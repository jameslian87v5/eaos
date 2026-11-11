import { v4 as uuidv4 } from "uuid";
import type { Chat, ChatMessage } from "./types.js";
import db from "./database.js";
import { applicationService } from "./application-service.js";
import { DEFAULT_ORG_ID } from "./request-context.js";

// Prepared statements for performance
const stmts = {
  insertChat: db.prepare(
    `INSERT INTO chats (id, user_id, org_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getChat: db.prepare(
    `SELECT id, user_id as userId, org_id as orgId, title, created_at as createdAt, updated_at as updatedAt FROM chats WHERE id = ?`
  ),
  getAllChats: db.prepare(
    `SELECT id, user_id as userId, org_id as orgId, title, created_at as createdAt, updated_at as updatedAt FROM chats WHERE user_id = ? ORDER BY updated_at DESC`
  ),
  updateTitle: db.prepare(
    `UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`
  ),
  updateTimestamp: db.prepare(
    `UPDATE chats SET updated_at = ? WHERE id = ?`
  ),
  deleteChat: db.prepare(`DELETE FROM chats WHERE id = ?`),
  // Phase 5: agents sibling row (same-id bridge). Maintained alongside chats at
  // the single creation/deletion chokepoint so agents.id == chats.id always holds,
  // regardless of caller (/api/chats or /api/agents).
  insertAgent: db.prepare(
    `INSERT INTO agents (id, org_id, owner_user_id, name, description, status, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?)`
  ),
  setAgentProfileId: db.prepare(
    `UPDATE agents SET profile_id = ?, updated_at = ? WHERE id = ?`
  ),
  deleteAgent: db.prepare(`DELETE FROM agents WHERE id = ?`),
  insertMessage: db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, tool_name, tool_input, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getMessages: db.prepare(
    `SELECT id, chat_id as chatId, role, content, tool_name as toolName, tool_input as toolInput, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`
  ),
  findRecentDuplicate: db.prepare(
    `SELECT id, timestamp FROM messages
     WHERE chat_id = ? AND role = ? AND content = ? AND timestamp >= ?
       AND COALESCE(tool_name, '') = COALESCE(?, '')
     ORDER BY timestamp DESC LIMIT 1`
  ),
};

// ─── S1 (resilience plan): durable agent-error representation ──────────────
// The messages CHECK constraint allows only role ∈ {user, assistant, tool_use}
// and there is no error flag column, so error rows need a storage encoding.
// Representation (S1 round-2, per Codex adversarial verification): a
// role:"system" chat message ENCODES to the reserved storage form
// role:"tool_use" + tool_name:"__agent_error__" (content = raw error text).
// getMessages DECODES only when BOTH role and the reserved tool_name match —
// a plain assistant message whose content happens to start with any error-ish
// text can never be reclassified, because normal writes never produce the
// reserved pair. The dedup lookup includes tool_name so synthetic errors and
// normal assistant rows can never dedup against each other.
export const AGENT_ERROR_TOOL_NAME = "__agent_error__";

// Phase 5: atomic create/delete of the chats + agents sibling rows (same id).
// A transaction guarantees we never persist one without the other.
// Inherits default-app.profileId so the real /api/chats path also gets the App Profile.
const createChatTx = db.transaction((id: string, userId: string, orgId: string, title: string, now: string, profileId: string | null) => {
  stmts.insertChat.run(id, userId, orgId, title, now, now);
  stmts.insertAgent.run(id, orgId, userId, title, profileId, now, now);
});
const deleteChatTx = db.transaction((id: string) => {
  stmts.deleteAgent.run(id);
  // chats CASCADE cleans messages / agent_sessions / agent_events / workspace_files
  return stmts.deleteChat.run(id);
});

class ChatStore {
  createChat(userId: string, title?: string, orgId: string = DEFAULT_ORG_ID): Chat {
    const id = uuidv4();
    const now = new Date().toISOString();
    // Inherit default-app's profileId at the ChatStore level so the real /api/chats
    // path (which calls chatStore.createChat directly, not agentService.createChat)
    // also gets the App Profile. Codex finding: agentService.createChat() was not
    // on the actual legacy path.
    const app = applicationService.getApplication("default-app");
    const profileId = app?.profileId ?? null;
    createChatTx(id, userId, orgId, title || "New Chat", now, profileId);
    return { id, userId, orgId, title: title || "New Chat", createdAt: now, updatedAt: now };
  }

  getChat(id: string): Chat | undefined {
    return stmts.getChat.get(id) as Chat | undefined;
  }

  getAllChats(userId: string): Chat[] {
    return stmts.getAllChats.all(userId) as Chat[];
  }

  // Verify chat belongs to user (and, when orgId is provided, to that org).
  // Phase 7: orgId is the tenant invariant — a cross-org match is denied even if
  // the userId lines up. orgId is optional only for backward-compatible callers;
  // the route layer always passes ctx.orgId.
  verifyChatOwnership(chatId: string, userId: string, orgId?: string): boolean {
    const chat = stmts.getChat.get(chatId) as { userId?: string; orgId?: string } | undefined;
    if (!chat || chat.userId !== userId) return false;
    if (orgId !== undefined && chat.orgId !== orgId) return false;
    return true;
  }

  updateChatTitle(id: string, title: string): Chat | undefined {
    const now = new Date().toISOString();
    const result = stmts.updateTitle.run(title, now, id);
    if (result.changes === 0) return undefined;
    return this.getChat(id);
  }

  deleteChat(id: string): boolean {
    // Phase 5: removes the agents sibling + chats (which cascades the rest) atomically.
    const result = deleteChatTx(id);
    return result.changes > 0;
  }

  addMessage(chatId: string, message: Omit<ChatMessage, "id" | "chatId" | "timestamp">): ChatMessage {
    const chat = this.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} not found`);
    }

    // S1: encode system error rows to the reserved storage form (role
    // "tool_use" + reserved tool_name — see AGENT_ERROR_TOOL_NAME). Encoded
    // BEFORE the dedup lookup so repeat errors dedup on the exact stored
    // role+content+tool_name triple; the tool_name term in the dedup query
    // keeps synthetic errors from ever deduping against normal rows.
    const isSyntheticError = message.role === "system";
    const storedRole = isSyntheticError ? "tool_use" : message.role;
    const storedContent = message.content;
    const storedToolName = isSyntheticError ? AGENT_ERROR_TOOL_NAME : (message as any).toolName || null;

    // Last-resort dedup: if the same chat+role+content was written within the
    // last 10s, return the existing record instead of inserting a duplicate.
    // This catches multi-Session concurrency that instance/static-level dedup
    // in Session.broadcastAssistantText can miss (e.g. cold resume racing
    // with concurrent WS subscribers).
    const cutoff = new Date(Date.now() - 10_000).toISOString();
    const recentDup = stmts.findRecentDuplicate.get(
      chatId,
      storedRole,
      storedContent,
      cutoff,
      storedToolName
    ) as { id: string; timestamp: string } | undefined;
    if (recentDup) {
      return {
        id: recentDup.id,
        chatId,
        role: message.role,
        content: message.content,
        timestamp: recentDup.timestamp,
      };
    }

    const id = uuidv4();
    const timestamp = new Date().toISOString();

    stmts.insertMessage.run(
      id,
      chatId,
      storedRole,
      storedContent,
      storedToolName,
      (message as any).toolInput ? JSON.stringify((message as any).toolInput) : null,
      timestamp
    );

    // Update chat timestamp
    stmts.updateTimestamp.run(timestamp, chatId);

    // Auto-generate title from first user message
    if (chat.title === "New Chat" && message.role === "user") {
      const title = message.content.slice(0, 50) + (message.content.length > 50 ? "..." : "");
      stmts.updateTitle.run(title, timestamp, chatId);
    }

    return { id, chatId, role: message.role, content: message.content, timestamp };
  }

  getMessages(chatId: string): ChatMessage[] {
    const rows = stmts.getMessages.all(chatId) as any[];
    return rows.map((row) => {
      // S1: decode reserved synthetic-error rows back to role:"system" with
      // isError, so every consumer (WS history, REST, fallbackFromMessages)
      // sees the canonical form without knowing the storage encoding. Gate =
      // role + reserved tool_name BOTH matching; a plain assistant row with
      // identical content stays untouched.
      if (row.role === "tool_use" && row.toolName === AGENT_ERROR_TOOL_NAME) {
        return {
          id: row.id,
          chatId: row.chatId,
          role: "system" as const,
          content: row.content,
          isError: true,
          systemKind: "error",
          timestamp: row.timestamp,
        };
      }
      return {
        id: row.id,
        chatId: row.chatId,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        ...(row.toolName && { toolName: row.toolName }),
        ...(row.toolInput && { toolInput: JSON.parse(row.toolInput) }),
      };
    });
  }
}

// Singleton instance
export const chatStore = new ChatStore();
