import { chatStore } from "./chat-store.js";
import db from "./database.js";
import { getPromptSettings, sanitizePromptText } from "./prompt-settings.js";
import { applicationService } from "./application-service.js";
import { getUserOrgId } from "./auth.js";
import { DEFAULT_ORG_ID } from "./request-context.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import type { Agent, AgentMessage, Chat, ChatMessage } from "./types.js";

// M6a: agents.quick_prompts is a JSON string in SQLite; the read model parses
// it into the typed array. Malformed JSON degrades to null (no starter), the
// same fail-safe the rest of the Agent projection uses.
function hydrateStarter<T extends Agent>(row: T | undefined): T | undefined {
  if (!row) return row;
  if (typeof row.quickPrompts === "string") {
    try {
      const parsed = JSON.parse(row.quickPrompts as unknown as string);
      (row as Agent).quickPrompts = Array.isArray(parsed) ? parsed : null;
    } catch {
      row.quickPrompts = null;
    }
  } else if (row.quickPrompts === undefined) {
    row.quickPrompts = null;
  }
  return row;
}

function hydrateStarterList<T extends Agent>(rows: T[]): T[] {
  return rows.map((r) => hydrateStarter(r)!);
}

// Phase 5: AgentService owns the canonical `agents` table. These reads project
// the Agent view from agents JOIN chats — `title` and timestamps come from chats
// (so the auto-derived conversation title and last-activity ordering stay live),
// while orgId/description/status are the Agent's own fields. `agents.name` is a
// stored seed (initialized = chats.title) reserved for a future Agent rename.
const agentStmts = {
  getAgent: db.prepare(
    `SELECT a.id, a.org_id AS orgId, a.owner_user_id AS userId, c.title AS title,
            a.description AS description, a.status AS status, a.profile_id AS profileId,
            a.app_id AS appId, a.template_id AS templateId, a.welcome_message AS welcomeMessage, a.quick_prompts AS quickPrompts,
            c.created_at AS createdAt, c.updated_at AS updatedAt
     FROM agents a JOIN chats c ON c.id = a.id WHERE a.id = ?`
  ),
  listAgents: db.prepare(
    `SELECT a.id, a.org_id AS orgId, a.owner_user_id AS userId, c.title AS title,
            a.description AS description, a.status AS status, a.profile_id AS profileId,
            a.app_id AS appId, a.template_id AS templateId, a.welcome_message AS welcomeMessage, a.quick_prompts AS quickPrompts,
            c.created_at AS createdAt, c.updated_at AS updatedAt
     FROM agents a JOIN chats c ON c.id = a.id
     WHERE a.owner_user_id = ? ORDER BY c.updated_at DESC`
  ),
  // Phase 6 (A1) + Phase 7: app-scoped list — filter by owner AND app_id AND org
  // (DB-backed, not in-memory). org is the tenant invariant.
  listByApp: db.prepare(
    `SELECT a.id, a.org_id AS orgId, a.owner_user_id AS userId, c.title AS title,
            a.description AS description, a.status AS status, a.profile_id AS profileId,
            a.app_id AS appId, a.template_id AS templateId, a.welcome_message AS welcomeMessage, a.quick_prompts AS quickPrompts,
            c.created_at AS createdAt, c.updated_at AS updatedAt
     FROM agents a JOIN chats c ON c.id = a.id
     WHERE a.owner_user_id = ? AND a.app_id = ? AND a.org_id = ? ORDER BY c.updated_at DESC`
  ),
  // Phase 6 (A1) + Phase 7: app-scoped get — verify owner AND app_id AND org.
  getOwnedAppAgent: db.prepare(
    `SELECT a.id, a.org_id AS orgId, a.owner_user_id AS userId, c.title AS title,
            a.description AS description, a.status AS status, a.profile_id AS profileId,
            a.app_id AS appId, a.template_id AS templateId, a.welcome_message AS welcomeMessage, a.quick_prompts AS quickPrompts,
            c.created_at AS createdAt, c.updated_at AS updatedAt
     FROM agents a JOIN chats c ON c.id = a.id
     WHERE a.id = ? AND a.owner_user_id = ? AND a.app_id = ? AND a.org_id = ?`
  ),
  // Phase 6 (A1): set app_id on agent creation (atomic with chats row).
  setAgentAppId: db.prepare(
    `UPDATE agents SET app_id = ?, updated_at = ? WHERE id = ?`
  ),
  // Set profile_id on agent creation (inherit from App's profileId).
  setAgentProfileId: db.prepare(
    `UPDATE agents SET profile_id = ?, updated_at = ? WHERE id = ?`
  ),
  // Phase 5 (MP5f): list EVERY agent (admin, not owner-scoped) with the per-Agent
  // prompt overrides folded in, for the admin assignment console. Same projection
  // as getAgent + the override columns (system_prompt / append_system_prompt) so
  // one round-trip seeds the whole table; profile_id is resolved to a name
  // client-side via the profiles list.
  listAllAgents: db.prepare(
    `SELECT a.id, a.org_id AS orgId, a.owner_user_id AS userId, c.title AS title,
            a.description AS description, a.status AS status, a.profile_id AS profileId,
            a.app_id AS appId, a.template_id AS templateId, a.welcome_message AS welcomeMessage, a.quick_prompts AS quickPrompts,
            a.system_prompt AS systemPrompt, a.append_system_prompt AS appendSystemPrompt,
            c.created_at AS createdAt, c.updated_at AS updatedAt
     FROM agents a JOIN chats c ON c.id = a.id
     ORDER BY c.updated_at DESC`
  ),
  // Self-heal: if a chats row exists without its agents sibling, (re)create it
  // from chats. Idempotent (OR IGNORE).
  ensureAgent: db.prepare(
    `INSERT OR IGNORE INTO agents (id, org_id, owner_user_id, name, description, status, created_at, updated_at)
     SELECT id, org_id, user_id, title, NULL, 'active', created_at, updated_at
     FROM chats WHERE id = ?`
  ),
  // Phase 5 (MP5b): per-Agent prompt overrides (NULL → platform default).
  getAgentPrompt: db.prepare(
    `SELECT system_prompt AS systemPrompt, append_system_prompt AS appendSystemPrompt, profile_id AS profileId
     FROM agents WHERE id = ?`
  ),
};

