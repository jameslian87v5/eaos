/**
 * Platform-neutral Runtime Protocol v0 (M0.5 FREEZE).
 *
 * Plan §5.1 (docs/开发计划/local-microvm-runtime-整体研发计划.md) + evt
 * reviews evt_20260915064506/065100: approval_request carries a bounded,
 * redacted tool input; workspace_changed is Host-scan driven (never a
 * harness-private field); assistant_text.final requires normalizer dedup.
 *
 * Freeze rules (plan §7 M0.5):
 * - NO engine-private structures: `claudeSessionId`, Claude content blocks,
 *   `tool_use_id`, `hookSpecificOutput` … must never appear in these types
 *   (enforced by scanForEnginePrivateFields + contract tests).
 * - Field changes after this freeze REQUIRE an explicit version bump +
 *   compatibility review (RUNTIME_PROTOCOL_VERSION). No silent amendments;
 *   no pre-M1 exception.
 *
 * v0 freeze decisions resolving M0 open items (see
 * docs/02-architecture/runtime-protocol-v0-mapping.md §2):
 *   ① `compact` command + `context_compacted` event are platform-neutral
 *      (auto-compact is a platform strategy; engines report support via
 *      EngineCapabilities.contextCompaction).
 *   ② platform-web-tools stays an engine-side detail; capabilities.mcp only
 *      reports engine MCP support. No protocol field.
 *   ③ sdk-init diagnostics do NOT cross the protocol (adapter-side logging).
 *   ④ engine session ids travel as engineSessionId only
 *      (runtime_ready + session_updated for late capture).
 */

import type { ResolvedExecutionPolicy } from "./resolved-execution-policy.js";

export const RUNTIME_PROTOCOL_VERSION = "0" as const;

// --- Bounds (transport views; audit stays metadata-only) --------------------
/** Hard frame cap in UTF-8 BYTES (both serialize and parse directions). */
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_TEXT_CHARS = 20_000;
/** Matches the current session.ts tool output truncation. */
export const MAX_TOOL_PAYLOAD_CHARS = 5_000;
export const MAX_PATHS_PER_EVENT = 200;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type RuntimeErrorCategory =
  | "protocol" // framing/version/sequence violations
  | "engine" // harness-reported failure
  | "timeout"
  | "io"
  | "oom"
  | "aborted"
  | "policy" // constraint refused by policy compiler (fail closed)
  | "internal";

// --- Commands (Host → Runtime) ----------------------------------------------

// --- M5-S4 C: engine-neutral bounded history replay (cold recovery) ----------
/**
 * Bounded, redacted history message for the transient Host→Guest `start`
 * payload. Only user/assistant TEXT (no tool payload, credentials, A2UI
 * internal, or system prompts). Last 20 messages, ≤ 40,000 chars total
 * (tail-truncated). restoreMode = "history_replay" (NOT Claude SDK resume).
 */
export interface HistoryReplayMessage {
  role: "user" | "assistant";
  content: string;
}

export type PlatformRuntimeCommand =
  | {
      type: "start";
      resumeToken?: string;
      policy: ResolvedExecutionPolicy;
      /**
       * M5-S4 C: bounded history snapshot for cold recovery. Guest seeds its
       * in-memory `conversation` from this BEFORE sending runtime_ready.
       * Absent = fresh start (no replay). restoreMode is reported as
       * "history_replay" when this field is non-empty, else "fresh".
       */
      history?: ReadonlyArray<HistoryReplayMessage>;
    }
  | { type: "send_message"; runId: string; content: string }
  | { type: "approval_result"; requestId: string; approved: boolean; message?: string }
  | { type: "a2ui_result"; requestId: string; result: unknown }
  | { type: "compact" } // v0 open-item ①: neutral auto-compact trigger
  | { type: "abort"; runId: string }
  /**
   * M3-S3B egress proxy loop: Host answer to a Guest `model_request`. The
   * Guest NEVER sees credentials — the Host executed the provider call and
   * returns a REDACTED result (body is provider JSON with any credential
   * material scrubbed; error strings sanitized).
   */
  | { type: "model_result"; requestId: string; ok: boolean; status: number; body?: string; error?: string }
  /**
   * M5-S4 B: lightweight health probe. No business payload. The Guest MUST
   * respond with a `pong` event within the heartbeat window. Used by the
   * Host to detect a stuck/unresponsive Guest worker and converge runtime
   * status to `crashed` after consecutive failures.
   */
  | { type: "ping" }
  | { type: "close" };

