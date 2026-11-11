#!/usr/bin/env node
/**
 * Agent Container Entry Point
 * 
 * Runs inside a Docker container. Starts a WebSocket server that:
 * 1. Receives user messages from the main process
 * 2. Feeds them into the Claude Agent SDK via MessageQueue
 * 3. Streams SDK events back to the main process
 * 
 * Environment variables:
 *   AGENT_WS_PORT - WebSocket server port (default: 9100)
 *   AGENT_TOOLS - JSON array of tool names
 *   AGENT_ALLOWED_TOOLS - JSON array of auto-approved tool names
 *   AGENT_SDK_OPTIONS - JSON object with additional SDK options:
 *     { disallowedTools, plugins, mcpServers, systemPrompt, appendSystemPrompt, additionalDirectories }
 *   CLAUDE_SESSION_ID - Resume a previous session
 *   ANTHROPIC_API_KEY - API key for Claude
 *
 * Path security rules (enforced at parse time):
 *   - plugins[].path must start with /opt/agent/plugins/
 *   - MCP local paths must start with /opt/agent/mcp/
 *   - additionalDirectories must NOT include /workspace (not a capability source)
 */

import { WebSocketServer, WebSocket } from "ws";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import path from "path";
import type { IPCToContainer, IPCFromContainer } from "../server/ipc-protocol.js";
import { isStreamingEnabled } from "../server/streaming-config.js";
import {
  decideMemoryWriteCore,
  MEMORY_PATH_ARG,
  MEMORY_WRITE_TOOLS,
  type MemoryWriteDecision,
} from "../server/user-memory-permission-core.js";
import { createPlatformWebToolsServer } from "../server/platform-web-tools.js";
import {
  A2UI_INTERNAL_MCP_NAME,
  SHOW_UI_TOOL_NAME,
  createA2UISdkMcpServer,
  resolveShowUiTimeout,
  resolveSubmitTimeoutMs,
} from "../server/a2ui-tool.js";
import type { ShowUiResult } from "../server/a2ui-schema.js";

const PORT = parseInt(process.env.AGENT_WS_PORT || "9100", 10);

// ─── A2UI v2 (S3): blocking show_ui inside the container ────────
// Same gating semantics as the host (无热重载: decided at container BUILD,
// i.e. per-runtime). The host forwards AGENT_A2UI_ENABLED from isA2UIEnabled().
const A2UI_ENABLED = process.env.AGENT_A2UI_ENABLED === "true";
if (A2UI_ENABLED) {
  // Both SDK timeout walls must exceed the human-wait budget (default 15 min)
  // or the 60s default kills the blocking call. max(existing, submit+30s) —
  // mirrors ai-client.ts local wiring. The container's SDK subprocess inherits
  // process.env (agent-entry passes no env option), so setting these at boot
  // is the whole fix.
  const wall = (name: string) => {
    const existing = Number.parseInt(process.env[name] ?? "", 10);
    const floor = Number.isFinite(existing) && existing > 0 ? existing : 0;
    process.env[name] = String(Math.max(floor, resolveSubmitTimeoutMs() + 30_000));
  };
  wall("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT");
  wall("MCP_TOOL_TIMEOUT");
}

// Container-side pendings for in-flight show_ui calls, keyed by the
// CONTAINER-generated requestId (never the host blockId). Belt-and-braces
// timer: if the host↔container WS dies, the host's finishPendingA2Ui forward
// never arrives — this bounds the hang to the same submit timeout instead of
// the SDK wall.
type PendingA2Ui = { resolve: (result: ShowUiResult) => void; timer: ReturnType<typeof setTimeout> };
const pendingA2Ui = new Map<string, PendingA2Ui>();

function finishA2Ui(requestId: string, result: ShowUiResult) {
  const pending = pendingA2Ui.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingA2Ui.delete(requestId);
  pending.resolve(result);
}

// Parse tool configuration from environment.
// Default-safe: only Read/Grep/Glob. Bash/Write/Edit require explicit opt-in.
const SAFE_DEFAULT_TOOLS = ["Read", "Grep", "Glob"];

