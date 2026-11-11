#!/usr/bin/env node
/**
 * spa-fallback-browser-check.mjs — browser acceptance for the integrated-
 * walkthrough P2 fix (evt_20261023050949): late SPA catch-all.
 * Covers, against the REAL server + built dist bundle in an isolated scratch
 * cwd/DB:
 *   1. unknown browser route serves the SPA shell and the client router
 *      redirects to "/" (login renders, no raw "Cannot GET");
 *   2. /experts hard reload while logged in renders the experts directory;
 *   3. /my-skills hard reload while logged in renders the My Skills page;
 *   4. unknown /api route → 404 with non-HTML body (NOT index.html);
 *   5. missing static asset /assets/missing.js → 404 non-HTML;
 *   6. unknown route while logged in also lands on the workbench.
 * Run (from worktree root): npm run build && \
 *   NODE_PATH=/tmp/m1d-pw/node_modules npx tsx scripts/spa-fallback-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = 3933;
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd(); // worktree root
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "spa-fb-cwd-"));

const ADMIN_PASS = "spafb-admin-1";
const USER = "spafb-user";
const USER_PASS = "spafb-user-1";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  results.push(line);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Isolated scratch cwd (seeded resource pool, controlled state) ───
for (const dir of ["data", "skills"]) {
  const src = path.join(WT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(SCRATCH, dir), { recursive: true });
}
const DB_PATH = path.join(SCRATCH, "data", "eaos.db");
// Fresh DB: the seeded eaos.db carries the dev admin's real password;
// a clean boot recreates the schema with the default admin/admin123.
for (const f of ["eaos.db", "eaos.db-wal", "eaos.db-shm"]) { try { fs.unlinkSync(path.join(SCRATCH, "data", f)); } catch {} }
fs.writeFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), JSON.stringify({}, null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/skills.json"), JSON.stringify([], null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/entitlements.json"), JSON.stringify({ version: 1, entries: [] }, null, 2));

// ─── 2. Real backend (worktree code, scratch cwd) ──────────────────────
try {
  const probe = await fetch(`${BASE}/api/health`);
  console.error(`FATAL: port ${PORT} already serving (HTTP ${probe.status})`);
  process.exit(1);
} catch (e) {
  if (!/fetch failed|ECONNREFUSED/.test(String(e?.message ?? e))) throw e;
}
// Worktrees have no local node_modules; binaries resolve from the main
// checkout (parent traversal) — spawn needs the absolute path.
const TSX = "/Users/jameslian/Work/projects/simple-chatapp/node_modules/.bin/tsx";
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
ok("backend ready (port 3933, scratch cwd, temp DB)", ready);
if (!ready) {
  console.error("server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// ─── 3. Actors ──────────────────────────────────────────────────────────
async function loginApi(username, pwd) {
  return (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: pwd }) })).json());
}
{
  const first = await loginApi("admin", "admin123");
  if (first?.mustChangePassword && first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
  const adminToken = (await loginApi("admin", ADMIN_PASS))?.token ?? "";
  await fetch(`${BASE}/api/admin/users`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ username: USER, password: USER_PASS, role: "user" }) });
  // activate: change password once so login is stable
  const u1 = await loginApi(USER, USER_PASS);
  if (u1?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${u1.token}` }, body: JSON.stringify({ oldPassword: USER_PASS, newPassword: USER_PASS + "x" }) });
  }
}
const USER_PASS_FINAL = USER_PASS + "x";

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="请输入用户名"]', USER);
  await page.fill('input[placeholder="请输入密码"]', USER_PASS_FINAL);
  await page.click('button[type="submit"]');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if ((await page.locator("body").innerText()).includes("创建 Agent")) return true;
  }
  return false;
}

let exitCode = 0;
try {
  await (async () => {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // 1. Unknown route, logged out → SPA shell + client redirect to login
    await page.goto(`${BASE}/definitely-not-a-route`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const bodyText = await page.locator("body").innerText();
    ok("unknown route: no raw 'Cannot GET' text", !bodyText.includes("Cannot GET"), bodyText.slice(0, 60).replace(/\n/g, " "));
    ok("unknown route: SPA shell loaded (login form renders)", (await page.locator('input[placeholder="请输入用户名"]').count()) === 1);

    // 2-3. Login, then hard reload SPA deep links
    ok("user login", await login(page));

    await page.goto(`${BASE}/experts`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const expertsText = await page.locator("body").innerText();
    ok("/experts hard reload: experts directory renders", expertsText.includes("我的专家") || expertsText.includes("专家"), expertsText.slice(0, 60).replace(/\n/g, " "));

    await page.goto(`${BASE}/my-skills`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const skillsText = await page.locator("body").innerText();
    ok("/my-skills hard reload: My Skills page renders", skillsText.includes("我的技能") || skillsText.includes("技能"), skillsText.slice(0, 60).replace(/\n/g, " "));

    // 6. Unknown route while logged in → redirected to workbench
    await page.goto(`${BASE}/definitely-not-a-route`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const wbText = await page.locator("body").innerText();
    ok("unknown route (logged in): redirected to the workbench", wbText.includes("创建 Agent") && !wbText.includes("Cannot GET"));

    await ctx.close();
    await browser.close();

    // 4-5. Non-HTML namespaces keep 404 (raw fetch, no browser needed)
    const api = await fetch(`${BASE}/api/definitely-not-a-route`);
    const apiBody = await api.text();
    ok("unknown /api route: 404, NOT the SPA shell", api.status === 404 && !apiBody.includes("<!doctype html>"), `status=${api.status} type=${api.headers.get("content-type")}`);

    const asset = await fetch(`${BASE}/assets/missing.js`);
    const assetBody = await asset.text();
    ok("missing static asset: 404, NOT the SPA shell", asset.status === 404 && !assetBody.includes("<!doctype html>"), `status=${asset.status}`);
  })();
} catch (e) {
  console.error("browser check crashed:", e);
  fail++;
  exitCode = 1;
} finally {
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
  try { server.kill("SIGKILL"); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) exitCode = 1;
fs.writeFileSync(path.join(WT, "docs/06-deployment/evidence/spa-fallback/browser-check-results.txt"), results.join("\n") + `\n\n${pass} passed, ${fail} failed.\n`);
process.exit(exitCode);
