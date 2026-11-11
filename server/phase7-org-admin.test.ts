// Phase 7.2 — org_admin role + org management proof test.
//
// Proves the three-tier role model + the org_admin iron laws:
//   1. role plumbing: DB CHECK accepts 'org_admin'; register/login/JWT/ctxFromReq
//      carry the three tiers faithfully.
//   2. promotion guard (checkUserMutation, PURE): org_admin cannot cross orgs,
//      cannot touch a privileged account, cannot grant a privileged role; admin
//      is the cross-org super-user.
//   3. org-scoped data: org_admin sees own-org profiles/applications only
//      (listByOrg); profiles are created in the caller's org.
//   4. org management: orgService.create/get/list/updateName + id validation.
//
// The route handlers in server.ts are thin wrappers over these pure functions
// (checkUserMutation) and stores (agentProfileStore.listByOrg,
// applicationService.listByOrg, orgService) — so proving the units proves the
// route behavior. HTTP-level wiring is code-reviewed (the project has no Express
// test harness, consistent with phase7-org-isolation.test.ts).
//
// Run: DB_PATH=/tmp/phase72-test.db npx tsx server/phase7-org-admin.test.ts
import assert from "node:assert";
import db from "./database.js";
import { login, verifyToken, register, updateUserRole, getUserById } from "./auth.js";
import {
  ctxFromReq,
  DEFAULT_ORG_ID,
  isPrivilegedRole,
  isPrivilegedReq,
  isAdminReq,
  checkUserMutation,
} from "./request-context.js";
import { agentProfileStore } from "./agent-profile-store.js";
import { applicationService } from "./application-service.js";
import { orgService, isValidOrgId } from "./org-service.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

// ─── 1. role plumbing: DB CHECK accepts org_admin; the tier flows end-to-end ──
{
  const username = `admin-${Date.now()}`;
  await register(username, "Secret123", "OA", ORG_A);
  const row = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: string };
  // updateUserRole now accepts org_admin — proves the CHECK was relaxed (legacy
  // two-tier CHECK would throw "CHECK constraint failed" here).
  updateUserRole(row.id, "org_admin");
  assert.equal(getUserById(row.id)?.role, "org_admin", "updateUserRole persists org_admin");

  // login bakes the org_admin role + org into the JWT; verifyToken reads it back.
  const { token, user } = await login(username, "Secret123");
  assert.equal(user.role, "org_admin", "login returns org_admin");
  const payload = verifyToken(token);
  assert.equal(payload.role, "org_admin", "JWT carries org_admin");
  assert.equal(payload.orgId, ORG_A, "JWT carries the user's org");

  // ctxFromReq maps all three tiers faithfully (no collapse to admin|user).
  assert.equal(ctxFromReq({ userRole: "admin" } as any).role, "admin");
  assert.equal(ctxFromReq({ userRole: "org_admin" } as any).role, "org_admin");
  assert.equal(ctxFromReq({ userRole: "user" } as any).role, "user");
  assert.equal(ctxFromReq({ userRole: "garbage" } as any).role, "user", "unknown tier -> user");

  // role predicate helpers.
  assert.equal(isPrivilegedRole("admin"), true);
  assert.equal(isPrivilegedRole("org_admin"), true);
  assert.equal(isPrivilegedRole("user"), false);
  assert.equal(isPrivilegedReq({ userRole: "org_admin" } as any), true);
  assert.equal(isAdminReq({ userRole: "org_admin" } as any), false, "org_admin is NOT admin (global-only gate denies)");
  assert.equal(isAdminReq({ userRole: "admin" } as any), true);
}

