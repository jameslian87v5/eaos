/**
 * skillhub-sync-worker.ts — R5d-1 production Skill sync runner.
 *
 * Closes codex R5d-1 directive §1–§3: the minimal background运营闭环 that
 * mirrors PUBLISHED Skill Hub skills into the platform shared pool + org
 * entitlement, WITHOUT business users or org_admin ever touching an API token
 * or running a sync command. The platform `skill:read` token is injected once
 * by ops (SKILLHUB_TOKEN, server-side env / secret only).
 *
 * Mirrors skillhub-member-runner.ts (R5c round-3): shared mutual-exclusion
 * lock lives HERE, so the periodic worker AND POST /api/admin/hub/sync/run
 * CANNOT overlap and double-sync a namespace. Hub unconfigured → safety
 * no-op (same contract as runSyncOnce). Hub failure is caught + classified
 * to a categorical status string; it NEVER crashes the server, breaks chat,
 * or invalidates already-installed skills (runSyncOnce is nonrollback: only
 * mutates data/skills.json + entitlements.json sidecars + audit rows).
 *
 * What this is NOT (directive边界): no outbox / message bus / SCIM / IAM / Hub
 * UI / R5e SSO. Reuses runSyncOnce + resolveTeamSyncTargets + the persistent
 * org_namespace_mappings + writeGovernanceAudit.
 */
import { runSyncOnce, type RunSyncOverrides } from "./skillhub-bridge.prod.js";
import { resolveTeamSyncTargets, type SyncTarget } from "./skillhub-sync-targets.js";
import {
  recordAttempt,
  classifySyncError,
  type NamespaceSyncStatus,
} from "./skillhub-sync-status.js";
import { writeGovernanceAudit } from "./org-governance.js";
import { DEFAULT_ORG_ID } from "./request-context.js";

/** Periodic worker tick interval. 0 = worker disabled (config-absent safe).
 *  Default 5 min; overridable for tests. */
export const SKILL_SYNC_INTERVAL_MS = Number(process.env.SKILL_SYNC_INTERVAL_MS ?? 300_000);

export interface SkillSyncCycleResult {
  /** Number of TEAM targets resolved (mapping-first). */
  targets: number;
  imported: number;
  skipped: number;
  errors: number;
  /** true = Hub unconfigured (SKILLHUB_URL/TOKEN absent) → no-op. */
  disabled: boolean;
  /** true = another cycle is already in flight → no-op. */
  busy?: boolean;
  /** Per-namespace status snapshot (admin view). */
  namespaces: NamespaceSyncStatus[];
}

/** Single-target sync function shape (injectable test seam). */
export type RunOnceFn = (
  namespaceSlug: string,
  orgId: string,
  overrides?: RunSyncOverrides,
) => Promise<{ imported: string[]; skipped: string[]; errors: Array<{ slug: string; reason: string }> }>;

// ── Shared mutual-exclusion lock (periodic worker + admin route) ──────────
// Both paths go through runSkillSyncCycleWith, so a slow periodic cycle and
// an admin-triggered one cannot overlap and double-sync a namespace. Atomic
// claim: set on entry, clear in finally — no double-claim window.
let cycleInFlight = false;

/**
 * Shared-lock core for one Skill sync cycle, with INJECTABLE target list +
 * runOnce (test seams). The mutual-exclusion lock lives here. `targets=[]`
 * or Hub unconfigured → safety no-op (disabled). Never throws — best-effort,
 * nonrollback; per-namespace failures are caught + classified + audited, and
 * do NOT abort the rest of the cycle.
 *
 * Status (metadata-only, categorical errors) is recorded per namespace.
 */
