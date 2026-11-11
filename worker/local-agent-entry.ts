/**
 * local-agent-entry.ts — Guest Worker entry (M3-S1 skeleton; M3-S3B egress
 * loop).
 *
 * Runs INSIDE the sandbox (`node /opt/agent/dist/worker/local-agent-entry.js`
 * with the pinned guest image).
 *
 * Hard boundaries (M3-S1/S3B requests):
 *   - only Host-declared paths are touched (workspace roots from the policy);
 *   - NO long-term credentials in the Guest, EVER. Two engine-start paths:
 *     ① policy.egress.mode === "host-proxy" (M3-S3B): model calls leave as
 *        `model_request` INTENTS (no credential, no provider/model choice —
 *        the Host stamps those) and the Host answers with a REDACTED
 *        `model_result`. This file holds no key material and reads no env
 *        secrets.
 *     ② no egress in the policy: the CredentialBroker stays DENY-ALL (fail
 *        closed; S1 semantics unchanged) — start fails with "policy".
 *   - NO arbitrary MCP command execution: MCP commands arrive via policy
 *        descriptors validated Host-side (governed root), not from the wire.
 *
 * Transport: newline-delimited JSON frames over stdin/stdout — one serialized
 * platform-protocol frame per line (MAX_FRAME_BYTES enforced by the framing
 * layer).
 */

import { createInterface } from "node:readline";
import { lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WorkerProtocolEndpoint, type WorkerTransport } from "../server/local-agent-worker-protocol.js";
import type { PlatformRuntimeCommand } from "../server/platform-runtime-protocol.js";
import type { ResolvedExecutionPolicy } from "../server/resolved-execution-policy.js";
import { ClaudeHarnessAdapter } from "./harness/claude-harness-adapter.js";

// ─── Credential boundary (M3-S1: deny-all until the egress proxy lands) ──────

export interface CredentialRequest {
  /** e.g. "model" — the only category the M3 proxy will serve. */
  kind: "model";
}

export interface CredentialLease {
  /** Short-lived authorization header value, Host-injected per-run. */
  authorization: string;
  expiresAtMs: number;
}

export interface CredentialBroker {
  readonly available: boolean;
  readonly reason?: string;
  acquire(req: CredentialRequest): Promise<CredentialLease | null>;
}

/** S1 deny-all broker: no long-term key ever enters the Guest. */
export const DENY_ALL_CREDENTIAL_BROKER: CredentialBroker = {
  available: false,
  reason: "policy carries no egress authorization — model credentials are withheld from the Guest",
  acquire: async () => null,
};

// ─── Guest tool executor (M3 closure — policy-bound, fail-closed) ────────────
//
// The worker — not an SDK subprocess — executes tools inside the Guest. Hard
// properties (all structurally verifiable in this file):
//   - NO child_process import anywhere: command execution is IMPOSSIBLE in
//     this worker (Bash is refused as unimplemented, never shelled out).
//   - NO network: node:fs + readline only.
//   - Path guard runs BEFORE any filesystem touch; roots come from the
//     Host-signed policy (workspacePolicy.roots), never from the wire.
//   - Every outcome is a bounded tool_result; nothing grows unbounded.

/** Bound on any tool output / write content crossing the frames (bytes). */
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_TOOL_INPUT_BYTES = 256 * 1024;
/** Bounded preview carried by approval_request (UI/audit view, never the fs). */
const MAX_APPROVAL_INPUT_CHARS = 2000;
/** Tool-loop bound when the policy carries no maxTurns. */
const DEFAULT_MAX_TOOL_ROUNDS = 8;

