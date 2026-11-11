import { v4 as uuidv4 } from "uuid";
import db from "./database.js";

export type AgentEventType =
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "stopped"
  // Capability diagnostics / audit log (MP4c). `sdk_init` was previously
  // written via `as any`; it is now a first-class type. These events are
  // audit/proof — the live desired state still comes from the control plane.
  // See server/capability-diagnostics.ts.
  | "sdk_init"
  | "resolved_snapshot"
  | "capability_activation_changed"
  | "entitlement_changed"
  | "runtime_config_stale"
  | "runtime_stopped"
  // S2 (resilience plan): metadata-only runtime lifecycle audit — death
  // reason, governed recovery success/failure/discard. Never payloads.
  | "runtime_dead"
  | "runtime_recovered"
  | "runtime_recovery_failed"
  | "runtime_recovery_discarded"
  // M8g (capability hot reload): voluntary turn-boundary runtime swap triggered
  // by control-plane configVersion drift. Metadata-only — version hashes.
  | "runtime_hot_reload"
  // Phase 5 (MP5c): per-Agent profile/prompt edit audit. Emitted by
  // PATCH /api/agents/:agentId with a REDACTED payload (no plaintext). Like the
  // other audit types, this is proof — the `agents` row remains source of truth.
  | "agent_profile_updated"
  // Phase 6 (A0): application lifecycle + capability allowlist audit. Like the
  // other audit types, this is proof — the `applications` /
  // `application_capabilities` rows remain source of truth.
  | "application_created"
  | "application_updated"
  | "application_capability_changed"
  // Widget W4: per-turn page-context audit. Proof only — payload is the
  // redacted summary (pageSessionId + sha256 + byte length + top-level keys);
  // the raw host context is never persisted.
  | "widget_context"
  // Phase 6 (A2): hook lifecycle audit (admin route operations). Per-hook-call
  // audit (hook_called) is deferred to A-late — container→host IPC audit pipeline
  // is out of scope for A2 MVP. These events have NO sensitive payload.
  | "hook_registered"
  | "hook_updated"
  | "hook_deleted"
  // Other event types previously cast via `as any` (now typed).
  | "a2ui_block"
  // A2UI v2 (S2): terminal state of a blocking show_ui call (submitted /
  // timeout / cancelled). Metadata only — submitted VALUES are NOT persisted
  // here (they return to the model as the tool_result in the same turn).
  | "a2ui_tool_result"
  | "approval_request"
  // Agent OS M2 (r2): approval DECISION audit (approve/reject/timeout/cancel).
  // METADATA ONLY — {id, toolName, decision, reason}. Never the toolInput/payload
  // (the request event is also metadata-only; execution outcome is in tool_result).
  | "approval_decision"
  // User memory (MEMORY.md) admin audit. METADATA ONLY — never the document body.
  | "user_memory_cleared"
  | "user_memory_quota_changed"
  // M4 (Auto Compact, plan §4.3): threshold-crossing decision audit + the
  // actual compaction boundary observed from the SDK (manual /compact and
  // auto-compact both emit the boundary). Metadata only — no payloads.
  | "auto_compact"
  // S2 rev4: the compact CONTROL turn was interrupted (runtime died while
  // compaction was in flight). Metadata only — /compact is never replayed.
  | "auto_compact_interrupted"
  | "compact_boundary";

export interface AgentEvent {
  id: string;
  userId: string;
  chatId: string;
  agentSessionId: string;
  sequence: number;
  eventType: AgentEventType;
  payloadJson: string;
  createdAt: string;
  // Agent OS M3: the run this event belongs to (nullable for lifecycle/audit
  // events emitted outside a user-message turn, and for legacy rows).
  runId?: string | null;
}