// --- Events (Runtime → Host) ------------------------------------------------

export type PlatformRuntimeEvent =
  | { type: "runtime_ready"; engineSessionId?: string; capabilities: EngineCapabilities }
  /** Late engine-session capture (docker IPC `session_id` frame semantics). */
  | { type: "session_updated"; engineSessionId: string }
  /**
   * final=true is the turn's final text, NOT necessarily new text: the
   * normalizer MUST dedup against already-streamed text (content equality)
   * before emitting — engines that emit both delta and final must not
   * double-render.
   */
  | { type: "assistant_text"; text: string; final: boolean }
  | { type: "tool_requested"; toolCallId: string; toolName: string; input?: unknown }
  | { type: "tool_result"; toolCallId: string; success: boolean; output?: unknown }
  /**
   * input is a BOUNDED + REDACTED view for the approval UI only
   * (MAX_TOOL_PAYLOAD_CHARS, secret-key redaction). Audit remains
   * metadata-only — this payload must never be persisted to run metadata.
   */
  | { type: "approval_request"; requestId: string; toolName: string; toolCallId?: string; input?: unknown }
  | { type: "a2ui_request"; requestId: string; block: unknown; timeoutSec?: number }
  /**
   * Host-scan driven (scanOutputFiles / controlled scan). A guest-only write
   * layer may report a bounded relative-path list; the Host revalidates.
   */
  | { type: "workspace_changed"; paths?: string[] }
  | { type: "turn_completed"; usage?: TokenUsage; costUsd?: number; durationMs?: number }
  | { type: "turn_failed"; category: RuntimeErrorCategory; message: string }
  | { type: "runtime_error"; category: RuntimeErrorCategory; message: string }
  | { type: "context_compacted"; preTokens?: number; postTokens?: number; trigger?: string }
  /**
   * M5-S4 B: Guest health-probe response. No payload — proves the worker
   * event loop is alive and the transport is up. Host correlates with its
   * heartbeat timer; missing pong within window = one heartbeat failure.
   */
  | { type: "pong" }
  /**
   * M3-S3B egress proxy loop: the Guest's CONTROLLED model-call INTENT (never
   * a credential). payload is a JSON string of the provider request body
   * WITHOUT model/target selection — the Host stamps the governed modelRef
   * and target (the Guest cannot choose provider, host or model).
   */
  | { type: "model_request"; requestId: string; provider: string; path: string; payload: string };

// --- Capabilities -----------------------------------------------------------

export interface EngineCapabilities {
  streamingText: boolean;
  structuredToolEvents: boolean;
  /** Reliable PRE-execution approval (PreToolUse-equivalent + verdict回注). */
  preToolApproval: boolean;
  sessionResume: boolean;
  tokenUsage: boolean;
  costUsage: boolean;
  mcp: boolean;
  a2ui: boolean;
  abort: boolean;
  /** v0 open-item ①: compact command + context_compacted events supported. */
  contextCompaction: boolean;
}

/** The only committed engine (plan §5.2). */
export const CLAUDE_ENGINE_CAPABILITIES: EngineCapabilities = {
  streamingText: true,
  structuredToolEvents: true,
  preToolApproval: true,
  sessionResume: true,
  tokenUsage: true,
  costUsage: true,
  mcp: true,
  a2ui: true,
  abort: true,
  contextCompaction: true,
};