interface ToolBlock {
  type: "text" | "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}
type ConversationContent = string | Array<ToolBlock | ToolResultBlock>;
interface ConversationMessage {
  role: "user" | "assistant";
  content: ConversationContent;
}

/** Resolve a Guest path against the policy roots BEFORE touching the fs.
 *  Returns the matching root or null (null = refuse without any fs access). */
function policyRootFor(
  policy: ResolvedExecutionPolicy,
  target: string,
  access: "ro" | "rw",
): { path: string } | null {
  if (typeof target !== "string" || !target.startsWith("/") || target.split("/").includes("..")) return null;
  const match = policy.workspacePolicy.roots.find(
    (r) => r.access === access && (target === r.path || target.startsWith(`${r.path}/`)),
  );
  return match ?? null;
}

/** R1-4: resolve a symlink target relative to its parent, without requiring
 *  the target to exist. Used when a Write target is a dangling symlink — the
 *  written file would land at the resolved link target, which must be inside
 *  a writable root. */
function resolveSymlinkTarget(linkPath: string, linkValue: string): string {
  return resolve(dirname(linkPath), linkValue);
}

function bounded(text: string, max = MAX_TOOL_RESULT_BYTES): string {
  return Buffer.byteLength(text, "utf8") > max ? `${text.slice(0, max)}…[truncated]` : text;
}

type ToolHandler = (input: Record<string, unknown>, policy: ResolvedExecutionPolicy) => Promise<{ content: string; isError?: boolean }>;

/**
 * The ONLY tools this worker implements. Unlisted tools are refused —
 * structurally there is nothing here that could run them.
 *
 * R1-4: every path is realpath-validated BEFORE any read/write. A symlink
 * inside the workspace pointing at /etc, /opt/agent, or another mount escapes
 * the policy roots and is refused with ZERO I/O.
 */
const IMPLEMENTED_TOOLS: Readonly<Record<string, ToolHandler>> = {
  Read: async (input, policy) => {
    const target = String(input.file_path ?? "");
    if (!target.startsWith("/") || target.split("/").includes(".."))
      return { content: `Read refused: '${target}' is not an absolute path without '..'`, isError: true };
    let realTarget: string;
    try { realTarget = realpathSync(target); }
    catch (e) { return { content: `Read failed: ${(e as Error).message}`, isError: true }; }
    const root = policyRootFor(policy, realTarget, "ro") ?? policyRootFor(policy, realTarget, "rw");
    if (!root) return { content: `Read refused: realpath '${realTarget}' escapes the policy workspace roots`, isError: true };
    try {
      return { content: bounded(readFileSync(target, "utf8")) };
    } catch (e) {
      return { content: `Read failed: ${(e as Error).message}`, isError: true };
    }
  },
  Write: async (input, policy) => {
    const target = String(input.file_path ?? "");
    const content = typeof input.content === "string" ? input.content : "";
    if (!target.startsWith("/") || target.split("/").includes(".."))
      return { content: `Write refused: '${target}' is not an absolute path without '..'`, isError: true };
    if (Buffer.byteLength(content, "utf8") > MAX_TOOL_INPUT_BYTES) return { content: `Write refused: content exceeds ${MAX_TOOL_INPUT_BYTES} bytes`, isError: true };
    // R1-4: if the target is a symlink, resolve where the write would land.
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        let realTarget: string;
        try { realTarget = realpathSync(target); }
        catch { realTarget = resolveSymlinkTarget(target, readlinkSync(target)); }
        if (!policyRootFor(policy, realTarget, "rw"))
          return { content: `Write refused: symlink target '${realTarget}' escapes the writable policy roots`, isError: true };
      }
    } catch { /* target doesn't exist — check parent below */ }
    // Nearest existing parent dir realpath.
    const parent = dirname(target);
    let realParent: string;
    try { realParent = realpathSync(parent); }
    catch (e) { return { content: `Write refused: parent directory not resolvable: ${(e as Error).message}`, isError: true }; }
    if (!policyRootFor(policy, realParent, "rw"))
      return { content: `Write refused: parent realpath '${realParent}' escapes the writable policy roots`, isError: true };
    try {
      writeFileSync(target, content, "utf8");
      return { content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}` };
    } catch (e) {
      // Includes mount-quota refusals (EDQUOT/ENOSPC) — surfaced, not retried.
      return { content: `Write failed: ${(e as Error).message}`, isError: true };
    }
  },
  Edit: async (input, policy) => {
    const target = String(input.file_path ?? "");
    if (!target.startsWith("/") || target.split("/").includes(".."))
      return { content: `Edit refused: '${target}' is not an absolute path without '..'`, isError: true };
    let realTarget: string;
    try { realTarget = realpathSync(target); }
    catch (e) { return { content: `Edit failed: ${(e as Error).message}`, isError: true }; }
    const root = policyRootFor(policy, realTarget, "rw");
    if (!root) return { content: `Edit refused: realpath '${realTarget}' escapes the writable policy roots`, isError: true };
    try {
      const current = readFileSync(target, "utf8");
      const oldStr = String(input.old_string ?? "");
      if (!current.includes(oldStr)) return { content: "Edit failed: old_string not found", isError: true };
      const next = current.replace(oldStr, String(input.new_string ?? ""));
      if (Buffer.byteLength(next, "utf8") > MAX_TOOL_INPUT_BYTES) return { content: `Edit refused: result exceeds ${MAX_TOOL_INPUT_BYTES} bytes`, isError: true };
      writeFileSync(target, next, "utf8");
      return { content: `Edited ${target}` };
    } catch (e) {
      return { content: `Edit failed: ${(e as Error).message}`, isError: true };
    }
  },
};

/** Tool schemas advertised to the model (subset of the exposed policy tools —
 *  the worker only advertises what it implements, plus show_ui for A2UI).
 *  R1-1: show_ui is advertised ONLY when it is in the exposed policy set,
 *  so an unconfigured A2UI policy never shows the tool to the model. */
function advertisedTools(policy: ResolvedExecutionPolicy): Array<Record<string, unknown>> {
  const defs: Record<string, Record<string, unknown>> = {
    Read: {
      name: "Read",
      description: "Read a UTF-8 text file inside the workspace.",
      input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    },
    Write: {
      name: "Write",
      description: "Write a file inside the writable workspace (subject to approval).",
      input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
    },
    Edit: {
      name: "Edit",
      description: "Replace the first occurrence of old_string in a workspace file (subject to approval).",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    show_ui: {
      name: "show_ui",
      description:
        "Present an inline interaction card (form / confirm / card / list) and block until the user submits. Use when the user should pick from explicit options or fill structured fields instead of typing free text. The submitted values return as this tool's result in the same turn — do not repeat them in the reply text. Do not create any .a2ui file.",
      input_schema: {
        type: "object",
        required: ["type", "title"],
        properties: {
          type: { type: "string", enum: ["form", "confirm", "card", "list"] },
          title: { type: "string" },
          description: { type: "string" },
          fields: { type: "array", items: { type: "object" } },
          items: { type: "array", items: { type: "object" } },
          actions: { type: "array", items: { type: "object" } },
          timeoutSec: { type: "integer", minimum: 1, maximum: 3600 },
        },
      },
    },
  };
  const exposed = new Set(policy.exposedToolIds);
  return Object.entries(defs)
    .filter(([name]) => exposed.has(name))
    .map(([, def]) => def);
}



// ─── Worker session (DI: broker + adapter injectable) ───────────────────────

export interface WorkerSessionDeps {
  endpoint: WorkerProtocolEndpoint;
  adapter: ClaudeHarnessAdapter;
  broker?: CredentialBroker;
  /** Engine starter — the real SDK query loop lands with the guest image;
   *  S1 keeps it injectable so the skeleton is testable without faking one. */
  startEngine?: (config: { authorization?: string }) => void;
  log?: (msg: string) => void;
}

/** Turn cap for proxy payloads (S3B minimal loop; the Host clamps too). */
const PROXY_MAX_TOKENS = 1024;

/**
 * Serve the worker command loop. Every inbound command is handled closed:
 * start (policy egress gate → engine), send_message, model_result,
 * approval_result, a2ui_result, abort, close. Unknown/unrepresentable →
 * runtime_error event (never a crash, never a silent drop).
 */
export function createWorkerSession(deps: WorkerSessionDeps) {
  const { endpoint, adapter } = deps;
  const broker = deps.broker ?? DENY_ALL_CREDENTIAL_BROKER;
  const log = deps.log ?? ((m: string) => console.error(`[worker] ${m}`));
  let engineRunning = false;
  /** M3-S3B: policy authorized the Host credential proxy for model calls. */
  let hostProxyMode = false;
  /** runId of the in-flight proxy turn (null = idle). Stays set across the
   *  tool loop — the turn ends only on turn_completed/turn_failed. */
  let pendingTurn: string | null = null;
  /** Host-signed policy snapshot (set by start; the tool gate reads ONLY this). */
  let policy: ResolvedExecutionPolicy | null = null;
  /** Conversation state for the proxy loop (Guest-local, bounded by frames). */
  const conversation: ConversationMessage[] = [];
  /** Parked approval verdicts + a2ui submissions keyed by requestId. */
  const parkedApprovals = new Map<string, (approved: boolean) => void>();
  const parkedA2ui = new Map<string, { resolve: (result: unknown) => void; reject: (e: Error) => void }>();
  /** Tool rounds used by the in-flight turn (bounded by policy.maxTurns). */
  let toolRounds = 0;
  let aborted = false;

  const failTurn = (category: "engine" | "policy" | "aborted" | "internal", message: string): void => {
    pendingTurn = null;
    cancelParked("aborted by host");
    endpoint.sendEvent({ type: "turn_failed", category, message });
  };

  /** Reject every parked approval/a2ui waiter (abort/turn end). */
  const cancelParked = (reason: string): void => {
    for (const resolve of parkedApprovals.values()) resolve(false);
    parkedApprovals.clear();
    for (const parked of parkedA2ui.values()) parked.reject(new Error(`wait cancelled: ${reason}`));
    parkedA2ui.clear();
  };

  const issueModelRequest = (): void => {
    if (pendingTurn === null || !policy) return;
    const tools = advertisedTools(policy);
    endpoint.sendEvent({
      type: "model_request",
      requestId: pendingTurn,
      provider: "claude",
      path: "/v1/messages",
      payload: JSON.stringify({
        messages: conversation.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: PROXY_MAX_TOKENS,
        ...(tools.length > 0 ? { tools } : {}),
      }),
    });
  };

  const handleCommand = (command: PlatformRuntimeCommand): void => {
    switch (command.type) {
      case "start": {
        if (engineRunning) {
          endpoint.sendEvent({ type: "runtime_error", category: "protocol", message: "engine already started" });
          return;
        }
        if (command.policy.egress?.mode === "host-proxy") {
          // M3-S3B: the Host-signed policy authorizes proxy egress. No
          // credential is acquired — model calls leave as intents only.
          hostProxyMode = true;
          policy = command.policy;
          // M5-S4 C: seed conversation from bounded history snapshot BEFORE
          // runtime_ready. The Guest's first turn then references prior
          // context. Host already bounded to last 20 / ≤40k chars / text-only
          // user+assistant (no tool payload/credentials/A2UI internal). An
          // absent or empty field = fresh start (no replay).
          if (Array.isArray(command.history)) {
            for (const m of command.history) {
              if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
                conversation.push({ role: m.role, content: m.content });
              }
            }
          }
          engineRunning = true;
          endpoint.sendEvent({ type: "runtime_ready", capabilities: adapter.capabilities });
          return;
        }
        if (!broker.available) {
          // Fail closed: no egress authorization → no engine. Explicit, diagnosable.
          log(`start refused: ${broker.reason}`);
          endpoint.sendEvent({
            type: "turn_failed",
            category: "policy",
            message: `engine start blocked: ${broker.reason}`,
          });
          return;
        }
        void broker
          .acquire({ kind: "model" })
          .then((lease) => {
            if (!lease) {
              endpoint.sendEvent({ type: "turn_failed", category: "policy", message: "credential lease denied" });
              return;
            }
            engineRunning = true;
            deps.startEngine?.({ authorization: lease.authorization });
            endpoint.sendEvent({
              type: "runtime_ready",
              capabilities: adapter.capabilities,
            });
          })
          .catch((e: unknown) => {
            endpoint.sendEvent({
              type: "runtime_error",
              category: "internal",
              message: `credential acquisition failed: ${String((e as Error)?.message ?? e)}`,
            });
          });
        return;
      }
      case "send_message": {
        if (!engineRunning) {
          endpoint.sendEvent({ type: "runtime_error", category: "protocol", message: "send_message before start" });
          return;
        }
        if (!hostProxyMode) {
          // S1 skeleton path: the real SDK query loop is not wired here.
          endpoint.sendEvent({
            type: "runtime_error",
            category: "internal",
            message: "engine message loop not wired in S1 skeleton (no egress authorization in policy)",
          });
          return;
        }
        if (pendingTurn !== null) {
          endpoint.sendEvent({ type: "runtime_error", category: "protocol", message: "turn already in flight (one proxy turn at a time)" });
          return;
        }
        // INTENT only: no credential, no model/provider/target selection —
        // the Host stamps the governed modelRef and executes provider-side.
        conversation.push({ role: "user", content: command.content });
        pendingTurn = command.runId;
        toolRounds = 0;
        aborted = false;
        issueModelRequest();
        return;
      }
      case "model_result": {
        if (!hostProxyMode) {
          endpoint.sendEvent({ type: "runtime_error", category: "protocol", message: "model_result outside host-proxy mode" });
          return;
        }
        if (pendingTurn === null || command.requestId !== pendingTurn) {
          // Unsolicited / stale answer — never feed the conversation.
          endpoint.sendEvent({ type: "runtime_error", category: "protocol", message: `unsolicited model_result for '${command.requestId}'` });
          return;
        }
        if (!command.ok) {
          failTurn("engine", command.error ?? `model call failed (status ${command.status})`);
          return;
        }
        void handleProxyResponse(command.body ?? "");
        return;
      }
      case "approval_result": {
        const parked = parkedApprovals.get(command.requestId);
        if (!parked) {
          endpoint.sendEvent({ type: "runtime_error", category: "protocol", message: `unsolicited approval_result for '${command.requestId}'` });
          return;
        }
        parkedApprovals.delete(command.requestId);
        parked(command.approved);
        return;
      }
      case "a2ui_result": {
        const parked = parkedA2ui.get(command.requestId);
        if (!parked) {
          endpoint.sendEvent({ type: "runtime_error", category: "protocol", message: `unsolicited a2ui_result for '${command.requestId}'` });
          return;
        }
        parkedA2ui.delete(command.requestId);
        parked.resolve(command.result);
        return;
      }
      case "compact":
        // No compaction state in the proxy loop (conversation is bounded by
        // turn caps + payload limits); accepted for protocol stability.
        return;
      case "ping": {
        // M5-S4 B: lightweight health probe — prove the worker event loop
        // is alive and the transport is up. No business payload.
        endpoint.sendEvent({ type: "pong" });
        return;
      }
      case "abort": {
        if (hostProxyMode && pendingTurn !== null) {
          // Cancel the in-flight intent AND every parked tool wait; a late
          // model_result arrives unsolicited and is refused above.
          aborted = true;
          failTurn("aborted", "turn aborted by host");
        }
        return;
      }
      case "close": {
        engineRunning = false;
        cancelParked("close");
        endpoint.close();
        return;
      }
      default: {
        // Closed command surface — parseFrame already rejects unknown types;
        // this arm is unreachable defense in depth.
        const never: never = command;
        void never;
      }
    }
  };

  /**
   * Provider response (redacted JSON) → SDK-shaped messages → the committed
   * Claude adapter/normalizer → platform events. With tool_use blocks the
   * M3-closure tool loop runs: classify (allowed/approval/deny), execute
   * policy-bound, then continue the SAME turn with a follow-up intent.
   */
  const handleProxyResponse = async (bodyText: string): Promise<void> => {
    let body: {
      content?: ToolBlock[];
      usage?: Record<string, number>;
    };
    try {
      body = JSON.parse(bodyText) as typeof body;
    } catch {
      failTurn("engine", "model proxy returned an unparseable response body");
      return;
    }
    const blocks = Array.isArray(body.content) ? body.content : [];
    const toolUses = blocks.filter((b) => b?.type === "tool_use");

    if (toolUses.length === 0) {
      // Terminal response: text only → assistant_text + turn_completed.
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
      conversation.push({ role: "assistant", content: text });
      let events: ReturnType<ClaudeHarnessAdapter["mapSdkMessage"]> = [];
      try {
        events = [
          ...adapter.mapSdkMessage({ type: "assistant", message: { content: blocks } }),
          ...adapter.mapSdkMessage({ type: "result", subtype: "success", ...(body.usage ? { usage: body.usage } : {}), result: text }),
        ];
      } catch (e: unknown) {
        failTurn("engine", `model response mapping failed: ${String((e as Error)?.message ?? e)}`);
        return;
      }
      for (const evt of events) endpoint.sendEvent(evt);
      pendingTurn = null;
      return;
    }

    // Tool round: assistant blocks enter the conversation verbatim (bounded —
    // the proxy already capped the body at 1MB), tool_results follow.
    try {
      conversation.push({ role: "assistant", content: blocks });
      const results: ToolResultBlock[] = [];
      for (const tu of toolUses) {
        results.push(await runOneTool(tu));
      }
      if (aborted || pendingTurn === null) return; // failTurn already emitted
      conversation.push({ role: "user", content: results });
      // Surface tool_result events through the committed normalizer.
      for (const evt of adapter.mapSdkMessage({ type: "user", message: { content: results } })) {
        endpoint.sendEvent(evt);
      }
      const maxRounds = policy?.resourcePolicy.maxTurns ?? DEFAULT_MAX_TOOL_ROUNDS;
      toolRounds += 1;
      if (toolRounds >= maxRounds) {
        failTurn("policy", `tool round cap reached (${maxRounds}) — refusing to continue the loop`);
        return;
      }
      issueModelRequest(); // same requestId: one logical turn, continuation call
    } catch (e: unknown) {
      failTurn("engine", `tool loop failed: ${String((e as Error)?.message ?? e)}`);
    }
  };

  /**
   * One tool_use → tool_result, classified by the Host-signed policy:
   *   denied/not exposed → refused WITHOUT any execution attempt (covers
   *     show_ui when the policy does not expose it — no card is shown);
   *   show_ui (exposed)  → a2ui_request … parked until a2ui_result (M3 A2UI);
   *   allowed            → executed only if implemented (else fail-closed);
   *   everything else    → approval_request … parked until approval_result;
   *                       approved+implemented → execute, else fail-closed.
   * R1-1: show_ui is subject to exposed/denied BEFORE parking on a2ui.
   * tool_requested/tool_result events ride the committed normalizer.
   */
  const runOneTool = async (tu: ToolBlock): Promise<ToolResultBlock> => {
    const toolCallId = String(tu.id ?? "");
    const name = String(tu.name ?? "");
    const input = (tu.input ?? {}) as Record<string, unknown>;
    const done = (content: string, isError: boolean): ToolResultBlock => ({ type: "tool_result", tool_use_id: toolCallId, content: bounded(content), is_error: isError });

    if (!policy) return done("tool refused: no policy snapshot", true);
    const exposed = policy.exposedToolIds.includes(name);
    const denied = policy.deniedToolIds.includes(name);
    if (!exposed || denied) {
      // DENY PATH — zero execution: nothing ran, nothing was read. show_ui
      // lands here too when it is not in the exposed set (no a2ui_request).
      for (const evt of adapter.mapSdkMessage({ type: "assistant", message: { content: [tu] } })) endpoint.sendEvent(evt);
      return done(`tool '${name}' refused: not in the exposed tool set (policy deny)`, true);
    }

    if (name === "show_ui") {
      // A2UI: exposed show_ui → park on a2ui_request. The card IS the UI —
      // push the tool_use through the normalizer so it registers the
      // internal-tool id (filters BOTH this tool_use chip and the later
      // tool_result chip); park until the Host delivers the user's submission.
      const requestId = `a2ui-${toolCallId}`;
      for (const evt of adapter.mapSdkMessage({ type: "assistant", message: { content: [tu] } })) endpoint.sendEvent(evt);
      const block = input;
      const timeoutSec = typeof input.timeoutSec === "number" ? input.timeoutSec : undefined;
      endpoint.sendEvent({ type: "a2ui_request", requestId, block, ...(timeoutSec !== undefined ? { timeoutSec } : {}) });
      try {
        const submitted = await new Promise<unknown>((resolve, reject) => {
          parkedA2ui.set(requestId, { resolve, reject });
        });
        return done(JSON.stringify(submitted ?? {}), false);
      } catch (e) {
        return done(`show_ui failed: ${(e as Error).message}`, true);
      }
    }

    const allowed = policy.allowedToolIds.includes(name);
    if (!allowed) {
      // APPROVAL PATH — pre-execution verdict from the platform approval flow.
      const requestId = `appr-${toolCallId}`;
      const preview = JSON.stringify(input).slice(0, MAX_APPROVAL_INPUT_CHARS);
      endpoint.sendEvent({ type: "approval_request", requestId, toolName: name, toolCallId, input: preview });
      const approved = await new Promise<boolean>((resolve) => {
        parkedApprovals.set(requestId, resolve);
      });
      if (!approved) {
        for (const evt of adapter.mapSdkMessage({ type: "assistant", message: { content: [tu] } })) endpoint.sendEvent(evt);
        return done(`tool '${name}' refused: denied by user approval`, true);
      }
    }

    // EXECUTE — only implemented tools; anything else fails closed (notably
    // Bash: this worker structurally cannot run commands — no child_process).
    const handler = IMPLEMENTED_TOOLS[name];
    if (!handler) {
      for (const evt of adapter.mapSdkMessage({ type: "assistant", message: { content: [tu] } })) endpoint.sendEvent(evt);
      return done(`tool '${name}' is not implemented in the MicroVM guest worker (fail closed)`, true);
    }
    for (const evt of adapter.mapSdkMessage({ type: "assistant", message: { content: [tu] } })) endpoint.sendEvent(evt);
    try {
      const r = await handler(input, policy);
      return done(r.content, r.isError === true);
    } catch (e: unknown) {
      return done(`tool '${name}' failed: ${String((e as Error)?.message ?? e)}`, true);
    }
  };

  return { handleCommand };
}

// ─── stdio transport + main (guest process entry) ───────────────────────────

export function createStdioTransport(): WorkerTransport {
  return {
    send(text: string): void {
      process.stdout.write(`${text}\n`);
    },
    close(): void {
      // stdin closes with the process; nothing extra to tear down.
    },
  };
}

/** Guest main: wire stdio frames → worker session. Exported for DI tests. */
export function runWorkerMain(deps: Partial<WorkerSessionDeps> & { stdin?: NodeJS.ReadableStream } = {}): void {
  const adapter = deps.adapter ?? new ClaudeHarnessAdapter();
  const endpoint = deps.endpoint ?? new WorkerProtocolEndpoint(createStdioTransport(), { role: "guest" });
  const session = createWorkerSession({ endpoint, adapter, ...deps });
  const rl = createInterface({ input: deps.stdin ?? process.stdin });
  rl.on("line", (line) => {
    const { command } = endpoint.handleCommandFrame(line);
    if (command) session.handleCommand(command);
  });
  rl.on("close", () => endpoint.close());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkerMain();
}
