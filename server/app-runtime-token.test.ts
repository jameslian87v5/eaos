/**
 * app-runtime-token.test.ts — P0.2 (Agent OS §4) adversarial unit tests.
 *
 * Focus: the app-scoped Runtime Token + WS path-B (verifyWSAppAuth) security
 * boundary. Deny-default chain: app scope, exp, principal status, agent
 * binding, org consistency, AppKey status, AppKey prefix bind (rotation-revoke),
 * and (codex gap 1) principal.appId === keyApp.appId to block same-org
 * cross-app principalId swap.
 *
 * The browser-facing token carries NO raw subject (only the opaque
 * principalId); asserted explicitly. Path-A (platform user JWT) regression
 * proves the existing `appKey + User JWT` dual-identity path still works.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import jwt from "jsonwebtoken";

// ─── Env before imports ──────────────────────────────────────
const TMP_DB = "/tmp/test-p02-app-runtime-token.db";
process.env.DB_PATH = TMP_DB;
// Pin the JWT secret so the test can craft forged / expired / wrong-app tokens
// with the same signer the server uses. auth.ts captures this at module load.
process.env.JWT_SECRET = "p02-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
rmSync(TMP_DB, { force: true });

const JWT_SECRET = process.env.JWT_SECRET;

const db = (await import("./database.js")).default;
const { applicationService } = await import("./application-service.js");
const {
  getOrCreateAppPrincipal,
  setAppPrincipalStatus,
} = await import("./app-principal.js");
const { signRuntimeToken } = await import("./auth.js");
const { verifyWSAppAuth, appAuthMiddleware, redactWsAuthQuery } = await import("./app-auth.js");
const { agentService } = await import("./agent-service.js");
const { applicationAccessGrantsService } = await import("./application-access.js");

// ─── Helpers ─────────────────────────────────────────────────

const ORG_A = "org-a";
const APP_1 = "app-1";
const APP_2 = "app-2";
const APP_3 = "app-3"; // for the disabled-app test (keep APP_1/2 active)

function setupApp(appId: string, orgId: string): string {
  applicationService.createApplication({ id: appId, orgId, name: appId });
  const { key } = applicationService.generateAppKey(appId);
  return key; // plaintext appKey — returned once
}

function insertAgent(agentId: string, appId: string, orgId: string, ownerUserId: string): void {
  // agents JOINs chats ON c.id = a.id (listByApp), so insert both rows.
  db.prepare(
    `INSERT INTO chats (id, user_id, title, org_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(agentId, ownerUserId, agentId, orgId);
  db.prepare(
    `INSERT INTO agents (id, org_id, owner_user_id, name, status, app_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'))`
  ).run(agentId, orgId, ownerUserId, agentId, appId);
}

function insertPlatformUser(userId: string, orgId: string): void {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status, token_version, must_change_password, created_at)
     VALUES (?, ?, 'x', 'user', ?, 'active', 1, 0, datetime('now'))`
  ).run(userId, `u_${userId}`, orgId);
}

function wsUrl(appId: string, token: string, appKey: string): URL {
  return new URL(
    `http://localhost/api/apps/${appId}/ws?token=${encodeURIComponent(token)}&appKey=${encodeURIComponent(appKey)}`
  );
}

/**
 * Mint a runtime token bound to the given (app, principal) and the AppKey that
 * will later be presented. The prefix is bound (gap 2) so the presented key's
 * prefix must match the minting key's prefix.
 */
function mint(appId: string, appKey: string, principalId: string, opts: { agentId?: string; pageSessionId?: string } = {}): string {
  return signRuntimeToken({
    appId,
    principalId,
    agentId: opts.agentId,
    pageSessionId: opts.pageSessionId ?? "ps",
    apiKeyPrefix: appKey.slice(0, 16),
  });
}

