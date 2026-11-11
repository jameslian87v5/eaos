// R2 (follow-up) — Application CRUD governance-audit + no-500 closure.
//
// Before this fix, POST/PATCH/DELETE /api/admin/applications (and PUT
// /applications/:id/capabilities) called eventStore.appendEvent(ctx.userId,
// app.id, "admin", …) — app.id is not a chat, so agent_events chat_id FK made
// every successful mutation 500 AFTER persisting. R2 moves these to the
// metadata-only governance_audit_log sink. This test proves:
//   - admin create/update/disable succeed (no 500) + audit success
//   - org_admin own-org create/update/disable succeed (no 500) + audit success
//   - org_admin cross-org update/disable → 404 (hidden via appAccessible) + audit failure
//   - audit rows are metadata-only (no payload column on the table)
//
// Run: npx tsx server/r2-app-crud-audit.test.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const PORT = "3995";
const DB_PATH = "/tmp/r2-app-crud-audit-test.db";
process.env.DB_PATH = DB_PATH;
process.env.PORT = PORT;
process.env.JWT_SECRET = "r2-app-crud-audit-secret-strong-3d8c";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });

const db = (await import("./database.js")).default;
await import("./server.js");

const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
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
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not become ready in 10s");
}
async function req(method: string, path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
}
async function loginAs(username: string, password: string): Promise<string> {
  const r = await req("POST", "/api/auth/login", { username, password });
  if (!r.ok) throw new Error(`login ${username} failed: ${r.status} ${await r.text()}`);
  return (await r.json() as any).token;
}
function provisionDept(token: string, id: string, name: string, adminUser: string, adminPass: string) {
  return req("POST", "/api/admin/orgs", { id, name, adminUsername: adminUser, adminPassword: adminPass }, token);
}
function findAudit(action: string, result?: string, objectId?: string): any {
  const clauses = ["action = ?"];
  const params: any[] = [action];
  if (result) { clauses.push("result = ?"); params.push(result); }
  if (objectId) { clauses.push("object_id = ?"); params.push(objectId); }
  return db.prepare(`SELECT * FROM governance_audit_log WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 1`).get(...params) as any;
}

await pollReady();
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
const engToken = await loginAs(ENG_ADMIN, ENG_PASS);

// ─── 1. admin create → 201 + success audit ──────────────────────────────
let adminAppId: string;
{
  const r = await req("POST", "/api/admin/applications", { name: "admin-app", description: "d" }, adminToken);
  ok(r.status === 201, `1. admin create status 201 (got ${r.status})`);
  const app = await r.json() as any;
  adminAppId = app.id;
  ok(!!adminAppId, "1. admin app has id");
  const row = findAudit("application.create", "success", adminAppId);
  ok(!!row, "1. application.create success audit row");
  console.log("✓ 1. admin create → 201 + success audit");
}

// ─── 2. admin update → 200 + success audit ──────────────────────────────
{
  const r = await req("PATCH", `/api/admin/applications/${encodeURIComponent(adminAppId)}`, { description: "updated" }, adminToken);
  ok(r.status === 200, `2. admin update status 200 (got ${r.status})`);
  const row = findAudit("application.update", "success", adminAppId);
  ok(!!row, "2. application.update success audit row");
  console.log("✓ 2. admin update → 200 + success audit");
}

// ─── 3. admin disable (DELETE) → 200 + success audit ────────────────────
{
  const r = await req("DELETE", `/api/admin/applications/${encodeURIComponent(adminAppId)}`, null, adminToken);
  ok(r.status === 200, `3. admin disable status 200 (got ${r.status})`);
  const row = findAudit("application.delete", "success", adminAppId);
  ok(!!row, "3. application.delete success audit row");
  console.log("✓ 3. admin disable → 200 + success audit");
}

// ─── 4. org_admin own-org create → 201 + success audit ──────────────────
let engAppId: string;
{
  const r = await req("POST", "/api/admin/applications", { name: "eng-app" }, engToken);
  ok(r.status === 201, `4. org_admin own-org create 201 (got ${r.status})`);
  const app = await r.json() as any;
  engAppId = app.id;
  ok(app.orgId === "eng", "4. org_admin app is own-org (eng)");
  const row = findAudit("application.create", "success", engAppId);
  ok(!!row && row.actor_role === "org_admin", "4. org_admin create success audit");
  console.log("✓ 4. org_admin own-org create → 201 + success audit");
}

// ─── 5. org_admin own-org update → 200 + success audit ──────────────────
{
  const r = await req("PATCH", `/api/admin/applications/${encodeURIComponent(engAppId)}`, { description: "eng-updated" }, engToken);
  ok(r.status === 200, `5. org_admin own-org update 200 (got ${r.status})`);
  const row = findAudit("application.update", "success", engAppId);
  ok(!!row, "5. org_admin update success audit");
  console.log("✓ 5. org_admin own-org update → 200 + success audit");
}