export async function runSkillSyncCycleWith(
  targets: SyncTarget[],
  runOnce: RunOnceFn,
  opts: { hubConfigured: boolean } = { hubConfigured: hubConfigured() },
): Promise<SkillSyncCycleResult> {
  const empty: SkillSyncCycleResult = {
    targets: targets.length, imported: 0, skipped: 0, errors: 0,
    disabled: !opts.hubConfigured || targets.length === 0, namespaces: [],
  };
  if (cycleInFlight) {
    return { ...empty, disabled: true, busy: true };
  }
  cycleInFlight = true;
  try {
    if (!opts.hubConfigured || targets.length === 0) {
      // Safety no-op: no Hub calls, no shared-pool mutation, no entitlement.
      // A disabled cycle still records nothing (no fact to record, matches
      // runSyncOnce's no-op semantics). The next configured cycle records.
      return empty;
    }
    const namespaces: NamespaceSyncStatus[] = [];
    for (const { namespaceSlug, orgId } of targets) {
      try {
        const r = await runOnce(namespaceSlug, orgId);
        const counts = { imported: r.imported.length, skipped: r.skipped.length, errors: r.errors.length };
        const outcome = counts.errors > 0 ? "failure" : "success";
        // Per-skill errors are categorical-ish but bridge already reduces them
        // to a short reason string. For namespace-level status we keep the
        // worst categorical class only when the whole namespace threw (below);
        // per-skill import_failed reasons are already audited by runSyncOnce.
        const status = recordAttempt(namespaceSlug, orgId, outcome as any, counts, null);
        namespaces.push(status);
      } catch (e) {
        // Namespace-level failure (Hub unreachable / 401 / 5xx / network).
        // Classify to a FIXED categorical string; drop the raw error (铁律:
        // no body/token enters status or audit). Record + audit + continue.
        // Count the namespace itself as 1 failure so the aggregate `errors`
        // (and POST /api/admin/hub/sync/run) is NONZERO during outages — a
        // thrown namespace sync is a real failure, not a silent zero.
        const category = classifySyncError(e);
        const status = recordAttempt(
          namespaceSlug, orgId, "failure",
          { imported: 0, skipped: 0, errors: 1 },
          category,
        );
        namespaces.push(status);
        writeGovernanceAudit({
          actorUserId: "system", actorRole: "system", orgId: orgId || DEFAULT_ORG_ID,
          action: "skillhub.namespace_failed", objectType: "skill",
          objectId: namespaceSlug, result: "failure", reasonSummary: category,
        });
      }
    }
    const imported = namespaces.reduce((n, s) => n + s.imported, 0);
    const skipped = namespaces.reduce((n, s) => n + s.skipped, 0);
    const errors = namespaces.reduce((n, s) => n + s.errors, 0);
    return { targets: targets.length, imported, skipped, errors, disabled: false, namespaces };
  } finally {
    cycleInFlight = false;
  }
}

/** Hub is configured iff both URL + TOKEN are present (server-side env/secret). */
export function hubConfigured(): boolean {
  const baseUrl = process.env.SKILLHUB_URL ?? "";
  const token = process.env.SKILLHUB_TOKEN ?? "";
  return Boolean(baseUrl && token);
}

/**
 * Run one Skill sync cycle over the TEAM targets resolved mapping-first
 * (resolveTeamSyncTargets — persistent org_namespace_mappings first, env only
 * as an audited emergency fallback). If Hub unconfigured → safety no-op.
 * Never throws.
 */
export async function runSkillSyncCycle(): Promise<SkillSyncCycleResult> {
  const targets = resolveTeamSyncTargets();
  if (!hubConfigured() || targets.length === 0) {
    return runSkillSyncCycleWith(targets, runSyncOnce, { hubConfigured: false });
  }
  return runSkillSyncCycleWith(targets, runSyncOnce, { hubConfigured: true });
}

// ── Periodic non-overlapping worker (mirrors startMemberSyncWorker) ────────
let workerTimer: NodeJS.Timeout | null = null;

export function startSkillSyncWorker(intervalMs: number = SKILL_SYNC_INTERVAL_MS): void {
  if (workerTimer) return; // idempotent — never start two workers
  if (intervalMs <= 0) return; // 0 = disabled
  workerTimer = setInterval(() => {
    // Lock is inside runSkillSyncCycle; a slow cycle won't stack ticks.
    runSkillSyncCycle().catch(() => { /* best-effort; failures recorded via status + audit */ });
  }, intervalMs);
  if (typeof (workerTimer as any).unref === "function") (workerTimer as any).unref();
}

export function stopSkillSyncWorker(): void {
  if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
}

/** Test-only: expose the shared cycle lock for assertions. */
export function __cycleInFlight(): boolean { return cycleInFlight; }
