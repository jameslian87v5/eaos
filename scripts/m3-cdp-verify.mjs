// M3 review (evt_20260811092207) — real browser/CDP verification.
// Spawns backend (3001) + Vite dev (5173) + Chrome (--remote-debugging-port=9222),
// seeds a dept with an org_admin + a second org_admin + a plain user, then
// drives the real bundled UI via CDP (project `ws` dep, no new prod dep) and
// asserts the M3 privilege boundary + active-org selects + dept detail for
// BOTH the enterprise-admin view and the org_admin own-dept view.
//
// Run: node scripts/m3-cdp-verify.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket } from "ws";
import Database from "better-sqlite3";

const PORT = "3001";
const VITE_PORT = "5173";
const CDP_PORT = 9222;
const DB_PATH = "/tmp/m3-cdp-verify.db";
const CHROME_USER_DATA = "/tmp/eaos-m3-cdp";
const JWT_SECRET = "m3-cdp-verify-secret-strong-3b2f";

// Portable: derive the checkout root from this script's own location
// (scripts/m3-cdp-verify.mjs → checkout root = parent of scripts/). No
// hardcoded worktree path — works from any checkout/worktree.
const WK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });
rmSync(CHROME_USER_DATA, { force: true, recursive: true });

const env = {
  ...process.env,
  PORT,
  DB_PATH,
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
    try {
      const r = await fetch(url);
      if (probeFn(r)) return r;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// --- 1. boot backend + vite ---
log("starting backend (3001)…");
const backend = spawn("npx", ["tsx", "server/server.ts"], { cwd: WK, env, stdio: ["ignore", "pipe", "pipe"] });
let backendBuf = "";
backend.stdout.on("data", (d) => { backendBuf += d.toString(); });
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

const post = (path, body, token) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const adminLogin = await post("/api/auth/login", { username: "admin", password: "admin123" });
const adminTok = (await adminLogin.json()).token;
const adminUser = (await (await fetch(`http://127.0.0.1:${PORT}/api/auth/me`, { headers: { Authorization: `Bearer ${adminTok}` } })).json());

// provision eng with first org_admin eng-admin
const ENG_ADMIN = "eng-admin-cdp";
const ENG_PASS = "EngAdminPassw0rd";
const ENG_OA2 = "eng-oa2-cdp";
const ENG_U1 = "eng-u1-cdp";
await post("/api/admin/orgs", { id: "eng", name: "工程部", adminUsername: ENG_ADMIN, adminPassword: ENG_PASS }, adminTok);
// clear eng-admin must_change so it can log in cleanly
const db2 = new Database(DB_PATH);
db2.prepare(`UPDATE users SET must_change_password = 0 WHERE username = ?`).run(ENG_ADMIN);
db2.close();
// create a 2nd org_admin + a plain user in eng (admin may)
await post("/api/admin/users", { username: ENG_OA2, password: "EngOa2Passw0r", role: "org_admin", orgId: "eng" }, adminTok);
await post("/api/admin/users", { username: ENG_U1, password: "EngU1Passw00", role: "user", orgId: "eng" }, adminTok);

const engLogin = await post("/api/auth/login", { username: ENG_ADMIN, password: ENG_PASS });
const engTok = (await engLogin.json()).token;
const engUser = (await (await fetch(`http://127.0.0.1:${PORT}/api/auth/me`, { headers: { Authorization: `Bearer ${engTok}` } })).json());
log("seeded: admin + eng{eng-admin, eng-oa2, eng-u1}");

// --- 3. launch chrome with remote debugging ---
log("launching chrome (--remote-debugging-port=9222)…");
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${CHROME_USER_DATA}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--headless=new",
  "about:blank",
], { env, stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", (d) => { /* swallow */ });
await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`, (r) => r.ok, 15000);
log("chrome ready");

// --- 4. CDP driver ---
async function cdpFirstPage() {
  // Chrome 151 removed GET /json/new (405). Reuse the existing about:blank tab
  // the launcher opened: GET /json lists all targets; pick the first page.
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await r.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target found");
  return page.webSocketDebuggerUrl;
}

function cdp(ws, method, params = {}) {
  const id = ++cdpId;
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id === id) {
        ws.off("message", onMsg);
        if (m.error) reject(new Error(`CDP ${method}: ${JSON.stringify(m.error)}`));
        else resolve(m.result);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
let cdpId = 0;

async function evalInPage(ws, expression) {
  // Auto-invoke arrow-function expressions so callers can pass `() => ({...})`
  // and get the returned value (not the function object serialized as {}).
  // Raw-statement blocks (no leading arrow) run as-is.
  const trimmed = expression.trim();
  const isArrow = /^(\([^)]*\)\s*|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed);
  const expr = isArrow ? `(${trimmed})()` : trimmed;
  const res = await cdp(ws, "Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafePayloadBlocking: false,
  });
  if (res.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(res.exceptionDetails)}\n--- ${expression}`);
  return res.result.value;
}

