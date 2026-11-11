/**
 * codex-harness-adapter.ts — Codex engine adapter (M4-S1, probe-grounded).
 *
 * Mirrors ClaudeHarnessAdapter's two one-way translations, but ONLY for
 * capabilities proven by a real `codex exec --json` probe (codex-cli 0.144.6,
 * 2026-09-18; fixtures in server/fixtures/codex/). Unproven capabilities are
 * declared false in CODEX_ENGINE_CAPABILITIES and FAIL CLOSED here — there is
 * NO Claude-shaped emulation, NO silent downgrade.
 *
 *   ① compileCodexExecConfig: platform policy → codex exec args. Throws on
 *      any constraint codex cannot honor (approval-required, MCP, A2UI, or
 *      the Host credential-proxy egress — codex runs its OWN model loop with
 *      its own OPENAI_API_KEY and cannot be funneled through the Host proxy).
 *   ② mapCodexEvent: one JSONL line → PlatformRuntimeEvent[]. Engine-private
 *      fields (thread_id, item.id, item.type, exit_code …) NEVER cross the
 *      boundary; only neutral platform events leave this method.
 *
 * Probe evidence + the proven/unproven/unavailable split:
 * docs/06-deployment/evidence/microvm-m4/m4-s1-codex-harness-probe-2026-09-18.md
 *
 * NOT wired into the Worker: codex is absent from the pinned Guest image
 * (eaos-guest:0.1.4), so a real Guest smoke is an explicit BLOCKER, not a
 * fabricated pass. This adapter + its focused tests are the only deliverable.
 */

import {
  CODEX_ENGINE_CAPABILITIES,
  type EngineCapabilities,
  type PlatformRuntimeEvent,
  type RuntimeErrorCategory,
} from "../../server/platform-runtime-protocol.js";
import { approvalRequiredToolIds, type ResolvedExecutionPolicy } from "../../server/resolved-execution-policy.js";

export const CODEX_ENGINE_ID = "codex" as const;

/** Structured view of the codex exec args this adapter compiles to. */
export interface CodexExecConfig {
  engineId: typeof CODEX_ENGINE_ID;
  /** Governed model ref (Host stamps literally; codex rejects non-OpenAI names — see probe doc). */
  model: string;
  /** codex --sandbox mode, derived from the exposed+allowed tool set. */
  sandbox: "read-only" | "workspace-write";
  /** --skip-git-repo-check (the Guest workspace is not a codex git repo). */
  skipGitRepoCheck: true;
  /** --json (JSONL event stream on stdout). */
  json: true;
  /** Resume token = a prior thread_id; emitted via `codex exec resume`. */
  resume?: string;
}

/**
 * ① Policy → codex exec config. Pure. Throws CodexPolicyRefusalError for ANY
 * constraint codex cannot honor — fail closed, never coerce, never emulate.
 *
 * Refusals (all proven gaps, not speculation):
 * - approvalRequired > 0  → preToolApproval=false; codex exec auto-runs
 *   commands and emits NO pre-execution approval item, so the platform CANNOT
 *   gate a destructive tool. The profile must move every such tool into
 *   allowedTools (auto-approve) or the engine refuses to expose it.
 * - mcpServers non-empty  → mcp=false; no in-loop MCP tool event was probed.
 * - egress.mode==="host-proxy" → codex runs its OWN model loop with its own
 *   OPENAI_API_KEY (auth.json inside the Guest); it CANNOT be funneled through
 *   the Host credential proxy. This is the platform's credential boundary,
 *   violated by codex today — a real M4 blocker, declared not patched over.
 */
export class CodexPolicyRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPolicyRefusalError";
  }
}

export function compileCodexExecConfig(
  policy: ResolvedExecutionPolicy,
  extras: { resume?: string } = {},
): CodexExecConfig {
  const approvalRequired = approvalRequiredToolIds(policy);
  if (approvalRequired.length > 0) {
    throw new CodexPolicyRefusalError(
      `codex cannot pre-approve tools (preToolApproval=false); move out of approval-required: ${approvalRequired.join(", ")}`,
    );
  }
  if (policy.mcpServers.length > 0) {
    throw new CodexPolicyRefusalError(
      `codex mcp not proven (mcp=false); refused mcp servers: ${policy.mcpServers.map((m) => m.name).join(", ")}`,
    );
  }
  if (policy.egress?.mode === "host-proxy") {
    throw new CodexPolicyRefusalError(
      "codex runs its own model loop (OPENAI_API_KEY in Guest) and cannot use the Host credential-proxy egress; platform credential boundary not satisfiable for codex today",
    );
  }

  // Sandbox: any exposed tool that can mutate the workspace → workspace-write
  // (and because approvalRequired===0 here, every such tool is already
  // allowed/auto-approved — the only honest stance under preToolApproval=false).
  // No destructive tools exposed → read-only (deny-default).
  const destructive = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);
  const hasDestructiveExposed = policy.exposedToolIds.some((t) => destructive.has(t));
  const sandbox: CodexExecConfig["sandbox"] = hasDestructiveExposed ? "workspace-write" : "read-only";

  return {
    engineId: CODEX_ENGINE_ID,
    model: policy.modelRef,
    sandbox,
    skipGitRepoCheck: true,
    json: true,
    ...(extras.resume ? { resume: extras.resume } : {}),
  };
}

