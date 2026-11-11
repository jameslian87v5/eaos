// M2 (user lifecycle) — focused integration test.
//
// Proves the M2 design invariants end-to-end against the REAL server (boots
// server.ts on an ephemeral port with a temp DB) + a real `ws` client:
//
//   1. Old JWT is rejected at every protected entry after disable / reset /
//      migrate (status check + token_version bump). Covers REST (authMiddleware)
//      AND the legacy WS connect path (the warm/cold-resume gate).
//   2. After restore, the pre-disable JWT is STILL rejected (token_version was
//      bumped on disable) → user must re-login. New login → fresh JWT works.
//   3. org_admin own-org / cross-org / privileged-account / migrate perms.
//   4. Create binds to an existing + active org (suspended org → 403).
//   5. Last active org_admin cannot be disabled.
//   6. Public self-registration stays closed.
//
// The route wiring (authMiddleware + WS handler call verifyUserTokenCurrent;
// PATCH dispatches to the primitives) is exercised for real here — not just
// code-reviewed — because the brief explicitly requires "Local 和 Docker
// WS/runtime 不接受失效 token".
//
// Run: npx tsx server/m2-user-lifecycle.test.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { WebSocket } from "ws";

// ─── Set env BEFORE any import that captures it ─────────────────────────
const PORT = "3991";
const DB_PATH = "/tmp/m2-user-lifecycle-test.db";
process.env.DB_PATH = DB_PATH;
process.env.PORT = PORT;
process.env.JWT_SECRET = "m2-test-secret-strong-and-random-9f3a";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";
// ALLOW_PUBLIC_REGISTER intentionally unset → closed (M1 + M2).

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });

const db = (await import("./database.js")).default;
// server.ts import boots the HTTP+WS server on PORT.
await import("./server.js");
const { provisionOrg, transitionOrgStatus } = await import("./org-governance.js");
const { getUserAuthState, verifyUserTokenCurrent } = await import("./auth.js");

const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/ws`;

// ─── Helpers ────────────────────────────────────────────────────────────
async function pollReady(): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "__probe__", password: "__probe__" }),
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not become ready in 10s");
}

async function postJson(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function patchJson(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
async function loginAs(username: string, password: string): Promise<{ token: string; user: any }> {
  const r = await postJson("/api/auth/login", { username, password });
  await assertOk(r, `login ${username}`);
  return r.json();
}
async function me(token: string): Promise<Response> {
  return fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Assert a 2xx response WITHOUT consuming the body (so the caller can .json()).
 *  Reads the body only on failure for the error message. */
async function assertOk(r: Response, what: string): Promise<void> {
  if (!r.ok) throw new Error(`${what} failed: HTTP ${r.status} ${await r.text()}`);
}

// Connect a legacy WS with a token; resolve with the close code+reason, or
// 'connected' if the server sends the connected frame first.
function wsConnect(token: string): Promise<{ code: number | null; reason: string; connected: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(token)}`);
    const done = (code: number | null, reason: string, connected: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({ code, reason, connected });
    };
    ws.on("open", () => {});
    ws.on("message", (d) => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.type === "connected") done(null, "", true);
      } catch {}
    });
    ws.on("close", (code, reasonBuf) => done(code, reasonBuf.toString(), false));
    ws.on("error", () => done(null, "error", false));
    setTimeout(() => done(null, "timeout", false), 3000);
  });
}

// ─── Setup: clear the seeded admin's must_change flag so it can hit admin ─
db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
const adminLogin = await loginAs("admin", "admin123");
const adminToken = adminLogin.token;
const adminId = (await (await me(adminToken)).json()).userId;

// ─── 1. Public self-registration stays closed ──────────────────────────
{
  const r = await postJson("/api/auth/register", { username: `pub-${Date.now()}`, password: "Passw0rd" });
  assert.equal(r.status, 403, "public register must be closed (M2)");
  const body = await r.json();
  assert.equal(body.code, "register_disabled");
  console.log("✓ 1. public registration closed");
}

