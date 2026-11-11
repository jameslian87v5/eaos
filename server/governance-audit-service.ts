/**
 * governance-audit-service.ts — M5 query/export/retention for the metadata-only
 * governance_audit_log sink (ACTIVE plan §M5).
 *
 * M1/M4 only WROTE rows (org/user/resource lifecycle + quota.exceeded from M5).
 * This module adds the read side: paginated org-scoped query, CSV/JSON export,
 * and the 180-day retention purge.
 *
 * Iron laws:
 *   - orgId scoping is enforced by the caller (admin = unscoped/all; org_admin
 *     = own-org only). This service takes a pre-resolved `orgId | null` filter
 *     and never trusts a client-sent orgId.
 *   - Rows are metadata-only by schema (no body/payload column). Export emits
 *     exactly the stored columns — never an attempt to join in chat/file body.
 */
import db from "./database.js";

export interface AuditQueryFilter {
  orgId?: string | null; // null/undefined = admin unscoped (all orgs)
  action?: string | null; // e.g. "org.provision" or "quota.exceeded"
  result?: "success" | "failure" | "denied" | null;
  from?: string | null; // ISO date lower bound (inclusive)
  to?: string | null; // ISO date upper bound (inclusive)
  limit: number;
  offset: number;
}

export interface AuditRow {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  orgId: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  fromOrgId: string | null;
  toOrgId: string | null;
  result: string;
  reasonSummary: string | null;
  requestId: string | null;
  traceId: string | null;
  createdAt: string;
}

export interface AuditQueryResult {
  rows: AuditRow[];
  total: number;
  hasMore: boolean;
}

function buildWhere(filter: AuditQueryFilter): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.orgId) {
    clauses.push(`org_id = ?`);
    params.push(filter.orgId);
  }
  if (filter.action) {
    clauses.push(`action = ?`);
    params.push(filter.action);
  }
  if (filter.result) {
    clauses.push(`result = ?`);
    params.push(filter.result);
  }
  if (filter.from) {
    clauses.push(`created_at >= ?`);
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push(`created_at <= ?`);
    params.push(filter.to);
  }
  return { clauses, params };
}

const SELECT_COLS = `id, actor_user_id, actor_role, org_id, action, object_type, object_id,
       from_org_id, to_org_id, result, reason_summary, request_id, trace_id, created_at`;

function mapRow(r: any): AuditRow {
  return {
    id: r.id,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    orgId: r.org_id,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    fromOrgId: r.from_org_id,
    toOrgId: r.to_org_id,
    result: r.result,
    reasonSummary: r.reason_summary,
    requestId: r.request_id,
    traceId: r.trace_id,
    createdAt: r.created_at,
  };
}

/** Paginated, filtered audit query. `total` is the unfiltered-count-for-this-
 *  filter (for UI pagination), `hasMore` signals another page exists. */
export function queryGovernanceAudit(filter: AuditQueryFilter): AuditQueryResult {
  const { clauses, params } = buildWhere(filter);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, filter.limit));
  const offset = Math.max(0, filter.offset);
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM governance_audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as any[];
  const totalRow = db
    .prepare(`SELECT COUNT(*) as c FROM governance_audit_log ${where}`)
    .get(...params) as { c: number };
  return {
    rows: rows.map(mapRow),
    total: totalRow.c,
    hasMore: offset + rows.length < totalRow.c,
  };
}

// ─── Export ─────────────────────────────────────────────────────────────
/** CSV (RFC 4180-ish, comma + double-quote escaping) or JSON dump of the SAME
 *  metadata-only columns. Capped at 10000 rows to bound a single export. */
export function exportGovernanceAudit(
  format: "csv" | "json",
  filter: Omit<AuditQueryFilter, "limit" | "offset">
): { contentType: string; body: string; filename: string } {
  const { clauses, params } = buildWhere({ ...filter, limit: 10000, offset: 0 });
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM governance_audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT 10000`)
    .all(...params) as any[];
  const mapped = rows.map(mapRow);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      filename: `governance-audit-${stamp}.json`,
      body: JSON.stringify(mapped, null, 2),
    };
  }
  const cols = [
    "id","createdAt","actorUserId","actorRole","orgId","action","objectType",
    "objectId","fromOrgId","toOrgId","result","reasonSummary","requestId","traceId",
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(","), ...mapped.map((r) => cols.map((c) => esc((r as any)[c])).join(","))];
  return {
    contentType: "text/csv; charset=utf-8",
    filename: `governance-audit-${stamp}.csv`,
    body: lines.join("\n"),
  };
}

// ─── Retention ──────────────────────────────────────────────────────────
/** Purge audit rows older than `days` (default 180 per design §7). Called at
 *  boot + available via admin route. Returns the number of rows deleted. */
export function purgeOldAudit(days: number = 180): number {
  const result = db
    .prepare(`DELETE FROM governance_audit_log WHERE created_at < datetime('now', ?)`)
    .run(`-${Math.max(1, days)} days`);
  return result.changes;
}