/**
 * AgentService — Phase 1 Agent semantic layer.
 *
 * Wraps the existing ChatStore so the product surface speaks in terms of
 * long-lived Agents while storage still uses the chats/messages tables. In this
 * phase agentId === chatId; every method is a thin delegation to ChatStore with
 * NO behavior change and NO schema change.
 *
 * Method names intentionally mirror ChatStore's public API so this class is a
 * drop-in `ResourceStore` for the shared route factory in server.ts — letting
 * `/api/agents` be a true alias of `/api/chats`, with `/api/chats` still bound
 * directly to chatStore (zero behavior change on the legacy path). The Agent
 * vocabulary shows up at the type level (`Agent` / `AgentMessage`) and the route
 * level (`/api/agents`).
 *
 * Later phases extend this service:
 *   - Phase 2c: per-Agent capability activation.
 *   - Phase 2d: feeds CapabilityProvider.resolve({ agentId, ... }).
 *   - Phase 5:  owns the new `agents` table (storage split).
 *
 * See docs/05-migration/current-chatapp-to-agent-platform-migration.md §Phase 1.
 */
export class AgentService {
  constructor(private readonly store: ChatStoreLike = chatStore) {}

  createChat(userId: string, title?: string, orgId?: string): Agent {
    // Phase 5: store.createChat writes chats + agents sibling (same id);
    // ChatStore.createChat now inherits default-app.profileId at the DB level.
    const chat = this.store.createChat(userId, title, orgId);
    const agent = this.getChat(chat.id);
    // Invariant: createChat persisted the agents row, and getChat self-heals too.
    if (!agent) throw new Error(`Agent ${chat.id} missing after create`);
    return agent;
  }

  getChat(id: string): Agent | undefined {
    // Phase 5: read the canonical Agent view from the agents table (JOIN chats).
    let row = agentStmts.getAgent.get(id) as Agent | undefined;
    if (!row) {
      // Self-heal a missing sibling (chats row predating the agents table/backfill).
      agentStmts.ensureAgent.run(id);
      row = agentStmts.getAgent.get(id) as Agent | undefined;
    }
    return hydrateStarter(row);
  }

  getAllChats(userId: string): Agent[] {
    // Phase 5: list Agents from agents JOIN chats, ordered by last activity.
    return hydrateStarterList(agentStmts.listAgents.all(userId) as Agent[]);
  }

