/**
 * quota-service.ts — M5 配额、审计与验证闭环 (ACTIVE plan §M5).
 *
 * M1 only WROTE the org_quotas row (all-NULL → "use platform default"). This
 * module is the M5 closure: it resolves an org's effective quota (NULL → platform
 * default), exposes admin read/update, and enforces the four dimensions at the
 * resource-creation touchpoints (create Agent, start runtime, upload file) plus
 * the per-runtime turns cap consumed by capability-provider.resolve().
 *
 * Iron laws (carried from M1/M4):
 *   - orgId is ALWAYS the server-trusted JWT claim (RequestContext.orgId), never
 *     a client-sent value. Callers pass it in; this module does not read request
 *     bodies.
 *   - Quota is a DENY-DEFAULT control-plane gate. It runs AFTER assertOrgActive
 *     (status gate) and BEFORE the resource is created. On denial it writes a
 *     metadata-only `quota.exceeded` audit row (result='denied') — never the
 *     file body, never the incoming payload.
 *   - Platform defaults are conservative; admin may raise per org. NULL columns
 *     mean "use platform default", NOT "unlimited".
 *
 * Storage is tracked per-chat (chat_storage_usage, FK→chats CASCADE) so deletes
 * are accurate and the org total is a cheap SUM join — no filesystem coupling,
 * hermetic-test friendly.
 */
import db from "./database.js";
import { writeGovernanceAudit } from "./org-governance.js";
import type { Role } from "./request-context.js";
import { randomUUID } from "node:crypto";

// ─── Platform defaults ─────────────────────────────────────────────────
// Conservative single-department ceiling. NULL columns resolve to these.
// Admin may raise per org via PUT /api/admin/orgs/:id/quota.
export const PLATFORM_DEFAULT_QUOTAS = {
  maxAgents: 10,
  maxConcurrentRuntimes: 2,
  maxStorageMb: 1024,
  maxTurnsPerRuntime: 100,
  // Stage 1 (token management): monthly per-org token budget + alert %.
  // NULL → these. No cost conversion; tokens are the provider's raw 4 counts
  // (input+output+cacheCreation+cacheRead) summed across result events.
  maxTokensMonthly: 2_000_000,
  tokenAlertThresholdPct: 80,
} as const;

/** The four provider-reported token dimensions. No cost field — we never
 *  fabricate cache pricing (codex Stage 1 boundary). `total` is the plain sum
 *  used for budget comparison (cache reads still count as provider-metered
 *  tokens; if a provider discounts cache, raise later, not now). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  total: number;
}

export interface MonthlyTokenUsage extends TokenUsage {
  /** ISO start-of-month bound used for the SUM (UTC, inclusive). */
  monthStart: string;
  /** Count of result events in the window (≈ turns). */
  turns: number;
}

export type TokenBudgetStatus = "normal" | "near" | "over";

export interface OrgQuota {
  orgId: string;
  maxAgents: number;
  maxConcurrentRuntimes: number;
  maxStorageMb: number;
  maxTurnsPerRuntime: number;
  maxTokensMonthly: number;
  tokenAlertThresholdPct: number;
  /** true if every column was NULL (row exists, admin never configured). */
  isDefault: boolean;
  /** Current usage snapshot (for admin display + enforcement logging). */
  usage: {
    agents: number;
    concurrentRuntimes: number;
    storageBytes: number;
    tokensMonthly: MonthlyTokenUsage;
  };
  /** Token budget status derived from usage.tokensMonthly.total vs the limit
   *  + alert %. normal < threshold% ≤ near < 100% ≤ over. Soft (alert-only,
   *  no hard cap this stage — codex Stage 1 boundary). */
  tokenStatus: TokenBudgetStatus;
}

export type QuotaDimension = "agents" | "concurrentRuntimes" | "storage" | "turns";

