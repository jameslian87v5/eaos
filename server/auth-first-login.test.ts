// P0-1 Node A test (brand-launch): users.must_change_password migration +
// login surfaces mustChangePassword + assertJwtSecret fails fast on weak default.
// Run: tsx server/auth-first-login.test.ts
//
// Isolates a temp DB and leaves JWT_SECRET unset so assertJwtSecret's weak-default
// path is exercised. Env is set BEFORE importing auth — the module captures it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import bcrypt from "bcrypt";

const tmpDb = path.join(os.tmpdir(), `p0-1-node-a-${process.pid}.db`);
fs.rmSync(tmpDb, { force: true });
process.env.DB_PATH = tmpDb;
delete process.env.JWT_SECRET;
delete process.env.ALLOW_DEV_JWT_SECRET;

const { assertJwtSecret, ensureAdminExists, markLegacyDefaultAdminForChange, changePassword, getMustChangePassword, isMustChangeAllowed, login, register } = await import("./auth.js");
// Same DB singleton auth uses — imported dynamically so DB_PATH is already set.
const db = (await import("./database.js")).default;

const failures: string[] = [];
async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.log(`  ✗ ${name}: ${e?.message ?? e}`);
    failures.push(name);
  }
}

// 1) assertJwtSecret throws when JWT_SECRET is the weak default and not allowed.
await run("assertJwtSecret throws on weak default secret", () => {
  assert.throws(() => assertJwtSecret(), /FATAL.*JWT_SECRET/);
});

// 2) Seeded admin must change password on first login.
await run("seeded admin login has mustChangePassword=true", async () => {
  ensureAdminExists();
  const res = await login("admin", "admin123");
  assert.equal(res.mustChangePassword, true);
});

// 3) A self-registered user (chose their own password) is NOT forced to change.
await run("registered user login has mustChangePassword=false", async () => {
  await register("alice", "alice-pw-123", "Alice");
  const res = await login("alice", "alice-pw-123");
  assert.equal(res.mustChangePassword, false);
});

// 4) Legacy DB: an admin that existed BEFORE the migration got must_change_password=0
//    from the ALTER default while still using admin123. markLegacyDefaultAdminForChange
//    must flip it back to 1 so it is forced to change on first login.
await run("legacy default admin (default pw, flag=0) gets flagged for change", async () => {
  // reset the seeded admin to the pre-migration state: default password, flag=0
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
  // sanity: before the fix it is NOT forced
  let res = await login("admin", "admin123");
  assert.equal(res.mustChangePassword, false);
  markLegacyDefaultAdminForChange();
  res = await login("admin", "admin123");
  assert.equal(res.mustChangePassword, true);
});

// 5) Legacy DB: an admin that already CHANGED its password must NOT be re-flagged.
await run("admin with changed password is not re-flagged", async () => {
  const changedHash = bcrypt.hashSync("a-strong-rotated-pw", 10);
  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'`
  ).run(changedHash);
  markLegacyDefaultAdminForChange(); // password no longer matches default → no-op
  const res = await login("admin", "a-strong-rotated-pw");
  assert.equal(res.mustChangePassword, false);
});

// ─── P0-1 backend closure: change-password + must-change gate ─────────────
const adminId = (db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: string }).id;

// 6) changePassword: valid old + strong new → clears must_change_password.
await run("changePassword succeeds and clears must-change flag", async () => {
  db.prepare(`UPDATE users SET must_change_password = 1 WHERE id = ?`).run(adminId);
  assert.equal(getMustChangePassword(adminId), true);
  await changePassword(adminId, "a-strong-rotated-pw", "NewPw2026!");
  assert.equal(getMustChangePassword(adminId), false);
  const res = await login("admin", "NewPw2026!");
  assert.equal(res.mustChangePassword, false);
});

// 7) wrong old password rejected.
await run("changePassword rejects wrong old password", async () => {
  await assert.rejects(() => changePassword(adminId, "wrong-old", "Another99!"), /Invalid credentials/);
});

// 8) weak (short) new password rejected.
await run("changePassword rejects short new password", async () => {
  await assert.rejects(() => changePassword(adminId, "NewPw2026!", "Ab1"), /at least 8/);
});

// 9) new == old rejected.
await run("changePassword rejects new == old", async () => {
  await assert.rejects(() => changePassword(adminId, "NewPw2026!", "NewPw2026!"), /differ/);
});

// 10) new == default admin123 rejected.
await run("changePassword rejects new == default password", async () => {
  await assert.rejects(() => changePassword(adminId, "NewPw2026!", "admin123"), /default password/);
});

// 11) must-change allowlist: only me + change-password pass; everything else gated.
await run("must-change allowlist only allows me + change-password", () => {
  assert.equal(isMustChangeAllowed("/api/auth/me"), true);
  assert.equal(isMustChangeAllowed("/api/auth/change-password"), true);
  assert.equal(isMustChangeAllowed("/api/chats"), false);
  assert.equal(isMustChangeAllowed("/ws"), false);
  assert.equal(isMustChangeAllowed("/api/admin/containers"), false);
});

fs.rmSync(tmpDb, { force: true });

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nOK: all P0-1 Node A checks passed");
