/**
 * skillhub-sync-status.ts — R5d-1 namespace-level Skill sync status.
 *
 * Closes codex R5d-1 directive §3: a namespace-level sync state store with
 * lastAttemptAt / lastSuccessAt / result / counts + CATEGORICAL errors only.
 *
 * metadata-only铁律 (same as governance_audit_log): NO raw error body, NO
 * token, NO Hub response payload is ever persisted here — errors are reduced
 * to a fixed categorical string (hub_unreachable | unauthorized | forbidden
 * | http_4xx | http_5xx | network | unknown). The raw Hub error is consumed
 * only in-memory inside the worker to classify, then dropped.
 *
 * Scoping (§3): admin sees all namespaces; org_admin sees ONLY namespaces whose
 * persistent mapping points at their own org. A cross-dept namespace is simply
 * absent from the list — no existence leak (404-style deny, like the M3 member-
 * tasks scoping). The namespace→org binding comes from org_namespace_mappings
 * (the persistent active mapping), so scoping follows the mapping, not a guess.
 *
 * Storage: sidecar JSON (data/skill-sync-status.json) — NO database, mirrors
 * the runtime-settings.ts pattern. SKILL_SYNC_STATUS_FILE overrides the path
 * for hermetic tests.
 */
import fs from "node:fs";
import path from "node:path";
import { orgNamespaceMappingService } from "./org-namespace-mapping.js";

export type SyncOutcome = "success" | "failure" | "disabled" | "busy";

export interface NamespaceSyncStatus {
  namespaceSlug: string;
  /** Owning org from the persistent mapping; "" for @global (admin-only). */
  orgId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastResult: SyncOutcome | null;
  imported: number;
  skipped: number;
  errors: number;
  /** Fixed categorical string; NEVER raw error/body/token. */
  errorCategory: string | null;
  updatedAt: string;
}

export interface SyncStatusScope {
  requesterRole: string;
  requesterOrgId: string;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const DEFAULT_FILE = path.resolve(DATA_DIR, "skill-sync-status.json");
const STATUS_FILE = process.env.SKILL_SYNC_STATUS_FILE ?? DEFAULT_FILE;

function load(): Record<string, NamespaceSyncStatus> {
  try {
    const raw = fs.readFileSync(STATUS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(store: Record<string, NamespaceSyncStatus>): void {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(store, null, 2) + "\n");
  } catch {
    // best-effort: status persistence must never break sync or boot.
  }
}

/**
 * Record one namespace sync attempt. `errorCategory` MUST be a fixed
 * categorical string from classifySyncError — never a raw message/body/token.
 */
export function recordAttempt(
  namespaceSlug: string,
  orgId: string,
  outcome: SyncOutcome,
  counts: { imported: number; skipped: number; errors: number },
  errorCategory: string | null,
): NamespaceSyncStatus {
  const store = load();
  const now = new Date().toISOString();
  const prev = store[namespaceSlug];
  const next: NamespaceSyncStatus = {
    namespaceSlug,
    orgId,
    lastAttemptAt: now,
    lastSuccessAt: outcome === "success" ? now : prev?.lastSuccessAt ?? null,
    lastResult: outcome,
    imported: counts.imported,
    skipped: counts.skipped,
    errors: counts.errors,
    errorCategory: outcome === "failure" ? errorCategory : null,
    updatedAt: now,
  };
  store[namespaceSlug] = next;
  save(store);
  return next;
}

/** Internal: read raw status by namespace (no scoping). */
function getRaw(namespaceSlug: string): NamespaceSyncStatus | null {
  return load()[namespaceSlug] ?? null;
}

/**
 * Scoped single-namespace read. org_admin → own-org only; cross-org → null
 * (no existence leak). admin → any.
 */
export function getStatusForScope(
  namespaceSlug: string,
  scope: SyncStatusScope,
): NamespaceSyncStatus | null {
  const status = getRaw(namespaceSlug);
  if (!status) return null;
  if (!visibleForScope(status, scope)) return null;
  // Strip orgId for org_admin? No — own-org is already their own; keep it.
  return status;
}

/**
 * Scoped list. admin → all; org_admin → only namespaces whose mapping points
 * at their own org (cross-dept absent, no leak). Unmapped namespaces are
 * admin-only (an org_admin has no claim on a namespace with no mapping).
 */
export function listStatusForScope(scope: SyncStatusScope): NamespaceSyncStatus[] {
  const store = load();
  return Object.values(store)
    .filter((s) => visibleForScope(s, scope))
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}

function visibleForScope(status: NamespaceSyncStatus, scope: SyncStatusScope): boolean {
  if (scope.requesterRole === "admin") return true;
  // org_admin: only namespaces whose persistent mapping points at their org.
  if (scope.requesterRole === "org_admin") {
    if (!status.orgId) return false; // @global / unmapped → admin-only
    return status.orgId === scope.requesterOrgId;
  }
  return false; // plain user → nothing
}

/** Test/ops: clear the status store (does NOT touch mappings or audit). */
export function clearStatusStore(): void {
  save({});
}

/**
 * Classify a Hub/network error to a FIXED categorical string. Never returns
 * the raw message. Used by the worker before recording status — the raw error
 * is dropped after classification (metadata-only铁律).
 */
export function classifySyncError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number } | null)?.status;
  const code = (e as { code?: string } | null)?.code;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status && status >= 400 && status < 500) return "http_4xx";
  if (status && status >= 500) return "http_5xx";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT") return "network";
  if (/unauthorized|401/i.test(msg)) return "unauthorized";
  if (/forbidden|403/i.test(msg)) return "forbidden";
  if (/network|econnrefused|enotfound|timeout|fetch failed|socket hang up/i.test(msg)) return "network";
  return "unknown";
}
