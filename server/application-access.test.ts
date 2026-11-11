/**
 * application-access.test.ts — Agent OS M2 application access grants.
 *
 * Covers the focused security matrix required by the M2 brief:
 *   - grant model: deny-default, org grant, user grant, cross-org rejection
 *   - org_admin boundary + ordinary-user rejection (admin route layer)
 *   - platform JWT app-scoped allow/deny via appAuthMiddleware (REST) +
 *     verifyWSAppAuth (WS); admin bypass
 *   - app-principal Runtime Token regression (path B unaffected by grants)
 *
 * See docs/开发计划/agent-os-overall-plan.md §6.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import jwt from "jsonwebtoken";
import express from "express";
import type { Request, Response, NextFunction } from "express";

// ─── Env before imports ──────────────────────────────────────
const TMP_DB = "/tmp/test-m2-application-access.db";
process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = "m2-access-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
rmSync(TMP_DB, { force: true });

const JWT_SECRET = process.env.JWT_SECRET;

const db = (await import("./database.js")).default;
const { applicationService } = await import("./application-service.js");
const { applicationAccessGrantsService } = await import("./application-access.js");
const { getOrCreateAppPrincipal } = await import("./app-principal.js");
const { signRuntimeToken } = await import("./auth.js");
const { verifyWSAppAuth, appAuthMiddleware } = await import("./app-auth.js");
const { createAdminAppRoutes } = await import("./admin-app-routes.js");
const { isPrivilegedReq, isAdminReq } = await import("./request-context.js");

// ─── Helpers ─────────────────────────────────────────────────

const ORG_A = "m2-org-a";
const ORG_B = "m2-org-b";
const APP_A = "m2-app-a"; // org A
const APP_B = "m2-app-b"; // org B

function setupApp(appId: string, orgId: string): string {
  applicationService.createApplication({ id: appId, orgId, name: appId });
  return applicationService.generateAppKey(appId).key;
}

function insertPlatformUser(userId: string, orgId: string, role: "user" | "admin" | "org_admin" = "user"): void {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status, token_version, must_change_password, created_at)
     VALUES (?, ?, 'x', ?, ?, 'active', 1, 0, datetime('now'))`
  ).run(userId, `u_${userId}`, role, orgId);
}

function platformJwt(userId: string, orgId: string, role: string, tokenVersion = 1): string {
  return jwt.sign(
    { userId, username: userId, role, orgId, tokenVersion },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function wsUrl(appId: string, token: string, appKey: string): URL {
  return new URL(
    `http://localhost/api/apps/${appId}/ws?token=${encodeURIComponent(token)}&appKey=${encodeURIComponent(appKey)}`
  );
}

function mint(appId: string, appKey: string, principalId: string): string {
  return signRuntimeToken({
    appId,
    principalId,
    pageSessionId: "ps",
    apiKeyPrefix: appKey.slice(0, 16),
  });
}

function mockReq(opts: { appId: string; appKey?: string; bearer?: string }): any {
  const headers: Record<string, string | undefined> = {};
  if (opts.appKey !== undefined) headers["x-app-key"] = opts.appKey;
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return { headers, params: { appId: opts.appId } };
}

function mockRes(): any {
  const r: any = { statusCode: 0, body: null };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function runAuth(req: any): { ok: boolean; status: number; body: any } {
  const res = mockRes();
  let nextCalled = false;
  appAuthMiddleware(req, res, () => { nextCalled = true; });
  return { ok: nextCalled, status: res.statusCode, body: res.body };
}

/** Mount createAdminAppRoutes with the production-style privileged gate
 * (admin|org_admin only) and identity injection. Mirrors server.ts mount. */
function startAdminApp(stubRole: string, stubOrgId: string, stubUserId = "actor-x"): {
  base: string; close: () => void;
} {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    (req as any).userId = stubUserId;
    (req as any).userRole = stubRole;
    (req as any).orgId = stubOrgId;
    if (!isPrivilegedReq(req)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  });
  app.use("/", createAdminAppRoutes());
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function putGrants(base: string, appId: string, grants: Array<{ principalType: string; principalId: string }>): Promise<globalThis.Response> {
  return fetch(`${base}/applications/${encodeURIComponent(appId)}/access-grants`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grants }),
  });
}
async function getGrants(base: string, appId: string): Promise<globalThis.Response> {
  return fetch(`${base}/applications/${encodeURIComponent(appId)}/access-grants`);
}

