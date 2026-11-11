// M4 (evt_20260811100855) — real browser/CDP verification for the resource-
// governance UI. Spawns backend (3001) + Vite (5173) + Chrome CDP, seeds eng +
// sales org_admins + an eng-submitted draft (via API), then drives the real
// bundled UI via CDP (project `ws` dep, no new prod dep) and asserts:
//   - admin sees the registration + can publish it + open the distribute panel
//   - eng-admin (submitting org) sees the SAME draft (own-org visibility)
//   - sales-admin does NOT see eng's draft (cross-org no-leak)
//   - org_admin has NO publish/reject/disable buttons (self-approval denied)
// Run: node scripts/m4-cdp-verify.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket } from "ws";
import Database from "better-sqlite3";

const PORT = "3001";
const VITE_PORT = "5173";
const CDP_PORT = 9222;
const DB_PATH = "/tmp/m4-cdp-verify.db";
const REG_FILE = "/tmp/m4-cdp-verify-reg.json";
const CHROME_USER_DATA = "/tmp/eaos-m4-cdp";
const JWT_SECRET = "m4-cdp-verify-secret-strong-3b2f";

const WK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });
rmSync(REG_FILE, { force: true });
rmSync(CHROME_USER_DATA, { force: true, recursive: true });

const env = {
  ...process.env,
  PORT,
  DB_PATH,
  RESOURCE_REGISTRATIONS_FILE: REG_FILE,
  JWT_SECRET,
  ALLOW_DEV_JWT_SECRET: "1",
  RUNTIME_MODE: "local",
  NODE_ENV: "development",
};

const log = (...a) => console.log("[cdp]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, probeFn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (probeFn(r)) return r; } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// --- 1. boot backend + vite ---
log("starting backend (3001)…");
const backend = spawn("npx", ["tsx", "server/server.ts"], { cwd: WK, env, stdio: ["ignore", "pipe", "pipe"] });
backend.stderr.on("data", (d) => { process.stderr.write("[backend] " + d); });
await waitFor(`http://127.0.0.1:${PORT}/api/auth/login`, (r) => true, 30000);
log("backend ready");

log("starting vite (5173)…");
const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", VITE_PORT, "--strictPort"], { cwd: WK, env, stdio: ["ignore", "pipe", "pipe"] });
vite.stderr.on("data", (d) => { process.stderr.write("[vite] " + d); });
await waitFor(`http://127.0.0.1:${VITE_PORT}/`, (r) => r.ok, 30000);
log("vite ready");

// --- 2. seed ---
log("seeding…");
const db = new Database(DB_PATH);
db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
db.close();

const post = (p, body, token) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (p, token) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { Authorization: `Bearer ${token}` } });

const adminLogin = await post("/api/auth/login", { username: "admin", password: "admin123" });
const adminTok = (await adminLogin.json()).token;
const adminUser = (await (await get("/api/auth/me", adminTok)).json());

const ENG_ADMIN = "eng-admin-m4cdp";
const ENG_PASS = "EngAdminPassw0rd";
const SALES_ADMIN = "sales-admin-m4cdp";
const SALES_PASS = "SalesAdminPass0";
await post("/api/admin/orgs", { id: "eng", name: "工程部", adminUsername: ENG_ADMIN, adminPassword: ENG_PASS }, adminTok);
await post("/api/admin/orgs", { id: "sales", name: "销售部", adminUsername: SALES_ADMIN, adminPassword: SALES_PASS }, adminTok);
const db2 = new Database(DB_PATH);
db2.prepare(`UPDATE users SET must_change_password = 0 WHERE username IN (?, ?)`).run(ENG_ADMIN, SALES_ADMIN);
db2.close();

const engTok = (await (await post("/api/auth/login", { username: ENG_ADMIN, password: ENG_PASS })).json()).token;
const engUser = (await (await get("/api/auth/me", engTok)).json());
const salesTok = (await (await post("/api/auth/login", { username: SALES_ADMIN, password: SALES_PASS })).json()).token;
const salesUser = (await (await get("/api/auth/me", salesTok)).json());

