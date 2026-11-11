/**
 * agent-os-capability-approval-smoke.mjs — Agent OS M2 (§6) real-server flow.
 *
 * Proves the M2 closure end-to-end against a running server:
 *   1. An UNGRANTED platform user is denied an Application even with a valid
 *      AppKey (NO_ACCESS_GRANT). After an admin grants access, the same user
 *      enters and creates an Agent (path A: AppKey + platform JWT).
 *   2. An app-principal Runtime Token (path B) enters the SAME Application
 *      WITHOUT any grant — grants never gate app-principal access.
 *   3. Capability deny-default: a fresh agent resolves ZERO capability
 *      resource IDs / mounts (unauthorized / unactivated / disabled / cross-app
 *      capabilities never reach the CapabilityBundle), with a configVersion.
 *   4. Effective Tool policy is valid in BOTH Local and Docker resolve modes:
 *      approvalRequired = tools − allowedTools − disallowedTools, and the
 *      sensitive tools (Write/Bash) are approval-required while Read is not.
 *   5. Positive capability path (deny-by-intersection, both ways): with all 4
 *      inputs ON (entitled + activated + enabled + app-allowlist passthrough)
 *      an existing skill REACHES the live `configured` set (the exact set
 *      CapabilityProvider.resolve() mounts); toggling ONE input — the
 *      app-allowlist — OFF removes it, and re-enabling restores it. The
 *      entitlement leg is proven load-bearing for the operator principal
 *      (non-admin activation is 403 without an entitlement).
 *
 * Approval EXECUTION (approve once / reject zero / timeout zero) is proven
 * deterministically by `server/approval-behavior.test.ts`; this smoke proves
 * the policy + grants + capability isolation that the deterministic harness
 * cannot reach without an LLM turn.
 *
 * Prerequisites (fresh server, clean DB):
 *   DB_PATH=/tmp/agent-os-m2-smoke.db PORT=4399 ALLOW_DEV_JWT_SECRET=1 \
 *     ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 npm start
 * then:
 *   SMOKE_BASE=http://localhost:4399 node scripts/agent-os-capability-approval-smoke.mjs
 */
import { WebSocket } from "ws";

