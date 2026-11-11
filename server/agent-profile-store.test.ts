// Run: npm run test:agent-profile-store
// Phase 5 (MP5d): reusable Agent Profiles. Verifies CRUD, delete-nulls-refs,
// promptForAgent graceful degradation, resolve() precedence (per-Agent > profile
// > platform), configVersion flips on profile edit + reassign, sanitize + bound.
import assert from "node:assert/strict";
import db from "./database.js";
import { chatStore } from "./chat-store.js";
import { agentService } from "./agent-service.js";
import { agentProfileStore } from "./agent-profile-store.js";
import { capabilityProvider } from "./capability-provider.js";
import { computeConfigVersion } from "./capability-version.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Hermetic: clear rows from any prior run.
db.exec("DELETE FROM agent_profiles");
db.exec("DELETE FROM agents");
db.exec("DELETE FROM chats");

// 1. CRUD: create / get / list / update.
const p1 = agentProfileStore.create({
  name: "code-reviewer",
  systemPrompt: "You review code.",
  appendSystemPrompt: "Cite style guide.",
});
assert.ok(p1.id, "create returns id");
assert.equal(p1.name, "code-reviewer");
assert.equal(p1.systemPrompt, "You review code.");
assert.equal(p1.appendSystemPrompt, "Cite style guide.");
assert.equal(agentProfileStore.get(p1.id)?.name, "code-reviewer", "get by id");
assert.ok(agentProfileStore.list().length >= 1, "list includes it");
const updated = agentProfileStore.update(p1.id, { name: "senior-reviewer", description: "Senior" });
assert.equal(updated?.name, "senior-reviewer", "update name");
assert.equal(updated?.description, "Senior", "update description");

// 2. create requires a non-empty name.
assert.throws(() => agentProfileStore.create({ name: "   " }), /required/i, "blank name rejected");

// 3. sanitize control chars + length bound on systemPrompt.
const dirty = agentProfileStore.create({ name: "dirty", systemPrompt: "ab\x00cd\x1f" });
assert.equal(dirty.systemPrompt, "abcd", "control chars stripped from profile prompt");
assert.throws(
  () => agentProfileStore.create({ name: "big", systemPrompt: "x".repeat(100000) }),
  /too long/i,
  "oversized profile systemPrompt rejected"
);
assert.throws(
  () => agentProfileStore.create({ name: "big-append", appendSystemPrompt: "x".repeat(100000) }),
  /too long/i,
  "oversized profile appendSystemPrompt rejected"
);

// 4. promptForAgent: no profile → nulls.
const a1 = chatStore.createChat("u1", "Agent1");
assert.deepEqual(
  agentProfileStore.promptForAgent(a1.id),
  { systemPrompt: null, appendSystemPrompt: null },
  "agent with no profile → nulls"
);

// 5. assign profile → promptForAgent resolves the profile's prompts; agent carries profileId.
agentService.updateAgentProfile(a1.id, { profileId: p1.id });
assert.deepEqual(
  agentProfileStore.promptForAgent(a1.id),
  // toolsConfigRaw: profile 工具配置原始列（无则 null）随 prompt 一起返回
  { systemPrompt: "You review code.", appendSystemPrompt: "Cite style guide.", toolsConfigRaw: null },
  "profile prompts resolved for agent"
);
assert.equal(agentService.getChat(a1.id)?.profileId, p1.id, "agent carries profileId");

// 6. resolve() precedence: per-Agent override > profile > platform default.
assert.equal(
  (capabilityProvider.resolve({ userId: "u1", chatId: a1.id, role: "user" }).sdkOptions.systemPrompt ?? "").startsWith("You review code."),
  true,
  "resolve uses the profile prompt when no per-Agent override"
);
agentService.updateAgentProfile(a1.id, { systemPrompt: "PER-AGENT-WINS" });
assert.equal(
  (capabilityProvider.resolve({ userId: "u1", chatId: a1.id, role: "user" }).sdkOptions.systemPrompt ?? "").startsWith("PER-AGENT-WINS"),
  true,
  "per-Agent override beats the profile"
);
agentService.updateAgentProfile(a1.id, { systemPrompt: null }); // clear override
assert.equal(
  (capabilityProvider.resolve({ userId: "u1", chatId: a1.id, role: "user" }).sdkOptions.systemPrompt ?? "").startsWith("You review code."),
  true,
  "cleared override falls back to the profile"
);

// 7. configVersion flips on profile edit, reassign, and clear.
const ctx: RequestContext = { userId: "u1", role: "user", orgId: DEFAULT_ORG_ID };
const cv0 = computeConfigVersion(ctx, a1.id);
agentProfileStore.update(p1.id, { systemPrompt: "You review code carefully." });
const cv1 = computeConfigVersion(ctx, a1.id);
assert.notEqual(cv1, cv0, "profile edit flips configVersion");
const p2 = agentProfileStore.create({ name: "other", systemPrompt: "Other role." });
agentService.updateAgentProfile(a1.id, { profileId: p2.id });
const cv2 = computeConfigVersion(ctx, a1.id);
assert.notEqual(cv2, cv1, "reassign flips configVersion");
agentService.updateAgentProfile(a1.id, { profileId: null });
const cv3 = computeConfigVersion(ctx, a1.id);
assert.notEqual(cv3, cv2, "clearing profile flips configVersion");

// 8. deleteProfile nulls dangling agents.profile_id refs; promptForAgent degrades.
const a2 = chatStore.createChat("u1", "Agent2");
agentService.updateAgentProfile(a2.id, { profileId: p2.id });
assert.equal(agentService.getChat(a2.id)?.profileId, p2.id, "assigned before delete");
agentProfileStore.deleteProfile(p2.id);
assert.equal(agentService.getChat(a2.id)?.profileId, null, "deleteProfile nulls dangling refs");
assert.deepEqual(
  agentProfileStore.promptForAgent(a2.id),
  { systemPrompt: null, appendSystemPrompt: null },
  "deleted profile → nulls (graceful)"
);
assert.equal(agentProfileStore.get(p2.id), undefined, "profile gone after delete");

// cleanup
db.exec("DELETE FROM agent_profiles");
db.exec("DELETE FROM agents");
db.exec("DELETE FROM chats");

console.log("agent-profile-store (MP5d) tests passed");