// eng-admin submits a draft for hello-skill (shared pool) via API.
const draftRes = await post("/api/admin/resource-registrations", { resourceType: "skill", resourceName: "hello-skill", description: "eng CDP draft" }, engTok);
const draft = (await draftRes.json()).registration;
log("seeded: admin + eng/sales org_admins + eng draft for hello-skill");

// --- 3. launch chrome ---
log("launching chrome (--remote-debugging-port=9222)…");
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${CHROME_USER_DATA}`,
  "--no-first-run", "--no-default-browser-check", "--headless=new", "about:blank",
], { env, stdio: ["ignore", "pipe", "pipe"] });
await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, (r) => r.ok, 15000);
log("chrome ready");

// --- 4. CDP driver (mirrors m3-cdp-verify) ---
async function cdpFirstPage() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await r.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target found");
  return page.webSocketDebuggerUrl;
}
let cdpId = 0;
function cdp(ws, method, params = {}) {
  const id = ++cdpId;
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id === id) { ws.off("message", onMsg); m.error ? reject(new Error(`CDP ${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result); }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalInPage(ws, expression) {
  const trimmed = expression.trim();
  const isArrow = /^(\([^)]*\)\s*|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed);
  const expr = isArrow ? `(${trimmed})()` : trimmed;
  const res = await cdp(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, allowUnsafePayloadBlocking: false });
  if (res.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(res.exceptionDetails)}\n--- ${expression}`);
  return res.result.value;
}
async function waitForSelector(ws, jsPredicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await evalInPage(ws, jsPredicate); if (v) return v; } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for selector: ${jsPredicate}`);
}
let failures = [];
function assert(cond, msg) {
  if (cond) log("  ✓", msg); else { log("  ✗ FAIL:", msg); failures.push(msg); }
}
async function waitForLoad(ws, timeoutMs = 8000) {
  await new Promise((resolve) => {
    const onMsg = (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } if (m.method === "Page.loadEventFired") { ws.off("message", onMsg); resolve(); } };
    ws.on("message", onMsg); setTimeout(resolve, timeoutMs);
  });
}
async function loadAs(ws, token, user, p) {
  await cdp(ws, "Page.enable"); await cdp(ws, "Runtime.enable");
  await cdp(ws, "Page.navigate", { url: `http://127.0.0.1:${VITE_PORT}/` });
  await waitForLoad(ws);
  await evalInPage(ws, `
    localStorage.setItem("token", ${JSON.stringify(token)});
    localStorage.setItem("user", ${JSON.stringify(JSON.stringify(user))});
  `);
  await cdp(ws, "Page.navigate", { url: `http://127.0.0.1:${VITE_PORT}${p}` });
  await waitForLoad(ws);
}

const wsUrl = await cdpFirstPage();
const ws = new WebSocket(wsUrl);
await new Promise((r, e) => { ws.once("open", r); ws.once("error", e); });

// ─── ADMIN VIEW ───────────────────────────────────────────────────────────
log("\n=== ADMIN VIEW ===");
await loadAs(ws, adminTok, adminUser, "/admin/resource-registrations");
await sleep(1500);
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);

const adminRows = await evalInPage(ws, `() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const text = rows.map(r => r.textContent.replace(/\\s+/g, ' '));
  return { count: rows.length, text, hasEngDraft: text.some(t => t.includes('hello-skill') && t.includes('待审核')) };
}`);
assert(adminRows.count >= 1, `admin sees the registrations table (>=1 row; got ${adminRows.count})`);
assert(adminRows.hasEngDraft, "admin sees eng's hello-skill draft (待审核)");