async function waitForSelector(ws, jsPredicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await evalInPage(ws, jsPredicate);
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for selector: ${jsPredicate}`);
}

let failures = [];
function assert(cond, msg) {
  if (cond) { log("  ✓", msg); }
  else { log("  ✗ FAIL:", msg); failures.push(msg); }
}

async function waitForLoad(ws, timeoutMs = 8000) {
  await new Promise((resolve) => {
    const onMsg = (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.method === "Page.loadEventFired") { ws.off("message", onMsg); resolve(); }
    };
    ws.on("message", onMsg);
    setTimeout(resolve, timeoutMs); // fallback
  });
}

async function loadAs(ws, token, user, path) {
  // The page starts at about:blank (opaque origin) — localStorage is denied
  // there. So: navigate to the app origin root first (so the document is on
  // 127.0.0.1:5173), THEN inject localStorage, THEN navigate to the target
  // admin path (localStorage persists across same-origin navigations).
  await cdp(ws, "Page.enable");
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Page.navigate", { url: `http://127.0.0.1:${VITE_PORT}/` });
  await waitForLoad(ws);
  await evalInPage(ws, `
    localStorage.setItem("token", ${JSON.stringify(token)});
    localStorage.setItem("user", ${JSON.stringify(JSON.stringify(user))});
  `);
  await cdp(ws, "Page.navigate", { url: `http://127.0.0.1:${VITE_PORT}${path}` });
  await waitForLoad(ws);
}

const wsUrl = await cdpFirstPage();
const ws = new WebSocket(wsUrl);
await new Promise((r, e) => { ws.once("open", r); ws.once("error", e); });

// ─── ADMIN VIEW ───────────────────────────────────────────────────────────
log("\n=== ADMIN VIEW ===");
await loadAs(ws, adminTok, adminUser, "/admin/users");
await sleep(1500);
const debug = await evalInPage(ws, `() => ({
  url: location.href,
  title: document.title,
  hasToken: !!localStorage.getItem('token'),
  hasUser: !!localStorage.getItem('user'),
  bodyStart: document.body.textContent.replace(/\\s+/g, ' ').slice(0, 180),
  rowCount: document.querySelectorAll('table tbody tr').length,
})`);
log("  [debug] admin page:", JSON.stringify(debug));
// wait for the users table to render rows
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);
// Open the create-user form to reveal the active-dept <select>.
await evalInPage(ws, `() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('创建用户')); b && b.click(); }`);
await sleep(500);
const adminCreateOrgSel = await evalInPage(ws, `() => {
  // The create-user form has two selects (Role, 所属部门). The org select is
  // the one whose options contain an org id (e.g. "eng"); the role select only
  // lists user/org_admin/admin. Collect options across all form selects.
  const selects = [...document.querySelectorAll('form select')];
  const allOpts = selects.flatMap(s => [...s.querySelectorAll('option')].map(o => o.textContent));
  const orgOpts = selects.map(s => [...s.querySelectorAll('option')].map(o => o.textContent))
    .find(opts => opts.some(o => /eng|default-org|sales/.test(o))) || [];
  return { ok: selects.length >= 2, count: orgOpts.length, opts: orgOpts, allOpts };
}`);
assert(adminCreateOrgSel.ok, "create-user form renders an org <select>");
assert(adminCreateOrgSel.count >= 1, `org <select> has >=1 active dept option (got ${adminCreateOrgSel.count})`);
assert((adminCreateOrgSel.opts || []).some((o) => o.includes("eng")), `org <select> includes eng (工程部) (opts=${JSON.stringify(adminCreateOrgSel.opts)})`);

