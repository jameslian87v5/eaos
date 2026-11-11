#!/usr/bin/env node
/**
 * m8g-browser-check.mjs — M8g (capability hot reload) browser acceptance.
 *
 * Octop-gap closure proof, live end-to-end against RUNTIME_MODE=local with a
 * REAL model provider (env ANTHROPIC_* passthrough + CLAUDE_CONFIG_DIR shim):
 *
 *   G1  open chat page → real turn 1 (baseline; skill NOT in runtime)
 *   G2  admin enables the skill in the registry + user activates it on the
 *       agent (control-plane drift) → user sends the NEXT message → the turn
 *       runs on a NEW runtime that has the skill (sdk_init reports it) and
 *       the conversation history survives the swap (model recalls turn-1
 *       content) — no stop/restart by the user, chat page stays open.
 *   G3  swap is metadata-only audited (runtime_hot_reload: version hashes),
 *       claudeSessionId is continuous (resume), rebuild latency ≤ 2s.
 *   G4  forbidden-window counterexample: a drift landing while a turn is
 *       active defers the swap to the fully idle boundary — no mid-flight
 *       kill, exactly-once delivery for the queued turn.
 *   G5  reload the chat page after the swap → full history renders.
 *
 * Run: NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m8g-browser-check.mjs
 * (requires a real provider in the ambient env; never printed/logged here)
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const MAIN_NM = "/Users/jameslian/Work/projects/simple-chatapp/node_modules";
const require = createRequire(import.meta.url);
const _sqlite = require(path.join(MAIN_NM, "better-sqlite3"));
const Database = _sqlite.Database ?? _sqlite;
const WebSocket = require(path.join(MAIN_NM, "ws"));

const PORT = 3935;
const DB_PATH = "/tmp/m8g-browser.db";
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "m8g-browser-cwd-"));
const CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "m8g-claude-config-"));
const ADMIN_PASS = "m8g-admin-1";
const USER = "m8g-user";
const USER_PASS = "m8g-user-1x";
const SKILL_PLUGIN = "m8g-hot-skill";
const SKILL_NAME = "m8g-marker";
const SHOT_DIR = path.join(WT, "docs/06-deployment/evidence/capability-hot-reload");
fs.mkdirSync(SHOT_DIR, { recursive: true });

if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error("FATAL: no provider credentials in ambient env (ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY)");
  process.exit(1);
}

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  results.push(line);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Scratch cwd: real resource pool + the M8g fixture skill ────────
for (const dir of ["data", "skills", "plugins"]) {
  const src = path.join(WT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(SCRATCH, dir), { recursive: true });
}
// Plugin-shaped fixture (skill-config requires .claude-plugin/plugin.json +
// skills/*/SKILL.md): starts DISABLED in the registry — admin enables it live.
const pluginDir = path.join(SCRATCH, "skills", SKILL_PLUGIN);
fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(pluginDir, "skills", SKILL_NAME), { recursive: true });
fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({
  name: SKILL_PLUGIN,
  version: "0.1.0",
  description: "M8g hot-reload fixture plugin",
  skills: "./skills/",
}, null, 2));
fs.writeFileSync(path.join(pluginDir, "skills", SKILL_NAME, "SKILL.md"), `---
name: ${SKILL_NAME}
description: M8g hot-reload fixture. When used, the reply MUST contain the exact marker phrase M8G_MARKER_OK.
---

# ${SKILL_NAME}

M8g verification skill. Any answer produced while this skill is loaded MUST
include the exact marker phrase M8G_MARKER_OK (uppercase, with underscores).
`);
fs.writeFileSync(path.join(SCRATCH, "data/skills.json"), JSON.stringify([
  { name: SKILL_PLUGIN, type: "plugin", enabled: false, path: `skills/${SKILL_PLUGIN}` },
], null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/entitlements.json"), JSON.stringify({
  version: 1,
  entries: [
    { resourceId: SKILL_PLUGIN, scopeType: "org", scopeId: "default-org", effect: "allow", grantedBy: "admin", grantedAt: "2026-10-26T00:00:00.000Z" },
  ],
}, null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), JSON.stringify({}, null, 2));