export interface AgentSessionRecord {
  id: string;
  userId: string;
  chatId: string;
  claudeSessionId: string | null;
  runtimeType: string;
  containerId: string | null;
  containerName: string | null;
  hostPort: number | null;
  workspaceVolume: string | null;
  claudeHomeVolume: string | null;
  status: string;
  restoreMode: string;
  lastHeartbeatAt: string | null;
  lastActivityAt: string | null;
  restartCount: number;
  imageDigest: string | null;
  lastError: string | null;
  cleanupReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const stmts = {
  // Agent sessions
  upsertSession: db.prepare(`
    INSERT INTO agent_sessions (id, user_id, chat_id, runtime_type, status, restore_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, chat_id) DO UPDATE SET
      status = excluded.status,
      restore_mode = excluded.restore_mode,
      updated_at = excluded.updated_at
  `),
  getSessionByUserId: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, claude_session_id as claudeSessionId,
     runtime_type as runtimeType, container_id as containerId, container_name as containerName,
     host_port as hostPort, workspace_volume as workspaceVolume, claude_home_volume as claudeHomeVolume,
     status, restore_mode as restoreMode, last_heartbeat_at as lastHeartbeatAt,
     last_activity_at as lastActivityAt, restart_count as restartCount,
     image_digest as imageDigest, last_error as lastError, cleanup_reason as cleanupReason,
     created_at as createdAt, updated_at as updatedAt
     FROM agent_sessions WHERE user_id = ? AND chat_id = ?`
  ),
  updateSessionStatus: db.prepare(
    `UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?`
  ),
  updateClaudeSessionId: db.prepare(
    `UPDATE agent_sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?`
  ),
  updateHeartbeat: db.prepare(
    `UPDATE agent_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?`
  ),
  deleteSessionByChat: db.prepare(
    `DELETE FROM agent_sessions WHERE user_id = ? AND chat_id = ?`
  ),
  // Minimal copilot reset: clear resume state (claudeSessionId + container
  // fields) WITHOUT deleting the row or its audit/diagnostic events. Next start
  // → fresh claudeSessionId instead of a cold resume of the cleared conversation.
  clearResumeStateByChat: db.prepare(
    `UPDATE agent_sessions SET
       claude_session_id = NULL, container_id = NULL, container_name = NULL,
       host_port = NULL, workspace_volume = NULL, claude_home_volume = NULL,
       status = 'stopped', restore_mode = 'fresh', last_heartbeat_at = NULL,
       last_error = NULL, cleanup_reason = 'reset', updated_at = datetime('now')
     WHERE user_id = ? AND chat_id = ?`
  ),
  updateContainerInfo: db.prepare(
    `UPDATE agent_sessions SET container_id = ?, container_name = ?, host_port = ?,
     workspace_volume = ?, claude_home_volume = ?, runtime_type = ?, status = ?, updated_at = ? WHERE id = ?`
  ),
  updateLastError: db.prepare(
    `UPDATE agent_sessions SET last_error = ?, updated_at = ? WHERE id = ?`
  ),
  updateCleanupReason: db.prepare(
    `UPDATE agent_sessions SET cleanup_reason = ?, updated_at = ? WHERE id = ?`
  ),
  updateActivity: db.prepare(
    `UPDATE agent_sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?`
  ),
  incrementRestart: db.prepare(
    `UPDATE agent_sessions SET restart_count = restart_count + 1, updated_at = ? WHERE id = ?`
  ),
  updateRestoreMode: db.prepare(
    `UPDATE agent_sessions SET restore_mode = ?, updated_at = ? WHERE id = ?`
  ),
  getActiveDockerSessions: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, claude_session_id as claudeSessionId,
     runtime_type as runtimeType, container_id as containerId, container_name as containerName,
     host_port as hostPort, workspace_volume as workspaceVolume, claude_home_volume as claudeHomeVolume,
     status, restore_mode as restoreMode, last_heartbeat_at as lastHeartbeatAt,
     last_activity_at as lastActivityAt, restart_count as restartCount,
     image_digest as imageDigest, last_error as lastError, cleanup_reason as cleanupReason,
     created_at as createdAt, updated_at as updatedAt
     FROM agent_sessions WHERE runtime_type = 'docker' AND status IN ('running', 'idle', 'paused')`
  ),
  getIdleSessions: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, container_id as containerId,
     container_name as containerName, status, last_activity_at as lastActivityAt
     FROM agent_sessions WHERE runtime_type = 'docker' AND status = 'running'
     AND last_activity_at < ?`
  ),

  // Agent events
  insertEvent: db.prepare(
    `INSERT INTO agent_events (id, user_id, chat_id, agent_session_id, sequence, event_type, payload_json, created_at, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getNextSequence: db.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 as next FROM agent_events WHERE agent_session_id = ?`
  ),
  getEventsBySession: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, agent_session_id as agentSessionId,
     sequence, event_type as eventType, payload_json as payloadJson, created_at as createdAt, run_id as runId
     FROM agent_events WHERE agent_session_id = ? ORDER BY sequence ASC`
  ),
  getEventsByChat: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, agent_session_id as agentSessionId,
     sequence, event_type as eventType, payload_json as payloadJson, created_at as createdAt, run_id as runId
     FROM agent_events WHERE user_id = ? AND chat_id = ? ORDER BY sequence ASC`
  ),
  getEventsByChatPaginated: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, agent_session_id as agentSessionId,
     sequence, event_type as eventType, payload_json as payloadJson, created_at as createdAt, run_id as runId
     FROM agent_events WHERE user_id = ? AND chat_id = ? AND sequence >= ? ORDER BY sequence ASC LIMIT ?`
  ),
  // Agent OS M3: bounded + paginated event summary for a run. Ordered by
  // sequence; caller caps the page size. Raw payload_json is decoded + the
  // detail map redacts sensitive fields (toolInput/output) before return.
  getEventsByRun: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, agent_session_id as agentSessionId,
     sequence, event_type as eventType, payload_json as payloadJson, created_at as createdAt, run_id as runId
     FROM agent_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?`
  ),
  countEventsByRunType: db.prepare(
    `SELECT event_type as eventType, COUNT(*) as count FROM agent_events WHERE run_id = ? GROUP BY event_type`
  ),
  // Usage aggregation: cost/duration from result events, grouped by day
  getUsageByDay: db.prepare(
    `SELECT DATE(created_at) as label,
       SUM(json_extract(payload_json, '$.cost')) as cost,
       SUM(json_extract(payload_json, '$.duration')) as duration,
       COUNT(*) as turns
     FROM agent_events WHERE event_type = 'result'
     GROUP BY DATE(created_at) ORDER BY label ASC`
  ),
  // Usage aggregation grouped by chat (agent)
  getUsageByChat: db.prepare(
    `SELECT chat_id as label,
       SUM(json_extract(payload_json, '$.cost')) as cost,
       SUM(json_extract(payload_json, '$.duration')) as duration,
       COUNT(*) as turns
     FROM agent_events WHERE event_type = 'result'
     GROUP BY chat_id ORDER BY cost DESC`
  ),
  // Audit log: governance events, paginated
  getAuditEvents: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, agent_session_id as agentSessionId,
     sequence, event_type as eventType, payload_json as payloadJson, created_at as createdAt
     FROM agent_events WHERE event_type IN (
       'application_created', 'application_updated', 'application_deleted',
       'hook_registered', 'hook_updated', 'hook_deleted',
       'agent_profile_updated', 'capability_activation_changed',
       'entitlement_changed', 'sdk_init', 'resolved_snapshot',
       'user_memory_cleared', 'user_memory_quota_changed'
     )
     ORDER BY created_at DESC LIMIT ?`
  ),
  getLatestEventByType: db.prepare(
    `SELECT id, user_id as userId, chat_id as chatId, agent_session_id as agentSessionId,
     sequence, event_type as eventType, payload_json as payloadJson, created_at as createdAt
     FROM agent_events WHERE user_id = ? AND chat_id = ? AND event_type = ?
     ORDER BY sequence DESC LIMIT 1`
  ),
  deleteEventsByChat: db.prepare(
    `DELETE FROM agent_events WHERE user_id = ? AND chat_id = ?`
  ),
};

