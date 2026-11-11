#!/usr/bin/env node
/**
 * m6b-browser-check.mjs — Octop absorption M6b browser acceptance for the
 * unified security center (evt_20261022074933).
 *
 * Drives a REAL Chromium against the production dist bundle:
 *   admin six tabs render → org_admin own-org scoping → platform default
 *   read-only → editable profile tri-state save (new-runtime note) →
 *   failure keeps the draft → Bash one-click tighten → reload restores →
 *   audit tab shows the governance audit row → 375px narrow viewport.
 *   Fix round (evt_20261022093849): org_admin skill scan is
 *   entitlement-scoped; unrelated-save then Bash tighten WITHOUT reload.
 *
 * Followed by server-side adversarial checks over the MOUNTED routes
 * (fetch + real tokens): user 403, org_admin cross-org 404, invalid
 * tri-state / unknown tool / extra fields (outer AND inner toolsConfig)
 * 400, platform default 403, guard-relax endpoint absent, audit reasons
 * categorical-only.
 *
 * The backend runs with cwd = fresh temp dir seeded with the worktree's
 * resource pool. Run:
 *   NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m6b-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = 3918;
const DB_PATH = "/tmp/m6b-browser.db";
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "m6b-browser-cwd-"));
const ADMIN_PASS = "m6b-admin-1";
const ORG_ADMIN = "m6b-orgadmin";
const ORG_ADMIN_PASS = "m6b-orgadmin-1x";
const USER = "m6b-user";
const USER_PASS = "m6b-user-1x";
const SHOT_DIR = path.join(WT, "docs/06-deployment/evidence/m6b-security-center");
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

// ─── 1. Seed the scratch cwd with the real resource pool ──────
for (const dir of ["data", "skills", "plugins"]) {
  const src = path.join(WT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(SCRATCH, dir), { recursive: true });
}
fs.writeFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), JSON.stringify({}, null, 2));
// M3 registry rows so the 技能扫描 tab shows real quarantine facts.
fs.writeFileSync(path.join(SCRATCH, "data/skills.json"), JSON.stringify([
  { name: "m6b-local-skill", type: "plugin", enabled: true, path: "skills/m6b-local-skill" },
  { name: "m6b-quarantined-pkg", type: "plugin", enabled: false, path: "skills/quarantine/m6b-quarantined-pkg", sourceKind: "zip", sha256: "m6bdeadbeef01", importedAt: "2026-10-22T00:00:00.000Z", copyPolicy: "snapshot", hasScripts: true },
], null, 2));
// P1-1: deterministic entitlements — default-org is entitled to exactly ONE
// skill; the quarantined package must stay admin-only (catalog leak check).
fs.writeFileSync(path.join(SCRATCH, "data/entitlements.json"), JSON.stringify({
  version: 1,
  entries: [
    { resourceId: "m6b-local-skill", scopeType: "org", scopeId: "default-org", effect: "allow", grantedBy: "admin", grantedAt: "2026-10-22T00:00:00.000Z" },
  ],
}, null, 2));

// ─── 2. Real backend (local runtime, temp DB, isolated cwd) ──────────
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
const server = spawn(TSX, [path.join(WT, "server/server.ts")], {
  cwd: SCRATCH,
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
ok("backend ready (port 3918, temp DB, isolated cwd)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// ─── 3. Provision actors + fixtures over the mounted REST API ──
let adminToken = "", orgAdminToken = "", userToken = "";
let bashProfileId = "", otherOrgProfileId = "";
async function api(method, url, body, token) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
try {
  const first = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  if (first?.mustChangePassword && first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
  adminToken = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: ADMIN_PASS }) })).json())?.token ?? "";
  const created = await api("POST", "/api/admin/users", { username: ORG_ADMIN, password: ORG_ADMIN_PASS, role: "org_admin" }, adminToken);
  ok("org_admin provisioned", created.status === 201 || created.status === 200, `status=${created.status}`);
  const createdU = await api("POST", "/api/admin/users", { username: USER, password: USER_PASS, role: "user" }, adminToken);
  ok("user provisioned", createdU.status === 201 || createdU.status === 200, `status=${createdU.status}`);
  const oaFirst = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: ORG_ADMIN, password: ORG_ADMIN_PASS }) })).json();
  if (oaFirst?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${oaFirst.token}` }, body: JSON.stringify({ oldPassword: ORG_ADMIN_PASS, newPassword: ORG_ADMIN_PASS + "x" }) });
  }
  orgAdminToken = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: ORG_ADMIN, password: ORG_ADMIN_PASS + "x" }) })).json())?.token ?? "";
  userToken = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: USER_PASS }) })).json())?.token ?? "";

  const p1 = await api("POST", "/api/admin/agent-profiles", {
    name: "m6b-bash-auto",
    toolsConfig: { tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"], allowedTools: ["Read", "Grep", "Glob", "Bash"], disallowedTools: [] },
  }, adminToken);
  bashProfileId = p1.json?.profile?.id ?? "";
  const p2 = await api("POST", "/api/admin/agent-profiles", {
    name: "m6b-org-b-profile",
    orgId: "m6b-org-b",
    toolsConfig: { tools: ["Read", "Grep", "Glob", "Write"], allowedTools: ["Read", "Grep", "Glob"], disallowedTools: [] },
  }, adminToken);
  otherOrgProfileId = p2.json?.profile?.id ?? "";
} catch (e) {
  console.error("pre-boot setup failed:", e);
}
ok("fixtures provisioned (bash-auto + other-org profile)", !!bashProfileId && !!otherOrgProfileId);

async function posture(token) {
  const r = await api("GET", "/api/admin/security-posture", undefined, token);
  return r;
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

let exitCode = 0;
try {
  await (async () => {
  const browser = await chromium.launch();

  // ══ Admin context: six tabs + cross-org visibility ════════════
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const adminPage = await adminCtx.newPage();
  ok("admin login", await login(adminPage, "admin", ADMIN_PASS));
  await adminPage.goto(`${BASE}/admin/security`, { waitUntil: "networkidle" });
  await adminPage.waitForTimeout(1200);
  const tabNames = ["工具审批", "文件访问", "敏感信息", "命令防护", "技能扫描", "审计日志"];
  const adminText = () => adminPage.locator("body").innerText();
  let allTabs = true;
  for (const t of tabNames) {
    if ((await adminPage.getByRole("button", { name: t }).count()) === 0) allTabs = false;
  }
  ok("admin: all six tabs render", allTabs);
  ok("admin: tool approval shows platform default as read-only",
    (await adminText()).includes("平台默认") && (await adminText()).includes("只读"));
  await adminPage.selectOption("select", "platform-default");
  await adminPage.waitForTimeout(400);
  const pdRow = adminPage.locator("div.flex.items-center.justify-between.gap-4").filter({ hasText: "Bash" }).first();
  ok("admin: platform default tri-state controls are disabled (hard read-only)",
    !(await pdRow.locator("button", { hasText: "需审批" }).first().isEnabled()));
  await adminPage.screenshot({ path: `${SHOT_DIR}/01-admin-tool-approval.png`, fullPage: true });

  // Cross-org profile visible to admin, absent for org_admin.
  const adminPosture = (await posture(adminToken)).json;
  ok("admin: posture lists the other-org profile", adminPosture?.toolApproval?.profiles?.some((p) => p.profileId === otherOrgProfileId));

  // File access + sensitive info tabs.
  await adminPage.getByRole("button", { name: "文件访问" }).click();
  await adminPage.waitForTimeout(300);
  ok("admin: file access tab shows symbolic boundaries (no host paths)",
    (await adminText()).includes("workspace/input") && !(await adminText()).includes("/Users/"));
  await adminPage.screenshot({ path: `${SHOT_DIR}/02-file-access.png`, fullPage: true });
  await adminPage.getByRole("button", { name: "敏感信息" }).click();
  await adminPage.waitForTimeout(300);
  ok("admin: sensitive info declares chat content DLP 未实现 (honest)",
    (await adminText()).includes("chat-content-dlp") && (await adminText()).includes("未实现"));
  await adminPage.screenshot({ path: `${SHOT_DIR}/03-sensitive-info.png`, fullPage: true });

  // Command protection + skill scan tabs.
  await adminPage.getByRole("button", { name: "命令防护" }).click();
  await adminPage.waitForTimeout(300);
  ok("admin: command protection shows local Bash hard-deny + risky profile",
    (await adminText()).includes("硬拒绝") && (await adminText()).includes("m6b-bash-auto"));
  await adminPage.screenshot({ path: `${SHOT_DIR}/04-command-protection.png`, fullPage: true });
  await adminPage.getByRole("button", { name: "技能扫描" }).click();
  await adminPage.waitForTimeout(300);
  ok("admin: skill scan shows quarantine facts (隔离待审 + 含脚本)",
    (await adminText()).includes("隔离待审") && (await adminText()).includes("含脚本") && (await adminText()).includes("m6b-quarantined-pkg"));
  await adminPage.screenshot({ path: `${SHOT_DIR}/05-skill-scan.png`, fullPage: true });
  await adminCtx.close();

  // ══ org_admin context: own-org + save journey ════════════════
  const oaCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await oaCtx.newPage();
  const bodyText = () => page.locator("body").innerText();
  ok("org_admin login", await login(page, ORG_ADMIN, ORG_ADMIN_PASS + "x"));
  await page.goto(`${BASE}/admin/security`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const oaPosture = (await posture(orgAdminToken)).json;
  ok("org_admin: own-org profile visible, cross-org profile NEVER visible",
    oaPosture?.toolApproval?.profiles?.some((p) => p.profileId === bashProfileId) &&
    !oaPosture?.toolApproval?.profiles?.some((p) => p.profileId === otherOrgProfileId));
  ok("org_admin: skillScan is entitlement-scoped (only the entitled skill; quarantined pkg NEVER leaks)",
    oaPosture?.skillScan?.packages?.length === 1 && oaPosture?.skillScan?.packages?.[0]?.name === "m6b-local-skill",
    JSON.stringify(oaPosture?.skillScan?.packages?.map((p) => p.name)));
  await page.screenshot({ path: `${SHOT_DIR}/06-orgadmin-own-org.png`, fullPage: true });

  // UI mirror of the P1-1 scope: the org_admin skill-scan tab must NOT list
  // the unentitled quarantined package (admin's tab does).
  await page.getByRole("button", { name: "技能扫描" }).click();
  await page.waitForTimeout(300);
  ok("org_admin: skill scan tab shows ONLY the entitled skill (P1-1)",
    (await bodyText()).includes("m6b-local-skill") && !(await bodyText()).includes("m6b-quarantined-pkg"));
  await page.getByRole("button", { name: "工具审批" }).click();
  await page.waitForTimeout(300);

  // Select the editable profile; verify its Bash is auto-allowed (risky).
  await page.selectOption("select", bashProfileId);
  await page.waitForTimeout(400);
  const bashRow = page.locator("div.flex.items-center.justify-between.gap-4").filter({ hasText: "Bash" }).first();
  ok("org_admin: risky profile's Bash segmented control shows 自动允许 active",
    (await bashRow.locator("button", { hasText: "自动允许" }).first().getAttribute("class"))?.includes("bg-green-100"));

  // ── Failure keeps the draft (route-aborted PATCH) ─────────────
  let abortOnce = true;
  await page.route(/\/api\/admin\/security-posture\/profiles\/.+\/tools/, (route) => {
    if (abortOnce) { abortOnce = false; return route.abort("failed"); }
    return route.continue();
  });
  const writeRow = page.locator("div.flex.items-center.justify-between.gap-4").filter({ hasText: "Write" }).first();
  await writeRow.locator("button", { hasText: "禁用" }).first().click();
  await page.waitForTimeout(200);
  ok("org_admin: dirty indicator appears after edit", (await bodyText()).includes("有未保存修改"));
  await page.getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(1200);
  ok("org_admin: failed save shows the error banner", (await bodyText()).includes("保存失败"));
  ok("org_admin: failed save KEEPS the draft (dirty + 禁用 still selected)",
    (await bodyText()).includes("有未保存修改") &&
    (await writeRow.locator("button", { hasText: "禁用" }).first().getAttribute("class"))?.includes("bg-red-100"));

  // ── Successful save (route un-aborted) + new-runtime note ─────
  await page.getByRole("button", { name: "保存" }).click();
  for (let i = 0; i < 20 && !(await bodyText()).includes("仅对新"); i++) await page.waitForTimeout(500);
  ok("org_admin: successful save shows the 仅对新 runtime 生效 note", (await bodyText()).includes("仅对新"));
  const afterSave = (await posture(orgAdminToken)).json;
  const savedProfile = afterSave?.toolApproval?.profiles?.find((p) => p.profileId === bashProfileId);
  ok("org_admin: save persisted server-side (Write now disallowed, not partial)",
    savedProfile?.disallowedTools?.includes("Write") && savedProfile?.allowedTools?.includes("Bash"));
  let cleanDraft = false;
  for (let i = 0; i < 20 && !cleanDraft; i++) {
    await page.waitForTimeout(500);
    cleanDraft = !(await bodyText()).includes("有未保存修改");
  }
  ok("org_admin: clean draft after save (not dirty)", cleanDraft);

  // ── Reload restores the saved state (server persistence) ─────
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.selectOption("select", bashProfileId);
  await page.waitForTimeout(600);
  const writeRowAfter = page.locator("div.flex.items-center.justify-between.gap-4").filter({ hasText: "Write" }).first();
  ok("org_admin: reload restores the saved tri-state (server-persisted, not client state)",
    (await writeRowAfter.locator("button", { hasText: "禁用" }).first().getAttribute("class"))?.includes("bg-red-100") &&
    !(await bodyText()).includes("有未保存修改"));
  await page.screenshot({ path: `${SHOT_DIR}/07-reloaded-saved-state.png`, fullPage: true });

  // ── P1-3: save an UNRELATED setting while Bash stays auto-allowed ──
  const editRow = page.locator("div.flex.items-center.justify-between.gap-4").filter({ hasText: "Edit" }).first();
  await editRow.locator("button", { hasText: "禁用" }).first().click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "保存" }).click();
  for (let i = 0; i < 20 && (await bodyText()).includes("有未保存修改"); i++) await page.waitForTimeout(500);
  const midSave = (await posture(orgAdminToken)).json;
  const midProfile = midSave?.toolApproval?.profiles?.find((p) => p.profileId === bashProfileId);
  ok("org_admin: unrelated save persisted (Edit disallowed) while Bash STILL auto-allowed",
    midProfile?.disallowedTools?.includes("Edit") && midProfile?.allowedTools?.includes("Bash"));

  // ── Bash one-click tighten from 命令防护 WITHOUT reload (P1-3) ──
  await page.getByRole("button", { name: "命令防护" }).click();
  await page.waitForTimeout(400);
  const tightenBtn = page.getByRole("button", { name: "收紧为需审批" }).first();
  ok("org_admin: tighten button stays available after the unrelated save (no stale 已收紧)",
    (await tightenBtn.isVisible()) && (await tightenBtn.isEnabled()) && !(await bodyText()).includes("已收紧"));
  await tightenBtn.click();
  for (let i = 0; i < 20 && !(await bodyText()).includes("Bash 收紧"); i++) await page.waitForTimeout(500);
  const afterTighten = (await posture(orgAdminToken)).json;
  const tightened = afterTighten?.toolApproval?.profiles?.find((p) => p.profileId === bashProfileId);
  ok("org_admin: Bash tighten persisted (allowed → approval, NOT disabled)",
    !tightened?.allowedTools?.includes("Bash") && !tightened?.disallowedTools?.includes("Bash") && tightened?.approvalRequired?.includes("Bash"));
  await page.screenshot({ path: `${SHOT_DIR}/08-bash-tightened.png`, fullPage: true });

  // ── Audit tab shows the governance audit rows ────────────────
  await page.getByRole("button", { name: "审计日志" }).click();
  await page.waitForTimeout(900);
  ok("org_admin: audit tab lists security.profile_tools.update rows",
    (await bodyText()).includes("security.profile_tools.update"));
  ok("org_admin: audit tab links to the full governance audit page",
    (await bodyText()).includes("治理审计检索"));
  await page.screenshot({ path: `${SHOT_DIR}/09-audit.png`, fullPage: true });

  // ── Narrow viewport: six tabs usable, no overlap ─────────────
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${BASE}/admin/security`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const narrowTabs = ["工具审批", "文件访问", "敏感信息", "命令防护", "技能扫描", "审计日志"];
  let narrowCount = 0;
  for (const t of narrowTabs) {
    if ((await page.getByRole("button", { name: t }).count()) > 0) narrowCount++;
  }
  const hasHorizOverflowScroll = await page.evaluate(() => {
    const strip = Array.from(document.querySelectorAll("div")).find((d) =>
      typeof d.className === "string" && d.className.includes("min-w-max"));
    if (!strip) return false;
    const scroller = strip.parentElement;
    return !!scroller && scroller.scrollWidth > scroller.clientWidth;
  });
  ok("narrow 375px: all six tabs present, tab bar scrolls horizontally (no overlap)",
    narrowCount === 6 && hasHorizOverflowScroll);
  await page.screenshot({ path: `${SHOT_DIR}/10-narrow-viewport.png`, fullPage: true });
  await oaCtx.close();

  await browser.close();

  // ══ Server-side adversarial checks (mounted routes + real tokens) ══
  const userGet = await posture(userToken);
  ok("adversarial: plain user GET posture → 403", userGet.status === 403);

  const cross = await api("PATCH", `/api/admin/security-posture/profiles/${otherOrgProfileId}/tools`, {
    toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] },
  }, orgAdminToken);
  ok("adversarial: org_admin PATCH cross-org profile → 404 (no existence leak)", cross.status === 404);

  const overlap = await api("PATCH", `/api/admin/security-posture/profiles/${bashProfileId}/tools`, {
    toolsConfig: { tools: ["Bash"], allowedTools: ["Bash"], disallowedTools: ["Bash"] },
  }, orgAdminToken);
  ok("adversarial: Bash in both allowed+disallowed → 400 invalid_tools_config", overlap.status === 400 && overlap.json?.code === "invalid_tools_config");

  const unknownTool = await api("PATCH", `/api/admin/security-posture/profiles/${bashProfileId}/tools`, {
    toolsConfig: { tools: ["NuclearLaunch"], allowedTools: [], disallowedTools: [] },
  }, orgAdminToken);
  ok("adversarial: unknown tool → 400 invalid_tools_config", unknownTool.status === 400 && unknownTool.json?.code === "invalid_tools_config");

  const extra = await api("PATCH", `/api/admin/security-posture/profiles/${bashProfileId}/tools`, {
    toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] },
    orgId: "m6b-org-b",
    name: "hijack",
  }, orgAdminToken);
  ok("adversarial: body orgId/name forging → 400 unexpected_fields", extra.status === 400 && extra.json?.code === "unexpected_fields");

  // P1-2: extra keys INSIDE toolsConfig must be rejected (never persisted).
  const innerExtra = await api("PATCH", `/api/admin/security-posture/profiles/${bashProfileId}/tools`, {
    toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [], secret: "smuggled", note: "extra" },
  }, orgAdminToken);
  ok("adversarial: inner toolsConfig extra fields (secret/note) → 400 unexpected_fields",
    innerExtra.status === 400 && innerExtra.json?.code === "unexpected_fields");

  const pd = await api("PATCH", `/api/admin/security-posture/profiles/platform-default/tools`, {
    toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] },
  }, adminToken);
  ok("adversarial: platform default write → 403 (even admin)", pd.status === 403);

  const relax = await api("PATCH", "/api/admin/security-posture/guards", { relax: true }, adminToken);
  ok("adversarial: no guard-relax endpoint exists (404)", relax.status === 404);

  // Config unchanged after all adversarial attempts.
  const finalPosture = (await posture(orgAdminToken)).json;
  const finalProfile = finalPosture?.toolApproval?.profiles?.find((p) => p.profileId === bashProfileId);
  ok("adversarial: all rejections left the config unchanged (Write still disallowed, Bash still approval)",
    finalProfile?.disallowedTools?.includes("Write") && finalProfile?.approvalRequired?.includes("Bash"));

  // Audit rows are categorical-only (no tool names, no paths, no secrets).
  const auditRes = await api("GET", "/api/admin/governance-audit?limit=100", undefined, adminToken);
  const secRows = (auditRes.json?.rows ?? []).filter((r) => r.action === "security.profile_tools.update");
  const successRows = secRows.filter((r) => r.result === "success");
  const categorical = secRows.every((r) => {
    const reason = r.reasonSummary ?? "";
    return reason.length > 0 && reason.length < 80 && !reason.includes("Bash") && !reason.includes("NuclearLaunch") && !reason.includes("/");
  }) && successRows.every((r) => /^tools=\d+ allowed=\d+ disallowed=\d+$/.test(r.reasonSummary ?? ""));
  ok("adversarial: governance audit reasons are categorical (no payload residue)",
    secRows.length >= 3 && categorical, `rows=${secRows.length}`);
  })();
} catch (e) {
  console.error("BROWSER CHECK CRASHED:", e);
  exitCode = 1;
} finally {
  try { server.kill("SIGKILL"); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(
  path.join(SHOT_DIR, "browser-check.txt"),
  `${new Date().toISOString()}\nnode ${process.argv[1]}\n\n${results.join("\n")}\n\n${pass} passed, ${fail} failed\n`
);
process.exit(fail > 0 || exitCode ? 1 : 0);