const TOOLS: string[] = process.env.AGENT_TOOLS
  ? JSON.parse(process.env.AGENT_TOOLS)
  : SAFE_DEFAULT_TOOLS;

const ALLOWED_TOOLS: string[] = process.env.AGENT_ALLOWED_TOOLS
  ? JSON.parse(process.env.AGENT_ALLOWED_TOOLS)
  : TOOLS;

// ─── Parse AGENT_SDK_OPTIONS (injected by CapabilityProvider via DockerRuntime) ───

type SdkOptionsEnv = {
  disallowedTools?: string[];
  plugins?: Array<{ type: "local"; path: string }>;
  mcpServers?: Record<string, unknown>;
  strictMcpConfig?: boolean;
  skills?: string[] | "all";
  systemPrompt?: string;
  appendSystemPrompt?: string;
  additionalDirectories?: string[];
  maxTurns?: number;
  // Stage 2 (coarse global model management): platform-wide default model
  // alias from CapabilityProvider.resolve (runtime-settings.defaultModel) via
  // AGENT_SDK_OPTIONS. Takes precedence over AGENT_MODEL (compat fallback).
  model?: string;
};

const sdkOptions: SdkOptionsEnv = process.env.AGENT_SDK_OPTIONS
  ? JSON.parse(process.env.AGENT_SDK_OPTIONS)
  : {};

// Path validation: plugins must live under /opt/agent/plugins/
const VALID_PLUGIN_PREFIX = "/opt/agent/plugins/";
const validatedPlugins = (sdkOptions.plugins || []).filter((p) => {
  if (!p.path.startsWith(VALID_PLUGIN_PREFIX)) {
    console.warn(`[agent-entry] BLOCKED plugin path: ${p.path} (must start with ${VALID_PLUGIN_PREFIX})`);
    return false;
  }
  return true;
});

// Path validation: additionalDirectories must NOT include /workspace (not a capability source)
const validatedAdditionalDirs = (sdkOptions.additionalDirectories || []).filter((d) => {
  if (d.startsWith("/workspace")) {
    console.warn(`[agent-entry] BLOCKED additionalDirectory: ${d} (/workspace is not a capability source)`);
    return false;
  }
  return true;
});

// MCP validation: local MCP commands must reference /opt/agent/mcp/ paths
const VALID_MCP_PREFIX = "/opt/agent/mcp/";
const validatedMcpServers: Record<string, unknown> = {};
for (const [name, config] of Object.entries(sdkOptions.mcpServers || {})) {
  const cfg = config as any;
  if (cfg?.command && typeof cfg.command === "string" && !cfg.command.startsWith(VALID_MCP_PREFIX)) {
    console.warn(`[agent-entry] BLOCKED MCP server '${name}': command must start with ${VALID_MCP_PREFIX}`);
    continue;
  }
  validatedMcpServers[name] = config;
}

const DISALLOWED_TOOLS: string[] = sdkOptions.disallowedTools || [];

// SDK 0.2.120+: enable skills via the `skills` option instead of 'Skill' in allowedTools.
const SKILLS = sdkOptions.skills;

// ─── User memory exact-path write rule (plan Task 4, docker side) ───
// The decision + byte-projection logic lives in the SHARED, zero-dependency
// core (server/user-memory-permission-core.ts), which is copied into this image
// and also imported by the host hook (server/user-memory-permission.ts) — so
// the auto-approve rule has ONE definition and cannot drift between runtimes.
// Per-side here: the fixed /user-memory/MEMORY.md path and the quota from
// USER_MEMORY_QUOTA_BYTES (forwarded by DockerRuntime).
const USER_MEMORY_FILE = "/user-memory/MEMORY.md";
const USER_MEMORY_QUOTA = parseInt(process.env.USER_MEMORY_QUOTA_BYTES || String(64 * 1024), 10);

