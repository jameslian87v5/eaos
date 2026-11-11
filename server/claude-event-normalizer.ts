/**
 * Claude raw-event → PlatformRuntimeEvent normalizer (M0.5).
 *
 * Contract source: docs/02-architecture/runtime-harness-coupling-inventory.md
 * (SN-01…SN-13) and the parity case IDs P-*. This module is deliberately NOT
 * wired into the production Session/Runtime path — M0.5 only freezes the
 * protocol + normalizer contract; Session migration is M3 (per-event-type
 * cutover with dual-path parity tests).
 *
 * Stateful by necessity: final-text dedup (P-TXT-02) and the internal
 * show_ui chip filter (P-A2UI-02) require memory across frames.
 */

import {
  CLAUDE_ENGINE_CAPABILITIES,
  MAX_TEXT_CHARS,
  MAX_TOOL_PAYLOAD_CHARS,
  type PlatformRuntimeEvent,
  type TokenUsage,
} from "./platform-runtime-protocol.js";

const SECRET_KEY_RE = /api[_-]?key|authorization|(^|_)token(_|$)|secret|password|credential/i;
const MAX_REDACT_DEPTH = 6;
const MAX_REDACT_ARRAY = 50;
/** Per-object key cap — a wide object cannot outgrow the view via key count. */
const MAX_REDACT_KEYS = 64;
/**
 * Declared serialized bound for ONE sanitized payload view (matches the
 * session.ts tool-payload truncation). JSON.stringify(view) NEVER exceeds it.
 */
export const MAX_REDACT_VIEW_CHARS = MAX_TOOL_PAYLOAD_CHARS;
/**
 * Worst-case serialization overshoot from truncation markers emitted after
 * the budget is spent (≤ one marker per recursion level). Kept under the
 * declared cap by initializing the budget at cap − margin.
 */
const TRUNCATION_MARGIN = 256;

const REDACTED = "[redacted]";
const DEPTH_EXCEEDED = "[depth-exceeded]";
const VIEW_TRUNCATED = "[view-truncated]";

/** Truncate a string payload to a transport bound. */
export function boundedText(s: string, max = MAX_TOOL_PAYLOAD_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}

/**
 * Serialized-size budget for one redacted view. Every node charges its own
 * JSON length (+1 separator); when the budget runs out, traversal stops and
 * a marker replaces the remainder — the FINAL view stays ≤ the declared cap.
 */
interface ViewBudget {
  left: number;
}

function charge(b: ViewBudget, serializedLen: number): boolean {
  if (serializedLen + 1 > b.left) return false;
  b.left -= serializedLen + 1;
  return true;
}

function redactBounded(value: unknown, depth: number, b: ViewBudget): unknown {
  // Markers are CHARGED where created; when even a marker cannot be afforded
  // an uncharged VIEW_TRUNCATED is returned and every consuming loop breaks —
  // so uncharged output is bounded to one marker per recursion level (≤ depth
  // cap), which the TRUNCATION_MARGIN covers.
  if (depth > MAX_REDACT_DEPTH) {
    return charge(b, DEPTH_EXCEEDED.length + 2) ? DEPTH_EXCEEDED : VIEW_TRUNCATED;
  }
  if (typeof value === "string") {
    const v = boundedText(value);
    return charge(b, v.length + 2) ? v : VIEW_TRUNCATED;
  }
  if (Array.isArray(value)) {
    if (!charge(b, 2)) return VIEW_TRUNCATED;
    const out: unknown[] = [];
    const max = Math.min(value.length, MAX_REDACT_ARRAY);
    for (let i = 0; i < max; i += 1) {
      if (b.left <= 0) {
        out.push(VIEW_TRUNCATED);
        break;
      }
      const v = redactBounded(value[i], depth + 1, b);
      out.push(v);
      if (v === VIEW_TRUNCATED) break; // budget gone — stop consuming
    }
    if (value.length > max && charge(b, 24)) out.push(VIEW_TRUNCATED);
    return out;
  }
  if (value && typeof value === "object") {
    if (!charge(b, 2)) return VIEW_TRUNCATED;
    const src = value as Record<string, unknown>;
    const keys = Object.keys(src);
    const out: Record<string, unknown> = {};
    const max = Math.min(keys.length, MAX_REDACT_KEYS);
    for (let i = 0; i < max; i += 1) {
      const k = keys[i];
      // Secret-shaped keys are ALWAYS masked, never dropped by truncation.
      if (SECRET_KEY_RE.test(k)) {
        if (!charge(b, k.length + 3 + REDACTED.length + 2)) break;
        out[k] = REDACTED;
      } else {
        if (!charge(b, k.length + 3)) break;
        if (b.left <= 0) break;
        out[k] = redactBounded(src[k], depth + 1, b);
      }
    }
    if (keys.length > max && charge(b, 32)) out["…"] = `${keys.length - max}+ keys truncated`;
    return out;
  }
  // number / boolean / null
  return charge(b, String(value ?? "null").length) ? value : VIEW_TRUNCATED;
}

