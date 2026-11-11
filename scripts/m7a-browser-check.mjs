#!/usr/bin/env node
/**
 * m7a-browser-check.mjs — Octop absorption M7a browser acceptance for the
 * My Experts directory + edit drawer (evt_20261022121045).
 *
 * Drives a REAL Chromium against the production dist bundle:
 *   user A login → 我的专家 directory → own agents only (user B's agent
 *   invisible) → 新建专家 (M6a drawer reuse) → edit name/welcome/quickPrompts
 *   → save → server-side verify → reload restores → capability checkbox save
 *   → effective set ⊆ options upper bound → delete → card removed.
 *
 * Followed by server-side adversarial checks over the MOUNTED routes
 * (fetch + real tokens): cross-user PATCH/DELETE 404; quickPrompts over-cap
 * 400; PATCH with forged ownerUserId/orgId/status zero-land; audit payload
 * metadata-only (no name/welcome/prompt plaintext in agent_events).
 *
 * The backend runs with cwd = fresh temp dir seeded with the worktree's
 * resource pool. Run:
 *   NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m7a-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = 3919;
const DB_PATH = "/tmp/m7a-browser.db";
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "m7a-browser-cwd-"));
const ADMIN_PASS = "m7a-admin-1";
const USER_A = "m7a-user-a";
const USER_A_PASS = "m7a-user-a-1x";
const USER_B = "m7a-user-b";
const USER_B_PASS = "m7a-user-b-1x";
const SKILL_ID = "hello-skill"; // seeded + org-entitled below
const SHOT_DIR = path.join(WT, "docs/06-deployment/evidence/m7a-expert-directory");
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
for (const dir of ["data", "skills"]) {
  const src = path.join(WT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(SCRATCH, dir), { recursive: true });
}
fs.writeFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), JSON.stringify({}, null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/skills.json"), JSON.stringify([
  { name: SKILL_ID, type: "plugin", enabled: true, path: `skills/${SKILL_ID}` },
], null, 2));
// Deterministic entitlement: default-org (both users) is entitled to exactly
// hello-skill — that is the checkbox upper bound in the drawer.
fs.writeFileSync(path.join(SCRATCH, "data/entitlements.json"), JSON.stringify({
  version: 1,
  entries: [
    { resourceId: SKILL_ID, scopeType: "org", scopeId: "default-org", effect: "allow", grantedBy: "admin", grantedAt: "2026-10-22T00:00:00.000Z" },
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
// detached → own process group: cleanup can kill the WHOLE backend tree with
// one group signal (process.kill(-pid)) and can never match this script, whose
// keep-alive fetch connections to the port would otherwise show up in lsof.
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
ok("backend ready (port 3919, temp DB, isolated cwd)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// ─── 3. Provision actors over the mounted REST API ─────────────
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
let adminToken = "", tokenA = "", tokenB = "";
try {
  const first = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  if (first?.mustChangePassword && first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
  adminToken = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: ADMIN_PASS }) })).json())?.token ?? "";
  await api("POST", "/api/admin/users", { username: USER_A, password: USER_A_PASS, role: "user" }, adminToken);
  await api("POST", "/api/admin/users", { username: USER_B, password: USER_B_PASS, role: "user" }, adminToken);
  // Fresh users are must-change-gated: burn the first-login token by changing
  // the password once, then take the FINAL token (and use the final password
  // for the browser login below).
  async function activateUser(username, pwd) {
    const first = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: pwd }) })).json();
    if (first?.token) {
      await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: pwd, newPassword: pwd + "x" }) });
    }
    return (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: pwd + "x" }) })).json())?.token ?? "";
  }
  tokenA = await activateUser(USER_A, USER_A_PASS);
  tokenB = await activateUser(USER_B, USER_B_PASS);
} catch (e) {
  console.error("pre-boot setup failed:", e);
}
ok("actors provisioned (user A + user B + admin)", !!adminToken && !!tokenA && !!tokenB);
const USER_A_FINAL_PASS = USER_A_PASS + "x";

// User B pre-creates one agent over the API (invisible to A's directory).
const bCreate = await api("POST", "/api/agent-builder", {
  templateId: "blank", name: "B 的私密专家", clientRequestId: "m7a-b-agent-0001",
}, tokenB);
const agentBId = bCreate.json?.agent?.id ?? "";
ok("user B pre-creates an own agent", bCreate.status === 201 && !!agentBId, `status=${bCreate.status}`);

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

const cardCount = (page) => page.locator('[data-testid^="expert-card-"]').count();

let agentAId = "";
let exitCode = 0;
try {
  await (async () => {
    const browser = await chromium.launch();

    // ══ User A: directory journey ═══════════════════════════════
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctxA.newPage();
    ok("user A login", await login(page, USER_A, USER_A_FINAL_PASS));

    await page.click('[data-testid="open-experts"]');
    await page.waitForTimeout(800);
    ok("directory route /experts reachable", page.url().includes("/experts"));
    ok("empty state shows for a fresh user", (await page.locator('[data-testid="experts-empty"]').count()) === 1);
    ok("user B's agent is NOT visible (empty directory)", (await cardCount(page)) === 0);
    await page.screenshot({ path: path.join(SHOT_DIR, "01-empty.png"), fullPage: true });

    // ── Create via the reused M6a drawer ──
    await page.click('button:has-text("新建专家")');
    await page.waitForTimeout(600);
    await page.click('button:has-text("空白助手")');
    await page.waitForTimeout(300);
    await page.fill('input[placeholder="给这个 Agent 起个名字"]', "A 的翻译专家");
    await page.click('button:has-text("下一步")');
    await page.waitForTimeout(300);
    await page.click('button:has-text("创建")');
    await page.waitForTimeout(1500);
    const cards = await cardCount(page);
    ok("created expert appears in the directory (exactly one)", cards === 1, `cards=${cards}`);
    agentAId = await page.locator('[data-testid^="expert-card-"]').first().getAttribute("data-testid").then((v) => v?.replace("expert-card-", "") ?? "");
    ok("created agent id captured", !!agentAId);
    await page.screenshot({ path: path.join(SHOT_DIR, "02-created.png"), fullPage: true });

    // ── Edit: name / welcome / quick prompts ──
    await page.click(`[data-testid="expert-card-${agentAId}"] button:has-text("编辑")`);
    await page.waitForTimeout(800);
    ok("edit drawer opens", (await page.locator('[data-testid="edit-name"]').count()) === 1);
    await page.fill('[data-testid="edit-name"]', "A 的会议专家");
    await page.fill('[data-testid="edit-welcome"]', "浏览器改过的欢迎语");
    await page.click('button:has-text("添加")');
    const qpInputs = page.locator('[data-testid="edit-quick-prompts"] input');
    await qpInputs.nth(0).fill("总结会议");
    await qpInputs.nth(1).fill("请总结会议要点");
    // Capability: enable the entitled skill.
    const capBtn = page.locator(`[data-testid="cap-${SKILL_ID}"]`);
    const hasCap = (await capBtn.count()) === 1;
    ok("drawer lists the entitled skill option (server upper bound)", hasCap);
    if (hasCap) await capBtn.click();
    await page.click('[data-testid="edit-save"]');
    await page.waitForTimeout(1500);

    // ── Server-side verification (authority, not DOM) ──
    const listA = await api("GET", "/api/agents", undefined, tokenA);
    const rowA = (listA.json ?? []).find((a) => a.id === agentAId);
    ok("server: name edit persisted (live title)", rowA?.title === "A 的会议专家", `title=${rowA?.title}`);
    ok("server: welcomeMessage persisted", rowA?.welcomeMessage === "浏览器改过的欢迎语");
    ok(
      "server: quickPrompts persisted in M6a shape",
      Array.isArray(rowA?.quickPrompts) && rowA.quickPrompts.length === 1 &&
        rowA.quickPrompts[0].title === "总结会议"
    );
    const capsAfter = await api("GET", `/api/agents/${agentAId}/capabilities`, undefined, tokenA);
    const capRow = (capsAfter.json?.capabilities ?? []).find((c) => c.resourceId === SKILL_ID);
    ok("server: capability activation effective", capRow?.enabled === true, JSON.stringify(capRow ?? null));
    const optsA = await api("GET", "/api/agent-builder/options", undefined, tokenA);
    const optIds = (optsA.json?.capabilities ?? []).map((c) => c.resourceId);
    const enabledIds = (capsAfter.json?.capabilities ?? []).filter((c) => c.enabled).map((c) => c.resourceId);
    ok("server: effective set ⊆ options upper bound", enabledIds.every((id) => optIds.includes(id)), `enabled=[${enabledIds}] opts=[${optIds}]`);

    // ── Reload restores (server persistence, not client state) ──
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    if ((await cardCount(page)) !== 1) {
      console.log("DEBUG reload url:", page.url());
      console.log("DEBUG reload body:", (await page.locator("body").innerText()).slice(0, 300));
      await page.screenshot({ path: path.join(SHOT_DIR, "debug-reload.png"), fullPage: true });
    }
    ok("reload: directory still shows the edited expert", (await cardCount(page)) === 1);
    await page.click(`[data-testid="expert-card-${agentAId}"] button:has-text("编辑")`);
    await page.waitForTimeout(800);
    ok(
      "reload: edit draft restored from server",
      (await page.locator('[data-testid="edit-name"]').inputValue()) === "A 的会议专家" &&
        (await page.locator('[data-testid="edit-welcome"]').inputValue()) === "浏览器改过的欢迎语"
    );
    const capChecked = await page.locator(`[data-testid="cap-${SKILL_ID}"]`).innerText();
    await page.click('button[aria-label="关闭"]');
    await page.screenshot({ path: path.join(SHOT_DIR, "03-edited-reloaded.png"), fullPage: true });
    ok("reload: capability checkbox reflects server state", capChecked.includes("将停用") === false);

    // ── Enter chat from the directory ──
    await page.click(`[data-testid="expert-card-${agentAId}"] button:has-text("进入会话")`);
    await page.waitForTimeout(1200);
    ok("enter chat navigates back to the workbench with the agent's conversation",
      !page.url().includes("/experts") && (await page.locator("body").innerText()).includes("A 的会议专家"));

    // ══ Adversarial (fetch + real tokens, mounted routes) ═══════
    const crossPatch = await api("PATCH", `/api/agents/${agentAId}`, { name: "B 偷改" }, tokenB);
    ok("adversarial: user B PATCH on A's agent → 404", crossPatch.status === 404, `status=${crossPatch.status}`);
    const crossDelete = await api("DELETE", `/api/agents/${agentAId}`, undefined, tokenB);
    ok("adversarial: user B DELETE on A's agent → 404", crossDelete.status === 404, `status=${crossDelete.status}`);

    const overCap = await api("PATCH", `/api/agents/${agentAId}`, {
      quickPrompts: Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` })),
    }, tokenA);
    ok("adversarial: 7 quickPrompts → 400", overCap.status === 400, `status=${overCap.status}`);
    const after400 = (await api("GET", "/api/agents", undefined, tokenA)).json.find((a) => a.id === agentAId);
    ok("adversarial: 400 left the row untouched", after400?.quickPrompts?.length === 1);

    const forged = await api("PATCH", `/api/agents/${agentAId}`, {
      name: "A 的合法改名",
      ownerUserId: "m7a-user-b",
      orgId: "evil-org",
      status: "archived",
      templateId: "doc-analysis",
    }, tokenA);
    ok("adversarial: forged-keys PATCH → 200 (ignored)", forged.status === 200, `status=${forged.status}`);
    const afterForge = (await api("GET", "/api/agents", undefined, tokenA)).json.find((a) => a.id === agentAId);
    ok("adversarial: legit field applied, ownership intact (B still cannot touch it)",
      afterForge?.title === "A 的合法改名" &&
        (await api("PATCH", `/api/agents/${agentAId}`, { name: "x" }, tokenB)).status === 404);
    ok("adversarial: status not archived (agent still listed)", !!afterForge);

    // ── Audit: metadata-only over the whole event family ──
    const req = createRequire(import.meta.url);
    const Database = req(path.join(WT, "node_modules/better-sqlite3"));
    const db = new Database(DB_PATH, { readonly: true });
    const events = db
      .prepare(`SELECT payload_json FROM agent_events WHERE event_type = 'agent_profile_updated' ORDER BY sequence`)
      .all()
      .map((r) => r.payload_json);
    db.close();
    ok("audit: agent_profile_updated events exist (owner timeline)", events.length >= 1, `count=${events.length}`);
    const allPayload = events.join("\n");
    ok(
      "audit: no plaintext (name/welcome/prompt text absent from every payload)",
      !allPayload.includes("A 的会议专家") && !allPayload.includes("浏览器改过的欢迎语") &&
        !allPayload.includes("总结会议") && !allPayload.includes("请总结会议要点") &&
        !allPayload.includes("A 的合法改名")
    );

    // ── Delete journey (A deletes own agent; B unaffected) ──
    await page.click('[data-testid="open-experts"]');
    await page.waitForTimeout(1000);
    page.on("dialog", (d) => d.accept());
    await page.click(`[data-testid="expert-card-${agentAId}"] button:has-text("删除")`);
    await page.waitForTimeout(1500);
    ok("delete: card removed from the directory", (await cardCount(page)) === 0);
    const bList = await api("GET", "/api/agents", undefined, tokenB);
    ok("delete: user B's agent untouched", (bList.json ?? []).some((a) => a.id === agentBId));
    const aListFinal = await api("GET", "/api/agents", undefined, tokenA);
    ok("delete: server confirms A's agent gone", !(aListFinal.json ?? []).some((a) => a.id === agentAId));
    await page.screenshot({ path: path.join(SHOT_DIR, "04-after-delete.png"), fullPage: true });

    await ctxA.close();
    await browser.close();
  })();
} catch (e) {
  console.error("browser check crashed:", e);
  fail++;
  exitCode = 1;
} finally {
  // Group-kill the spawned backend tree (detached group). Never lsof-match by
  // port here: this script holds keep-alive connections to the port, so a bare
  // `lsof -ti :PORT | xargs kill -9` would SIGKILL the script itself (exit
  // 137) before the summary/results are written.
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
  try { server.kill("SIGKILL"); } catch {}
}

// Summary + results are written AFTER cleanup so a cleanup failure can never
// lose the run's outcome, and the cleanup above can never kill this process.
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) exitCode = 1;
fs.writeFileSync(
  path.join(SHOT_DIR, "browser-check-results.txt"),
  results.join("\n") + `\n\n${pass} passed, ${fail} failed.\n`
);
process.exit(exitCode);
