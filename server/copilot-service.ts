// Minimal copilot model: one FIXED agent per user (app_id='copilot'). Reset
// restarts the SAME agent's conversation/runtime while preserving its Docker
// volumes. See agent-service.getOrCreateCopilotAgent + server.ts copilot routes.
//
// Why no brain-keying (much simpler than the abandoned shared-brain design): the
// agentId is STABLE across resets, and Docker volumes are already keyed by
// agentId (`agent-workspace-<agentId>`, `agent-claude-home-<agentId>`). So
// preserving the workspace + .claude volumes = "stop the container, don't delete
// the volumes, clear the conversation + resume state" → the next message
// re-mounts the SAME volumes and starts a fresh claudeSessionId. The invariant
// (agentId == chatId == conversationId == runtime key == claudeSessionId owner)
// is untouched because nothing is ever re-keyed or re-created.

import db from "./database.js";
import { containerManager } from "./container-manager.js";
import { eventStore } from "./event-store.js";
import { agentService } from "./agent-service.js";
import type { Agent } from "./types.js";

// ─── Session-closer injection ───────────────────────────────────────────────
// The in-memory `sessions` Map lives in server.ts. Injected at boot to avoid a
// server↔copilot-service circular import: close + drop the Session orchestrator
// for (user, chat). Docker volumes are NOT touched here.
type SessionCloser = (userId: string, chatId: string) => void;
let closeSession: SessionCloser = () => {
  console.warn(
    "[copilot] session closer not registered — server.ts must call setCopilotSessionCloser at boot"
  );
};
export function setCopilotSessionCloser(fn: SessionCloser): void {
  closeSession = fn;
}

// ─── Per-user lock ──────────────────────────────────────────────────────────
// Serialize reset against itself / an open so we never tear down a conversation
// mid-send. Cheap correctness (no shared-brain binding, no new agent).
const noop = () => {};
const userLocks = new Map<string, Promise<unknown>>();
function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  userLocks.set(userId, next.then(noop, noop));
  return next;
}

/** Clear a chat's message history (messages only — the chat/agent row is kept). */
function clearMessages(chatId: string): void {
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
}

/**
 * Get-or-open the user's fixed copilot agent, SERIALIZED per user against reset
 * (Codex round-3 finding 1): a concurrent open must not race reset's create and
 * produce two `app_id='copilot'` agents. Same lock as reset.
 */
export async function getOrOpenCopilotAgent(userId: string): Promise<Agent> {
  return withUserLock(userId, async () => agentService.getOrCreateCopilotAgent(userId));
}

/**
 * Reset the user's copilot agent: SAME agentId, fresh conversation, preserved
 * workspace + .claude volumes.
 *  1. close + drop the in-memory Session orchestrator;
 *  2. stop the Docker runtime (AutoRemove removes the container; volumes persist);
 *  3. clear the message history (chat/agent rows kept);
 *  4. clear the agent_sessions resume state (claudeSessionId + container fields)
 *     → next message starts a fresh claudeSessionId instead of cold-resuming the
 *     cleared conversation. The session row + its audit/diagnostic events are
 *     KEPT (Codex round-3 finding 2: reset ≠ governance wipe).
 * The chat/agent rows and Docker volumes are never touched → agentId stable →
 * volumes auto-preserved. Returns the SAME agent.
 */
export async function resetCopilotAgent(userId: string): Promise<Agent> {
  return withUserLock(userId, async () => {
    const agent = agentService.getOrCreateCopilotAgent(userId);
    const agentId = agent.id;
    closeSession(userId, agentId);
    await containerManager.stopRuntime(userId, agentId, "copilot_reset");
    clearMessages(agentId);
    eventStore.clearResumeState(userId, agentId);
    return agent;
  });
}
