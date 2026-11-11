#!/usr/bin/env node
/**
 * m3b-browser-check.mjs — Octop absorption M3b browser acceptance for the
 * SkillsPage local ZIP import/review UI (evt_20261021034505 §Verification).
 *
 * Drives a REAL Chromium against the production-served dist bundle:
 *   admin: import panel → upload valid skill ZIP (with scripts/) →
 *   quarantined manifest card (enabled=false, script warning, hash, license,
 *   file list) → metadata columns (zip/snapshot/importedAt) + ⚠️脚本 marker →
 *   explicit enable (confirm dialog repeats script warning + 启用 ≠ 授权) →
 *   disable; bounded error toasts (invalid slug, duplicate, registry_invalid);
 *   ZIP payload text never rendered in the DOM;
 *   org_admin: import controls hidden + direct POST still 403 (backend
 *   authoritative).
 *
 * The backend runs with cwd = fresh temp dir so the import writes (skills.json
 * + skills/quarantine) never touch the checkout. Run:
 *   NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m3b-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = 3905;
const DB_PATH = "/tmp/m3b-browser.db";
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd(); // worktree root (dist + node_modules live here)
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "m3b-browser-cwd-"));
const ADMIN_PASS = "m3b-admin-1";
const ORG_ADMIN = "m3b-orgadmin";
const ORG_ADMIN_PASS = "m3b-orgadmin-1";
const SLUG = "m3b-demo";
const SECRET_MARKER = "M3B-SECRET-PAYLOAD-9d2f7a";
const SHOT_DIR = path.join(WT, "docs/06-deployment/evidence/m3b-browser");
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  results.push(line);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Build a valid skill ZIP (SKILL.md + scripts/ + references/ + LICENSE)
const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "m3b-pkg-"));
fs.writeFileSync(path.join(pkgDir, "SKILL.md"), `---
name: ${SLUG}
---

# M3b demo skill

${SECRET_MARKER} — must never be rendered in the admin DOM.
`);
fs.mkdirSync(path.join(pkgDir, "scripts"));
fs.writeFileSync(path.join(pkgDir, "scripts", "run.sh"), "#!/bin/sh\necho m3b\n");
fs.mkdirSync(path.join(pkgDir, "references"));
fs.writeFileSync(path.join(pkgDir, "references", "api.md"), "m3b reference\n");
fs.writeFileSync(path.join(pkgDir, "LICENSE"), "MIT m3b demo\n");
const zipPath = path.join(SCRATCH, `${SLUG}.zip`);
execFileSync("zip", ["-r", "-q", "-X", zipPath, "."], { cwd: pkgDir });

// ─── 2. Real backend (local runtime, temp DB, isolated cwd) ──────────
// Refuse to run against a stale squatter on the port BEFORE spawning —
// otherwise our own server dies with EADDRINUSE and every request would
// silently hit the WRONG backend.
try {
  const probe = await fetch(`${BASE}/api/health`);
  console.error(`FATAL: port ${PORT} already serving (HTTP ${probe.status}) — kill the squatter first`);
  process.exit(1);
} catch (e) {
  if (!/fetch failed|ECONNREFUSED/.test(String(e?.message ?? e))) throw e;
}

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
// Worktrees share the main checkout's node_modules (resolution walks up);
// pick whichever tsx bin is reachable.
const TSX = [
  path.join(WT, "node_modules/.bin/tsx"),
  path.resolve(WT, "../../../node_modules/.bin/tsx"),
].find((p) => fs.existsSync(p));
if (!TSX) throw new Error("tsx bin not found (worktree nor parent checkout)");
const server = spawn(TSX, [path.join(WT, "server/server.ts")], {
  cwd: SCRATCH,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    RUNTIME_MODE: "local",
    ALLOW_DEV_JWT_SECRET: "1",
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
  if (!ready && server.exitCode !== null) break; // our server died (e.g. EADDRINUSE)
}
ok("backend ready (port 3905, temp DB, isolated cwd)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// Pre-boot: resolve fresh-DB admin password change + create org_admin (API).
let adminToken = "";
try {
  const first = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  if (first?.mustChangePassword && first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
  let login = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: ADMIN_PASS }) })).json();
  if (!login?.token) login = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  adminToken = login?.token ?? "";
  // Create org_admin + rotate their first-login password via API (otherwise
  // the browser login lands on the must-change-password wall).
  await fetch(`${BASE}/api/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username: ORG_ADMIN, password: ORG_ADMIN_PASS, role: "org_admin" }),
  });
  const oaFirst = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: ORG_ADMIN, password: ORG_ADMIN_PASS }) })).json();
  if (oaFirst?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${oaFirst.token}` }, body: JSON.stringify({ oldPassword: ORG_ADMIN_PASS, newPassword: ORG_ADMIN_PASS + "x" }) });
  }
} catch (e) {
  console.error("pre-boot setup failed:", e);
}

async function login(page, user, pwd) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="请输入用户名"]', user);
  await page.fill('input[placeholder="请输入密码"]', pwd);
  await page.click('button[type="submit"]');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if ((await page.locator("body").innerText()).length > 50) return true;
  }
  return false;
}

async function toastText(page, withinMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < withinMs) {
    const t = (await page.locator("[data-sonner-toast]").allInnerTexts()).join("\n");
    if (t.trim()) return t;
    await sleep(300);
  }
  return "";
}

// Wait for a toast CONTAINING substr — prior success toasts linger a few
// seconds, so matching the specific error text avoids racing them.
async function toastContaining(page, substr, withinMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < withinMs) {
    const t = (await page.locator("[data-sonner-toast]").allInnerTexts()).join("\n");
    if (t.includes(substr)) return t;
    await sleep(300);
  }
  return "";
}

let exitCode = 0;
try {
  await (async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const bodyText = () => page.locator("body").innerText();
  ok("admin login lands in app", await login(page, "admin", ADMIN_PASS), page.url());

  // ── 1. Import panel + upload → quarantined manifest ─────────────
  await page.goto(`${BASE}/admin/skills`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  ok("import panel visible for admin", await page.locator('[data-testid="skill-import-panel"]').isVisible());
  await page.setInputFiles('[data-testid="skill-import-file"]', zipPath);
  await page.fill('[data-testid="skill-import-slug"]', SLUG);
  await page.fill('[data-testid="skill-import-version"]', "2.0.0");
  await page.screenshot({ path: `${SHOT_DIR}/01-import-form.png`, fullPage: true });
  await page.click('[data-testid="skill-import-submit"]');
  await page.waitForTimeout(2000);

  ok("manifest card rendered", await page.locator('[data-testid="skill-import-manifest"]').isVisible());
  ok("quarantine badge: enabled=false, 装了 ≠ 可用",
    (await page.locator('[data-testid="manifest-quarantine"]').innerText()).includes("enabled=false"));
  ok("manifest sourceKind = zip", (await page.locator('[data-testid="manifest-source-kind"]').innerText()) === "zip");
  const manifestText = await page.locator('[data-testid="skill-import-manifest"]').innerText();
  ok("manifest: version 2.0.0 + license filename + description",
    manifestText.includes("2.0.0") && manifestText.includes("LICENSE") && manifestText.includes("M3b demo skill"));
  ok("manifest: deterministic content hash shown", /sha256:[0-9a-f]{64}/.test(manifestText));
  ok("manifest: file count = 4", (await page.locator('[data-testid="manifest-file-count"]').innerText()).startsWith("4"));
  // <details> body is hidden → innerText skips it; textContent covers it.
  const fileList = (await page.locator('[data-testid="manifest-file-list"]').textContent()) ?? "";
  ok("manifest: file list shows SKILL.md + scripts/run.sh (≤100 cap)",
    fileList.includes("SKILL.md") && fileList.includes("scripts/run.sh"));
  ok("manifest: script warning visible", await page.locator('[data-testid="manifest-script-warning"]').isVisible());
  ok("manifest: importedAt timestamp shown", /20\d\d-\d\d-\d\dT/.test(manifestText));
  await page.screenshot({ path: `${SHOT_DIR}/02-manifest.png`, fullPage: true });

  // ── 2. Skills table metadata ────────────────────────────────────
  const row = page.locator("tr", { hasText: SLUG });
  await row.waitFor({ state: "visible", timeout: 8000 });
  let rowText = await row.innerText();
  ok("table row: 来源 zip + snapshot policy", rowText.includes("zip") && rowText.includes("snapshot"));
  ok("table row: importedAt date + hash prefix", /20\d\d-\d\d-\d\d/.test(rowText) && / · [0-9a-f]{12}…/.test(rowText));
  ok("table row: ⚠️脚本 marker visible before enable", rowText.includes("脚本"));
  ok("table row: quarantined import still disabled", rowText.includes("禁用"));
  ok("ZIP payload text never rendered in DOM", !(await bodyText()).includes(SECRET_MARKER));
  await page.screenshot({ path: `${SHOT_DIR}/03-table-metadata.png`, fullPage: true });

  // Fix round: marker is SERVER-authoritative — wiping all non-auth localStorage
  // and reloading must NOT remove it, and a fresh second admin context (no
  // localStorage at all) must still see it.
  await page.evaluate(() => {
    const t = localStorage.getItem("token");
    const u = localStorage.getItem("user");
    localStorage.clear();
    localStorage.setItem("token", t);
    localStorage.setItem("user", u);
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  ok("clearing non-auth localStorage keeps ⚠️脚本 marker (server flag)", (await row.innerText()).includes("脚本"));

  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page3 = await ctx3.newPage();
  ok("second admin session login", await login(page3, "admin", ADMIN_PASS));
  await page3.goto(`${BASE}/admin/skills`, { waitUntil: "networkidle" });
  await page3.waitForTimeout(1500);
  ok("fresh context (no localStorage) still sees ⚠️脚本 marker",
    (await page3.locator("tr", { hasText: SLUG }).innerText()).includes("脚本"));
  await ctx3.close();

  // ── 3. Explicit enable: confirmation repeats script warning + ≠授权 ──
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  await row.getByRole("button", { name: "启用" }).click();
  await page.waitForTimeout(1500);
  ok("enable confirm repeats script warning", dialogs.some((m) => m.includes("scripts/")));
  ok("enable confirm states 启用 ≠ 授权 (entitlement/activation guards)", dialogs.some((m) => m.includes("启用 ≠ 授权") && m.includes("entitlement")));
  ok("after confirm: row shows 启用", (await row.innerText()).includes("启用"));
  await page.screenshot({ path: `${SHOT_DIR}/04-enabled.png`, fullPage: true });

  // ── 4. Disable (no confirmation needed) ─────────────────────────
  await row.getByRole("button", { name: "禁用" }).click();
  await page.waitForTimeout(1500);
  ok("disable restores 禁用", (await row.innerText()).includes("禁用"));

  // ── 4b. ZIP WITHOUT scripts → hasScripts:false, no marker, no warning ──
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "m3b-plain-"));
  fs.writeFileSync(path.join(plainDir, "SKILL.md"), `---
name: m3b-plain
---

# Plain skill without scripts
`);
  const plainZip = path.join(SCRATCH, "m3b-plain.zip");
  execFileSync("zip", ["-r", "-q", "-X", plainZip, "."], { cwd: plainDir });
  await page.setInputFiles('[data-testid="skill-import-file"]', plainZip);
  await page.fill('[data-testid="skill-import-slug"]', "m3b-plain");
  await page.fill('[data-testid="skill-import-version"]', "");
  await page.click('[data-testid="skill-import-submit"]');
  await page.waitForTimeout(2000);
  const plainRow = page.locator("tr", { hasText: "m3b-plain" });
  const plainRowText = await plainRow.innerText();
  ok("no-scripts import: row shows NO ⚠️脚本 marker", !plainRowText.includes("脚本"));
  ok("no-scripts import: manifest has no script warning", (await page.locator('[data-testid="manifest-script-warning"]').count()) === 0);

  // ── 5. Bounded error mapping (bad slug, duplicate, registry_invalid) ──
  await page.fill('[data-testid="skill-import-slug"]', "Bad Slug!");
  await page.click('[data-testid="skill-import-submit"]');
  ok("invalid slug → bounded toast", (await toastContaining(page, "slug 不合法")).includes("slug 不合法"));

  await page.fill('[data-testid="skill-import-slug"]', SLUG);
  await page.click('[data-testid="skill-import-submit"]');
  ok("duplicate slug → bounded toast (409 mapped)", (await toastContaining(page, "已注册或 quarantine 目录已占用")).length > 0);

  const registryPath = path.join(SCRATCH, "data", "skills.json");
  const backup = fs.readFileSync(registryPath, "utf8");
  fs.writeFileSync(registryPath, "{ broken json !!");
  await page.fill('[data-testid="skill-import-slug"]', "m3b-registry-test");
  await page.click('[data-testid="skill-import-submit"]');
  ok("corrupted registry → registry_invalid toast, file untouched",
    (await toastContaining(page, "data/skills.json 损坏")).length > 0 && fs.readFileSync(registryPath, "utf8") === "{ broken json !!");
  fs.writeFileSync(registryPath, backup);

  // ── 6. org_admin: import controls hidden + backend 403 authoritative ──
  // org_admin's list is entitlement-filtered (deny-default): grant the org an
  // allow first so the read-only view actually shows the imported skill.
  await fetch(`${BASE}/api/admin/capabilities/${SLUG}/entitlements`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ entries: [{ scopeType: "org", scopeId: "default-org", effect: "allow" }] }),
  });
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  ok("org_admin login lands in app", await login(page2, ORG_ADMIN, ORG_ADMIN_PASS + "x"), page2.url());
  await page2.goto(`${BASE}/admin/skills`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(1200);
  ok("org_admin: import panel hidden", (await page2.locator('[data-testid="skill-import-panel"]').count()) === 0);
  ok("org_admin: read-only note shown", (await page2.locator("body").innerText()).includes("只读"));
  ok("org_admin read-only list also receives server ⚠️脚本 flag",
    (await page2.locator("tr", { hasText: SLUG }).innerText()).includes("脚本"));
  const oaToken = await page2.evaluate(() => localStorage.getItem("token"));
  const denied = await page2.request.post(`${BASE}/api/admin/skills/import-zip?slug=evil-skill`, {
    headers: { authorization: `Bearer ${oaToken}`, "content-type": "application/zip" },
    data: fs.readFileSync(zipPath),
  });
  ok("org_admin direct POST import → 403 (backend authoritative)", denied.status() === 403);
  ok("org_admin denied import left no quarantine dir", !fs.existsSync(path.join(SCRATCH, "skills/quarantine/evil-skill")));
  await page2.screenshot({ path: `${SHOT_DIR}/05-orgadmin-readonly.png`, fullPage: true });
  await ctx2.close();

  await browser.close();
  })();
} catch (e) {
  console.error("BROWSER CHECK FAILED:", e);
  console.error("server log tail:\n" + serverLog.slice(-30).join(""));
  exitCode = 1;
} finally {
  try { server.kill("SIGKILL"); } catch {}
  await sleep(500);
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n=== M3b browser check: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync(path.join(SHOT_DIR, "results.txt"), results.join("\n") + "\n");
if (fail > 0 || exitCode !== 0) process.exit(1);
process.exit(0); // playwright/server handles can linger — exit explicitly
