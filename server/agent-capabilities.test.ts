// Run: npm run test:agent-capabilities
// Hermetic: ENTITLEMENTS_FILE + AGENT_CAPABILITIES_FILE point at temp files
// (set by the npm script). Reads the real data/skills.json for resource ids.
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  agentCapabilityService,
  EntitlementError,
  ResourceNotFoundError,
} from "./agent-capabilities.js";
import { entitlementService } from "./entitlement.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Reset temp stores → hermetic + repeatable across runs.
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");

const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };
const user: RequestContext = { userId: "user-1", role: "user", orgId: DEFAULT_ORG_ID };
const AGENT = "agent-xyz";
const RID = "hello-skill"; // exists in data/skills.json
const RID2 = "minimal-plugin"; // exists, NOT entitled for user
const GHOST = "does-not-exist"; // not a registered resource

// Grant user entitlement to RID only (RID2 + GHOST stay out).
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "user", scopeId: "user-1", effect: "allow" },
]);

// 1. enable entitled + valid → ok
agentCapabilityService.updateAgentCapabilities(user, AGENT, {
  resources: [{ resourceId: RID, enabled: true }],
});
const ul = agentCapabilityService.listAgentCapabilities(user, AGENT);
assert.equal(
  ul.find((x) => x.resourceId === RID)?.enabled,
  true,
  "entitled resource enabled"
);

// F4: non-admin sees ONLY entitled ∪ already-enabled — RID2 hidden
assert.equal(
  ul.some((x) => x.resourceId === RID2),
  false,
  "Phase 2b: non-entitled, non-enabled resource hidden from non-admin"
);
// F4: admin sees the full pool (incl. RID2)
assert.ok(
  agentCapabilityService.listAgentCapabilities(admin, AGENT).some((x) => x.resourceId === RID2),
  "admin sees full resource pool"
);

// 2. enable valid-but-non-entitled resource → EntitlementError (resource check passes first)
assert.throws(
  () =>
    agentCapabilityService.updateAgentCapabilities(user, AGENT, {
      resources: [{ resourceId: RID2, enabled: true }],
    }),
  (e) => e instanceof EntitlementError,
  "enabling valid-but-non-entitled resource throws EntitlementError"
);

// 3. F3: enable non-existent resource → ResourceNotFoundError (even for admin —
//    admin-bypass is authz only, not existence)
assert.throws(
  () =>
    agentCapabilityService.updateAgentCapabilities(user, AGENT, {
      resources: [{ resourceId: GHOST, enabled: true }],
    }),
  (e) => e instanceof ResourceNotFoundError,
  "enabling non-existent resource throws ResourceNotFoundError (non-admin)"
);
assert.throws(
  () =>
    agentCapabilityService.updateAgentCapabilities(admin, AGENT, {
      resources: [{ resourceId: GHOST, enabled: true }],
    }),
  (e) => e instanceof ResourceNotFoundError,
  "enabling non-existent resource throws ResourceNotFoundError (admin too)"
);

// 4. resolveEnabledResourceIds = enabled ∩ entitled
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(user, AGENT),
  [RID],
  "resolveEnabledResourceIds returns entitled+enabled set"
);

// 5. disable is always allowed (no entitlement check). RID still entitled here,
//    so resolve reflects the enable state and proves the removal.
agentCapabilityService.updateAgentCapabilities(user, AGENT, {
  resources: [{ resourceId: RID, enabled: false }],
});
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(user, AGENT),
  [],
  "disable removes resource from enabled set"
);

// 6. re-enable, then revoke (deny) → backstop excludes it even though enabled
agentCapabilityService.updateAgentCapabilities(user, AGENT, {
  resources: [{ resourceId: RID, enabled: true }],
});
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(user, AGENT),
  [RID],
  "re-enabled while entitled"
);
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "user", scopeId: "user-1", effect: "deny" },
]);
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(user, AGENT),
  [],
  "revoked-but-enabled excluded from resolved set (entitlement backstop)"
);
// revoked-but-enabled stays visible to the owner so they can disable it
const ul2 = agentCapabilityService.listAgentCapabilities(user, AGENT);
const revoked = ul2.find((x) => x.resourceId === RID);
assert.ok(revoked, "revoked-but-enabled still visible to owner (so they can disable)");
assert.equal(revoked?.enabled, true, "still marked enabled");
assert.equal(revoked?.entitled, false, "entitled dropped after revoke");

// 7. Phase 7.3: the activation∩entitled intersection is org-aware. An org-scope
//    allow for org-beta lets an org-beta user resolve an enabled RID, but the
//    SAME enabled agent resolved in an org-alpha context EXCLUDES RID — no
//    cross-org spill. (Run after all user-1 assertions; this re-scopes RID.)
const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const AGENT2 = "agent-cross-org";
const orgAUser: RequestContext = { userId: "u-a", role: "user", orgId: ORG_A };
const orgBUser: RequestContext = { userId: "u-b", role: "user", orgId: ORG_B };

entitlementService.setEntitlements(admin, RID, [
  { scopeType: "org", scopeId: ORG_B, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(orgBUser, AGENT2, {
  resources: [{ resourceId: RID, enabled: true }],
});
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(orgBUser, AGENT2),
  [RID],
  "org-beta user resolves enabled RID under own-org entitlement"
);
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(orgAUser, AGENT2),
  [],
  "cross-org spill denied: org-alpha user does not resolve org-beta-enabled RID"
);

console.log("agent-capabilities tests passed");
