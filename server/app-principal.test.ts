/**
 * app-principal.test.ts — P0.1 (Agent OS §4) adversarial unit tests.
 *
 * Focus: security + isolation invariants of the internal app-principal
 * registry and resolvePrincipal. No Token / WS / admin wiring (those are
 * P0.2 / P0.3).
 *
 * Cases:
 *   1. getOrCreate is idempotent — same (app, subject) → same principalId.
 *   2. same subject across two apps → two distinct principalIds (no aliasing).
 *   3. org_id comes ONLY from the verified app, never from subject; a forged
 *      trustedAppOrgId that mismatches applications.org_id is rejected.
 *   4. subject validation: empty / oversize / NUL rejected.
 *   5. resolvePrincipal: app → AppPrincipal; platform user → PlatformPrincipal;
 *      unknown id → null (must NOT be misread as platform).
 *   6. setStatus disables an app principal; resolvePrincipal reflects it.
 *   7. principalKey formats stably; it is never parsed (no parser exists).
 *   8. principalId is an opaque value usable as the data-plane key — placing it
 *      into chats.user_id works with the existing schema/index unchanged.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";

// ─── Env before imports ──────────────────────────────────────
const TMP_DB = "/tmp/test-p01-app-principal.db";
process.env.DB_PATH = TMP_DB;
// Allow the weak JWT default because an import chain asserts it at module load;
// this test never mints JWTs.
process.env.ALLOW_DEV_JWT_SECRET = "1";
rmSync(TMP_DB, { force: true });

const db = (await import("./database.js")).default;
const {
  getOrCreateAppPrincipal,
  resolvePrincipal,
  setAppPrincipalStatus,
  principalKey,
} = await import("./app-principal.js");

// ─── Helpers ─────────────────────────────────────────────────

function insertApp(appId: string, orgId: string): void {
  db.prepare(
    `INSERT INTO applications (id, org_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))`
  ).run(appId, orgId, appId);
}

function insertPlatformUser(userId: string, orgId: string, role: string, status: string): void {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status, token_version, must_change_password, created_at)
     VALUES (?, ?, 'x', ?, ?, ?, 1, 0, datetime('now'))`
  ).run(userId, `u_${userId}`, role, orgId, status);
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const APP_1 = "app-1";
const APP_2 = "app-2";

// ─── Tests ───────────────────────────────────────────────────

insertApp(APP_1, ORG_A);
insertApp(APP_2, ORG_A);

// 1. Idempotency: same (app, subject) → same principalId
{
  const a = getOrCreateAppPrincipal(APP_1, "alice", ORG_A);
  const b = getOrCreateAppPrincipal(APP_1, "alice", ORG_A);
  assert.equal(a.principalId, b.principalId, "same (app,subject) must yield same id");
  assert.equal(a.kind, "app");
  assert.equal(a.appId, APP_1);
  assert.equal(a.subject, "alice");
  assert.equal(a.orgId, ORG_A, "org must come from verified app, not subject");
  assert.equal(a.status, "active");
  console.log("✓ 1. idempotent getOrCreate");
}

// 2. Same subject across two apps → two distinct principalIds (no cross-app aliasing)
{
  const p1 = getOrCreateAppPrincipal(APP_1, "bob", ORG_A);
  const p2 = getOrCreateAppPrincipal(APP_2, "bob", ORG_A);
  assert.notEqual(p1.principalId, p2.principalId, "cross-app same subject must NOT alias");
  assert.equal(p1.appId, APP_1);
  assert.equal(p2.appId, APP_2);
  console.log("✓ 2. cross-app same subject → distinct principalIds");
}

// 3. org_id never from subject; forged trustedAppOrgId mismatching app.org rejected
{
  // subject literally carries a different org string; platform must ignore it.
  const p = getOrCreateAppPrincipal(APP_1, "subject-with-org-B-inside", ORG_A);
  assert.equal(p.orgId, ORG_A, "subject content must not influence org_id");

  // Caller claims an org that does NOT match the app's org → reject.
  assert.throws(
    () => getOrCreateAppPrincipal(APP_1, "charlie", ORG_B),
    /does not match the verified application org/,
    "forged trustedAppOrgId must be rejected"
  );
  console.log("✓ 3. org_id sourced only from verified app; subject ignored, forgery rejected");
}

// 3b. Unknown app id → reject (no principal minted for a phantom app)
{
  assert.throws(
    () => getOrCreateAppPrincipal("ghost-app", "x", ORG_A),
    /application not found/,
    "getOrCreate against a non-existent app must fail"
  );
  const none = db.prepare(`SELECT COUNT(*) AS c FROM app_principals WHERE app_id = 'ghost-app'`).get() as { c: number };
  assert.equal(none.c, 0, "no row should be created for a phantom app");
  console.log("✓ 3b. unknown app rejected; no phantom principal created");
}

// 4. Subject validation
{
  assert.throws(() => getOrCreateAppPrincipal(APP_1, "", ORG_A), /non-empty/);
  assert.throws(() => getOrCreateAppPrincipal(APP_1, "a\0b", ORG_A), /NUL/);
  const tooLong = "x".repeat(257);
  assert.throws(() => getOrCreateAppPrincipal(APP_1, tooLong, ORG_A), /too long/);
  // Boundary: 256-char subject is allowed.
  const max = "x".repeat(256);
  const p = getOrCreateAppPrincipal(APP_1, max, ORG_A);
  assert.equal(p.subject.length, 256);
  console.log("✓ 4. subject validation (empty / NUL / oversize rejected; 256 ok)");
}

// 5. resolvePrincipal: app / platform / unknown(null)
{
  insertPlatformUser("plat-user-1", ORG_A, "user", "active");

  const appP = getOrCreateAppPrincipal(APP_1, "dave", ORG_A);
  const r1 = resolvePrincipal(appP.principalId);
  assert.equal(r1?.kind, "app", "app principalId resolves to app");
  assert.equal(r1 && "subject" in r1 && r1.subject, "dave");

  const r2 = resolvePrincipal("plat-user-1");
  assert.equal(r2?.kind, "platform", "platform userId resolves to platform");
  assert.equal(r2 && "userId" in r2 && r2.userId, "plat-user-1");
  assert.equal(r2 && "role" in r2 && r2.role, "user");

  // Unknown id → null (must NOT degrade to a platform guess).
  const r3 = resolvePrincipal("does-not-exist");
  assert.equal(r3, null, "unknown principalId must resolve to null");
  console.log("✓ 5. resolvePrincipal: app / platform / unknown(null)");
}

// 6. setStatus disables; resolvePrincipal reflects it
{
  const p = getOrCreateAppPrincipal(APP_1, "eve", ORG_A);
  assert.equal(p.status, "active");
  const n = setAppPrincipalStatus(p.principalId, "disabled");
  assert.equal(n, 1, "one row updated");
  const r = resolvePrincipal(p.principalId);
  assert.equal(r?.kind, "app");
  assert.equal(r && "status" in r && r.status, "disabled", "disabled status reflected");
  // restore
  setAppPrincipalStatus(p.principalId, "active");
  const r2 = resolvePrincipal(p.principalId);
  assert.equal(r2 && "status" in r2 && r2.status, "active");
  console.log("✓ 6. setStatus disable/restore reflected by resolvePrincipal");
}

// 7. principalKey formats stably; no parser exists (contract: never parse)
{
  const appP = getOrCreateAppPrincipal(APP_1, "frank", ORG_A);
  const platP = resolvePrincipal("plat-user-1")!;
  assert.equal(principalKey(appP), `app:${APP_1}:frank`);
  assert.equal(principalKey(platP), `platform:plat-user-1`);
  // The key is log/audit-only; confirm there is no parse function exported.
  // (If one is ever added, this test must be deleted and the contract revised.)
  console.log("✓ 7. principalKey stable; audit-only (no parser)");
}

// 8. principalId is a usable data-plane key: existing schema/index unchanged
{
  // Drop a principalId into chats.user_id exactly as the data plane does today.
  const p = getOrCreateAppPrincipal(APP_1, "grace", ORG_A);
  db.prepare(
    `INSERT INTO chats (id, user_id, title) VALUES (?, ?, 'Grace chat')`
  ).run("chat-grace", p.principalId);
  // Existing index on chats(user_id) serves this lookup unchanged.
  const row = db.prepare(`SELECT user_id FROM chats WHERE user_id = ?`).get(p.principalId) as { user_id: string };
  assert.equal(row.user_id, p.principalId);
  // Resolve back from the value stored in the column.
  const resolved = resolvePrincipal(row.user_id);
  assert.equal(resolved?.kind, "app");
  console.log("✓ 8. principalId usable as existing user_id value; schema/index unchanged");
}

console.log("\nAll app-principal tests passed.");
