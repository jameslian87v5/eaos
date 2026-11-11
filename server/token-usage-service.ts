/**
 * token-usage-service.ts — M3 (docs/开发计划/model-and-token-management-plan.md §7 org_admin
 * Token 明细, §8.2 Token 归因).
 *
 * Read-only aggregation over the EXISTING result-event stream (agent_events,
 * event_type='result', payload_json.$.usage.{input,output,cacheCreation,
 * cacheRead} — written by session.ts since Stage 1). No new tables, no price/
 * billing fields (§8.2: "本阶段不记录价格").
 *
 * Org attribution = chats.org_id (the org owning the chat at usage time — same
 * rule as quota-service.getTokenUsageMonthly, so a user migrating orgs never
 * drags history across org boundaries). The caller passes the orgId it already
 * verified against the JWT claim; path params can never widen scope.
 *
 * Pagination + date range (from/to, inclusive YYYY-MM-DD, UTC). groupBy ∈
 * day | user | agent | chat (chatId == agentId bridge: "agent" groups by the
 * agents.name label, "chat" by chats.title).
 */

import db from "./database.js";
import { getQuota } from "./quota-service.js";

export type TokenUsageGroupBy = "day" | "user" | "agent" | "chat";

export interface TokenUsageQuery {
  orgId: string;
  from?: string | null; // YYYY-MM-DD inclusive
  to?: string | null;   // YYYY-MM-DD inclusive (converted to exclusive upper)
  groupBy: TokenUsageGroupBy;
  userId?: string | null; // drill-down filter
  chatId?: string | null; // drill-down filter
  limit: number;
  offset: number;
}

export interface TokenUsageDims {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  total: number;
  turns: number;
}

export interface TokenUsageGroup extends TokenUsageDims {
  /** Stable grouping key (day string / user id / chat id). */
  key: string;
  /** Human label (username, agent name, chat title; day key as-is). */
  label: string;
}

export interface TokenUsageResult {
  items: TokenUsageGroup[];
  totals: TokenUsageDims;
  /** Total number of groups matching the filter (for pagination). */
  groups: number;
  limit: number;
  offset: number;
  groupBy: TokenUsageGroupBy;
}