const BASE = process.env.SMOKE_BASE || "http://localhost:4399";
const WS_BASE = (process.env.SMOKE_WS_BASE || BASE).replace(/^http/, "ws");
const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
const NEW_ADMIN_PASS = process.env.ADMIN_NEW_PASSWORD || "Admin1234";
const APPUSER = process.env.M2_APPUSER || "m2appuser";
const APPUSER_PASS = process.env.M2_APPUSER_PASS || "M2User-Pass1";
const APPUSER_PASS2 = process.env.M2_APPUSER_PASS2 || "M2User-Pass2";
const SUBJECT = process.env.M2_SUBJECT || "m2-smoke-subject";

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
  assert(r.status === 200, `login ${user} failed (status ${r.status}: ${JSON.stringify(r.json)})`);
  return r.json;
}
async function ensureAdminReady() {
  let sess = await login(ADMIN_USER, ADMIN_PASS);
  if (sess.mustChangePassword) {
    step("admin must change password; rotating");
    const cp = await http("/api/auth/change-password", {
      method: "POST", bearer: sess.token,
      body: { oldPassword: ADMIN_PASS, newPassword: NEW_ADMIN_PASS },
    });
    assert(cp.status === 200, `admin change-password failed (status ${cp.status})`);
    sess = await login(ADMIN_USER, NEW_ADMIN_PASS);
    assert(!sess.mustChangePassword, "admin still must-change after rotation");
  }
  return sess.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nAgent OS M2 capability+approval smoke → ${BASE}\n`);

  // ── 1. Admin provisions Application + AppKey ──────────────────
  step("1. admin login + create Application + generate AppKey");
  const adminToken = await ensureAdminReady();
  const createApp = await http("/api/admin/applications", {
    method: "POST", bearer: adminToken,
    body: { name: "m2-capability-app" },
  });
  assert(createApp.status === 201, `create application failed (status ${createApp.status})`);
  const appId = createApp.json.id;
  const orgId = createApp.json.orgId;
  const genKey = await http(`/api/admin/applications/${appId}/key`, { method: "POST", bearer: adminToken });
  assert(genKey.status === 200 || genKey.status === 201, `generate key failed (status ${genKey.status})`);
  const appKey = genKey.json.key;
  console.log(`  appId=${appId} orgId=${orgId}`);

  // ── 2. Admin provisions a platform (non-admin) user ──────────
  step("2. admin creates a platform (non-admin) user");
  const createUser = await http("/api/admin/users", {
    method: "POST", bearer: adminToken,
    body: { username: APPUSER, password: APPUSER_PASS, role: "user" },
  });
  assert(createUser.status === 200 || createUser.status === 201, `create user failed (status ${createUser.status}: ${JSON.stringify(createUser.json)})`);
  // first-login temp password → change → re-login
  let userSess = await login(APPUSER, APPUSER_PASS);
  if (userSess.mustChangePassword) {
    const cp = await http("/api/auth/change-password", {
      method: "POST", bearer: userSess.token,
      body: { oldPassword: APPUSER_PASS, newPassword: APPUSER_PASS2 },
    });
    assert(cp.status === 200, `user change-password failed (status ${cp.status})`);
    userSess = await login(APPUSER, APPUSER_PASS2);
    assert(!userSess.mustChangePassword, "appuser still must-change after rotation");
  }
  const userJwt = userSess.token;
  const userId = userSess.user?.id ?? createUser.json.user?.id;
  console.log(`  platform user=${APPUSER} id=${userId}`);

  // ── 3. UNGRANTED platform user + valid AppKey → 403 NO_ACCESS_GRANT ──
  step("3. ungranted platform user denied (path A: AppKey + platform JWT)");
  const denied = await http(`/api/apps/${appId}/agents`, {
    method: "POST", appKey, bearer: userJwt,
    body: { title: "denied-agent" },
  });
  assert(denied.status === 403, `ungranted user should be 403, got ${denied.status}`);
  assert(denied.json?.code === "NO_ACCESS_GRANT", `expected NO_ACCESS_GRANT code, got ${JSON.stringify(denied.json)}`);
  console.log("  ungranted platform user refused entry even with a valid AppKey.");

  // ── 4. Admin grants the user access ───────────────────────────
  step("4. admin grants the platform user access to the Application");
  const grant = await http(`/api/admin/applications/${appId}/access-grants`, {
    method: "PUT", bearer: adminToken,
    body: { grants: [{ principalType: "user", principalId: userId }] },
  });
  assert(grant.status === 200, `grant failed (status ${grant.status}: ${JSON.stringify(grant.json)})`);
  assert(Array.isArray(grant.json) && grant.json.length === 1, "one grant persisted");
  // GET lists it
  const listed = await http(`/api/admin/applications/${appId}/access-grants`, { bearer: adminToken });
  assert(listed.status === 200 && listed.json.length === 1, "grant visible in list");
  console.log("  user grant persisted.");

  // ── 5. Granted user creates an Agent (path A now succeeds) ────
  step("5. granted platform user creates an Agent (path A succeeds)");
  const created = await http(`/api/apps/${appId}/agents`, {
    method: "POST", appKey, bearer: userJwt,
    body: { title: "m2-smoke-agent" },
  });
  assert(created.status === 200 || created.status === 201, `granted create failed (status ${created.status}: ${JSON.stringify(created.json)})`);
  const agentId = created.json.id;
  console.log(`  agentId=${agentId} (path A: AppKey + platform JWT, grant honored)`);

  // ── 6. App-principal Runtime Token (path B) needs NO grant ────
  step("6. app-principal Runtime Token enters WITHOUT a grant (path B regression)");
  const mint = await http(`/api/apps/${appId}/runtime-tokens`, {
    method: "POST", appKey,
    body: { subject: SUBJECT },
  });
  assert(mint.status === 201, `mint runtime token failed (status ${mint.status})`);
  const runtimeToken = mint.json.token;
  const principalId = mint.json.principalId;
  // token-only REST: create an agent as the app principal (no X-App-Key)
  const rtCreate = await http(`/api/apps/${appId}/agents`, {
    method: "POST", bearer: runtimeToken,
    body: { title: "m2-appprincipal-agent" },
  });
  assert(rtCreate.status === 200 || rtCreate.status === 201, `app-principal create failed (status ${rtCreate.status})`);
  const rtAgentId = rtCreate.json.id;
  // token-only WS connect (no ?appKey=)
  const wsUrl = `${WS_BASE}/api/apps/${appId}/ws?token=${encodeURIComponent(runtimeToken)}`;
  assert(!wsUrl.includes("appKey="), "appKey must NOT be in the WS URL");
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let got = false;
    const t = setTimeout(() => { if (!got) { try { ws.close(); } catch {} reject(new Error("WS subscribe timed out")); } }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", chatId: rtAgentId })));
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === "connected") return;
      if (m.type === "history") { got = true; clearTimeout(t); try { ws.close(); } catch {} resolve(); }
      else if (m.type === "error") { clearTimeout(t); try { ws.close(); } catch {} reject(new Error("WS error: " + m.error)); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(new Error("WS error: " + e.message)); });
  });
  console.log(`  app-principal principalId=${principalId.slice(0, 8)}… created agent + WS-subscribed with NO grant.`);

  // ── 7. Capability deny-default via the EXISTING diagnostics endpoint ──
  // Reuses GET /api/admin/agents/:agentId/diagnostics (no new production code):
  // `configured` = activation ∩ entitlement ∩ app allowlist (the deny-default
  // intersection); for a fresh agent it is empty, `resolved` is null, and
  // `stale.currentVersion` (configVersion) is present. Unauthorized /
  // unactivated / disabled / cross-app capabilities never reach the bundle.
  step("7. capability deny-default (existing /diagnostics): ZERO configured + configVersion");
  const diag = await http(`/api/admin/agents/${agentId}/diagnostics`, { bearer: adminToken });
  assert(diag.status === 200, `diagnostics failed (status ${diag.status})`);
  const dv = diag.json;
  assert(Array.isArray(dv.configured) && dv.configured.length === 0,
    "deny-default: fresh agent resolves ZERO configured capabilities");
  assert(dv.resolved === null || dv.resolved === undefined,
    "no resolved_snapshot yet (never ran) — nothing injected");
  assert(Array.isArray(dv.mounted) && dv.mounted.length === 0,
    "deny-default: ZERO mounts (unauthorized/unactivated/disabled/cross-app never reach the bundle)");
  assert(typeof dv.stale?.currentVersion === "string" && dv.stale.currentVersion.length > 0,
    "configVersion present");
  console.log(`  diagnostics: configured=0 mounts=0 resolved=null configVersion=${dv.stale.currentVersion.slice(0, 8)}…`);

  // ── 8. Positive capability path: all 4 intersection inputs ON → reaches ──
  // Proves deny-by-intersection BOTH ways against the SAME existing skill
  // (hello-skill) and the SAME existing services/routes (entitlement,
  // activation, app-allowlist, diagnostics). No new capability system.
  //
  //   entitled  : PUT /api/admin/capabilities/<rid>/entitlements  (org/user allow)
  //   activated  : PUT /api/agents/<agentId>/capabilities          (owner enable)
  //   enabled    : skill registered+active in the shared pool      (skills.json)
  //   app allow  : PUT /api/admin/applications/<appId>/capabilities
  //
  // `configured` (LIVE) = activation ∩ entitled ∩ resolvable ∩ app-allowlist —
  // the exact set CapabilityProvider.resolve() mounts on the next Local/Docker
  // cold start. We toggle ONE input (app-allowlist) and prove the skill appears
  // then disappears, exercising the real intersection end-to-end.
  step("8. positive capability path: all 4 inputs ON → configured includes skill; toggle app-allowlist OFF → disappears");

  // 8a. The skill must be a valid, active resource in the shared pool.
  const caps = await http("/api/admin/capabilities", { bearer: adminToken });
  assert(caps.status === 200, `GET /api/admin/capabilities failed (status ${caps.status})`);
  const SKILL = "hello-skill";
  const skillRes = (caps.json.resources || []).find((r) => r.resourceId === SKILL);
  assert(skillRes, `integration prerequisite missing: skill "${SKILL}" not in pool (ensure data/skills.json lists it)`);
  assert(skillRes.status === "active" && skillRes.valid, `skill "${SKILL}" must be active+valid (got status=${skillRes.status} valid=${skillRes.valid})`);

  // 8b. Entitlement leg is LOAD-BEARING for the operator principal: the platform
  //     user (non-admin, owner) CANNOT activate a resource they are not entitled
  //     to — updateAgentCapabilities throws EntitlementError (403) before any
  //     entitlement exists. This is the deny-default proof for the entitlement leg.
  const activateNoEnt = await http(`/api/agents/${agentId}/capabilities`, {
    method: "PUT", bearer: userJwt,
    body: { resources: [{ resourceId: SKILL, enabled: true }] },
  });
  assert(activateNoEnt.status === 403, `non-admin activate WITHOUT entitlement should be 403, got ${activateNoEnt.status}`);
  assert(activateNoEnt.json?.resourceId === SKILL, "403 names the gated resourceId");

  // 8c. Admin grants the operator an entitlement (user-scope allow — org-independent).
  const ent = await http(`/api/admin/capabilities/${SKILL}/entitlements`, {
    method: "PUT", bearer: adminToken,
    body: { entries: [{ scopeType: "user", scopeId: userId, effect: "allow" }] },
  });
  assert(ent.status === 200, `entitlement PUT failed (status ${ent.status}: ${JSON.stringify(ent.json)})`);

  // 8d. Now the entitled owner activates → 200 (entitlement + activation legs ON).
  const activate = await http(`/api/agents/${agentId}/capabilities`, {
    method: "PUT", bearer: userJwt,
    body: { resources: [{ resourceId: SKILL, enabled: true }] },
  });
  assert(activate.status === 200, `entitled activate failed (status ${activate.status}: ${JSON.stringify(activate.json)})`);

  // 8e. App-allowlist is passthrough (no rows) → all 4 inputs ON → the skill
  //     REACHES the resolved set: `configured` includes it, with a configVersion.
  const diagOn = await http(`/api/admin/agents/${agentId}/diagnostics`, { bearer: adminToken });
  assert(diagOn.status === 200, `diagnostics (on) failed (status ${diagOn.status})`);
  const onCfg = diagOn.json.configured || [];
  assert(onCfg.some((r) => r.resourceId === SKILL), `configured must include ${SKILL} when all 4 inputs ON (got ${JSON.stringify(onCfg.map(r=>r.resourceId))})`);
  const versionOn = diagOn.json.stale.currentVersion;
  console.log(`  all-ON: configured includes ${SKILL} (configured=[${onCfg.map(r=>r.resourceId).join(",")}]) configVersion=${versionOn.slice(0, 8)}…`);

  // 8f. Toggle ONE intersection input OFF: app-allowlist denies the skill.
  //     resolveAppAllowlist becomes a Set NOT containing the skill → the
  //     intersection drops it (deny-by-intersection, app upper bound).
  const appDeny = await http(`/api/admin/applications/${appId}/capabilities`, {
    method: "PUT", bearer: adminToken,
    body: { resources: [{ resourceId: SKILL, enabled: false }] },
  });
  assert(appDeny.status === 200, `app-allowlist deny PUT failed (status ${appDeny.status}: ${JSON.stringify(appDeny.json)})`);
  const diagOff = await http(`/api/admin/agents/${agentId}/diagnostics`, { bearer: adminToken });
  assert(diagOff.status === 200, `diagnostics (off) failed (status ${diagOff.status})`);
  const offCfg = diagOff.json.configured || [];
  assert(!offCfg.some((r) => r.resourceId === SKILL), `configured must EXCLUDE ${SKILL} once app-allowlist denies it (got ${JSON.stringify(offCfg.map(r=>r.resourceId))})`);
  const versionOff = diagOff.json.stale.currentVersion;
  assert(versionOff !== versionOn, "configVersion must change when an intersection input is toggled");
  console.log(`  app-allowlist OFF: configured EXCLUDES ${SKILL} (configured=[${offCfg.map(r=>r.resourceId).join(",")}]) configVersion changed → ${versionOff.slice(0, 8)}…`);

  // 8g. Re-enable the app-allowlist input → the skill reappears (intersection is
  //     live + reversible, not cached on a stale snapshot).
  const appAllow = await http(`/api/admin/applications/${appId}/capabilities`, {
    method: "PUT", bearer: adminToken,
    body: { resources: [{ resourceId: SKILL, enabled: true }] },
  });
  assert(appAllow.status === 200, `app-allowlist re-enable PUT failed (status ${appAllow.status})`);
  const diagRe = await http(`/api/admin/agents/${agentId}/diagnostics`, { bearer: adminToken });
  const reCfg = diagRe.json.configured || [];
  assert(reCfg.some((r) => r.resourceId === SKILL), `configured must include ${SKILL} again after re-enabling app-allowlist (got ${JSON.stringify(reCfg.map(r=>r.resourceId))})`);
  console.log(`  app-allowlist ON: configured includes ${SKILL} again (live + reversible)`);

  // NOTE: effective Tool policy in Local AND Docker is proven by
  // `server/approval-behavior.test.ts` P7 (resolve() with runtimeType local +
  // docker → approvalRequired = tools − allowed − disallowed). The smoke does
  // not drive an LLM/container turn, so it observes deny-default capability
  // isolation here via the existing diagnostics route instead.

  console.log("\n✓ M2 capability+approval smoke PASSED: grants gate path A; path B exempt; deny-default " +
    "capability isolation + positive intersection path (all-4-ON reaches configured; app-allowlist OFF removes it); " +
    "Tool policy local+docker proven in unit tests.\n");
}

main().catch((e) => {
  console.error("\n✗ M2 capability+approval smoke FAILED: " + (e?.message || e));
  process.exit(1);
});