/** Thrown when an org is at/over a quota limit. Callers render 429/403 + audit. */
export class QuotaExceededError extends Error {
  constructor(
    public orgId: string,
    public dimension: QuotaDimension,
    public limit: number,
    public current: number
  ) {
    super(
      `Quota exceeded for org "${orgId}": ${dimension} limit ${limit} (current ${current})`
    );
    this.name = "QuotaExceededError";
  }
}

// ─── Prepared statements ────────────────────────────────────────────────
const stmts = {
  getRow: db.prepare(
    `SELECT max_agents, max_concurrent_runtimes, max_storage_mb, max_turns_per_runtime,
            max_tokens_monthly, token_alert_threshold_pct
       FROM org_quotas WHERE org_id = ?`
  ),
  countAgents: db.prepare(
    `SELECT COUNT(*) as c FROM agents WHERE org_id = ? AND status = 'active'`
  ),
  countActiveRuntimes: db.prepare(
    `SELECT COUNT(*) as c
       FROM agent_sessions s
       JOIN chats c ON s.chat_id = c.id
       JOIN users u ON c.user_id = u.id
      WHERE u.org_id = ? AND s.status IN ('running','idle','paused')`
  ),
  countActiveRuntimesExcl: db.prepare(
    `SELECT COUNT(*) as c
       FROM agent_sessions s
       JOIN chats c ON s.chat_id = c.id
       JOIN users u ON c.user_id = u.id
      WHERE u.org_id = ? AND s.status IN ('running','idle','paused') AND s.chat_id <> ?`
  ),
  // M5: org storage = SUM(workspace_files.size_bytes) for the org's chats.
  // Covers BOTH input uploads AND agent-produced output (registerOutput writes
  // the same table). The UPSERT on (chat_id, kind, filename) makes overwrites
  // size-replace-not-accumulate (see file-workspace-service.ts).
  getStorageBytes: db.prepare(
    `SELECT COALESCE(SUM(f.size_bytes), 0) as bytes
       FROM workspace_files f
       JOIN chats c ON f.chat_id = c.id
       JOIN users u ON c.user_id = u.id
      WHERE u.org_id = ?`
  ),
  getInputSize: db.prepare(
    `SELECT size_bytes FROM workspace_files WHERE chat_id = ? AND kind = 'input' AND filename = ?`
  ),
  // Reservation UPSERT — runs INSIDE the storage quota transaction so two
  // concurrent uploads cannot both pass the pre-check. Idempotent on overwrite.
  // M5: the `id` (a per-call random reservation token) is refreshed on conflict
  // (id = excluded.id). The row's PK therefore always reflects the LATEST
  // reservation. releaseReservation deletes by that exact id only — a stale
  // failed-write compensation carries the OLD id, which no longer matches after
  // any overwrite (even a same-size one), so a newer overwrite is never deleted.
  upsertInput: db.prepare(
    `INSERT INTO workspace_files (id, user_id, chat_id, kind, filename, path, mime_type, size_bytes)
     VALUES (?, ?, ?, 'input', ?, ?, ?, ?)
     ON CONFLICT(chat_id, kind, filename) DO UPDATE SET
       id = excluded.id,
       size_bytes = excluded.size_bytes,
       mime_type = excluded.mime_type,
       path = excluded.path`
  ),
  // M5 failure compensation: release a reservation by its exact reservation id.
  // The id is a per-call random token; after any overwrite the row's id was
  // refreshed to the newer reservation's id, so a stale id (from a failed
  // earlier write) won't match — the newer overwrite is preserved. Safe even
  // for same-byte-size overwrites (the case the (id, size_bytes) match missed).
  releaseById: db.prepare(`DELETE FROM workspace_files WHERE id = ?`),
  // Stage 1 (token management): monthly per-org token aggregation. Joins
  // agent_events(result) -> chats.org_id (the org owning the chat at usage
  // time — NOT the user's CURRENT org, so user migration never re-attributes
  // history). Reads the four token dims from the persisted payload_json
  // (session.ts writes `usage.*`). COALESCE per-field so old result rows
  // (pre-Stage-1, no usage) count as 0 rather than NULL-summing the whole row
  // away. Window is [monthStart, nextMonthStart) — exclusive upper bound keeps
  // future-dated rows (clock skew) out of the running month.
  getTokenUsageMonthly: db.prepare(
    `SELECT
        COALESCE(SUM(json_extract(e.payload_json, '$.usage.inputTokens')), 0) AS inputTokens,
        COALESCE(SUM(json_extract(e.payload_json, '$.usage.outputTokens')), 0) AS outputTokens,
        COALESCE(SUM(json_extract(e.payload_json, '$.usage.cacheCreationTokens')), 0) AS cacheCreationTokens,
        COALESCE(SUM(json_extract(e.payload_json, '$.usage.cacheReadTokens')), 0) AS cacheReadTokens,
        COUNT(*) AS turns
       FROM agent_events e
       JOIN chats c ON e.chat_id = c.id
      WHERE c.org_id = ? AND e.event_type = 'result' AND e.created_at >= ? AND e.created_at < ?`
  ),
};