/**
 * Bounded, redacted transport view for UI-facing payloads (approval input,
 * tool input/output). Secret-shaped keys are masked; strings are capped;
 * depth, array width, object key count AND total serialized size are bounded
 * (MAX_REDACT_VIEW_CHARS). Never used for audit persistence.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  const budget: ViewBudget = { left: MAX_REDACT_VIEW_CHARS - TRUNCATION_MARGIN };
  return redactBounded(value, depth, budget);
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * usage mapping (P-RES-02): SDK snake_case → platform camelCase. Field names
 * MUST stay in sync with quota-service json_extract ($.usage.inputTokens…).
 */
export function extractTokenUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const raw = u as Record<string, unknown>;
  const inputTokens = numOrUndef(raw.input_tokens);
  const outputTokens = numOrUndef(raw.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const usage: TokenUsage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  const cacheRead = numOrUndef(raw.cache_read_input_tokens);
  const cacheWrite = numOrUndef(raw.cache_creation_input_tokens);
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return usage;
}

/** The internal blocking-UI tool: its tool_use/tool_result carry no chips. */
const INTERNAL_UI_TOOL_NAME = "show_ui";

export class ClaudeEventNormalizer {
  /**
   * Hard cap on tracked internal tool ids: unclosed show_ui calls (engine
   * aborted mid-tool) must not grow memory forever. FIFO eviction — the
   * oldest id degrades to a normal tool_result event, newest stay filtered.
   */
  private static readonly MAX_INTERNAL_TOOL_IDS = 256;

  /** Trimmed texts already emitted THIS TURN — final-text dedup keys. */
  private emittedTexts = new Set<string>();
  /** tool_call ids of internal show_ui calls (chip filter, P-A2UI-02). */
  private internalToolCallIds = new Map<string, true>();
  private engineSessionId: string | undefined;
  private readyEmitted = false;