  /**
   * Minimal copilot model: the user's ONE fixed copilot agent, identified by
   * app_id='copilot'. Returns it if it exists (owned by the user), else creates
   * one normal agent (titled 我的助手) under the built-in 'copilot' app. The id is
   * STABLE across resets — reset reuses the SAME agentId, so the Docker volumes
   * keyed by agentId are preserved automatically (no brain keying needed).
   * See copilot-service.resetCopilotAgent.
   */
  getOrCreateCopilotAgent(userId: string): Agent {
    // Phase 7 org fix: listByApp is org-scoped (3 bind params) and the created
    // agent must land in the user's OWN org — not createChat's DEFAULT_ORG_ID —
    // or a non-default-org user would mint a fresh copilot agent on every call.
    // orgId comes from the trusted users row (same source the JWT claim is
    // minted from); the fallback covers rows without a users entry (tests).
    const orgId = getUserOrgId(userId) ?? DEFAULT_ORG_ID;
    const existing = (agentStmts.listByApp.all(userId, "copilot", orgId) as Agent[])[0];
    if (existing) return existing;
    return this.createAgentForApp(userId, "copilot", "我的助手", orgId);
  }

  /**
   * Phase 6 (A1): Create an agent under a specific application. The agents.app_id
   * is set atomically WITH createChat in a single transaction.
   * Codex A1 review finding 4: must never be born under 'default-app' for app-scoped paths.
   */
  createAgentForApp(userId: string, appId: string, title?: string, orgId?: string): Agent {
    // Read App's profileId to inherit at creation time. ChatStore.createChat
    // already sets default-app.profileId on the agents row; we must explicitly
    // override it with the target App's profileId (or clear it if null) so
    // app-scoped agents don't keep a default-app inherited profile.
    const app = applicationService.getApplication(appId);
    const inheritProfileId = app?.profileId ?? null;
    const tx = db.transaction(() => {
      const chat = this.store.createChat(userId, title, orgId);
      const now = new Date().toISOString();
      const result = agentStmts.setAgentAppId.run(appId, now, chat.id);
      if (result.changes === 0) {
        throw new Error(`setAgentAppId affected 0 rows — agent ${chat.id} may not exist`);
      }
      // Explicitly set profile_id: override the default-app inheritance from
      // ChatStore.createChat with the target App's profileId (or NULL to clear).
      agentStmts.setAgentProfileId.run(inheritProfileId, now, chat.id);
      return chat.id;
    });
    const chatId = tx();
    const agent = this.getChat(chatId);
    if (!agent) throw new Error(`Agent ${chatId} missing after createAgentForApp`);
    return agent;
  }

  /**
   * Phase 6 (A1): List agents for a user within a specific app (DB-backed filter).
   * Codex A1 finding 3: do NOT filter in memory.
   */
  listByApp(userId: string, appId: string, orgId: string): Agent[] {
    return hydrateStarterList(agentStmts.listByApp.all(userId, appId, orgId) as Agent[]);
  }

  /**
   * Phase 6 (A1): Get a single agent verifying both owner AND app_id in one query.
   * Codex A1 finding 3: DB-backed ownership + app scope check.
   * Returns undefined if the agent doesn't exist OR doesn't belong to this user/app.
   */
  getOwnedAppAgent(agentId: string, userId: string, appId: string, orgId: string): Agent | undefined {
    return hydrateStarter(agentStmts.getOwnedAppAgent.get(agentId, userId, appId, orgId) as Agent | undefined);
  }

  /**
   * Phase 5 (MP5f): list EVERY agent (admin console, not owner-scoped) with the
   * per-Agent prompt overrides folded in. Drives the admin profile-assignment /
   * per-Agent prompt table; edits go through updateAgentProfile (PATCH
   * /api/agents/:id). The override columns are NULL when the Agent falls through
   * to its profile / the platform default.
   */
  listAllAgents(): Array<Agent & { systemPrompt: string | null; appendSystemPrompt: string | null }> {
    return hydrateStarterList(agentStmts.listAllAgents.all() as Array<
      Agent & { systemPrompt: string | null; appendSystemPrompt: string | null }
    >);
  }

  /** Phase 5: ensure an agents sibling row exists for a chats row (self-heal). */
  ensureAgentRow(id: string): void {
    agentStmts.ensureAgent.run(id);
  }

  /**
   * Phase 5 (MP5b): per-Agent prompt overrides. NULL fields fall through to the
   * platform default in CapabilityProvider.resolve().
   */
  getAgentPromptOverrides(id: string): {
    systemPrompt: string | null;
    appendSystemPrompt: string | null;
    profileId: string | null;
  } {
    const row = agentStmts.getAgentPrompt.get(id) as
      | {
          systemPrompt: string | null;
          appendSystemPrompt: string | null;
          profileId: string | null;
        }
      | undefined;
    return row ?? { systemPrompt: null, appendSystemPrompt: null, profileId: null };
  }