// Returns a decision when this call targets EXACTLY the user memory file
// (Write/Edit); otherwise null (caller falls through to the approval gate).
function decideUserMemoryWrite(input: any): MemoryWriteDecision | null {
  const tool: string = input?.tool_name;
  if (!MEMORY_WRITE_TOOLS.has(tool)) return null;
  const target = input?.tool_input?.[MEMORY_PATH_ARG];
  if (typeof target !== "string") return null;
  return decideMemoryWriteCore({
    tool,
    toolInput: (input.tool_input ?? {}) as Record<string, unknown>,
    candidatePath: target,
    memoryFilePath: USER_MEMORY_FILE,
    quotaBytes: USER_MEMORY_QUOTA,
    readFile: (p) => fs.readFileSync(p, "utf8"),
  });
}

const SYSTEM_PROMPT = sdkOptions.systemPrompt
  || process.env.AGENT_SYSTEM_PROMPT
  || `You are a helpful AI assistant. You can help users with a wide variety of tasks including:
- Answering questions
- Writing and editing text
- Coding and debugging
- Analysis and research
- Creative tasks

Be concise but thorough in your responses.`;

const APPEND_SYSTEM_PROMPT = sdkOptions.appendSystemPrompt || undefined;

console.log(`[agent-entry] Tools: ${JSON.stringify(TOOLS)}, AllowedTools: ${JSON.stringify(ALLOWED_TOOLS)}, DisallowedTools: ${JSON.stringify(DISALLOWED_TOOLS)}`);
console.log(`[agent-entry] Plugins: ${validatedPlugins.length}, MCP: ${Object.keys(validatedMcpServers).length}, strictMcpConfig: true, AdditionalDirs: ${validatedAdditionalDirs.length}, Skills: ${JSON.stringify(SKILLS)}`);

// --- MessageQueue (same pattern as ai-client.ts) ---
type UserMessage = {
  type: "user";
  message: { role: "user"; content: string };
};

class MessageQueue {
  private messages: UserMessage[] = [];
  private waiting: ((msg: UserMessage) => void) | null = null;
  private closed = false;

  push(content: string) {
    const msg: UserMessage = {
      type: "user",
      message: { role: "user", content },
    };
    if (this.waiting) {
      this.waiting(msg);
      this.waiting = null;
    } else {
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<UserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        yield await new Promise<UserMessage>((resolve) => {
          this.waiting = resolve;
        });
      }
    }
  }

  close() {
    this.closed = true;
  }
}

// --- Approval handling ---
type PendingApproval = {
  resolve: (result: { decision: "allow" | "deny"; reason?: string }) => void;
};

const pendingApprovals = new Map<string, PendingApproval>();

function handleApprovalResponse(id: string, approved: boolean, message?: string) {
  const pending = pendingApprovals.get(id);
  if (pending) {
    pending.resolve(
      approved
        ? { decision: "allow" }
        : { decision: "deny", reason: message || "User denied" }
    );
    pendingApprovals.delete(id);
  }
}

// --- Main ---
const queue = new MessageQueue();
const abortController = new AbortController();
let mainClient: WebSocket | null = null;
const startTime = Date.now();
let agentStatus: "starting" | "ready" | "busy" | "idle" | "waiting_for_approval" | "shutting_down" = "starting";
let capturedSessionId: string | undefined;

function sendToMain(msg: IPCFromContainer) {
  if (mainClient && mainClient.readyState === WebSocket.OPEN) {
    mainClient.send(JSON.stringify(msg));
  }
}

// Resume support: if CLAUDE_SESSION_ID is set, resume that session
const resumeSessionId = process.env.CLAUDE_SESSION_ID || undefined;
if (resumeSessionId) {
  console.log(`[agent-entry] Resuming session: ${resumeSessionId}`);
}

// Start SDK query
const MAX_TURNS = typeof sdkOptions.maxTurns === "number" ? sdkOptions.maxTurns : 100;

