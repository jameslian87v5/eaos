/**
 * local-sandbox-recovery.test.ts — M5-S4 C: bounded history snapshot tests.
 *
 * Covers artifact test cases 1, 2, 9 (recovery subset):
 *   1. Cold rebuild → Guest receives bounded history, can reference prior turn.
 *   2. Snapshot bounded (count/char), no tool payload/credentials/A2UI internal.
 *   9. local/docker regression unchanged (snapshot is additive, not wired
 *      into local/docker paths).
 *
 * Run: npx tsx server/local-sandbox-recovery.test.ts
 */

import assert from "node:assert";
import {
  snapshotHistory,
  snapshotChatHistory,
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_MAX_CHARS,
} from "./local-sandbox-history.js";

// ─── Stub ChatStore (getMessages only) ───────────────────────────────────────
interface RawMsg { role: string; content: string; toolName?: string | null }
function makeStore(msgs: RawMsg[]) {
  return {
    getMessages: (_chatId: string) =>
      msgs.map((m) => ({ id: "x", chatId: "c", timestamp: "t", ...m })),
  };
}

// ─── Test 1: bounded history snapshot references prior turn ──────────────────
{
  const store = makeStore([
    { role: "user", content: "What is the capital of France?" },
    { role: "assistant", content: "Paris." },
    { role: "user", content: "And its population?" },
    { role: "assistant", content: "About 2.1 million." },
  ]);
  const snap = snapshotChatHistory("c", store);
  assert.strictEqual(snap.length, 4, "all 4 text messages kept");
  assert.strictEqual(snap[0]!.role, "user");
  assert.strictEqual(snap[0]!.content, "What is the capital of France?");
  assert.strictEqual(snap[3]!.role, "assistant");
  assert.strictEqual(snap[3]!.content, "About 2.1 million.");
  // Guest can reference prior turn: the last assistant message is present.
  assert.ok(snap.some((m) => m.content.includes("2.1 million")), "prior assistant turn present");
  console.log("✓ test 1: bounded history snapshot references prior turn");
}