  /**
   * Phase 5 (MP5b) + M7a: per-Agent field updates — description, L2 prompt
   * overrides, and the starter metadata (welcomeMessage / quickPrompts, added
   * by the M7a edit route; stored JSON string, validated upstream). Sanitizes
   * control chars; systemPrompt is bounded by maxSystemPromptChars. Only
   * provided fields are touched. Returns whether a row was updated. `name` is
   * handled by the M7a edit route via updateChatTitle (title is the live
   * display name); the `agents.name` seed column stays untouched.
   */
  updateAgentProfile(
    id: string,
    fields: {
      description?: string | null;
      systemPrompt?: string | null;
      appendSystemPrompt?: string | null;
      profileId?: string | null;
      welcomeMessage?: string | null;
      quickPrompts?: string | null;
    }
  ): boolean {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if (fields.description !== undefined) {
      sets.push("description = ?");
      vals.push(fields.description === null ? null : sanitizePromptText(fields.description));
    }
    if (fields.systemPrompt !== undefined) {
      const text = fields.systemPrompt === null ? null : sanitizePromptText(fields.systemPrompt);
      if (text !== null && text.length > getPromptSettings().maxSystemPromptChars) {
        throw new Error(
          `systemPrompt too long: ${text.length} > maxSystemPromptChars(${getPromptSettings().maxSystemPromptChars})`
        );
      }
      sets.push("system_prompt = ?");
      vals.push(text);
    }
    if (fields.appendSystemPrompt !== undefined) {
      const text =
        fields.appendSystemPrompt === null ? null : sanitizePromptText(fields.appendSystemPrompt);
      if (text !== null && text.length > getPromptSettings().maxSystemPromptChars) {
        throw new Error(
          `appendSystemPrompt too long: ${text.length} > maxSystemPromptChars(${getPromptSettings().maxSystemPromptChars})`
        );
      }
      sets.push("append_system_prompt = ?");
      vals.push(text);
    }
    if (fields.profileId !== undefined) {
      // Reference to an agent_profile (existence validated by the caller); null
      // clears the assignment. Not sanitized — it is an id, not free text.
      sets.push("profile_id = ?");
      vals.push(fields.profileId);
    }
    // M7a: starter metadata edits (validated/bounded by the route layer; the
    // JSON string is the stored format the hydrate path already parses).
    if (fields.welcomeMessage !== undefined) {
      sets.push("welcome_message = ?");
      vals.push(fields.welcomeMessage);
    }
    if (fields.quickPrompts !== undefined) {
      sets.push("quick_prompts = ?");
      vals.push(fields.quickPrompts);
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    vals.push(new Date().toISOString());
    vals.push(id);
    const result = db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return result.changes > 0;
  }

  verifyChatOwnership(id: string, userId: string, orgId?: string): boolean {
    return this.store.verifyChatOwnership(id, userId, orgId);
  }

  updateChatTitle(id: string, title: string): Agent | undefined {
    // Phase 5: chats.title is the live title the Agent view projects; re-read agents.
    const chat = this.store.updateChatTitle(id, title);
    return chat ? this.getChat(id) : undefined;
  }

  deleteChat(id: string): boolean {
    const deleted = this.store.deleteChat(id);
    if (deleted) {
      // M6a: activation keys persist OUTSIDE the database (JSON store) — clean
      // the orphan when the Agent goes away. Best-effort: a failed cleanup must
      // not resurrect the delete (resolve is deny-default either way).
      try {
        agentCapabilityService.deleteAgentActivation(id);
      } catch (err) {
        console.warn(`[AgentService] activation cleanup failed for ${id}:`, err);
      }
    }
    return deleted;
  }

  addMessage(
    id: string,
    message: Omit<ChatMessage, "id" | "chatId" | "timestamp">
  ): AgentMessage {
    return this.store.addMessage(id, message);
  }

  getMessages(id: string): AgentMessage[] {
    return this.store.getMessages(id);
  }
}

/**
 * Structural shape AgentService depends on for the chats-backed operations it
 * still delegates (create/update/delete/messages/ownership). Phase 5 moved Agent
 * reads (getChat/getAllChats) onto the `agents` table directly, so those are no
 * longer part of this contract. ChatStore satisfies this exactly, so the default
 * `chatStore` singleton and any test fake can be injected.
 */
export interface ChatStoreLike {
  createChat(userId: string, title?: string, orgId?: string): Chat;
  verifyChatOwnership(id: string, userId: string, orgId?: string): boolean;
  updateChatTitle(id: string, title: string): Chat | undefined;
  deleteChat(id: string): boolean;
  addMessage(
    id: string,
    message: Omit<ChatMessage, "id" | "chatId" | "timestamp">
  ): ChatMessage;
  getMessages(id: string): ChatMessage[];
}

// Singleton — mirrors the ChatStore singleton pattern.
export const agentService = new AgentService();
