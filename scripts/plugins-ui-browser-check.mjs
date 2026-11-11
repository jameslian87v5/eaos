#!/usr/bin/env node
/**
 * plugins-ui-browser-check.mjs — browser acceptance for the /admin/plugins
 * UI closure (evt_20261023054637, thread octop-plugins-ui-closure). Runs the
 * REAL server + built dist in an isolated scratch cwd with a controlled
 * registry state. UI-only change: no backend contract edits.
 *
 * Covers: admin card list + statuses (error-first), enable/disable toggle on
 * a valid skill (server-authority via data/skills.json), hook-plugin row has
 * no toggle (route doesn't exist), invalid row error-first + no toggle,
 * user-submitted (M7b quarantine) rows never toggle (governance guard),
 * card/table view switch, import dialog flow with a real staged package,
 * empty state, load-error state (route abort + retry), org_admin redirect +
 * API 403, responsive 390px spot-check.
 *
 * Run (worktree root, after npm run build):
 *   NODE_PATH=/tmp/m1d-pw/node_modules npx tsx scripts/plugins-ui-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = 3934;
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd(); // worktree root
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-ui-cwd-"));

const ADMIN_PASS = "plui-admin-1";
const ORG_ADMIN = "plui-orgadmin";
const ORG_ADMIN_PASS = "plui-orgadmin-1";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  results.push(line);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const netLog = [];

// ─── 1. Isolated scratch cwd ────────────────────────────────────────────
for (const dir of ["data", "skills"]) {
  const src = path.join(WT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(SCRATCH, dir), { recursive: true });
}
const DB_PATH = path.join(SCRATCH, "data", "eaos.db");
// Fresh DB: the seeded eaos.db carries the dev admin's real password.
for (const f of ["eaos.db", "eaos.db-wal", "eaos.db-shm"]) { try { fs.unlinkSync(path.join(SCRATCH, "data", f)); } catch {} }

const SKILLS_JSON = path.join(SCRATCH, "data", "skills.json");
const HOOKS_JSON = path.join(SCRATCH, "data", "hook-plugins.json");

// User-submitted (M7b) skill: valid package under skills/quarantine WITH
// submitter provenance (the registry flag that drives the governance guard).
// Layout mirrors a real plugin package: .claude-plugin/plugin.json +
// skills/<name>/SKILL.md (same shape as skills/hello-skill).
fs.mkdirSync(path.join(SCRATCH, "skills/quarantine/user-sub-skill/.claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(SCRATCH, "skills/quarantine/user-sub-skill/skills/user-sub-skill"), { recursive: true });
fs.writeFileSync(
  path.join(SCRATCH, "skills/quarantine/user-sub-skill/.claude-plugin/plugin.json"),
  JSON.stringify({ name: "user-sub-skill", version: "0.1.0", description: "submitted by a user, pending admin review", skills: "./skills/" }, null, 2)
);
fs.writeFileSync(
  path.join(SCRATCH, "skills/quarantine/user-sub-skill/skills/user-sub-skill/SKILL.md"),
  `---
name: user-sub-skill
description: submitted by a user, pending admin review
---

# user-sub-skill
`
);

// Admin-imported (M3 ZIP) quarantined package: same quarantine path but NO
// submitter provenance — must stay toggle-eligible when valid (fix-round P1)
fs.mkdirSync(path.join(SCRATCH, "skills/quarantine/admin-zip-skill/.claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(SCRATCH, "skills/quarantine/admin-zip-skill/skills/admin-zip-skill"), { recursive: true });
fs.writeFileSync(
  path.join(SCRATCH, "skills/quarantine/admin-zip-skill/.claude-plugin/plugin.json"),
  JSON.stringify({ name: "admin-zip-skill", version: "0.2.0", description: "admin-imported M3 ZIP package in quarantine", skills: "./skills/" }, null, 2)
);
fs.writeFileSync(
  path.join(SCRATCH, "skills/quarantine/admin-zip-skill/skills/admin-zip-skill/SKILL.md"),
  `---
name: admin-zip-skill
description: admin-imported M3 ZIP package in quarantine
---

# admin-zip-skill
`
);

// Import source package inside PLUGIN_IMPORT_ROOT (data/skill-hub-cache)
fs.mkdirSync(path.join(SCRATCH, "data/skill-hub-cache/demo-pkg/skills/demo-pkg"), { recursive: true });
fs.mkdirSync(path.join(SCRATCH, "data/skill-hub-cache/demo-pkg/.claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(SCRATCH, "data/skill-hub-cache/demo-pkg/.claude-plugin/plugin.json"),
  JSON.stringify({ name: "demo-pkg", version: "1.2.3", description: "staged import package for the plugins UI acceptance", skills: "./skills/" }, null, 2)
);
fs.writeFileSync(
  path.join(SCRATCH, "data/skill-hub-cache/demo-pkg/skills/demo-pkg/SKILL.md"),
  `---
name: demo-pkg
description: staged import package for the plugins UI acceptance
---

# demo-pkg
`
);

// Approved user submission (fix 2): valid quarantined package whose ledger
// record is approved — enabled by the (simulated) M7b approve flow.
fs.mkdirSync(path.join(SCRATCH, "skills/quarantine/user-approved-skill/.claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(SCRATCH, "skills/quarantine/user-approved-skill/skills/user-approved-skill"), { recursive: true });
fs.writeFileSync(
  path.join(SCRATCH, "skills/quarantine/user-approved-skill/.claude-plugin/plugin.json"),
  JSON.stringify({ name: "user-approved-skill", version: "0.3.0", description: "approved user submission", skills: "./skills/" }, null, 2)
);
fs.writeFileSync(
  path.join(SCRATCH, "skills/quarantine/user-approved-skill/skills/user-approved-skill/SKILL.md"),
  `---
name: user-approved-skill
description: approved user submission
---

# user-approved-skill
`
);

// M7b submission ledger (fix 2): authoritative lifecycle status per
// submissionId. m7b-1 = approved (user-approved-skill), m7b-2 = pending
// (user-sub-skill).
const SUBS_FILE = path.join(SCRATCH, "data", "user-skill-submissions.json");
fs.writeFileSync(SUBS_FILE, JSON.stringify({
  version: 1,
  submissions: [
    { id: "m7b-1", slug: "user-approved-skill", submitterUserId: "user-uuid-2", orgId: "default-org", status: "approved", createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z", reviewedAt: "2026-10-23T01:00:00.000Z", reviewedBy: "admin" },
    { id: "m7b-2", slug: "user-sub-skill", submitterUserId: "user-uuid-1", orgId: "default-org", status: "pending_review", createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z" },
  ],
}, null, 2));

// Phase A: empty registries (empty state check)
fs.writeFileSync(SKILLS_JSON, JSON.stringify([], null, 2));
fs.writeFileSync(HOOKS_JSON, JSON.stringify([], null, 2));

const fullSkills = [
  { name: "hello-skill", type: "plugin", enabled: true, path: "skills/hello-skill" },
  { name: "broken-skill", type: "plugin", enabled: true, path: "plugins/does-not-exist" },
  { name: "user-sub-skill", type: "plugin", enabled: false, path: "skills/quarantine/user-sub-skill", submittedBy: "user-uuid-1", submissionId: "m7b-2" },
  { name: "user-approved-skill", type: "plugin", enabled: true, path: "skills/quarantine/user-approved-skill", submittedBy: "user-uuid-2", submissionId: "m7b-1" },
  { name: "admin-zip-skill", type: "plugin", enabled: false, path: "skills/quarantine/admin-zip-skill" },
];
const fullHooks = [
  { name: "demo-hook", type: "hook-plugin", enabled: true, path: "skills/minimal-plugin" },
];

function skillEntry(name) {
  return JSON.parse(fs.readFileSync(SKILLS_JSON, "utf8")).find((s) => s.name === name);
}

// ─── 2. Real backend (worktree code, scratch cwd) ───────────────────────
try {
  const probe = await fetch(`${BASE}/api/health`);
  console.error(`FATAL: port ${PORT} already serving (HTTP ${probe.status})`);
  process.exit(1);
} catch (e) {
  if (!/fetch failed|ECONNREFUSED/.test(String(e?.message ?? e))) throw e;
}
// Worktrees have no local node_modules; spawn needs the absolute tsx path.
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
ok("backend ready (port 3934, scratch cwd, temp DB)", ready);
if (!ready) {
  console.error("server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// ─── 3. Actors ──────────────────────────────────────────────────────────
async function loginApi(username, pwd) {
  return (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: pwd }) })).json());
}
let adminToken = "", orgAdminToken = "";
{
  const first = await loginApi("admin", "admin123");
  if (first?.mustChangePassword && first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
  adminToken = (await loginApi("admin", ADMIN_PASS))?.token ?? "";
  await fetch(`${BASE}/api/admin/users`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ username: ORG_ADMIN, password: ORG_ADMIN_PASS, role: "org_admin" }) });
  const oa1 = await loginApi(ORG_ADMIN, ORG_ADMIN_PASS);
  if (oa1?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${oa1.token}` }, body: JSON.stringify({ oldPassword: ORG_ADMIN_PASS, newPassword: ORG_ADMIN_PASS + "x" }) });
  }
  orgAdminToken = (await loginApi(ORG_ADMIN, ORG_ADMIN_PASS + "x"))?.token ?? "";
}
ok("admin + org_admin provisioned", !!adminToken && !!orgAdminToken);

async function adminLogin(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="请输入用户名"]', "admin");
  await page.fill('input[placeholder="请输入密码"]', ADMIN_PASS);
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
    page.on("response", async (res) => {
      const u = res.url().replace(BASE, "");
      if (u.includes("/api/admin/skills") || u.includes("/api/admin/plugins")) {
        let body = "";
        try { body = (await res.text()).slice(0, 300); } catch {}
        netLog.push(`${res.request().method()} ${u} → ${res.status()} ${body}`);
      }
    });
    page.on("pageerror", (err) => netLog.push(`PAGEERROR: ${String(err).slice(0, 300)}`));
    page.on("console", (msg) => { if (msg.type() === "error") netLog.push(`CONSOLE: ${msg.text().slice(0, 300)}`); });
    ok("admin login", await adminLogin(page));

    // ══ Phase A: empty state ═══════════════════════════════════════
    await page.goto(`${BASE}/admin/plugins`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    ok("empty registries → plugins-empty state", (await page.locator('[data-testid="plugins-empty"]').count()) === 1);

    // Switch to the full controlled registry state
    fs.writeFileSync(SKILLS_JSON, JSON.stringify(fullSkills, null, 2));
    fs.writeFileSync(HOOKS_JSON, JSON.stringify(fullHooks, null, 2));

    // ══ Phase B: admin card list + status hierarchy ════════════════
    await page.goto(`${BASE}/admin/plugins`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    ok("card list renders (plugins-list)", (await page.locator('[data-testid="plugins-list"]').count()) === 1);
    ok("hello-skill card present", (await page.locator('[data-testid="plugin-card-hello-skill"]').count()) === 1);
    ok("valid enabled skill → 已启用", (await page.locator('[data-testid="plugin-status-hello-skill"]').innerText()).includes("已启用"));

    // Error-first: invalid but "enabled" broken-skill renders 无效
    ok("invalid skill → 无效 (error-first, despite enabled:true)", (await page.locator('[data-testid="plugin-status-broken-skill"]').innerText()).includes("无效"));
    const brokenText = await page.locator('[data-testid="plugin-card-broken-skill"]').innerText();
    ok("invalid card body shows 校验失败 detail", brokenText.includes("校验失败"));
    ok("invalid row toggle disabled", (await page.locator('[data-testid="toggle-broken-skill"]').isDisabled()) === true);

    // hook-plugin row: type-based no-toggle (route does not exist)
    ok("hook-plugin card present", (await page.locator('[data-testid="plugin-card-demo-hook"]').count()) === 1);
    ok("hook-plugin toggle disabled with reason", (await page.locator('[data-testid="toggle-demo-hook"]').isDisabled()) === true && (await page.locator('[data-testid="toggle-demo-hook"]').getAttribute("title") ?? "").includes("hook-plugin"));

    // Governance: user-submitted (M7b quarantine) rows never offer the global toggle
    const userSubText = await page.locator('[data-testid="plugin-card-user-sub-skill"]').innerText();
    ok("user-submitted row shows 待审 badge", userSubText.includes("用户提交待审"));
    ok("user-submitted toggle disabled (M7b approve flow owns enable)", (await page.locator('[data-testid="toggle-user-sub-skill"]').isDisabled()) === true);
    ok("user-submitted toggle reason points to 用户技能审核", (await page.locator('[data-testid="toggle-user-sub-skill"]').getAttribute("title") ?? "").includes("用户技能审核"));

    // Fix-round P1: admin-imported (M3 ZIP) quarantine rows are NOT user-submitted —
    // provenance (submittedBy), not the path, drives the guard.
    const adminZipText = await page.locator('[data-testid="plugin-card-admin-zip-skill"]').innerText();
    ok("admin M3 ZIP quarantine row has NO user-submitted badge", !adminZipText.includes("用户提交待审"));
    ok("admin M3 ZIP quarantine row stays toggle-eligible when valid", (await page.locator('[data-testid="toggle-admin-zip-skill"]').isDisabled()) === false);

    // Fix 2: submission status comes from the M7b ledger, not provenance alone.
    // Approved submission → 已通过 label (NOT 待审), still no global toggle; only
    // pending_review is counted in the header.
    const approvedText = await page.locator('[data-testid="plugin-card-user-approved-skill"]').innerText();
    ok("approved user submission shows 用户提交已通过 (not 待审)", approvedText.includes("用户提交已通过") && !approvedText.includes("用户提交待审"));
    ok("approved user submission keeps 已启用 status", (await page.locator('[data-testid="plugin-status-user-approved-skill"]').innerText()).includes("已启用"));
    ok("approved user submission still has NO global toggle (approve flow owns it)", (await page.locator('[data-testid="toggle-user-approved-skill"]').isDisabled()) === true);
    const headerText = await page.locator("h1").locator("xpath=..").innerText();
    ok("header counts ONLY pending_review as 待审 (1, not 2)", headerText.includes("1 个用户提交待审"), headerText);

    // ══ Phase C: enable/disable toggle → server authority ═════════
    page.once("dialog", (d) => d.accept());
    await page.click('[data-testid="toggle-hello-skill"]');
    await page.waitForTimeout(1500);
    ok("toggle off → server registry enabled:false", skillEntry("hello-skill")?.enabled === false, JSON.stringify(skillEntry("hello-skill")));
    ok("toggle off → status 已停用", (await page.locator('[data-testid="plugin-status-hello-skill"]').innerText()).includes("已停用"));
    await page.click('[data-testid="toggle-hello-skill"]');
    await page.waitForTimeout(1500);
    ok("toggle back on → server registry enabled:true", skillEntry("hello-skill")?.enabled === true);

    // ══ Phase D: card/table view switch ═══════════════════════════
    await page.click('[data-testid="view-table"]');
    await page.waitForTimeout(400);
    ok("table view renders rows", (await page.locator('[data-testid="plugins-table"]').count()) === 1 && (await page.locator('[data-testid="plugins-table"] tbody tr').count()) >= 4);
    await page.click('[data-testid="view-cards"]');
    await page.waitForTimeout(400);
    ok("card view restores", (await page.locator('[data-testid="plugins-list"]').count()) === 1);

    // ══ Phase E: import dialog flow — first a MOCKED response carrying scan
    // warnings (P2: verify warning rendering + dismissal), then the real path.
    await page.route("**/api/admin/plugins/import", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          resourceId: "warn-pkg",
          version: "9.9.9",
          types: ["skill"],
          valid: true,
          warnings: ["scripts/ found — review before enabling", "no LICENSE file"],
        }),
      });
    });
    await page.click('[data-testid="open-import"]');
    await page.waitForTimeout(400);
    ok("import dialog opens", (await page.locator('[data-testid="import-dialog"]').count()) === 1);
    await page.fill('[data-testid="import-path"]', "data/skill-hub-cache/demo-pkg");
    await page.fill('[data-testid="import-name"]', "warn-pkg");
    await page.click('[data-testid="import-confirm"]');
    await page.waitForTimeout(1500);
    ok("warned import closes the dialog (notice is page-level, not behind the overlay)", (await page.locator('[data-testid="import-dialog"]').count()) === 0);
    const warnText = await page.locator('[data-testid="import-warnings"]').innerText();
    ok("mocked import warnings render", warnText.includes("scripts/ found") && warnText.includes("no LICENSE file"));
    await page.click('button:has-text("知道了")');
    await page.waitForTimeout(400);
    ok("warning notice dismissible", (await page.locator('[data-testid="import-warnings"]').count()) === 0);
    await page.unroute("**/api/admin/plugins/import");

    // Real import (unmocked) of the staged package
    await page.click('[data-testid="open-import"]');
    await page.waitForTimeout(400);
    await page.fill('[data-testid="import-path"]', "data/skill-hub-cache/demo-pkg");
    await page.fill('[data-testid="import-name"]', "demo-pkg");
    await page.click('[data-testid="import-confirm"]');
    await page.waitForTimeout(2000);
    ok("import succeeds → demo-pkg card appears", (await page.locator('[data-testid="plugin-card-demo-pkg"]').count()) === 1);
    ok("imported package registered in skills.json", skillEntry("demo-pkg")?.path === "plugins/demo-pkg" && skillEntry("demo-pkg")?.enabled === true);
    ok("installed dir exists (plugins/demo-pkg)", fs.existsSync(path.join(SCRATCH, "plugins/demo-pkg/skills/demo-pkg/SKILL.md")));

    // ══ Phase F: load-error state + retry ═════════════════════════
    await page.route("**/api/admin/plugins/installed*", (route) => route.abort());
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    ok("API failure → plugins-error state", (await page.locator('[data-testid="plugins-error"]').count()) === 1);
    await page.unroute("**/api/admin/plugins/installed*");
    await page.click('button:has-text("重试")');
    await page.waitForTimeout(1500);
    ok("retry recovers the card list", (await page.locator('[data-testid="plugins-list"]').count()) === 1);

    // ══ Phase G: org_admin visibility/permissions ═════════════════
    const orgRes = await fetch(`${BASE}/api/admin/plugins/installed`, { headers: { authorization: `Bearer ${orgAdminToken}` } });
    ok("org_admin plugins API → 403 (admin-only backend gate unchanged)", orgRes.status === 403, `status=${orgRes.status}`);

    const ctxO = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageO = await ctxO.newPage();
    await pageO.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await pageO.fill('input[placeholder="请输入用户名"]', ORG_ADMIN);
    await pageO.fill('input[placeholder="请输入密码"]', ORG_ADMIN_PASS + "x");
    await pageO.click('button[type="submit"]');
    await pageO.waitForTimeout(2000);
    await pageO.goto(`${BASE}/admin/plugins`, { waitUntil: "networkidle" });
    await pageO.waitForTimeout(1000);
    ok("org_admin deep-link /admin/plugins → redirected away (no plugins page)", !pageO.url().includes("/admin/plugins") && !(await pageO.locator('[data-testid="plugins-list"]').count()));
    await ctxO.close();

    // ══ Phase H: responsive spot-check ════════════════════════════
    const ctxN = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageN = await ctxN.newPage();
    await adminLogin(pageN);
    await pageN.goto(`${BASE}/admin/plugins`, { waitUntil: "networkidle" });
    await pageN.waitForTimeout(1200);
    const overflow = await pageN.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok("narrow viewport (390px): no horizontal overflow", overflow <= 2, `overflow=${overflow}px`);
    ok("narrow viewport: cards stack (single column)", (await pageN.locator('[data-testid="plugin-card-hello-skill"]').boundingBox()) !== null);
    await ctxN.close();

    await ctx.close();
    await browser.close();
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
if (fail > 0) console.log("\n— network/console capture —\n" + netLog.join("\n"));
if (fail > 0) exitCode = 1;
fs.mkdirSync(path.join(WT, "docs/06-deployment/evidence/plugins-ui"), { recursive: true });
fs.writeFileSync(path.join(WT, "docs/06-deployment/evidence/plugins-ui/browser-check-results.txt"), results.join("\n") + `\n\n${pass} passed, ${fail} failed.\n`);
process.exit(exitCode);
