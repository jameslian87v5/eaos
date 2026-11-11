// R5c round-2 integration: lifecycle mutation → durable task → adapter call →
// terminal state; env cannot override mapping; missed-hook recovery; two-org
// denial; retry/exhaust/replay; route-unverified boundary; nonleakage.
// Run: npx tsx server/r5c-integration.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r5c-int-"));
process.env.DB_PATH = path.join(TMP, "int.db");
process.env.ENTITLEMENTS_FILE = path.join(TMP, "ent.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(TMP, "ac.json");
fs.writeFileSync(process.env.ENTITLEMENTS_FILE, JSON.stringify({ entries: [] }));
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE, JSON.stringify({ agents: {} }));

const db = (await import("./database.js")).default;
const { orgService } = await import("./org-service.js");
const { orgNamespaceMappingService } = await import("./org-namespace-mapping.js");
const { memberSyncService, HubMemberRouteM2mExcludedError } = await import("./skillhub-member-sync.js");
const {
  onOrgCreated, onUserCreate, onUserRoleChange, onUserOrgMove, onUserSuspend, dispatchUserHook,
} = await import("./org-namespace-lifecycle.js");
const { resolveTeamSyncTargets } = await import("./skillhub-sync-targets.js");
const { reconcileMemberSync, backfillOrgMappings, runMemberSyncPass, runMemberSyncPassWith, startMemberSyncWorker, stopMemberSyncWorker, __passInFlight } = await import("./skillhub-member-runner.js");
const { createHubMemberAdapter } = await import("./skillhub-member-adapter.js");

let passed = 0, failed = 0;
const failures: string[] = [];
async function ok(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; } catch (e) { failed++; failures.push(`${name}: ${(e as Error).message}`); }
}

// ── Setup: two orgs with mappings + seeded users ──────────────────────────
orgService.create("org-a", "Org A");
orgService.create("org-b", "Org B");
onOrgCreated("org-a"); // upsert mapping org-a → "org-a"
onOrgCreated("org-b"); // upsert mapping org-b → "org-b"