// ─── 2. Admin creates a plain user in default-org; login → JWT works ──
const USER = `u2-${Date.now()}`;
const USER_PASS = "UserPassw0rd";
{
  const r = await postJson("/api/admin/users", { username: USER, password: USER_PASS, displayName: "U2" }, adminToken);
  await assertOk(r, "create user");
  const created = (await r.json()).user;
  assert.equal(created.status, "active", "new user is active");
  assert.equal(created.role, "user");
}
const userLogin = await loginAs(USER, USER_PASS);
const userToken = userLogin.token;
{
  // must_change=1 (admin-created) → /me is allowlisted, returns 200; a non-allowlisted
  // path (e.g. /api/chats) must 403 MUST_CHANGE_PASSWORD.
  const rMe = await me(userToken);
  assert.equal(rMe.status, 200, "user /me works (allowlisted even with must_change)");
  const rChats = await fetch(`${BASE}/api/chats`, { headers: { Authorization: `Bearer ${userToken}` } });
  assert.equal(rChats.status, 403, "must-change user blocked from non-allowlisted path");
  const body = await rChats.json();
  assert.equal(body.code, "MUST_CHANGE_PASSWORD");
  // Clear must_change so the rest of the flow exercises the token-version path cleanly.
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = ?`).run(USER);
  console.log("✓ 2. admin-created user + must_change gate");
}

// ─── 3. Disable → old JWT dies at REST + WS; restore → still dead; re-login ─
{
  // Pre: user JWT is valid.
  assert.equal((await me(userToken)).status, 200, "pre-disable /me ok");
  // Disable as admin.
  const userId = (await db.prepare("SELECT id FROM users WHERE username = ?").get(USER) as { id: string }).id;
  const r = await patchJson(`/api/admin/users/${userId}`, { status: "disabled" }, adminToken);
  await assertOk(r, "disable user");
  // REST: old JWT now rejected at authMiddleware.
  const rMe = await me(userToken);
  assert.equal(rMe.status, 401, "disabled user's old JWT rejected at REST");
  const body = await rMe.json();
  assert.ok(["token_user_disabled", "token_version_mismatch"].includes(body.code), `unexpected code ${body.code}`);
  // WS: old JWT rejected at connect (the warm/cold-resume gate).
  const ws = await wsConnect(userToken);
  assert.ok(!ws.connected, "disabled user's WS must not connect");
  assert.equal(ws.code, 4001, "WS closed with 4001 for disabled user");
  // Function-level cross-check: getUserAuthState sees disabled.
  const st = getUserAuthState(userId);
  assert.equal(st?.status, "disabled");
  assert.notEqual(st?.tokenVersion, 1, "disable bumped token_version");
  // Restore.
  const rRest = await patchJson(`/api/admin/users/${userId}`, { status: "active" }, adminToken);
  assert.equal(rRest.status, 200, "restore should succeed");
  // Old JWT is STILL dead — token_version was bumped on disable → re-login required.
  const rMe2 = await me(userToken);
  assert.equal(rMe2.status, 401, "restored user's OLD JWT still rejected (must re-login)");
  // Re-login → fresh JWT works.
  const fresh = await loginAs(USER, USER_PASS);
  assert.equal((await me(fresh.token)).status, 200, "re-login after restore works");
  console.log("✓ 3. disable → REST+WS reject; restore → old JWT still dead; re-login ok");
}

// ─── 4. Password reset → old JWT dies; new temp password + must_change ─
{
  const userId = (await db.prepare("SELECT id FROM users WHERE username = ?").get(USER) as { id: string }).id;
  const current = await loginAs(USER, USER_PASS);
  const r = await patchJson(`/api/admin/users/${userId}`, { password: "NewTempPass123" }, adminToken);
  await assertOk(r, "reset password");
  // Old JWT dies (token_version bumped).
  assert.equal((await me(current.token)).status, 401, "old JWT rejected after password reset");
  // New password logs in + must_change gate re-armed.
  const fresh = await loginAs(USER, "NewTempPass123");
  const rChats = await fetch(`${BASE}/api/chats`, { headers: { Authorization: `Bearer ${fresh.token}` } });
  assert.equal(rChats.status, 403, "reset re-arms must_change");
  assert.equal((await rChats.json()).code, "MUST_CHANGE_PASSWORD");
  // Clear for subsequent tests.
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = ?`).run(USER);
  console.log("✓ 4. password reset → old JWT dead; new temp password + must_change");
}

