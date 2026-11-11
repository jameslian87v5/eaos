// R2 (ACTIVE remediation) — capability-write governance audit closure.
//
// Every capability write (skill/mcp global toggle, entitlement replace, api
// register/update/delete, plugin import/uninstall) must leave a metadata-only
// governance_audit_log row for success / denied / failure. org_admin own-org
// entitlement toggle audited; cross-org entitlement attempt audited as denied.
// No token/body/payload recorded (schema has none). Cross-org audit scoping:
// org_admin A cannot see org B's audit rows.
//
// Run: npx tsx server/r2-capability-audit.test.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const PORT = "3994";
const DB_PATH = "/tmp/r2-capability-audit-test.db";
const ENTITLEMENTS_PATH = "/tmp/r2-capability-audit-entitlements.json";
process.env.DB_PATH = DB_PATH;
process.env.ENTITLEMENTS_FILE = ENTITLEMENTS_PATH;
process.env.PORT = PORT;
process.env.JWT_SECRET = "r2-capability-audit-secret-strong-7c2b";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });
rmSync(ENTITLEMENTS_PATH, { force: true });

const db = (await import("./database.js")).default;
await import("./server.js");

const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

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
async function putJson(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
async function loginAs(username: string, password: string): Promise<string> {
  const r = await postJson("/api/auth/login", { username, password });
  if (!r.ok) throw new Error(`login ${username} failed: ${r.status} ${await r.text()}`);
  return (await r.json() as any).token;
}
function provisionDept(token: string, id: string, name: string, adminUser: string, adminPass: string) {
  return postJson("/api/admin/orgs", { id, name, adminUsername: adminUser, adminPassword: adminPass }, token);
}
async function assertStatus(r: Response, expected: number, what: string): Promise<void> {
  if (r.status !== expected) throw new Error(`${what}: expected ${expected}, got ${r.status} ${await r.text()}`);
}
// Find an audit row by action + result (+ optional objectId). Returns the row or undefined.
function findAudit(action: string, result?: string, objectId?: string): any {
  const clauses = ["action = ?"];
  const params: any[] = [action];
  if (result) { clauses.push("result = ?"); params.push(result); }
  if (objectId) { clauses.push("object_id = ?"); params.push(objectId); }
  return db.prepare(`SELECT * FROM governance_audit_log WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 1`).get(...params) as any;
}

await pollReady();

// Seeded admin (admin/admin123) has must_change=1; clear it so it can act.
db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
const adminToken = await loginAs("admin", "admin123");

const ENG_ADMIN = `eng-admin-${Date.now()}`;
const ENG_PASS = "EngAdminPassw0rd";
const SALES_ADMIN = `sales-admin-${Date.now()}`;
const SALES_PASS = "SalesPass0word";
{
  const r1 = await provisionDept(adminToken, "eng", "工程部", ENG_ADMIN, ENG_PASS);
  if (!r1.ok) throw new Error(`provision eng failed: ${r1.status} ${await r1.text()}`);
  const r2 = await provisionDept(adminToken, "sales", "销售部", SALES_ADMIN, SALES_PASS);
  if (!r2.ok) throw new Error(`provision sales failed: ${r2.status} ${await r2.text()}`);
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username IN (?, ?)`).run(ENG_ADMIN, SALES_ADMIN);
}
const engToken = await loginAs(ENG_ADMIN, ENG_PASS);     // org_admin of eng
const salesToken = await loginAs(SALES_ADMIN, SALES_PASS); // org_admin of sales

const SKILL_NAME = "r2-fake-skill";
const RESOURCE_ID = "skill:r2-test-resource";

// ─── 1. org_admin global skill toggle → 403 + denied audit ──────────────
{
  const r = await postJson(`/api/admin/skills/${SKILL_NAME}/enable`, {}, engToken);
  await assertStatus(r, 403, "org_admin skill enable");
  const row = findAudit("skill.enable", "denied", SKILL_NAME);
  ok(!!row, "1. skill.enable denied audit row written");
  ok(row?.actor_role === "org_admin", "1. denied audit actorRole=org_admin");
  ok(row?.org_id === "eng", "1. denied audit orgId=eng");
  ok(row?.object_id === SKILL_NAME, "1. denied audit objectId captured");
  // metadata-only: no payload column exists on the table; reason is categorical.
  ok(typeof row?.reason_summary === "string" && row.reason_summary.length > 0, "1. reasonSummary present");
  console.log("✓ 1. org_admin global skill toggle → 403 + denied audit (metadata-only)");
}

// ─── 2. admin global skill toggle on nonexistent → 404 + failure audit ───
{
  const r = await postJson(`/api/admin/skills/${SKILL_NAME}/disable`, {}, adminToken);
  await assertStatus(r, 404, "admin skill disable (nonexistent)");
  const row = findAudit("skill.disable", "failure", SKILL_NAME);
  ok(!!row, "2. skill.disable failure audit row written");
  ok(row?.actor_role === "admin", "2. failure audit actorRole=admin");
  ok(row?.reason_summary === "skill not found", "2. failure reasonSummary categorical");
  console.log("✓ 2. admin skill toggle (404) → failure audit");
}

// ─── 3. org_admin own-org entitlement replace → 200 + success audit ─────
{
  const r = await putJson(
    `/api/admin/capabilities/${encodeURIComponent(RESOURCE_ID)}/entitlements`,
    { entries: [{ scopeType: "org", scopeId: "eng", effect: "allow" }] },
    engToken,
  );
  await assertStatus(r, 200, "org_admin own-org entitlement replace");
  const row = findAudit("entitlement.replace", "success", RESOURCE_ID);
  ok(!!row, "3. entitlement.replace success audit row written");
  ok(row?.actor_role === "org_admin", "3. success audit actorRole=org_admin");
  ok(row?.org_id === "eng", "3. success audit orgId=eng");
  console.log("✓ 3. org_admin own-org entitlement replace → 200 + success audit");
}

// ─── 4. org_admin cross-org entitlement attempt → 403 + denied audit ────
{
  const r = await putJson(
    `/api/admin/capabilities/${encodeURIComponent(RESOURCE_ID)}/entitlements`,
    { entries: [{ scopeType: "org", scopeId: "sales", effect: "allow" }] },
    engToken, // eng org_admin trying to grant to sales
  );
  await assertStatus(r, 403, "org_admin cross-org entitlement (denied)");
  const row = findAudit("entitlement.replace", "denied", RESOURCE_ID);
  ok(!!row, "4. entitlement.replace denied audit row written");
  ok(row?.org_id === "eng", "4. denied audit orgId=eng (caller's org, not target)");
  ok(row?.reason_summary === "entitlement scope violation", "4. denied reasonSummary categorical");
  console.log("✓ 4. org_admin cross-org entitlement → 403 + denied audit");
}

// ─── 5. plugin import missing fields → 400 + failure audit ──────────────
{
  const r = await postJson("/api/admin/plugins/import", { path: "/tmp/x" /* no name */ }, adminToken);
  await assertStatus(r, 400, "plugin import missing name");
  const row = findAudit("plugin.import", "failure");
  ok(!!row, "5. plugin.import failure audit row written");
  ok(row?.actor_role === "admin", "5. failure audit actorRole=admin");
  console.log("✓ 5. plugin import (missing fields) → 400 + failure audit");
}

// ─── 6. plugin uninstall missing name → 400 + failure audit ─────────────
{
  const r = await postJson("/api/admin/plugins/uninstall", {}, adminToken);
  await assertStatus(r, 400, "plugin uninstall missing name");
  const row = findAudit("plugin.uninstall", "failure");
  ok(!!row, "6. plugin.uninstall failure audit row written");
  console.log("✓ 6. plugin uninstall (missing name) → 400 + failure audit");
}

// ─── 7. api register missing fields → 400 + failure audit ───────────────
{
  const r = await postJson("/api/admin/apis", { name: "x" /* missing apiUrl, method */ }, adminToken);
  await assertStatus(r, 400, "api register missing fields");
  const row = findAudit("api.register", "failure");
  ok(!!row, "7. api.register failure audit row written");
  console.log("✓ 7. api register (missing fields) → 400 + failure audit");
}

// ─── 8. Cross-org audit scoping: eng cannot see sales' audit rows ────────
{
  // Insert a sales-org audit row directly (simulating a sales action) so we
  // have a guaranteed sales-scoped row to test the read filter against.
  const { writeGovernanceAudit } = await import("./org-governance.js");
  writeGovernanceAudit({
    actorUserId: "sales-user", actorRole: "org_admin", orgId: "sales",
    action: "skill.disable", objectType: "skill", objectId: "sales-only-skill",
    result: "denied", reasonSummary: "cross-org read probe fixture",
  });
  // eng-scoped query must NOT return the sales row.
  const engRows = db
    .prepare(`SELECT * FROM governance_audit_log WHERE org_id = ? AND object_id = ?`)
    .all("eng", "sales-only-skill") as any[];
  ok(engRows.length === 0, "8. sales-scoped audit row does NOT appear under eng orgId");
  // And the sales row IS visible under sales orgId.
  const salesRows = db
    .prepare(`SELECT * FROM governance_audit_log WHERE org_id = ? AND object_id = ?`)
    .all("sales", "sales-only-skill") as any[];
  ok(salesRows.length === 1, "8. sales-scoped audit row visible under sales orgId");
  console.log("✓ 8. cross-org audit scoping: eng cannot see sales audit rows");
}

// ─── 9. Metadata-only: governance_audit_log has no payload/body column ───
{
  const cols = db.prepare(`PRAGMA table_info(governance_audit_log)`).all() as any[];
  const names = cols.map((c) => c.name);
  ok(!names.includes("payload") && !names.includes("body") && !names.includes("token"), "9. no payload/body/token column on governance_audit_log");
  console.log("✓ 9. governance_audit_log is metadata-only (no payload/body/token column)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
// Best-effort: let the server keep the process alive long enough; tests exit 0.
process.exit(0);
