/**
 * skillhub-member-sync.ts — R5c Hub member-sync task state machine.
 *
 * Desired-state generation model (corrected per review): the idempotency key
 * is (org_id, user_id, event, target_version) where target_version is the
 * user's monotonic token_version AT ENQUEUE time. EXACT duplicate delivery
 * (same mutation delivered twice) shares the key → dedupes (INSERT OR IGNORE).
 * A LATER legitimate mutation (2nd role change, suspend after a reactivate
 * cycle) bumps token_version → a new key → a NEW task. UNIQUE(org,user,event)
 * is deliberately NOT used (it would permanently suppress legitimate repeats).
 *
 * Desired state (round-2): each task carries desired_role / desired_status /
 * source_namespace_slug so the adapter can converge role/status/move on the
 * Hub. The platform never re-derives these at sync time — they are captured at
 * enqueue from the post-mutation users row (single source of truth).
 *
 * State machine: pending → succeeded | exhausted (finite retry). The runner
 * processes pending tasks FIFO; Hub member ops are idempotent (add/remove/
 * set-role), so older-then-newer application converges to the latest desired
 * state. Frozen orgs' tasks are skipped (not failed) — TEAM/member sync pauses
 * while the org is suspended. HubMemberRouteM2mExcludedError → immediate
 * exhausted (no retry waste — the boundary is permanent, not transient).
 *
 * metadata-only 铁律: last_error is a SHORT categorical reason
 * ("hub_member_sync_failed" | "hub_member_route_m2m_excluded"); NEVER the raw Hub
 * response body, status, error message, or token.
 *
 * nonrollback: this service only mutates hub_member_sync_tasks. It NEVER writes
 * users / organizations — a Hub failure cannot roll back platform main data.
 *
 * The Hub client is injected (test fake, or the real R5b-recorded-routes
 * adapter in skillhub-member-adapter.ts).
 */
import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import { orgNamespaceMappingService } from "./org-namespace-mapping.js";
import type { Role } from "./request-context.js";

export type MemberSyncEvent =
  | "user_create" | "role_change" | "org_move" | "user_suspend" | "user_restore";
export type MemberSyncState = "pending" | "succeeded" | "exhausted";

/** Desired state the adapter applies at the Hub. All optional — present when
 * the lifecycle hook captured them (create/role/move/suspend/restore). */
export interface MemberDesiredState {
  role?: string;
  status?: string;
  /** For org_move: the user's SOURCE namespace (old org) so the adapter can
   * remove stale membership there. Undefined for non-move events. */
  sourceNamespaceSlug?: string;
}

export interface MemberSyncTask {
  id: string;
  idempotencyKey: string;
  orgId: string;
  namespaceSlug: string;
  userId: string;
  event: MemberSyncEvent;
  targetVersion: number;
  desiredRole: string | null;
  desiredStatus: string | null;
  sourceNamespaceSlug: string | null;
  nextAttemptAt: string | null;
  state: MemberSyncState;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Adapter contract. The real production adapter (skillhub-member-adapter.ts)
 * uses ONLY R5b-recorded routes (listNamespaces precondition). The member op
 * route is LIVE-VERIFIED M2M-EXCLUDED (round-6 forensics): every admin
 * namespace member/freeze route returns HTTP 403 "API token cannot access
 * endpoint" from ApiTokenScopeFilter for ANY API token (no API_TOKEN_POLICIES
 * entry), AND @PreAuthorize("hasRole('SUPER_ADMIN')") gates the role. The Hub
 * exposes NO M2M path to these ops → adapter throws
 * HubMemberRouteM2mExcludedError (explicit permanent boundary, NOT fake PASS).
 * Tests inject a fake.
 */
export interface HubMemberClient {
  syncMember(
    namespaceSlug: string,
    userId: string,
    event: MemberSyncEvent,
    desired: MemberDesiredState,
  ): Promise<void>;
}