interface QuotaRow {
  max_agents: number | null;
  max_concurrent_runtimes: number | null;
  max_storage_mb: number | null;
  max_turns_per_runtime: number | null;
  max_tokens_monthly: number | null;
  token_alert_threshold_pct: number | null;
}

// ─── Read ───────────────────────────────────────────────────────────────
/** Resolve an org's effective quota (NULL → platform default). If no row exists
 *  at all, returns platform defaults (e.g. the bootstrap default-org before M1
 *  provision, or a freshly referenced org). Never throws for a missing row. */
export function getQuota(orgId: string): OrgQuota {
  const row = stmts.getRow.get(orgId) as QuotaRow | undefined;
  const r = row ?? {
    max_agents: null,
    max_concurrent_runtimes: null,
    max_storage_mb: null,
    max_turns_per_runtime: null,
    max_tokens_monthly: null,
    token_alert_threshold_pct: null,
  };
  const isDefault =
    r.max_agents === null &&
    r.max_concurrent_runtimes === null &&
    r.max_storage_mb === null &&
    r.max_turns_per_runtime === null &&
    r.max_tokens_monthly === null &&
    r.token_alert_threshold_pct === null;
  const maxTokensMonthly = r.max_tokens_monthly ?? PLATFORM_DEFAULT_QUOTAS.maxTokensMonthly;
  const tokenAlertThresholdPct =
    r.token_alert_threshold_pct ?? PLATFORM_DEFAULT_QUOTAS.tokenAlertThresholdPct;
  const tokensMonthly = getTokenUsageMonthly(orgId);
  return {
    orgId,
    maxAgents: r.max_agents ?? PLATFORM_DEFAULT_QUOTAS.maxAgents,
    maxConcurrentRuntimes: r.max_concurrent_runtimes ?? PLATFORM_DEFAULT_QUOTAS.maxConcurrentRuntimes,
    maxStorageMb: r.max_storage_mb ?? PLATFORM_DEFAULT_QUOTAS.maxStorageMb,
    maxTurnsPerRuntime: r.max_turns_per_runtime ?? PLATFORM_DEFAULT_QUOTAS.maxTurnsPerRuntime,
    maxTokensMonthly,
    tokenAlertThresholdPct,
    isDefault,
    usage: {
      agents: countAgentsByOrg(orgId),
      concurrentRuntimes: countActiveRuntimesByOrg(orgId),
      storageBytes: getStorageUsageBytes(orgId),
      tokensMonthly,
    },
    tokenStatus: tokenBudgetStatus(tokensMonthly.total, maxTokensMonthly, tokenAlertThresholdPct),
  };
}

// ─── Usage counters ─────────────────────────────────────────────────────
export function countAgentsByOrg(orgId: string): number {
  return (stmts.countAgents.get(orgId) as { c: number }).c;
}
/**
 * Count active runtimes for an org. `excludeChatId` excludes the target chat's
 * own persisted session — a warm reconnect / cold resume of an already-active
 * runtime does NOT acquire a new slot, so it must not be double-counted against
 * maxConcurrentRuntimes. The caller passes the chatId being resumed; a fresh
 * start (no existing row) passes undefined.
 */
