/**
 * agent-run-service.ts — Agent OS M3 (plan §7): runId execution audit closure.
 *
 * A "run" = ONE user-message execution turn (sendMessage → result), DISTINCT
 * from the long-lived `agent_sessions.id`. This service mints + finalizes one
 * fixed-size run metadata row per execution and links existing `agent_events`
 * (approval, tool_use, result, token usage) by `run_id`.
 *
 * Audit-volume hard boundary (plan §7 + M3 brief):
 *   - Exactly ONE fixed-size run metadata row per execution. No stream chunks,
 *     message bodies, raw subject/AppKey/Token, Tool input/output, or duplicated
 *     payloads are ever stored. The run row carries only identity snapshot +
 *     configVersion + capability IDs + model + final status/cost/usage totals.
 *   - Event detail is fetched from the EXISTING `agent_events` table (bounded +
 *     paginated) and REDACTED before return — toolInput/toolOutput/raw payload
 *     are stripped. No event bus, Trace/Span, replay, or duplicate store.
 *
 * Governance (plan §7 验收): `getRun` is admin-only. Non-admin requesters
 * (user / org_admin / cross-org / cross-app) get `null` — existence is hidden.
 */
import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import { eventStore, type AgentEvent } from "./event-store.js";
import { resolvePrincipal } from "./app-principal.js";
import { applicationService } from "./application-service.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { computeConfigVersion } from "./capability-version.js";
import { resolveEffectiveModel } from "./model-catalog.js";
import type { RequestContext, Role } from "./request-context.js";

export type RunStatus = "running" | "success" | "failed" | "tool_rejected" | "stopped";
export type PrincipalType = "user" | "app_principal";

export interface RunStartInput {
  agentSessionId: string;
  userId: string;
  chatId: string;
  role: Role;
  orgId: string;
}

export interface RunRow {
  id: string;
  agentSessionId: string;
  userId: string;
  principalType: PrincipalType;
  orgId: string;
  appId: string;
  chatId: string;
  configVersion: string | null;
  capabilityIds: string | null;
  model: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  durationMs: number | null;
  usageJson: string | null;
}

export interface RunFinalizeInput {
  success: boolean;
  costUsd?: number | null;
  durationMs?: number | null;
  usage?: TokenUsageTotals | null;
  model?: string | null;
}

export interface TokenUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/** A redacted, bounded event summary entry — never carries raw payload. */
export interface RunEventSummary {
  sequence: number;
  eventType: string;
  createdAt: string;
  toolName?: string | null;
  decision?: string | null;
  isError?: boolean;
  success?: boolean;
  model?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
}

export interface RunDetail {
  run: Omit<RunRow, "userId" | "orgId" | "appId" | "chatId"> & {
    // Opaque platform principal ID (the value frozen at run start — either a
    // platform users.id or an app_principals.id). The raw app subject is NEVER
    // surfaced here; only principalId + principalType identify the actor.
    principalId: string;
    orgId: string;
    appId: string;
    agentId: string;
  };
  eventCounts: Array<{ eventType: string; count: number }>;
  events: RunEventSummary[];
  eventPage: { limit: number; offset: number; totalShown: number };
}

