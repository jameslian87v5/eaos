/**
 * skillhub-member-runner.ts — R5c production member-sync runner.
 *
 * Closes codex review #2: lifecycle hooks enqueue durable tasks, but nothing
 * consumed them in production. This runner is the production consumer: a finite
 * pass that drains pending tasks via the real adapter (or no-ops when Hub is
 * unconfigured — safety disable, same contract as runSyncOnce).
 *
 * Wiring:
 *   - Startup (server.ts init): best-effort, non-blocking, swallowed — a
 *     member-sync pass must never block boot or fail the HTTP server.
 *   - Admin route POST /api/admin/hub/member-sync/run: admin-triggered pass
 *     (operator-initiated reconcile after a Hub outage or mapping backfill).
 *
 * Finite: runAll loops runOnce until no runnable task remains (bounded by
 * tasks × maxRetries + 1 passes). The state machine is nonrollback — Hub
 * failures only mutate hub_member_sync_tasks, never users/organizations.
 */
import { createHubMemberAdapter } from "./skillhub-member-adapter.js";
import { memberSyncService, type HubMemberClient } from "./skillhub-member-sync.js";
import { orgNamespaceMappingService } from "./org-namespace-mapping.js";
import { orgService } from "./org-service.js";
import { writeGovernanceAudit } from "./org-governance.js";

export const MEMBER_SYNC_MAX_RETRIES = 3;
/** Periodic worker tick interval (round-3 codex finding #1): a bounded,
 * non-overlapping scheduler that retries pending tasks after their persisted
 * backoff elapses — so a Hub outage → recovery converges automatically without
 * admin replay. 60s default; overridable for tests. */
export const MEMBER_SYNC_INTERVAL_MS = Number(process.env.MEMBER_SYNC_INTERVAL_MS ?? 60000);

/** Exponential backoff schedule by retry count (ms). Capped at the last value. */
const BACKOFF_SCHEDULE_MS = [5_000, 15_000, 45_000];
function backoffMs(retryCount: number): number {
  if (retryCount <= 0) return 0;
  return BACKOFF_SCHEDULE_MS[Math.min(retryCount - 1, BACKOFF_SCHEDULE_MS.length - 1)] ?? 45_000;
}

export interface MemberSyncPassResult {
  pendingBefore: number;
  pendingAfter: number;
  exhaustedAfter: number;
  disabled: boolean; // true = Hub unconfigured (safety no-op) OR a pass is already in flight
  busy?: boolean; // true = skipped because another pass is in flight (mutual exclusion)
}

// ── Shared mutual-exclusion lock for member-sync passes (round-3 #2) ─────
// BOTH the periodic worker AND POST /api/admin/hub/member-sync/run route go
// through runMemberSyncPass, so the lock lives HERE (not just in the timer
// callback). This prevents the admin route from overlapping the timer and
// processing the same pending task twice. An atomic claim: set the flag on
// entry, clear in finally — no window for a double claim.
let passInFlight = false;

/**
 * Shared-lock core for one member-sync pass, with an INJECTABLE adapter (test
 * seam). The mutual-exclusion lock lives here: set on entry, cleared in finally
 * (atomic claim, no double-claim window). BOTH the periodic worker AND the
 * admin route go through this, so they cannot overlap and double-process a
 * pending task. `adapter === null` → safety no-op (Hub unconfigured). Never
 * throws — best-effort, nonrollback.
 */
export async function runMemberSyncPassWith(
  adapter: HubMemberClient | null,
  opts: { maxRetries: number; backoffMs?: (retryCount: number) => number } = { maxRetries: MEMBER_SYNC_MAX_RETRIES, backoffMs },
): Promise<MemberSyncPassResult> {
  const pendingBefore = memberSyncService.listPending().length;
  if (passInFlight) {
    return { pendingBefore, pendingAfter: pendingBefore, exhaustedAfter: memberSyncService.listExhausted().length, disabled: true, busy: true };
  }
  passInFlight = true;
  try {
    if (!adapter) {
      return { pendingBefore, pendingAfter: pendingBefore, exhaustedAfter: memberSyncService.listExhausted().length, disabled: true };
    }
    await memberSyncService.runAll(adapter, opts);
    return {
      pendingBefore,
      pendingAfter: memberSyncService.listPending().length,
      exhaustedAfter: memberSyncService.listExhausted().length,
      disabled: false,
    };
  } finally {
    passInFlight = false;
  }
}