// ─── 6. org_admin own-org disable → 200 + success audit ─────────────────
{
  const r = await req("DELETE", `/api/admin/applications/${encodeURIComponent(engAppId)}`, null, engToken);
  ok(r.status === 200, `6. org_admin own-org disable 200 (got ${r.status})`);
  const row = findAudit("application.delete", "success", engAppId);
  ok(!!row, "6. org_admin disable success audit");
  console.log("✓ 6. org_admin own-org disable → 200 + success audit");
}

// ─── 7. org_admin cross-org update → 404 (hidden) + failure audit ───────
// admin creates a sales-scoped app; eng org_admin must not see/mutate it.
let salesAppId: string;
{
  const c = await req("POST", "/api/admin/applications", { name: "sales-app", orgId: "sales" }, adminToken);
  salesAppId = (await c.json() as any).id;
}
{
  const r = await req("PATCH", `/api/admin/applications/${encodeURIComponent(salesAppId)}`, { description: "hack" }, engToken);
  ok(r.status === 404, `7. org_admin cross-org update → 404 hidden (got ${r.status})`);
  const row = findAudit("application.update", "failure", salesAppId);
  ok(!!row && row.reason_summary === "not found or cross-org", "7. cross-org update failure audit");
  console.log("✓ 7. org_admin cross-org update → 404 + failure audit");
}

// ─── 8. org_admin cross-org disable → 404 + failure audit ────────────────
{
  const r = await req("DELETE", `/api/admin/applications/${encodeURIComponent(salesAppId)}`, null, engToken);
  ok(r.status === 404, `8. org_admin cross-org disable → 404 (got ${r.status})`);
  const row = findAudit("application.delete", "failure", salesAppId);
  ok(!!row, "8. cross-org disable failure audit");
  console.log("✓ 8. org_admin cross-org disable → 404 + failure audit");
}

// ─── 9. caps PUT success → 200 + success audit ──────────────────────────
// Fresh app for caps testing (admin can access any org's app).
let capsAppId: string;
{
  const c = await req("POST", "/api/admin/applications", { name: "caps-app" }, adminToken);
  capsAppId = (await c.json() as any).id;
}
{
  const r = await req("PUT", `/api/admin/applications/${encodeURIComponent(capsAppId)}/capabilities`, { resources: [{ resourceId: "res-a", enabled: true }] }, adminToken);
  ok(r.status === 200, `9. caps PUT success 200 (got ${r.status})`);
  const row = findAudit("application.caps", "success", capsAppId);
  ok(!!row && row.reason_summary === "1 capabilities", "9. caps success audit (count only)");
  console.log("✓ 9. caps PUT success → 200 + success audit");
}

// ─── 10. caps invalid input (resources not array) → 400 + failure ─────────
{
  const r = await req("PUT", `/api/admin/applications/${encodeURIComponent(capsAppId)}/capabilities`, { resources: "not-an-array" }, adminToken);
  ok(r.status === 400, `10. caps invalid input 400 (got ${r.status})`);
  const row = findAudit("application.caps", "failure", capsAppId);
  ok(!!row && row.reason_summary === "resources array required", "10. caps invalid failure audit");
  console.log("✓ 10. caps invalid input → 400 + failure audit");
}

// ─── 11. caps cross-org → 404 (hidden) + failure audit ───────────────────
{
  const r = await req("PUT", `/api/admin/applications/${encodeURIComponent(salesAppId)}/capabilities`, { resources: [] }, engToken);
  ok(r.status === 404, `11. caps cross-org → 404 (got ${r.status})`);
  const row = findAudit("application.caps", "failure", salesAppId);
  ok(!!row && row.reason_summary === "not found or cross-org", "11. caps cross-org failure audit");
  console.log("✓ 11. caps cross-org → 404 + failure audit");
}

// ─── 12. caps exception (NOT NULL violation) → 400 + failure audit ───────
// resources:[{enabled:true}] (no resourceId) → resource_id NOT NULL throws.
{
  const r = await req("PUT", `/api/admin/applications/${encodeURIComponent(capsAppId)}/capabilities`, { resources: [{ enabled: true }] }, adminToken);
  ok(r.status === 400, `12. caps exception 400 (got ${r.status})`);
  const row = findAudit("application.caps", "failure", capsAppId);
  ok(!!row && row.reason_summary === "application caps update failed", "12. caps exception failure audit");
  console.log("✓ 12. caps exception → 400 + failure audit");
}

// ─── 13. sensitive string in err.message NOT in audit reason_summary ────
// POST /applications with toolAllowlist:["SECRET-TOKEN-XYZ-789"] → createApp
// throws "Unsupported tool in tool_allowlist: SECRET-TOKEN-XYZ-789" (echoes
// user input). Audit must be categorical "application create failed" — the
// sentinel must NOT leak into governance_audit_log.reason_summary.
const SENTINEL = "SECRET-TOKEN-XYZ-789";
{
  const r = await req("POST", "/api/admin/applications", { name: "leak-test", toolAllowlist: [SENTINEL] }, adminToken);
  ok(r.status === 400, `13. sensitive create 400 (got ${r.status})`);
  const row = findAudit("application.create", "failure");
  ok(!!row && row.reason_summary === "application create failed", "13. create failure categorical (no err.message)");
  ok(!!row && !row.reason_summary.includes(SENTINEL), "13. sentinel NOT in reason_summary");
  // Belt-and-suspenders: scan the ENTIRE audit log for the sentinel.
  const leak = db.prepare(`SELECT COUNT(*) AS n FROM governance_audit_log WHERE reason_summary LIKE ?`).get(`%${SENTINEL}%`) as any;
  ok(leak.n === 0, `13. sentinel absent from all audit rows (found ${leak.n})`);
  console.log("✓ 13. sensitive err.message not leaked into audit reason_summary");
}