// A2UI v2 (S3): the in-process show_ui server. Runtime infrastructure, NOT a
// control-plane capability — deliberately outside validatedMcpServers (it has
// no `command`, so the /opt/agent/mcp/ guard doesn't apply to it by design).
// Handler: ship the block to the host, park on the requestId promise; the
// host's Session owns persistence/broadcast/pending and forwards the terminal
// result back via a2ui_response.
const a2uiServer = A2UI_ENABLED
  ? createA2UISdkMcpServer(async (call) => {
      const requestId = crypto.randomUUID();
      sendToMain({
        type: "a2ui_request",
        requestId,
        block: call.block,
        ...(call.timeoutSec !== undefined ? { timeoutSec: call.timeoutSec } : {}),
      });
      // FALLBACK only (Codex S3 review #3): the HOST owns the normal timeout
      // transition (it expires the UI card + broadcasts + records audit at the
      // deadline). The container arms its timer AFTER the host deadline so it
      // fires only when the a2ui_response never arrives (dead IPC). Stays
      // below the SDK wall (wall = submit + 30s ≥ timeout + 30s).
      const fallbackMs = resolveShowUiTimeout(call.timeoutSec) + 5_000;
      return await new Promise<ShowUiResult>((resolve) => {
        const timer = setTimeout(() => {
          finishA2Ui(requestId, {
            status: "timeout",
            blockId: requestId,
            message: "宿主响应未送达（IPC 中断），按超时处理",
          });
        }, fallbackMs);
        pendingA2Ui.set(requestId, { resolve, timer });
      });
    })
  : undefined;

const mergedMcpServers: Record<string, unknown> = {
  ...validatedMcpServers,
  // platform-web-tools (Agent OS W1): the platform built-in in-process instance
  // (bailian_search + web_fetch), NOT ordinary MCP — it does not go through
  // data/mcp.json → entitlement → activation → mount → stdio, so the
  // /opt/agent/mcp/ prefix guard must NOT apply to it. Created once per
  // query() lifecycle (this process). DASHSCOPE_API_KEY is read from container
  // ENV inside the factory, never from AGENT_SDK_OPTIONS (that blob is
  // logged/inspectable).
  "platform-web-tools": createPlatformWebToolsServer(),
  ...(a2uiServer ? { [A2UI_INTERNAL_MCP_NAME]: a2uiServer } : {}),
};
// The reserved name must WIN when A2UI is on (Codex S3 review #1) — but say
// so loudly if a control-plane MCP tried to claim it.
if (a2uiServer && A2UI_INTERNAL_MCP_NAME in validatedMcpServers) {
  console.warn(
    `[agent-entry] control-plane MCP named '${A2UI_INTERNAL_MCP_NAME}' is shadowed by the internal A2UI server`
  );
}