class EventStore {
  // --- Agent Session management ---

  getOrCreateSession(userId: string, chatId: string, runtimeType = "local"): AgentSessionRecord {
    let session = stmts.getSessionByUserId.get(userId, chatId) as AgentSessionRecord | undefined;
    if (!session) {
      const id = uuidv4();
      const now = new Date().toISOString();
      stmts.upsertSession.run(id, userId, chatId, runtimeType, "running", "fresh", now, now);
      session = stmts.getSessionByUserId.get(userId, chatId) as AgentSessionRecord;
    }
    return session;
  }

  getSessionByChat(userId: string, chatId: string): AgentSessionRecord | undefined {
    return stmts.getSessionByUserId.get(userId, chatId) as AgentSessionRecord | undefined;
  }

  updateStatus(sessionId: string, status: string) {
    stmts.updateSessionStatus.run(status, new Date().toISOString(), sessionId);
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string) {
    stmts.updateClaudeSessionId.run(claudeSessionId, new Date().toISOString(), sessionId);
  }

  updateHeartbeat(sessionId: string) {
    const now = new Date().toISOString();
    stmts.updateHeartbeat.run(now, now, sessionId);
  }

  updateContainerInfo(
    sessionId: string,
    containerId: string,
    containerName: string,
    hostPort: number,
    workspaceVolume: string,
    claudeHomeVolume: string,
    runtimeType = "docker"
  ) {
    const now = new Date().toISOString();
    stmts.updateContainerInfo.run(containerId, containerName, hostPort, workspaceVolume, claudeHomeVolume, runtimeType, "running", now, sessionId);
  }

