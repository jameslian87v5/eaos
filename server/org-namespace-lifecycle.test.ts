// R5c lifecycle hooks (org create/freeze + user create/role/move/suspend).
// Run: npx tsx server/org-namespace-lifecycle.test.ts
// Fails until server/org-namespace-lifecycle.ts is implemented.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r5c-lc-"));
process.env.DB_PATH = path.join(TMP, "lc.db");
process.env.ENTITLEMENTS_FILE = path.join(TMP, "ent.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(TMP, "ac.json");
fs.writeFileSync(process.env.ENTITLEMENTS_FILE, JSON.stringify({ entries: [] }));
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE, JSON.stringify({ agents: {} }));

const db = (await import("./database.js")).default;
const { orgService } = await import("./org-service.js");
const { orgNamespaceMappingService } = await import("./org-namespace-mapping.js");
const { memberSyncService } = await import("./skillhub-member-sync.js");
const { onOrgCreated, onOrgFrozen, onOrgActivated, onUserCreate, onUserRoleChange, onUserOrgMove, onUserSuspend } = await import("./org-namespace-lifecycle.js");

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`${name}: ${(e as Error).message}`); }
}

orgService.create("org-a", "Org A");
orgService.create("org-b", "Org B");
// both orgs get a persistent mapping via the lifecycle hook (so org-move to
// org-b has a destination namespace).
onOrgCreated("org-a");
onOrgCreated("org-b");

// ─── 1. onOrgCreated: derives namespace + upserts mapping (persistent) ──
ok("1. onOrgCreated upserts mapping", () => {
  onOrgCreated("org-a");
  const m = orgNamespaceMappingService.getForOrg("org-a");
  assert.ok(m, "org create must persist a TEAM namespace mapping");
  assert.equal(m!.status, "active");
});

// ─── 2. onOrgFrozen / onOrgActivated toggle mapping status ──────────────
ok("2. onOrgFrozen/onOrgActivated toggle", () => {
  onOrgFrozen("org-a");
  assert.equal(orgNamespaceMappingService.getForOrg("org-a")!.status, "frozen");
  onOrgActivated("org-a");
  assert.equal(orgNamespaceMappingService.getForOrg("org-a")!.status, "active");
});

// ─── 3. onUserCreate enqueues a member-sync task with target_version ────
ok("3. onUserCreate enqueues task", () => {
  onUserCreate({ orgId: "org-a", userId: "u1", tokenVersion: 1 });
  const tasks = memberSyncService.listPending({ orgId: "org-a" });
  const t = tasks.find((x) => x.userId === "u1" && x.event === "user_create");
  assert.ok(t, "user_create enqueued a member-sync task");
  assert.equal(t!.targetVersion, 1);
});

// ─── 4. exact-duplicate hook fire dedupes (same generation) ─────────────
ok("4. exact-duplicate hook fire dedupes", () => {
  onUserCreate({ orgId: "org-a", userId: "u1", tokenVersion: 1 }); // same gen
  const tasks = memberSyncService.listPending({ orgId: "org-a" }).filter((x) => x.userId === "u1");
  assert.equal(tasks.length, 1, "duplicate hook fire (same token_version) dedupes");
});

// ─── 5. later role change (new generation) enqueues a NEW task ──────────
ok("5. later role change enqueues new desired state", () => {
  onUserRoleChange({ orgId: "org-a", userId: "u2", tokenVersion: 5 });
  onUserRoleChange({ orgId: "org-a", userId: "u2", tokenVersion: 6 });
  const tasks = memberSyncService.listPending({ orgId: "org-a" }).filter((x) => x.userId === "u2");
  assert.equal(tasks.length, 2, "later role change (new generation) = new task");
});

// ─── 6. org move: enqueues task scoped to the NEW org's namespace ────────
ok("6. org move enqueues under new org namespace", () => {
  // onUserOrgMove reads the user's CURRENT (post-migration) token_version +
  // role from the DB. Seed a user in org-a (the source) with tv=9.
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password_hash, role, org_id, status, token_version)
     VALUES ('u3', 'u3', 'x', 'org_admin', 'org-a', 'active', 9)`
  ).run();
  onUserOrgMove({ fromOrgId: "org-a", toOrgId: "org-b", userId: "u3" });
  const inB = memberSyncService.listPending({ orgId: "org-b" }).filter((x) => x.userId === "u3");
  assert.equal(inB.length, 1, "org move enqueues a task under the destination org's namespace");
  assert.equal(inB[0].event, "org_move");
  assert.equal(inB[0].sourceNamespaceSlug, "org-a", "org move carries the source namespace slug");
  assert.equal(inB[0].desiredRole, "org_admin", "org move carries the user's role as desiredRole");
});

// ─── 7. suspend/reactivate cycle: distinct tasks per generation ──────────
ok("7. suspend/reactivate cycle", () => {
  onUserSuspend({ orgId: "org-a", userId: "u4", tokenVersion: 10, suspended: true });
  onUserSuspend({ orgId: "org-a", userId: "u4", tokenVersion: 11, suspended: false });
  onUserSuspend({ orgId: "org-a", userId: "u4", tokenVersion: 12, suspended: true });
  const tasks = memberSyncService.listPending({ orgId: "org-a" }).filter((x) => x.userId === "u4");
  assert.equal(tasks.length, 3, "suspend→reactivate→suspend = 3 distinct tasks");
  const events = tasks.map((t) => t.event);
  assert.deepEqual(events.sort(), ["user_restore", "user_suspend", "user_suspend"], "suspend then restore then suspend events");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
