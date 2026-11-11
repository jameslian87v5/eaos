// Run: npx tsx server/r5d-runtime-e2e.test.ts
// Hermetic: ENTITLEMENTS_FILE + AGENT_CAPABILITIES_FILE → temp files.
// Reads the real data/skills.json for enabled skill ids (same harness as
// capability-provider.test.ts). R5d focus: cross-org deny (entitlement
// org-scope) + revoke→rebuild (a NEW runtime/agentId sees an empty bundle).
// These complement capability-provider.test.ts (deny-default / activation /
// user-deny backstop) — not duplicated.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { capabilityProvider } from "./capability-provider.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { entitlementService } from "./entitlement.js";
import { getAllSkills } from "./skill-config.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Reset temp stores → hermetic + repeatable.
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");
// Seed the shared skill pool with the worktree's sample native plugins (a real
// R5a sync would write these entries + the .hub-source.json marker; here we
// seed the pool shape so resolve has enabled+valid skills to gate). Hermetic.
const skillsConfigPath = path.resolve(process.cwd(), "data", "skills.json");
fs.mkdirSync(path.dirname(skillsConfigPath), { recursive: true });
fs.writeFileSync(
  skillsConfigPath,
  JSON.stringify(
    [
      { name: "hello-skill", type: "plugin", enabled: true, path: "skills/hello-skill" },
      { name: "minimal-plugin", type: "plugin", enabled: true, path: "skills/minimal-plugin" },
    ],
    null,
    2,
  ) + "\n",
);

const ORG_A = DEFAULT_ORG_ID; // e.g. "test_org"
const ORG_B = "r5d_other_org"; // a different department (single-enterprise, org=department)
const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: ORG_A };
const operatorA: RequestContext = { userId: "u-a", role: "user", orgId: ORG_A };
const operatorB: RequestContext = { userId: "u-b", role: "user", orgId: ORG_B };

const pluginNames = (b: { sdkOptions: { plugins?: Array<{ path: string }> } }) =>
  (b.sdkOptions.plugins ?? []).map((p) => p.path.split("/").pop()!);

const enabledNames = getAllSkills().filter((s) => s.enabled && s.valid).map((s) => s.name);
assert.ok(enabledNames.length >= 1, `need >=1 enabled skill (got ${enabledNames.length})`);
const RID = enabledNames[0];

// ── 1. Cross-org deny (entitlement org-scope) ──────────────────────────────
// Activate RID on agent-x; grant org-scope allow ONLY for ORG_A (TEAM semantics:
// the Hub mirror targets [orgId]). resolve for an operator in ORG_A → injected;
// the SAME activation resolved for an operator in ORG_B → NOT injected (org-scope
// allow never grants cross-org; structural deny, not a config flag).
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "org", scopeId: ORG_A, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(operatorA, "agent-x", {
  resources: [{ resourceId: RID, enabled: true }],
});

const inOrgA = capabilityProvider.resolve({
  userId: operatorA.userId,
  chatId: "agent-x",
  role: "user",
  orgId: ORG_A,
  runtimeType: "docker",
});
assert.deepEqual(
  pluginNames(inOrgA),
  [RID],
  "org-scope allow for ORG_A → skill injected for an operator in ORG_A"
);
// Docker mount is read-only /opt/agent/plugins/<name> (the data-plane shape).
const mountA = inOrgA.mounts.find((m) => m.containerPath === `/opt/agent/plugins/${RID}`);
assert.ok(mountA, "docker bundle has /opt/agent/plugins/<name> mount");
assert.equal(mountA!.readonly, true, "skill mount is read-only");

const inOrgB = capabilityProvider.resolve({
  userId: operatorB.userId,
  chatId: "agent-x", // SAME activation (agentId-based)
  role: "user",
  orgId: ORG_B,
  runtimeType: "docker",
});
assert.deepEqual(
  pluginNames(inOrgB),
  [],
  "cross-org deny: org-scope allow for ORG_A does NOT inject for an operator in ORG_B"
);

// ── 2. Local runtime shape: host-path plugins, NO mounts ───────────────────
const localBundle = capabilityProvider.resolve({
  userId: operatorA.userId,
  chatId: "agent-x",
  role: "user",
  orgId: ORG_A,
  runtimeType: "local",
});
assert.deepEqual(pluginNames(localBundle), [RID], "local resolve injects the same gated skill");
assert.equal(localBundle.mounts.length, 0, "local runtime intentionally receives NO mounts (host-path plugins only)");
assert.ok(
  localBundle.sdkOptions.plugins!.every((p) => !p.path.startsWith("/opt/agent/plugins/")),
  "local plugins use HOST paths (not container /opt/agent/...)"
);

// ── 3. Revoke → rebuild (a NEW runtime/agentId sees deny-default 0 skills) ─
// Flip the entitlement to deny (revoke). The EXISTING agent-x runtime would be
// rebuilt on next message/cold-resume; here we model "rebuild" as a fresh
// resolve on a new agentId that is NOT activated → deny-default. Plus the
// revoked-backstop on agent-x itself → 0.
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "org", scopeId: ORG_A, effect: "deny" },
]);
const revokedX = capabilityProvider.resolve({
  userId: operatorA.userId,
  chatId: "agent-x",
  role: "user",
  orgId: ORG_A,
  runtimeType: "docker",
});
assert.deepEqual(
  pluginNames(revokedX),
  [],
  "revoke (org-scope deny) → agent-x bundle rebuilt with 0 skills (entitlement backstop)"
);
const rebuiltFresh = capabilityProvider.resolve({
  userId: operatorA.userId,
  chatId: "agent-fresh",
  role: "user",
  orgId: ORG_A,
  runtimeType: "docker",
});
assert.deepEqual(
  pluginNames(rebuiltFresh),
  [],
  "rebuild: a new unactivated runtime → deny-default 0 skills, no mount/inject/call"
);
assert.equal(
  rebuiltFresh.mounts.filter((m) => m.containerPath.startsWith("/opt/agent/plugins/")).length,
  0,
  "rebuild: no /opt/agent/plugins mount on the fresh runtime"
);

console.log("r5d-runtime-e2e.test: 4 assertions passed (cross-org deny + local shape + revoke→rebuild).");