const outputIterator = query({
  prompt: queue as any,
  options: {
    maxTurns: MAX_TURNS,
    // Stage 2 precedence: sdkOptions.model (control plane, resolve →
    // runtime-settings.defaultModel) > AGENT_MODEL env (compat fallback) > "opus".
    // Mirrors the local chain (ai-client resolveLocalModel).
    model: sdkOptions.model || process.env.AGENT_MODEL || "opus",
    tools: TOOLS,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS.length > 0 ? DISALLOWED_TOOLS : undefined,
    ...(SKILLS !== undefined ? { skills: SKILLS } : {}),
    systemPrompt: SYSTEM_PROMPT,
    ...(APPEND_SYSTEM_PROMPT ? { appendSystemPrompt: APPEND_SYSTEM_PROMPT } : {}),
    ...(validatedPlugins.length > 0 ? { plugins: validatedPlugins } : {}),
    // mcpServers: validated stdio MCP ∪ platform-web-tools (built-in in-process)
    // ∪ the internal A2UI server when enabled — see mergedMcpServers above.
    ...(Object.keys(mergedMcpServers).length > 0 ? { mcpServers: mergedMcpServers as any } : {}),
    // Platform invariant (Phase 3): ignore ALL .mcp.json file discovery so a
    // planted /workspace/.mcp.json cannot bypass the control plane. Hardcoded
    // true here as the data-plane execution boundary — independent of whether
    // the bundle requested it, and applies even when mcpServers is empty.
    strictMcpConfig: true,
    // S3b (Appendix A.1): partial/stream events for streaming preview. Same
    // runtime-infra switch as local (agent-entry forwards the host env).
    // AGENT_STREAMING_ENABLED=false restores exact whole-frame behavior.
    ...(isStreamingEnabled() ? { includePartialMessages: true } : {}),
    ...(validatedAdditionalDirs.length > 0 ? { additionalDirectories: validatedAdditionalDirs } : {}),
    persistSession: true,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    abortController,
    hooks: {
      PreToolUse: [{
        hooks: [async (input: any, toolUseID: string | undefined) => {
          // ── A2UI v2 (S3) ─────────────────────────────────────────
          // Bypass for the in-process show_ui tool (EXACT name — not a
          // prefix), GATED on A2UI_ENABLED (Codex S3 review #1): with A2UI
          // off there is no internal server, and a governed MCP that happens
          // to be named "a2ui" exposing "show_ui" would otherwise ride the
          // same exact tool name past the approval gate.
          if (A2UI_ENABLED && input.tool_name === SHOW_UI_TOOL_NAME) {
            return {};
          }

          // ── Platform Guard ───────────────────────────────────────
          // Auto-approve allowed tools. "Skill" only loads skill instructions
          // (no destructive side effect) and is enabled via the `skills` option,
          // so auto-approve it here even though it is no longer in allowedTools.
          const platformAllowed = ALLOWED_TOOLS.includes(input.tool_name) || input.tool_name === "Skill";

          if (platformAllowed) {
            // Platform allows this tool.
            // Phase 6 (A2, Route A): app hook plugins are loaded via sdkOptions.plugins
            // and run as native SDK hooks. The platform inline guard's deny wins
            // (experiment-verified). updatedInput from plugin hooks is treated as
            // unsupported trusted-code policy — path safety is enforced by the
            // container sandbox, not hook precedence.
            return {};
          }

          // Plan Task 4: auto-allow Write/Edit to EXACTLY /user-memory/MEMORY.md
          // (quota-enforced). Any other Write/Edit — CLAUDE.md, /workspace/input,
          // another user's file — returns null and falls through to approval below.
          const memDecision = decideUserMemoryWrite(input);
          if (memDecision) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: memDecision.decision,
                permissionDecisionReason: memDecision.reason,
              },
            };
          }

          // ── Platform requires approval (not in allowedTools) ─────
          // Request human approval (existing behavior).
          // App hook plugins may also run for this event (merged by SDK) and can
          // return deny — which wins (experiment-verified deny-wins semantics).
          const id = toolUseID || crypto.randomUUID();
          sendToMain({
            type: "sdk_event",
            event: {
              type: "approval_request",
              id,
              toolName: input.tool_name,
              toolInput: input.tool_input,
              toolUseId: toolUseID || "",
            },
          });
          // Wait for response
          return new Promise((resolve) => {
            pendingApprovals.set(id, {
              resolve: (result) => {
                resolve({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: result.decision,
                    permissionDecisionReason: result.reason,
                  },
                });
              },
            });
          });
        }] as HookCallback[],
      }],
    },
    stderr: (data: string) => {
      console.error(`[claude-stderr] ${data.trimEnd()}`);
    },
  },
})[Symbol.asyncIterator]();