/**
 * M4-S1 — Codex engine capabilities, declared ONLY from real probe evidence
 * (codex-cli 0.144.6 `codex exec --json`, 2026-09-18; see
 * docs/06-deployment/evidence/microvm-m4/m4-s1-codex-harness-probe-2026-09-18.md).
 * Proven → true; unproven → false and fail-closed (no Claude-shaped emulation).
 *
 *   streamingText:        FALSE — JSONL emits item.completed{agent_message}
 *     with the FULL text only; there are no stdout streaming-delta events
 *     (OutputTextDelta surfaces only as a stderr error, not a platform event).
 *   structuredToolEvents: FALSE — codex DOES emit `command_execution` items
 *     (probe-proven), but they are POST-HOC and UNGOVERNABLE: by the time
 *     item.completed arrives the command has already run, and preToolApproval
 *     is false so the platform cannot gate it. Surfacing them as `tool_result`
 *     would (via platform-event-adapter) synthesize the appearance of a
 *     GOVERNED tool call, and `runtime_error{policy}` would (via the same
 *     consumer) mark the run failed for a non-fatal command. So the adapter
 *     DROPS them; the platform's side-effect governance for codex is the
 *     Host workspace scan, not this ungovernable event stream. The capability
 *     bit therefore reads false: the platform cannot surface codex tool
 *     events in a governed way. (Engine raw emission ≠ adapter surface.)
 *   preToolApproval:      FALSE — codex exec runs commands itself; NO pre-
 *     execution approval item is emitted, so the platform CANNOT gate codex
 *     commands before they run. Fail-closed: a codex profile must place every
 *     destructive tool in allowedTools (auto-approve) or the engine refuses
 *     to expose it — no approval_request is ever synthesized.
 *   sessionResume:        TRUE  — thread.started{thread_id} + `codex exec
 *     resume` subcommand.
 *   tokenUsage:           TRUE  — turn.completed.usage{input_tokens,
 *     cached_input_tokens, output_tokens, reasoning_output_tokens}.
 *   costUsage:            FALSE — no cost field emitted.
 *   mcp:                  FALSE — not proven in the loop (codex manages MCP
 *     servers via `codex mcp`, but no in-loop MCP tool events were probed).
 *   a2ui:                 FALSE — not proven.
 *   abort:                 FALSE — exec runs to completion; no mid-turn abort
 *     proven.
 *   contextCompaction:    FALSE — no compact command/event proven.
 *
 * maxPromisableLevel(CODEX_ENGINE_CAPABILITIES) = 0 — abort=false AND
 * streamingText=false are BOTH hard L0 gates (the platform cannot abort or
 * stream a codex turn today). The proven structuredToolEvents/sessionResume/
 * tokenUsage are real but do NOT elevate codex past L0 in the platform's
 * ladder, because abort is a required capability from L1 up. This is the
 * authoritative floor, not a downgrade.
 */
export const CODEX_ENGINE_CAPABILITIES: EngineCapabilities = {
  streamingText: false,
  structuredToolEvents: false,
  preToolApproval: false,
  sessionResume: true,
  tokenUsage: true,
  costUsage: false,
  mcp: false,
  a2ui: false,
  abort: false,
  contextCompaction: false,
};

/**
 * M4 multi-engine matrix (plan §5.2). Only engines with a REAL probe + adapter
 * are listed; speculative rows are preserved as PLANNED with the exact next
 * probe prerequisite. maxPromisableLevel is the adapter's AUTHORITY — a product
 * may only claim the level its adapter actually passed.
 */
