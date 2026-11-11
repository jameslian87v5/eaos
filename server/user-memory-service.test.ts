import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import * as svc from "./user-memory-service.js";

// Isolate on a temp dir + temp settings so quota edits don't leak.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usermem-svc-"));
process.env.USER_MEMORY_ROOT = TMP;
process.env.RUNTIME_SETTINGS_PATH = path.join(TMP, "runtime-settings.json");

const USER_A = "user-abc-123";
const USER_B = "user-xyz-789";

// 1. Provisioning: creates exactly one MEMORY.md, idempotent, preserves edits.
svc.ensureMemory(USER_A);
const fileA = svc.getHostFile(USER_A);
assert.ok(fs.existsSync(fileA), "ensureMemory creates MEMORY.md");
svc.ensureMemory(USER_A); // idempotent
assert.equal(fs.existsSync(fileA), true);

svc.write(USER_A, "MY DURABLE NOTE");
svc.ensureMemory(USER_A); // must NOT overwrite user edits
assert.equal(svc.read(USER_A), "MY DURABLE NOTE", "ensureMemory must not overwrite edits");

// 2. Per-user isolation: different dirs, never collide.
const dirA = svc.getHostDir(USER_A);
const dirB = svc.getHostDir(USER_B);
assert.notEqual(dirA, dirB, "two users → different host dirs");
svc.ensureMemory(USER_B);
assert.notEqual(svc.read(USER_A), svc.read(USER_B), "users have independent memory");

// 3. userId sanitization REJECTS unsafe IDs (no stripping → no aliasing).
//    Safe format = ASCII [A-Za-z0-9_-], non-empty; everything else throws.
assert.equal(svc.sanitizeUserId("user-abc_123"), "user-abc_123", "valid id passes through unchanged");
assert.throws(() => svc.sanitizeUserId("u/../evil"), /invalid userId/, "traversal rejected");
assert.throws(() => svc.sanitizeUserId("a/b"), /invalid userId/, "slash rejected");
assert.throws(() => svc.sanitizeUserId("a b"), /invalid userId/, "space rejected");
assert.throws(() => svc.sanitizeUserId("///"), /invalid userId/, "all-slash rejected");
assert.throws(() => svc.sanitizeUserId(""), /invalid userId/, "empty rejected");
//    Because `a/b` is rejected (not stripped to `ab`), it can never alias `ab`.
assert.throws(() => svc.getHostDir("a/b"), /invalid userId/);
const abDir = svc.getHostDir("ab");
assert.doesNotThrow(() => svc.getHostDir("ab"));
assert.equal(svc.getHostDir("ab"), abDir, "ab resolves stably");

// 4. Quota: oversized API write rejected; valid write is atomic replace.
svc.setQuotaBytes(2000);
assert.throws(() => svc.write(USER_A, "x".repeat(3000)), /quota exceeded/);
svc.write(USER_A, "replaced-atomically");
assert.equal(svc.read(USER_A), "replaced-atomically", "write replaces atomically");
// no leftover .tmp files
assert.equal(
  fs.readdirSync(dirA).some((f) => f.startsWith("MEMORY.md.tmp")),
  false,
  "no temp files left behind"
);

// 5. clear() recreates the empty template.
svc.write(USER_A, "to be cleared");
svc.clear(USER_A);
const after = svc.read(USER_A);
assert.ok(after.includes("# Memory"), "clear recreates template");
assert.ok(!after.includes("to be cleared"), "clear wipes content");

console.log("user-memory-service tests passed");