export function countActiveRuntimesByOrg(orgId: string, excludeChatId?: string): number {
  const row = excludeChatId
    ? (stmts.countActiveRuntimesExcl.get(orgId, excludeChatId) as { c: number })
    : (stmts.countActiveRuntimes.get(orgId) as { c: number });
  return row.c;
}
export function getStorageUsageBytes(orgId: string): number {
  return (stmts.getStorageBytes.get(orgId) as { bytes: number }).bytes;
}

// ─── Stage 1: token usage / monthly budget / alert ─────────────────────
/** UTC start-of-month (inclusive lower bound) as ISO, e.g. "2026-08-01T00:00:00.000Z". */
export function monthStartUTC(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** UTC start-of-NEXT-month (exclusive upper bound) as ISO. */
export function monthEndExclusiveUTC(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Safe integer coercion for SQLite aggregates. NO bitwise `| 0` — that
 *  truncates to 32-bit signed and a monthly org sum can legitimately exceed
 *  2^31 tokens; better-sqlite3 returns doubles up to 2^53, keep them. */
function toCount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Monthly token usage for an org (current UTC month, [start, nextStart) —
 *  future-dated rows are EXCLUDED, not lumped into the running month): the 4
 *  provider dims + total + turn count, aggregated from persisted result-event
 *  payloads. Org attribution is by chats.org_id (the org that owns the chat
 *  when the usage happens) — NOT the user's CURRENT users.org_id, so a user
 *  migrating orgs does not drag historical usage across org boundaries.
 *  Old result rows without usage count as 0 tokens but still count a turn. */
export function getTokenUsageMonthly(orgId: string, now: Date = new Date()): MonthlyTokenUsage {
  const monthStart = monthStartUTC(now);
  const monthEnd = monthEndExclusiveUTC(now);
  const r = stmts.getTokenUsageMonthly.get(orgId, monthStart, monthEnd) as {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    turns: number;
  };
  const inputTokens = toCount(r.inputTokens);
  const outputTokens = toCount(r.outputTokens);
  const cacheCreationTokens = toCount(r.cacheCreationTokens);
  const cacheReadTokens = toCount(r.cacheReadTokens);
  return {
    monthStart,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    total: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    turns: toCount(r.turns),
  };
}

/** Derive the console status from a token total. normal < threshold% ≤ near
 *  < 100% ≤ over. thresholdPct is clamped to (0, 100] so a misconfigured 0 or
 *  negative can never make "near" unreachable / fire on every turn. */
export function tokenBudgetStatus(total: number, limit: number, thresholdPct: number): TokenBudgetStatus {
  if (limit <= 0) return "over"; // budget 0 = nothing allowed (still soft: alert-only)
  const pct = Math.min(100, Math.max(1, thresholdPct));
  if (total >= limit) return "over";
  if (total >= Math.floor((limit * pct) / 100)) return "near";
  return "normal";
}

export interface TokenTurnResult {
  status: TokenBudgetStatus;
  total: number;
  limit: number;
  thresholdPct: number;
}

/**
 * Record one turn's token delta against the org's monthly budget and write a
 * metadata-only governance audit ON ESCALATION ONLY (normal→near, →over).
 * Called by session.ts AFTER the result event is persisted, so the monthly SUM
 * already includes this turn; the "before" total is derived by subtracting the
 * delta — no persistent transition state, no per-turn audit spam.
 *
 * SOFT (Stage 1 boundary, codex-agreed): no hard cap, no turn admission guard;
 * "over" alerts (`quota.token.over`, result=success — nothing was denied),
 * unlike the hard-cap `quota.exceeded`/denied rows other dimensions write.
 * Never throws — an alerting failure must not break the agent turn.
 */
export function evaluateTokenTurn(
  orgId: string,
  delta: TokenUsage,
  audit?: QuotaAuditMeta,
  now: Date = new Date()
): TokenTurnResult {
  try {
    const q = getQuota(orgId);
    const after = getTokenUsageMonthly(orgId, now);
    const beforeTotal = Math.max(0, after.total - delta.total);
    const status = tokenBudgetStatus(after.total, q.maxTokensMonthly, q.tokenAlertThresholdPct);
    const before = tokenBudgetStatus(beforeTotal, q.maxTokensMonthly, q.tokenAlertThresholdPct);
    if (status !== before && status !== "normal") {
      const near = status === "near";
      writeGovernanceAudit({
        actorUserId: audit?.actorUserId ?? null,
        actorRole: audit?.actorRole ?? "system",
        orgId,
        action: near ? "quota.token.near" : "quota.token.over",
        objectType: "quota",
        objectId: "tokens",
        result: "success",
        reasonSummary: near
          ? `monthly token budget near threshold (${after.total}/${q.maxTokensMonthly}, ${q.tokenAlertThresholdPct}%)`
          : `monthly token budget exceeded (${after.total}/${q.maxTokensMonthly})`,
        requestId: audit?.requestId ?? null,
        traceId: audit?.traceId ?? null,
      });
    }
    return { status, total: after.total, limit: q.maxTokensMonthly, thresholdPct: q.tokenAlertThresholdPct };
  } catch (e) {
    // Alerting is best-effort; a broken read must never fail the agent turn.
    console.warn("[quota-service] evaluateTokenTurn failed:", e instanceof Error ? e.message : e);
    return { status: "normal", total: 0, limit: 0, thresholdPct: 0 };
  }
}

// ─── Update (admin only) ────────────────────────────────────────────────
export interface QuotaPatch {
  maxAgents?: number;
  maxConcurrentRuntimes?: number;
  maxStorageMb?: number;
  maxTurnsPerRuntime?: number;
  maxTokensMonthly?: number;
  tokenAlertThresholdPct?: number;
}

const BOUNDS: Record<keyof QuotaPatch, [number, number]> = {
  maxAgents: [0, 100000],
  maxConcurrentRuntimes: [0, 100000],
  maxStorageMb: [1, 10_000_000],
  maxTurnsPerRuntime: [1, 10_000_000],
  maxTokensMonthly: [0, 1_000_000_000_000],
  tokenAlertThresholdPct: [1, 100],
};

/** Validate a patch value against per-field bounds. Throws on out-of-range. */
export function validateQuotaPatch(patch: QuotaPatch): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const [lo, hi] = BOUNDS[k as keyof QuotaPatch];
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`Invalid quota value for ${k}: ${v} (must be integer in [${lo}, ${hi}])`);
    }
  }
}