// On the admin Users page, a privileged (org_admin) row keeps full controls
// (admin can manage every row) — the role <select> is present, not a badge.
const adminRowView = await evalInPage(ws, `() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const find = (name) => rows.find(r => r.textContent.includes(name));
  const engOa2 = find('${ENG_OA2}');
  const engU1 = find('${ENG_U1}');
  return {
    engOa2HasRoleSelect: !!(engOa2 && engOa2.querySelector('select')),
    engOa2HasReset: !!(engOa2 && [...engOa2.querySelectorAll('button')].some(b => b.textContent.includes('重置密码'))),
    engOa2HasMigrate: !!(engOa2 && [...engOa2.querySelectorAll('button')].some(b => b.textContent.includes('迁移'))),
    engU1HasReset: !!(engU1 && [...engU1.querySelectorAll('button')].some(b => b.textContent.includes('重置密码'))),
  };
}`);
assert(adminRowView.engOa2HasRoleSelect, "admin sees a role <select> on the org_admin row (not read-only badge)");
assert(adminRowView.engOa2HasReset, "admin sees 重置密码 on the org_admin row (admin can manage privileged)");
assert(adminRowView.engOa2HasMigrate, "admin sees 迁移 on the org_admin row");
assert(adminRowView.engU1HasReset, "admin sees 重置密码 on the plain-user row");

// Orgs page: enterprise overview + dept detail (详情) for eng.
await evalInPage(ws, `() => { location.href = '/admin/orgs'; }`);
await sleep(700);
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);
// Click the 详情 button on the ENG row (not the first/default-org row).
await evalInPage(ws, `() => {
  const engRow = [...document.querySelectorAll('table tbody tr')].find(r => r.textContent.includes('eng') && r.textContent.includes('工程部'));
  const b = engRow && [...engRow.querySelectorAll('button')].find(x => x.textContent === '详情');
  if (b) b.click();
}`);
await sleep(1200);
const detailView = await evalInPage(ws, `() => {
  const t = document.body.textContent;
  return {
    showsEngAdmins: t.includes('${ENG_ADMIN}') || t.includes('${ENG_OA2}'),
    showsUsersLabel: t.includes('用户') && t.includes('部门管理员'),
    bodyHasEng: t.includes('eng'),
  };
}`);
assert(detailView.showsEngAdmins, `dept detail (eng) lists its org_admin(s) by name (hasEng=${detailView.bodyHasEng})`);
assert(detailView.showsUsersLabel, "dept detail renders 部门管理员 + 用户 sections");

// ─── CREATE GATING (M3 final fix) ────────────────────────────────────────
// Force the org-list request to fail (CDP Fetch → 500), assert the create
// form shows the error state AND the create button is disabled (no fallback
// to default-org). Then restore the org-list + reload: assert the select is
// present but NO org is selected → create still disabled (selection-required);
// pick an org → create enabled.
log("\n=== CREATE GATING (org-list failure → disabled) ===");

// Intercept ONLY the org LIST endpoint (*/api/admin/orgs with no trailing
// path), NOT /api/admin/orgs/:id/detail. CDP urlPattern is a glob; ending the
// pattern at /api/admin/orgs matches the list URL but not the detail URL.
const ORG_LIST_PATTERN = "*/api/admin/orgs";

