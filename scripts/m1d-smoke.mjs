#!/usr/bin/env node
/**
 * m1d-smoke.mjs — Octop absorption M1d: real Docker + API acceptance.
 *
 * Proves, against a REAL backend in RUNTIME_MODE=docker with a temp DB:
 *   1. fixture upstream with a unique marker + Authorization-echo guard;
 *   2. admin API flow: create internal-rest instance → write credential →
 *      enable → org entitlement → agent activation;
 *   3. deny-default: an UNCONFIGURED agent's diagnostics show no connector MCP;
 *   4. a real agent container calls the connector `rest_request` tool and the
 *      non-error tool_result contains the fixture marker; final result ok;
 *   5. isolation: raw credential absent from container env / docker logs /
 *      host server log / governance audits / any response; only the
 *      short-lived internal-mcp token appears in runtime MCP config;
 *   6. live revocation with the REAL minted token: disable → immediate 401;
 *      runtime stop → immediate 401.
 *
 * Usage: node scripts/m1d-smoke.mjs   (from repo root; uses .env for provider)
 */
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import { WebSocket } from "ws";

const PORT = 3902;
const DB_PATH = "/tmp/m1d-smoke.db";
const BASE = `http://127.0.0.1:${PORT}`;
const MARKER = `m1d-marker-${Date.now().toString(36)}`;
const CRED = `m1d-cred-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const RESULTS = [];
let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  RESULTS.push(line);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(path, opts = {}) {
  const { token, ...rest } = opts;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ─── 1. Fixture upstream (unique marker + auth echo guard) ──────────
const fixture = http.createServer((req, res) => {
  const route = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");
  if (route === "/hello") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, marker: MARKER, route }));
    return;
  }
  if (route === "/echo-auth") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ echoedAuth: String(req.headers.authorization ?? "") }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise((r) => fixture.listen(0, "0.0.0.0", r));
const FIXTURE_PORT = fixture.address().port;
console.log(`[m1d] fixture upstream on :${FIXTURE_PORT}, marker=${MARKER}`);

// ─── 2. Real backend, Docker runtime mode, temp DB ─────────────────
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
const server = spawn("npx", ["tsx", "server/server.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    RUNTIME_MODE: "docker",
    ALLOW_DEV_JWT_SECRET: "1",
    CONNECTOR_MCP_BASE_URL: `http://host.docker.internal:${PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (d) => { const s = d.toString(); serverLog.push(s); process.stdout.write(`[server] ${s}`); });
server.stderr.on("data", (d) => { const s = d.toString(); serverLog.push(s); process.stderr.write(`[server:err] ${s}`); });

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(1000);
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok || r.status === 401 || r.status === 404) ready = true; } catch {}
}
if (!ready) {
  // fall back to log-based readiness
  ready = serverLog.join("").includes("Server running");
}
ok("backend ready (RUNTIME_MODE=docker, port 3902, temp DB)", ready);