const stmts = {
  insertRun: db.prepare(
    `INSERT INTO agent_runs
       (id, agent_session_id, user_id, principal_type, org_id, app_id, chat_id,
        config_version, capability_ids, model, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
  ),
  getRun: db.prepare(
    `SELECT id, agent_session_id as agentSessionId, user_id as userId,
       principal_type as principalType, org_id as orgId, app_id as appId,
       chat_id as chatId, config_version as configVersion,
       capability_ids as capabilityIds, model, status, started_at as startedAt,
       ended_at as endedAt, cost_usd as costUsd, duration_ms as durationMs,
       usage_json as usageJson
     FROM agent_runs WHERE id = ?`
  ),
  finalizeRun: db.prepare(
    `UPDATE agent_runs SET status = ?, ended_at = datetime('now'),
       cost_usd = ?, duration_ms = ?, usage_json = ?, model = COALESCE(?, model)
     WHERE id = ?`
  ),
  markSessionRunningStopped: db.prepare(
    `UPDATE agent_runs SET status = 'stopped', ended_at = datetime('now')
     WHERE agent_session_id = ? AND status = 'running'`
  ),
  getDecisionEventsForRun: db.prepare(
    `SELECT payload_json as payloadJson FROM agent_events
     WHERE run_id = ? AND event_type = 'approval_decision' ORDER BY sequence ASC`
  ),
};

const DEFAULT_EVENT_PAGE_LIMIT = 50;
const MAX_EVENT_PAGE_LIMIT = 200;

class AgentRunService {
  /**
   * Mint a runId + freeze the run-start snapshot (principal type, org, app,
   * agent, agentSession, configVersion, effective capability IDs, model, start
   * time). Any prior 'running' run for the same agent_session is marked
   * 'stopped' first (defensive — a crashed/restarted run that never finalized).
   */
  startRun(input: RunStartInput): string {
    const runId = uuidv4();
    const startedAt = new Date().toISOString();

    // Defensive: a previous run on this agent_session never finalized (process
    // crash / abandoned turn). Mark it stopped so only ONE 'running' row per
    // session exists at a time. Best-effort; does not throw.
    try {
      stmts.markSessionRunningStopped.run(input.agentSessionId);
    } catch (err) {
      console.warn(`[agent-run] markSessionRunningStopped failed:`, (err as Error).message);
    }

    const principal = resolvePrincipal(input.userId);
    const principalType: PrincipalType = principal?.kind === "app" ? "app_principal" : "user";
    const orgId = principal?.orgId ?? input.orgId;

    // appId authority = DB (agents.app_id), NEVER request input.
    const appId = applicationService.getAppIdForAgent(input.chatId);

    const ctx: RequestContext = {
      userId: input.userId,
      role: input.role,
      orgId,
    };
    const configVersion = computeConfigVersion(ctx, input.chatId);
    const capabilityIds = [...agentCapabilityService.resolveEnabledResourceIdsForApp(ctx, input.chatId, appId)]
      .sort()
      .join(",") || null;

    // Model frozen at run start (the alias the runtime will actually use).
    let model: string | null = null;
    try {
      const effective = resolveEffectiveModel({ chatId: input.chatId, orgId });
      model = effective.runtimeModel ?? effective.alias ?? null;
    } catch (err) {
      console.warn(`[agent-run] resolveEffectiveModel failed:`, (err as Error).message);
    }

    stmts.insertRun.run(
      runId,
      input.agentSessionId,
      input.userId,
      principalType,
      orgId,
      appId,
      input.chatId,
      configVersion,
      capabilityIds,
      model,
      startedAt
    );

    return runId;
  }

  /**
   * Finalize a run at its result event. Status resolution (plan §7: four run
   * statuses, consistent with events):
   *   - result.subtype === 'success' → 'success'
   *   - non-success AND a prior approval_decision with decision reject|timeout
   *     → 'tool_rejected'
   *   - otherwise non-success → 'failed'
   * 'stopped' is set by markRunningAsStopped (abort/close) — never here.
   */
  finalizeRun(runId: string, input: RunFinalizeInput): void {
    const status: RunStatus = input.success
      ? "success"
      : this.hasRejectionDecision(runId)
        ? "tool_rejected"
        : "failed";

    const usageJson = input.usage ? JSON.stringify(input.usage) : null;
    stmts.finalizeRun.run(
      status,
      input.costUsd ?? null,
      input.durationMs ?? null,
      usageJson,
      input.model ?? null,
      runId
    );
  }

  /** Mark all 'running' runs for an agent_session 'stopped' (abort/close). */
  markRunningAsStopped(agentSessionId: string): void {
    stmts.markSessionRunningStopped.run(agentSessionId);
  }

  /**
   * Admin-only run detail. Returns `null` (existence hidden) for non-admin
   * requesters OR runs not in the requester's org scope — callers render 404.
   * The returned event summary is bounded + redacted: toolInput/toolOutput and
   * raw payload bodies are NEVER included.
   */
  getRun(
    runId: string,
    requester: { role: Role; orgId: string },
    opts?: { eventLimit?: number; eventOffset?: number }
  ): RunDetail | null {
    // M3: admin-only. user / org_admin / cross-org all get null (hidden).
    if (requester.role !== "admin") return null;

    const row = stmts.getRun.get(runId) as RunRow | undefined;
    if (!row) return null;

    // Even an admin's request is org-scoped for tenant isolation: a run from
    // another org is hidden (existence not disclosed). Single-tenant deployments
    // use 'default-org', so admin sees everything there.
    if (row.orgId !== requester.orgId) return null;

    // principalType was frozen at startRun (stored in the row). The opaque
    // principalId is the frozen user_id value. resolvePrincipal is NOT called
    // at read time — we never resurface the raw app subject, only the opaque id.
    const limit = Math.min(
      Math.max(opts?.eventLimit ?? DEFAULT_EVENT_PAGE_LIMIT, 1),
      MAX_EVENT_PAGE_LIMIT
    );
    const offset = Math.max(opts?.eventOffset ?? 0, 0);

    const rawEvents = eventStore.getEventsByRun(runId, limit, offset);
    const events = rawEvents.map((e) => redactEvent(e));
    const eventCounts = eventStore.countEventsByRunType(runId);

    return {
      run: {
        id: row.id,
        agentSessionId: row.agentSessionId,
        principalType: row.principalType,
        principalId: row.userId,
        orgId: row.orgId,
        appId: row.appId,
        agentId: row.chatId,
        configVersion: row.configVersion,
        capabilityIds: row.capabilityIds,
        model: row.model,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        costUsd: row.costUsd,
        durationMs: row.durationMs,
        usageJson: row.usageJson,
      },
      eventCounts,
      events,
      eventPage: { limit, offset, totalShown: events.length },
    };
  }

  // ─── Internal ─────────────────────────────────────────────

  private hasRejectionDecision(runId: string): boolean {
    const rows = stmts.getDecisionEventsForRun.all(runId) as Array<{ payloadJson: string }>;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payloadJson) as { decision?: string };
        if (p.decision === "reject" || p.decision === "timeout") return true;
      } catch {
        // ignore malformed
      }
    }
    return false;
  }
}

/**
 * Redact an agent_events row into a bounded summary. Carries only metadata +
 * non-sensitive result totals (model, cost, duration) — NEVER toolInput,
 * toolOutput, message bodies, or raw payloads. This is the single chokepoint
 * that enforces the M3 "no raw payload" boundary for run detail views.
 */
function redactEvent(e: AgentEvent): RunEventSummary {
  const base: RunEventSummary = {
    sequence: e.sequence,
    eventType: e.eventType,
    createdAt: e.createdAt,
  };

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(e.payloadJson) as Record<string, unknown>;
  } catch {
    return base;
  }

  switch (e.eventType) {
    case "tool_use":
      // {toolName, toolUseId} only — toolInput is intentionally dropped.
      if (typeof parsed.toolName === "string") base.toolName = parsed.toolName;
      break;
    case "tool_result":
      // tool_result carries {toolUseId, success, ...} in some paths; never the
      // output body. Surface only success flag if present.
      if (typeof parsed.success === "boolean") base.success = parsed.success;
      if (typeof parsed.toolName === "string") base.toolName = parsed.toolName;
      break;
    case "approval_request":
      if (typeof parsed.toolName === "string") base.toolName = parsed.toolName;
      break;
    case "approval_decision":
      if (typeof parsed.toolName === "string") base.toolName = parsed.toolName;
      if (typeof parsed.decision === "string") base.decision = parsed.decision;
      break;
    case "result":
      if (typeof parsed.success === "boolean") base.success = parsed.success;
      if (typeof parsed.cost === "number") base.costUsd = parsed.cost;
      if (typeof parsed.duration === "number") base.durationMs = parsed.duration;
      break;
    case "sdk_init":
      if (typeof parsed.model === "string") base.model = parsed.model;
      break;
    case "error":
      base.isError = true;
      break;
    default:
      // No sensitive fields surfaced for other event types.
      break;
  }
  return base;
}

export const agentRunService = new AgentRunService();
