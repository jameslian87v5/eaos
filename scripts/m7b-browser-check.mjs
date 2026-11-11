#!/usr/bin/env node
/**
 * m7b-browser-check.mjs — Octop absorption M7b browser acceptance for the
 * governed user skill submission + admin review loop (evt_20261023024425).
 *
 * Drives a REAL Chromium against the production dist bundle:
 *   user A login → 我的技能 → submit valid ZIP → 待审核 card + manifest
 *   user B (fresh context): sees NONE of A's submissions; /api/admin/user-skills
 *   read → 403; builder options exclude the pending skill (提交≠可用).
 *   org_admin: /admin/user-skills queue shows A's submission READ-ONLY (no
 *   buttons; API write → 403 + denied audit).
 *   admin: 通过 → skill enabled + EXACTLY one submitter user-scope entitlement
 *   (A-only builder options; B excluded) → reload restores.
 *   reject path: B's skill → 拒绝 (categorical reason) → disabled + zero
 *   entitlement; re-submit same slug → 409.
 *   quarantined path: package without SKILL.md → 已隔离 record, zero registry
 *   row/dir; same slug re-submittable.
 *   duplicate while pending → 409. Audit: categorical metadata-only.
 *
 * Harness follows the m7a fix round: backend spawned detached (own process
 * group), group-kill cleanup, summary/results written AFTER cleanup. Run:
 *   NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m7b-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = 3923;
const DB_PATH = "/tmp/m7b-browser.db";
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "m7b-browser-cwd-"));
const SHOT_DIR = path.join(WT, "docs/06-deployment/evidence/m7b-user-skills");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const ADMIN_PASS = "m7b-admin-1";
const USER_A = "m7b-user-a";
const USER_A_PASS = "m7b-user-a-1x";
const USER_B = "m7b-user-b";
const USER_B_PASS = "m7b-user-b-1x";
const ORG_ADMIN = "m7b-orgadmin";
const ORG_ADMIN_PASS = "m7b-orgadmin-1x";

const SLUG_A = "m7b-skill-a";
const SLUG_B = "m7b-skill-b";
const SLUG_BAD = "m7b-bad-pkg";
const PAYLOAD_MARKER = "M7B-BROWSER-PAYLOAD-77e31";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  results.push(line);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Seed the scratch cwd with the real resource pool ──────
for (const dir of ["data", "skills"]) {
  const src = path.join(WT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(SCRATCH, dir), { recursive: true });
}
fs.writeFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), JSON.stringify({}, null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/skills.json"), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/entitlements.json"), JSON.stringify({ version: 1, entries: [] }, null, 2));
const SUBS_FILE = path.join(SCRATCH, "data/user-skill-submissions.json");

// ─── 2. ZIP fixtures (real zip-writer, real package shapes) ────
const req = createRequire(import.meta.url);
// zip-writer is TypeScript — dynamic ESM import so the script runs under tsx.
const { zipDir } = await import(
  `file://${path.join(WT, "server/skill-importer/zip-writer.ts").split(path.sep).join("/")}`
);
function buildValidPackageDir(marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m7b-pkg-src-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---
name: demo
---

# Demo skill

${marker}
`);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "references", "api.md"), "reference doc\n");
  fs.writeFileSync(path.join(dir, "LICENSE"), "MIT demo license\n");
  return dir;
}
const ZIP_A = path.join(os.tmpdir(), "m7b-pkg-a.zip");
fs.writeFileSync(ZIP_A, zipDir(buildValidPackageDir(PAYLOAD_MARKER)).buffer);
const ZIP_B = path.join(os.tmpdir(), "m7b-pkg-b.zip");
fs.writeFileSync(ZIP_B, zipDir(buildValidPackageDir("M7B-BROWSER-PAYLOAD-second")).buffer);
const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "m7b-plain-"));
fs.writeFileSync(path.join(plainDir, "readme.txt"), "not a skill package\n");
const ZIP_BAD = path.join(os.tmpdir(), "m7b-pkg-bad.zip");
fs.writeFileSync(ZIP_BAD, zipDir(plainDir).buffer);

// ─── 3. Real backend (local runtime, temp DB, isolated cwd) ──────────
try {
  const probe = await fetch(`${BASE}/api/health`);
  console.error(`FATAL: port ${PORT} already serving (HTTP ${probe.status}) — kill the squatter first`);
  process.exit(1);
} catch (e) {
  if (!/fetch failed|ECONNREFUSED/.test(String(e?.message ?? e))) throw e;
}
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
const TSX = [
  path.join(WT, "node_modules/.bin/tsx"),
  path.resolve(WT, "../../../node_modules/.bin/tsx"),
].find((p) => fs.existsSync(p));
if (!TSX) throw new Error("tsx bin not found (worktree nor parent checkout)");
// detached → own process group: cleanup group-kills the whole backend tree and
// can never match this script (whose keep-alive fetch connections would show
// up in a bare lsof port-kill — the m7a fix-round root cause).
const server = spawn(TSX, [path.join(WT, "server/server.ts")], {
  cwd: SCRATCH,
  detached: true,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    RUNTIME_MODE: "local",
    ALLOW_DEV_JWT_SECRET: "1",
    ENTITLEMENTS_FILE: path.join(SCRATCH, "data/entitlements.json"),
    AGENT_CAPABILITIES_FILE: path.join(SCRATCH, "data/agent-capabilities.json"),
    USER_SKILL_SUBMISSIONS_FILE: SUBS_FILE,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(d.toString()));
server.stderr.on("data", (d) => serverLog.push(d.toString()));

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(1000);
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok || r.status === 401 || r.status === 404) ready = true; } catch {}
  if (!ready && server.exitCode !== null) break;
}
ok("backend ready (port 3923, temp DB, isolated cwd)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// ─── 4. Provision actors over the mounted REST API ─────────────
async function api(method, url, body, token, rawZip) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(rawZip ? { "content-type": "application/zip" } : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: rawZip ? rawZip : body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function loginApi(username, pwd) {
  return (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: pwd }) })).json());
}
// Fresh users are must-change-gated: burn the first-login token, then relogin.
async function activateUser(username, pwd) {
  const first = await loginApi(username, pwd);
  if (first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: pwd, newPassword: pwd + "x" }) });
  }
  return (await loginApi(username, pwd + "x"))?.token ?? "";
}
let adminToken = "", tokenA = "", tokenB = "", tokenOrgAdmin = "";
try {
  const first = await loginApi("admin", "admin123");
  if (first?.mustChangePassword && first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
  adminToken = (await loginApi("admin", ADMIN_PASS))?.token ?? "";
  await api("POST", "/api/admin/users", { username: USER_A, password: USER_A_PASS, role: "user" }, adminToken);
  await api("POST", "/api/admin/users", { username: USER_B, password: USER_B_PASS, role: "user" }, adminToken);
  await api("POST", "/api/admin/users", { username: ORG_ADMIN, password: ORG_ADMIN_PASS, role: "org_admin" }, adminToken);
  tokenA = await activateUser(USER_A, USER_A_PASS);
  tokenB = await activateUser(USER_B, USER_B_PASS);
  tokenOrgAdmin = await activateUser(ORG_ADMIN, ORG_ADMIN_PASS);
} catch (e) {
  console.error("pre-boot setup failed:", e);
}
ok("actors provisioned (user A + user B + org_admin + admin)", !!adminToken && !!tokenA && !!tokenB && !!tokenOrgAdmin);
const USER_A_FINAL_PASS = USER_A_PASS + "x";

function registryRows() {
  return JSON.parse(fs.readFileSync(path.join(SCRATCH, "data/skills.json"), "utf8"));
}
function submissions() {
  if (!fs.existsSync(SUBS_FILE)) return [];
  return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")).submissions ?? [];
}
function entitlementEntries(rid) {
  return (JSON.parse(fs.readFileSync(path.join(SCRATCH, "data/entitlements.json"), "utf8")).entries ?? [])
    .filter((e) => e.resourceId === rid);
}

async function login(page, user, pwd) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="请输入用户名"]', user);
  await page.fill('input[placeholder="请输入密码"]', pwd);
  await page.click('button[type="submit"]');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if ((await page.locator("body").innerText()).includes("创建 Agent")) return true;
  }
  return false;
}

let submissionAId = "";
let exitCode = 0;
try {
  await (async () => {
    const browser = await chromium.launch();

    // ══ User A: submit journey ══════════════════════════════════
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctxA.newPage();
    ok("user A login", await login(page, USER_A, USER_A_FINAL_PASS));

    await page.click('[data-testid="open-my-skills"]');
    await page.waitForTimeout(800);
    ok("my-skills route /my-skills reachable", page.url().includes("/my-skills"));
    ok("empty state shows for a fresh user", (await page.locator('[data-testid="my-skills-empty"]').count()) === 1);
    await page.screenshot({ path: path.join(SHOT_DIR, "01-empty.png"), fullPage: true });

    await page.fill('[data-testid="my-skills-slug"]', SLUG_A);
    await page.fill('[data-testid="my-skills-version"]', "1.0.0");
    await page.setInputFiles('[data-testid="my-skills-file"]', ZIP_A);
    await page.click('[data-testid="my-skills-submit"]');
    await page.waitForTimeout(2000);
    ok("submitted skill appears as 待审核 card", (await page.locator(`[data-testid="my-skill-card-${SLUG_A}"]`).count()) === 1);
    ok("status chip shows 待审核", (await page.locator(`[data-testid="my-skill-card-${SLUG_A}"] [data-testid="my-skill-status"]`).innerText()).includes("待审核"));
    await page.screenshot({ path: path.join(SHOT_DIR, "02-submitted-pending.png"), fullPage: true });

    // Server authority (not DOM):
    submissionAId = submissions().find((s) => s.slug === SLUG_A)?.id ?? "";
    ok("server: submission record exists (pending_review)", submissionAId !== "" && submissions().find((s) => s.id === submissionAId)?.status === "pending_review");
    const rowA = registryRows().find((r) => r.name === SLUG_A);
    ok("server: registry row enabled:false in quarantine", rowA?.enabled === false && String(rowA?.path).startsWith("skills/quarantine/"));
    ok("server: zero entitlement while pending (提交≠可用)", entitlementEntries(SLUG_A).length === 0);
    const optsA0 = await api("GET", "/api/agent-builder/options", undefined, tokenA);
    ok("server: pending skill NOT in A's builder options (提交≠可用)", !(optsA0.json?.capabilities ?? []).some((c) => c.resourceId === SLUG_A));

    // Duplicate while pending → 409.
    const dup = await api("POST", `/api/my-skills/submit?slug=${SLUG_A}`, undefined, tokenA, new Uint8Array(fs.readFileSync(ZIP_A)));
    ok("server: duplicate slug while pending → 409", dup.status === 409, `status=${dup.status}`);

    // ══ User B: isolation ══════════════════════════════════════
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageB = await ctxB.newPage();
    ok("user B login", await login(pageB, USER_B, USER_B_PASS + "x"));
    await pageB.goto(`${BASE}/my-skills`, { waitUntil: "networkidle" });
    await pageB.waitForTimeout(800);
    ok("user B sees NONE of A's submissions", (await pageB.locator('[data-testid^="my-skill-card-"]').count()) === 0);
    const bQueue = await api("GET", "/api/admin/user-skills", undefined, tokenB);
    ok("adversarial: user B reading the admin queue → 403", bQueue.status === 403, `status=${bQueue.status}`);
    const bApprove = await api("POST", `/api/admin/user-skills/${submissionAId}/approve`, undefined, tokenB);
    ok("adversarial: user B forging an approval → 403", bApprove.status === 403, `status=${bApprove.status}`);
    ok("adversarial: submission still pending after B's denied writes", submissions().find((s) => s.id === submissionAId)?.status === "pending_review");
    await ctxB.close();

    // ══ org_admin: read-only visibility ════════════════════════
    const ctxO = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageO = await ctxO.newPage();
    ok("org_admin login", await login(pageO, ORG_ADMIN, ORG_ADMIN_PASS + "x"));
    await pageO.goto(`${BASE}/admin/user-skills`, { waitUntil: "networkidle" });
    await pageO.waitForTimeout(1000);
    ok("org_admin queue shows A's submission (read-only visibility)", (await pageO.locator(`[data-testid="user-skill-review-${SLUG_A}"]`).count()) === 1);
    ok("org_admin sees NO approve/reject buttons", (await pageO.locator('[data-testid^="approve-"]').count()) === 0 && (await pageO.locator('[data-testid^="reject-"]').count()) === 0);
    ok("org_admin page shows the read-only notice", (await pageO.locator("body").innerText()).includes("只读"));
    await pageO.screenshot({ path: path.join(SHOT_DIR, "03-orgadmin-readonly.png"), fullPage: true });
    await ctxO.close();
    const oApprove = await api("POST", `/api/admin/user-skills/${submissionAId}/approve`, undefined, tokenOrgAdmin);
    const oReject = await api("POST", `/api/admin/user-skills/${submissionAId}/reject`, { reasonCode: "nope" }, tokenOrgAdmin);
    ok("adversarial: org_admin approve/reject → 403 (admin-only authority)", oApprove.status === 403 && oReject.status === 403, `approve=${oApprove.status} reject=${oReject.status}`);
    ok("adversarial: submission still pending after org_admin's denied writes", submissions().find((s) => s.id === submissionAId)?.status === "pending_review");

    // ══ Admin: approve journey ═════════════════════════════════
    const ctxAdm = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageAdm = await ctxAdm.newPage();
    ok("admin login", await login(pageAdm, "admin", ADMIN_PASS));
    await pageAdm.goto(`${BASE}/admin/user-skills`, { waitUntil: "networkidle" });
    await pageAdm.waitForTimeout(1000);
    ok("admin queue lists the pending submission with manifest metadata",
      (await pageAdm.locator(`[data-testid="user-skill-review-${SLUG_A}"]`).count()) === 1 &&
      (await pageAdm.locator(`[data-testid="user-skill-review-${SLUG_A}"]`).innerText()).includes("sha256"));
    await pageAdm.screenshot({ path: path.join(SHOT_DIR, "04-admin-queue.png"), fullPage: true });

    pageAdm.on("dialog", (d) => d.accept());
    await pageAdm.click(`[data-testid="approve-${SLUG_A}"]`);
    await pageAdm.waitForTimeout(2000);
    const admText = await pageAdm.locator(`[data-testid="user-skill-review-${SLUG_A}"]`).innerText();
    ok("admin approve → status chip 已通过 + submitter-only note", admText.includes("已通过") && admText.includes("仅授权提交者本人"));
    await pageAdm.screenshot({ path: path.join(SHOT_DIR, "05-approved.png"), fullPage: true });
    await ctxAdm.close();

    // Server authority after approve:
    ok("server: registry row enabled:true after approve", registryRows().find((r) => r.name === SLUG_A)?.enabled === true);
    const entries = entitlementEntries(SLUG_A);
    ok("server: EXACTLY one user-scope allow for the submitter (no org spill)",
      entries.length === 1 && entries[0].scopeType === "user" && entries[0].scopeId === (submissions().find((s) => s.slug === SLUG_A)?.submitterUserId) && entries[0].effect === "allow",
      JSON.stringify(entries));
    ok("server: submission approved with reviewer provenance",
      submissions().find((s) => s.id === submissionAId)?.status === "approved" && !!submissions().find((s) => s.id === submissionAId)?.reviewedAt);
    const optsA = await api("GET", "/api/agent-builder/options", undefined, tokenA);
    const optsB = await api("GET", "/api/agent-builder/options", undefined, tokenB);
    ok("server: builder options include the skill ONLY for the submitter",
      (optsA.json?.capabilities ?? []).some((c) => c.resourceId === SLUG_A) && !(optsB.json?.capabilities ?? []).some((c) => c.resourceId === SLUG_A));

    // Reload restore (server persistence, not client state):
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    ok("reload: A's card still shows 已通过",
      (await page.locator(`[data-testid="my-skill-card-${SLUG_A}"] [data-testid="my-skill-status"]`).innerText()).includes("已通过"));
    await page.screenshot({ path: path.join(SHOT_DIR, "06-approved-reloaded.png"), fullPage: true });

    // ══ Reject path (B submits, admin rejects in the browser) ═══
    const subB = await api("POST", `/api/my-skills/submit?slug=${SLUG_B}`, undefined, tokenB, new Uint8Array(fs.readFileSync(ZIP_B)));
    const submissionBId = subB.json?.submission?.id ?? "";
    ok("server: user B submits a second skill (pending)", subB.status === 201 && !!submissionBId, `status=${subB.status}`);

    const ctxAdm2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageAdm2 = await ctxAdm2.newPage();
    await login(pageAdm2, "admin", ADMIN_PASS);
    await pageAdm2.goto(`${BASE}/admin/user-skills`, { waitUntil: "networkidle" });
    await pageAdm2.waitForTimeout(1000);
    await pageAdm2.click(`[data-testid="reject-${SLUG_B}"]`);
    await pageAdm2.waitForTimeout(600);
    ok("reject dialog opens with categorical reasons", (await pageAdm2.locator('[data-testid="reject-dialog"]').count()) === 1);
    await pageAdm2.selectOption('[data-testid="reject-reason"]', "unsafe_scripts");
    await pageAdm2.click('[data-testid="reject-confirm"]');
    await pageAdm2.waitForTimeout(2000);
    ok("admin reject → status chip 已拒绝", (await pageAdm2.locator(`[data-testid="user-skill-review-${SLUG_B}"]`).innerText()).includes("已拒绝"));
    await pageAdm2.screenshot({ path: path.join(SHOT_DIR, "07-rejected.png"), fullPage: true });
    await ctxAdm2.close();

    ok("server: rejected submission records the categorical reason",
      submissions().find((s) => s.id === submissionBId)?.status === "rejected" && submissions().find((s) => s.id === submissionBId)?.reasonCode === "unsafe_scripts");
    ok("server: registry stays enabled:false after reject", registryRows().find((r) => r.name === SLUG_B)?.enabled === false);
    ok("server: reject wrote ZERO entitlement entries", entitlementEntries(SLUG_B).length === 0);
    const optsB2 = await api("GET", "/api/agent-builder/options", undefined, tokenB);
    ok("server: B cannot configure the rejected skill", !(optsB2.json?.capabilities ?? []).some((c) => c.resourceId === SLUG_B));
    const resubmit = await api("POST", `/api/my-skills/submit?slug=${SLUG_B}`, undefined, tokenB, new Uint8Array(fs.readFileSync(ZIP_B)));
    ok("server: re-submit a rejected slug → 409 (registry occupied)", resubmit.status === 409, `status=${resubmit.status}`);

    // ══ Quarantined path (package without SKILL.md) ════════════
    const subBad = await api("POST", `/api/my-skills/submit?slug=${SLUG_BAD}`, undefined, tokenA, new Uint8Array(fs.readFileSync(ZIP_BAD)));
    ok("server: invalid package → 400 with categorical code no_skill", subBad.status === 400 && subBad.json?.code === "no_skill", `status=${subBad.status}`);
    const badRec = submissions().find((s) => s.slug === SLUG_BAD && s.status === "quarantined");
    ok("server: quarantined record kept for the submitter", badRec?.errorCode === "no_skill");
    ok("server: quarantined import left ZERO registry row", !registryRows().some((r) => r.name === SLUG_BAD));
    ok("server: quarantined import left ZERO directory", !fs.existsSync(path.join(SCRATCH, "skills/quarantine", SLUG_BAD)));
    const reOk = await api("POST", `/api/my-skills/submit?slug=${SLUG_BAD}`, undefined, tokenA, new Uint8Array(fs.readFileSync(ZIP_A)));
    ok("server: quarantined slug is re-submittable (fresh pending record)", reOk.status === 201, `status=${reOk.status}`);

    // B sees none of this either:
    const myB = await api("GET", "/api/my-skills", undefined, tokenB);
    ok("server: B's my-skills stays empty (B only owns the rejected record)",
      (myB.json?.submissions ?? []).every((s) => s.slug === SLUG_B) && (myB.json?.submissions ?? []).length === 1);

    // ══ Audit: categorical, metadata-only ══════════════════════
    const Database = req(path.join(WT, "node_modules/better-sqlite3"));
    const db = new Database(DB_PATH, { readonly: true });
    const audits = db.prepare(`SELECT * FROM governance_audit_log WHERE action LIKE 'user_skill%'`).all();
    db.close();
    ok("audit: user_skill actions exist across the loop", audits.length >= 8, `count=${audits.length}`);
    ok("audit: denied writes recorded (B + org_admin authority attempts)", audits.some((a) => a.result === "denied"));
    ok("audit: approve + reject successes recorded", audits.some((a) => String(a.action).endsWith("approve") && a.result === "success") && audits.some((a) => String(a.action).endsWith("reject") && a.result === "success"));
    ok("audit: payload is metadata-only (no ZIP file content marker)", !JSON.stringify(audits).includes(PAYLOAD_MARKER));

    // ══ Fix-round adversarial: fail-closed chains + pending caps ═════
    // (a) approve is fail-closed on a malformed entitlements store (P1-2):
    //     failure response, bytes unchanged, skill disabled, ledger pending.
    const subC = await api("POST", `/api/my-skills/submit?slug=m7b-skill-c`, undefined, tokenA, new Uint8Array(fs.readFileSync(ZIP_B)));
    const subCId = subC.json?.submission?.id ?? "";
    ok("fixround: setup — C submitted pending", subC.status === 201 && !!subCId, `status=${subC.status}`);
    const entPath = path.join(SCRATCH, "data/entitlements.json");
    const entSaved = fs.readFileSync(entPath, "utf8");
    fs.writeFileSync(entPath, "{ NOT VALID JSON", "utf8");
    const entMalformed = fs.readFileSync(entPath, "utf8");
    const apprBad = await api("POST", `/api/admin/user-skills/${subCId}/approve`, undefined, adminToken);
    ok("fixround: approve on malformed entitlements → failure (not a silent reset)", apprBad.status >= 400, `status=${apprBad.status}`);
    ok("fixround: malformed entitlement bytes unchanged", fs.readFileSync(entPath, "utf8") === entMalformed);
    ok("fixround: skill remains disabled", registryRows().find((r) => r.name === "m7b-skill-c")?.enabled === false);
    ok("fixround: ledger stays pending", submissions().find((s) => s.id === subCId)?.status === "pending_review");
    fs.writeFileSync(entPath, entSaved, "utf8");
    ok("fixround: entitlements restored, A's grant intact", entitlementEntries(SLUG_A).length === 1);

    // (b) submit is fail-closed on a malformed ledger (P1-1): zero residue.
    const subsSaved = fs.readFileSync(SUBS_FILE, "utf8");
    fs.writeFileSync(SUBS_FILE, "]]] not json", "utf8");
    const subsMalformed = fs.readFileSync(SUBS_FILE, "utf8");
    const badSub = await api("POST", `/api/my-skills/submit?slug=m7b-skill-d`, undefined, tokenA, new Uint8Array(fs.readFileSync(ZIP_A)));
    ok("fixround: submit with malformed ledger → 500 fail-closed", badSub.status === 500, `status=${badSub.status}`);
    ok("fixround: malformed ledger bytes unchanged", fs.readFileSync(SUBS_FILE, "utf8") === subsMalformed);
    ok("fixround: zero registry row for the attempted slug", !registryRows().some((r) => r.name === "m7b-skill-d"));
    ok("fixround: zero quarantine dir for the attempted slug", !fs.existsSync(path.join(SCRATCH, "skills/quarantine/m7b-skill-d")));
    fs.writeFileSync(SUBS_FILE, subsSaved, "utf8");

    // (c) submitter cap via QUARANTINED volume (fix round 2): seed 5
    // quarantined records for B — the next B request must be blocked BEFORE
    // import (no extraction residue, no registry row). The ledger stores the
    // UUID userId (not the username), so take it from B's own record.
    const bUserId = submissions().find((s) => s.slug === SLUG_B)?.submitterUserId ?? "";
    ok("fixround2: setup — B's ledger userId captured", !!bUserId);
    const storeNow = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
    for (let i = 0; i < 5; i++) {
      storeNow.submissions.push({
        id: `seed-q-${i}`, slug: `seed-q-${i}`, submitterUserId: bUserId, orgId: "default-org",
        status: "quarantined", errorCode: "no_skill",
        createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
      });
    }
    fs.writeFileSync(SUBS_FILE, JSON.stringify(storeNow, null, 2));
    const qCap = await api("POST", `/api/my-skills/submit?slug=m7b-skill-e`, undefined, tokenB, new Uint8Array(fs.readFileSync(ZIP_B)));
    ok("fixround2: 5 quarantined records block the next submit → 429 categorical", qCap.status === 429 && qCap.json?.code === "submission_cap_submitter", `status=${qCap.status} code=${qCap.json?.code}`);
    ok("fixround2: capped request ran ZERO import (no registry row)", !registryRows().some((r) => r.name === "m7b-skill-e"));
    ok("fixround2: capped request left ZERO quarantine dir", !fs.existsSync(path.join(SCRATCH, "skills/quarantine/m7b-skill-e")));

    // (d) cross-user org cap via quarantined volume: fill the org's OPEN
    // total with quarantined filler records, then the org_admin (own open = 0,
    // low-history user) is blocked by other users' volume.
    const storeOrg = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
    const openNow = storeOrg.submissions.filter((s) => s.orgId === "default-org" && (s.status === "pending_review" || s.status === "quarantined")).length;
    for (let i = 0; i < 20 - openNow; i++) {
      storeOrg.submissions.push({
        id: `seed-q-org-${i}`, slug: `seed-q-org-${i}`, submitterUserId: "m7b-org-filler", orgId: "default-org",
        status: "quarantined", errorCode: "no_skill",
        createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
      });
    }
    fs.writeFileSync(SUBS_FILE, JSON.stringify(storeOrg, null, 2));
    const orgCap = await api("POST", `/api/my-skills/submit?slug=m7b-skill-f`, undefined, tokenOrgAdmin, new Uint8Array(fs.readFileSync(ZIP_B)));
    ok("fixround2: cross-user org quarantined volume blocks a low-history user → 429 submission_cap_org", orgCap.status === 429 && orgCap.json?.code === "submission_cap_org", `status=${orgCap.status} code=${orgCap.json?.code}`);
    ok("fixround2: org cap rejection left zero registry row", !registryRows().some((r) => r.name === "m7b-skill-f"));

    // Cap denials are audited categorically (re-open read-only DB).
    const Database2 = req(path.join(WT, "node_modules/better-sqlite3"));
    const db2 = new Database2(DB_PATH, { readonly: true });
    const capAudits = db2.prepare(`SELECT * FROM governance_audit_log WHERE action LIKE 'user_skill%' AND result = 'denied' AND reason_summary LIKE '%cap%'`).all();
    db2.close();
    ok("fixround2: cap denials audited categorically (new codes)", capAudits.length >= 2 && capAudits.some((a) => a.reason_summary === "submission_cap_submitter") && capAudits.some((a) => a.reason_summary === "submission_cap_org"), `count=${capAudits.length}`);

    await ctxA.close();
    await browser.close();
  })();
} catch (e) {
  console.error("browser check crashed:", e);
  fail++;
  exitCode = 1;
} finally {
  // Group-kill the spawned backend tree (detached group). NEVER a bare
  // lsof port-kill here: this script holds keep-alive fetch connections to
  // the port and would SIGKILL itself (m7a fix-round root cause, exit 137).
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
  try { server.kill("SIGKILL"); } catch {}
}

// Summary + results are written AFTER cleanup so cleanup can never lose the
// run's outcome and the cleanup above can never kill this process.
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) exitCode = 1;
fs.writeFileSync(
  path.join(SHOT_DIR, "browser-check-results.txt"),
  results.join("\n") + `\n\n${pass} passed, ${fail} failed.\n`
);
process.exit(exitCode);