export interface EngineMatrixRow {
  readonly engineId: string;
  /**
   * "active" = an adapter EXISTS and was probed against the real engine (not
   * speculative). It does NOT mean deployable — see `deployable`.
   */
  readonly status: "active" | "planned";
  readonly adapter?: string;
  readonly maxLevel: 0 | 1 | 2 | 3 | 4;
  /**
   * TRUE only when the engine is in the pinned Guest image, wired into the
   * Worker, AND its credential/model governance is resolved (host-proxy or
   * equivalent). `status:"active" && !deployable` means adapter-probed only.
   */
  readonly deployable: boolean;
  /** For `planned` rows: the exact prerequisite before the next probe. */
  readonly nextProbePrerequisite?: string;
}

export const ENGINE_MATRIX: readonly EngineMatrixRow[] = [
  { engineId: "claude", status: "active", adapter: "ClaudeHarnessAdapter", maxLevel: 4, deployable: true },
  {
    engineId: "codex",
    status: "active",
    adapter: "CodexHarnessAdapter",
    maxLevel: 0,
    deployable: false, // adapter-probed; NOT in Guest image, NOT Worker-wired, host-proxy egress refused (own model loop)
  },
  {
    engineId: "pi",
    status: "planned",
    maxLevel: 0,
    deployable: false,
    nextProbePrerequisite:
      "Pi harness binary available to the Guest image (not present in eaos-guest:0.1.4); probe non-interactive exec + event stream shape, session/resume, usage, approval model, then implement smallest PiHarnessAdapter for proven-only capabilities",
  },
  {
    engineId: "deepseek",
    status: "planned",
    maxLevel: 0,
    deployable: false,
    nextProbePrerequisite:
      "DeepSeek harness binary/SDK available to the Guest image (not present in eaos-guest:0.1.4); probe non-interactive exec + event stream shape, session/resume, usage, approval model, then implement smallest DeepSeekHarnessAdapter for proven-only capabilities",
  },
] as const;

/**
 * Max promisable capability level (plan §5.2 L0–L4). A product may only
 * claim the level its adapter actually passed — this helper computes the
 * ceiling implied by reported capabilities.
 *   L0 single-turn text · L1 streaming/multi-turn · L2 structured tools +
 *   approval · L3 resume/usage/MCP · L4 A2UI + full governance.
 */
export function maxPromisableLevel(caps: EngineCapabilities): 0 | 1 | 2 | 3 | 4 {
  if (!caps.abort) return 0; // platform needs abort from L1 up
  if (!caps.streamingText) return 0;
  if (!caps.structuredToolEvents || !caps.preToolApproval) return 1;
  if (!caps.sessionResume || !caps.tokenUsage || !caps.mcp) return 2;
  if (!caps.a2ui) return 3;
  return 4;
}

// --- Framing -----------------------------------------------------------------

export interface ProtocolFrame {
  /** Wire protocol version — must equal RUNTIME_PROTOCOL_VERSION. */
  v: string;
  /**
   * Strictly increasing per direction, starting at 1. Duplicate seq →
   * idempotent drop; gap (seq > last+1) → protocol error (fail closed).
   */
  seq: number;
  kind: "command" | "event";
  body: PlatformRuntimeCommand | PlatformRuntimeEvent;
}

export class ProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolViolationError";
  }
}

/** Tracks per-direction sequence state; enforces duplicate/gap rules. */
export class FrameSequenceTracker {
  private lastSeq = 0;

  observe(seq: number): "accept" | "drop-duplicate" {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new ProtocolViolationError(`invalid seq ${seq} (must be integer ≥ 1)`);
    }
    if (seq <= this.lastSeq) return "drop-duplicate";
    if (seq > this.lastSeq + 1) {
      throw new ProtocolViolationError(`sequence gap: expected ${this.lastSeq + 1}, got ${seq}`);
    }
    this.lastSeq = seq;
    return "accept";
  }

  get last(): number {
    return this.lastSeq;
  }
}

/** Closed command surface (kind:"command"). Unknown wire types fail closed. */
const COMMAND_TYPES: ReadonlySet<string> = new Set([
  "start",
  "send_message",
  "approval_result",
  "a2ui_result",
  "compact",
  "abort",
  "model_result",
  "ping",
  "close",
]);