  /** Feed one raw SDK/IPC frame; returns the platform events it maps to. */
  push(raw: unknown): PlatformRuntimeEvent[] {
    const events: PlatformRuntimeEvent[] = [];
    const msg = (raw ?? {}) as Record<string, unknown>;

    // Session capture from ANY frame carrying it (docker IPC semantics,
    // P-SESS-01). Neutral name only — the raw field never crosses.
    if (this.engineSessionId === undefined && typeof msg.session_id === "string" && msg.session_id) {
      this.engineSessionId = msg.session_id;
      if (this.readyEmitted) {
        events.push({ type: "session_updated", engineSessionId: msg.session_id });
      }
    }

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          // Open-item ③: diagnostics (model/cwd/tools/skills/plugins/mcp
          // snapshot, slash_commands) stay adapter-side — NOT mapped.
          if (!this.readyEmitted) {
            this.readyEmitted = true;
            events.push({
              type: "runtime_ready",
              ...(this.engineSessionId !== undefined ? { engineSessionId: this.engineSessionId } : {}),
              capabilities: CLAUDE_ENGINE_CAPABILITIES,
            });
          }
        } else if (msg.subtype === "compact_boundary") {
          const meta = (msg.compact_metadata ?? {}) as Record<string, unknown>;
          events.push({
            type: "context_compacted",
            ...(numOrUndef(meta.pre_tokens) !== undefined ? { preTokens: numOrUndef(meta.pre_tokens) } : {}),
            ...(numOrUndef(meta.post_tokens) !== undefined ? { postTokens: numOrUndef(meta.post_tokens) } : {}),
            ...(strOrUndef(meta.trigger) !== undefined ? { trigger: strOrUndef(meta.trigger) } : {}),
          });
        }
        // Unknown system subtypes: no protocol mapping (host-side fallback
        // for command output is documented in the mapping doc).
        break;
      }

      case "assistant": {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (typeof content === "string") {
          this.emitText(content, false, events);
        } else if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "text" && typeof block.text === "string") {
              this.emitText(block.text, false, events);
            } else if (block.type === "tool_use") {
              if (block.name === INTERNAL_UI_TOOL_NAME) {
                if (typeof block.id === "string" && block.id) {
                  if (this.internalToolCallIds.size >= ClaudeEventNormalizer.MAX_INTERNAL_TOOL_IDS) {
                    const oldest = this.internalToolCallIds.keys().next().value;
                    if (oldest !== undefined) this.internalToolCallIds.delete(oldest);
                  }
                  this.internalToolCallIds.set(block.id, true);
                }
                continue; // the card IS the UI (P-A2UI-02)
              }
              events.push({
                type: "tool_requested",
                toolCallId: String(block.id ?? ""),
                toolName: String(block.name ?? ""),
                ...(block.input !== undefined ? { input: redactSecrets(block.input) } : {}),
              });
            }
          }
        }
        break;
      }

      case "user": {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) break;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== "tool_result") continue;
          const toolCallId = String(block.tool_use_id ?? "");
          if (this.internalToolCallIds.delete(toolCallId)) continue; // consumed in-turn
          const resultContent = block.content;
          const output = Array.isArray(resultContent)
            ? boundedText((resultContent as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n"))
            : typeof resultContent === "string"
              ? boundedText(resultContent)
              : undefined;
          events.push({
            type: "tool_result",
            toolCallId,
            success: !block.is_error,
            ...(output !== undefined ? { output } : {}),
          });
        }
        break;
      }

      case "approval_request": {
        // Docker IPC frame (agent-entry synthesizes from the PreToolUse hook):
        // {id, toolName, toolInput, toolUseId} → neutral shape + redaction.
        events.push({
          type: "approval_request",
          requestId: String(msg.id ?? ""),
          toolName: String(msg.toolName ?? ""),
          ...(strOrUndef(msg.toolUseId) !== undefined ? { toolCallId: strOrUndef(msg.toolUseId) } : {}),
          ...(msg.toolInput !== undefined ? { input: redactSecrets(msg.toolInput) } : {}),
        });
        break;
      }

      case "a2ui_request": {
        // Docker IPC frame — already neutral; pass through bounded envelope.
        // Envelope hygiene mirrors the Host revalidation rules (session.ts):
        // requestId non-empty; timeoutSec absent or a finite number ≥ 1.
        // An INVALID envelope field drops the whole event (respondInvalid
        // semantics) — the Host never sees a half-valid request.
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        if (!requestId || requestId.length > 100) break;
        const timeoutSec = msg.timeoutSec;
        const timeoutInvalid =
          timeoutSec !== undefined &&
          !(typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec >= 1);
        if (timeoutInvalid) break;
        events.push({
          type: "a2ui_request",
          requestId,
          block: msg.block,
          ...(typeof timeoutSec === "number" ? { timeoutSec } : {}),
        });
        break;
      }

      case "result": {
        const success = msg.subtype === "success";
        // P-TXT-02: result-only final text, deduped against streamed text.
        const resultText = typeof msg.result === "string" ? msg.result : null;
        if (resultText !== null && resultText.trim()) {
          this.emitText(resultText, true, events);
        }
        if (success) {
          const usage = extractTokenUsage(msg.usage);
          events.push({
            type: "turn_completed",
            ...(usage !== undefined ? { usage } : {}),
            ...(numOrUndef(msg.total_cost_usd) !== undefined ? { costUsd: numOrUndef(msg.total_cost_usd) } : {}),
            ...(numOrUndef(msg.duration_ms) !== undefined ? { durationMs: numOrUndef(msg.duration_ms) } : {}),
          });
        } else {
          events.push({
            type: "turn_failed",
            category: "engine",
            message: boundedText(
              resultText ?? strOrUndef(msg.message) ?? `engine result subtype=${String(msg.subtype)}`
            ),
          });
        }
        // Turn boundary (completed OR failed): per-turn state is invalid from
        // here — final-text dedup keys must not suppress the next turn's
        // identical text, and unclosed internal tool ids start a fresh set.
        this.emittedTexts.clear();
        this.internalToolCallIds.clear();
        break;
      }

      case "error": {
        events.push({ type: "runtime_error", category: "engine", message: boundedText(String(msg.error ?? "unknown")) });
        break;
      }

      default:
        // Unknown frame types are dropped (fail-closed surface: the protocol
        // event union is closed; adapters must map before the boundary).
        break;
    }

    return events;
  }

  private emitText(text: string, final: boolean, out: PlatformRuntimeEvent[]): void {
    const key = text.trim();
    if (!key) return;
    if (final && this.emittedTexts.has(key)) return; // already streamed
    this.emittedTexts.add(key);
    out.push({ type: "assistant_text", text: boundedText(text, MAX_TEXT_CHARS), final });
  }
}