/**
 * Run one member-sync pass (drains currently-DUE tasks only). If another pass
 * is already in flight → returns busy immediately (no overlap). If Hub is
 * unconfigured → safety no-op. Never throws — best-effort, nonrollback.
 */
export async function runMemberSyncPass(): Promise<MemberSyncPassResult> {
  const baseUrl = process.env.SKILLHUB_URL ?? "";
  const token = process.env.SKILLHUB_TOKEN ?? "";
  const adapter = createHubMemberAdapter({ baseUrl, token });
  return runMemberSyncPassWith(adapter, { maxRetries: MEMBER_SYNC_MAX_RETRIES, backoffMs });
}

// ── Periodic non-overlapping worker (round-3 #1) ─────────────────────────
// A single in-process worker. startMemberSyncWorker() is idempotent. The
// mutual-exclusion lock lives inside runMemberSyncPass (above), so the timer
// callback just calls it — if a pass is already in flight (timer tick or
// admin route), runMemberSyncPass returns busy and the tick no-ops. Tasks
// carry persisted next_attempt_at so the worker survives restart — a task
// scheduled for "now+15s" is retried on the next tick after it becomes due,
// even across a process bounce (state is in SQLite, not memory).
let workerTimer: NodeJS.Timeout | null = null;

export function startMemberSyncWorker(intervalMs: number = MEMBER_SYNC_INTERVAL_MS): void {
  if (workerTimer) return; // idempotent — never start two workers
  workerTimer = setInterval(() => {
    // The lock is inside runMemberSyncPass; a slow pass won't stack ticks.
    runMemberSyncPass().catch(() => { /* best-effort; failures recorded via task last_error */ });
  }, intervalMs);
  // unref so the timer never blocks shutdown.
  if (typeof (workerTimer as any).unref === "function") (workerTimer as any).unref();
}

export function stopMemberSyncWorker(): void {
  if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
}

/** Test-only: expose the shared pass lock for assertions. */
export function __passInFlight(): boolean { return passInFlight; }

/**
 * Backfill org→TEAM namespace mappings for existing orgs that have no mapping
 * (codex review #4). Round-3 (#2): uses listAll (active AND frozen) so a
 * frozen or custom mapping is preserved — NOT overwritten or reactivated.
 * Idempotent: skips orgs that already have a mapping (any status). Audited.
 */
export function backfillOrgMappings(): number {
  const allMapped = new Set(orgNamespaceMappingService.listAll().map((m) => m.orgId));
  let created = 0;
  for (const org of orgService.list()) {
    if (allMapped.has(org.id)) continue; // preserve frozen/custom mapping
    try {
      orgNamespaceMappingService.upsert(org.id, org.id);
      writeGovernanceAudit({
        actorUserId: "system", actorRole: "system", orgId: org.id,
        action: "hub.mapping_backfill", objectType: "org", objectId: org.id,
        result: "success", reasonSummary: "backfill mapping for existing org",
      });
      created++;
    } catch {
      writeGovernanceAudit({
        actorUserId: "system", actorRole: "system", orgId: org.id,
        action: "hub.mapping_backfill_failed", objectType: "org", objectId: org.id,
        result: "failure", reasonSummary: "mapping backfill failed",
      });
    }
  }
  return created;
}

/**
 * Durable reconcile for missed user hooks (codex review #4). Re-enqueues the
 * user's current desired state for every user in the org (idempotency dedupes
 * — only users whose hook was missed get a NEW task). Optionally scoped to one
 * org; unscoped = all active orgs with a mapping. Returns total enqueued.
 */
export function reconcileMemberSync(orgId?: string): number {
  const orgIds = orgId
    ? [orgId]
    : orgService.list().filter((o) => o.status === "active").map((o) => o.id);
  let total = 0;
  for (const oid of orgIds) {
    const mapping = orgNamespaceMappingService.getForOrg(oid);
    if (!mapping) continue; // unmapped org — operator must backfill mapping first
    total += memberSyncService.reconcileForOrg(oid);
  }
  return total;
}
