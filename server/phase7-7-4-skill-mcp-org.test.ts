// Phase 7.4 — skill/MCP/hook-plugin management org-scope (fix round:
// evt_20260729_phase7_7_4_fix_org_scoped_resource_reads).
//
// Two-layer model:
//   - The catalog (data/skills.json, data/mcp.json, data/hook-plugins.json) is a
//     SHARED global pool — NO org_id on catalog records (constraint: no per-org
//     registries). The raw pool reader `listResources` is ctx-agnostic BY DESIGN
//     (per-agent views + activation rely on the full pool).
//   - The MANAGEMENT read (`listResourcesForCtx`) is org-scoped: admin sees the
//     full pool; any other role sees ONLY resources their org is authorized to
//     use (entitlement canConfigure). Org-scoping = entitlement overlay.
//
// Route policy in server.ts (code-reviewed; project has no Express harness):
//   - READ  GET /api/admin/skills|mcp|capabilities → isPrivilegedReq, BUT
//     org_admin gets own-org authorized only (listResourcesForCtx / entitlement
//     filter). The raw global catalog MUST NOT leak to org_admin.
//   - WRITE POST .../enable|disable (global flag)  → isAdminReq (admin only)
//   - install/import (/apis, /plugins)             → admin only (P7-2)
//   - entitlement (P7-3)                           → org_admin own-org
//
// Run: ENTITLEMENTS_FILE=/tmp/test-74-ent.json AGENT_CAPABILITIES_FILE=/tmp/test-74-ac.json \
//      npx tsx server/phase7-7-4-skill-mcp-org.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { entitlementService, EntitlementScopeError } from "./entitlement.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { capabilityResourceService } from "./capability-resource.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Hermetic temp stores.
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");

const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };
const orgAAdmin: RequestContext = { userId: "oa-a", role: "org_admin", orgId: ORG_A };
const orgAUser: RequestContext = { userId: "u-a", role: "user", orgId: ORG_A };
const orgBUser: RequestContext = { userId: "u-b", role: "user", orgId: ORG_B };
const RID = "hello-skill"; // real skill package in data/skills.json
const OTHER_RID = "minimal-plugin"; // another real skill (NOT entitled to org A)
const AGENT_A = "agent-org-a";

// 1. Raw pool reader is ctx-agnostic BY DESIGN (per-agent views + activation
//    rely on the full pool). It returns the shared catalog regardless of caller.
assert.ok(
  capabilityResourceService.listResources(admin).some((r) => r.resourceId === RID),
  "raw listResources contains hello-skill (admin)"
);
assert.ok(
  capabilityResourceService.listResources(orgAAdmin).some((r) => r.resourceId === RID),
  "raw listResources is ctx-agnostic (per-agent/activation invariant)"
);

// 2. MANAGEMENT read is org-scoped (the fix). Before adoption, org_admin sees
//    NEITHER hello-skill NOR minimal-plugin (both unentitled for org A). admin
//    sees the full pool. The raw catalog must NOT leak to org_admin.
const mgmtBefore = capabilityResourceService.listResourcesForCtx(orgAAdmin);
assert.equal(
  mgmtBefore.some((r) => r.resourceId === RID),
  false,
  "org_admin management read hides unentitled hello-skill (no global leak)"
);
assert.equal(
  mgmtBefore.some((r) => r.resourceId === OTHER_RID),
  false,
  "org_admin management read hides unentitled minimal-plugin"
);
assert.ok(
  capabilityResourceService.listResourcesForCtx(admin).some((r) => r.resourceId === RID) &&
    capabilityResourceService.listResourcesForCtx(admin).some((r) => r.resourceId === OTHER_RID),
  "admin management read sees the full pool"
);

// 3. org_admin adopts RID for own org via entitlement (org-scoped "enable for my org").
entitlementService.setEntitlements(orgAAdmin, RID, [
  { scopeType: "org", scopeId: ORG_A, effect: "allow" },
]);
assert.equal(entitlementService.canConfigure(orgAUser, RID), true, "org A user can use adopted skill");
assert.equal(entitlementService.canConfigure(orgBUser, RID), false, "org B user still denied — no cross-org spill");

// 4. After adoption, RID appears on org_admin's management read; OTHER_RID still hidden.
const mgmtAfter = capabilityResourceService.listResourcesForCtx(orgAAdmin);
assert.ok(mgmtAfter.some((r) => r.resourceId === RID), "adopted skill now visible on org_admin management read");
assert.equal(
  mgmtAfter.some((r) => r.resourceId === OTHER_RID),
  false,
  "still-unentitled minimal-plugin stays hidden from org_admin"
);

// 5. org_admin CANNOT adopt for another org (write guard, P7-3 EntitlementScopeError).
assert.throws(
  () =>
    entitlementService.setEntitlements(orgAAdmin, RID, [
      { scopeType: "org", scopeId: ORG_B, effect: "allow" },
    ]),
  EntitlementScopeError,
  "org_admin cannot adopt a skill for another org"
);

// 6. Org-scoped activation: org A agent resolves RID; org B context does NOT.
agentCapabilityService.updateAgentCapabilities(orgAAdmin, AGENT_A, {
  resources: [{ resourceId: RID, enabled: true }],
});
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(orgAUser, AGENT_A),
  [RID],
  "org A agent resolves adopted skill"
);
assert.deepEqual(
  agentCapabilityService.resolveEnabledResourceIds(orgBUser, AGENT_A),
  [],
  "org B context cannot resolve org A's adopted skill — no spill"
);

// 7. listAgentCapabilities (per-agent view) for an org A user shows the adopted
//    (entitled) skill and hides the unentitled one.
const acView = agentCapabilityService.listAgentCapabilities(orgAUser, AGENT_A);
assert.ok(
  acView.some((x) => x.resourceId === RID && x.entitled),
  "own-org adopted skill visible + entitled to org A user"
);
assert.equal(
  acView.some((x) => x.resourceId === OTHER_RID),
  false,
  "unentitled minimal-plugin hidden from org A user's per-agent view"
);

// 8. admin sees the full pool on every view (cross-org super-user).
assert.ok(
  agentCapabilityService.listAgentCapabilities(admin, AGENT_A).some((x) => x.resourceId === OTHER_RID),
  "admin sees unentitled minimal-plugin in the full pool"
);

console.log("phase7-7-4 skill/mcp org-scope tests passed");
