/**
 * local-sandbox-history.ts — M5-S4 C: engine-neutral bounded history snapshot.
 *
 * Host-side helper that reads chat history from ChatStore and produces a
 * BOUNDED, REDACTED snapshot suitable for the transient Host→Guest
 * `start{history}` payload (cold recovery).
 *
 * Frozen invariants (artifact §C):
 *   - Only user/assistant TEXT messages (role ∈ {user, assistant}, toolName
 *     null — tool calls/results carry payloads that must not be replayed).
 *   - Last 20 messages, total ≤ 40,000 chars (tail-truncate: keep the most
 *     recent N that fit under the char cap).
 *   - No system prompts, no credentials, no tool input/output, no A2UI
 *     internal submission protocol, no file binary content.
 *   - Read failure → throw (fail closed — the caller MUST surface a
 *     diagnosable startup failure, never silently continue with empty
 *     context).
 *
 * restoreMode = "history_replay" (NOT Claude SDK session resume). The
 * `resumeToken` field is retained on the start command for future engine
 * adapters but is ignored by the current Guest worker.
 */

import type { ChatMessage } from "./types.js";

/**
 * Structural ChatStore type (only the getMessages method is used). Widened
 * role: string so test stubs that return `{ role: string }` are assignable;
 * the real chatStore.getMessages returns ChatMessage[] (role: "user"|"assistant")
 * which is assignable to this wider shape.
 */
export interface ChatStoreLike {
  getMessages(chatId: string): ReadonlyArray<{ role: string; content: string; toolName?: string | null }>;
}

/** Keep the import for type-completeness; unused at runtime. */
export type { ChatMessage };

/** A single replay message — minimal neutral shape (role + text content). */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Default bounds (artifact §C: last 20, ≤ 40,000 chars). */
export const DEFAULT_HISTORY_MAX_MESSAGES = 20;
export const DEFAULT_HISTORY_MAX_CHARS = 40_000;

export interface SnapshotHistoryOptions {
  maxMessages?: number;
  maxChars?: number;
}

/**
 * Extract a bounded, redacted history snapshot from a raw ChatMessage stream.
 * Pure: no I/O, no clock. Throws on read failure (fail closed).
 *
 * Rules:
 *   1. Filter to role ∈ {user, assistant} AND toolName null (text only —
 *      tool calls, tool results, and system messages are dropped).
 *   2. Take the tail (most recent N) where N ≤ maxMessages.
 *   3. Tail-truncate by char budget: walk from newest backward, accumulate
 *      until the char cap is reached; drop older messages that don't fit.
 *   4. Return in chronological order (oldest-first) so the Guest can push
 *      them into `conversation` verbatim.
 */
export function snapshotHistory(
  raw: ReadonlyArray<{ role: string; content: string; toolName?: string | null }>,
  opts: SnapshotHistoryOptions = {},
): HistoryMessage[] {
  const maxMessages = opts.maxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_HISTORY_MAX_CHARS;
  if (!Number.isFinite(maxMessages) || maxMessages < 0) {
    throw new Error(`history snapshot: maxMessages must be a non-negative number (got ${maxMessages})`);
  }
  if (!Number.isFinite(maxChars) || maxChars < 0) {
    throw new Error(`history snapshot: maxChars must be a non-negative number (got ${maxChars})`);
  }
  // Step 1: text-only user/assistant messages.
  const textMsgs: HistoryMessage[] = [];
  for (const m of raw) {
    if (typeof m?.role !== "string" || typeof m?.content !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    // toolName non-null = tool call/result record (carries payload). Drop.
    if (m.toolName !== undefined && m.toolName !== null && m.toolName !== "") continue;
    textMsgs.push({ role: m.role as "user" | "assistant", content: m.content });
  }
  if (textMsgs.length === 0) return [];
  // Step 2: tail N.
  const tail = textMsgs.slice(-Math.max(0, Math.floor(maxMessages)));
  if (tail.length === 0) return [];
  // Step 3: tail-truncate by char budget (newest first, then reverse back).
  let budget = Math.floor(maxChars);
  const keptReversed: HistoryMessage[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const msg = tail[i]!;
    const len = msg.content.length;
    if (len > budget) break; // older message doesn't fit — stop (keeps contiguity)
    keptReversed.push(msg);
    budget -= len;
  }
  // Step 4: chronological order.
  return keptReversed.reverse();
}

/**
 * Read chat history from ChatStore and snapshot it. Throws on store errors
 * (fail closed — the caller MUST surface a diagnosable startup failure).
 */
export function snapshotChatHistory(
  chatId: string,
  store: ChatStoreLike,
  opts: SnapshotHistoryOptions = {},
): HistoryMessage[] {
  if (typeof chatId !== "string" || chatId.length === 0) {
    throw new Error("history snapshot: chatId required (fail closed)");
  }
  let messages: ReturnType<typeof store.getMessages>;
  try {
    messages = store.getMessages(chatId);
  } catch (e) {
    // Fail closed: a store error must NOT silently continue with empty
    // context (that would mask the failure as "recovered"). Throw so the
    // caller surfaces a diagnosable startup failure.
    throw new Error(`history snapshot: failed to read messages for chat '${chatId}': ${(e as Error).message}`);
  }
  return snapshotHistory(messages, opts);
}