/** Closed event surface (kind:"event"). Unknown wire types fail closed. */
const EVENT_TYPES: ReadonlySet<string> = new Set([
  "runtime_ready",
  "session_updated",
  "assistant_text",
  "tool_requested",
  "tool_result",
  "approval_request",
  "a2ui_request",
  "workspace_changed",
  "turn_completed",
  "turn_failed",
  "runtime_error",
  "context_compacted",
  "pong",
  "model_request",
]);

/**
 * Shape validation shared by serialize (catch our own bugs) and parse (the
 * untrusted inbound path): version, integer seq ≥ 1, known kind, and a
 * body.type that is BOTH whitelisted and consistent with the kind.
 */
function assertFrameShape(frame: ProtocolFrame): void {
  if (frame.v !== RUNTIME_PROTOCOL_VERSION) {
    throw new ProtocolViolationError(`unsupported protocol version '${frame.v}'`);
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 1) {
    throw new ProtocolViolationError(`invalid seq ${frame.seq} (must be integer ≥ 1)`);
  }
  if (frame.kind !== "command" && frame.kind !== "event") {
    throw new ProtocolViolationError(`invalid frame kind '${frame.kind}'`);
  }
  const bodyType = (frame.body as { type?: unknown } | undefined)?.type;
  if (typeof bodyType !== "string") {
    throw new ProtocolViolationError("frame.body.type must be a string");
  }
  const allowed = frame.kind === "command" ? COMMAND_TYPES : EVENT_TYPES;
  if (!allowed.has(bodyType)) {
    throw new ProtocolViolationError(
      `unknown frame body type '${bodyType}' for kind '${frame.kind}' (closed ${frame.kind} surface)`,
    );
  }
}

export function serializeFrame(frame: ProtocolFrame): string {
  assertFrameShape(frame);
  const json = JSON.stringify(frame);
  // UTF-8 BYTES, not UTF-16 code units — multibyte payloads cannot slip past.
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw new ProtocolViolationError(`frame exceeds MAX_FRAME_BYTES (${bytes} > ${MAX_FRAME_BYTES})`);
  }
  return json;
}

export function parseFrame(text: string): ProtocolFrame {
  // Inbound byte cap BEFORE JSON.parse — never allocate structures for an
  // oversized frame.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_FRAME_BYTES) {
    throw new ProtocolViolationError(`frame exceeds MAX_FRAME_BYTES (${bytes} > ${MAX_FRAME_BYTES})`);
  }
  let frame: ProtocolFrame;
  try {
    frame = JSON.parse(text) as ProtocolFrame;
  } catch {
    throw new ProtocolViolationError("frame is not valid JSON");
  }
  assertFrameShape(frame);
  return frame;
}

// --- Neutrality guard ---------------------------------------------------------

/**
 * Keys that must NEVER appear inside a protocol frame — engine-private
 * structures (M0.5 acceptance: 协议中不出现 claudeSessionId 或 Claude
 * content block 等私有结构). Returns the offending key paths.
 */
export const ENGINE_PRIVATE_KEYS = [
  "claudeSessionId",
  "session_id", // raw SDK field — neutral form is engineSessionId
  "tool_use_id", // neutral form is toolCallId
  "tool_use",
  "content_block",
  "hookSpecificOutput",
  "permissionDecision",
  "slash_commands", // engine diagnostics (open-item ③)
  "total_cost_usd", // neutral form is costUsd
  "duration_ms", // neutral form is durationMs
  "ANTHROPIC_API_KEY",
] as const;

export function scanForEnginePrivateFields(value: unknown, path = "$"): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...scanForEnginePrivateFields(item, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((ENGINE_PRIVATE_KEYS as readonly string[]).includes(k)) hits.push(`${path}.${k}`);
      hits.push(...scanForEnginePrivateFields(v, `${path}.${k}`));
    }
  }
  return hits;
}