/**
 * Merge a partial patch into the existing row (NULL columns keep their default
 * semantics until explicitly set). Resolved numbers are clamped to >= 0. Runs
 * in one transaction so a concurrent enforcement read never sees a half patch.
 */
export function setQuota(orgId: string, patch: QuotaPatch): OrgQuota {
  validateQuotaPatch(patch);
  const txn = db.transaction(() => {
    const existing = (stmts.getRow.get(orgId) as QuotaRow | undefined) ?? {
      max_agents: null,
      max_concurrent_runtimes: null,
      max_storage_mb: null,
      max_turns_per_runtime: null,
      max_tokens_monthly: null,
      token_alert_threshold_pct: null,
    };
    const merged: QuotaRow = {
      max_agents: patch.maxAgents ?? existing.max_agents,
      max_concurrent_runtimes: patch.maxConcurrentRuntimes ?? existing.max_concurrent_runtimes,
      max_storage_mb: patch.maxStorageMb ?? existing.max_storage_mb,
      max_turns_per_runtime: patch.maxTurnsPerRuntime ?? existing.max_turns_per_runtime,
      max_tokens_monthly: patch.maxTokensMonthly ?? existing.max_tokens_monthly,
      token_alert_threshold_pct: patch.tokenAlertThresholdPct ?? existing.token_alert_threshold_pct,
    };
    db.prepare(
      `INSERT INTO org_quotas (org_id, max_agents, max_concurrent_runtimes, max_storage_mb, max_turns_per_runtime, max_tokens_monthly, token_alert_threshold_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           max_agents=excluded.max_agents,
           max_concurrent_runtimes=excluded.max_concurrent_runtimes,
           max_storage_mb=excluded.max_storage_mb,
           max_turns_per_runtime=excluded.max_turns_per_runtime,
           max_tokens_monthly=excluded.max_tokens_monthly,
           token_alert_threshold_pct=excluded.token_alert_threshold_pct,
           updated_at=datetime('now')`
    ).run(orgId, merged.max_agents, merged.max_concurrent_runtimes, merged.max_storage_mb, merged.max_turns_per_runtime, merged.max_tokens_monthly, merged.token_alert_threshold_pct);
  });
  txn();
  return getQuota(orgId);
}