// Stream SDK events to main process
async function streamEvents() {
  try {
    while (true) {
      const { value, done } = await outputIterator.next();
      if (done) break;

      // Capture session_id
      if (value.session_id) {
        if (!capturedSessionId) {
          capturedSessionId = value.session_id;
          sendToMain({ type: "session_id", sessionId: value.session_id });
        }
        agentStatus = "busy";
      }
      if (value.type === "result") {
        const v = value as any;
        const resultPreview = typeof v.result === "string" ? v.result.slice(0, 800) : JSON.stringify(v.result)?.slice(0, 800);
        console.log(`[agent-entry] SDK result subtype=${v.subtype}, is_error=${v.is_error}, has_result=${typeof v.result === "string"}`);
        if (v.is_error || v.subtype !== "success") {
          console.log(`[agent-entry] result body: ${resultPreview}`);
          if (v.message) console.log(`[agent-entry] result.message: ${JSON.stringify(v.message).slice(0, 800)}`);
        }
      }

      sendToMain({ type: "sdk_event", event: value });
    }
    sendToMain({ type: "stopped" });
  } catch (error) {
    sendToMain({ type: "error", error: (error as Error).message });
  }
}

// Start WebSocket server
const wss = new WebSocketServer({ port: PORT });

let streamStarted = false;

wss.on("connection", (ws) => {
  console.log("[agent-entry] Main process connected");
  mainClient = ws;
  if (!streamStarted) {
    streamStarted = true;
    streamEvents();
  }

  ws.on("message", (data) => {
    try {
      const msg: IPCToContainer = JSON.parse(data.toString());

      switch (msg.type) {
        case "user_message":
          console.log(`[agent-entry] Received user_message (${msg.content.length} chars)`);
          queue.push(msg.content);
          break;
        case "approval_response":
          handleApprovalResponse(msg.id, msg.approved, msg.message);
          break;
        case "a2ui_response":
          // Host resolved the blocking show_ui call (submitted/timeout/cancelled)
          finishA2Ui(msg.requestId, msg.result);
          break;
        case "abort":
          abortController.abort();
          break;
        case "ping":
          sendToMain({ type: "pong" });
          break;
        case "health_check":
          sendToMain({
            type: "health_status",
            requestId: msg.requestId,
            status: agentStatus,
            sdkSessionId: capturedSessionId,
            pendingApprovals: pendingApprovals.size,
            queueDepth: 0,
            uptimeMs: Date.now() - startTime,
          });
          break;
        case "shutdown":
          gracefulShutdown(msg.reason, msg.deadlineMs);
          break;
      }
    } catch (err) {
      console.error("[agent-entry] Failed to parse message:", err);
    }
  });

  ws.on("close", () => {
    console.log("[agent-entry] Main process disconnected");
    mainClient = null;
  });
});

wss.on("listening", () => {
  console.log(`[agent-entry] WebSocket server listening on port ${PORT}`);
});

async function gracefulShutdown(reason: string, deadlineMs = 5000) {
  if (agentStatus === "shutting_down") return;
  agentStatus = "shutting_down";
  console.log(`[agent-entry] Graceful shutdown: ${reason} (deadline: ${deadlineMs}ms)`);

  sendToMain({ type: "draining", reason });

  // Deny all pending approvals
  for (const [id, pending] of pendingApprovals) {
    pending.resolve({ decision: "deny", reason: `Shutdown: ${reason}` });
    pendingApprovals.delete(id);
  }

  // A2UI v2 (S3): cancel all blocking show_ui calls — the SDK turn must get
  // its cancelled tool_result instead of hanging into the force-abort.
  for (const [requestId] of [...pendingA2Ui]) {
    finishA2Ui(requestId, {
      status: "cancelled",
      blockId: requestId,
      message: `容器关闭: ${reason}`,
    });
  }

  // Wait for grace period, then force abort
  const timer = setTimeout(() => {
    console.log("[agent-entry] Deadline reached, force aborting");
    abortController.abort();
    queue.close();
  }, deadlineMs);

  // Send final stopped with session ID
  sendToMain({ type: "stopped" });

  // Cleanup after short delay
  setTimeout(() => {
    clearTimeout(timer);
    wss.close(() => {
      process.exit(0);
    });
  }, Math.min(deadlineMs + 1000, 10000));
}

// Handle shutdown signals
// Delay SIGTERM handler registration — tsx sends SIGTERM to itself during startup
// to suppress Node.js warnings; registering early would trigger graceful shutdown immediately.
setTimeout(() => {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}, 1000);
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