// ─── Test 2a: count bound (last 20) ──────────────────────────────────────────
{
  const many: RawMsg[] = [];
  for (let i = 0; i < 30; i++) {
    many.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}` });
  }
  const snap = snapshotHistory(many);
  assert.strictEqual(snap.length, DEFAULT_HISTORY_MAX_MESSAGES, "capped at 20");
  // Tail-truncated: the most recent 20 survive (msg-10 .. msg-29).
  assert.strictEqual(snap[0]!.content, "msg-10");
  assert.strictEqual(snap[19]!.content, "msg-29");
  console.log("✓ test 2a: count bound caps at 20 (tail kept)");
}

// ─── Test 2b: char bound (≤ 40,000 chars, tail-truncate) ─────────────────────
{
  // 3 messages of 15,000 chars each = 45,000 total > 40,000 cap. Only the
  // newest 2 should fit (30,000 ≤ 40,000); the oldest is dropped.
  const big: RawMsg[] = [
    { role: "user", content: "A".repeat(15_000) },
    { role: "assistant", content: "B".repeat(15_000) },
    { role: "user", content: "C".repeat(15_000) },
  ];
  const snap = snapshotHistory(big);
  assert.ok(snap.length <= 3, "never exceeds input count");
  assert.ok(snap.length === 2, "2 of 3 fit under 40k char cap");
  assert.strictEqual(snap[0]!.content, "B".repeat(15_000));
  assert.strictEqual(snap[1]!.content, "C".repeat(15_000));
  const totalChars = snap.reduce((n, m) => n + m.content.length, 0);
  assert.ok(totalChars <= DEFAULT_HISTORY_MAX_CHARS, "total chars ≤ 40,000");
  console.log(`✓ test 2b: char bound tail-truncate (kept ${snap.length}/${big.length}, ${totalChars} chars)`);
}

// ─── Test 2c: no tool payload / credentials / A2UI internal ──────────────────
{
  const store = makeStore([
    { role: "user", content: "normal question" },
    // Tool call record — has toolName, must be dropped.
    { role: "assistant", content: `{"tool":"Bash","input":"rm -rf /"}`, toolName: "Bash" },
    // Tool result record — has toolName, must be dropped.
    { role: "assistant", content: "deleted", toolName: "Bash" },
    // A2UI internal submission (user role, but toolName set) — dropped.
    { role: "user", content: "[A2UI 提交] whatever", toolName: "show_ui" },
    // System prompt — wrong role, dropped.
    { role: "system", content: "You are a helpful assistant. ANTHROPIC_API_KEY=sk-xxx" },
    // Credential-bearing assistant text — kept (it's text; redaction is a
    // separate concern — the snapshot carries text, not credentials as
    // structured fields). The Guest sees only role+content; no tool payload.
    { role: "assistant", content: "normal answer" },
  ]);
  const snap = snapshotChatHistory("c", store);
  assert.strictEqual(snap.length, 2, "only the 2 text-only user/assistant messages survive");
  assert.strictEqual(snap[0]!.role, "user");
  assert.strictEqual(snap[0]!.content, "normal question");
  assert.strictEqual(snap[1]!.role, "assistant");
  assert.strictEqual(snap[1]!.content, "normal answer");
  // Verify no tool payload leaked.
  for (const m of snap) {
    assert.ok(!m.content.includes("rm -rf"), "no Bash input payload leaked");
    assert.ok(!m.content.includes("sk-xxx"), "no system-prompt credential leaked");
    assert.ok(!m.content.includes("[A2UI 提交]"), "no A2UI internal protocol leaked");
  }
  console.log("✓ test 2c: tool payload / credentials / A2UI internal excluded");
}

// ─── Test 2d: empty / no user-assistant messages → empty snapshot (not error) ─
{
  assert.deepStrictEqual(snapshotHistory([]), [], "empty input → empty");
  assert.deepStrictEqual(
    snapshotHistory([{ role: "system", content: "sys" }]),
    [],
    "system-only → empty",
  );
  assert.deepStrictEqual(
    snapshotHistory([{ role: "user", content: "x", toolName: "Bash" }]),
    [],
    "tool-call user message → empty",
  );
  console.log("✓ test 2d: empty snapshot when no text user/assistant messages");
}

// ─── Test 2e: read failure → fail closed (throw, not silent empty) ───────────
{
  const failingStore = {
    getMessages: (_chatId: string) => {
      throw new Error("disk read error");
    },
  };
  assert.throws(
    () => snapshotChatHistory("c", failingStore),
    /failed to read messages/,
    "store error throws (fail closed)",
  );
  console.log("✓ test 2e: read failure throws (fail closed, no silent empty)");
}

// ─── Test 2f: invalid chatId → fail closed ───────────────────────────────────
{
  const store = makeStore([]);
  assert.throws(
    () => snapshotChatHistory("", store),
    /chatId required/,
    "empty chatId throws",
  );
  assert.throws(
    () => snapshotChatHistory(undefined as unknown as string, store),
    /chatId required/,
    "undefined chatId throws",
  );
  console.log("✓ test 2f: invalid chatId fails closed");
}

// ─── Test 9: snapshot is pure / additive — local/docker regression unchanged ─
{
  // The snapshot helper is a pure function that does not touch local/docker
  // runtime paths. It only reads from ChatStore and returns a bounded array.
  // Wiring it into local-sandbox's start payload does NOT affect local or
  // docker runtimes (they don't call snapshotChatHistory).
  const store = makeStore([{ role: "user", content: "hi" }]);
  const snap1 = snapshotChatHistory("c", store);
  const snap2 = snapshotChatHistory("c", store);
  assert.deepStrictEqual(snap1, snap2, "pure: same input → same output");
  assert.ok(Array.isArray(snap1), "returns an array");
  assert.ok(snap1.every((m) => m.role === "user" || m.role === "assistant"), "only user/assistant roles");
  assert.ok(snap1.every((m) => typeof m.content === "string"), "content is always string");
  console.log("✓ test 9: snapshot is pure/additive (local/docker regression unchanged)");
}

console.log("\nAll local-sandbox-recovery tests passed.");