/**
 * Capability set this adapter has PASSED in focused tests (M4-S1). Identical
 * to CODEX_ENGINE_CAPABILITIES — the engine-level declaration IS the adapter's
 * authority. maxPromisableLevel === 0 (abort=false + streamingText=false are
 * hard L0 gates). structuredToolEvents=false: codex emits command_execution
 * items (probe-proven), but they are post-hoc/ungovernable → DROPPED by
 * mapCodexEvent (see §item.completed) — the platform cannot surface them as
 * governed tool events; side-effect governance is the Host workspace scan.
 */
export const CODEX_HARNESS_CAPABILITIES: EngineCapabilities = CODEX_ENGINE_CAPABILITIES;

/** Minimal typed view of a parsed codex JSONL event line. */
interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id: string;
    type: string;
    text?: string;
    message?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

/**
 * ② One JSONL line → platform events. Stateless (codex emits each item once,
 * completed, so there is no per-session dedup state to own — unlike Claude's
 * delta+final normalizer). Unknown event types are dropped (forward-compat,
 * no fabrication); malformed JSON → runtime_error (protocol).
 */
export class CodexHarnessAdapter {
  readonly engineId = CODEX_ENGINE_ID;
  readonly capabilities: EngineCapabilities = CODEX_HARNESS_CAPABILITIES;

  /**
   * @param rawLine one stdout line from `codex exec --json` (without trailing
   *                newline). Callers MUST feed one line at a time — codex
   *                writes one JSON object per line.
   * @returns zero or more platform events. Never throws on a bad line — the
   *          error is returned as a runtime_error event so the turn survives.
   */
  mapCodexEvent(rawLine: string): PlatformRuntimeEvent[] {
    const trimmed = rawLine.trim();
    if (!trimmed) return [];
    let parsed: CodexEvent;
    try {
      parsed = JSON.parse(trimmed) as CodexEvent;
    } catch {
      return [
        { type: "runtime_error", category: "protocol" as RuntimeErrorCategory, message: "malformed codex jsonl line" },
      ];
    }
    return this.mapParsed(parsed);
  }

  private mapParsed(e: CodexEvent): PlatformRuntimeEvent[] {
    switch (e.type) {
      // thread_id is the engine session id (late-capture, like claudeSessionId).
      // sessionResume=true: a later compileCodexExecConfig({resume: thread_id})
      // feeds it back via `codex exec resume`.
      case "thread.started":
        return typeof e.thread_id === "string" && e.thread_id
          ? [{ type: "session_updated", engineSessionId: e.thread_id }]
          : [];

      case "turn.started":
        return []; // internal, no platform event

      case "item.started":
        // codex signals a command is running, but preToolApproval=false means
        // the platform CANNOT gate it — emitting tool_requested would imply we
        // can. Fail-closed: emit nothing pre-execution. The completed item
        // carries the (post-hoc, ungovernable) result below.
        return [];

      case "item.completed": {
        const item = e.item;
        if (!item || typeof item.id !== "string") return [];
        if (item.type === "agent_message") {
          // streamingText=false: only the FULL text arrives. final=true.
          return typeof item.text === "string"
            ? [{ type: "assistant_text", text: item.text, final: true }]
            : [];
        }
        if (item.type === "command_execution") {
          // POST-HOC, UNGOVERNABLE — DROP. preToolApproval=false means the
          // platform CANNOT gate a codex command before it runs, and by the
          // time this item.completed arrives the command has ALREADY executed.
          // Emitting `tool_result` (success OR failure) would, through the
          // real consumer (platform-event-adapter → SDK tool_result block),
          // synthesize the appearance of a GOVERNED, authorized tool call —
          // which it was not. `runtime_error{policy}` is also wrong: the
          // consumer maps it to `result(error)` → run failure, but codex
          // commands are non-fatal. So neither protocol event is honest here.
          // The platform's side-effect governance for codex is the Host
          // WORKSPACE SCAN (scanOutputFiles) after the turn — NOT this
          // (ungovernable) event stream. Raw item.id is kept opaque and
          // NEVER parsed for auth/tenancy/policy; it does not cross the
          // boundary at all under drop.
          return [];
        }
        if (item.type === "error") {
          // Non-fatal harness-level warning (e.g. skill-context budget). The
          // turn still completes after it. Surfaces as runtime_error{engine}.
          return typeof item.message === "string"
            ? [{ type: "runtime_error", category: "engine" as RuntimeErrorCategory, message: item.message }]
            : [];
        }
        return []; // unknown item.type — drop, do not fabricate
      }

      case "turn.completed": {
        const u = e.usage ?? {};
        // tokenUsage=true. reasoning_output_tokens has no neutral slot; folded
        // into outputTokens (reasoning is model output). cacheReadTokens from
        // cached_input_tokens. costUsage=false → no costUsd.
        const usage =
          typeof u.input_tokens === "number" || typeof u.output_tokens === "number"
            ? {
                inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
                outputTokens:
                  (typeof u.output_tokens === "number" ? u.output_tokens : 0) +
                  (typeof u.reasoning_output_tokens === "number" ? u.reasoning_output_tokens : 0),
                ...(typeof u.cached_input_tokens === "number" ? { cacheReadTokens: u.cached_input_tokens } : {}),
              }
            : undefined;
        return [{ type: "turn_completed", ...(usage ? { usage } : {}) }];
      }

      default:
        return []; // unknown top-level type — forward-compat drop
    }
  }
}