// ─── Setup ───────────────────────────────────────────────────

const KEY_A = setupApp(APP_A, ORG_A);
const KEY_B = setupApp(APP_B, ORG_B);

const USER_A1 = "m2-user-a1"; // org A
const USER_A2 = "m2-user-a2"; // org A
const USER_B1 = "m2-user-b1"; // org B
insertPlatformUser(USER_A1, ORG_A);
insertPlatformUser(USER_A2, ORG_A);
insertPlatformUser(USER_B1, ORG_B);

// ─── Service-level grant model ───────────────────────────────

// S1. Deny by default: no grants for APP_A → hasAccess false.
{
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A1, ORG_A), false, "deny-default: no grant");
  assert.equal(applicationAccessGrantsService.hasAnyGrant(APP_A), false, "no grants exist");
  console.log("✓ S1. deny-default: no grant → hasAccess false");
}

// S2. org grant: any user in that org may enter.
{
  const grants = applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "org", principalId: ORG_A }] }, "tester");
  assert.equal(grants.length, 1, "one org grant created");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A1, ORG_A), true, "org grant → user in org allowed");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A2, ORG_A), true, "org grant → other user in org allowed");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_B1, ORG_B), false, "org grant does NOT cover other-org user");
  // reset for subsequent tests
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ S2. org grant covers all users in that org; rejects other-org user");
}

// S3. user grant: only the named user.
{
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "user", principalId: USER_A1 }] }, "tester");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A1, ORG_A), true, "user grant → that user allowed");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A2, ORG_A), false, "user grant → different user rejected (same org)");
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ S3. user grant is per-user; same-org other user rejected");
}

// S4. replace is a full replace (delete-then-insert): stale grants vanish.
{
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "user", principalId: USER_A1 }] }, "tester");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A1, ORG_A), true);
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "user", principalId: USER_A2 }] }, "tester");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A1, ORG_A), false, "old user grant removed by replace");
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A2, ORG_A), true, "new user grant in effect");
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ S4. replace is full replace; stale grants vanish");
}

// ─── Platform JWT path A: allow/deny via middleware ──────────

// M-REST-1. platform JWT path A, NO grant → 403 NO_ACCESS_GRANT.
{
  assert.equal(applicationAccessGrantsService.hasAnyGrant(APP_A), false, "precondition: no grants");
  const req = mockReq({ appId: APP_A, appKey: KEY_A, bearer: platformJwt(USER_A1, ORG_A, "user") });
  const r = runAuth(req);
  assert.equal(r.ok, false, "no grant → middleware does not call next()");
  assert.equal(r.status, 403, "no grant → 403");
  assert.equal(r.body?.code, "NO_ACCESS_GRANT", "403 carries NO_ACCESS_GRANT code");
  console.log("✓ M-REST-1. platform JWT path A: no grant → 403 NO_ACCESS_GRANT");
}

// M-REST-2. platform JWT path A + user grant → next() (authorized).
{
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "user", principalId: USER_A1 }] }, "tester");
  const req = mockReq({ appId: APP_A, appKey: KEY_A, bearer: platformJwt(USER_A1, ORG_A, "user") });
  const r = runAuth(req);
  assert.equal(r.ok, true, "user grant → next() called");
  assert.equal((req as any).appId, APP_A, "appId set");
  assert.equal((req as any).userId, USER_A1, "userId set");
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ M-REST-2. platform JWT path A + user grant → authorized");
}

// M-REST-3. platform JWT path A + org grant → next() (any user in org).
{
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "org", principalId: ORG_A }] }, "tester");
  const req = mockReq({ appId: APP_A, appKey: KEY_A, bearer: platformJwt(USER_A2, ORG_A, "user") });
  const r = runAuth(req);
  assert.equal(r.ok, true, "org grant → next() for any user in org");
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ M-REST-3. platform JWT path A + org grant → authorized");
}