// ─── 2. promotion guard (checkUserMutation) — the org_admin iron laws ─────────
{
  const admin = (targetOrg: string, cur: any, want: any) =>
    checkUserMutation({ actorRole: "admin", actorOrg: ORG_A, targetOrg, targetCurrentRole: cur, desiredRole: want });
  const oa = (targetOrg: string, cur: any, want: any) =>
    checkUserMutation({ actorRole: "org_admin", actorOrg: ORG_A, targetOrg, targetCurrentRole: cur, desiredRole: want });

  // admin is the cross-org super-user: everything allowed (last-admin guard is separate).
  assert.equal(admin(ORG_B, "admin", "user"), null, "admin may cross-org");
  assert.equal(admin(ORG_A, "user", "admin"), null, "admin may grant admin");

  // org_admin: own-org plain-user management is allowed.
  assert.equal(oa(ORG_A, "user", "user"), null, "org_admin manages own-org user");

  // org_admin: cross-org target is hidden as "not found" (route renders 404).
  assert.equal(oa(ORG_B, "user", "user"), "not found", "org_admin cross-org -> not found");

  // org_admin: cannot touch a privileged account.
  assert.equal(oa(ORG_A, "admin", "user"), "org_admin cannot modify privileged accounts");
  assert.equal(oa(ORG_A, "org_admin", "user"), "org_admin cannot modify privileged accounts");

  // org_admin: cannot grant a privileged role.
  assert.equal(oa(ORG_A, "user", "admin"), "org_admin cannot grant privileged roles");
  assert.equal(oa(ORG_A, "user", "org_admin"), "org_admin cannot grant privileged roles");

  // delete semantics: desiredRole === current role → guard only blocks privileged target.
  assert.equal(oa(ORG_A, "admin", "admin"), "org_admin cannot modify privileged accounts", "org_admin cannot delete admin");
  assert.equal(oa(ORG_A, "user", "user"), null, "org_admin may delete own-org user");
}

// ─── 3. org-scoped data: profiles + applications are own-org for org_admin ────
{
  // Profiles: created in the caller's org; listByOrg returns only that org.
  const pA = agentProfileStore.create({ name: `PA-${Date.now()}`, orgId: ORG_A });
  const pB = agentProfileStore.create({ name: `PB-${Date.now()}`, orgId: ORG_B });
  assert.equal(pA.orgId, ORG_A, "profile created in ORG_A");
  assert.equal(pB.orgId, ORG_B, "profile created in ORG_B");
  const inA = agentProfileStore.listByOrg(ORG_A).map((p) => p.id);
  assert.ok(inA.includes(pA.id) && !inA.includes(pB.id), "listByOrg(ORG_A) excludes ORG_B profile");
  assert.equal(agentProfileStore.create({ name: "default-org-p" }).orgId, DEFAULT_ORG_ID, "profile defaults to default-org");

  // Applications: createApplication honors orgId; listByOrg filters.
  const aA = applicationService.createApplication({ id: `appa-${Date.now()}`, orgId: ORG_A, name: "App A" });
  const aB = applicationService.createApplication({ id: `appb-${Date.now()}`, orgId: ORG_B, name: "App B" });
  assert.equal(aA.orgId, ORG_A);
  const appsInA = applicationService.listByOrg(ORG_A).map((a) => a.id);
  assert.ok(appsInA.includes(aA.id) && !appsInA.includes(aB.id), "listByOrg(ORG_A) excludes ORG_B app");
}

// ─── 4. org management: orgService CRUD + id validation ───────────────────────
{
  assert.equal(isValidOrgId("acme-corp"), true);
  assert.equal(isValidOrgId("Acme Corp"), false, "spaces rejected");
  assert.equal(isValidOrgId("ACME"), false, "uppercase rejected");
  assert.equal(isValidOrgId(""), false);

  const orgId = `org-${Date.now()}`;
  const created = orgService.create(orgId, "测试组织");
  assert.equal(created.id, orgId);
  assert.equal(created.name, "测试组织");
  assert.equal(orgService.get(orgId)?.name, "测试组织");
  assert.throws(() => orgService.create(orgId, "dup"), /already exists/, "duplicate id rejected");
  assert.throws(() => orgService.create("BAD ID", "x"), /Invalid org id/, "invalid id rejected");
  const renamed = orgService.updateName(orgId, "改名后");
  assert.equal(renamed?.name, "改名后");
  assert.equal(orgService.updateName("nope-" + Date.now(), "x"), undefined, "update missing org -> undefined");
  const listed = orgService.list();
  assert.ok(listed.some((o) => o.id === orgId), "create visible in list");
  assert.ok(listed.some((o) => o.id === DEFAULT_ORG_ID), "default-org still present");
}

console.log("phase7-org-admin tests passed");