// ─── Enforcement ────────────────────────────────────────────────────────
export interface QuotaAuditMeta {
  actorUserId?: string | null;
  actorRole?: Role | "system" | null;
  requestId?: string | null;
  traceId?: string | null;
}

/**
 * Assert `orgId` is under its limit for `dimension`. Throws QuotaExceededError
 * (caller renders 429/413) AND writes a metadata-only `quota.exceeded` audit.
 *
 * `excludeChatId` (concurrentRuntimes): excludes the target chat's own
 * persisted session so a warm reconnect / cold resume of an ALREADY-active
 * runtime is not double-counted. A fresh start passes undefined.
 *
 * Storage has its own transactional method `assertStorageQuota` (overwrite
 * delta + concurrent-upload serialization) — do NOT use this for storage.
 * Callers MUST have already passed assertOrgActive (status gate).
 */
export function assertQuota(
  orgId: string,
  dimension: Exclude<QuotaDimension, "storage">,
  opts: { excludeChatId?: string; audit?: QuotaAuditMeta } = {}
): void {
  const q = getQuota(orgId);
  let limit: number;
  let current: number;
  let next: number;
  switch (dimension) {
    case "agents":
      limit = q.maxAgents;
      current = q.usage.agents;
      next = current + 1; // this creation would add one active agent
      break;
    case "concurrentRuntimes":
      limit = q.maxConcurrentRuntimes;
      // Exclude the chat being resumed — it does not acquire a new slot. A
      // fresh start (excludeChatId undefined) counts the full active set.
      current = countActiveRuntimesByOrg(orgId, opts.excludeChatId);
      next = current + 1;
      break;
    case "turns":
      // turns is enforced at runtime creation via capability-provider capping;
      // no-op assertion kept for symmetry/testing.
      return;
  }
  if (next > limit) {
    writeGovernanceAudit({
      actorUserId: opts.audit?.actorUserId ?? null,
      actorRole: opts.audit?.actorRole ?? null,
      orgId,
      action: `quota.exceeded`,
      objectType: "quota",
      objectId: dimension,
      result: "denied",
      reasonSummary: `${dimension} limit ${limit} reached (current ${current})`,
      requestId: opts.audit?.requestId ?? null,
      traceId: opts.audit?.traceId ?? null,
    });
    throw new QuotaExceededError(orgId, dimension, limit, current);
  }
}

/**
 * M5 storage quota — transactional, overwrite-aware, concurrent-safe.
 *
 * Runs in ONE better-sqlite3 transaction (single writer → serialized):
 *   1. read the existing registered size of (chatId, filename) — overwrite
 *      returns delta = incoming - old, NOT a full add (fixes the overwrite bug).
 *   2. read the org's current storage total (SUM(workspace_files) — covers
 *      input + agent-produced output via registerOutput).
 *   3. if `enforce` and (orgTotal - old + incoming) > maxStorageMb: audit
 *      (denied) + throw. admin path passes enforce=false (still reserves the
 *      row for accounting; cross-org super-user is exempt from the ceiling).
 *   4. UPSERT the reservation row (size = incoming) so a concurrent upload T2
 *      sees the new total when it runs its own check.
 *
 * Returns the reserved FileRecord. The actual fs/volume write happens AFTER
 * this returns (in the upload route via writeInputFile); if it fails the
 * registry over-counts — a safe ceiling, reconciled on the next overwrite.
 */