// M-REST-4. admin is NOT exempt — the grant gate is deny-default for EVERY
//           platform-JWT principal incl. admin (codex review r1 #1). Admin
//           recovery lives on /api/admin/*, not the Application execution path.
{
  assert.equal(applicationAccessGrantsService.hasAnyGrant(APP_A), false, "precondition: no grants");
  const reqNoGrant = mockReq({ appId: APP_A, appKey: KEY_A, bearer: platformJwt(USER_A1, ORG_A, "admin") });
  const denied = runAuth(reqNoGrant);
  assert.equal(denied.ok, false, "admin with no grant → not admitted");
  assert.equal(denied.status, 403, "admin with no grant → 403 NO_ACCESS_GRANT");
  assert.equal(denied.body?.code, "NO_ACCESS_GRANT", "admin gets the same deny code");
  // with a grant, admin enters like any platform principal
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "user", principalId: USER_A1 }] }, "tester");
  const reqGranted = mockReq({ appId: APP_A, appKey: KEY_A, bearer: platformJwt(USER_A1, ORG_A, "admin") });
  assert.equal(runAuth(reqGranted).ok, true, "admin with a grant → admitted");
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ M-REST-4. admin is NOT exempt: no grant → 403 (same as user); grant → admitted");
}

// M-REST-5. app-principal Runtime Token (path B) succeeds WITHOUT any grant.
//          Regression: grants never gate app-principal access.
{
  assert.equal(applicationAccessGrantsService.hasAnyGrant(APP_A), false, "precondition: no grants");
  const p = getOrCreateAppPrincipal(APP_A, "app-subject-1", ORG_A);
  const tok = mint(APP_A, KEY_A, p.principalId);
  const req = mockReq({ appId: APP_A, appKey: KEY_A, bearer: tok });
  const r = runAuth(req);
  assert.equal(r.ok, true, "app-principal token → next() without grant");
  assert.equal((req as any).userId, p.principalId, "opaque principalId flows");
  console.log("✓ M-REST-5. app-principal Runtime Token path B: NO grant needed (regression)");
}

// ─── Platform JWT path A: WS allow/deny ──────────────────────

// M-WS-1. platform JWT path A WS, NO grant → null (WS close 4001).
{
  const req = wsUrl(APP_A, platformJwt(USER_A1, ORG_A, "user"), KEY_A);
  assert.equal(verifyWSAppAuth(req), null, "no grant → WS path A rejected");
  console.log("✓ M-WS-1. platform JWT WS path A: no grant → null (close 4001)");
}

// M-WS-2. platform JWT path A WS + org grant → ok.
{
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [{ principalType: "org", principalId: ORG_A }] }, "tester");
  const r = verifyWSAppAuth(wsUrl(APP_A, platformJwt(USER_A2, ORG_A, "user"), KEY_A));
  assert.ok(r, "org grant → WS path A ok");
  assert.equal(r!.ctx.appId, APP_A);
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ M-WS-2. platform JWT WS path A + org grant → authorized");
}

// M-WS-3. app-principal Runtime Token WS path B, NO grant → ok (regression).
{
  const p = getOrCreateAppPrincipal(APP_A, "app-subject-2", ORG_A);
  const r = verifyWSAppAuth(wsUrl(APP_A, mint(APP_A, KEY_A, p.principalId), KEY_A));
  assert.ok(r, "app-principal WS path B ok without grant");
  assert.equal(r!.userId, p.principalId);
  console.log("✓ M-WS-3. app-principal Runtime Token WS path B: NO grant needed (regression)");
}

// ─── Admin route boundary tests ──────────────────────────────

// A1. ordinary user (role=user) cannot mutate grants — privileged mount rejects.
{
  const { base, close } = startAdminApp("user", ORG_A);
  const res = await putGrants(base, APP_A, [{ principalType: "user", principalId: USER_A1 }]);
  assert.equal(res.status, 403, "ordinary user → 403 at privileged mount");
  close();
  console.log("✓ A1. ordinary user cannot mutate grants (403 at /api/admin mount)");
}