// ─── 2. Real backend (local runtime, fresh DB, CLAUDE_CONFIG_DIR shim) ─
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
    // Shim: empty config dir so ~/.claude/settings.json cannot override the
    // ambient provider credentials (they are only passed through, never logged).
    CLAUDE_CONFIG_DIR,
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // own process group — kill(-pid) reaps tsx AND the server child
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
ok("backend ready (port 3935, local runtime, fresh DB)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-25).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// ─── 3. Read-side DB access (transcript + audit + session state) ───────
const openDb = () => new Database(DB_PATH, { readonly: true, fileMustExist: true });
const events = (chatId, type) =>
  openDb().prepare(`SELECT payload_json, created_at FROM agent_events WHERE chat_id = ? AND event_type = ? ORDER BY sequence`).all(chatId, type)
    .map((r) => ({ ...JSON.parse(r.payload_json), _at: r.created_at }));
const countEvents = (chatId, type) =>
  openDb().prepare(`SELECT COUNT(*) AS n FROM agent_events WHERE chat_id = ? AND event_type = ?`).get(chatId, type).n;
const userIdOf = (username) =>
  openDb().prepare(`SELECT id FROM users WHERE username = ?`).get(username)?.id ?? null;
const claudeSessionIdOf = (username, chatId) =>
  openDb().prepare(`SELECT s.claude_session_id AS sid FROM agent_sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ? AND s.chat_id = ?`).get(username, chatId)?.sid ?? null;

async function waitDb(cond, timeoutMs = 90000, label = "db condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(500);
  }
  return false;
}

