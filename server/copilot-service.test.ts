// Minimal copilot reset — state-cleanup test.
// Run: tsx server/copilot-service.test.ts  (npm run test:copilot)
//
// Verifies the same-agent reset contract: reset returns the SAME agentId,
// clears the conversation history + the agent_sessions resume row (so the next
// message starts a fresh claudeSessionId), and preserves the agent/chat row.
// Uses an isolated temp DB so data/eaos.db is never touched. Docker is not
// required — containerManager.stopRuntime is a no-op without a managed runtime.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set DB_PATH BEFORE importing database.js (it reads the env at module load).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const { agentService } = await import("./agent-service.js");
const { resetCopilotAgent, setCopilotSessionCloser } = await import("./copilot-service.js");
const { eventStore } = await import("./event-store.js");
const db = (await import("./database.js")).default;

const count = (chatId: string): number =>
  (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE chat_id = ?").get(chatId) as { c: number }).c;
const appIdOf = (agentId: string): string =>
  (db.prepare("SELECT app_id AS appId FROM agents WHERE id = ?").get(agentId) as { appId: string }).appId;

// No real in-memory Session in the test → inject a no-op closer.
setCopilotSessionCloser(() => {});

const userId = "copilot-test-user";

// 1) getOrCreateCopilotAgent: creates on first use, stable on repeat calls.
const agent = agentService.getOrCreateCopilotAgent(userId);
assert.ok(agent.id, "copilot agent created with an id");
assert.equal(appIdOf(agent.id), "copilot", "copilot agent is under app_id='copilot'");
const sameAgain = agentService.getOrCreateCopilotAgent(userId);
assert.equal(sameAgain.id, agent.id, "getOrCreateCopilotAgent returns the SAME agent id");
const agentId = agent.id;

// 2) Seed a conversation: one message + an agent_sessions resume row w/ claudeSessionId.
db.prepare(
  "INSERT INTO messages (id, chat_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)"
).run("m1", agentId, "hello", new Date().toISOString());
const sess = eventStore.getOrCreateSession(userId, agentId, "local");
eventStore.updateClaudeSessionId(sess.id, "cls-old-session");
assert.equal(count(agentId), 1, "seeded one message");
assert.ok(eventStore.getSessionByChat(userId, agentId), "seeded an agent_sessions resume row");

// 3) Reset.
const after = await resetCopilotAgent(userId);
assert.equal(after.id, agentId, "reset returns the SAME agent id (no new agent)");

// 4) Conversation cleared + resume state reset; session row + agent/chat row
//    PRESERVED (reset ≠ governance wipe — audit/diagnostics kept).
assert.equal(count(agentId), 0, "reset clears the message history");
const afterSess = eventStore.getSessionByChat(userId, agentId);
assert.ok(afterSess, "reset preserves the agent_sessions row (audit/diagnostics kept)");
assert.ok(
  !afterSess!.claudeSessionId,
  "reset clears the resume claudeSessionId (→ fresh start next time, not a cold resume)"
);
assert.ok(agentService.getChat(agentId), "reset preserves the agent/chat row");

console.log("copilot-service tests passed");
process.exit(0);
