// M2 review fixes (evt_20260811084601) — focused proof for the two blockers
// codex-1 raised on the M2 review:
//
//   Fix 1: a role change must invalidate the user's outstanding JWTs. A demoted
//          admin's old (admin-role) JWT must be rejected at REST (authMiddleware)
//          AND at the legacy WS connect path.
//   Fix 2: last-admin protection counts ACTIVE admins only, so the lockout
//          sequence "A disables B, then A self-demotes → 0 active admins" is
//          refused at step 2 (countAdmins() == 1 after B is disabled).
//
// Run: npx tsx server/m2-review-fixes.test.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { WebSocket } from "ws";

const PORT = "3992";
const DB_PATH = "/tmp/m2-review-fixes-test.db";
process.env.DB_PATH = DB_PATH;
process.env.PORT = PORT;
process.env.JWT_SECRET = "m2-review-fixes-secret-strong-7c2e";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });

const db = (await import("./database.js")).default;
await import("./server.js");
const { getUserAuthState } = await import("./auth.js");

const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/ws`;

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
async function assertOk(r: Response, what: string): Promise<void> {
  if (!r.ok) throw new Error(`${what} failed: HTTP ${r.status} ${await r.text()}`);
}
async function loginAs(username: string, password: string) {
  const r = await postJson("/api/auth/login", { username, password });
  if (!r.ok) throw new Error(`login ${username} failed: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ token: string; user: any }>;
}
function me(token: string) {
  return fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
}
function wsConnect(token: string): Promise<{ code: number | null; connected: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(token)}`);
    const done = (code: number | null, connected: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({ code, connected });
    };
    ws.on("message", (d) => {
      try { if (JSON.parse(d.toString()).type === "connected") done(null, true); } catch {}
    });
    ws.on("close", (c) => done(c, false));
    ws.on("error", () => done(null, false));
    setTimeout(() => done(null, false), 3000);
  });
}

await pollReady();
// Seeded admin (admin/admin123) has must_change=1; clear it so it can act.
db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
const admin = await loginAs("admin", "admin123");
const adminToken = admin.token;
const adminId = (await (await me(adminToken)).json()).userId;

// Create a SECOND admin in default-org so the seeded admin isn't the only one.
const ADMIN2 = `a2-${Date.now()}`;
const ADMIN2_PASS = "Admin2Passw0rd";
{
  const r = await postJson("/api/admin/users", { username: ADMIN2, password: ADMIN2_PASS, role: "admin" }, adminToken);
  await assertOk(r, "create 2nd admin");
  // 2nd admin was admin-created with must_change=1; clear so it can log in cleanly.
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = ?`).run(ADMIN2);
}

// ─── Fix 1: role change invalidates old JWT (REST + WS) ─────────────
{
  const a2Login = await loginAs(ADMIN2, ADMIN2_PASS);
  const oldToken = a2Login.token;
  // sanity: old admin token works pre-demotion.
  assert.equal((await me(oldToken)).status, 200, "pre-demotion admin token works");
  // admin demotes ADMIN2 → user. Atomic update sets role + increments
  // token_version EXACTLY once (the prior two-step path could not guarantee
  // that; the atomic UPDATE is one statement).
  const a2Id = (await db.prepare("SELECT id FROM users WHERE username = ?").get(ADMIN2) as { id: string }).id;
  const tvBefore = getUserAuthState(a2Id)!.tokenVersion;
  const r = await patchJson(`/api/admin/users/${a2Id}`, { role: "user" }, adminToken);
  await assertOk(r, "demote admin2");
  // REST: old admin JWT now rejected.
  const rMe = await me(oldToken);
  assert.equal(rMe.status, 401, "demoted admin's old JWT rejected at REST");
  const body = await rMe.json();
  assert.equal(body.code, "token_version_mismatch", "rejection reason is version mismatch");
  // WS: old admin JWT rejected at connect.
  const ws = await wsConnect(oldToken);
  assert.ok(!ws.connected, "demoted admin's old WS must not connect");
  assert.equal(ws.code, 4001, "WS closed 4001 for stale-role token");
  // tv incremented EXACTLY once (atomic single UPDATE, not two steps).
  const tvAfter = getUserAuthState(a2Id)!.tokenVersion;
  assert.equal(tvAfter, tvBefore + 1, "role change bumped token_version exactly once");
  // re-login → fresh JWT works, role is now user.
  const fresh = await loginAs(ADMIN2, ADMIN2_PASS);
  assert.equal((await me(fresh.token)).status, 200, "re-login after demotion works");
  const payload = JSON.parse(Buffer.from(fresh.token.split(".")[1], "base64").toString());
  assert.equal(payload.role, "user", "new JWT carries demoted role");
  console.log("✓ Fix 1: role change bumps token_version; demoted admin old REST+WS token rejected");
}

// ─── Fix 2: lockout sequence prevented (countAdmins counts active) ───
// Sequence: A (seeded admin) disables ADMIN2, then A self-demotes.
// Before the fix countAdmins() counted the disabled ADMIN2 → A could demote
// itself → 0 active admins → lockout. Now countAdmins() filters status=active
// → after disabling ADMIN2, count==1 → A self-demote is refused.
{
  // Re-promote ADMIN2 to admin so we have 2 active admins again.
  const a2Id = (await db.prepare("SELECT id FROM users WHERE username = ?").get(ADMIN2) as { id: string }).id;
  await patchJson(`/api/admin/users/${a2Id}`, { role: "admin" }, adminToken);
  // A disables ADMIN2.
  const rDis = await patchJson(`/api/admin/users/${a2Id}`, { status: "disabled" }, adminToken);
  await assertOk(rDis, "disable admin2");
  // Now active admins = {A} only. A tries to self-demote → must be refused.
  const rSelfDemote = await patchJson(`/api/admin/users/${adminId}`, { role: "user" }, adminToken);
  assert.equal(rSelfDemote.status, 400, "self-demote after disabling the only other admin must be refused");
  const body = await rSelfDemote.json();
  assert.equal(body.error, "Cannot demote the last admin", "refusal reason is last-admin protection");
  // A is still an active admin (lockout did NOT happen).
  assert.equal(getUserAuthState(adminId)?.status, "active", "A still active");
  assert.equal(getUserAuthState(adminId)?.role, "admin", "A still admin");
  // A's token still works.
  assert.equal((await me(adminToken)).status, 200, "A's token still valid (lockout prevented)");
  console.log("✓ Fix 2: disable-other-admin → self-demote lockout sequence prevented (countAdmins counts active)");
}

console.log("\nM2 review fixes: both blockers proved. ✓");
process.exit(0);