export interface ReservedFileRecord {
  id: string;
  userId: string;
  chatId: string;
  kind: "input";
  filename: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
}

export function assertStorageQuota(
  orgId: string,
  chatId: string,
  filename: string,
  incomingBytes: number,
  userId: string,
  mimeType: string | null,
  opts: { enforce?: boolean; audit?: QuotaAuditMeta } = {}
): ReservedFileRecord {
  const safeName = filename.replace(/[^a-zA-Z0-9._\-]/g, "_");
  const containerPath = `/workspace/input/${safeName}`;
  // M5: a per-call random reservation id. The UPSERT refreshes `id` on conflict,
  // so the row's PK always reflects the LATEST reservation. The upload route
  // passes this id to releaseReservation on fs-write failure; a stale id (from
  // a failed earlier write) won't match after any overwrite, so a newer
  // overwrite — even a same-byte-size one — is never deleted.
  const reservationId = `wfr-${randomUUID()}`;
  const enforce = opts.enforce !== false; // default true; admin passes false
  const limit = getQuota(orgId).maxStorageMb * 1024 * 1024;
  const txn = db.transaction(() => {
    const oldRow = stmts.getInputSize.get(chatId, safeName) as { size_bytes: number } | undefined;
    const oldSize = oldRow?.size_bytes ?? 0;
    const orgTotal = (stmts.getStorageBytes.get(orgId) as { bytes: number }).bytes;
    // Subtract the file's OLD size (it will be replaced), add the new size.
    const next = orgTotal - oldSize + incomingBytes;
    if (enforce && next > limit) {
      writeGovernanceAudit({
        actorUserId: opts.audit?.actorUserId ?? null,
        actorRole: opts.audit?.actorRole ?? null,
        orgId,
        action: `quota.exceeded`,
        objectType: "quota",
        objectId: "storage",
        result: "denied",
        reasonSummary: `storage limit ${limit} bytes reached (org ${orgTotal}, file old ${oldSize}, incoming ${incomingBytes})`,
        requestId: opts.audit?.requestId ?? null,
        traceId: opts.audit?.traceId ?? null,
      });
      throw new QuotaExceededError(orgId, "storage", limit, orgTotal);
    }
    // Reserve — UPSERT so concurrent T2's orgTotal reflects this file's new
    // size. The id is refreshed on conflict so the row carries THIS call's
    // reservation identity (used for exact-id release on failure).
    stmts.upsertInput.run(reservationId, userId, chatId, safeName, containerPath, mimeType, incomingBytes);
  });
  txn();
  return {
    id: reservationId,
    userId,
    chatId,
    kind: "input",
    filename: safeName,
    path: containerPath,
    mimeType,
    sizeBytes: incomingBytes,
    createdAt: new Date().toISOString(),
  };
}

/**
 * M5 failure compensation — release a reservation by its exact reservation id.
 * Called by the upload route when `writeInputFile` throws: the DB reservation
 * was committed but no file was stored, so a phantom row would otherwise
 * permanently consume quota. The id is a per-call random token; the UPSERT in
 * assertStorageQuota refreshes `id` on conflict, so after any overwrite the
 * row's id is the NEWER reservation's id. A stale id (from a failed earlier
 * write) therefore won't match — the newer overwrite is preserved, including
 * the same-byte-size case the previous (id, size_bytes) match missed. No-op
 * if the row was already replaced. Runs in one transaction.
 */
export function releaseReservation(reservationId: string): void {
  const txn = db.transaction(() => {
    stmts.releaseById.run(reservationId);
  });
  txn();
}