// ─── 5. Provision a 2nd org + org_admin B for the perm/migrate/active-org tests
const ORG_B = `m2-org-b-${Date.now()}`.slice(0, 30);
const OA_B = `oab-${Date.now()}`;
const OA_B_PASS = "OaBPassw0rd";
let oaBId: string;
{
  const r = await postJson("/api/admin/orgs", {
    id: ORG_B,
    name: "M2 Org B",
    adminUsername: OA_B,
    adminPassword: OA_B_PASS,
    adminDisplayName: "OA B",
  }, adminToken);
  await assertOk(r, "provision org B");
  oaBId = (await r.json()).adminUserId;
  // Clear must_change for OA_B so it can act as org_admin without the gate.
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = ?`).run(OA_B);
}
const oaBLogin = await loginAs(OA_B, OA_B_PASS);
const oaBToken = oaBLogin.token;

// ─── 6. org_admin perms: own-org create OK; can't touch admin; can't migrate ─
const PLAIN_B = `pb-${Date.now()}`;
const PLAIN_B_PASS = "PlainBPassw0rd";
{
  // org_admin B creates a plain user in own org (orgId is server-trusted from JWT,
  // not the body — pass none).
  const r = await postJson("/api/admin/users", { username: PLAIN_B, password: PLAIN_B_PASS }, oaBToken);
  await assertOk(r, "org_admin own-org create");
  const created = (await r.json()).user;
  assert.equal(created.orgId, ORG_B, "created in own org");
  assert.equal(created.role, "user");
  // org_admin cannot grant a privileged role.
  const rPriv = await postJson("/api/admin/users", { username: `x-${Date.now()}`, password: "Passw0rd1", role: "org_admin" }, oaBToken);
  assert.equal(rPriv.status, 403, "org_admin cannot grant privileged role");
  // org_admin cannot disable an admin (cross-org/privileged → 404 not-found, no existence leak).
  const rDisAdmin = await patchJson(`/api/admin/users/${adminId}`, { status: "disabled" }, oaBToken);
  assert.equal(rDisAdmin.status, 404, "org_admin touching admin → 404 (no existence leak)");
  // org_admin cannot migrate (admin-only action) — even own-org user.
  const plainBId = (await db.prepare("SELECT id FROM users WHERE username = ?").get(PLAIN_B) as { id: string }).id;
  const rMig = await patchJson(`/api/admin/users/${plainBId}`, { orgId: "default-org" }, oaBToken);
  assert.equal(rMig.status, 403, "org_admin cannot migrate (admin-only)");
  console.log("✓ 6. org_admin own-org create; no privileged grant; admin→404; no migrate");
}

// ─── 7. Migrate (admin) → old JWT dies; new login carries new org ─────
{
  const plainBId = (await db.prepare("SELECT id FROM users WHERE username = ?").get(PLAIN_B) as { id: string }).id;
  // Clear must_change on PLAIN_B so it can log in cleanly first.
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = ?`).run(PLAIN_B);
  const before = await loginAs(PLAIN_B, PLAIN_B_PASS);
  // Admin migrates PLAIN_B from ORG_B → default-org.
  const r = await patchJson(`/api/admin/users/${plainBId}`, { orgId: "default-org" }, adminToken);
  await assertOk(r, "migrate user");
  // Old JWT (org=ORG_B) is rejected — version bump + stale org claim.
  const rMe = await me(before.token);
  assert.equal(rMe.status, 401, "migrated user's OLD JWT rejected");
  // New login → JWT carries the NEW org.
  const fresh = await loginAs(PLAIN_B, PLAIN_B_PASS);
  const payload = JSON.parse(Buffer.from(fresh.token.split(".")[1], "base64").toString());
  assert.equal(payload.orgId, "default-org", "new JWT carries migrated org");
  assert.equal((await me(fresh.token)).status, 200, "migrated user re-login works");
  console.log("✓ 7. migrate → old JWT dead; new login carries new org");
}

// ─── 8. active-org bind on create: suspend ORG_B → create in it → 403 ─
{
  await transitionOrgStatus({ orgId: ORG_B, action: "suspend", actorUserId: adminId, actorRole: "admin" });
  const r = await postJson("/api/admin/users", { username: `sb-${Date.now()}`, password: "Passw0rd1", orgId: ORG_B }, adminToken);
  assert.equal(r.status, 403, "create in suspended org → 403");
  const body = await r.json();
  assert.equal(body.code, "org_not_active", "create in suspended org → org_not_active");
  // Reactivate for the next test.
  await transitionOrgStatus({ orgId: ORG_B, action: "activate", actorUserId: adminId, actorRole: "admin" });
  console.log("✓ 8. create binds to active org (suspended → 403)");
}

// ─── 9. Last active org_admin cannot be disabled ──────────────────────
{
  // OA_B is the only org_admin of ORG_B → disabling must be refused.
  const r = await patchJson(`/api/admin/users/${oaBId}`, { status: "disabled" }, adminToken);
  assert.equal(r.status, 400, "cannot disable the last active org_admin");
  // Verify OA_B is still active.
  assert.equal(getUserAuthState(oaBId)?.status, "active", "last org_admin was NOT disabled");
  console.log("✓ 9. last active org_admin cannot be disabled");
}

// ─── 10. Self-disable refused ─────────────────────────────────────────
{
  const r = await patchJson(`/api/admin/users/${adminId}`, { status: "disabled" }, adminToken);
  assert.equal(r.status, 400, "cannot change your own status");
  console.log("✓ 10. self-disable refused");
}

// ─── 11. Function-level: verifyUserTokenCurrent invariant summary ─────
{
  // A migrated user's old payload (old org) is rejected by the pure check too.
  const plainBId = (await db.prepare("SELECT id FROM users WHERE username = ?").get(PLAIN_B) as { id: string }).id;
  const st = getUserAuthState(plainBId)!;
  const check = verifyUserTokenCurrent({ userId: plainBId, tokenVersion: 1, orgId: ORG_B });
  assert.equal(check.ok, false, "stale token (old version + old org) rejected by verifyUserTokenCurrent");
  const fresh = await loginAs(PLAIN_B, PLAIN_B_PASS);
  const freshPayload = JSON.parse(Buffer.from(fresh.token.split(".")[1], "base64").toString());
  const checkOk = verifyUserTokenCurrent({ userId: plainBId, tokenVersion: freshPayload.tokenVersion, orgId: freshPayload.orgId });
  assert.equal(checkOk.ok, true, "fresh token passes verifyUserTokenCurrent");
  console.log("✓ 11. verifyUserTokenCurrent invariant (stale reject / fresh ok)");
}

console.log("\nM2 user-lifecycle: all focused tests passed.");
process.exit(0);
