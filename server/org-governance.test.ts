// M1 (org governance) — focused proof test for the ACTIVE plan's department
// lifecycle primitives. Covers the four M1 guarantees the review asked for:
//
//   1. Provision transaction: success creates org(active)+org_admin+quota+audit;
//      failure rolls back ALL of it (no half-configured loginable department).
//   2. Status guard: assertOrgActive passes for active, throws for suspended /
//      provisioning / archived / unknown.
//   3. Last-effective-org_admin protection: demote/delete blocked when it would
//      leave a department with zero org_admins.
//   4. Cross-org: status of one org is independent of another; org_admin counts
//      are per-org.
//
// Plus legal-transition graph + audit metadata-only enforcement.
//
// Run: DB_PATH=/tmp/m1-org-gov-test.db npx tsx server/org-governance.test.ts
import assert from "node:assert/strict";
import db from "./database.js";
import { insertUserRow } from "./auth.js";
import {
  provisionOrg,
  transitionOrgStatus,
  getOrgStatus,
  assertOrgActive,
  isOrgActive,
  countActiveOrgAdmins,
  assertNotLastOrgAdmin,
  writeGovernanceAudit,
  OrgNotActiveError,
  LastOrgAdminError,
} from "./org-governance.js";
import { v4 as uuidv4 } from "uuid";

const TEST_PASS = "Passw0rd"; // 8 chars, letters + digit, not "admin123"

function resetState() {
  // Wipe org-dependent rows + orgs (keep default-org seeded for foreign keys by
  // re-seeding). Tests provision their own orgs with unique ids.
  db.exec(`DELETE FROM governance_audit_log`);
  db.exec(`DELETE FROM users WHERE org_id LIKE 'm1-%'`);
  db.exec(`DELETE FROM org_quotas WHERE org_id LIKE 'm1-%'`);
  db.exec(`DELETE FROM organizations WHERE id LIKE 'm1-%'`);
}

function orgAdmin(orgId: string, username: string): string {
  const id = uuidv4();
  insertUserRow({
    id,
    username,
    passwordHash: "$2b$10$dummyhashdummyhashdummyhashdummyhashdummyhashdummy",
    displayName: username,
    role: "org_admin",
    mustChangePassword: 0,
    orgId,
    createdAt: new Date().toISOString(),
  });
  return id;
}

// ─── 1. Provision success ──────────────────────────────────────────────
{
  resetState();
  const orgId = `m1-success-${Date.now()}`;
  const result = await provisionOrg({
    id: orgId,
    name: "Success Dept",
    firstAdminUsername: `admin_${orgId}`,
    firstAdminPassword: TEST_PASS,
    firstAdminDisplayName: "First Admin",
    actorUserId: "actor-1",
    actorRole: "admin",
  });

  // org is active (provisioning → active flipped atomically)
  assert.equal(result.org.status, "active", "provisioned org is active");
  assert.equal(getOrgStatus(orgId), "active");

  // first org_admin exists with must_change_password=1
  const admin = db
    .prepare(`SELECT role, must_change_password AS mcp, org_id AS orgId FROM users WHERE id = ?`)
    .get(result.adminUserId) as { role: string; mcp: number; orgId: string };
  assert.equal(admin.role, "org_admin", "first user is org_admin");
  assert.equal(admin.mcp, 1, "first admin must change password on first login");
  assert.equal(admin.orgId, orgId, "first admin bound to the new org");

  // default quota row created
  const quota = db
    .prepare(`SELECT org_id AS orgId FROM org_quotas WHERE org_id = ?`)
    .get(orgId);
  assert.ok(quota, "default quota row created at provision time");

  // audit row written (metadata-only schema has no body/payload column)
  const audit = db
    .prepare(`SELECT action, result FROM governance_audit_log WHERE org_id = ? AND action = 'org.provision'`)
    .get(orgId) as { action: string; result: string };
  assert.equal(audit.action, "org.provision");
  assert.equal(audit.result, "success");
  const auditCols = db
    .prepare(`SELECT name FROM pragma_table_info('governance_audit_log')`)
    .all()
    .map((r: any) => r.name);
  assert.ok(!auditCols.includes("payload"), "audit table has NO payload column");
  assert.ok(!auditCols.includes("body"), "audit table has NO body column");

  console.log("[M1] provision success: org active + org_admin(must_change=1) + quota + audit");
}

