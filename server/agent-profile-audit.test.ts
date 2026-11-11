// Run: npm run test:agent-profile-audit
// Pure (no DB): verifies the agent_profile_updated audit payload is REDACTED —
// no prompt/profile plaintext — and records actor / owner / changedFields /
// configVersion before-after. Mirrors what the server.ts PATCH handler emits.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildProfileUpdateAudit } from "./agent-profile-audit.js";
import type { RequestContext } from "./request-context.js";

const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: "default-org" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// 1. set systemPrompt → action=set, length, sha256 identity; NO plaintext leak.
const p1 = buildProfileUpdateAudit({
  actor: admin,
  ownerUserId: "u-owner",
  fields: { systemPrompt: "You are the code reviewer." },
  after: { description: null, systemPrompt: "You are the code reviewer.", appendSystemPrompt: null },
  configVersion: { before: "cv-before-0", after: "cv-after-1" },
});
assert.equal(p1.actor.userId, "admin-1", "actor recorded");
assert.equal(p1.actor.role, "admin", "actor role recorded");
assert.equal(p1.ownerUserId, "u-owner", "owner recorded (admin acted on another user's agent)");
assert.deepEqual(p1.changedFields, ["systemPrompt"], "only provided field listed");
assert.equal(p1.changes.systemPrompt.action, "set", "set action");
assert.equal(p1.changes.systemPrompt.length, "You are the code reviewer.".length, "length of stored value");
assert.equal(p1.changes.systemPrompt.sha256, sha("You are the code reviewer."), "sha256 identity");
// CRITICAL: plaintext must not appear anywhere in the serialized payload.
assert.ok(
  !JSON.stringify(p1).includes("You are the code reviewer."),
  "NO prompt plaintext in audit payload"
);
assert.equal(p1.configVersion.before, "cv-before-0");
assert.equal(p1.configVersion.after, "cv-after-1");

// 2. cleared appendSystemPrompt → action=cleared, length 0, sha256 of "".
const p2 = buildProfileUpdateAudit({
  actor: admin,
  ownerUserId: "u-owner",
  fields: { appendSystemPrompt: null },
  after: { description: null, systemPrompt: null, appendSystemPrompt: null },
  configVersion: { before: "a", after: "b" },
});
assert.equal(p2.changes.appendSystemPrompt.action, "cleared", "cleared action");
assert.equal(p2.changes.appendSystemPrompt.length, 0, "cleared → length 0");
assert.equal(p2.changes.appendSystemPrompt.sha256, sha(""), "cleared → sha256 of empty");
assert.deepEqual(p2.changedFields, ["appendSystemPrompt"]);

// 3. multiple fields → each listed, no plaintext for any.
const p3 = buildProfileUpdateAudit({
  actor: { userId: "u1", role: "user", orgId: "default-org" },
  ownerUserId: "u1",
  fields: {
    description: "desc-secret-123",
    systemPrompt: "sys-secret-456",
    appendSystemPrompt: "app-secret-789",
  },
  after: {
    description: "desc-secret-123",
    systemPrompt: "sys-secret-456",
    appendSystemPrompt: "app-secret-789",
  },
  configVersion: { before: "x", after: "y" },
});
assert.deepEqual(
  p3.changedFields.sort(),
  ["appendSystemPrompt", "description", "systemPrompt"],
  "all provided fields listed"
);
assert.equal(p3.actor.role, "user", "user actor recorded");
const dump3 = JSON.stringify(p3);
assert.ok(
  !dump3.includes("desc-secret-123") &&
    !dump3.includes("sys-secret-456") &&
    !dump3.includes("app-secret-789"),
  "no plaintext leaked for any field"
);

// 4. Empty fields → changedFields empty (handler rejects empty before calling,
//    but the builder is defensive).
const p4 = buildProfileUpdateAudit({
  actor: admin,
  ownerUserId: "u",
  fields: {},
  after: { description: null, systemPrompt: null, appendSystemPrompt: null },
  configVersion: { before: "p", after: "p" },
});
assert.deepEqual(p4.changedFields, [], "no fields → empty changedFields");
assert.deepEqual(p4.changes, {}, "no fields → empty changes");

console.log("agent-profile-audit (MP5c redaction) tests passed");
