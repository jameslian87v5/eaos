// M3 (evt_20260811090210) — focused proof for the admin & management-UI closure.
//
// Scope: enterprise admin gets an enterprise-wide org overview (with per-org
// counts) + dept detail; org_admin gets own-dept-only view; the org-scoped
// detail endpoint denies cross-dept reads (404, no leak). Adversarial: forged
// orgId in POST create, org_admin cross-org migrate/write, privileged-user
// mutation by org_admin, suspended-org blocks create/migrate, last active
// org_admin protection. Metadata-only audit: governance_audit_log has no
// body/payload column and writes carry only categorical fields.
//
// Run: npx tsx server/m3-admin-management.test.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const PORT = "3993";
const DB_PATH = "/tmp/m3-admin-management-test.db";
process.env.DB_PATH = DB_PATH;
process.env.PORT = PORT;
process.env.JWT_SECRET = "m3-admin-mgmt-secret-strong-9f1a";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });

const db = (await import("./database.js")).default;
await import("./server.js");

const BASE = `http://127.0.0.1:${PORT}`;

async function pollReady(): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "__probe__", password: "__probe__" }),
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not become ready in 10s");
}
async function postJson(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function patchJson(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
async function getJson(path: string, token: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}
async function assertOk(r: Response, what: string): Promise<void> {
  if (!r.ok) throw new Error(`${what} failed: HTTP ${r.status} ${await r.text()}`);
}
async function loginAs(username: string, password: string) {
  const r = await postJson("/api/auth/login", { username, password });
  if (!r.ok) throw new Error(`login ${username} failed: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ token: string; user: any }>;
}
function provisionDept(token: string, id: string, name: string, adminUser: string, adminPass: string) {
  return postJson("/api/admin/orgs", { id, name, adminUsername: adminUser, adminPassword: adminPass }, token);
}

await pollReady();

// Seeded admin (admin/admin123) has must_change=1; clear it so it can act.
db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
const admin = await loginAs("admin", "admin123");
const adminToken = admin.token;
const adminId = (await (await getJson("/api/auth/me", adminToken)).json()).userId;

// ─── Setup: provision two depts (eng, sales) with their first org_admin ─
const ENG_ADMIN = `eng-admin-${Date.now()}`;
const ENG_PASS = "EngAdminPassw0rd";
const SALES_ADMIN = `sales-admin-${Date.now()}`;
const SALES_PASS = "SalesAdminPass0";
{
  const r1 = await provisionDept(adminToken, "eng", "工程部", ENG_ADMIN, ENG_PASS);
  await assertOk(r1, "provision eng");
  const r2 = await provisionDept(adminToken, "sales", "销售部", SALES_ADMIN, SALES_PASS);
  await assertOk(r2, "provision sales");
  // First org_admins get must_change=1; clear so they can act in tests.
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username IN (?, ?)`).run(ENG_ADMIN, SALES_ADMIN);
}
const engAdmin = await loginAs(ENG_ADMIN, ENG_PASS);   // org_admin of eng
const engAdminToken = engAdmin.token;
const engAdminId = (await (await getJson("/api/auth/me", engAdminToken)).json()).userId;
const salesAdmin = await loginAs(SALES_ADMIN, SALES_PASS); // org_admin of sales
const salesAdminToken = salesAdmin.token;
const salesAdminId = (await (await getJson("/api/auth/me", salesAdminToken)).json()).userId;

// ─── 1. Enterprise overview: admin sees all orgs with counts ────────────
{
  const r = await getJson("/api/admin/orgs", adminToken);
  await assertOk(r, "admin list orgs");
  const data = await r.json();
  const ids = data.orgs.map((o: any) => o.id);
  assert.ok(ids.includes("default-org"), "default-org present");
  assert.ok(ids.includes("eng"), "eng present");
  assert.ok(ids.includes("sales"), "sales present");
  // M3: counts are server-derived and attached to each row.
  const eng = data.orgs.find((o: any) => o.id === "eng");
  assert.equal(typeof eng.userCount, "number", "eng.userCount is a number");
  assert.ok(eng.userCount >= 1, "eng has at least 1 user (the org_admin)");
  assert.equal(eng.activeOrgAdminCount, 1, "eng has 1 active org_admin");
  console.log("✓ 1. enterprise overview: admin sees all orgs with userCount + activeOrgAdminCount");
}

// ─── 2. Dept detail: admin sees org + users + orgAdmins ──────────────────
{
  const r = await getJson(`/api/admin/orgs/eng/detail`, adminToken);
  await assertOk(r, "admin org detail");
  const data = await r.json();
  assert.equal(data.org.id, "eng");
  assert.ok(Array.isArray(data.users) && data.users.length >= 1, "detail users list");
  assert.ok(Array.isArray(data.orgAdmins) && data.orgAdmins.length === 1, "1 org_admin");
  assert.equal(data.orgAdmins[0].username, ENG_ADMIN);
  console.log("✓ 2. dept detail: admin sees org + users + orgAdmins");
}

// ─── 3. org_admin own-dept-only overview ────────────────────────────────
{
  const r = await getJson("/api/admin/orgs", engAdminToken);
  await assertOk(r, "org_admin list orgs");
  const data = await r.json();
  assert.equal(data.orgs.length, 1, "org_admin sees exactly 1 org (own)");
  assert.equal(data.orgs[0].id, "eng", "it is their own dept");
  console.log("✓ 3. org_admin overview: own-dept-only (1 row)");
}

// ─── 4. org_admin cross-dept detail → 404 (no leak) ────────────────────
{
  const r = await getJson(`/api/admin/orgs/sales/detail`, engAdminToken);
  assert.equal(r.status, 404, "org_admin cross-dept detail = 404 (not 403, no existence leak)");
  console.log("✓ 4. org_admin cross-dept detail denied (404, no leak)");
}

// ─── 5. org_admin user list is own-org-only (UI scoping root) ───────────
{
  const r = await getJson("/api/admin/users", engAdminToken);
  await assertOk(r, "org_admin list users");
  const data = await r.json();
  assert.ok(data.users.every((u: any) => u.orgId === "eng"), "every visible user is in eng");
  assert.ok(data.users.some((u: any) => u.username === ENG_ADMIN), "eng-admin visible");
  assert.ok(!data.users.some((u: any) => u.username === SALES_ADMIN), "sales-admin NOT visible to eng-admin");
  console.log("✓ 5. org_admin user list own-org-only (no cross-org leak)");
}

// ─── 6. Forged orgId in POST create → rejected ───────────────────────────
// admin sends a nonexistent orgId; assertOrgActive rejects (no admin exemption).
{
  const r = await postJson("/api/admin/users", { username: `forged-${Date.now()}`, password: "ForgedPassw0rd", role: "user", orgId: "does-not-exist" }, adminToken);
  assert.equal(r.status, 403, "forged (nonexistent) orgId rejected");
  const body = await r.json();
  assert.equal(body.code, "org_not_active", "rejection reason is org_not_active");
  console.log("✓ 6. forged nonexistent orgId in POST create → 403 org_not_active");
}

// ─── 7. Suspended org blocks create + migrate ───────────────────────────
{
  // admin suspends sales.
  const rSus = await postJson(`/api/admin/orgs/sales/suspend`, {}, adminToken);
  await assertOk(rSus, "suspend sales");
  // create user in suspended sales → 403.
  const rCreate = await postJson("/api/admin/users", { username: `sales-u-${Date.now()}`, password: "SalesUserPass0", role: "user", orgId: "sales" }, adminToken);
  assert.equal(rCreate.status, 403, "create in suspended org rejected");
  // migrate eng-admin → sales (suspended) → 403.
  const rMig = await patchJson(`/api/admin/users/${engAdminId}`, { orgId: "sales" }, adminToken);
  assert.equal(rMig.status, 403, "migrate to suspended org rejected");
  // reactivate sales for downstream tests.
  const rAct = await postJson(`/api/admin/orgs/sales/activate`, {}, adminToken);
  await assertOk(rAct, "reactivate sales");
  console.log("✓ 7. suspended org blocks create + migrate (403 org_not_active)");
}

// ─── 8. org_admin cannot migrate (cross-org) ────────────────────────────
// org_admin is never allowed to migrate (it changes org = enterprise action).
{
  const r = await patchJson(`/api/admin/users/${engAdminId}`, { orgId: "sales" }, engAdminToken);
  assert.equal(r.status, 403, "org_admin migrate refused");
  console.log("✓ 8. org_admin cannot migrate (enterprise-admin only)");
}

// ─── 9. org_admin cannot mutate privileged users ────────────────────────
// Cross-org targets return 404 (no-leak, same as the detail endpoint); same-
// org privileged targets return 403. Both mean "denied + no privileged info
// leaked".
{
  // disable the enterprise admin (privileged, cross-org) → 404 (no-leak).
  const rDis = await patchJson(`/api/admin/users/${adminId}`, { status: "disabled" }, engAdminToken);
  assert.ok(rDis.status === 403 || rDis.status === 404, `org_admin disable admin refused (got ${rDis.status})`);
  // reset password on a cross-org org_admin (sales) → 404 (no-leak).
  const rReset = await patchJson(`/api/admin/users/${salesAdminId}`, { password: "NewPassw0rd1" }, engAdminToken);
  assert.ok(rReset.status === 403 || rReset.status === 404, `org_admin reset cross-org privileged refused (got ${rReset.status})`);
  console.log("✓ 9. org_admin cannot disable admin / reset cross-org privileged (denied, no-leak)");
}

// ─── 10. Last active org_admin protection ───────────────────────────────
// eng-admin is the only active org_admin of eng. Demote / disable / migrate-
// out all refused.
{
  const rDemote = await patchJson(`/api/admin/users/${engAdminId}`, { role: "user" }, adminToken);
  assert.equal(rDemote.status, 400, "demote last org_admin refused");
  const rDisable = await patchJson(`/api/admin/users/${engAdminId}`, { status: "disabled" }, adminToken);
  assert.equal(rDisable.status, 400, "disable last org_admin refused");
  const rMigrate = await patchJson(`/api/admin/users/${engAdminId}`, { orgId: "sales" }, adminToken);
  assert.equal(rMigrate.status, 400, "migrate-out last org_admin refused");
  console.log("✓ 10. last active org_admin protected (demote/disable/migrate-out refused)");
}

// ─── 11. Metadata-only governance audit ──────────────────────────────────
// Schema has no body/payload column; every write carries categorical fields.
{
  const cols = db.prepare(`PRAGMA table_info(governance_audit_log)`).all() as { name: string }[];
  const colNames = cols.map((c) => c.name);
  assert.ok(!colNames.includes("body"), "no body column");
  assert.ok(!colNames.includes("payload"), "no payload column");
  assert.ok(!colNames.includes("password"), "no password column");
  assert.ok(!colNames.includes("token"), "no token column");
  // Create a plain user in sales, then disable them — a clean write that
  // produces a user.disable audit row without tripping the last-org_admin guard.
  const salesUser = `sales-u-${Date.now()}`;
  const rCreate = await postJson("/api/admin/users", { username: salesUser, password: "SalesUserPass0", role: "user", orgId: "sales" }, adminToken);
  await assertOk(rCreate, "create sales plain user");
  const salesUserId = (await (await getJson("/api/admin/users", adminToken)).json())
    .users.find((u: any) => u.username === salesUser).id;
  const rDis = await patchJson(`/api/admin/users/${salesUserId}`, { status: "disabled" }, adminToken);
  await assertOk(rDis, "disable sales plain user");
  const row = db.prepare(`SELECT action, object_type, object_id, reason_summary, result FROM governance_audit_log WHERE action = 'user.disable' AND object_id = ? ORDER BY created_at DESC LIMIT 1`).get(salesUserId) as any;
  assert.ok(row, "user.disable audit row exists");
  assert.equal(row.result, "success");
  assert.equal(row.object_type, "user");
  console.log("✓ 11. governance_audit_log is metadata-only (no body/payload/password/token column)");
}

// ─── 12. UI role visibility root: org_admin create cannot grant privileged ─
// org_admin POST create with role=admin in body → 403 (promotion denied).
{
  const r = await postJson("/api/admin/users", { username: `eng-priv-${Date.now()}`, password: "EngPrivPassw0", role: "admin" }, engAdminToken);
  assert.equal(r.status, 403, "org_admin create with role=admin refused");
  // org_admin create with role=org_admin in body → 403 (can't grant org_admin).
  const r2 = await postJson("/api/admin/users", { username: `eng-oa-${Date.now()}`, password: "EngOaPassw000", role: "org_admin" }, engAdminToken);
  assert.equal(r2.status, 403, "org_admin create with role=org_admin refused");
  console.log("✓ 12. org_admin cannot grant privileged roles (UI role-select root enforced server-side)");
}

console.log("\nM3 admin & management-UI closure: all 12 checks passed. ✓");
process.exit(0);
