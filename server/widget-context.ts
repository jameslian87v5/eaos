/**
 * Widget W4 — page-context guardrail + runtime-input wrapping.
 *
 * Pure (no DB / runtime deps) so it is unit-testable. This is the security
 * boundary for host-provided page context:
 *  - `boundPageContext`: reject non-plain-JSON, cap size / depth / key count.
 *  - `wrapRuntimeInput`: build the runtime-only `<page-context>` + `<user-message>`
 *    input. This is fed to the agent runtime for the current turn and is NEVER
 *    persisted to chatStore or broadcast (platform history shows the typed text).
 *  - `contextSummary`: audit record — pageSessionId + sha256 + byte length +
 *    top-level keys only. No payload.
 *
 * Contract: docs/开发计划/widget-w4-page-context-contract.md (§4, §6).
 */
import { createHash } from "crypto";

export interface TurnContext {
  pageSessionId?: string;
  pageContext?: Record<string, unknown>;
}

export const PAGE_CONTEXT_DEFAULTS = {
  maxBytes: 8 * 1024, // 8 KB
  maxDepth: 3,
  maxKeys: 32,
};

export interface BoundContext {
  ok: boolean;
  value: Record<string, unknown> | null;
  warning?: string;
}

export interface BoundOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxKeys?: number;
}

/**
 * Validate + bound host page context. `null`/absent context is valid (no-op).
 * Returns `{ ok, value }` on success or `{ ok: false, warning }` on violation.
 * On violation the caller drops context for the turn but still sends the user
 * text (contract §4: "用户正文仍可发送").
 */
export function boundPageContext(raw: unknown, opts: BoundOptions = {}): BoundContext {
  const maxBytes = opts.maxBytes ?? PAGE_CONTEXT_DEFAULTS.maxBytes;
  const maxDepth = opts.maxDepth ?? PAGE_CONTEXT_DEFAULTS.maxDepth;
  const maxKeys = opts.maxKeys ?? PAGE_CONTEXT_DEFAULTS.maxKeys;

  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw) || Buffer.isBuffer(raw)) {
    return { ok: false, value: null, warning: "pageContext must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  // Plain-JSON boundary first (contract §4), before any key/size accounting.
  // JSON.parse input can't carry these, but the guard must not assume that.
  const valErr = validateJsonValue(obj, 0, maxDepth);
  if (valErr) return { ok: false, value: null, warning: valErr };

  const keys = Object.keys(obj);
  if (keys.length === 0) return { ok: true, value: null }; // empty = no-op
  if (keys.length > maxKeys) {
    return { ok: false, value: null, warning: `pageContext has too many top-level keys (${keys.length} > ${maxKeys})` };
  }

  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch {
    return { ok: false, value: null, warning: "pageContext is not serializable" };
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) {
    return { ok: false, value: null, warning: `pageContext too large (${bytes} > ${maxBytes} bytes)` };
  }

  return { ok: true, value: obj };
}

/**
 * Enforce the plain-JSON boundary + nesting depth on any value.
 *
 * Allowed: null, boolean, number, string, plain arrays, plain objects
 * (proto === Object.prototype). Rejected: functions, symbols, bigint,
 * undefined, Date/class instances, Buffer/ArrayBuffer/typed arrays, and
 * over-depth nesting. Nested arrays ARE allowed (treated as JSON arrays);
 * their children + depth are validated. A cycle is caught by the depth cap.
 */
function validateJsonValue(node: unknown, depth: number, maxDepth: number): string | null {
  if (node === null) return null;
  const t = typeof node;
  if (t === "string" || t === "number" || t === "boolean") return null;
  if (t === "undefined" || t === "symbol" || t === "bigint" || t === "function") {
    return `pageContext contains a non-JSON value (${t})`;
  }
  // typeof === "object"
  if (Buffer.isBuffer(node) || node instanceof ArrayBuffer || ArrayBuffer.isView(node)) {
    return "pageContext contains a binary value (Buffer/typed array)";
  }
  if (depth >= maxDepth) return `pageContext exceeds max nesting depth ${maxDepth}`;
  if (Array.isArray(node)) {
    for (const item of node) {
      const err = validateJsonValue(item, depth + 1, maxDepth);
      if (err) return err;
    }
    return null;
  }
  if (Object.getPrototypeOf(node) !== Object.prototype) {
    return "pageContext must be plain JSON (no Date/class instances)";
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const err = validateJsonValue(v, depth + 1, maxDepth);
    if (err) return err;
  }
  return null;
}

/**
 * Build the runtime-only input wrapping bounded page context + user content.
 * Not persisted, not broadcast — fed to the agent runtime for this turn only.
 * Format per contract §6.
 */
export function wrapRuntimeInput(content: string, pageContext: Record<string, unknown>): string {
  return (
    `<page-context>\n${JSON.stringify(pageContext)}\n</page-context>\n\n` +
    `<user-message>\n${content}\n</user-message>`
  );
}

export interface ContextSummary {
  pageSessionId?: string;
  contextHash: string;
  contextLen: number;
  keys: string[];
}

/** Audit summary — NO payload. Hash is for change identity, not secrecy. */
export function contextSummary(
  pageContext: Record<string, unknown>,
  pageSessionId?: string
): ContextSummary {
  const json = JSON.stringify(pageContext);
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  return {
    pageSessionId,
    contextHash: hash,
    contextLen: Buffer.byteLength(json, "utf8"),
    keys: Object.keys(pageContext),
  };
}