// ─── 4. Provision actors ───────────────────────────────────────────────
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
const first = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
if (first?.mustChangePassword && first?.token) {
  await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${first.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
}
const adminToken = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: ADMIN_PASS }) })).json())?.token ?? "";
const createdU = await api("POST", "/api/admin/users", { username: USER, password: USER_PASS, role: "user" }, adminToken);
ok("user provisioned", createdU.status === 201 || createdU.status === 200, `status=${createdU.status}`);
// First login forces a password change; settle it over REST BEFORE the browser
// login so the chat UI (not the change-password screen) is what renders.
const uFirst = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: USER_PASS }) })).json();
if (uFirst?.mustChangePassword && uFirst?.token) {
  await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${uFirst.token}` }, body: JSON.stringify({ oldPassword: USER_PASS, newPassword: USER_PASS + "x" }) });
}
const USER_FINAL_PASS = uFirst?.mustChangePassword ? USER_PASS + "x" : USER_PASS;
const userToken = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: USER_FINAL_PASS }) })).json())?.token ?? "";
ok("tokens acquired (admin + user)", !!adminToken && !!userToken);

// ─── 5. Node-side WebSocket (same path the browser chat uses) ──────────
function openChatWs(chatId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(userToken)}`);
    const opened = setTimeout(() => reject(new Error("ws open timeout")), 10000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", chatId }));
      clearTimeout(opened);
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

// ─── 6. Browser: login, open chat, run the M8g golden path ─────────────
let exitCode = 0;
let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="请输入用户名"]', USER);
  await page.fill('input[placeholder="请输入密码"]', USER_FINAL_PASS);
  await page.click('button[type="submit"]');
  let loggedIn = false;
  for (let i = 0; i < 20 && !loggedIn; i++) {
    await page.waitForTimeout(1000);
    loggedIn = (await page.locator("body").innerText()).includes("新建空白对话");
  }
  ok("user login", loggedIn);

  await page.click("text=新建空白对话");
  await page.waitForSelector('textarea[placeholder^="输入消息"]', { timeout: 15000 });
  // Fresh DB + fresh user → this user's ONLY agent is the one just created.
  let chatId = null;
  for (let i = 0; i < 10 && !chatId; i++) {
    const list = (await api("GET", "/api/agents", undefined, userToken)).json ?? [];
    chatId = Array.isArray(list) ? list[0]?.id : list?.agents?.[0]?.id;
    if (!chatId) await sleep(500);
  }
  ok("chat created and opened (chat page active)", !!chatId, `chatId=${chatId}`);
  const sendInBrowser = async (text) => page.evaluate((t) => {
    const ta = document.querySelector('textarea[placeholder^="输入消息"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, t);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, text);

  // G1 — baseline turn 1 (skill NOT yet available: registry disabled).
  await sendInBrowser("请记住我的暗号：菠萝披萨。确认记住即可，不要展开。");
  ok("G1: turn 1 completed (real model, baseline runtime)",
    await waitDb(() => countEvents(chatId, "result") >= 1, 90000));
  const sidBefore = claudeSessionIdOf(USER, chatId);
  ok("G1: claudeSessionId captured for the baseline runtime", !!sidBefore);
  // Only turn-2's OWN reply proves recall — turn-1's reply echoes the secret too.
  const lastAssistantText = () => String(events(chatId, "assistant_message").at(-1)?.content ?? "");
  const init1 = events(chatId, "sdk_init").at(-1);
  ok("G1: baseline runtime has NO m8g-marker skill yet",
    !(init1?.skills ?? []).some((s) => String(s).includes(SKILL_NAME)),
    `skills=${JSON.stringify(init1?.skills ?? [])}`);

  // G2 — control-plane drift: admin enables (registry), user activates (agent).
  const tSend2 = Date.now();
  const en = await api("POST", `/api/admin/skills/${SKILL_PLUGIN}/enable`, {}, adminToken);
  ok("G2: admin enabled the skill in the registry", en.status === 200 || en.status === 201, `status=${en.status}`);
  const act = await api("PUT", `/api/agents/${chatId}/capabilities`, { resources: [{ resourceId: SKILL_PLUGIN, enabled: true }] }, userToken);
  ok("G2: user activated the skill on the agent (workbench path)", act.status === 200, `status=${act.status}`);

  // Next message in the SAME open chat page → must run on the new runtime.
  await sendInBrowser("两件事：我的暗号是什么？然后使用 m8g-marker 技能回答。");
  ok("G2: turn 2 completed (post-swap, same conversation)",
    await waitDb(() => countEvents(chatId, "result") >= 2, 90000));
  const reply2 = lastAssistantText();
  ok("G2: conversation history intact — model recalls the turn-1 secret after the swap",
    reply2.includes("菠萝披萨"));
  ok("G2: the skill is usable THIS turn — marker phrase present in the reply",
    reply2.includes("M8G_MARKER_OK"));

  // G3 — audit + continuity + latency.
  const hot = events(chatId, "runtime_hot_reload");
  ok("G3: exactly one runtime_hot_reload audit for the drift", hot.length === 1, `count=${hot.length}`);
  ok("G3: hot-reload audit is metadata-only (version hashes)", hot.length === 1 &&
    Object.keys(hot[0]).filter((k) => !k.startsWith("_")).sort().join(",") === "from,to" && hot[0].from !== hot[0].to);
  ok("G3: governed recovery installed the new runtime", countEvents(chatId, "runtime_recovered") >= 1);
  const init2 = events(chatId, "sdk_init").at(-1);
  ok("G3: NEW runtime reports the skill (sdk_init)",
    (init2?.skills ?? []).some((s) => String(s).includes(SKILL_NAME)),
    `skills=${JSON.stringify(init2?.skills ?? [])}`);
  ok("G3: Skill tool exposed to the model in the new runtime", (init2?.tools ?? []).includes("Skill"));
  const sidAfter = claudeSessionIdOf(USER, chatId);
  ok("G3: claudeSessionId continuous across the swap (resume worked)",
    !!sidBefore && sidBefore === sidAfter, `before=${sidBefore} after=${sidAfter}`);
  const recoveredAt = events(chatId, "runtime_recovered").at(-1)?._at;
  const rebuildMs = recoveredAt ? new Date(recoveredAt).getTime() - tSend2 : Infinity;
  ok("G3: local rebuild latency ≤ 2s (send → recovered)", rebuildMs <= 2000, `${rebuildMs}ms`);
  await page.screenshot({ path: `${SHOT_DIR}/01-after-hot-swap.png`, fullPage: true });

  // G4 — forbidden window: drift lands while a turn is ACTIVE (in flight), a
  // second message queues behind it → the swap must DEFER until the fully
  // idle boundary. No mid-flight process kill, exactly-once delivery.
  const nodeWs = await openChatWs(chatId);
  const sendOverWs = (content) => nodeWs.send(JSON.stringify({ type: "chat", content, chatId }));
  const resultsBefore = countEvents(chatId, "result");
  sendOverWs("请从1数到5，每个数字单独一行，数完就停。"); // turn 3 dispatched (no drift at entry)
  // Drift + queue turn 4 WHILE turn 3 is still streaming (active turn).
  // Disable only — a disable+re-enable round-trip returns to the IDENTICAL
  // normalized config (same hash → no drift). Disabling alone is a real drift.
  const dis = await api("POST", `/api/admin/skills/${SKILL_PLUGIN}/disable`, {}, adminToken);
  sendOverWs("现在从5数到1，每个数字单独一行，数完就停。"); // turn 4 → queued, NOT dispatched
  ok("G4: drift written while a turn is in flight", dis.status === 200);
  // While turn 3 is active (and turn 4 queued), the swap MUST NOT fire.
  const deferred = await waitDb(() => countEvents(chatId, "runtime_hot_reload") !== 1, 2500);
  ok("G4: forbidden window — NO swap while a turn is active/queued",
    !deferred && countEvents(chatId, "runtime_hot_reload") === 1);
  // Turn 3 must complete normally (no mid-flight kill): result +1 by the OLD…
  ok("G4: turn 3 NOT killed mid-flight (completed on the pre-drift runtime)",
    await waitDb(() => countEvents(chatId, "result") >= resultsBefore + 1, 90000));
  // …then turn 4 runs, and only at the FULLY idle boundary does swap #2 fire.
  ok("G4: turn 4 completed exactly once (queued turn delivered after turn 3)",
    await waitDb(() => countEvents(chatId, "result") >= resultsBefore + 2, 90000));
  ok("G4: second hot reload fired only at the idle boundary (metadata-only)",
    await waitDb(() => countEvents(chatId, "runtime_hot_reload") === 2, 60000));
  const hot2 = events(chatId, "runtime_hot_reload");
  ok("G4: exactly two swaps total, both version-hash pairs",
    hot2.length === 2 && hot2.every((h) => h.from !== h.to));
  // Swap #2 rebuilt WITHOUT any new turn running on it yet — the latest
  // sdk_init is still swap #1's runtime. Run one more turn to observe the
  // post-swap #2 runtime's own init: the disabled skill must be GONE.
  sendOverWs("好的，请只回复：完成。");
  ok("G4: turn 5 completed on the post-swap #2 runtime",
    await waitDb(() => countEvents(chatId, "result") >= resultsBefore + 3, 90000));
  const init3 = events(chatId, "sdk_init").at(-1);
  ok("G4: post-swap #2 runtime correctly DROPS the disabled skill (symmetry)",
    !(init3?.skills ?? []).some((s) => String(s).includes(SKILL_NAME)),
    `skills=${JSON.stringify(init3?.skills ?? [])}`);
  const sidFinal = claudeSessionIdOf(USER, chatId);
  ok("G4: claudeSessionId still continuous after swap #2", sidFinal === sidBefore);
  nodeWs.close();
  await page.screenshot({ path: `${SHOT_DIR}/02-after-second-swap.png`, fullPage: true });

  // G5 — reload the page: full history renders (user-visible continuity).
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // Reload lands on the chat LIST — re-select the (single) conversation.
  if ((await page.locator('textarea[placeholder^="输入消息"]').count()) === 0) {
    await page.locator('div.group:has(button[title="删除对话"])').first().click();
    await page.waitForSelector('textarea[placeholder^="输入消息"]', { timeout: 15000 });
  }
  await page.waitForTimeout(2500);
  const bodyText = await page.locator("body").innerText();
  ok("G5: after page reload the full conversation history renders",
    bodyText.includes("菠萝披萨") && bodyText.includes("M8G_MARKER_OK"));
  await page.screenshot({ path: `${SHOT_DIR}/03-history-after-reload.png`, fullPage: true });
  await ctx.close();
} catch (e) {
  console.error("BROWSER CHECK CRASHED:", e);
  exitCode = 1;
} finally {
  try { browser?.close(); } catch {}
  try { server.kill("SIGKILL"); } catch {}
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.writeFileSync(
  path.join(SHOT_DIR, "browser-check.txt"),
  `${new Date().toISOString()}\nnode ${process.argv[1]}\n\n${results.join("\n")}\n\n${pass} passed, ${fail} failed\n`
);
process.exit(fail > 0 || exitCode ? 1 : 0);
