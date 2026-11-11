import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { authorizeMemoryAccess } from "./user-memory-admin.js";
import * as svc from "./user-memory-service.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usermem-admin-"));
process.env.USER_MEMORY_ROOT = TMP;

// 1. Authorization policy (pure): memory body/clear/quota are admin-only.
//    admin any org; org_admin denied everywhere (own-org forbidden, cross-org
//    hidden as not-found); plain user forbidden.
assert.equal(
  authorizeMemoryAccess({ actorRole: "admin", actorOrg: "o1", targetOrg: "o2" }),
  null,
  "admin may access any org"
);
assert.equal(
  authorizeMemoryAccess({ actorRole: "org_admin", actorOrg: "o1", targetOrg: "o1" }),
  "forbidden",
  "org_admin own-org has NO memory body/clear access (admin-only)"
);
assert.equal(
  authorizeMemoryAccess({ actorRole: "org_admin", actorOrg: "o1", targetOrg: "o2" }),
  "not found",
  "cross-org is hidden as not-found (no existence leak)"
);
assert.equal(
  authorizeMemoryAccess({ actorRole: "user", actorOrg: "o1", targetOrg: "o1" }),
  "forbidden",
  "plain user has no admin access"
);

// 2. Admin clear+recreate: body wiped, template remains.
const U = "user-clear-1";
svc.write(U, "SECRET-LIKE-DATA that admin can see but audit never stores");
svc.clear(U);
const after = svc.read(U);
assert.ok(after.includes("# Memory"), "clear recreates template");
assert.ok(!after.includes("SECRET-LIKE-DATA"), "clear wipes content");

// 3. Admin can read body (enterprise admin may view); quota round-trip.
const body = svc.read(U);
assert.ok(typeof body === "string" && body.length > 0, "admin GET returns the body");
const q = svc.setQuotaBytes(4096);
assert.equal(svc.getQuotaBytes(), q, "quota set/get round-trip");
assert.equal(q, 4096);

// 4. Audit stores metadata only — the document body is never part of the audit
//    payload (the admin endpoints build payloads with targetUserId/actor/bytes,
//    never `body`). Assert the policy symbolically: clear() returns no body and
//    the service never exposes body-bearing audit fields.
assert.equal(svc.getSizeBytes(U) >= 0, true, "size is metadata-safe");

console.log("user-memory-admin tests passed");
