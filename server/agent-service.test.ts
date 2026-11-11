// Run: npm run test:agent-service
// Phase 5 storage split: AgentService owns the canonical `agents` table via the
// same-id bridge (agents.id == chats.id). This test exercises the REAL chatStore
// + agentService against a temp DB (DB_PATH env).
//
// It REPLACES the Phase 1 "transparent delegation wrapper" test: Phase 5
// intentionally makes getChat/getAllChats read from `agents` and makes
// createChat/deleteChat maintain the sibling row, so a recording fake no longer
// reflects reality. The same-id invariant + backfill + self-heal are the new
// contract under test.
import assert from "node:assert/strict";
import db from "./database.js";
import { chatStore } from "./chat-store.js";
import { agentService } from "./agent-service.js";
import { capabilityProvider } from "./capability-provider.js";
import { computeConfigVersion } from "./capability-version.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Hermetic: tables are CREATE IF NOT EXISTS, so a temp DB reused across runs
// accumulates rows. Clear them (chats CASCADE cleans messages/sessions/events/
// workspace_files; agents has no FK so it is cleared explicitly).
db.exec("DELETE FROM agents");
db.exec("DELETE FROM chats");

// 1. chatStore.createChat writes chats + the agents sibling (same id) and
//    returns a Chat whose shape is byte-identical to pre-Phase-5 — i.e. no Agent
//    fields leak into the /api/chats response.
const chat = chatStore.createChat("u1", "My Agent");
assert.deepEqual(
  Object.keys(chat).sort(),
  // Phase 7: orgId is now a Chat field (chats.org_id tenant key), not an Agent
  // field leaking through — status/profileId/appId stay excluded.
  ["createdAt", "id", "orgId", "title", "updatedAt", "userId"],
  "createChat returns Chat shape (no agent fields leak into /api/chats)"
);
const agentsRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(chat.id) as Record<string, unknown>;
assert.ok(agentsRow, "agents sibling row created");
assert.equal(agentsRow.id, chat.id, "same-id bridge: agents.id == chats.id");
assert.equal(agentsRow.owner_user_id, "u1", "agents.owner_user_id <- chats.user_id");
assert.equal(agentsRow.name, "My Agent", "agents.name seeded from chats.title");
assert.equal(agentsRow.org_id, "default-org", "default org");
assert.equal(agentsRow.status, "active", "default status");

// 2. AgentService.getChat projects the enriched Agent view (orgId/status).
const agent = agentService.getChat(chat.id)!;
assert.equal(agent.id, chat.id);
assert.equal(agent.userId, "u1");
assert.equal(agent.title, "My Agent");
assert.equal(agent.orgId, "default-org", "Agent view exposes orgId");
assert.equal(agent.status, "active", "Agent view exposes status");
assert.ok(!agent.description, "description unset");

// 3. Agent title follows chats.title LIVE (not a stale agents.name seed).
chatStore.updateChatTitle(chat.id, "Renamed");
assert.equal(agentService.getChat(chat.id)!.title, "Renamed", "Agent title follows chats.title");

// 4. AgentService.getAllChats lists Agents (agents JOIN chats), owner-scoped.
chatStore.createChat("u1", "Second");
const list = agentService.getAllChats("u1");
assert.equal(list.length, 2, "lists both agents for owner");
assert.ok(
  list.every((a) => a.orgId === "default-org" && a.status === "active"),
  "every listed Agent carries the Phase 5 fields"
);
assert.equal(agentService.getAllChats("other").length, 0, "owner-scoped: other user sees none");

// 4b. listAllAgents (admin Agents console, MP5f) is NOT owner-scoped: returns
//     every Agent across owners, with the per-Agent prompt overrides folded in.
//     Contrast with getAllChats above. This is the security-relevant surface for
//     the admin assignment tab, so guard that it spans owners.
const otherAgent = chatStore.createChat("other", "OtherOwner");
const all = agentService.listAllAgents();
assert.ok(all.length >= 3, "listAllAgents spans owners (not owner-scoped)");
assert.ok(
  all.some((a) => a.id === otherAgent.id && a.userId === "other"),
  "listAllAgents includes the other-owner Agent"
);
assert.ok(all.some((a) => a.id === chat.id && a.userId === "u1"), "listAllAgents includes the u1 Agent");
const meInAll = all.find((a) => a.id === chat.id)!;
assert.equal(meInAll.systemPrompt, null, "override columns folded in (null until set)");
assert.equal(meInAll.appendSystemPrompt, null, "append override folded in (null until set)");