export interface OrgTokenBudgetView {
  /** Effective monthly limit (platform default when the org row is NULL). */
  limit: number;
  thresholdPct: number;
  /** Current UTC month usage (the budget window — independent of the page's
   *  arbitrary date range, so the card always answers "this month's budget"). */
  used: number;
  remaining: number;
  status: "normal" | "near" | "over";
  monthStart: string;
  usage: TokenUsageDims;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Fixed group definitions — no caller-controlled SQL fragments reach the query.
const GROUP_DEFS: Record<
  TokenUsageGroupBy,
  { keyExpr: string; labelExpr: string; extraJoin: string }
> = {
  day: {
    keyExpr: `date(e.created_at)`,
    labelExpr: `date(e.created_at)`,
    extraJoin: ``,
  },
  user: {
    keyExpr: `e.user_id`,
    labelExpr: `COALESCE(u.display_name, u.username, e.user_id)`,
    extraJoin: `LEFT JOIN users u ON u.id = e.user_id`,
  },
  agent: {
    keyExpr: `e.chat_id`, // agents.id === chats.id compatibility bridge
    labelExpr: `COALESCE(a.name, e.chat_id)`,
    extraJoin: `LEFT JOIN agents a ON a.id = e.chat_id`,
  },
  chat: {
    keyExpr: `e.chat_id`,
    labelExpr: `COALESCE(c2.title, e.chat_id)`,
    extraJoin: `LEFT JOIN chats c2 ON c2.id = e.chat_id`,
  },
};

/** Safe integer coercion for SQLite aggregates (same rule as quota-service:
 *  no bitwise |0 — a monthly sum can legitimately exceed 2^31). */
function toCount(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

const DIMS_SQL = `
  COALESCE(SUM(json_extract(e.payload_json, '$.usage.inputTokens')), 0) AS inputTokens,
  COALESCE(SUM(json_extract(e.payload_json, '$.usage.outputTokens')), 0) AS outputTokens,
  COALESCE(SUM(json_extract(e.payload_json, '$.usage.cacheCreationTokens')), 0) AS cacheCreationTokens,
  COALESCE(SUM(json_extract(e.payload_json, '$.usage.cacheReadTokens')), 0) AS cacheReadTokens,
  COUNT(*) AS turns
`;

function buildWhere(q: TokenUsageQuery): { clause: string; params: Record<string, string> } {
  const params: Record<string, string> = { orgId: q.orgId };
  const clauses = [`c.org_id = @orgId`, `e.event_type = 'result'`];
  if (q.from != null) {
    if (!DATE_RE.test(q.from)) throw new Error(`Invalid from "${q.from}" (expected YYYY-MM-DD)`);
    clauses.push(`e.created_at >= @from`);
    params.from = q.from;
  }
  if (q.to != null) {
    if (!DATE_RE.test(q.to)) throw new Error(`Invalid to "${q.to}" (expected YYYY-MM-DD)`);
    // Inclusive end date → exclusive upper bound (created_at is UTC "YYYY-MM-DD HH:MM:SS").
    clauses.push(`e.created_at < date(@to, '+1 day')`);
    params.to = q.to;
  }
  if (q.userId) {
    clauses.push(`e.user_id = @userId`);
    params.userId = q.userId;
  }
  if (q.chatId) {
    clauses.push(`e.chat_id = @chatId`);
    params.chatId = q.chatId;
  }
  return { clause: clauses.join(" AND "), params };
}

export function queryTokenUsage(q: TokenUsageQuery): TokenUsageResult {
  const g = GROUP_DEFS[q.groupBy];
  const { clause, params } = buildWhere(q);
  const limit = Math.min(Math.max(Math.trunc(q.limit) || 50, 1), 200);
  const offset = Math.max(Math.trunc(q.offset) || 0, 0);

  const base = `
    FROM agent_events e
    JOIN chats c ON e.chat_id = c.id
    ${g.extraJoin}
    WHERE ${clause}
  `;

  const items = (
    db.prepare(
      `SELECT ${g.keyExpr} AS key, ${g.labelExpr} AS label, ${DIMS_SQL}
       ${base}
       GROUP BY ${g.keyExpr}
       ORDER BY ${q.groupBy === "day" ? "key DESC" : "turns DESC, key ASC"}
       LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset }) as Array<Record<string, unknown>>
  ).map((r) => ({
    key: String(r.key ?? ""),
    label: String(r.label ?? r.key ?? ""),
    inputTokens: toCount(r.inputTokens),
    outputTokens: toCount(r.outputTokens),
    cacheCreationTokens: toCount(r.cacheCreationTokens),
    cacheReadTokens: toCount(r.cacheReadTokens),
    total:
      toCount(r.inputTokens) + toCount(r.outputTokens) +
      toCount(r.cacheCreationTokens) + toCount(r.cacheReadTokens),
    turns: toCount(r.turns),
  }));

  const totalsRow = db.prepare(`SELECT ${DIMS_SQL} ${base}`).get(params) as Record<string, unknown>;
  const inputTokens = toCount(totalsRow.inputTokens);
  const outputTokens = toCount(totalsRow.outputTokens);
  const cacheCreationTokens = toCount(totalsRow.cacheCreationTokens);
  const cacheReadTokens = toCount(totalsRow.cacheReadTokens);

  const groups = toCount(
    (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT ${g.keyExpr} AS k ${base} GROUP BY ${g.keyExpr})`)
      .get(params) as { n: number }).n
  );

  return {
    items,
    totals: {
      inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
      total: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      turns: toCount(totalsRow.turns),
    },
    groups,
    limit,
    offset,
    groupBy: q.groupBy,
  };
}

/** Budget card for the CURRENT UTC month (window is monthly by definition —
 *  the page's date range only affects the aggregation table). */
export function getOrgTokenBudget(orgId: string): OrgTokenBudgetView {
  const quota = getQuota(orgId);
  const m = quota.usage.tokensMonthly;
  return {
    limit: quota.maxTokensMonthly,
    thresholdPct: quota.tokenAlertThresholdPct,
    used: m.total,
    remaining: Math.max(0, quota.maxTokensMonthly - m.total),
    status: quota.tokenStatus,
    monthStart: m.monthStart,
    usage: {
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheCreationTokens: m.cacheCreationTokens,
      cacheReadTokens: m.cacheReadTokens,
      total: m.total,
      turns: m.turns,
    },
  };
}

// ─── M4 (plan §4.2): per-chat context visibility ──────────────────────────
// Feeds GET /api/chats/:chatId/context (the Chat header status chip). The
// caller has ALREADY run ownership verification — the orgId/chatId pair here
// is server-trusted; the org join is kept anyway as cheap defense-in-depth.

export interface ChatUsageStats {
  /** Cumulative over this chat's recorded result events. */
  usage: TokenUsageDims;
  /** Input-side tokens of the LAST result carrying usage (the §4.2 context
   *  estimate). Null when the chat has no usage-bearing results yet. */
  lastResultEstimateTokens: number | null;
}

export function getChatUsageStats(orgId: string, chatId: string): ChatUsageStats {
  const totalsRow = db.prepare(`
    SELECT ${DIMS_SQL}
    FROM agent_events e
    JOIN chats c ON e.chat_id = c.id
    WHERE c.org_id = @orgId AND e.chat_id = @chatId AND e.event_type = 'result'
  `).get({ orgId, chatId }) as Record<string, unknown>;

  const lastRow = db.prepare(`
    SELECT
      COALESCE(json_extract(e.payload_json, '$.usage.inputTokens'), 0)
      + COALESCE(json_extract(e.payload_json, '$.usage.cacheCreationTokens'), 0)
      + COALESCE(json_extract(e.payload_json, '$.usage.cacheReadTokens'), 0) AS estimate,
      json_extract(e.payload_json, '$.usage.inputTokens') IS NOT NULL AS has
    FROM agent_events e
    JOIN chats c ON e.chat_id = c.id
    WHERE c.org_id = @orgId AND e.chat_id = @chatId AND e.event_type = 'result'
    ORDER BY e.created_at DESC, e.sequence DESC
    LIMIT 1
  `).get({ orgId, chatId }) as { estimate: number; has: number } | undefined;

  return {
    usage: {
      inputTokens: toCount(totalsRow.inputTokens),
      outputTokens: toCount(totalsRow.outputTokens),
      cacheCreationTokens: toCount(totalsRow.cacheCreationTokens),
      cacheReadTokens: toCount(totalsRow.cacheReadTokens),
      total:
        toCount(totalsRow.inputTokens) + toCount(totalsRow.outputTokens) +
        toCount(totalsRow.cacheCreationTokens) + toCount(totalsRow.cacheReadTokens),
      turns: toCount(totalsRow.turns),
    },
    lastResultEstimateTokens: lastRow && lastRow.has ? toCount(lastRow.estimate) : null,
  };
}

export interface ChatLastCompact {
  at: string;
  preTokens: number | null;
  postTokens: number | null;
  /** Provider-reported trigger ("manual" | "auto" | ...). Null when absent. */
  trigger: string | null;
}

/** Most recent compact_boundary event for the chat (manual /compact AND M4
 *  auto-compact both land here). Null when the chat never compacted. */
export function getChatLastCompact(orgId: string, chatId: string): ChatLastCompact | null {
  const row = db.prepare(`
    SELECT e.created_at AS at, e.payload_json AS p
    FROM agent_events e
    JOIN chats c ON e.chat_id = c.id
    WHERE c.org_id = @orgId AND e.chat_id = @chatId AND e.event_type = 'compact_boundary'
    ORDER BY e.created_at DESC, e.sequence DESC
    LIMIT 1
  `).get({ orgId, chatId }) as { at: string; p: string } | undefined;
  if (!row) return null;
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(row.p) as Record<string, unknown>;
  } catch {
    // Corrupt payload — the timestamp alone is still useful metadata.
  }
  return {
    at: row.at,
    preTokens: typeof p.preTokens === "number" ? p.preTokens : null,
    postTokens: typeof p.postTokens === "number" ? p.postTokens : null,
    trigger: typeof p.trigger === "string" ? p.trigger : null,
  };
}