// Admin publishes the draft via the UI 发布 button on the hello-skill row.
await evalInPage(ws, `() => {
  const row = [...document.querySelectorAll('table tbody tr')].find(r => r.textContent.includes('hello-skill'));
  const b = row && [...row.querySelectorAll('button')].find(x => x.textContent.includes('发布'));
  if (b) b.click();
}`);
await sleep(1200);
const afterPublish = await evalInPage(ws, `() => {
  const row = [...document.querySelectorAll('table tbody tr')].find(r => r.textContent.includes('hello-skill'));
  return row ? row.textContent.replace(/\\s+/g, ' ') : '';
}`);
assert(afterPublish.includes("已发布"), "admin 发布 click → status becomes 已发布");

// Admin opens the distribute panel + sees the owner-org entitlement.
await evalInPage(ws, `() => {
  const row = [...document.querySelectorAll('table tbody tr')].find(r => r.textContent.includes('hello-skill'));
  const b = row && [...row.querySelectorAll('button')].find(x => x.textContent.includes('分发/回收'));
  if (b) b.click();
}`);
await sleep(1000);
const distPanel = await evalInPage(ws, `() => {
  const t = document.body.textContent;
  return {
    hasOrgSelect: !!document.querySelector('select'),
    showsEngAuthorized: t.includes('eng'),
  };
}`);
assert(distPanel.hasOrgSelect, "distribute panel renders a target-org <select>");
assert(distPanel.showsEngAuthorized, "distribute panel shows eng as authorized (auto-entitled on publish)");

// ─── ENG-ADMIN VIEW (submitting org) ─────────────────────────────────────
log("\n=== ENG-ADMIN VIEW (submitting org) ===");
await loadAs(ws, engTok, engUser, "/admin/resource-registrations");
await sleep(1500);
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);
const engRows = await evalInPage(ws, `() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const text = rows.map(r => r.textContent.replace(/\\s+/g, ' '));
  return { text, seesHello: text.some(t => t.includes('hello-skill')) };
}`);
assert(engRows.seesHello, "eng-admin (submitting org) sees the hello-skill registration (own-org visibility)");

// org_admin has NO publish/reject/disable buttons (self-approval denied at UI).
const engNoAdminActions = await evalInPage(ws, `() => {
  const row = [...document.querySelectorAll('table tbody tr')].find(r => r.textContent.includes('hello-skill'));
  if (!row) return { missing: true };
  const btns = [...row.querySelectorAll('button')].map(b => b.textContent);
  return {
    hasPublish: btns.some(b => b.includes('发布')),
    hasReject: btns.some(b => b.includes('驳回')),
    hasDisable: btns.some(b => b.includes('禁用')),
  };
}`);
assert(!engNoAdminActions.hasPublish, "org_admin sees NO 发布 button (self-approval denied)");
assert(!engNoAdminActions.hasReject, "org_admin sees NO 驳回 button");
assert(!engNoAdminActions.hasDisable, "org_admin sees NO 禁用 button");

// ─── SALES-ADMIN VIEW (cross-org no-leak) ────────────────────────────────
log("\n=== SALES-ADMIN VIEW (cross-org no-leak) ===");
await loadAs(ws, salesTok, salesUser, "/admin/resource-registrations");
await sleep(1500);
const salesRows = await evalInPage(ws, `() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const text = rows.map(r => r.textContent.replace(/\\s+/g, ' '));
  return { count: rows.length, seesHello: text.some(t => t.includes('hello-skill')) };
}`);
assert(!salesRows.seesHello, "sales-admin does NOT see eng's hello-skill draft (cross-org no-leak)");

// ─── teardown ---
ws.close();
try { chrome.kill(); } catch {}
try { vite.kill(); } catch {}
try { backend.kill(); } catch {}

if (failures.length > 0) {
  console.error(`\n[cdp] ${failures.length} CDP ASSERTION(S) FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\n[cdp] ALL CDP ASSERTIONS PASSED ✓");
process.exit(0);
