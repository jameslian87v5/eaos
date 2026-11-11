// R5c member-sync state machine. Run: npx tsx server/skillhub-member-sync.test.ts
// Hermetic: DB_PATH + ENTITLEMENTS_FILE + AGENT_CAPABILITIES_FILE point at temp
// files set before the dynamic import (database.js connects at module load).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r5c-ms-"));
process.env.DB_PATH = path.join(TMP, "ms.db");
process.env.ENTITLEMENTS_FILE = path.join(TMP, "ent.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(TMP, "ac.json");
fs.writeFileSync(process.env.ENTITLEMENTS_FILE, JSON.stringify({ entries: [] }));
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE, JSON.stringify({ agents: {} }));

const db = (await import("./database.js")).default;
const { orgService } = await import("./org-service.js");
const { orgNamespaceMappingService } = await import("./org-namespace-mapping.js");
const { memberSyncService } = await import("./skillhub-member-sync.js");

let passed = 0, failed = 0;
const failures: string[] = [];
async function ok(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; } catch (e) { failed++; failures.push(`${name}: ${(e as Error).message}`); }
}

// Two orgs, each with a TEAM namespace mapping.
orgService.create("org-a", "Org A");
orgService.create("org-b", "Org B");
orgNamespaceMappingService.upsert("org-a", "team-a");
orgNamespaceMappingService.upsert("org-b", "team-b");

// A fake Hub member-sync client. Records calls; can be made to throw to
// simulate Hub outage, then recover. NEVER carries a token in its surface
// (the real client holds the token server-side only).
function makeClient() {
  const calls: Array<{ ns: string; userId: string; event: string; desired: any }> = [];
  let failing = false;
  let routeUnverified = false;
  let throwMsg = "hub unavailable";
  return {
    calls,
    failing,
    setFailing(v: boolean, msg = "hub unavailable") { failing = v; throwMsg = msg; },
    setRouteUnverified(v: boolean) { routeUnverified = v; },
    async syncMember(ns: string, userId: string, event: string, desired: any) {
      calls.push({ ns, userId, event, desired });
      if (routeUnverified) throw new (await import("./skillhub-member-sync.js")).HubMemberRouteM2mExcludedError();
      if (failing) throw new Error(`HUB_RESPONSE_BODY_SECRET:${throwMsg}`);
    },
  };
}

const MAX_RETRIES = 3;

// ─── A. exact-duplicate delivery dedupes (same generation) ──────────────
await ok("A. exact-duplicate dedupe", () => {
  memberSyncService.__clearAll();
  const c = makeClient();
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u1", event: "user_create", targetVersion: 1 });
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u1", event: "user_create", targetVersion: 1 });
  const tasks = memberSyncService.listPending();
  assert.equal(tasks.length, 1, "exact duplicate (same target_version) must dedupe to 1 task");
});

// ─── B. later legitimate mutation enqueues a NEW task (NOT suppressed) ──
await ok("B. later role change enqueues new desired state", () => {
  memberSyncService.__clearAll();
  const c = makeClient();
  // first role change → role R1 (token_version bumped to 5)
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u2", event: "role_change", targetVersion: 5 });
  // later role change → role R2 (token_version bumped to 6) — NEW desired state
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u2", event: "role_change", targetVersion: 6 });
  const tasks = memberSyncService.listPending({ orgId: "org-a" });
  assert.equal(tasks.length, 2, "later role change (new target_version) must enqueue a new task");
});

// ─── C. suspend→reactivate→suspend cycle: 3 distinct tasks ─────────────
await ok("C. suspend/reactivate/suspend cycle enqueues distinct tasks", () => {
  memberSyncService.__clearAll();
  memberSyncService.enqueue({ orgId: "org-b", namespaceSlug: "team-b", userId: "u3", event: "user_suspend", targetVersion: 10 });
  memberSyncService.enqueue({ orgId: "org-b", namespaceSlug: "team-b", userId: "u3", event: "user_restore", targetVersion: 11 });
  memberSyncService.enqueue({ orgId: "org-b", namespaceSlug: "team-b", userId: "u3", event: "user_suspend", targetVersion: 12 });
  const tasks = memberSyncService.listPending({ orgId: "org-b" });
  assert.equal(tasks.length, 3, "suspend→reactivate→suspend (each new generation) = 3 distinct tasks, not deduped");
});