async function interceptOrgListFail(ws) {
  // Attach the requestPaused listener before enabling Fetch so we don't miss
  // the first paused request.
  const handler = (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.method === "Fetch.requestPaused" && m.params) {
      const url = m.params.request.url;
      // fulfill the list endpoint with 500; pass through anything else.
      if (url.endsWith("/api/admin/orgs")) {
        cdp(ws, "Fetch.fulfillRequest", {
          requestId: m.params.requestId,
          responseCode: 500,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify({ error: "forced failure" })).toString("base64"),
        }).catch(() => {});
      } else {
        cdp(ws, "Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {});
      }
    }
  };
  ws.on("message", handler);
  ws.__orgIntercept = handler;
  await cdp(ws, "Fetch.enable", { patterns: [{ urlPattern: ORG_LIST_PATTERN, requestStage: "Request" }] });
}
async function clearOrgListIntercept(ws) {
  await cdp(ws, "Fetch.disable");
  if (ws.__orgIntercept) { ws.off("message", ws.__orgIntercept); ws.__orgIntercept = null; }
}

// (1) Force org-list failure → error state + disabled create button.
await interceptOrgListFail(ws);
await loadAs(ws, adminTok, adminUser, "/admin/users");
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);
await evalInPage(ws, `() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('创建用户')); b && b.click(); }`);
await sleep(600);
const failState = await evalInPage(ws, `() => {
  const form = document.querySelector('form');
  const text = form ? form.textContent : '';
  const submit = form && [...form.querySelectorAll('button[type=submit]')][0];
  return {
    showsError: text.includes('部门列表加载失败'),
    submitDisabled: !!(submit && submit.disabled),
  };
}`);
assert(failState.showsError, "org-list failure → create form shows 部门列表加载失败 error state");
assert(failState.submitDisabled, "org-list failure → create button disabled (no default-org fallback)");
await clearOrgListIntercept(ws);

// (2) Restore org-list → select present but unselected → create disabled;
//     pick an org → create enabled.
log("\n=== CREATE GATING (restored → selection-required) ===");
await loadAs(ws, adminTok, adminUser, "/admin/users");
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);
await evalInPage(ws, `() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('创建用户')); b && b.click(); }`);
await sleep(600);
const restoredState = await evalInPage(ws, `() => {
  const form = document.querySelector('form');
  const selects = form ? [...form.querySelectorAll('select')] : [];
  // org select = the one whose options include an org id
  const orgSel = selects.find(s => [...s.options].some(o => /eng|default-org/.test(o.textContent)));
  const submit = form && [...form.querySelectorAll('button[type=submit]')][0];
  return {
    orgSelectPresent: !!orgSel,
    orgSelectValue: orgSel ? orgSel.value : null,
    submitDisabledBefore: !!(submit && submit.disabled),
  };
}`);
assert(restoredState.orgSelectPresent, "restored → org <select> present again");
assert(restoredState.orgSelectValue === "" || restoredState.orgSelectValue === null,
  `restored → no org pre-selected (value=${JSON.stringify(restoredState.orgSelectValue)})`);
assert(restoredState.submitDisabledBefore, "restored, unselected → create button disabled (selection-required)");
// pick an org → create enabled
await evalInPage(ws, `() => {
  const form = document.querySelector('form');
  const selects = [...form.querySelectorAll('select')];
  const orgSel = selects.find(s => [...s.options].some(o => /eng/.test(o.textContent)));
  if (orgSel) { orgSel.value = [...orgSel.options].find(o => /eng/.test(o.textContent)).value; orgSel.dispatchEvent(new Event('change', {bubbles:true})); }
}`);
await sleep(300);
const afterPick = await evalInPage(ws, `() => {
  const form = document.querySelector('form');
  const submit = form && [...form.querySelectorAll('button[type=submit]')][0];
  return { submitDisabled: !!(submit && submit.disabled), orgPicked: !!form.querySelector('select') };
}`);
assert(!afterPick.submitDisabled, "after picking an org → create button enabled");

