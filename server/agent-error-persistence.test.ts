/**
 * agent-error-persistence.test.ts — S1 round-2 adversarial tests for the
 * durable agent-error storage encoding.
 *
 * Codex verification (evt_20261008103903) found that decoding ANY assistant
 * row whose content starts with "[agent_error] " let a user/model-forced
 * assistant message be reclassified as a platform error. The fix gates
 * decoding on the reserved storage pair (role "tool_use" + tool_name
 * "__agent_error__"), which normal writes never produce.
 *
 * Cases:
 *  T1 plain assistant with EXACT error-ish prefix stays assistant, verbatim.
 *  T2 synthetic system error decodes to role:"system" + isError + systemKind.
 *  T3 repeat synthetic error within the 10s window dedups (same row id).
 *  T4 synthetic error and a normal assistant with IDENTICAL content do not
 *     cross-dedup (both rows survive).
 *  T5 no schema migration: the messages CHECK constraint still rejects a raw
 *     role:"system" insert (the encoding is the only way in).
 *  T6 legacy tool rows (role tool_use, real tool_name) are untouched.
 *
 * Run: DB_PATH=/tmp/s1-agent-error.db JWT_SECRET=test npx tsx server/agent-error-persistence.test.ts
 */

import assert from "node:assert/strict";
import { chatStore, AGENT_ERROR_TOOL_NAME } from "./chat-store.js";
import db from "./database.js";

const freshChat = (title: string) => chatStore.createChat(`u-${title}`, title);

// T1: a plain assistant message whose content EXACTLY starts with the old
// prefix form is NOT reclassified — no isError, no strip, role unchanged.
{
  const chat = freshChat("t1-forge2");
  chatStore.addMessage(chat.id, {
    role: "assistant",
    content: "[agent_error] user-forced assistant prefix",
  } as any);
  const rows = chatStore.getMessages(chat.id);
  const forged = rows.find((r: any) => r.content?.includes("user-forced"));
  assert.ok(forged, "T1: forged assistant row present");
  assert.equal((forged as any).role, "assistant", "T1: role stays assistant");
  assert.equal((forged as any).isError, undefined, "T1: no isError flag");
  assert.equal(
    (forged as any).content,
    "[agent_error] user-forced assistant prefix",
    "T1: content verbatim (no prefix strip)"
  );
  assert.equal((forged as any).systemKind, undefined, "T1: no systemKind");
  console.log("✓ T1 plain assistant with exact prefix stays verbatim (not reclassified)");
}

// T2: synthetic error encodes to the reserved pair and decodes to system.
{
  const chat = freshChat("t2-encode");
  chatStore.addMessage(chat.id, { role: "system", content: "消息未送达 Agent: boom" });
  const raw = db
    .prepare(`SELECT role, content, tool_name FROM messages WHERE chat_id = ?`)
    .all(chat.id) as any[];
  const synth = raw.find((r) => r.tool_name === AGENT_ERROR_TOOL_NAME);
  assert.ok(synth, "T2: raw row carries the reserved tool_name");
  assert.equal(synth.role, "tool_use", "T2: raw role is the reserved tool_use");
  assert.equal(synth.content, "消息未送达 Agent: boom", "T2: raw content is the error text");
  const decoded = chatStore.getMessages(chat.id).find((m: any) => m.isError);
  assert.ok(decoded, "T2: decoded row present");
  assert.equal((decoded as any).role, "system", "T2: decoded role system");
  assert.equal((decoded as any).isError, true, "T2: isError true");
  assert.equal((decoded as any).systemKind, "error", "T2: systemKind error");
  assert.equal((decoded as any).content, "消息未送达 Agent: boom", "T2: content intact");
  console.log("✓ T2 synthetic error encodes (tool_use + __agent_error__) and decodes (system/isError)");
}

// T3: repeat synthetic error within 10s dedups to the SAME row.
{
  const chat = freshChat("t3-dedup");
  const first = chatStore.addMessage(chat.id, { role: "system", content: "err-x" });
  const second = chatStore.addMessage(chat.id, { role: "system", content: "err-x" });
  assert.equal(second.id, first.id, "T3: repeat error dedups to same row");
  const count = (
    db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?`).get(chat.id) as any
  ).c;
  assert.equal(count, 1, "T3: exactly one physical row");
  console.log("✓ T3 repeat synthetic error still dedups");
}

// T4: synthetic error + normal assistant with IDENTICAL content — both survive.
{
  const chat = freshChat("t4-cross");
  const err = chatStore.addMessage(chat.id, { role: "system", content: "same text" });
  const plain = chatStore.addMessage(chat.id, { role: "assistant", content: "same text" } as any);
  assert.notEqual(plain.id, err.id, "T4: no cross-dedup between error and plain assistant");
  const rows = chatStore.getMessages(chat.id);
  assert.equal(rows.length, 2, "T4: both rows survive");
  const decoded = rows.find((m: any) => m.isError);
  const plainRow = rows.find((m: any) => !m.isError);
  assert.equal((decoded as any)?.role, "system", "T4: error decodes as system");
  assert.equal((plainRow as any)?.role, "assistant", "T4: plain stays assistant");
  console.log("✓ T4 synthetic error and identical-content assistant never cross-dedup");
}

// T5: no schema migration — the CHECK constraint still rejects role "system"
// written directly, proving the encoding is the only path in.
{
  const chat = freshChat("t5-check");
  const stmt = db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, timestamp) VALUES (?, ?, 'system', ?, ?)`
  );
  assert.throws(
    () => stmt.run(`t5-${Date.now()}`, chat.id, "raw", new Date().toISOString()),
    /CHECK constraint/i,
    "T5: raw role:system insert must fail (constraint intact, no migration)"
  );
  console.log("✓ T5 messages CHECK constraint intact — no schema migration happened");
}

// T6: a legacy tool row (role tool_use with a REAL tool name) is untouched.
{
  const chat = freshChat("t6-legacy");
  db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, tool_name, timestamp) VALUES (?, ?, 'tool_use', 'tool output', 'Read', ?)`
  ).run(`t6-${Date.now()}`, chat.id, new Date().toISOString());
  const rows = chatStore.getMessages(chat.id);
  assert.equal(rows.length, 1, "T6: legacy tool row present");
  const row = rows[0] as any;
  assert.equal(row.role, "tool_use", "T6: role unchanged");
  assert.equal(row.isError, undefined, "T6: not flagged as error");
  assert.equal(row.toolName, "Read", "T6: tool_name preserved");
  console.log("✓ T6 legacy tool_use rows untouched by the decode gate");
}

console.log("\nAll agent-error-persistence tests passed.");
