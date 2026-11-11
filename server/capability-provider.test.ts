// Run: npm run test:capability-provider
// Hermetic: ENTITLEMENTS_FILE + AGENT_CAPABILITIES_FILE → temp files.
// Reads the real data/skills.json for enabled skill ids.
import assert from "node:assert/strict";
import fs from "node:fs";
import { capabilityProvider } from "./capability-provider.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { entitlementService } from "./entitlement.js";
import { getAllSkills } from "./skill-config.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Reset temp stores → hermetic + repeatable across runs.
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");

const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };
const user: RequestContext = { userId: "u1", role: "user", orgId: DEFAULT_ORG_ID };

const pluginNames = (b: { sdkOptions: { plugins?: Array<{ path: string }> } }) =>
  (b.sdkOptions.plugins ?? []).map((p) => p.path.split("/").pop()!);

// Registry-enabled skill ids, read directly (NOT via resolve) so the deny-default
// change to resolve() cannot break the RID/RID2 fixtures used below.
const enabledNames = getAllSkills().filter((s) => s.enabled && s.valid).map((s) => s.name);
assert.ok(
  enabledNames.length >= 2,
  `need >=2 enabled skills for subset test (got ${enabledNames.length})`
);
const [RID, RID2] = enabledNames;

// 0. Deny-default baseline: unconfigured agent (no activation record) → 0 skills.
//    The legacy "no-activation ⇒ all enabled skills" fallback is removed.
const baseline = capabilityProvider.resolve({ chatId: "agent-none" });
assert.deepEqual(
  pluginNames(baseline),
  [],
  "unconfigured agent → deny-default 0 skills (no legacy fallback)"
);

// 1. Gated: activate only RID (entitled) → bundle has ONLY RID.
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "user", scopeId: user.userId, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(user, "agent-1", {
  resources: [{ resourceId: RID, enabled: true }],
});
const gated = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-1",
  role: "user",
  runtimeType: "docker",
});
assert.deepEqual(pluginNames(gated), [RID], "activation-gated bundle has only the entitled skill");
// Count only skill-plugin mounts (containerPath under /opt/agent/plugins/) — robust
// to unrelated mounts (e.g. the user-memory /user-memory rw mount added when
// userId + runtimeType!=="local"). deny-by-intersection is verified by
// pluginNames === [RID] above; here we assert exactly ONE skill plugin mount.
const gatedSkillMounts = gated.mounts.filter((m) => m.containerPath.startsWith("/opt/agent/plugins/"));
assert.equal(gatedSkillMounts.length, 1, "one skill-plugin mount for the gated skill");

// 2. Deny-default (full context): a DIFFERENT unconfigured agent with full
//    context (userId/role/docker) still → 0 skills. No legacy fallback regardless
//    of how complete the context is.
const unconfigured = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-2",
  role: "user",
  runtimeType: "docker",
});
assert.deepEqual(
  pluginNames(unconfigured),
  [],
  "unconfigured agent (full context) → deny-default 0 skills (no legacy fallback)"
);

// 3. Revoked backstop: deny RID → gated bundle excludes it → 0 (deny-default).
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "user", scopeId: user.userId, effect: "deny" },
]);
const revoked = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-1",
  role: "user",
});
assert.equal(
  revoked.sdkOptions.plugins!.length,
  0,
  "revoked-but-enabled excluded from bundle (entitlement backstop)"
);

// 4. Admin-bypass at resolution: admin activates both → both entitled via admin.
agentCapabilityService.updateAgentCapabilities(admin, "agent-3", {
  resources: [
    { resourceId: RID, enabled: true },
    { resourceId: RID2, enabled: true },
  ],
});
const adminBundle = capabilityProvider.resolve({
  userId: admin.userId,
  chatId: "agent-3",
  role: "admin",
});
assert.deepEqual(
  pluginNames(adminBundle).sort(),
  [RID, RID2].sort(),
  "admin owner: all activations entitled via admin-bypass"
);

// 5. Re-grant RID, fresh agent with only RID entitled → only RID resolved
//    (entitlement filtering at resolution, not the full activation store).
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "user", scopeId: user.userId, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(user, "agent-4", {
  resources: [{ resourceId: RID, enabled: true }],
});
const mixed = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-4",
  role: "user",
});
assert.deepEqual(pluginNames(mixed), [RID], "only entitled subset resolved");

// 6. Regression (Codex MP3 review): enable → disable last → configured-empty
//    must stay 0 skills (deny-default).
agentCapabilityService.updateAgentCapabilities(user, "agent-5", {
  resources: [{ resourceId: RID, enabled: true }],
});
agentCapabilityService.updateAgentCapabilities(user, "agent-5", {
  resources: [{ resourceId: RID, enabled: false }],
});
const emptied = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-5",
  role: "user",
});
assert.equal(
  emptied.sdkOptions.plugins!.length,
  0,
  "disable-last → configured-empty → 0 skills (deny-default)"
);

console.log("capability-provider tests passed");
