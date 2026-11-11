import type { WebSocket } from "ws";

// WebSocket client with session data
export interface WSClient extends WebSocket {
  sessionId?: string;
  isAlive?: boolean;
}

// Chat stored in memory
export interface Chat {
  id: string;
  userId: string;
  orgId: string; // Phase 7: chats.org_id (tenant key, never from request params)
  title: string;
  createdAt: string;
  updatedAt: string;
}

// Message stored in memory
export interface ChatMessage {
  id: string;
  chatId: string;
  // "system" rows: S1 (resilience plan) durable agent errors
  // ([agent_error] prefix, parsed back by expandAgentErrorMessages) — not
  // user input, not model output.
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

// Agent — the primary product object. During the MVP migration an Agent is
// backed by the existing `chats` row; `agentId === chatId` is the explicit
// compatibility bridge (see docs/05-migration/current-chatapp-to-agent-platform-
// migration.md, Phase 1). The field shape mirrors `Chat` until the storage
// split in Phase 5. AgentService wraps ChatStore and returns this type.
export interface Agent {
  id: string; // agentId === chatId (same-id bridge)
  userId: string; // === agents.owner_user_id (name kept for the shared route factory + requireAgentAccess)
  title: string; // === chats.title (live conversation title)
  orgId: string; // Phase 5: agents.org_id
  description?: string; // Phase 5: agents.description
  status: string; // Phase 5: agents.status (active | archived | deleted)
  profileId: string | null; // Phase 5 (MP5d): agents.profile_id -> agent_profiles.id (null = no profile)
  appId: string; // Phase 6 (A0): agents.app_id -> applications.id (NOT NULL DEFAULT 'default-app')
  // M6a (Octop absorption): expert-builder starter metadata. Absent/null = a
  // plain Agent from the legacy path (no starter). quickPrompts is parsed from
  // the agents.quick_prompts JSON column by the read model.
  templateId?: string | null;
  welcomeMessage?: string | null;
  quickPrompts?: Array<{ title: string; prompt: string }> | null;
  createdAt: string;
  updatedAt: string;
}

// Application (Phase 6 A0) — a first-class preset the platform drives agents
// from: { profile + capability allowlist + data space + entry + credential }.
// Apps are NOT independent software; the platform is the engine. See
// docs/02-architecture/platform-application-layer-architecture.md.
export interface Application {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  profileId: string | null; // -> agent_profiles.id (null = platform default prompt)
  entryUrl: string | null; // app frontend entrypoint (informational)
  apiKeyPrefix: string | null; // non-secret prefix for key lookup
  status: "active" | "disabled";
  lastUsedAt: string | null; // updated on each authenticated app call (audit)
  systemPrompt: string | null; // app-level prompt override (Phase 6)
  appendSystemPrompt: string | null; // app-level append prompt override (Phase 6)
  toolAllowlist: string[] | null; // app-level built-in tool upper bound (null = passthrough)
  createdAt: string;
  updatedAt: string;
}

// Application Capability (Phase 6 A0) — per-app capability allowlist (UPPER
// BOUND). Effective agent capability set = app allowlist ∩ entitlement ∩
// activation (deny-by-intersection). No row for an app = passthrough (no
// upper bound); rows with enabled=0 = explicitly denied.
export interface ApplicationCapability {
  id: string;
  appId: string;
  resourceId: string; // -> capability_resources.id
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Agent Profile (Phase 5 MP5d) — a reusable, shareable prompt template. Multiple
// Agents point to one via Agent.profileId. resolve() precedence:
// per-Agent override > profile > platform default.
export interface AgentProfile {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  toolsConfig: ToolsConfig | null; // null = inherit platform DEFAULT_PROFILE
  createdAt: string;
  updatedAt: string;
}

export interface ToolsConfig {
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
}

// A message within an Agent's single active conversation. The storage column is
// still `chat_id` (= agentId); the field name is retained to avoid a schema
// change in this phase.
export interface AgentMessage {
  id: string;
  chatId: string; // === agentId (compatibility bridge)
  // "system" mirrors ChatMessage: S1 durable agent-error rows.
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

// ─── Phase 6 (A3): Registered Internal API → MCP Wrapper ──────────
//
// Admin registers internal HTTP APIs → capability-installer generates a
// stdio-wrapper MCP package → appears in resource pool → app selects →
// agent calls via MCP stdio transport.

export interface RegisteredApi {
  id: string;
  orgId: string;
  name: string;                // unique within org, also MCP package name
  displayName: string | null;  // 中文名
  description: string | null;
  apiUrl: string;              // e.g. http://ds-cmn.chit-dev/ds/GET_CUSTOMER_ERPID/1
  method: "GET" | "POST";
  requestParamsSchema: Record<string, unknown> | null;  // JSON schema for tool input
  responseMapping: Record<string, string> | null;       // {code,msg,data,total}
  timeoutMs: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface ApiRegistrationInput {
  name: string;
  displayName?: string | null;
  description?: string | null;
  apiUrl: string;
  method?: "GET" | "POST";
  requestParamsSchema?: Record<string, unknown> | null;
  responseMapping?: Record<string, string> | null;
  timeoutMs?: number;
}

// WebSocket incoming messages
export interface WSChatMessage {
  type: "chat";
  content: string;
  chatId: string;
  // Widget W4: per-turn page context. `content` stays the typed user text
  // (persisted/broadcast as-is); pageContext is wrapped into the runtime input
  // only. Validated/bounded server-side (server/widget-context.ts).
  pageSessionId?: string;
  pageContext?: unknown;
}

export interface WSSubscribeMessage {
  type: "subscribe";
  chatId: string;
}

export interface WSApprovalResponseMessage {
  type: "approval_response";
  id: string;
  chatId: string;
  approved: boolean;
  message?: string;
  alwaysAllow?: boolean;
}

export interface WSStopMessage {
  type: "stop";
  chatId: string;
}

export interface WSA2UISubmitMessage {
  type: "a2ui_submit";
  chatId: string;
  blockId: string;
  actionId: string;
  actionLabel?: string;
  values: Record<string, string | number | boolean | string[]>;
}

export type IncomingWSMessage =
  | WSChatMessage
  | WSSubscribeMessage
  | WSApprovalResponseMessage
  | WSStopMessage
  | WSA2UISubmitMessage;