// ─── 14. api.register catch → categorical (err.message echoes name) ──────
// name with space fails VALID_API_NAME regex → create() throws
// `Invalid API name "<sentinel>": must match ...` (echoes user input, pre-INSERT).
// Audit reason_summary must be categorical, sentinel must not leak into it.
{
  const r = await req("POST", "/api/admin/apis", { name: "SENTINEL API REG", apiUrl: "http://x.example.com", method: "GET" }, adminToken);
  ok(r.status === 400, `14. api.register invalid-name 400 (got ${r.status})`);
  const row = findAudit("api.register", "failure");
  ok(!!row && row.reason_summary === "api register failed", "14. api.register categorical reason");
  ok(!!row && !row.reason_summary.includes("SENTINEL"), "14. sentinel not in api.register reason_summary");
  console.log("✓ 14. api.register catch → categorical (no err.message leak)");
}

// ─── 15. api.update catch → categorical + table-wide sentinel absent ──────
// Insert a row directly (avoids installApiAsMcp filesystem side-effect), then
// PATCH with responseMapping:{sentinel-key:123} → validateSchemaFields throws
// `responseMapping.<sentinel-key> must be a string` (echoes the key). object_id
// is req.params.id (NOT the sentinel), so the sentinel must be absent from the
// ENTIRE governance_audit_log.
const UPD_SENTINEL = "SENTINEL-KEY-789";
{
  db.prepare("INSERT INTO registered_apis (id, name, api_url, method, status) VALUES (?, ?, ?, ?, 'active')").run("upd-api-1", "upd-api-1", "http://x.example.com", "GET");
  const r = await req("PATCH", "/api/admin/apis/upd-api-1", { responseMapping: { [UPD_SENTINEL]: 123 } }, adminToken);
  ok(r.status === 400, `15. api.update invalid-responseMapping 400 (got ${r.status})`);
  const row = findAudit("api.update", "failure", "upd-api-1");
  ok(!!row && row.reason_summary === "api update failed", "15. api.update categorical reason");
  ok(!!row && !row.reason_summary.includes(UPD_SENTINEL), "15. sentinel not in api.update reason_summary");
  const leak = db.prepare(`SELECT COUNT(*) AS n FROM governance_audit_log WHERE reason_summary LIKE ? OR object_id LIKE ?`).get(`%${UPD_SENTINEL}%`, `%${UPD_SENTINEL}%`) as any;
  ok(leak.n === 0, `15. sentinel absent from all audit reason_summary+object_id (found ${leak.n})`);
  console.log("✓ 15. api.update catch → categorical + sentinel absent table-wide");
}

// ─── 16. plugin.import catch → categorical (err.message echoes name) ─────
// name with space fails VALID_PLUGIN_NAME regex → importNativePlugin throws
// `Invalid plugin name "<sentinel>": must match ...` (echoes user input).
{
  const r = await req("POST", "/api/admin/plugins/import", { name: "SENTINEL PLUGIN IMP", path: "/tmp/nope" }, adminToken);
  ok(r.status === 400, `16. plugin.import invalid-name 400 (got ${r.status})`);
  const row = findAudit("plugin.import", "failure");
  ok(!!row && row.reason_summary === "plugin import failed", "16. plugin.import categorical reason");
  ok(!!row && !row.reason_summary.includes("SENTINEL"), "16. sentinel not in plugin.import reason_summary");
  console.log("✓ 16. plugin.import catch → categorical (no err.message leak)");
}

// ─── 17. plugin.uninstall catch → categorical (err.message echoes name) ──
{
  const r = await req("POST", "/api/admin/plugins/uninstall", { name: "SENTINEL PLUGIN UNI" }, adminToken);
  ok(r.status === 400, `17. plugin.uninstall invalid-name 400 (got ${r.status})`);
  const row = findAudit("plugin.uninstall", "failure");
  ok(!!row && row.reason_summary === "plugin uninstall failed", "17. plugin.uninstall categorical reason");
  ok(!!row && !row.reason_summary.includes("SENTINEL"), "17. sentinel not in plugin.uninstall reason_summary");
  console.log("✓ 17. plugin.uninstall catch → categorical (no err.message leak)");
}

// ─── 18. metadata-only: no payload column ─────────────────────────────────
{
  const cols = db.prepare(`PRAGMA table_info(governance_audit_log)`).all() as any[];
  const names = cols.map((c) => c.name);
  ok(!names.includes("payload") && !names.includes("body") && !names.includes("token"), "18. no payload/body/token column");
  console.log("✓ 18. governance_audit_log metadata-only");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
process.exit(0);
