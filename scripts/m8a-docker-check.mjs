#!/usr/bin/env node
/**
 * m8a-docker-check.mjs — M8a (plan §9) 生产 docker 切换实机验收。
 *
 * RUNTIME_MODE=docker + 真模型 + 真容器，一条脚本覆盖计划验收项：
 *   A1  backend boots in docker mode (fresh temp DB, git-pinned agent image)
 *   A2  agent container IPC binds loopback only (P0.2 invariant at switch time)
 *   B   per-agent prompt 真实通路：agent systemPrompt override 的 marker 出现在
 *       容器内真模型回复中
 *   C   普通 governed MCP 真实通路：smoke-mcp (stdio) 经 entitlement +
 *       activation → /opt/agent/mcp 只读挂载 → mcp__smoke-mcp__ping tool_use +
 *       tool_result "pong"
 *   D   M8g docker 换壳复验：控制面漂移（启用技能）→ 下一轮换壳重建容器
 *       （runtime_hot_reload 审计、新容器 id、sdk_init 技能、claudeSessionId
 *       连续 + 历史召回——docker 冷恢复路径）
 *
 * Connector 真实通路不在本脚本（独立跑 `node scripts/m1d-smoke.mjs`，
 * 内含 internal-MCP connector 全链路）。凭据仅从 ambient env 透传，绝不打印。
 *
 * Prereq: eaos-agent image built at the current tip
 *   docker build -f docker/Dockerfile -t eaos-agent:latest .
 * Run:   node scripts/m8a-docker-check.mjs
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";

const MAIN_NM = "/Users/jameslian/Work/projects/simple-chatapp/node_modules";
const require = createRequire(import.meta.url);
const _sqlite = require(path.join(MAIN_NM, "better-sqlite3"));
const Database = _sqlite.Database ?? _sqlite;
const WebSocket = require(path.join(MAIN_NM, "ws"));

const PORT = 3941;
const DB_PATH = "/tmp/m8a-docker.db";
const BASE = `http://127.0.0.1:${PORT}`;
const WT = process.cwd();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "m8a-docker-cwd-"));
const ADMIN_PASS = "m8a-admin-1";
const USER = "m8a-user";
const USER_PASS = "m8a-user-1x";
const SKILL_PLUGIN = "m8a-hot-skill";
const SKILL_NAME = "m8a-marker";
const PROMPT_MARKER = "M8A_PROMPT_MARKER_OK";
const EVIDENCE_DIR = path.join(WT, "docs/06-deployment/evidence/m8a-prod-docker");
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("FATAL: no provider credentials in ambient env (ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN)");
  process.exit(1);
}

// Ambient env may lack AGENT_MODEL (it lives in the main checkout .env).
// Without it the platform model catalog degrades to the "opus" default →
// claude-opus-4-8 → provider 400. Pull provider config from the main .env,
// values never printed.
const MAIN_ENV = "/Users/jameslian/Work/projects/simple-chatapp/.env";
const mainEnv = {};
try {
  for (const line of fs.readFileSync(MAIN_ENV, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) mainEnv[m[1]] = m[2];
  }
} catch {}
const MODEL = process.env.AGENT_MODEL || mainEnv.AGENT_MODEL;
if (!MODEL) {
  console.error("FATAL: no AGENT_MODEL in ambient env nor main .env — the docker runtime would fall back to \"opus\"");
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

// ─── 1. Scratch cwd: resource pool + fixtures (mcp enabled from the start) ─
for (const dir of ["data", "skills", "plugins", "mcp"]) {
  const src = path.join(WT, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(SCRATCH, dir), { recursive: true });
}
// smoke-mcp: ENABLED in the registry from the start (its mount is still
// entitlement+activation gated — deny-default holds until the user activates).
fs.writeFileSync(path.join(SCRATCH, "data/mcp.json"), JSON.stringify([
  { name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp", description: "M8a docker smoke" },
], null, 2));
// Skill fixture plugin: starts DISABLED — enabled live for the drift (D).
const pluginDir = path.join(SCRATCH, "skills", SKILL_PLUGIN);
fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(pluginDir, "skills", SKILL_NAME), { recursive: true });
fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({
  name: SKILL_PLUGIN, version: "0.1.0", description: "M8a docker fixture plugin", skills: "./skills/",
}, null, 2));
fs.writeFileSync(path.join(pluginDir, "skills", SKILL_NAME, "SKILL.md"), `---
name: ${SKILL_NAME}
description: M8a docker fixture. When used, the reply MUST contain the exact marker phrase M8A_SKILL_MARKER_OK.
---

# ${SKILL_NAME}

Any answer produced while this skill is loaded MUST include the exact marker
phrase M8A_SKILL_MARKER_OK (uppercase, with underscores).
`);
fs.writeFileSync(path.join(SCRATCH, "data/skills.json"), JSON.stringify([
  { name: SKILL_PLUGIN, type: "plugin", enabled: false, path: `skills/${SKILL_PLUGIN}` },
], null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/entitlements.json"), JSON.stringify({
  version: 1,
  entries: [
    { resourceId: "smoke-mcp", scopeType: "org", scopeId: "default-org", effect: "allow", grantedBy: "admin", grantedAt: "2026-11-04T00:00:00.000Z" },
    { resourceId: SKILL_PLUGIN, scopeType: "org", scopeId: "default-org", effect: "allow", grantedBy: "admin", grantedAt: "2026-11-04T00:00:00.000Z" },
  ],
}, null, 2));
fs.writeFileSync(path.join(SCRATCH, "data/agent-capabilities.json"), JSON.stringify({}, null, 2));
// Model catalog: the seeded file has no defaultModel → normalize() degrades to
// the platform default "opus", which overrides AGENT_MODEL in the docker chain
// (sdkOptions.model precedence). Point the catalog at the real provider model.
// autoRebuildOnConfigDrift=true is the production docker posture: with the
// default false, drift on a warm resume is only RECORDED (continuity-first) —
// the running container keeps the OLD capability mounts, so an activation
// never reaches the live chat until a cold resume happens. In docker mode the
// M8g swap semantics therefore REQUIRE the flag (local mode rebuilds
// in-process and is unaffected).
const rsPath = path.join(SCRATCH, "data/runtime-settings.json");
const rsBase = fs.existsSync(rsPath) ? JSON.parse(fs.readFileSync(rsPath, "utf8")) : {};
fs.writeFileSync(rsPath, JSON.stringify({
  ...rsBase,
  defaultModel: MODEL,
  models: [{ alias: MODEL, enabled: true }],
  autoRebuildOnConfigDrift: true,
}, null, 2));

// ─── 2. Real backend (docker runtime, fresh DB) ─────────────────────────
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
    ...mainEnv,
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    RUNTIME_MODE: "docker",
    ALLOW_DEV_JWT_SECRET: "1",
    ENTITLEMENTS_FILE: path.join(SCRATCH, "data/entitlements.json"),
    AGENT_CAPABILITIES_FILE: path.join(SCRATCH, "data/agent-capabilities.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
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
ok("A1: backend ready (RUNTIME_MODE=docker, port 3941, fresh DB)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-25).join(""));
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
  process.exit(1);
}

// ─── 3. Read-side DB access ─────────────────────────────────────────────
const openDb = () => new Database(DB_PATH, { readonly: true, fileMustExist: true });
const events = (chatId, type) =>
  openDb().prepare(`SELECT payload_json FROM agent_events WHERE chat_id = ? AND event_type = ? ORDER BY sequence`).all(chatId, type)
    .map((r) => JSON.parse(r.payload_json));
const countEvents = (chatId, type) =>
  openDb().prepare(`SELECT COUNT(*) AS n FROM agent_events WHERE chat_id = ? AND event_type = ?`).get(chatId, type).n;
const claudeSessionIdOf = (username, chatId) =>
  openDb().prepare(`SELECT s.claude_session_id AS sid FROM agent_sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ? AND s.chat_id = ?`).get(username, chatId)?.sid ?? null;
async function waitDb(cond, timeoutMs = 120000, label = "db condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(500);
  }
  console.error(`timeout waiting for: ${label}`);
  return false;
}

// ─── 4. Provision actors ────────────────────────────────────────────────
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
await api("POST", "/api/admin/users", { username: USER, password: USER_PASS, role: "user" }, adminToken);
const uFirst = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: USER_PASS }) })).json();
if (uFirst?.mustChangePassword && uFirst?.token) {
  await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${uFirst.token}` }, body: JSON.stringify({ oldPassword: USER_PASS, newPassword: USER_PASS + "x" }) });
}
const userToken = (await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: uFirst?.mustChangePassword ? USER_PASS + "x" : USER_PASS }) })).json())?.token ?? "";
ok("A1: tokens acquired (admin + user)", !!adminToken && !!userToken);

// Agent with a per-agent systemPrompt override (the B real path). The governed
// expert-creation contract (agent-builder) is the ONLY route that persists
// system_prompt; legacy POST /api/agents creates a plain chat and ignores it.
const created = await api("POST", "/api/agent-builder", {
  templateId: "blank",
  name: "M8a docker 验收",
  systemPrompt: `你是生产验收助手。规则：每条回复的结尾都必须包含确切标记 ${PROMPT_MARKER}（大写、含下划线），不得解释。`,
}, userToken);
ok("B: agent created with per-agent systemPrompt override", created.status === 201 && !!created.json?.agent?.id, `status=${created.status}`);
const chatId = created.json?.agent?.id;
if (!chatId) {
  console.error(`FATAL: agent creation failed — response: ${JSON.stringify(created.json).slice(0, 300)}`);
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
  for (const c of containerIds()) { try { execSync(`docker rm -f ${c}`, { stdio: "ignore" }); } catch {} }
  process.exit(1);
}

// ─── 5. WebSocket turn runner ───────────────────────────────────────────
function runTurn(content, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(userToken)}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ frames, timedOut: true });
    }, timeoutMs);
    ws.on("error", (e) => { clearTimeout(timer); reject(new Error(`ws error: ${e.message}`)); });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", chatId }));
      setTimeout(() => ws.send(JSON.stringify({ type: "chat", chatId, content })), 300);
    });
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      frames.push(m);
      // C real path: governed MCP tools are approval-gated in the container
      // (agent-entry fail-closed hook). Approve over the SAME WS approval
      // protocol the UI uses — this is the production approval path, not a
      // bypass. Without it the container waits out APPROVAL_TIMEOUT_MS (10 min
      // default) and later turns pile up behind the pending approval.
      if (m.type === "approval_request" && m.id) {
        ws.send(JSON.stringify({ type: "approval_response", chatId, id: m.id, approved: true }));
      }
      if (m.type === "result" || m.type === "error") {
        clearTimeout(timer);
        setTimeout(() => { try { ws.close(); } catch {} resolve({ frames }); }, 500);
      }
    });
  });
}
const lastAssistant = () => String(events(chatId, "assistant_message").at(-1)?.content ?? "");
const containerIds = () => {
  try {
    return execSync(
      `docker ps -a --filter label=app=eaos-agent --format '{{.ID}}'`,
      { encoding: "utf8" }
    ).trim().split("\n").filter(Boolean);
  } catch { return []; }
};

// ─── B: per-agent prompt real path (turn 1, baseline runtime) ────────────
let turn1;
try {
  turn1 = await runTurn("请记住我的暗号：芒果糯米糍。确认记住即可，不要展开。");
} catch (e) { ok("B: turn 1 completed", false, e.message); turn1 = { frames: [] }; }
ok("B: turn 1 completed (real model, container runtime)",
  await waitDb(() => countEvents(chatId, "result") >= 1, 180000, "turn1 result"));
ok("B: per-agent prompt override reached the model (marker in reply)",
  lastAssistant().includes(PROMPT_MARKER), lastAssistant().slice(-120));
const sidBefore = claudeSessionIdOf(USER, chatId);
ok("B: claudeSessionId captured (docker cold-resume anchor)", !!sidBefore);
const containersAfterT1 = containerIds();
ok("A2: agent container running", containersAfterT1.length >= 1);
// A2: IPC port binding is loopback-only (P0.2 invariant).
let loopbackOk = false, bindingDetail = "";
for (const cid of containersAfterT1) {
  try {
    const inspect = JSON.parse(execSync(`docker inspect ${cid}`, { encoding: "utf8" }))[0];
    const bindings = Object.values(inspect.NetworkSettings.Ports ?? {}).flat().filter(Boolean);
    bindingDetail = JSON.stringify(bindings);
    loopbackOk = bindings.every((b) => b.HostIp === "127.0.0.1");
  } catch {}
}
ok("A2: container IPC binds loopback only", loopbackOk, bindingDetail);

// ─── C: governed ordinary MCP real path (activation → swap → ping) ──────
const actMcp = await api("PUT", `/api/agents/${chatId}/capabilities`, { resources: [{ resourceId: "smoke-mcp", enabled: true }] }, userToken);
ok("C: user activated smoke-mcp on the agent (workbench path)", actMcp.status === 200, `status=${actMcp.status}`);
let turn2;
try {
  turn2 = await runTurn("请调用 smoke-mcp 的 ping 工具，然后原样告诉我它返回了什么。");
} catch (e) { ok("C: turn 2 completed", false, e.message); turn2 = { frames: [] }; }
const allToolUse = events(chatId, "tool_use");
const mcpUse = allToolUse.filter((e) => String(e.toolName ?? e.tool_name ?? "").startsWith("mcp__smoke-mcp"));
ok("C: turn 2 completed", await waitDb(() => countEvents(chatId, "result") >= 2, 180000, "turn2 result"));
ok("C: model invoked mcp__smoke-mcp__ping inside the container", mcpUse.length >= 1,
  JSON.stringify(allToolUse.map((e) => e.toolName ?? e.tool_name)).slice(0, 200));
const toolResults = events(chatId, "tool_result");
const pingResult = toolResults.find((r) => JSON.stringify(r).includes("pong"));
ok("C: ping tool_result contains pong (real stdio MCP in container)", !!pingResult);
ok("C: hot swap fired for the drift (runtime_hot_reload audit)",
  countEvents(chatId, "runtime_hot_reload") === 1, `count=${countEvents(chatId, "runtime_hot_reload")}`);
ok("C: new container after swap (container id changed)",
  containerIds().some((c) => !containersAfterT1.includes(c)));
ok("C: claudeSessionId continuous across the swap (docker cold resume)",
  claudeSessionIdOf(USER, chatId) === sidBefore, `${sidBefore?.slice(0, 8)} → ${claudeSessionIdOf(USER, chatId)?.slice(0, 8)}`);

// ─── D: M8g docker hot-swap re-verification (skill enable → swap #2) ─────
const enableSkill = await api("POST", `/api/admin/skills/${SKILL_PLUGIN}/enable`, {}, adminToken);
ok("D: admin enabled the skill in the registry", enableSkill.status === 200 || enableSkill.status === 204, `status=${enableSkill.status}`);
const actSkill = await api("PUT", `/api/agents/${chatId}/capabilities`, { resources: [{ resourceId: SKILL_PLUGIN, enabled: true }] }, userToken);
ok("D: user activated the skill on the agent", actSkill.status === 200, `status=${actSkill.status}`);
let turn3;
try {
  turn3 = await runTurn(`先告诉我我之前说的暗号是什么，再使用 ${SKILL_NAME} 技能回答。`);
} catch (e) { ok("D: turn 3 completed", false, e.message); turn3 = { frames: [] }; }
ok("D: turn 3 completed", await waitDb(() => countEvents(chatId, "result") >= 3, 180000, "turn3 result"));
const t3Reply = lastAssistant();
ok("D: history survived swap #2 (model recalls the turn-1 secret)", t3Reply.includes("芒果糯米糍"), t3Reply.slice(0, 120));
ok("D: skill usable this turn (marker in reply)", t3Reply.includes("M8A_SKILL_MARKER_OK"), t3Reply.slice(-120));
const hotCount = countEvents(chatId, "runtime_hot_reload");
ok("D: exactly two hot swaps total, both metadata-only", hotCount === 2, `count=${hotCount}`);
const hotEvents = events(chatId, "runtime_hot_reload");
ok("D: swap audits are metadata-only (version hashes only)",
  hotEvents.every((h) => JSON.stringify(Object.keys(h).sort()) === JSON.stringify(["from", "to"])));
const lastInit = events(chatId, "sdk_init").at(-1);
ok("D: new runtime reports the skill (sdk_init)",
  JSON.stringify(lastInit?.skills ?? lastInit?.tools ?? lastInit ?? {}).includes(SKILL_PLUGIN) ||
  JSON.stringify(lastInit ?? {}).includes(SKILL_PLUGIN));

// ─── 6. Teardown + evidence ─────────────────────────────────────────────
try { process.kill(-server.pid, "SIGKILL"); } catch {}
for (const c of containerIds()) { try { execSync(`docker rm -f ${c}`, { stdio: "ignore" }); } catch {} }
fs.writeFileSync(path.join(EVIDENCE_DIR, "docker-check.txt"), results.join("\n") + "\n");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