// 5. deleteChat removes BOTH chats + agents (chats CASCADE cleans the rest).
const gone = chatStore.createChat("u1", "ToDelete");
assert.ok(chatStore.deleteChat(gone.id), "deleteChat returns true");
assert.equal(db.prepare("SELECT 1 FROM chats WHERE id = ?").get(gone.id), undefined, "chats row gone");
assert.equal(db.prepare("SELECT 1 FROM agents WHERE id = ?").get(gone.id), undefined, "agents sibling gone");
assert.equal(agentService.getChat(gone.id), undefined, "Agent view gone");

// 6. ensureAgentRow / getChat self-heal a missing sibling from chats.
const heal = chatStore.createChat("u1", "HealMe");
db.prepare("DELETE FROM agents WHERE id = ?").run(heal.id);
assert.equal(db.prepare("SELECT 1 FROM agents WHERE id = ?").get(heal.id), undefined, "sibling removed");
agentService.ensureAgentRow(heal.id);
const healed = db.prepare("SELECT owner_user_id, name FROM agents WHERE id = ?").get(heal.id) as Record<string, unknown>;
assert.ok(healed, "ensureAgentRow recreated the sibling from chats");
assert.equal(healed.owner_user_id, "u1");
assert.equal(healed.name, "HealMe");
db.prepare("DELETE FROM agents WHERE id = ?").run(heal.id); // corrupt again
assert.ok(agentService.getChat(heal.id), "getChat self-heals a missing sibling");

