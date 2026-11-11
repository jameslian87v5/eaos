// IPC Protocol: defines messages between the main process and agent containers.
// Transport: WebSocket (container exposes WS server on a dynamic port).

import type { A2UIBlock } from "./a2ui-types.js";
import type { ShowUiResult } from "./a2ui-schema.js";

// --- Messages from Main Process → Container ---

export type IPCToContainer =
  | { type: "user_message"; content: string }
  | { type: "approval_response"; id: string; approved: boolean; message?: string }
  | { type: "abort" }
  | { type: "ping" }
  | { type: "health_check"; requestId: string }
  | { type: "shutdown"; reason: string; deadlineMs: number }
  // A2UI v2 (S3): resolve the container's blocking show_ui call. `requestId`
  // is the CONTAINER-generated correlation key from the matching a2ui_request
  // (the UI-side blockId lives host-side only — the two id spaces never mix).
  | { type: "a2ui_response"; requestId: string; result: ShowUiResult };

// --- Messages from Container → Main Process ---

export type IPCFromContainer =
  | { type: "ready"; port: number }
  | { type: "session_id"; sessionId: string }
  | { type: "sdk_event"; event: Record<string, unknown> }
  | { type: "error"; error: string }
  | { type: "stopped" }
  | { type: "pong" }
  | {
      type: "health_status";
      requestId: string;
      status: "starting" | "ready" | "busy" | "idle" | "waiting_for_approval" | "shutting_down";
      sdkSessionId?: string;
      pendingApprovals: number;
      queueDepth: number;
      uptimeMs: number;
    }
  | { type: "draining"; reason: string }
  // A2UI v2 (S3): the in-container show_ui handler awaits user input. The
  // host (Session.handleA2UiToolCall) persists/broadcasts the block under its
  // OWN tool- blockId and forwards the terminal result back via
  // a2ui_response. Block is schema-validated IN the container before send.
  | { type: "a2ui_request"; requestId: string; block: A2UIBlock; timeoutSec?: number };

// Container configuration passed via environment variables
export interface ContainerEnvConfig {
  // Port the container's WS server listens on
  AGENT_WS_PORT: string;
  // Anthropic API key (forwarded from host)
  ANTHROPIC_API_KEY?: string;
  // Tools configuration (JSON array)
  AGENT_TOOLS?: string;
  // Allowed tools (JSON array) 
  AGENT_ALLOWED_TOOLS?: string;
  // System prompt override
  AGENT_SYSTEM_PROMPT?: string;
  // Claude session ID for resume
  CLAUDE_SESSION_ID?: string;
}

// Default container WS port
export const CONTAINER_WS_PORT = 9100;