// ─── D. retry → exhausted (finite retry); last_error metadata-only ───────
await ok("D. retry exhausted + metadata-only error", async () => {
  memberSyncService.__clearAll();
  const c = makeClient(); c.setFailing(true, "503 service unavailable");
  // u4 suspend, tv=20
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u4", event: "user_suspend", targetVersion: 20 });
  // run pending until exhausted (finite retry within one run)
  await memberSyncService.runAll(c, { maxRetries: MAX_RETRIES });
  const ex = memberSyncService.listExhausted({ orgId: "org-a" });
  assert.equal(ex.length, 1, "exhausted after finite retry");
  const t = ex[0];
  assert.equal(t.retryCount, MAX_RETRIES, "retry_count == maxRetries at exhaustion");
  // metadata-only: the raw HUB_RESPONSE_BODY_SECRET marker must NOT be in last_error
  assert.ok(!t.lastError?.includes("HUB_RESPONSE_BODY_SECRET"), "last_error must not leak raw hub body/error");
  assert.ok(!t.lastError?.includes("503"), "last_error must be a short categorical reason, not the raw status/body");
});

// ─── E. freeze: frozen org's pending tasks are skipped (no Hub call) ────
await ok("E. frozen org skips member sync", () => {
  memberSyncService.__clearAll();
  const c = makeClient();
  memberSyncService.enqueue({ orgId: "org-b", namespaceSlug: "team-b", userId: "u5", event: "user_create", targetVersion: 1 });
  orgNamespaceMappingService.setFrozen("org-b", true);
  memberSyncService.runOnce(c, { maxRetries: MAX_RETRIES });
  assert.equal(c.calls.length, 0, "frozen org must not trigger Hub member calls");
  const stillPending = memberSyncService.listPending({ orgId: "org-b" });
  assert.equal(stillPending.length, 1, "frozen task stays pending (not failed, not run)");
  orgNamespaceMappingService.setFrozen("org-b", false);
});

// ─── F. nonrollback: Hub failure does not touch platform main data ───────
await ok("F. nonrollback — platform user/org data intact after Hub failure", async () => {
  memberSyncService.__clearAll();
  const c = makeClient(); c.setFailing(true, "hub down");
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u6", event: "user_suspend", targetVersion: 30 });
  const orgsBefore = orgService.list().length;
  await memberSyncService.runAll(c, { maxRetries: MAX_RETRIES });
  const orgsAfter = orgService.list();
  assert.equal(orgsAfter.length, orgsBefore, "orgs unchanged by Hub failure (nonrollback)");
  // member sync only mutated the task table; org/user main rows intact.
});

// ─── G. replay: admin resets exhausted → pending → recovers ─────────────
await ok("G. admin replay exhausted → recovers after Hub back", async () => {
  memberSyncService.__clearAll();
  const c = makeClient(); c.setFailing(true, "hub down");
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u7", event: "user_suspend", targetVersion: 40 });
  await memberSyncService.runAll(c, { maxRetries: MAX_RETRIES });
  assert.equal(memberSyncService.listExhausted({ orgId: "org-a" }).length, 1, "exhausted before replay");
  c.setFailing(false);
  memberSyncService.replay(/* find the exhausted task id */ memberSyncService.listExhausted({ orgId: "org-a" })[0].id, { requesterRole: "admin" });
  await memberSyncService.runAll(c, { maxRetries: MAX_RETRIES });
  assert.equal(memberSyncService.listExhausted({ orgId: "org-a" }).length, 0, "exhausted cleared after successful replay");
});

// ─── H. cross-org: org_admin cannot query another org's exhausted tasks ──
await ok("H. cross-org denial on exhausted query", async () => {
  memberSyncService.__clearAll();
  const c = makeClient(); c.setFailing(true, "hub down");
  memberSyncService.enqueue({ orgId: "org-a", namespaceSlug: "team-a", userId: "u8", event: "user_suspend", targetVersion: 50 });
  await memberSyncService.runAll(c, { maxRetries: MAX_RETRIES });
  // org_admin of org-b querying exhausted must NOT see org-a's tasks
  const seen = memberSyncService.listExhausted({ orgId: "org-b", requesterOrgId: "org-b", requesterRole: "org_admin" });
  assert.equal(seen.length, 0, "org_admin must not see another org's exhausted tasks");
  // admin sees all
  const allEx = memberSyncService.listExhausted({ requesterRole: "admin" });
  assert.ok(allEx.length >= 1, "admin sees all exhausted tasks");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