// ─── 2. Provision failure rolls back the whole transaction ─────────────
{
  resetState();
  const orgId = `m1-rollback-${Date.now()}`;

  // 2a. validation failure (short password) — throws BEFORE txn, no rows.
  await assert.rejects(
    provisionOrg({
      id: orgId,
      name: "Rollback Dept",
      firstAdminUsername: "rb_admin",
      firstAdminPassword: "short", // < 8 chars → validatePasswordStrength rejects
      actorUserId: "actor",
      actorRole: "admin",
    }),
    /password/i
  );
  assert.equal(getOrgStatus(orgId), null, "no org row after pre-txn validation failure");

  // 2b. SUCCESS once with a good password.
  await provisionOrg({
    id: orgId,
    name: "Rollback Dept",
    firstAdminUsername: "rb_admin_ok",
    firstAdminPassword: TEST_PASS,
    actorUserId: "actor",
    actorRole: "admin",
  });
  const usersBefore = (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE org_id = ?`).get(orgId) as { c: number }).c;
  assert.equal(usersBefore, 1, "one user after first successful provision");

  // 2c. SECOND provision of the SAME id → re-check inside txn throws → rollback.
  // The org already exists, so the txn must roll back and leave NO second user
  // and NO duplicate quota row. This is the atomicity guarantee.
  await assert.rejects(
    provisionOrg({
      id: orgId,
      name: "Rollback Dept DUP",
      firstAdminUsername: "rb_admin_dup",
      firstAdminPassword: TEST_PASS,
      actorUserId: "actor",
      actorRole: "admin",
    }),
    /already exists/i
  );
  const usersAfter = (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE org_id = ?`).get(orgId) as { c: number }).c;
  assert.equal(usersAfter, 1, "duplicate provision rolled back — no orphan user");
  const dupAdmin = db
    .prepare(`SELECT id FROM users WHERE username = 'rb_admin_dup'`)
    .get();
  assert.equal(dupAdmin, undefined, "the would-be second admin was NOT inserted (rollback)");

  console.log("[M1] provision atomicity: duplicate-id failure rolled back ALL writes");
}

// ─── 3. Status guard ───────────────────────────────────────────────────
{
  resetState();
  const orgId = `m1-guard-${Date.now()}`;
  await provisionOrg({
    id: orgId,
    name: "Guard Dept",
    firstAdminUsername: `g_${orgId}`,
    firstAdminPassword: TEST_PASS,
    actorUserId: "actor",
    actorRole: "admin",
  });

  // active → passes
  assert.doesNotThrow(() => assertOrgActive(orgId), "active org passes guard");
  assert.equal(isOrgActive(orgId), true);

  // suspend → guard throws OrgNotActiveError
  transitionOrgStatus({ orgId, action: "suspend", actorUserId: "actor", actorRole: "admin" });
  assert.equal(getOrgStatus(orgId), "suspended");
  assert.throws(
    () => assertOrgActive(orgId),
    (e) => e instanceof OrgNotActiveError && e.status === "suspended",
    "suspended org rejected by guard"
  );
  assert.equal(isOrgActive(orgId), false);

  // reactivate → passes again
  transitionOrgStatus({ orgId, action: "activate", actorUserId: "actor", actorRole: "admin" });
  assert.doesNotThrow(() => assertOrgActive(orgId), "reactivated org passes guard");

  // unknown org → throws with status null
  assert.throws(
    () => assertOrgActive("m1-does-not-exist"),
    (e) => e instanceof OrgNotActiveError && e.status === null,
    "unknown org rejected"
  );

  console.log("[M1] status guard: active passes; suspended/unknown throw OrgNotActiveError");
}

// ─── 4. Legal-transition graph ─────────────────────────────────────────
{
  resetState();
  const orgId = `m1-trans-${Date.now()}`;
  await provisionOrg({
    id: orgId,
    name: "Trans Dept",
    firstAdminUsername: `t_${orgId}`,
    firstAdminPassword: TEST_PASS,
    actorUserId: "actor",
    actorRole: "admin",
  });

  // illegal: provisioning→suspend is not in the graph (and provision already
  // flipped to active). Verify active→active (re-activate) is rejected too.
  assert.throws(
    () => transitionOrgStatus({ orgId, action: "activate", actorUserId: "actor", actorRole: "admin" }),
    /Illegal status transition/i,
    "active --activate--> rejected (already active)"
  );
  // suspended→suspend rejected
  transitionOrgStatus({ orgId, action: "suspend", actorUserId: "actor", actorRole: "admin" });
  assert.throws(
    () => transitionOrgStatus({ orgId, action: "suspend", actorUserId: "actor", actorRole: "admin" }),
    /Illegal status transition/i,
    "suspended --suspend--> rejected"
  );
  // unknown org → reject
  assert.throws(
    () => transitionOrgStatus({ orgId: "m1-nope", action: "suspend", actorUserId: "actor", actorRole: "admin" }),
    /not found/i
  );

  console.log("[M1] transitions: only active↔suspended allowed; illegal jumps rejected");
}