try {
  // ─── 3. Admin session (fresh DB: change password first) ────────────
  let login = await jfetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin123" }) });
  if (login.json?.mustChangePassword) {
    await jfetch("/api/auth/change-password", { method: "POST", token: login.json.token, body: JSON.stringify({ oldPassword: "admin123", newPassword: "m1d-admin-1" }) });
    login = await jfetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "m1d-admin-1" }) });
  }
  const T = login.json?.token;
  ok("admin login", !!T);

  // Environment wiring (not a product feature): a fresh DB seeds the platform
  // default alias "opus" with model_id NULL, so the SDK resolves the alias to
  // claude-opus-4-8 and the Zhipu provider rejects it. Map the alias to the
  // provider model exactly as the main checkout's catalog does.
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("npx", ["tsx", "-e",
      `import Database from "better-sqlite3"; const db = new Database("${DB_PATH}"); db.prepare("UPDATE model_catalog SET model_id = 'glm-5.2' WHERE alias = 'opus'").run(); db.close();`],
      { stdio: "ignore" });
  } catch {}

  // ─── 4. Chats (configured + unconfigured agent) ───────────────────
  const chatA = await jfetch("/api/chats", { method: "POST", token: T, body: JSON.stringify({ name: "m1d-connector-agent" }) });
  const agentId = chatA.json?.id;
  const chatB = await jfetch("/api/chats", { method: "POST", token: T, body: JSON.stringify({ name: "m1d-unconfigured-agent" }) });
  const plainAgentId = chatB.json?.id;
  ok("created configured + unconfigured agents", !!agentId && !!plainAgentId, `${agentId} / ${plainAgentId}`);

  // ─── 5. Connector admin flow ──────────────────────────────────────
  const created = await jfetch("/api/admin/connectors/instances", {
    method: "POST", token: T,
    // baseUrl is consumed HOST-side (rest_request fetches from the host
    // process) — use the host's loopback, NOT the container's
    // host.docker.internal view.
    body: JSON.stringify({ catalogKind: "internal-rest", name: "m1d-fixture", baseUrl: `http://127.0.0.1:${FIXTURE_PORT}` }),
  });
  const instanceId = created.json?.instance?.id;
  ok("create internal-rest instance (draft)", created.status === 201 && !!instanceId);

  const credWrite = await jfetch(`/api/admin/connectors/instances/${instanceId}/credentials`, {
    method: "PUT", token: T, body: JSON.stringify({ values: { apiToken: CRED } }),
  });
  ok("write credential → ready", credWrite.status === 200 && credWrite.json?.instance?.status === "ready" && !credWrite.text.includes(CRED));

  const enabled = await jfetch(`/api/admin/connectors/instances/${instanceId}/enable`, { method: "POST", token: T });
  ok("enable instance", enabled.status === 200 && enabled.json?.instance?.status === "enabled");

  const ent = await jfetch(`/api/admin/capabilities/connector:${instanceId}/entitlements`, {
    method: "PUT", token: T,
    body: JSON.stringify({ entries: [{ scopeType: "org", scopeId: "default-org", effect: "allow" }] }),
  });
  ok("org-scope entitlement allow", ent.status === 200, `entries=${ent.json?.entries?.length}`);

  const act = await jfetch(`/api/agents/${agentId}/capabilities`, {
    method: "PUT", token: T,
    body: JSON.stringify({ resources: [{ resourceId: `connector:${instanceId}`, enabled: true }] }),
  });
  ok("agent activation", act.status === 200 && JSON.stringify(act.json).includes(`connector:${instanceId}`));

  // ─── 6. Deny-default: unconfigured agent gets NO connector ────────
  // `configured` is the LIVE control-plane intersection (activation ∩ entitled).
  const diagPlain = await jfetch(`/api/admin/agents/${plainAgentId}/diagnostics`, { token: T });
  const plainDump = JSON.stringify(diagPlain.json ?? {});
  ok("deny-default: unconfigured agent has no connector capability", !plainDump.includes(`connector-${instanceId}`) && !plainDump.includes(`connector:${instanceId}`));

  // Configured agent: LIVE intersection includes the connector; no secrets serialized.
  const diag = await jfetch(`/api/admin/agents/${agentId}/diagnostics`, { token: T });
  const diagDump = JSON.stringify(diag.json ?? {});
  ok("configured agent LIVE intersection includes the connector", diagDump.includes(`connector:${instanceId}`));
  ok("diagnostics never serialize credential/token", !diagDump.includes(CRED) && !diagDump.includes("Bearer "));

  // ─── 7. Real agent container flow over WS ────────────────────────
  const events = [];
  let approvalCount = 0;
  const wsDone = new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${T}`);
    const hardTimeout = setTimeout(() => resolve("timeout"), 300_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", chatId: agentId }));
      setTimeout(() => {
      ws.send(JSON.stringify({ type: "chat", chatId: agentId, content: `请调用 rest_request 工具：method=GET，path=/hello。不要用 Bash/curl，只用 rest_request 工具，然后把工具返回原样告诉我。` }));
      }, 500);
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.chatId !== agentId && msg.type !== "system") return;
      events.push(msg);
      if (msg.type === "tool_use") console.log(`[ws] tool_use ${msg.toolName} ${JSON.stringify(msg.toolInput ?? {}).slice(0, 120)}`);
      if (msg.type === "assistant_message") console.log(`[ws] assistant: ${String(msg.content ?? msg.text ?? "").slice(0, 300)}`);
      if (msg.type === "error") console.log(`[ws] error: ${JSON.stringify(msg).slice(0, 300)}`);
      if (msg.type === "approval_request") {
        approvalCount++;
        const allowRest = String(msg.toolName ?? "").includes("rest_request");
        console.log(`[ws] approval_request ${msg.toolName} → ${allowRest ? "allow" : "deny"}`);
        ws.send(JSON.stringify({ type: "approval_response", chatId: agentId, id: msg.id, approved: allowRest, alwaysAllow: false }));
      }
      if (msg.type === "result") {
        clearTimeout(hardTimeout);
        resolve("done");
        ws.close();
      }
    });
    ws.on("error", (e) => { console.error(`[ws error] ${e.message}`); });
  });
  const wsOutcome = await wsDone;
  const allEvents = events.map((e) => e.type).join(",");
  console.log(`[m1d] ws outcome=${wsOutcome} events=${allEvents}`);
  ok("agent turn completed (result event)", wsOutcome === "done", `events=${allEvents.slice(0, 200)}`);

  const toolUse = events.find((e) => e.type === "tool_use" && String(e.toolName ?? "").includes("rest_request"));
  ok("SDK/tool event names the connector rest_request tool", !!toolUse, toolUse?.toolName ?? "none");

  if (toolUse) {
    const tr = events.find((e) => e.type === "tool_result" && e.toolId === toolUse.toolId);
    ok("matching non-error tool_result", !!tr && tr.isError !== true, `isError=${tr?.isError}`);
    ok("tool_result contains the fixture marker", !!tr && String(tr.output ?? "").includes(MARKER));
    ok("tool_result carries no raw credential", !tr || !String(tr.output ?? "").includes(CRED));
  }

  const finalResult = events.find((e) => e.type === "result");
  ok("final agent result succeeds", !!finalResult && finalResult.isError !== true, String(finalResult?.subtype ?? ""));

  // ─── 8. Isolation from live Docker state ─────────────────────────
  // Post-runtime diagnostics: the resolved snapshot must show the connector
  // http MCP (what the real container actually received), secret-free.
  const diagAfter = await jfetch(`/api/admin/agents/${agentId}/diagnostics`, { token: T });
  const afterDump = JSON.stringify(diagAfter.json?.resolved ?? {});
  ok("resolved snapshot shows connector http MCP (post-runtime)", afterDump.includes(`connector-${instanceId}`) && afterDump.includes('"type":"http"'));
  ok("resolved snapshot is secret-free", !afterDump.includes(CRED) && !afterDump.includes("Bearer "));

  await sleep(1500);
  let containerId = "";
  try {
    containerId = execSync(`docker ps --filter name=eaos-agent- --format {{.ID}}`, { encoding: "utf8" }).trim().split("\n")[0];
  } catch {}
  ok("agent container running", !!containerId, `container=${containerId}`);

  let token = null;
  if (containerId) {
    const envDump = execSync(`docker exec ${containerId} printenv`, { encoding: "utf8" });
    ok("raw credential ABSENT from container env", !envDump.includes(CRED));
    ok("only internal-mcp token in runtime MCP config (AGENT_SDK_OPTIONS)", envDump.includes("AGENT_SDK_OPTIONS"));
    const m = envDump.match(/"authorization":"Bearer ([^"]+)"/);
    token = m?.[1] ?? null;
    ok("runtime MCP config carries a JWT capability token", !!token && token.split(".").length === 3 && token !== CRED);

    let logs = "";
    try { logs = execSync(`docker logs ${containerId} 2>&1`, { encoding: "utf8" }); } catch {}
    const mcpLines = logs.split("\n").filter((l) => /mcp|MCP|connector|error|Error/i.test(l)).slice(-30);
    if (mcpLines.length) console.log(`[m1d] container MCP/error log lines:\n${mcpLines.join("\n")}`);
    ok("raw credential ABSENT from container logs", !logs.includes(CRED));
  }
  ok("raw credential ABSENT from host server log", !serverLog.join("").includes(CRED));

  // Audits: read governance_audit_log from the temp DB.
  let auditDump = "";
  try {
    const { execFileSync } = await import("node:child_process");
    auditDump = execFileSync("npx", ["tsx", "-e", `import Database from "better-sqlite3"; const db = new Database("${DB_PATH}", { readonly: true }); console.log(JSON.stringify(db.prepare("SELECT * FROM governance_audit_log").all()));`], { encoding: "utf8" });
  } catch (e) { auditDump = `audit-read-error:${e?.message ?? e}`; }
  ok("raw credential ABSENT from governance audits", !auditDump.includes(CRED));

  // ─── 9. Live revocation with the REAL minted tokens ──────────────
  // Order matters: disable kills the jti permanently (a re-enable cannot
  // resurrect a killed token — the runtime re-resolves and mints a NEW one),
  // so stop-revocation is proven FIRST with the live token, then a fresh
  // container mints token2 and disable-rejection is proven with THAT.
  if (token) {
    const list = (tk) => fetch(`${BASE}/api/mcp/connectors/${instanceId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tk}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }).then((r) => r.status);

    ok("live token works (tools/list 200)", (await list(token)) === 200);

    const stopped = await jfetch(`/api/admin/containers/${agentId}/stop`, { method: "POST", token: T });
    await sleep(500);
    ok("runtime stop revokes the token (401)", stopped.status === 200 && (await list(token)) === 401);

    // Fresh runtime → new container → new token.
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${T}`);
    await new Promise((r) => ws2.once("open", r));
    ws2.send(JSON.stringify({ type: "chat", chatId: agentId, content: "再调用一次 rest_request：method=GET，path=/hello。" }));
    let token2 = null, newContainerId = "";
    for (let i = 0; i < 60 && !newContainerId; i++) {
      await sleep(1000);
      try {
        const ids = execSync(`docker ps --filter name=eaos-agent- --format {{.ID}}`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
        newContainerId = ids.find((id) => id !== containerId) ?? "";
      } catch {}
    }
    if (newContainerId) {
      const env2 = execSync(`docker exec ${newContainerId} printenv`, { encoding: "utf8" });
      token2 = env2.match(/"authorization":"Bearer ([^"]+)"/)?.[1] ?? null;
    }
    ok("fresh runtime mints a NEW token", !!token2 && token2 !== token, `container=${newContainerId}`);
    if (token2) {
      ok("token2 works before disable (200)", (await list(token2)) === 200);
      const dis = await jfetch(`/api/admin/connectors/instances/${instanceId}/disable`, { method: "POST", token: T });
      ok("connector disable immediately rejects subsequent calls (401)", dis.status === 200 && (await list(token2)) === 401, `disable=${dis.status}`);
      const re = await jfetch(`/api/admin/connectors/instances/${instanceId}/enable`, { method: "POST", token: T });
      const afterRe = await list(token2);
      ok("killed token does not resurrect after re-enable", re.status === 200 && afterRe === 401, `re-enable=${re.status} list=${afterRe}`);
    }
    try { ws2.close(); } catch {}
    try { await jfetch(`/api/admin/containers/${agentId}/stop`, { method: "POST", token: T }); } catch {}
  }

  // ─── 10. Cleanup ─────────────────────────────────────────────────
  try { await jfetch(`/api/chats/${agentId}`, { method: "DELETE", token: T }); } catch {}
  try { await jfetch(`/api/chats/${plainAgentId}`, { method: "DELETE", token: T }); } catch {}
} finally {
  if (!process.env.M1D_DEBUG_KEEP) {
    try { server.kill("SIGTERM"); } catch {}
    fixture.close();
    await sleep(1500);
    try { execSync(`docker ps -aq --filter name=eaos-agent- | xargs -r docker rm -f`, { stdio: "ignore" }); } catch {}
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
  } else {
    console.log(`[m1d] M1D_DEBUG_KEEP=1 — server on :${PORT}, DB ${DB_PATH}, containers left running`);
  }
}

console.log(`\n=== M1d smoke: ${pass} passed, ${fail} failed ===`);
fs.writeFileSync("/tmp/m1d-smoke-results.txt", RESULTS.join("\n") + `\n\nTOTAL: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