// A2. admin replaces grants → returns the grant list.
{
  const { base, close } = startAdminApp("admin", ORG_A);
  const res = await putGrants(base, APP_A, [
    { principalType: "org", principalId: ORG_A },
    { principalType: "user", principalId: USER_A1 },
  ]);
  assert.equal(res.status, 200, "admin replace → 200");
  const body = await res.json();
  assert.equal(body.length, 2, "two grants persisted");
  close();
  // verify the grant actually took effect at the middleware
  const req = mockReq({ appId: APP_A, appKey: KEY_A, bearer: platformJwt(USER_A1, ORG_A, "user") });
  assert.equal(runAuth(req).ok, true, "grant from admin route gates middleware");
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ A2. admin replaces grants; list returned; grant gates middleware");
}

// A3. org_admin cross-org app → 404 (existence hidden).
{
  const { base, close } = startAdminApp("org_admin", ORG_A); // org_admin of org A
  const res = await getGrants(base, APP_B); // APP_B is org B
  assert.equal(res.status, 404, "cross-org app → 404");
  close();
  console.log("✓ A3. org_admin cross-org app → 404 (existence hidden)");
}

// A4. org_admin grants cross-org user → 403 (cannot grant cross-org users).
{
  const { base, close } = startAdminApp("org_admin", ORG_A); // org_admin of org A, APP_A is org A
  const res = await putGrants(base, APP_A, [{ principalType: "user", principalId: USER_B1 }]); // USER_B1 is org B
  assert.equal(res.status, 403, "org_admin granting cross-org user → 403");
  close();
  // verify no grant was persisted
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_B1, ORG_B), false, "no grant persisted");
  console.log("✓ A4. org_admin cannot grant cross-org users (403; nothing persisted)");
}

// A5. org_admin grants own-org user → 200 (allowed within own org).
{
  const { base, close } = startAdminApp("org_admin", ORG_A);
  const res = await putGrants(base, APP_A, [{ principalType: "user", principalId: USER_A2 }]);
  assert.equal(res.status, 200, "org_admin granting own-org user → 200");
  close();
  assert.equal(applicationAccessGrantsService.hasAccess(APP_A, USER_A2, ORG_A), true, "own-org user grant persisted");
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ A5. org_admin grants own-org user → 200");
}

// A6. org_admin grants foreign org (not own, not app's... app is org A, org_admin org A,
//     trying to grant org=ORG_B) → 403 (can only grant app's own org).
{
  const { base, close } = startAdminApp("org_admin", ORG_A);
  const res = await putGrants(base, APP_A, [{ principalType: "org", principalId: ORG_B }]);
  assert.equal(res.status, 403, "org_admin granting foreign org → 403");
  close();
  console.log("✓ A6. org_admin can only grant the application's own org");
}

// A7. admin grants cross-org user → 200 (admin exempt).
{
  const { base, close } = startAdminApp("admin", ORG_A);
  const res = await putGrants(base, APP_A, [{ principalType: "user", principalId: USER_B1 }]);
  assert.equal(res.status, 200, "admin granting cross-org user → 200");
  close();
  applicationAccessGrantsService.replaceGrants(APP_A, { grants: [] }, "tester");
  console.log("✓ A7. admin may grant cross-org users (exempt)");
}

// A8. unknown user grant → 400.
{
  const { base, close } = startAdminApp("admin", ORG_A);
  const res = await putGrants(base, APP_A, [{ principalType: "user", principalId: "nonexistent-user" }]);
  assert.equal(res.status, 400, "unknown user grant → 400");
  close();
  console.log("✓ A8. unknown user grant → 400");
}

// A9. invalid principalType → 400; empty principalId → 400.
{
  const { base, close } = startAdminApp("admin", ORG_A);
  const r1 = await putGrants(base, APP_A, [{ principalType: "team", principalId: USER_A1 }]);
  assert.equal(r1.status, 400, "invalid principalType → 400");
  const r2 = await putGrants(base, APP_A, [{ principalType: "user", principalId: "  " }]);
  assert.equal(r2.status, 400, "empty principalId → 400");
  close();
  console.log("✓ A9. invalid principalType / empty principalId → 400");
}

console.log("\nAll application-access tests passed.");