  updateLastError(sessionId: string, error: string | null) {
    stmts.updateLastError.run(error, new Date().toISOString(), sessionId);
  }

  updateCleanupReason(sessionId: string, reason: string) {
    stmts.updateCleanupReason.run(reason, new Date().toISOString(), sessionId);
  }

  updateActivity(sessionId: string) {
    const now = new Date().toISOString();
    stmts.updateActivity.run(now, now, sessionId);
  }

  incrementRestart(sessionId: string) {
    stmts.incrementRestart.run(new Date().toISOString(), sessionId);
  }

  updateRestoreMode(sessionId: string, mode: string) {
    stmts.updateRestoreMode.run(mode, new Date().toISOString(), sessionId);
  }

  getActiveDockerSessions(): AgentSessionRecord[] {
    return stmts.getActiveDockerSessions.all() as AgentSessionRecord[];
  }

  getIdleSessions(olderThan: string): AgentSessionRecord[] {
    return stmts.getIdleSessions.all(olderThan) as AgentSessionRecord[];
  }

  // --- Agent Events ---

  appendEvent(
    userId: string,
    chatId: string,
    agentSessionId: string,
    eventType: AgentEventType,
    payload: object,
    runId?: string | null
  ): AgentEvent {
    const id = uuidv4();
    const now = new Date().toISOString();
    const { next: sequence } = stmts.getNextSequence.get(agentSessionId) as { next: number };
    const payloadJson = JSON.stringify(payload);

    stmts.insertEvent.run(id, userId, chatId, agentSessionId, sequence, eventType, payloadJson, now, runId ?? null);

    return { id, userId, chatId, agentSessionId, sequence, eventType, payloadJson, createdAt: now, runId: runId ?? null };
  }

  /**
   * Agent OS M3: bounded + paginated raw event rows for a run. Returns the
   * stored rows (including payload_json); the caller (agent-run-service)
   * redacts sensitive fields before exposing them externally. Page size is
   * capped by the caller.
   */
  getEventsByRun(runId: string, limit: number, offset: number): AgentEvent[] {
    return stmts.getEventsByRun.all(runId, limit, offset) as AgentEvent[];
  }

  /** Agent OS M3: per-event-type counts for a run (summary stats). */
  countEventsByRunType(runId: string): Array<{ eventType: string; count: number }> {
    return stmts.countEventsByRunType.all(runId) as Array<{ eventType: string; count: number }>;
  }

  getEventsBySession(agentSessionId: string): AgentEvent[] {
    return stmts.getEventsBySession.all(agentSessionId) as AgentEvent[];
  }

  getEventsByChat(userId: string, chatId: string): AgentEvent[] {
    return stmts.getEventsByChat.all(userId, chatId) as AgentEvent[];
  }

  getEventsByChatPaginated(userId: string, chatId: string, fromSeq: number, limit: number): AgentEvent[] {
    return stmts.getEventsByChatPaginated.all(userId, chatId, fromSeq, limit) as AgentEvent[];
  }

  getUsageByDay(): Array<{ label: string; cost: number; duration: number; turns: number }> {
    return stmts.getUsageByDay.all() as Array<{ label: string; cost: number; duration: number; turns: number }>;
  }

  getUsageByChat(): Array<{ label: string; cost: number; duration: number; turns: number }> {
    return stmts.getUsageByChat.all() as Array<{ label: string; cost: number; duration: number; turns: number }>;
  }

  getAuditEvents(limit: number): AgentEvent[] {
    return stmts.getAuditEvents.all(limit) as AgentEvent[];
  }

  /** Newest event of a given type for a chat (null if none). Used by diagnostics. */
  getLatestEventByType(userId: string, chatId: string, eventType: AgentEventType): AgentEvent | null {
    return (stmts.getLatestEventByType.get(userId, chatId, eventType) as AgentEvent | undefined) ?? null;
  }

  // Cleanup (user-scoped for multi-tenancy safety)
  deleteByChat(userId: string, chatId: string) {
    stmts.deleteEventsByChat.run(userId, chatId);
    stmts.deleteSessionByChat.run(userId, chatId);
  }

  /**
   * Minimal copilot reset: clear an agent's resume state (claudeSessionId +
   * container fields → fresh start next time) WITHOUT deleting the session row
   * or its audit/diagnostic events. Used by copilot reset (preserves governance
   * proof); distinct from deleteByChat, which wipes everything.
   */
  clearResumeState(userId: string, chatId: string) {
    stmts.clearResumeStateByChat.run(userId, chatId);
  }
}

export const eventStore = new EventStore();