/** Thrown by the adapter when the Hub member route is live-verified
 * M2M-excluded (HTTP 403 "API token cannot access endpoint" from
 * ApiTokenScopeFilter; admin namespace routes are SUPER_ADMIN-session-only).
 * The runner treats this as immediate-exhausted (PERMANENT boundary, not a
 * transient retryable outage) with last_error="hub_member_route_m2m_excluded".
 * The desired state is still carried so that IF a future Hub version adds an
 * M2M-authorized member path (or the platform adopts a SUPER_ADMIN session
 * flow), the task converges. */
export class HubMemberRouteM2mExcludedError extends Error {
  constructor() { super("hub_member_route_m2m_excluded"); this.name = "HubMemberRouteM2mExcludedError"; }
}

const COLUMNS = `id, idempotency_key AS idempotencyKey, org_id AS orgId, namespace_slug AS namespaceSlug,
  user_id AS userId, event, target_version AS targetVersion,
  desired_role AS desiredRole, desired_status AS desiredStatus,
  source_namespace_slug AS sourceNamespaceSlug,
  next_attempt_at AS nextAttemptAt,
  state, retry_count AS retryCount, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt`;

const stmts = {
  insert: db.prepare(
    `INSERT OR IGNORE INTO hub_member_sync_tasks
      (id, idempotency_key, org_id, namespace_slug, user_id, event, target_version,
       desired_role, desired_status, source_namespace_slug, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ),
  getById: db.prepare(`SELECT ${COLUMNS} FROM hub_member_sync_tasks WHERE id = ?`),
  getByIdempotency: db.prepare(`SELECT ${COLUMNS} FROM hub_member_sync_tasks WHERE idempotency_key = ?`),
  // Runnable = pending AND due (next_attempt_at NULL or <= now). Frozen-org
  // filtering is applied in JS (needs the mapping lookup).
  listRunnable: db.prepare(
    `SELECT ${COLUMNS} FROM hub_member_sync_tasks
     WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
     ORDER BY created_at ASC`
  ),
  listRunnableForOrg: db.prepare(
    `SELECT ${COLUMNS} FROM hub_member_sync_tasks
     WHERE state = 'pending' AND org_id = ? AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
     ORDER BY created_at ASC`
  ),
  listPending: db.prepare(`SELECT ${COLUMNS} FROM hub_member_sync_tasks WHERE state = 'pending' ORDER BY created_at ASC`),
  listPendingForOrg: db.prepare(`SELECT ${COLUMNS} FROM hub_member_sync_tasks WHERE state = 'pending' AND org_id = ? ORDER BY created_at ASC`),
  listExhausted: db.prepare(`SELECT ${COLUMNS} FROM hub_member_sync_tasks WHERE state = 'exhausted' ORDER BY updated_at DESC`),
  listExhaustedForOrg: db.prepare(`SELECT ${COLUMNS} FROM hub_member_sync_tasks WHERE state = 'exhausted' AND org_id = ? ORDER BY updated_at DESC`),
  markSucceeded: db.prepare(`UPDATE hub_member_sync_tasks SET state = 'succeeded', last_error = NULL, next_attempt_at = NULL, updated_at = datetime('now') WHERE id = ?`),
  bumpRetry: db.prepare(`UPDATE hub_member_sync_tasks SET retry_count = retry_count + 1, last_error = 'hub_member_sync_failed', next_attempt_at = ?, updated_at = datetime('now') WHERE id = ?`),
  markExhausted: db.prepare(`UPDATE hub_member_sync_tasks SET state = 'exhausted', retry_count = ?, last_error = ?, next_attempt_at = NULL, updated_at = datetime('now') WHERE id = ?`),
  replayReset: db.prepare(`UPDATE hub_member_sync_tasks SET state = 'pending', retry_count = 0, last_error = NULL, next_attempt_at = NULL, updated_at = datetime('now') WHERE id = ? AND state = 'exhausted'`),
  getRetryCount: db.prepare(`SELECT retry_count AS retryCount FROM hub_member_sync_tasks WHERE id = ?`),
};

export interface EnqueueInput {
  orgId: string;
  namespaceSlug: string;
  userId: string;
  event: MemberSyncEvent;
  targetVersion: number;
  desired?: MemberDesiredState;
}

export interface ListScope {
  orgId?: string;
  requesterOrgId?: string;
  requesterRole?: Role | "system";
}

export interface ReplayScope {
  requesterRole: Role | "system";
  requesterOrgId?: string;
}

export interface ReplayResult {
  ok: boolean;
  reason?: "not_found" | "not_exhausted" | "cross_org_denied";
  task?: MemberSyncTask;
}

class MemberSyncService {
  /**
   * Enqueue a member-sync task. Idempotent on (org,user,event,target_version):
   * exact duplicate delivery (same generation) is a no-op returning the
   * existing task; a later mutation (new generation) enqueues a new task.
   */
  enqueue(input: EnqueueInput): MemberSyncTask {
    const idempotencyKey = `${input.orgId}:${input.userId}:${input.event}:v${input.targetVersion}`;
    const id = uuidv4();
    stmts.insert.run(
      id, idempotencyKey, input.orgId, input.namespaceSlug, input.userId, input.event,
      input.targetVersion, input.desired?.role ?? null, input.desired?.status ?? null,
      input.desired?.sourceNamespaceSlug ?? null,
    );
    return stmts.getByIdempotency.get(idempotencyKey) as MemberSyncTask;
  }

  listPending(scope: ListScope = {}): MemberSyncTask[] {
    if (scope.requesterRole === "org_admin") {
      const org = scope.requesterOrgId;
      if (!org) return [];
      return stmts.listPendingForOrg.all(org) as MemberSyncTask[];
    }
    if (scope.orgId) return stmts.listPendingForOrg.all(scope.orgId) as MemberSyncTask[];
    return stmts.listPending.all() as MemberSyncTask[];
  }

  listExhausted(scope: ListScope = {}): MemberSyncTask[] {
    if (scope.requesterRole === "org_admin") {
      const org = scope.requesterOrgId;
      if (!org) return [];
      return stmts.listExhaustedForOrg.all(org) as MemberSyncTask[];
    }
    if (scope.orgId) return stmts.listExhaustedForOrg.all(scope.orgId) as MemberSyncTask[];
    return stmts.listExhausted.all() as MemberSyncTask[];
  }

  /**
   * Admin replay: reset an EXHAUSTED task to pending (retry_count=0). Scope-
   * checked: org_admin may only replay own-org tasks (cross-org deny). Only
   * exhausted tasks are replayable (pending/succeeded → not_exhausted).
   */
  replay(taskId: string, scope: ReplayScope): ReplayResult {
    const task = stmts.getById.get(taskId) as MemberSyncTask | undefined;
    if (!task) return { ok: false, reason: "not_found" };
    if (scope.requesterRole === "org_admin" && task.orgId !== scope.requesterOrgId) {
      return { ok: false, reason: "cross_org_denied" };
    }
    if (task.state !== "exhausted") return { ok: false, reason: "not_exhausted", task };
    stmts.replayReset.run(taskId);
    return { ok: true, task: stmts.getById.get(taskId) as MemberSyncTask };
  }

  /** Test-only: clear all member-sync tasks for scenario isolation. */
  __clearAll(): void {
    db.prepare(`DELETE FROM hub_member_sync_tasks`).run();
  }

  /**
   * Process the oldest DUE runnable pending task (pending + next_attempt_at
   * due + org not frozen). Frozen-org tasks are skipped. Route-unverified →
   * immediate exhausted (no retry waste). Generic failure → bump retry +
   * schedule next_attempt_at = now + backoff(retry). After maxRetries →
   * exhausted. Returns the task processed (terminal/due state) or null.
   *
   * backoffMs(retryCount) defaults to 0 (immediate) so a single runAll still
   * drains all due tasks in one pass (existing test behavior). Production
   * passes a real backoff so a transient Hub outage is retried over time by
   * the periodic worker — and converges automatically after Hub recovery
   * WITHOUT admin replay.
   */
  async runOnce(
    hubClient: HubMemberClient,
    opts: { maxRetries: number; backoffMs?: (retryCount: number) => number },
  ): Promise<MemberSyncTask | null> {
    const due = stmts.listRunnable.all() as MemberSyncTask[];
    const runnable = due.find((t) => {
      const m = orgNamespaceMappingService.getForOrg(t.orgId);
      return !!m && m.status === "active";
    });
    if (!runnable) return null;
    const desired: MemberDesiredState = {
      role: runnable.desiredRole ?? undefined,
      status: runnable.desiredStatus ?? undefined,
      sourceNamespaceSlug: runnable.sourceNamespaceSlug ?? undefined,
    };
    const backoffMs = opts.backoffMs ?? (() => 0);
    try {
      await hubClient.syncMember(runnable.namespaceSlug, runnable.userId, runnable.event, desired);
      stmts.markSucceeded.run(runnable.id);
    } catch (err: any) {
      if (err instanceof HubMemberRouteM2mExcludedError) {
        const cur = stmts.getRetryCount.get(runnable.id) as { retryCount: number } | undefined;
        stmts.markExhausted.run((cur?.retryCount ?? runnable.retryCount), "hub_member_route_m2m_excluded", runnable.id);
      } else {
        const cur = stmts.getRetryCount.get(runnable.id) as { retryCount: number } | undefined;
        const nextRetry = (cur?.retryCount ?? runnable.retryCount) + 1;
        if (nextRetry >= opts.maxRetries) {
          stmts.markExhausted.run(nextRetry, "hub_member_sync_failed", runnable.id);
        } else {
          const waitMs = Math.max(0, backoffMs(nextRetry));
          // Format as SQLite datetime('now') does: "YYYY-MM-DD HH:MM:SS" UTC,
          // NO milliseconds — otherwise the ms fraction makes the string
          // lexicographically greater than datetime('now') and the task never
          // becomes due. Truncate to whole seconds (conservative — the task may
          // retry up to ~1s early, which is fine for backoff).
          const nextAt = new Date(Date.now() + waitMs).toISOString().slice(0, 19).replace("T", " ");
          stmts.bumpRetry.run(nextAt, runnable.id);
        }
      }
    }
    return stmts.getById.get(runnable.id) as MemberSyncTask;
  }

  /**
   * Process DUE pending tasks until no runnable one remains. With backoffMs=0
   * (default) this drains all pending tasks in one pass (existing behavior);
   * with a real backoff it drains only currently-due tasks, leaving
   * future-dated tasks for the periodic worker.
   */
  async runAll(
    hubClient: HubMemberClient,
    opts: { maxRetries: number; backoffMs?: (retryCount: number) => number },
  ): Promise<void> {
    let guard = 0;
    const maxPasses = (stmts.listPending.all() as MemberSyncTask[]).length * (opts.maxRetries + 1) + 1;
    while (guard < maxPasses) {
      const processed = await this.runOnce(hubClient, opts);
      if (!processed) break;
      guard++;
    }
  }

  /**
   * Durable reconcile/backfill for missed hooks (round-2 P1 #4). For every user
   * in the org, enqueue a `user_create` task at the user's CURRENT token_version
   * (the desired-state generation). Idempotency dedupes — if a task for this
   * generation already exists, INSERT OR IGNORE no-ops. Safe to run repeatedly.
   * Reads users READ-ONLY (nonrollback: never writes users).
   */
  reconcileForOrg(orgId: string): number {
    const rows = db.prepare(
      `SELECT id AS userId, token_version AS tokenVersion, role, status FROM users WHERE org_id = ?`
    ).all(orgId) as Array<{ userId: string; tokenVersion: number; role: string; status: string }>;
    const mapping = orgNamespaceMappingService.getForOrg(orgId);
    if (!mapping) return 0;
    let enqueued = 0;
    for (const u of rows) {
      const before = (stmts.listPending.all() as MemberSyncTask[]).length;
      this.enqueue({
        orgId, namespaceSlug: mapping.namespaceSlug, userId: u.userId,
        event: "user_create", targetVersion: u.tokenVersion,
        desired: { role: u.role, status: u.status },
      });
      if ((stmts.listPending.all() as MemberSyncTask[]).length > before) enqueued++;
    }
    return enqueued;
  }
}

export const memberSyncService = new MemberSyncService();