// ─── ORG_ADMIN VIEW ───────────────────────────────────────────────────────
log("\n=== ORG_ADMIN VIEW (own-dept) ===");
await loadAs(ws, engTok, engUser, "/admin/users");
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);
const oaView = await evalInPage(ws, `() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const find = (name) => rows.find(r => r.textContent.includes(name));
  const engOa2 = find('${ENG_OA2}');
  const engU1 = find('${ENG_U1}');
  const self = rows.find(r => r.textContent.includes('(you)'));
  // sidebar visible links
  const sidebar = [...document.querySelectorAll('nav a')].map(a => a.getAttribute('href'));
  return {
    sidebarLinks: sidebar,
    // privileged (org_admin) row must be read-only: NO role <select>, badge present, NO action buttons
    engOa2RoleIsBadge: !!(engOa2 && /org_admin/.test(engOa2.textContent) && engOa2.textContent.includes('只读') && !engOa2.querySelector('select')),
    engOa2NoReset: !(engOa2 && [...engOa2.querySelectorAll('button')].some(b => b.textContent.includes('重置密码'))),
    engOa2NoDisable: !(engOa2 && [...engOa2.querySelectorAll('button')].some(b => b.textContent.includes('停用') || b.textContent.includes('恢复'))),
    engOa2NoDelete: !(engOa2 && [...engOa2.querySelectorAll('button')].some(b => b.textContent.includes('删除'))),
    engOa2NoMigrate: !(engOa2 && [...engOa2.querySelectorAll('button')].some(b => b.textContent.includes('迁移'))),
    // plain user row keeps full controls
    engU1HasReset: !!(engU1 && [...engU1.querySelectorAll('button')].some(b => b.textContent.includes('重置密码'))),
    engU1HasDisable: !!(engU1 && [...engU1.querySelectorAll('button')].some(b => b.textContent.includes('停用') || b.textContent.includes('恢复'))),
    engU1HasDelete: !!(engU1 && [...engU1.querySelectorAll('button')].some(b => b.textContent.includes('删除'))),
    engU1RoleIsSelect: !!(engU1 && engU1.querySelector('select')),
    // org_admin has NO migrate button anywhere (admin-only)
    noMigrateAnywhere: ![...document.querySelectorAll('table tbody tr button')].some(b => b.textContent.includes('迁移')),
  };
}`);
assert(oaView.engOa2RoleIsBadge, "org_admin: privileged (org_admin) row shows read-only badge (no role <select>)");
assert(oaView.engOa2NoReset && oaView.engOa2NoDisable && oaView.engOa2NoDelete && oaView.engOa2NoMigrate,
  "org_admin: privileged row has NO reset/disable/delete/migrate controls");
assert(oaView.engU1HasReset && oaView.engU1HasDisable && oaView.engU1HasDelete, "org_admin: plain-user row keeps reset/disable/delete controls");
assert(oaView.engU1RoleIsSelect, "org_admin: plain-user row has a role <select>");
assert(oaView.noMigrateAnywhere, "org_admin: no 迁移 button anywhere (admin-only)");
assert(oaView.sidebarLinks.includes("/admin/users") && oaView.sidebarLinks.includes("/admin/orgs"),
  "org_admin sidebar shows Users + Orgs");
assert(!oaView.sidebarLinks.includes("/admin/skills") && !oaView.sidebarLinks.includes("/admin/mcp"),
  "org_admin sidebar does NOT show admin-only links (skills/mcp)");

// org_admin cross-dept detail is denied server-side; the Orgs page renders
// only the own dept (single row). Verify own-dept overview.
await evalInPage(ws, `() => { location.href = '/admin/orgs'; }`);
await sleep(600);
await waitForSelector(ws, `() => document.querySelectorAll('table tbody tr').length > 0`);
const ownOrgView = await evalInPage(ws, `() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  return { count: rows.length, onlyEng: rows.length === 1 && rows[0].textContent.includes('eng') };
}`);
assert(ownOrgView.onlyEng, `org_admin Orgs overview shows exactly 1 row = own dept eng (got ${ownOrgView.count})`);

// ─── cleanup ──────────────────────────────────────────────────────────────
log("\n=== DONE ===");
if (failures.length === 0) log("ALL CDP ASSERTIONS PASSED ✓");
else { log(`FAILURES (${failures.length}):`); failures.forEach((f) => log("  -", f)); }

ws.close();
try { chrome.kill("SIGTERM"); } catch {}
try { vite.kill("SIGTERM"); } catch {}
try { backend.kill("SIGTERM"); } catch {}
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 1000);
