// Run: npm run test:entitlement
// Hermetic: ENTITLEMENTS_FILE points at a temp file (set by the npm script).
import assert from "node:assert/strict";
import fs from "node:fs";
import { entitlementService, EntitlementScopeError } from "./entitlement.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Reset temp store → hermetic + repeatable across runs (a stale allow would
// otherwise fail the deny-default assertion).
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");

const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };
const user: RequestContext = { userId: "user-1", role: "user", orgId: DEFAULT_ORG_ID };
const other: RequestContext = { userId: "user-2", role: "user", orgId: DEFAULT_ORG_ID };
const RID = "hello-skill";

// 1. admin-bypass: admin can configure even with no entries
assert.equal(
  entitlementService.canConfigure(admin, RID),
  true,
  "admin-bypass with no entries"
);

// 2. deny-default: non-admin, no entries → deny
assert.equal(
  entitlementService.canConfigure(user, RID),
  false,
  "deny-default for non-admin"
);

// 3. org-allow grants every same-org user
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "org", scopeId: DEFAULT_ORG_ID, effect: "allow" },
]);
assert.equal(entitlementService.canConfigure(user, RID), true, "org-allow grants same-org user");
assert.equal(entitlementService.canConfigure(other, RID), true, "org-allow grants another same-org user");

// 4. user-scope deny overrides org-scope allow (deny-overrides-allow, user > org)
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "org", scopeId: DEFAULT_ORG_ID, effect: "allow" },
  { scopeType: "user", scopeId: "user-1", effect: "deny" },
]);
assert.equal(
  entitlementService.canConfigure(user, RID),
  false,
  "user-deny overrides org-allow for that user"
);
assert.equal(
  entitlementService.canConfigure(other, RID),
  true,
  "other user still allowed by org-allow"
);

// 5. explicit user-allow grants (replaces org entry under PUT semantics)
entitlementService.setEntitlements(admin, RID, [
  { scopeType: "user", scopeId: "user-1", effect: "allow" },
]);
assert.equal(entitlementService.canConfigure(user, RID), true, "user-allow grants");
assert.equal(entitlementService.canConfigure(other, RID), false, "no spillover to other users");

// 6. listEntitledResources reflects allows, excludes denied
assert.ok(
  entitlementService.listEntitledResources(user).includes(RID),
  "listEntitledResources includes allowed resource"
);
assert.ok(
  !entitlementService.listEntitledResources(other).includes(RID),
  "listEntitledResources excludes non-entitled user"
);

// 7. audit fields persisted
const entries = entitlementService.listEntries(RID);
assert.ok(entries.length > 0, "entries persisted");
assert.equal(entries[0].grantedBy, "admin-1", "grantedBy recorded for audit");
assert.ok(entries[0].grantedAt.length > 0, "grantedAt recorded for audit");

// 8. Phase 7.3: cross-org deny is structural — an org-allow scoped to org-B
//    NEVER grants a user in org-A (org-scope matches ONLY ctx.orgId).
const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const RID2 = "cross-org-skill";
const orgAUser: RequestContext = { userId: "u-a", role: "user", orgId: ORG_A };
const orgBUser: RequestContext = { userId: "u-b", role: "user", orgId: ORG_B };
const orgBAdmin: RequestContext = { userId: "oa-b", role: "org_admin", orgId: ORG_B };

entitlementService.setEntitlements(admin, RID2, [
  { scopeType: "org", scopeId: ORG_B, effect: "allow" },
]);
assert.equal(
  entitlementService.canConfigure(orgAUser, RID2),
  false,
  "cross-org deny: org-B allow does not grant org-A user"
);
assert.equal(
  entitlementService.canConfigure(orgBUser, RID2),
  true,
  "same-org user in org-B is granted by org-B allow"
);

// 9. Phase 7.3: org_admin WRITE guard — may only write own-org org-scope entries.
//    Cross-org spill → EntitlementScopeError; user-scope grant → also rejected.
assert.throws(
  () =>
    entitlementService.setEntitlements(orgBAdmin, RID2, [
      { scopeType: "org", scopeId: ORG_A, effect: "allow" },
    ]),
  EntitlementScopeError,
  "org_admin cannot write entitlements for another org"
);
assert.throws(
  () =>
    entitlementService.setEntitlements(orgBAdmin, RID2, [
      { scopeType: "user", scopeId: "u-b", effect: "allow" },
    ]),
  EntitlementScopeError,
  "org_admin cannot write user-scope entitlements"
);
// same-org org-scope write by org_admin → allowed.
const written = entitlementService.setEntitlements(orgBAdmin, RID2, [
  { scopeType: "org", scopeId: ORG_B, effect: "deny" },
]);
assert.equal(written.length, 1, "org_admin can write own-org org-scope entry");
assert.equal(written[0].grantedBy, "oa-b", "org_admin recorded as grantedBy");

// 10. Phase 7.3: listEntriesForCtx scopes the READ path. admin sees ALL entries;
//     org_admin sees only own-org org-scope entries (user-scope entries excluded).
const allView = entitlementService.listEntriesForCtx(admin, RID2);
assert.ok(allView.length >= 1, "admin sees all entries for RID2");
const orgBView = entitlementService.listEntriesForCtx(orgBAdmin, RID2);
assert.equal(
  orgBView.every((e) => e.scopeType === "org" && e.scopeId === ORG_B),
  true,
  "org_admin listEntriesForCtx returns only own-org org-scope entries"
);

// 11. Phase 7.5: listAllEntriesForCtx — org-aggregate across ALL resources.
//     admin sees every entry; org_admin sees only own-org org-scope entries
//     (user-scope + other-org entries hidden) across resources.
const adminAll = entitlementService.listAllEntriesForCtx(admin);
assert.ok(adminAll.length >= 2, "admin sees all entries across resources");
assert.ok(adminAll.some((e) => e.resourceId === RID), "admin aggregate includes RID");
assert.ok(adminAll.some((e) => e.resourceId === RID2), "admin aggregate includes RID2");
const orgBAggr = entitlementService.listAllEntriesForCtx(orgBAdmin);
assert.equal(
  orgBAggr.every((e) => e.scopeType === "org" && e.scopeId === ORG_B),
  true,
  "org_admin aggregate sees only own-org org-scope entries across resources"
);
assert.ok(
  orgBAggr.some((e) => e.resourceId === RID2),
  "org_admin aggregate includes own-org entry on RID2"
);
// RID's only entry is user-scope (user-1) → hidden from org_admin aggregate
// (also proves user-scope + other-org exclusion in the aggregate view).
assert.equal(
  orgBAggr.some((e) => e.resourceId === RID),
  false,
  "org_admin aggregate excludes user-scope / other-org entries"
);

console.log("entitlement tests passed");