/** Craft a widget-shaped app token with arbitrary fields (forgery tests). */
function craftAppToken(overrides: Record<string, unknown>): string {
  return jwt.sign(
    {
      kind: "widget",
      role: "user",
      pageSessionId: "ps",
      principalType: "app",
      ...overrides,
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

// ─── Setup ───────────────────────────────────────────────────

const KEY_1 = setupApp(APP_1, ORG_A);
const KEY_2 = setupApp(APP_2, ORG_A);
const KEY_3 = setupApp(APP_3, ORG_A);

// ─── Tests ───────────────────────────────────────────────────

// 1. Mint + verify path B happy path: opaque principalId flows as userId.
{
  const p = getOrCreateAppPrincipal(APP_1, "alice", ORG_A);
  const token = mint(APP_1, KEY_1, p.principalId);
  const r = verifyWSAppAuth(wsUrl(APP_1, token, KEY_1));
  assert.ok(r, "path B must succeed for a valid runtime token + appKey");
  assert.equal(r!.userId, p.principalId, "userId must be the opaque principalId");
  assert.equal(r!.ctx.appId, APP_1);
  assert.equal(r!.ctx.orgId, ORG_A);
  assert.equal(r!.widgetAgentId, undefined, "no agentId bound → no widgetAgentId");
  console.log("✓ 1. mint + verify path B; principalId is the data-plane key");
}

// 2. Cross-subject isolation: same app, two subjects → two principalIds, no cross-bleed.
{
  const pa = getOrCreateAppPrincipal(APP_1, "alice", ORG_A);
  const pb = getOrCreateAppPrincipal(APP_1, "bob", ORG_A);
  assert.notEqual(pa.principalId, pb.principalId, "two subjects must map to two ids");
  const ta = mint(APP_1, KEY_1, pa.principalId, { pageSessionId: "ps-a" });
  const tb = mint(APP_1, KEY_1, pb.principalId, { pageSessionId: "ps-b" });
  const ra = verifyWSAppAuth(wsUrl(APP_1, ta, KEY_1));
  const rb = verifyWSAppAuth(wsUrl(APP_1, tb, KEY_1));
  assert.equal(ra!.userId, pa.principalId);
  assert.equal(rb!.userId, pb.principalId);
  assert.notEqual(ra!.userId, rb!.userId, "tokens must not cross-bleed subjects");
  console.log("✓ 2. cross-subject isolation; same app, distinct opaque ids");
}

// 3. Cross-app: token for APP_1 presented with APP_2's appKey → reject.
//    The token is bound to KEY_1's prefix; presenting KEY_2 (different prefix)
//    fails the prefix bind, and the scope claim (APP_1 vs APP_2) also fails.
{
  const p1 = getOrCreateAppPrincipal(APP_1, "carol", ORG_A);
  const t1 = mint(APP_1, KEY_1, p1.principalId);
  assert.equal(verifyWSAppAuth(wsUrl(APP_2, t1, KEY_2)), null, "cross-app scope rejected");
  console.log("✓ 3. cross-app / forged scope rejected");
}

// 4. Expired token → reject (verifyWidgetToken enforces exp).
{
  const p = getOrCreateAppPrincipal(APP_1, "dave", ORG_A);
  const expired = jwt.sign(
    {
      kind: "widget",
      appId: APP_1,
      userId: p.principalId,
      role: "user",
      pageSessionId: "ps",
      principalType: "app",
      principalId: p.principalId,
      apiKeyPrefix: KEY_1.slice(0, 16),
      exp: Math.floor(Date.now() / 1000) - 60, // 60s ago
    },
    JWT_SECRET
  );
  assert.equal(verifyWSAppAuth(wsUrl(APP_1, expired, KEY_1)), null, "expired token rejected");
  console.log("✓ 4. expired token rejected");
}

// 5. Revoked principal (disabled) → reject; restore → accept.
{
  const p = getOrCreateAppPrincipal(APP_1, "eve", ORG_A);
  const t = mint(APP_1, KEY_1, p.principalId);
  assert.ok(verifyWSAppAuth(wsUrl(APP_1, t, KEY_1)), "active principal connects");
  setAppPrincipalStatus(p.principalId, "disabled");
  assert.equal(verifyWSAppAuth(wsUrl(APP_1, t, KEY_1)), null, "disabled principal rejected");
  setAppPrincipalStatus(p.principalId, "active");
  assert.ok(verifyWSAppAuth(wsUrl(APP_1, t, KEY_1)), "restored principal connects again");
  console.log("✓ 5. revoked (disabled) principal rejected; restore re-enables");
}

// 6. Forged appId in token (claims APP_2 but appKey is APP_1) → reject.
//    Prefix is bound to KEY_1 so the prefix check passes; the scope check
//    (token.appId APP_2 ≠ keyApp.appId APP_1) is the rejector.
{
  const p1 = getOrCreateAppPrincipal(APP_1, "frank", ORG_A);
  const forged = craftAppToken({ appId: APP_2, userId: p1.principalId, principalId: p1.principalId, apiKeyPrefix: KEY_1.slice(0, 16) });
  assert.equal(verifyWSAppAuth(wsUrl(APP_1, forged, KEY_1)), null, "forged appId rejected");
  console.log("✓ 6. forged appId (token.appId ≠ appKey.appId) rejected");
}

// 7. Agent binding: bound agent must belong to the token's app.
{
  const p1 = getOrCreateAppPrincipal(APP_1, "grace", ORG_A);
  insertAgent("agent-1", APP_1, ORG_A, p1.principalId);
  const tokGood = mint(APP_1, KEY_1, p1.principalId, { agentId: "agent-1" });
  const rg = verifyWSAppAuth(wsUrl(APP_1, tokGood, KEY_1));
  assert.ok(rg, "agent in this app → accepted");
  assert.equal(rg!.widgetAgentId, "agent-1", "widgetAgentId surfaced for scoping");

  const p2 = getOrCreateAppPrincipal(APP_2, "heidi", ORG_A);
  insertAgent("agent-2", APP_2, ORG_A, p2.principalId);
  const tokBad = mint(APP_1, KEY_1, p1.principalId, { agentId: "agent-2" });
  assert.equal(verifyWSAppAuth(wsUrl(APP_1, tokBad, KEY_1)), null, "agent from another app rejected");
  console.log("✓ 7. agent binding: in-app accepted, cross-app agent rejected");
}

// 8. Disabled AppKey (application status=disabled) → reject.
{
  const p3 = getOrCreateAppPrincipal(APP_3, "ivan", ORG_A);
  const t = mint(APP_3, KEY_3, p3.principalId);
  assert.ok(verifyWSAppAuth(wsUrl(APP_3, t, KEY_3)), "active app connects");
  applicationService.updateApplication(APP_3, { status: "disabled" });
  assert.equal(verifyWSAppAuth(wsUrl(APP_3, t, KEY_3)), null, "disabled app key rejected");
  console.log("✓ 8. disabled AppKey rejected");
}

// 9. Browser token carries NO raw subject — only the opaque principalId.
{
  const p = getOrCreateAppPrincipal(APP_1, "judy", ORG_A);
  const t = mint(APP_1, KEY_1, p.principalId);
  const decoded = jwt.decode(t) as Record<string, unknown> | null;
  assert.ok(decoded, "token decodes");
  assert.equal(decoded!.kind, "widget");
  assert.equal(decoded!.principalType, "app");
  assert.equal(decoded!.principalId, p.principalId);
  assert.ok(!("subject" in decoded!), "raw subject must NEVER be embedded in the token");
  console.log("✓ 9. browser token has no raw subject; principalId is opaque");
}

// 10. Path-A regression: appKey + platform User JWT still works.
//     M2: path A now requires an application_access_grant; grant plat-user-1
//     entry to APP_1 so the regression stays meaningful (proves the gate
//     ADMITS a granted platform user, not that it skips the check).
{
  insertPlatformUser("plat-user-1", ORG_A);
  applicationAccessGrantsService.replaceGrants(APP_1, { grants: [{ principalType: "user", principalId: "plat-user-1" }] }, "tester");
  const userJwt = jwt.sign(
    { userId: "plat-user-1", username: "plat-user-1", role: "user", orgId: ORG_A, tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  const r = verifyWSAppAuth(wsUrl(APP_1, userJwt, KEY_1));
  assert.ok(r, "path A (appKey + user JWT) must still work");
  assert.equal(r!.userId, "plat-user-1");
  assert.equal(r!.ctx.appId, APP_1);
  assert.equal(r!.ctx.orgId, ORG_A);
  console.log("✓ 10. path-A platform user JWT regression passes (with access grant)");
}

// 11. A widget token WITHOUT principalType:"app" is not accepted as path B.
{
  const p = getOrCreateAppPrincipal(APP_1, "karl", ORG_A);
  const notApp = jwt.sign(
    { kind: "widget", appId: APP_1, userId: p.principalId, role: "user", pageSessionId: "ps", apiKeyPrefix: KEY_1.slice(0, 16) },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  assert.equal(verifyWSAppAuth(wsUrl(APP_1, notApp, KEY_1)), null, "non-app widget token rejected on path B");
  console.log("✓ 11. widget token without principalType:app rejected (no silent platform fallback)");
}

// 12. (codex gap 1) Same-org cross-app principalId swap: a token that LIES about
//     its appId (claims APP_1 to pass scope) but carries a principalId that
//     actually belongs to APP_2 (same org). Must be rejected by
//     principal.appId === keyApp.appId. The prefix is bound to KEY_1 so the
//     prefix check passes and principal.appId is the rejector.
{
  const p2 = getOrCreateAppPrincipal(APP_2, "lia", ORG_A);
  const swapped = craftAppToken({
    appId: APP_1, // lie: claims APP_1 to pass scope vs KEY_1
    userId: p2.principalId,
    principalId: p2.principalId, // actually belongs to APP_2
    apiKeyPrefix: KEY_1.slice(0, 16),
  });
  assert.equal(
    verifyWSAppAuth(wsUrl(APP_1, swapped, KEY_1)),
    null,
    "same-org cross-app principalId swap must be rejected (principal.appId check)"
  );
  console.log("✓ 12. (gap 1) same-org cross-app principalId swap rejected");
}

// 13. (codex gap 2) AppKey rotation: a runtime token minted under the OLD key
//     must be rejected when the NEW key is presented (prefix mismatch). A fresh
//     token minted under the NEW key works.
{
  const p = getOrCreateAppPrincipal(APP_1, "mike", ORG_A);
  const oldToken = mint(APP_1, KEY_1, p.principalId);
  // Sanity: old key + old token works before rotation.
  assert.ok(verifyWSAppAuth(wsUrl(APP_1, oldToken, KEY_1)), "pre-rotation: old key + old token works");
  // Rotate: generateAppKey overwrites api_key_prefix/hash → old key no longer
  // resolves, and old tokens carry the OLD prefix.
  const KEY_1b = applicationService.generateAppKey(APP_1).key;
  // New key + OLD token → the presented prefix (P_new) ≠ token's bound prefix
  // (P_old) → reject.
  assert.equal(
    verifyWSAppAuth(wsUrl(APP_1, oldToken, KEY_1b)),
    null,
    "post-rotation: new key + old token must be rejected (prefix bind)"
  );
  // Old key + old token → verifyAppKeyWithOrg(oldKey) finds nothing (prefix
  // gone) → reject (existing behavior).
  assert.equal(
    verifyWSAppAuth(wsUrl(APP_1, oldToken, KEY_1)),
    null,
    "post-rotation: old key no longer resolves"
  );
  // Fresh token minted under the NEW key works with the NEW key.
  const newToken = mint(APP_1, KEY_1b, p.principalId);
  assert.ok(verifyWSAppAuth(wsUrl(APP_1, newToken, KEY_1b)), "post-rotation: new key + new token works");
  console.log("✓ 13. (gap 2) AppKey rotation invalidates old runtime tokens; new key works");
}

// ─── REST path-B (appAuthMiddleware) ──────────────────────────
// P0.2 spec: WS/REST dual-identity. The Runtime Token must also authenticate
// REST `/api/apps/:appId/*`, reusing the SAME deny-default chain. These tests
// exercise appAuthMiddleware directly (pure-module, no HTTP) and prove list /
// create agent work for an app principal (owner_user_id = principalId).

const APP_4 = "app-4";
const KEY_4 = setupApp(APP_4, ORG_A);

function mockReq(opts: { appId: string; appKey?: string; bearer?: string }): any {
  const headers: Record<string, string | undefined> = {};
  if (opts.appKey !== undefined) headers["x-app-key"] = opts.appKey;
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return { headers, params: { appId: opts.appId } };
}

function mockRes(): { statusCode: number; body: any; status(c: number): any; json(b: any): any } {
  const r: any = { statusCode: 0, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function runAuth(req: any): { ok: boolean; status: number; body: any } {
  const res = mockRes();
  let nextCalled = false;
  appAuthMiddleware(req, res as any, () => { nextCalled = true; });
  return { ok: nextCalled, status: res.statusCode, body: res.body };
}

// R1. Path B REST happy: runtime token + appKey → next(), opaque principalId.
{
  const p = getOrCreateAppPrincipal(APP_4, "nora", ORG_A);
  const tok = mint(APP_4, KEY_4, p.principalId);
  const req = mockReq({ appId: APP_4, appKey: KEY_4, bearer: tok });
  const r = runAuth(req);
  assert.ok(r.ok, "path B REST must pass");
  assert.equal(req.userId, p.principalId, "REST userId must be the opaque principalId");
  assert.equal(req.appId, APP_4);
  assert.equal(req.orgId, ORG_A);
  console.log("✓ R1. REST path-B accepts runtime token; principalId is the data-plane key");
}

// R2. Path B REST list-agent ownership: only agents owned by this principal.
{
  const pa = getOrCreateAppPrincipal(APP_4, "oscar", ORG_A);
  const pb = getOrCreateAppPrincipal(APP_4, "piper", ORG_A);
  insertAgent("agent-oscar", APP_4, ORG_A, pa.principalId);
  insertAgent("agent-piper", APP_4, ORG_A, pb.principalId);
  const tok = mint(APP_4, KEY_4, pa.principalId);
  const req = mockReq({ appId: APP_4, appKey: KEY_4, bearer: tok });
  assert.ok(runAuth(req).ok);
  const list = agentService.listByApp(req.userId, req.appId, req.orgId);
  const ids = list.map((a: any) => a.id);
  assert.ok(ids.includes("agent-oscar"), "principal sees its own agent");
  assert.ok(!ids.includes("agent-piper"), "principal does NOT see another subject's agent");
  console.log("✓ R2. REST path-B listByApp is principal-scoped (no cross-subject leak)");
}

// R3. Path B REST create-agent: createAgentForApp(principalId) works, owned by principal.
{
  const p = getOrCreateAppPrincipal(APP_4, "quinn", ORG_A);
  const tok = mint(APP_4, KEY_4, p.principalId);
  const req = mockReq({ appId: APP_4, appKey: KEY_4, bearer: tok });
  assert.ok(runAuth(req).ok);
  const created = agentService.createAgentForApp(req.userId, req.appId, "Quinn agent", req.orgId);
  assert.equal(created.userId, p.principalId, "new agent is owned by the app principal");
  const list = agentService.listByApp(req.userId, req.appId, req.orgId);
  assert.ok(list.some((a: any) => a.id === created.id), "new agent visible to its principal");
  console.log("✓ R3. REST path-B createAgentForApp works; agent owned by app principal");
}

// R4. Path B REST cross-app token → 401 (scope via principal.appId).
{
  const p1 = getOrCreateAppPrincipal(APP_1, "rachel", ORG_A);
  const tok = mint(APP_1, KEY_1, p1.principalId); // APP_1 principal + APP_1 key prefix
  // Present against APP_4 with KEY_4: scope (token.appId APP_1 ≠ keyApp.appId APP_4) + prefix mismatch.
  const r = runAuth(mockReq({ appId: APP_4, appKey: KEY_4, bearer: tok }));
  assert.equal(r.ok, false, "cross-app runtime token rejected on REST");
  assert.equal(r.status, 401);
  console.log("✓ R4. REST path-B cross-app token rejected (401)");
}

// R5. Path A REST regression: platform user JWT + appKey still works.
//     M2: APP_4 needs an access grant for plat-user-1 (path A gate).
{
  // plat-user-1 inserted in test 10; reuse it.
  applicationAccessGrantsService.replaceGrants(APP_4, { grants: [{ principalType: "user", principalId: "plat-user-1" }] }, "tester");
  const userJwt = jwt.sign(
    { userId: "plat-user-1", username: "plat-user-1", role: "user", orgId: ORG_A, tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  const req = mockReq({ appId: APP_4, appKey: KEY_4, bearer: userJwt });
  const r = runAuth(req);
  assert.ok(r.ok, "path A REST must still work");
  assert.equal(req.userId, "plat-user-1");
  console.log("✓ R5. REST path-A platform user JWT regression passes (with access grant)");
}

// R6. Path B REST disabled AppKey → 401.
{
  const p = getOrCreateAppPrincipal(APP_4, "sam", ORG_A);
  const tok = mint(APP_4, KEY_4, p.principalId);
  applicationService.updateApplication(APP_4, { status: "disabled" });
  const r = runAuth(mockReq({ appId: APP_4, appKey: KEY_4, bearer: tok }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 401, "disabled app key rejected on REST");
  applicationService.updateApplication(APP_4, { status: "active" });
  console.log("✓ R6. REST path-B disabled AppKey rejected (401)");
}

// R7. Path B REST AppKey rotation → old token rejected.
{
  const p = getOrCreateAppPrincipal(APP_4, "tina", ORG_A);
  const oldTok = mint(APP_4, KEY_4, p.principalId);
  const KEY_4b = applicationService.generateAppKey(APP_4).key;
  const r = runAuth(mockReq({ appId: APP_4, appKey: KEY_4b, bearer: oldTok }));
  assert.equal(r.ok, false, "post-rotation old token rejected on REST");
  assert.equal(r.status, 401);
  const newTok = mint(APP_4, KEY_4b, p.principalId);
  const r2 = runAuth(mockReq({ appId: APP_4, appKey: KEY_4b, bearer: newTok }));
  assert.ok(r2.ok, "new key + new token works on REST");
  console.log("✓ R7. REST path-B AppKey rotation invalidates old tokens");
}

// ─── M1: Token-only (no plaintext AppKey) ─────────────────────
// The Runtime Token alone proves the Application (re-read by appId) + the
// principal. Browser REST/WS path-B2 carries NO X-App-Key / ?appKey=. These
// tests prove the token-only happy paths and the full rejection matrix, plus
// S2S (appKey) regressions to prove the existing dual-identity paths survive.

const APP_5 = "app-5";
const KEY_5 = setupApp(APP_5, ORG_A); // fresh app, untouched by earlier rotation tests

function wsUrlTokenOnly(appId: string, token: string): URL {
  return new URL(
    `http://localhost/api/apps/${appId}/ws?token=${encodeURIComponent(token)}`
  );
}

// M1-1. Token-only REST happy: Bearer runtime token, NO X-App-Key → next().
{
  const p = getOrCreateAppPrincipal(APP_5, "m1alice", ORG_A);
  const tok = mint(APP_5, KEY_5, p.principalId);
  const req = mockReq({ appId: APP_5, bearer: tok }); // no appKey
  assert.ok(!req.headers["x-app-key"], "no X-App-Key in the browser request");
  const r = runAuth(req);
  assert.ok(r.ok, "token-only REST must pass without AppKey");
  assert.equal(req.userId, p.principalId);
  assert.equal(req.appId, APP_5);
  assert.equal(req.orgId, ORG_A);
  console.log("✓ M1-1. token-only REST accepts Runtime Token; no X-App-Key");
}

// M1-2. Token-only REST list-agent: principal sees only its own agents.
{
  const pa = getOrCreateAppPrincipal(APP_5, "m1bob", ORG_A);
  const pb = getOrCreateAppPrincipal(APP_5, "m1cara", ORG_A);
  insertAgent("agent-m1bob", APP_5, ORG_A, pa.principalId);
  insertAgent("agent-m1cara", APP_5, ORG_A, pb.principalId);
  const req = mockReq({ appId: APP_5, bearer: mint(APP_5, KEY_5, pa.principalId) });
  assert.ok(runAuth(req).ok);
  const ids = agentService.listByApp(req.userId, req.appId, req.orgId).map((a: any) => a.id);
  assert.ok(ids.includes("agent-m1bob"));
  assert.ok(!ids.includes("agent-m1cara"));
  console.log("✓ M1-2. token-only REST listByApp is principal-scoped");
}

// M1-3. Token-only REST wrong URL appId → 401 (route consistency).
{
  const p = getOrCreateAppPrincipal(APP_5, "m1dan", ORG_A);
  const tok = mint(APP_5, KEY_5, p.principalId); // token for APP_5
  const r = runAuth(mockReq({ appId: APP_2, bearer: tok })); // URL says APP_2
  assert.equal(r.ok, false, "wrong URL appId rejected");
  assert.equal(r.status, 401);
  console.log("✓ M1-3. token-only REST wrong URL appId rejected (401)");
}

// M1-4. Token-only REST rotated credential → 401 (prefix mismatch vs app record).
{
  const p = getOrCreateAppPrincipal(APP_5, "m1eve", ORG_A);
  const oldTok = mint(APP_5, KEY_5, p.principalId); // bound to KEY_5's prefix
  const KEY_5b = applicationService.generateAppKey(APP_5).key; // rotate
  const r = runAuth(mockReq({ appId: APP_5, bearer: oldTok })); // no appKey
  assert.equal(r.ok, false, "rotated-away credential token rejected (token-only)");
  assert.equal(r.status, 401);
  const newTok = mint(APP_5, KEY_5b, p.principalId);
  assert.ok(runAuth(mockReq({ appId: APP_5, bearer: newTok })).ok, "new token works token-only");
  console.log("✓ M1-4. token-only REST rotation invalidates old tokens; new works");
}

// M1-5. Token-only REST disabled Application → 401.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1fra", ORG_A);
  const tok = mint(APP_5, applicationService.generateAppKey(APP_5).key, p.principalId);
  applicationService.updateApplication(APP_5, { status: "disabled" });
  assert.equal(runAuth(mockReq({ appId: APP_5, bearer: tok })).status, 401, "disabled app rejected");
  applicationService.updateApplication(APP_5, { status: "active" });
  console.log("✓ M1-5. token-only REST disabled Application rejected (401)");
}

// M1-6. Token-only REST disabled principal → 401.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1grace", ORG_A);
  const tok = mint(APP_5, applicationService.generateAppKey(APP_5).key, p.principalId);
  setAppPrincipalStatus(p.principalId, "disabled");
  assert.equal(runAuth(mockReq({ appId: APP_5, bearer: tok })).status, 401, "disabled principal rejected");
  setAppPrincipalStatus(p.principalId, "active");
  console.log("✓ M1-6. token-only REST disabled principal rejected (401)");
}

// M1-7. Token-only REST expired token → 401.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1henry", ORG_A);
  const k = applicationService.generateAppKey(APP_5).key;
  const expired = jwt.sign(
    {
      kind: "widget", appId: APP_5, userId: p.principalId, role: "user", pageSessionId: "ps",
      principalType: "app", principalId: p.principalId, apiKeyPrefix: k.slice(0, 16),
      exp: Math.floor(Date.now() / 1000) - 60,
    },
    JWT_SECRET
  );
  assert.equal(runAuth(mockReq({ appId: APP_5, bearer: expired })).status, 401, "expired rejected");
  console.log("✓ M1-7. token-only REST expired token rejected (401)");
}

// M1-8. Token-only REST wrong agent binding → 401.
{
  const p1 = getOrCreateAppPrincipal(APP_5, "m1iris", ORG_A);
  insertAgent("agent-m1iris", APP_5, ORG_A, p1.principalId);
  const p2 = getOrCreateAppPrincipal(APP_2, "m1josh", ORG_A);
  insertAgent("agent-m1josh", APP_2, ORG_A, p2.principalId);
  const k = applicationService.generateAppKey(APP_5).key;
  const tok = jwt.sign(
    {
      kind: "widget", appId: APP_5, userId: p1.principalId, role: "user", pageSessionId: "ps",
      principalType: "app", principalId: p1.principalId, agentId: "agent-m1josh", apiKeyPrefix: k.slice(0, 16),
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  assert.equal(runAuth(mockReq({ appId: APP_5, bearer: tok })).status, 401, "wrong agent binding rejected");
  console.log("✓ M1-8. token-only REST wrong agent binding rejected (401)");
}

// M1-9. Token-only REST cross-app principalId swap → 401.
{
  const p2 = getOrCreateAppPrincipal(APP_2, "m1kara", ORG_A); // belongs to APP_2
  const k = applicationService.generateAppKey(APP_5).key;
  const swapped = jwt.sign(
    {
      kind: "widget", appId: APP_5, userId: p2.principalId, role: "user", pageSessionId: "ps",
      principalType: "app", principalId: p2.principalId, apiKeyPrefix: k.slice(0, 16),
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  assert.equal(runAuth(mockReq({ appId: APP_5, bearer: swapped })).status, 401, "cross-app principalId rejected");
  console.log("✓ M1-9. token-only REST cross-app principalId swap rejected (401)");
}

// M1-10. S2S regression: appKey + Runtime Token (B1) still works.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1leo", ORG_A);
  const k = applicationService.generateAppKey(APP_5).key;
  const tok = mint(APP_5, k, p.principalId);
  const req = mockReq({ appId: APP_5, appKey: k, bearer: tok });
  assert.ok(runAuth(req).ok, "S2S appKey+token must still work");
  assert.equal(req.userId, p.principalId);
  console.log("✓ M1-10. S2S appKey + Runtime Token regression passes");
}

// M1-11. S2S regression: appKey + platform user JWT (path A) still works.
//        M2: APP_5 needs an access grant for plat-user-1 (path A gate).
{
  applicationAccessGrantsService.replaceGrants(APP_5, { grants: [{ principalType: "user", principalId: "plat-user-1" }] }, "tester");
  const userJwt = jwt.sign(
    { userId: "plat-user-1", username: "plat-user-1", role: "user", orgId: ORG_A, tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  const k = applicationService.generateAppKey(APP_5).key;
  const req = mockReq({ appId: APP_5, appKey: k, bearer: userJwt });
  assert.ok(runAuth(req).ok, "S2S appKey+userJWT must still work");
  assert.equal(req.userId, "plat-user-1");
  console.log("✓ M1-11. S2S appKey + platform user JWT regression passes (with access grant)");
}

// ─── M1 WS token-only (verifyWSAppAuth with ?token=, no ?appKey=) ───

// M1-W1. Token-only WS happy.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1mia", ORG_A);
  const tok = mint(APP_5, applicationService.generateAppKey(APP_5).key, p.principalId);
  const u = wsUrlTokenOnly(APP_5, tok);
  assert.ok(!u.searchParams.get("appKey"), "no appKey in WS URL");
  const r = verifyWSAppAuth(u);
  assert.ok(r, "token-only WS must pass");
  assert.equal(r!.userId, p.principalId);
  assert.equal(r!.ctx.appId, APP_5);
  console.log("✓ M1-W1. token-only WS accepts Runtime Token; no appKey in URL");
}

// M1-W2. Token-only WS wrong URL appId → null.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1nia", ORG_A);
  const tok = mint(APP_5, applicationService.generateAppKey(APP_5).key, p.principalId);
  assert.equal(verifyWSAppAuth(wsUrlTokenOnly(APP_2, tok)), null, "wrong URL appId rejected");
  console.log("✓ M1-W2. token-only WS wrong URL appId rejected");
}

// M1-W3. Token-only WS rotated credential → null.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1olivia", ORG_A);
  const oldTok = mint(APP_5, KEY_5, p.principalId);
  applicationService.generateAppKey(APP_5).key; // rotate (KEY_5 now stale)
  assert.equal(verifyWSAppAuth(wsUrlTokenOnly(APP_5, oldTok)), null, "rotated credential rejected");
  console.log("✓ M1-W3. token-only WS rotation invalidates old tokens");
}

// M1-W4. Token-only WS disabled app → null.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1paul", ORG_A);
  const k = applicationService.generateAppKey(APP_5).key;
  const tok = mint(APP_5, k, p.principalId);
  applicationService.updateApplication(APP_5, { status: "disabled" });
  assert.equal(verifyWSAppAuth(wsUrlTokenOnly(APP_5, tok)), null, "disabled app rejected");
  applicationService.updateApplication(APP_5, { status: "active" });
  console.log("✓ M1-W4. token-only WS disabled Application rejected");
}

// M1-W5. Token-only WS disabled principal → null.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1quinn", ORG_A);
  const k = applicationService.generateAppKey(APP_5).key;
  const tok = mint(APP_5, k, p.principalId);
  setAppPrincipalStatus(p.principalId, "disabled");
  assert.equal(verifyWSAppAuth(wsUrlTokenOnly(APP_5, tok)), null, "disabled principal rejected");
  setAppPrincipalStatus(p.principalId, "active");
  console.log("✓ M1-W5. token-only WS disabled principal rejected");
}

// M1-W6. Token-only WS expired → null.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1rose", ORG_A);
  const k = applicationService.generateAppKey(APP_5).key;
  const expired = jwt.sign(
    {
      kind: "widget", appId: APP_5, userId: p.principalId, role: "user", pageSessionId: "ps",
      principalType: "app", principalId: p.principalId, apiKeyPrefix: k.slice(0, 16),
      exp: Math.floor(Date.now() / 1000) - 60,
    },
    JWT_SECRET
  );
  assert.equal(verifyWSAppAuth(wsUrlTokenOnly(APP_5, expired)), null, "expired rejected");
  console.log("✓ M1-W6. token-only WS expired token rejected");
}

// M1-W7. Token-only WS cross-app principalId → null.
{
  const p2 = getOrCreateAppPrincipal(APP_2, "m1sam", ORG_A);
  const k = applicationService.generateAppKey(APP_5).key;
  const swapped = jwt.sign(
    {
      kind: "widget", appId: APP_5, userId: p2.principalId, role: "user", pageSessionId: "ps",
      principalType: "app", principalId: p2.principalId, apiKeyPrefix: k.slice(0, 16),
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  assert.equal(verifyWSAppAuth(wsUrlTokenOnly(APP_5, swapped)), null, "cross-app principalId rejected");
  console.log("✓ M1-W7. token-only WS cross-app principalId swap rejected");
}

// M1-W8. S2S WS regression: appKey + Runtime Token (B1) still works.
{
  const p = getOrCreateAppPrincipal(APP_5, "m1tom", ORG_A);
  const k = applicationService.generateAppKey(APP_5).key;
  const tok = mint(APP_5, k, p.principalId);
  const r = verifyWSAppAuth(wsUrl(APP_5, tok, k)); // S2S: token + appKey
  assert.ok(r, "S2S WS appKey+token must still work");
  assert.equal(r!.userId, p.principalId);
  console.log("✓ M1-W8. S2S WS appKey + Runtime Token regression passes");
}

// M1-W9. S2S WS regression: appKey + platform user JWT (path A) still works.
{
  const userJwt = jwt.sign(
    { userId: "plat-user-1", username: "plat-user-1", role: "user", orgId: ORG_A, tokenVersion: 1 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  const k = applicationService.generateAppKey(APP_5).key;
  const r = verifyWSAppAuth(wsUrl(APP_5, userJwt, k));
  assert.ok(r, "S2S WS appKey+userJWT must still work");
  assert.equal(r!.userId, "plat-user-1");
  console.log("✓ M1-W9. S2S WS appKey + platform user JWT regression passes");
}

// M1-R1. redactWsAuthQuery: no credential value ever leaks into a log line.
// Regression for the app-scoped WS connection log (server.ts:2976): the URL
// carries the full Runtime Token / User JWT as `token=` and the AppKey as
// `appKey=`. Neither value may survive redaction in any param order.
{
  const token = "eyJhbGciOiJIUzI1NiJ9.SECRET_RUNTIME_TOKEN_PAYLOAD.abc123_-_";
  const appKey = "sap_live_TESTKEY_0123456789";
  // app-scoped URL, token-first order
  const u1 = `/api/apps/${APP_1}/ws?token=${token}&appKey=${appKey}`;
  // app-scoped URL, appKey-first order
  const u2 = `/api/apps/${APP_1}/ws?appKey=${appKey}&token=${token}`;
  // widget path carries widgetToken
  const u3 = `/api/apps/${APP_1}/ws?widgetToken=${token}`;
  // legacy path carries only token
  const u4 = `/ws?token=${token}`;

  for (const [label, u] of [["token-first", u1], ["appKey-first", u2], ["widget", u3], ["legacy", u4]] as const) {
    const red = redactWsAuthQuery(u);
    assert.ok(!red.includes(token), `${label}: raw token leaked into redacted URL: ${red}`);
    assert.ok(!red.includes(appKey), `${label}: raw appKey leaked into redacted URL: ${red}`);
    assert.ok(/=REDACTED/.test(red), `${label}: redaction marker missing in ${red}`);
  }
  // Case-insensitivity + param-name preserved (for grep-ability of WHICH cred).
  const mixed = redactWsAuthQuery(`/api/apps/${APP_1}/ws?ToKeN=${token}`);
  assert.ok(!mixed.includes(token), "mixed-case param name leaked token");
  assert.ok(/ToKeN=REDACTED/.test(mixed), "mixed-case param name not preserved");

  console.log("✓ M1-R1. redactWsAuthQuery masks token/appKey/widgetToken in all orders; no credential leaks");
}

console.log("\nAll app-runtime-token tests passed.");
