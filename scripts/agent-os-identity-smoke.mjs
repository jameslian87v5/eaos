/**
 * agent-os-identity-smoke.mjs — M1 (Agent OS §5) real-server identity flow.
 *
 * Proves the Token-only browser boundary end-to-end against a running server:
 *   1. App backend mints a short-lived Runtime Token (AppKey + opaque subject).
 *   2. Browser REST: create + list an Agent using ONLY the Runtime Token
 *      (no X-App-Key in the request).
 *   3. Browser WS: connect + subscribe using ONLY ?token= (no ?appKey=).
 *
 * The AppKey never appears in any browser-facing request URL/header/query.
 * The flow stops after WS subscription (auth + ownership + subscription
 * proven); it does NOT drive an LLM turn, so no provider key is required.
 *
 * Prerequisites: a running server. Suggested:
 *   DB_PATH=/tmp/agent-os-m1-smoke.db PORT=3999 ALLOW_DEV_JWT_SECRET=1 \
 *     ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 npm start
 * then:
 *   SMOKE_BASE=http://localhost:3999 node scripts/agent-os-identity-smoke.mjs
 */
import { WebSocket } from "ws";

const BASE = process.env.SMOKE_BASE || "http://localhost:3999";
const WS_BASE = (process.env.SMOKE_WS_BASE || BASE).replace(/^http/, "ws");
const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
const NEW_ADMIN_PASS = process.env.ADMIN_NEW_PASSWORD || "Admin1234";
const SUBJECT = process.env.M1_SUBJECT || "smoke-subject-1";

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); failures++; throw new Error("smoke failed: " + msg); }
}
function step(msg) { console.log("▸ " + msg); }

async function http(path, { method = "GET", bearer, appKey, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (appKey) headers["x-app-key"] = appKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers };
}

async function login(user, pass) {
  const r = await http("/api/auth/login", { method: "POST", body: { username: user, password: pass } });
  assert(r.status === 200, `admin login failed (status ${r.status}: ${JSON.stringify(r.json)})`);
  return r.json; // { token, user, mustChangePassword }
}

async function ensureAdminReady() {
  let sess = await login(ADMIN_USER, ADMIN_PASS);
  if (sess.mustChangePassword) {
    step("admin must change password; rotating " + ADMIN_PASS + " → " + NEW_ADMIN_PASS);
    const cp = await http("/api/auth/change-password", {
      method: "POST", bearer: sess.token,
      body: { oldPassword: ADMIN_PASS, newPassword: NEW_ADMIN_PASS },
    });
    assert(cp.status === 200, `change-password failed (status ${cp.status}: ${JSON.stringify(cp.json)})`);
    // token_version bumped → re-login with the new password.
    sess = await login(ADMIN_USER, NEW_ADMIN_PASS);
    assert(!sess.mustChangePassword, "admin still must-change after rotation");
  }
  return sess.token;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log(`\nAgent OS M1 identity smoke → ${BASE}\n`);

  // ── 1. Admin provisions an Application + AppKey (S2S; AppKey lives here). ──
  step("1. admin login + create Application + generate AppKey");
  const adminToken = await ensureAdminReady();
  const createApp = await http("/api/admin/applications", {
    method: "POST", bearer: adminToken,
    body: { name: "m1-smoke-app" },
  });
  assert(createApp.status === 201, `create application failed (status ${createApp.status}: ${JSON.stringify(createApp.json)})`);
  const appId = createApp.json.id;
  const orgId = createApp.json.orgId;
  console.log(`  appId=${appId} orgId=${orgId}`);

  const genKey = await http(`/api/admin/applications/${appId}/key`, { method: "POST", bearer: adminToken });
  assert(genKey.status === 200 || genKey.status === 201, `generate key failed (status ${genKey.status})`);
  const appKey = genKey.json.key;
  assert(typeof appKey === "string" && appKey.startsWith("sap_"), "appKey not returned");
  console.log("  AppKey minted (stays in the app backend; never sent to browser).");

  // ── 2. App backend mints a short-lived Runtime Token (AppKey + subject). ──
  step("2. mint Runtime Token (S2S: X-App-Key + subject)");
  const mint = await http(`/api/apps/${appId}/runtime-tokens`, {
    method: "POST", appKey,
    body: { subject: SUBJECT },
  });
  assert(mint.status === 201, `mint runtime token failed (status ${mint.status}: ${JSON.stringify(mint.json)})`);
  const runtimeToken = mint.json.token;
  const principalId = mint.json.principalId;
  assert(typeof runtimeToken === "string", "runtime token not returned");
  assert(typeof principalId === "string", "principalId not returned");
  console.log(`  principalId=${principalId.slice(0, 8)}… token=${runtimeToken.slice(0, 12)}…`);

  // ── 3. Browser REST (Token-only, NO X-App-Key): create an Agent. ─────────
  step("3. Token-only REST: create Agent (Authorization: Bearer only)");
  const createAgent = await http(`/api/apps/${appId}/agents`, {
    method: "POST", bearer: runtimeToken, // NO appKey
    body: { title: "m1-smoke-agent" },
  });
  assert(createAgent.status === 200 || createAgent.status === 201,
    `token-only create agent failed (status ${createAgent.status}: ${JSON.stringify(createAgent.json)})`);
  const agentId = createAgent.json.id;
  assert(typeof agentId === "string", "created agent id missing");
  console.log(`  agentId=${agentId} (owned by principalId, no AppKey in request)`);

  // ── 4. Browser REST (Token-only): list Agents → only this principal's. ───
  step("4. Token-only REST: list Agents (Authorization: Bearer only)");
  const listAgents = await http(`/api/apps/${appId}/agents`, { bearer: runtimeToken });
  assert(listAgents.status === 200, `token-only list agents failed (status ${listAgents.status})`);
  const ids = Array.isArray(listAgents.json) ? listAgents.json.map((a) => a.id) : [];
  assert(ids.includes(agentId), "created agent not visible to its principal");
  console.log(`  list returned ${ids.length} agent(s); includes the created one.`);

  // ── 5. Browser WS (Token-only, NO ?appKey=): connect + subscribe. ───────
  step("5. Token-only WS: connect + subscribe (?token= only)");
  const wsUrl = `${WS_BASE}/api/apps/${appId}/ws?token=${encodeURIComponent(runtimeToken)}`;
  assert(!wsUrl.includes("appKey="), "appKey must NOT be in the WS URL");

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let gotHistory = false;
    const timer = setTimeout(() => {
      if (!gotHistory) { try { ws.close(); } catch {} reject(new Error("WS subscribe did not yield history within timeout")); }
    }, 8000);

    ws.on("open", () => {
      console.log("  ws: connected (Token-only; no appKey in URL).");
      ws.send(JSON.stringify({ type: "subscribe", chatId: agentId }));
    });
    ws.on("message", (d) => {
      let msg; try { msg = JSON.parse(d.toString()); } catch { return; }
      if (msg.type === "connected") return;
      if (msg.type === "history") {
        gotHistory = true;
        console.log("  ws: received history → subscription proven (auth + ownership OK).");
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve();
      } else if (msg.type === "error") {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(new Error("WS error: " + (msg.error || JSON.stringify(msg))));
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(new Error("WS error: " + e.message)); });
  });

  console.log("\n✓ M1 identity smoke PASSED: Token-only REST + WS proven; AppKey never reached the browser.\n");
}

main().catch((e) => {
  console.error("\n✗ M1 identity smoke FAILED: " + (e?.message || e));
  process.exit(1);
});
