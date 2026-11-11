#!/usr/bin/env node
/**
 * m6a-browser-check.mjs — Octop absorption M6a browser acceptance for the
 * expert creation + first-chat journey (evt_20261021101507).
 *
 * Drives a REAL Chromium against the production-served dist bundle as a
 * normal (non-admin) user:
 *   workbench 创建 Agent primary button → drawer template catalog (≥4) →
 *   template preset prefill → inline name validation → step-3 shows ONLY
 *   entitled capabilities (hello-skill yes, minimal-plugin no) → create →
 *   auto-enter the new Agent → empty conversation shows the SERVER-persisted
 *   welcome + quick prompts → quick prompt FILLS the composer without
 *   sending → reload restores the starter (server persistence, not client
 *   state) → rapid double-submit creates exactly ONE agent → narrow
 *   viewport keeps the drawer usable.
 *
 * The backend runs with cwd = fresh temp dir seeded with the worktree's
 * resource pool (data/ + skills/ + plugins/) so capability validity checks
 * resolve real resources. Run:
 *   NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m6a-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const PORT = 3917;
const DB_PATH = "/tmp/m6a-browser.db";
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "m6a-browser-cwd-"));
const ADMIN_PASS = "m6a-admin-1";
const USER = "m6a-user";
const USER_PASS = "m6a-user-1x";
const AGENT_NAME = "我的文档专家";
const SHOT_DIR = path.join(WT, "docs/06-deployment/evidence/m6a-expert-builder");
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
// Grant hello-skill to the test user (user-scope allow) — minimal-plugin
// stays UN-entitled so step 3 must NOT show it (only-entitled invariant).
// scopeId = the user's REAL id (a UUID, only known after the users row is
// created), so this runs post-provision; the service re-reads the file per
// request, so a late write is picked up immediately.
function grantHelloSkill(userId) {
  fs.writeFileSync(
    path.join(SCRATCH, "data/entitlements.json"),
    JSON.stringify(
      {
        entries: [
          {
            resourceId: "hello-skill",
            scopeType: "user",
            scopeId: userId,
            effect: "allow",
            grantedBy: "admin",
            grantedAt: new Date().toISOString(),
          },
        ],
      },
      null,
      2
    )
  );
}
// Fresh activation store so agent-capabilities land only in this run.
fs.writeFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), JSON.stringify({}, null, 2));

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
ok("backend ready (port 3917, temp DB, isolated cwd)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// Pre-boot: admin must-change flow → create the normal test user → rotate
// their first-login password.
let adminToken = "";
let userToken = "";
try {
  const first = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  if (first?.mustChangePassword && first?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
  let login = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: ADMIN_PASS }) })).json();
  if (!login?.token) login = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  adminToken = login?.token ?? "";
  await fetch(`${BASE}/api/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username: USER, password: USER_PASS, role: "user" }),
  });
  const uFirst = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: USER_PASS }) })).json();
  if (uFirst?.token) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${uFirst.token}` }, body: JSON.stringify({ oldPassword: USER_PASS, newPassword: USER_PASS + "x" }) });
  }
  const uLogin = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: USER_PASS + "x" }) })).json();
  userToken = uLogin?.token ?? "";
  // Resolve the user's real UUID (entitlement scopeIds are user ids) and grant
  // hello-skill before the browser journey starts.
  const usersList = await (await fetch(`${BASE}/api/admin/users`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
  const created = Array.isArray(usersList) ? usersList.find((u) => u.username === USER) : usersList?.users?.find((u) => u.username === USER);
  if (created?.id) grantHelloSkill(created.id);
} catch (e) {
  console.error("pre-boot setup failed:", e);
}
ok("test user provisioned with token", !!userToken);

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

async function agentsCount() {
  const r = await fetch(`${BASE}/api/agents`, { headers: { authorization: `Bearer ${userToken}` } });
  const list = await r.json();
  return Array.isArray(list) ? list.length : -1;
}

let exitCode = 0;
try {
  await (async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const bodyText = () => page.locator("body").innerText();

  // ── 1. Login → workbench shows the primary 创建 Agent button ──
  ok("user login lands in workbench", await login(page, USER, USER_PASS + "x"), page.url());
  ok("primary action is 创建 Agent (legacy 新建空白对话 kept as secondary)",
    await page.getByRole("button", { name: "创建 Agent" }).isVisible() &&
    await page.getByRole("button", { name: "新建空白对话" }).isVisible());
  await page.screenshot({ path: `${SHOT_DIR}/01-workbench.png`, fullPage: true });

  const beforeCount = await agentsCount();

  // ── 2. Drawer: template catalog ─────────────────────────────
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.waitForTimeout(600);
  const drawer = page.locator('[role="dialog"][aria-label="创建 Agent"]');
  ok("drawer opens with template catalog", await drawer.isVisible());
  const catalogText = await drawer.innerText();
  ok("template catalog: ≥4 templates incl. 空白助手/文档分析/方案撰写/项目助手",
    ["空白助手", "文档分析", "方案撰写", "项目助手"].every((n) => catalogText.includes(n)));
  await page.screenshot({ path: `${SHOT_DIR}/02-template-catalog.png` });

  // ── 3. Step 2: template preset prefill + inline validation ──
  await drawer.locator("button", { hasText: "文档分析" }).first().click();
  await page.waitForTimeout(400);
  const sysPromptVal = await drawer.locator("textarea").first().inputValue();
  ok("step 2 prefills the template system prompt", sysPromptVal.includes("文档分析专家"));
  ok("step 2 name starts empty (user types identity)", await drawer.locator('input[placeholder^="给这个 Agent"]').inputValue() === "");
  // Inline validation: 下一步 disabled (or error) without a name.
  await page.screenshot({ path: `${SHOT_DIR}/03-step2-prefill.png` });
  const nextBtn = drawer.getByRole("button", { name: "下一步" });
  const nextDisabledNoName = !(await nextBtn.isEnabled());
  await drawer.locator('input[placeholder^="给这个 Agent"]').fill(AGENT_NAME);
  const nextEnabledWithName = await nextBtn.isEnabled();
  ok("name is required before proceeding (disabled → enabled once named)",
    (nextDisabledNoName || (await drawer.innerText()).includes("请为 Agent 命名")) && nextEnabledWithName);
  await nextBtn.click();
  await page.waitForTimeout(400);

  // ── 4. Step 3: ONLY entitled capabilities are offered ────────
  const step3Text = await drawer.innerText();
  ok("step 3 offers the entitled capability (hello-skill)", step3Text.includes("hello-skill"));
  ok("step 3 does NOT offer the un-entitled capability (minimal-plugin)",
    !step3Text.includes("minimal-plugin"), `step3 has: ${step3Text.slice(0, 200)}`);
  await page.screenshot({ path: `${SHOT_DIR}/04-step3-capabilities.png` });

  // Select hello-skill, then create with a rapid DOUBLE click (submit guard).
  await drawer.locator("button", { hasText: "hello-skill" }).first().click();
  await page.waitForTimeout(200);
  const createBtn = drawer.getByRole("button", { name: "创建", exact: true });
  await createBtn.click();
  await createBtn.click().catch(() => {}); // second click may hit the disabled guard
  await page.waitForTimeout(2500);

  // ── 5. Auto-enter new agent + starter in empty conversation ──
  ok("drawer closed after create", !(await drawer.isVisible().catch(() => false)));
  const afterCount = await agentsCount();
  ok("rapid double-submit created exactly ONE agent", afterCount === beforeCount + 1, `before=${beforeCount} after=${afterCount}`);
  const agentList = await (await fetch(`${BASE}/api/agents`, { headers: { authorization: `Bearer ${userToken}` } })).json();
  const created = agentList.find((a) => a.title === AGENT_NAME);
  ok("created agent carries starter metadata (server-persisted)",
    !!created && created.templateId === "doc-analysis" && typeof created.welcomeMessage === "string" && Array.isArray(created.quickPrompts) && created.quickPrompts.length === 3, JSON.stringify(created && { templateId: created.templateId, qp: created.quickPrompts?.length }));
  ok("created agent activated hello-skill", JSON.stringify(
    JSON.parse(fs.readFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), "utf8"))[created.id]
  ) === JSON.stringify(["hello-skill"]));
  ok("workbench auto-entered the new agent", (await bodyText()).includes(AGENT_NAME));
  await page.screenshot({ path: `${SHOT_DIR}/05-first-chat-starter.png`, fullPage: true });

  // ── 6. Starter in the empty conversation ─────────────────────
  ok("empty conversation shows the welcome message", (await bodyText()).includes(created.welcomeMessage.slice(0, 12)));
  const quickBtn = page.locator("button", { hasText: "总结文档要点" });
  ok("empty conversation shows the quick prompts", await quickBtn.isVisible());

  // ── 7. Quick prompt FILLS the composer, never auto-sends ─────
  await quickBtn.click();
  await page.waitForTimeout(300);
  const composerVal = await page.locator("textarea[placeholder^='输入消息']").inputValue();
  ok("clicking a quick prompt fills the composer with its prompt text", composerVal.includes("请阅读文档并总结核心要点"));
  ok("quick prompt click did NOT send a message (no user bubble, starter still shown)",
    (await bodyText()).includes("总结文档要点") && !(await page.locator('[data-testid="user-message"]').count()));

  // ── 8. Reload: starter survives (server persistence) ─────────
  // A reload resets the workbench selection (no agent auto-opened); the
  // invariant is that selecting the SAME agent again renders the SAME
  // server-persisted starter — nothing was client-only state.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // Click the agent's title in the sidebar (event bubbles to the row div).
  await page.getByText(AGENT_NAME, { exact: true }).first().click();
  await page.waitForTimeout(1200);
  ok("after reload + re-select the welcome message is restored (server persistence)",
    (await bodyText()).includes(created.welcomeMessage.slice(0, 12)));
  ok("after reload + re-select the quick prompts are restored",
    await page.locator("button", { hasText: "总结文档要点" }).isVisible());
  await page.screenshot({ path: `${SHOT_DIR}/06-reload-restored.png`, fullPage: true });

  // ── 8.5 Production mounted DELETE removes the activation key ──
  // The fix-round invariant: DELETE /api/agents/:id (the production delete
  // path funnels through deleteAgentCleanup) must clean agent-capabilities.json
  // — no orphan keys outliving their agents.
  const actStore = () => JSON.parse(fs.readFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), "utf8"));
  ok("pre-delete: activation key present for the created agent", created.id in actStore());
  const delRes = await fetch(`${BASE}/api/agents/${created.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${userToken}` },
  });
  ok("mounted DELETE /api/agents/:id succeeds", delRes.ok, `status=${delRes.status}`);
  ok("mounted DELETE removed the activation key (no orphan)",
    !(created.id in actStore()), `keys=${Object.keys(actStore()).join(",")}`);
  ok("mounted DELETE removed the agent row", (await agentsCount()) === beforeCount);

  // ── 9. Narrow viewport: drawer stays usable ──────────────────
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.waitForTimeout(600);
  ok("narrow viewport: drawer opens and template cards are visible",
    await drawer.isVisible() && (await drawer.innerText()).includes("空白助手"));
  await page.screenshot({ path: `${SHOT_DIR}/07-narrow-viewport.png` });
  await ctx.close();

  await browser.close();
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