// 7. Backfill (the boot migration): a pre-Phase-5 chats row with no agents
//    sibling gets one on the next backfill run; idempotent on re-run.
db.prepare(
  "INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
).run("legacy-1", "legacy-user", "Legacy Chat", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
assert.equal(db.prepare("SELECT 1 FROM agents WHERE id = ?").get("legacy-1"), undefined, "legacy chat has no agents row yet");
// Re-run the exact backfill SQL database.ts runs at boot:
const backfillSql = `
  INSERT OR IGNORE INTO agents (id, org_id, owner_user_id, name, description, status, created_at, updated_at)
  SELECT id, 'default-org', user_id, title, NULL, 'active', created_at, updated_at
  FROM chats WHERE id NOT IN (SELECT id FROM agents)
`;
db.exec(backfillSql);
const legacy = db.prepare("SELECT owner_user_id, name FROM agents WHERE id = ?").get("legacy-1") as Record<string, unknown>;
assert.ok(legacy, "backfill created agents row for legacy chat");
assert.equal(legacy.owner_user_id, "legacy-user");
assert.equal(legacy.name, "Legacy Chat");
db.exec(backfillSql); // idempotent re-run
const legacyCount = (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?").get("legacy-1") as Record<string, unknown>).n;
assert.equal(legacyCount, 1, "backfill is idempotent (no duplicate)");

// 8. Sanity: ownership still routes through chatStore (unchanged tenancy).
assert.equal(chatStore.verifyChatOwnership(chat.id, "u1"), true, "ownership true for owner");
assert.equal(chatStore.verifyChatOwnership(chat.id, "other"), false, "ownership false for non-owner");

// ─── Phase 5 (MP5b): per-Agent prompt (L2) ───────────────────────────────
const pAgent = chatStore.createChat("u1", "PromptAgent");
const pctx: RequestContext = { userId: "u1", role: "user", orgId: DEFAULT_ORG_ID };

// 9. No overrides initially → resolve() uses the platform default.
assert.deepEqual(
  agentService.getAgentPromptOverrides(pAgent.id),
  { systemPrompt: null, appendSystemPrompt: null, profileId: null },
  "no prompt overrides initially"
);
const baselineBundle = capabilityProvider.resolve({ userId: "u1", chatId: pAgent.id, role: "user" });
assert.ok(
  typeof baselineBundle.sdkOptions.systemPrompt === "string" &&
    (baselineBundle.sdkOptions.systemPrompt ?? "").length > 0,
  "baseline systemPrompt is the platform default (non-empty)"
);

// 10. updateAgentProfile persists; the override REPLACES (not concatenates) the
//     platform default in resolve().
agentService.updateAgentProfile(pAgent.id, { systemPrompt: "OVERRIDE-MARKER-XYZ" });
assert.equal(
  agentService.getAgentPromptOverrides(pAgent.id).systemPrompt,
  "OVERRIDE-MARKER-XYZ",
  "override persisted"
);
const overrideBundle = capabilityProvider.resolve({ userId: "u1", chatId: pAgent.id, role: "user" });
assert.equal(
  (overrideBundle.sdkOptions.systemPrompt ?? "").startsWith("OVERRIDE-MARKER-XYZ"),
  true,
  "resolve() systemPrompt replaced by the per-Agent override"
);

// 11. Sanitization: control chars stripped on write.
agentService.updateAgentProfile(pAgent.id, { systemPrompt: "clean\x00text\x1f!" });
assert.equal(
  agentService.getAgentPromptOverrides(pAgent.id).systemPrompt,
  "cleantext!",
  "control chars stripped from per-Agent prompt"
);

// 12. Length bound: oversized systemPrompt rejected (matches platform rule).
assert.throws(
  () => agentService.updateAgentProfile(pAgent.id, { systemPrompt: "x".repeat(100000) }),
  /too long/i,
  "oversized per-Agent systemPrompt rejected"
);
// 12b. appendSystemPrompt is also length-bounded (Codex MP5 review: an oversized
//      append could crowd out the skill manifest appended last).
assert.throws(
  () => agentService.updateAgentProfile(pAgent.id, { appendSystemPrompt: "x".repeat(100000) }),
  /too long/i,
  "oversized per-Agent appendSystemPrompt rejected"
);

// 13. Clear (null) → falls back to the platform default again.
agentService.updateAgentProfile(pAgent.id, { systemPrompt: null, appendSystemPrompt: null });
assert.equal(agentService.getAgentPromptOverrides(pAgent.id).systemPrompt, null, "override cleared");
const reclearedBundle = capabilityProvider.resolve({ userId: "u1", chatId: pAgent.id, role: "user" });
assert.equal(
  reclearedBundle.sdkOptions.systemPrompt,
  baselineBundle.sdkOptions.systemPrompt,
  "cleared override restores platform-default systemPrompt"
);

// 14. configVersion flips on a per-Agent prompt edit and restores on clear.
const cv0 = computeConfigVersion(pctx, pAgent.id);
agentService.updateAgentProfile(pAgent.id, { systemPrompt: "cv-probe" });
const cv1 = computeConfigVersion(pctx, pAgent.id);
assert.notEqual(cv1, cv0, "per-Agent prompt edit flips configVersion (drift-detectable)");
agentService.updateAgentProfile(pAgent.id, { systemPrompt: null });
assert.equal(computeConfigVersion(pctx, pAgent.id), cv0, "clearing restores configVersion");

// 15. The skill manifest is appended AFTER the override base by
//     buildAppendSystemPrompt (unchanged by MP5b), so a per-Agent prompt can
//     never suppress the platform-owned skill listing. With the append override
//     set, the bundle append starts with the override base.
agentService.updateAgentProfile(pAgent.id, { appendSystemPrompt: "APPEND-OVERRIDE" });
const appendBundle = capabilityProvider.resolve({ userId: "u1", chatId: pAgent.id, role: "user" });
assert.equal(
  (appendBundle.sdkOptions.appendSystemPrompt ?? "").startsWith("APPEND-OVERRIDE"),
  true,
  "append override is the base; skill manifest still appended after it"
);

// Leave the temp DB clean.
db.exec("DELETE FROM agents");
db.exec("DELETE FROM chats");

console.log("agent-service (Phase 5 storage split + MP5b per-Agent prompt) tests passed");