function seedUser(id: string, orgId: string, role: string, tokenVersion: number, status = "active") {
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password_hash, role, org_id, status, token_version)
     VALUES (?, ?, 'x', ?, ?, ?, ?)`
  ).run(id, id, role, orgId, status, tokenVersion);
}

// A fake adapter: records calls + desired state; configurable to succeed /
// fail (transient) / throw route-unverified. NEVER carries a token in surface.
function makeAdapter() {
  const calls: Array<{ ns: string; userId: string; event: string; desired: any }> = [];
  let mode: "ok" | "fail" | "unverified" = "ok";
  return {
    calls,
    setMode(m: "ok" | "fail" | "unverified") { mode = m; },
    async syncMember(ns: string, userId: string, event: string, desired: any) {
      calls.push({ ns, userId, event, desired });
      if (mode === "fail") throw new Error(`HUB_BODY_SECRET:503 service unavailable`);
      if (mode === "unverified") throw new HubMemberRouteM2mExcludedError();
    },
  };
}

const MAX_RETRIES = 3;

// ── 1. lifecycle mutation → durable task → adapter call → terminal (succeeded)
await ok("1. user_create → task → adapter → succeeded (desired carried)", async () => {
  memberSyncService.__clearAll();
  seedUser("u1", "org-a", "user", 1);
  dispatchUserHook("u1", "user_create");
  const tasks = memberSyncService.listPending({ orgId: "org-a" });
  assert.equal(tasks.length, 1, "lifecycle mutation enqueued a durable task");
  assert.equal(tasks[0].desiredRole, "user", "desired role captured at enqueue");
  const a = makeAdapter();
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES });
  assert.equal(a.calls.length, 1, "adapter called once");
  assert.equal(a.calls[0].desired.role, "user", "adapter received desired role");
  assert.equal(a.calls[0].ns, "org-a", "adapter received namespace");
  // terminal state = succeeded (no pending/exhausted left)
  assert.equal(memberSyncService.listPending({ orgId: "org-a" }).length, 0, "task reached succeeded terminal state");
});

// ── 2. later role_change (new generation) enqueues a NEW task → converges
await ok("2. later role_change enqueues new desired state + converges", async () => {
  memberSyncService.__clearAll();
  seedUser("u2", "org-a", "user", 5);
  dispatchUserHook("u2", "role_change");        // tv=5, role=user
  seedUser("u2", "org-a", "org_admin", 6);      // promote → tv=6
  dispatchUserHook("u2", "role_change");        // new generation
  const tasks = memberSyncService.listPending({ orgId: "org-a" }).filter((t) => t.userId === "u2");
  assert.equal(tasks.length, 2, "two generations enqueued");
  const a = makeAdapter();
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES });
  // both calls happened; the later one carries the promoted role
  const last = a.calls[a.calls.length - 1];
  assert.equal(last.desired.role, "org_admin", "later generation carries promoted role");
});

// ── 3. org_move carries source namespace + destination
await ok("3. org_move carries source namespace + destination", () => {
  memberSyncService.__clearAll();
  seedUser("u3", "org-a", "user", 9);
  onUserOrgMove({ fromOrgId: "org-a", toOrgId: "org-b", userId: "u3" });
  const inB = memberSyncService.listPending({ orgId: "org-b" }).filter((t) => t.userId === "u3");
  assert.equal(inB.length, 1, "org_move enqueued under destination org");
  assert.equal(inB[0].sourceNamespaceSlug, "org-a", "source namespace carried for stale-membership removal");
});

// ── 4. env cannot override mapping (mapping wins; override audited)
await ok("4. env cannot override mapping — mapping wins", () => {
  const audited: string[] = [];
  const targets = resolveTeamSyncTargets({
    // env tries to point org-a at a DIFFERENT namespace → override attempt
    envTargets: [{ namespaceSlug: "evil-ns", orgId: "org-a" }],
    audit: (action) => audited.push(action),
  });
  // mapping (org-a → "org-a") wins
  const orgATarget = targets.find((t) => t.orgId === "org-a");
  assert.ok(orgATarget, "org-a target present");
  assert.equal(orgATarget!.namespaceSlug, "org-a", "mapping namespace won over env override");
  assert.ok(!targets.some((t) => t.namespaceSlug === "evil-ns"), "env override namespace NOT applied");
  assert.ok(audited.includes("skillhub.sync_target_env_override_ignored"), "override attempt audited (not silent)");
});

// ── 5. missed-hook recovery: reconcile re-enqueues current desired state
await ok("5. missed-hook recovery via reconcileMemberSync", () => {
  memberSyncService.__clearAll();
  seedUser("u4", "org-a", "user", 10);
  seedUser("u5", "org-a", "user", 11);
  // (NO dispatchUserHook — simulate missed hooks)
  assert.equal(memberSyncService.listPending({ orgId: "org-a" }).length, 0, "no tasks before reconcile");
  const enqueued = reconcileMemberSync("org-a");
  assert.ok(enqueued >= 2, "reconcile enqueued tasks for missed users");
  // idempotent: running again does NOT double-enqueue (idempotency dedupes)
  const enqueued2 = reconcileMemberSync("org-a");
  assert.equal(enqueued2, 0, "reconcile idempotent — no duplicate tasks on re-run");
});

// ── 6. two-org denial: org_admin cannot see another org's tasks
await ok("6. cross-org denial on scoped query", () => {
  memberSyncService.__clearAll();
  seedUser("u6", "org-a", "user", 20);
  dispatchUserHook("u6", "user_create");
  // org_admin of org-b querying pending must NOT see org-a's tasks
  const seen = memberSyncService.listPending({
    orgId: "org-b", requesterOrgId: "org-b", requesterRole: "org_admin",
  });
  assert.equal(seen.length, 0, "org_admin must not see another org's tasks");
  // admin sees all
  const all = memberSyncService.listPending({ requesterRole: "admin" });
  assert.ok(all.length >= 1, "admin sees all tasks");
});

// ── 7. retry → exhausted (finite) → metadata-only last_error → nonleakage
await ok("7. retry → exhausted + metadata-only + nonleakage", async () => {
  memberSyncService.__clearAll();
  seedUser("u7", "org-a", "user", 30);
  dispatchUserHook("u7", "user_create");
  const a = makeAdapter(); a.setMode("fail");
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES });
  const ex = memberSyncService.listExhausted({ orgId: "org-a" });
  assert.equal(ex.length, 1, "exhausted after finite retry");
  assert.equal(ex[0].retryCount, MAX_RETRIES, "retry_count == maxRetries");
  assert.equal(ex[0].lastError, "hub_member_sync_failed", "metadata-only categorical reason");
  assert.ok(!ex[0].lastError?.includes("HUB_BODY_SECRET"), "no raw body leaked");
  assert.ok(!ex[0].lastError?.includes("503"), "no raw status leaked");
});

// ── 8. admin replay (exhausted only) → recovers after Hub back
await ok("8. admin replay (exhausted only) → recovers", async () => {
  memberSyncService.__clearAll();
  seedUser("u8", "org-a", "user", 40);
  dispatchUserHook("u8", "user_create");
  const a = makeAdapter(); a.setMode("fail");
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES });
  const exId = memberSyncService.listExhausted({ orgId: "org-a" })[0].id;
  // replay a non-existent task → not_found
  assert.equal(memberSyncService.replay("nope", { requesterRole: "admin" }).reason, "not_found");
  // replay is admin-scoped; org_admin cross-org → cross_org_denied
  assert.equal(memberSyncService.replay(exId, { requesterRole: "org_admin", requesterOrgId: "org-b" }).reason, "cross_org_denied");
  // admin replay → ok
  const r = memberSyncService.replay(exId, { requesterRole: "admin" });
  assert.equal(r.ok, true, "admin replay ok");
  a.setMode("ok");
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES });
  assert.equal(memberSyncService.listExhausted({ orgId: "org-a" }).length, 0, "exhausted cleared after replay + recovery");
});

// ── 9. member route M2M-excluded boundary → immediate exhausted (no retry waste)
// Round-6 live-verified: Hub admin namespace member routes return HTTP 403
// "API token cannot access endpoint" for ANY API token (SUPER_ADMIN-session-
// only by Hub design). The adapter throws HubMemberRouteM2mExcludedError →
// immediate exhausted (PERMANENT boundary, not transient — no retry waste).
await ok("9. member route M2M-excluded → immediate exhausted (no fake PASS)", async () => {
  memberSyncService.__clearAll();
  seedUser("u9", "org-a", "user", 50);
  dispatchUserHook("u9", "user_create");
  const a = makeAdapter(); a.setMode("unverified");
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES });
  const ex = memberSyncService.listExhausted({ orgId: "org-a" });
  assert.equal(ex.length, 1, "M2M-excluded route → exhausted (NOT succeeded — no fake PASS)");
  assert.equal(ex[0].lastError, "hub_member_route_m2m_excluded", "explicit permanent-boundary reason");
  assert.equal(ex[0].retryCount, 0, "no retries wasted on permanent boundary");
});

// ── 10. production adapter boundary: real adapter uses listNamespaces then
// throws M2mExcluded (live-verified: no M2M-authorized member route exists).
// Proves the production path is honest, not a fake PASS.
await ok("10. production adapter = listNamespaces precondition + M2M-excluded boundary", async () => {
  memberSyncService.__clearAll();
  seedUser("u10", "org-a", "user", 60);
  dispatchUserHook("u10", "user_create");
  // fake R5b client: listNamespaces returns ACTIVE "org-a"
  const adapter = createHubMemberAdapter({
    baseUrl: "http://hub", token: "secret-token",
    client: {
      listNamespaces: async () => [{ slug: "org-a", displayName: "Org A", type: "TEAM" as const, status: "ACTIVE" }],
      listPublishedSkills: async () => [], getVersionDetail: async () => ({ version: "", sha256: null, parsedMetadataJson: null, manifestJson: null }),
      downloadSkill: async () => ({ localPath: "", sha256: null }),
    },
  });
  assert.ok(adapter, "adapter built when configured");
  const err = await adapter!.syncMember("org-a", "u10", "user_create", { role: "user" }).then(() => null).catch((e) => e);
  assert.ok(err instanceof HubMemberRouteM2mExcludedError, "production adapter throws M2mExcluded (no fake PASS)");
  // token is NOT in the adapter's surface — it lives only in the R5b client
});

// ── 11. safety disable: no SKILLHUB_URL/TOKEN → runner no-op
await ok("11. unconfigured Hub → runner safety no-op", async () => {
  memberSyncService.__clearAll();
  seedUser("u11", "org-a", "user", 70);
  dispatchUserHook("u11", "user_create");
  const savedUrl = process.env.SKILLHUB_URL; const savedTok = process.env.SKILLHUB_TOKEN;
  delete process.env.SKILLHUB_URL; delete process.env.SKILLHUB_TOKEN;
  try {
    const r = await runMemberSyncPass();
    assert.equal(r.disabled, true, "runner disabled when Hub unconfigured");
    assert.equal(memberSyncService.listPending({ orgId: "org-a" }).length, 1, "task left pending (not run) when disabled");
  } finally {
    // Restore exactly: if saved was undefined (absent), DELETE — assigning
    // undefined would set the string "undefined" and leak into later tests.
    if (savedUrl === undefined) delete process.env.SKILLHUB_URL; else process.env.SKILLHUB_URL = savedUrl;
    if (savedTok === undefined) delete process.env.SKILLHUB_TOKEN; else process.env.SKILLHUB_TOKEN = savedTok;
  }
});

// ── 12. backfill: existing unmapped org gets a mapping (missed onOrgCreated)
await ok("12. backfillOrgMappings fills missed mappings", () => {
  orgService.create("org-c", "Org C"); // no onOrgCreated → no mapping
  const before = orgNamespaceMappingService.getForOrg("org-c");
  assert.ok(!before, "org-c has no mapping before backfill");
  const created = backfillOrgMappings();
  assert.ok(created >= 1, "backfill created at least one mapping");
  const after = orgNamespaceMappingService.getForOrg("org-c");
  assert.ok(after, "org-c mapped after backfill");
});

// ── 13. suspend → restore cycle enqueues distinct desired-status tasks
await ok("13. suspend/restore carries desired status", () => {
  memberSyncService.__clearAll();
  seedUser("u13", "org-a", "user", 80);
  onUserSuspend({ orgId: "org-a", userId: "u13", tokenVersion: 80, suspended: true });
  seedUser("u13", "org-a", "user", 81);
  onUserSuspend({ orgId: "org-a", userId: "u13", tokenVersion: 81, suspended: false });
  const tasks = memberSyncService.listPending({ orgId: "org-a" }).filter((t) => t.userId === "u13");
  assert.equal(tasks.length, 2, "suspend + restore = 2 distinct tasks");
  const suspend = tasks.find((t) => t.event === "user_suspend");
  const restore = tasks.find((t) => t.event === "user_restore");
  assert.ok(suspend && restore);
  assert.equal(suspend!.desiredStatus, "disabled", "suspend carries desiredStatus=disabled");
  assert.equal(restore!.desiredStatus, "active", "restore carries desiredStatus=active");
});

// ── 14. outage → recovery → AUTOMATIC success (no admin retry) [round-3 #1]
await ok("14. outage→recovery automatic success via persisted backoff", async () => {
  memberSyncService.__clearAll();
  seedUser("u14", "org-a", "user", 90);
  dispatchUserHook("u14", "user_create");
  const a = makeAdapter(); a.setMode("fail");
  // backoff > 1s so SQLite whole-second datetime('now') actually defers the
  // retry (sub-second backoff truncates to the same second → due immediately).
  const backoff = () => 1100;
  // 1st pass: Hub down → task fails, retry_count=1, next_attempt_at = future
  await memberSyncService.runOnce(a, { maxRetries: MAX_RETRIES, backoffMs: backoff });
  let t = memberSyncService.listPending({ orgId: "org-a" })[0];
  assert.ok(t, "task still pending (NOT exhausted) after one failure with backoff");
  assert.equal(t.retryCount, 1, "retry_count bumped once");
  assert.ok(t.nextAttemptAt, "next_attempt_at persisted (durable retry eligibility)");
  // runAll now finds NO due task (next_attempt_at in the future) → no progress
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES, backoffMs: backoff });
  assert.equal(memberSyncService.listPending({ orgId: "org-a" }).length, 1, "future-dated task NOT retried early");
  // 2. Hub recovers → wait past backoff → next pass succeeds AUTOMATICALLY
  a.setMode("ok");
  await new Promise((r) => setTimeout(r, 1300));
  await memberSyncService.runAll(a, { maxRetries: MAX_RETRIES, backoffMs: backoff });
  assert.equal(memberSyncService.listPending({ orgId: "org-a" }).length, 0, "task auto-converged to succeeded after recovery — no admin replay");
});

// ── 15. backfill preserves frozen/custom mapping [round-3 #2]
await ok("15. backfill preserves frozen custom mapping (no overwrite/reactivate)", () => {
  // org-d: custom namespace "custom-ns", frozen. backfill must NOT touch it.
  orgService.create("org-d", "Org D");
  orgNamespaceMappingService.upsert("org-d", "custom-ns");
  orgNamespaceMappingService.setFrozen("org-d", true);
  const before = orgNamespaceMappingService.getForOrg("org-d");
  assert.equal(before!.namespaceSlug, "custom-ns", "custom namespace set");
  assert.equal(before!.status, "frozen", "frozen before backfill");
  backfillOrgMappings();
  const after = orgNamespaceMappingService.getForOrg("org-d");
  assert.equal(after!.namespaceSlug, "custom-ns", "custom namespace PRESERVED (not overwritten to org-d)");
  assert.equal(after!.status, "frozen", "frozen status PRESERVED (not reactivated)");
});

// ── 16. periodic worker: idempotent start + stop + shared pass lock
await ok("16. member-sync worker start/stop + shared pass lock", () => {
  stopMemberSyncWorker();
  startMemberSyncWorker(1000);
  startMemberSyncWorker(1000); // idempotent — must not start a second timer
  assert.equal(__passInFlight(), false, "pass lock released at rest");
  stopMemberSyncWorker();
});

// ── 17. mutual exclusion: admin route + timer cannot overlap [round-3 #2]
// Deterministic (round-5): a delayed adapter that holds the first run inside
// runAll→runOnce→syncMember, so the second pass observes passInFlight=true
// and returns busy WITHOUT a second processing attempt. Then release the
// first, assert it completed + exactly one syncMember call + lock released.
await ok("17. manual+timer mutual exclusion — no double processing", async () => {
  memberSyncService.__clearAll();
  seedUser("u17", "org-a", "user", 100);
  dispatchUserHook("u17", "user_create");
  // Release gate: first syncMember call awaits this promise, holding the lock.
  let release1: () => void = () => {};
  const held = new Promise<void>((r) => { release1 = r; });
  let calls = 0;
  const a: any = {
    async syncMember(_ns: string, _userId: string, _event: string, _desired: any) {
      calls++;
      if (calls === 1) await held; // hold the first pass inside runAll
    },
  };
  // 1st pass (e.g. slow timer tick): enters runAll → runOnce → syncMember → awaits `held`.
  const p1 = runMemberSyncPassWith(a, { maxRetries: MAX_RETRIES, backoffMs: () => 0 });
  // Let p1 actually claim the lock and reach the await inside syncMember.
  // (runOnce is async; a microtask flush lets it progress past the claim.)
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(__passInFlight(), true, "lock held while first pass is in flight");
  // 2nd pass (admin route) while first holds → busy, no overlap, no extra call.
  const r2 = await runMemberSyncPassWith(a, { maxRetries: MAX_RETRIES, backoffMs: () => 0 });
  assert.equal(r2.busy, true, "second pass skipped as busy (no overlap)");
  assert.equal(r2.disabled, true, "second pass disabled (skipped, not run)");
  assert.equal(calls, 1, "no second processing attempt while first holds lock");
  // Release the first pass → it completes; lock released; still exactly one call.
  release1();
  const r1 = await p1;
  assert.equal(r1.disabled, false, "first pass completed after release");
  assert.equal(calls, 1, "exactly one syncMember attempt total — no double processing");
  assert.equal(__passInFlight(), false, "pass lock released after first completes");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