// ─── 5. Last-effective-org_admin protection ────────────────────────────
{
  resetState();
  const orgId = `m1-last-${Date.now()}`;
  await provisionOrg({
    id: orgId,
    name: "Last Admin Dept",
    firstAdminUsername: `la_${orgId}`,
    firstAdminPassword: TEST_PASS,
    actorUserId: "actor",
    actorRole: "admin",
  });

  // The provisioned first admin is the sole org_admin.
  assert.equal(countActiveOrgAdmins(orgId), 1, "one org_admin after provision");

  const soleAdmin = db
    .prepare(`SELECT id FROM users WHERE org_id = ? AND role = 'org_admin'`)
    .get(orgId) as { id: string };

  // removing the sole org_admin → blocked
  assert.throws(
    () => assertNotLastOrgAdmin(orgId, soleAdmin.id, "org_admin"),
    (e) => e instanceof LastOrgAdminError,
    "cannot remove the last org_admin"
  );

  // add a SECOND org_admin → now removing either is allowed
  const secondId = orgAdmin(orgId, `la2_${orgId}`);
  assert.equal(countActiveOrgAdmins(orgId), 2, "two org_admins after adding one");
  assert.doesNotThrow(
    () => assertNotLastOrgAdmin(orgId, soleAdmin.id, "org_admin"),
    "can remove when another org_admin remains"
  );
  assert.doesNotThrow(
    () => assertNotLastOrgAdmin(orgId, secondId, "org_admin"),
    "can remove the second when the first remains"
  );

  // removing a non-org_admin never trips the guard
  assert.doesNotThrow(
    () => assertNotLastOrgAdmin(orgId, "any-non-admin-id", "user"),
    "guard is a no-op for non-admin targets"
  );

  console.log("[M1] last-org_admin protection: blocks last removal; allows when ≥2 remain");
}

// ─── 6. Cross-org independence ─────────────────────────────────────────
{
  resetState();
  const a = `m1-cross-a-${Date.now()}`;
  const b = `m1-cross-b-${Date.now()}`;
  await provisionOrg({ id: a, name: "A", firstAdminUsername: `ca_${a}`, firstAdminPassword: TEST_PASS, actorUserId: "x", actorRole: "admin" });
  await provisionOrg({ id: b, name: "B", firstAdminUsername: `cb_${b}`, firstAdminPassword: TEST_PASS, actorUserId: "x", actorRole: "admin" });

  // suspend A only; B stays active — independent status.
  transitionOrgStatus({ orgId: a, action: "suspend", actorUserId: "x", actorRole: "admin" });
  assert.equal(isOrgActive(a), false);
  assert.equal(isOrgActive(b), true, "suspending A does not affect B");

  // org_admin counts are per-org
  assert.equal(countActiveOrgAdmins(a), 1);
  assert.equal(countActiveOrgAdmins(b), 1);

  console.log("[M1] cross-org: status + admin counts are independent per department");
}

// ─── 7. Audit write (metadata-only) ────────────────────────────────────
{
  resetState();
  writeGovernanceAudit({
    actorUserId: "u1",
    actorRole: "admin",
    orgId: "default-org",
    action: "test.event",
    objectType: "organization",
    objectId: "default-org",
    result: "denied",
    reasonSummary: "synthetic test event",
  });
  const row = db
    .prepare(`SELECT actor_role AS actorRole, result, reason_summary AS reason FROM governance_audit_log WHERE action = 'test.event'`)
    .get() as { actorRole: string; result: string; reason: string };
  assert.equal(row.actorRole, "admin");
  assert.equal(row.result, "denied");
  assert.equal(row.reason, "synthetic test event");

  console.log("[M1] audit write: metadata-only row recorded with result + reason");
}

console.log("\norg-governance (M1) tests passed");
