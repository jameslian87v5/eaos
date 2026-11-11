import { AgentSession, type AgentSessionOptions, type PreToolUseHandler } from "./ai-client.js";
import { isA2UIEnabled } from "./a2ui-prompt.js";
import { A2UI_INTERNAL_MCP_NAME, createA2UISdkMcpServer } from "./a2ui-tool.js";
import type { ShowUiCall, ShowUiResult } from "./a2ui-schema.js";

// --- AgentRuntime interface ---
// Defines the contract between Session (orchestration) and agent execution (SDK layer).
// Session should ONLY depend on this interface, never on AgentSession directly.

export type RuntimeStatus = "starting" | "running" | "paused" | "stopping" | "stopped" | "crashed" | "removed";

export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentRuntimeOptions {
  // Tools available to the agent
  tools?: string[];
  // Tools that auto-execute without approval
  allowedTools?: string[];
  // Called for tools NOT in allowedTools
  onPreToolUse?: PreToolUseHandler;
  // Called when the SDK session_id is first captured
  onSessionId?: (sessionId: string) => void;
  // Claude session ID for resuming a previous session
  resume?: string;
  // Full capability bundle from CapabilityProvider (Docker mode)
  capabilityBundle?: import("./capability-provider.js").CapabilityBundle;
  // Current capability configVersion (MP4c diagnostics) — sha256 of normalized
  // control-plane inputs. Persisted in resolved_snapshot; compared on warmResume
  // to detect config drift (R1). Computed by the caller (which has full ctx).
  configVersion?: string;
  // Local-mode path confinement roots (L1 workspace guard). Absolute host dirs
  // that path-taking tools (Read/Grep/Glob/Write/Edit) are confined to. Docker
  // mode ignores this — its confinement lives in docker/agent-entry.ts.
  workspaceRoots?: string[];
  // Authenticated user's MEMORY.md host path (local mode). See ai-client.ts.
  userMemoryPath?: string;
  // A2UI v2 (S2): blocking show_ui callback. When set AND A2UI is enabled,
  // buildLocalSessionOptions injects the in-process a2ui MCP server; its
  // handler resolves when the user submits the card (or timeout/cancel).
  // Docker mode (S3) does NOT use this field — the container builds its own
  // instance and talks a2ui_request/a2ui_response over WS IPC.
  onShowUi?: (call: ShowUiCall) => Promise<ShowUiResult>;
}

export interface AgentRuntime {
  /**
   * Send a user message to the agent.
   *
   * S1 (resilience plan) contract: delivery failure MUST throw — a runtime
   * whose transport is dead (docker IPC closed, local SDK stream closed)
   * never silently swallows a message. Callers (Session) catch and surface
   * a durable, user-visible error.
   */
  sendMessage(content: string): void;

  /** Get the async event stream from the agent */
  getEventStream(): AsyncIterable<RuntimeEvent>;

  /** Route an approval response back to the runtime (for Docker IPC) */
  handleApprovalResponse?(response: { id: string; approved: boolean; message?: string }): boolean;

  /** Route a terminal show_ui result back to the container (A2UI v2, Docker IPC) */
  forwardA2UiResult?(requestId: string, result: ShowUiResult): void;

  /** Abort the current agent execution */
  abort(): void;

  /** Close the runtime and release resources */
  close(): void;

  /** Get the current runtime status */
  getStatus(): RuntimeStatus;

  /**
   * S2 (resilience plan): register the (single) death listener. Fire contract:
   * idempotent — exactly one notification per runtime lifecycle; a listener
   * registered AFTER death fires immediately. `reason` is metadata only.
   * Session (the cache owner) uses this to invalidate its cached runtime;
   * recovery is triggered by the next user message, never here.
   */
  setDeathListener?(listener: (reason: string) => void): void;
}

/** Factory function type for creating runtimes */
export type RuntimeFactory = (options?: AgentRuntimeOptions) => AgentRuntime;

/** Default factory: creates a LocalAgentRuntime */
export const createLocalRuntime: RuntimeFactory = (options) => new LocalAgentRuntime(options);

// M3-S1 (additive): local-sandbox (MicroVM) runtime factory — a PEER adapter,
// not yet wired into Session/runtime selection (next M3 stage wires it in
// small steps). Production stays `local`/`docker`; this export changes no
// existing behavior. Unavailability throws MicrosandboxUnavailableError —
// never a silent fallback to plain local.
export { createMicrosandboxRuntime, MicrosandboxUnavailableError } from "./microsandbox-runtime.js";

// --- LocalAgentRuntime ---
// Wraps the existing AgentSession for in-process execution.
// Preserves the MessageQueue pattern exactly as-is.

/**
 * Map AgentRuntimeOptions → AgentSessionOptions. Phase B: when a
 * capabilityBundle is present (local resolves via the control plane), forward
 * its sdkOptions — tools/allowedTools: options WINS (carries ALLOWED_TOOLS env
 * override, server.ts); bundle-only fields from sdk, INCLUDING the Stage 2
 * model alias (resolve → runtime-settings.defaultModel; the only source —
 * never a client-supplied value). Pure + exported so the mapping (and the
 * model passthrough) is unit-testable without starting a real SDK query.
 */
export function buildLocalSessionOptions(options?: AgentRuntimeOptions): AgentSessionOptions {
  const sdk = options?.capabilityBundle?.sdkOptions;
  // A2UI v2 (S2): runtime-infrastructure tool (same class as the PreToolUse
  // hook), injected here — NOT via the capability bundle. Gated at build time
  // per the 无热重载 convention: applies to NEW runtimes only.
  const a2ui =
    options?.onShowUi && isA2UIEnabled()
      ? {
          [A2UI_INTERNAL_MCP_NAME]: createA2UISdkMcpServer(options.onShowUi),
        }
      : undefined;
  return {
    tools: options?.tools ?? sdk?.tools,
    allowedTools: options?.allowedTools ?? sdk?.allowedTools,
    disallowedTools: sdk?.disallowedTools,
    skills: sdk?.skills,
    plugins: sdk?.plugins,
    systemPrompt: sdk?.systemPrompt,
    appendSystemPrompt: sdk?.appendSystemPrompt,
    model: sdk?.model,
    onPreToolUse: options?.onPreToolUse,
    resume: options?.resume,
    workspaceRoots: options?.workspaceRoots,
    userMemoryPath: options?.userMemoryPath,
    ...(a2ui ? { mcpServers: a2ui } : {}),
  };
}

export class LocalAgentRuntime implements AgentRuntime {
  private agentSession: AgentSession;
  private status: RuntimeStatus = "running";
  private claudeSessionId: string | null = null;
  private onSessionId?: (sessionId: string) => void;
  // S2: death notification parity with DockerAgentRuntime.
  private deathListener: ((reason: string) => void) | null = null;
  private deathNotified = false;

  constructor(options?: AgentRuntimeOptions) {
    this.onSessionId = options?.onSessionId;
    this.agentSession = new AgentSession(buildLocalSessionOptions(options));
    this.status = "running";
  }

  setDeathListener(listener: (reason: string) => void): void {
    this.deathListener = listener;
    if (this.deathNotified) {
      listener("local_sdk_stream_ended");
    }
  }

  private notifyDead(reason: string) {
    if (this.deathNotified) return;
    this.deathNotified = true;
    this.deathListener?.(reason);
  }

  sendMessage(content: string): void {
    this.agentSession.sendMessage(content);
  }

  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  async *getEventStream(): AsyncIterable<RuntimeEvent> {
    try {
      for await (const message of this.agentSession.getOutputStream()) {
        // Capture session_id from the first event that carries it
        if (!this.claudeSessionId && (message as any).session_id) {
          this.claudeSessionId = (message as any).session_id;
          this.onSessionId?.(this.claudeSessionId!);
        }
        yield message as RuntimeEvent;
      }
      // S1 (resilience plan): the SDK output stream ended without our close() —
      // the runtime is dead. Mark it so status consumers see the truth; the
      // stream-end itself surfaces via Session's listening loop.
      if (this.status === "running") {
        this.status = "crashed";
        this.notifyDead("local_sdk_stream_ended");
      }
    } catch (err) {
      // S1: stream ERROR (SDK death) marks the runtime dead too, before the
      // error propagates to Session's catch.
      if (this.status === "running") {
        this.status = "crashed";
        this.notifyDead("local_sdk_stream_error");
      }
      throw err;
    }
  }

  abort(): void {
    this.agentSession.abort();
    this.status = "stopped";
    // A user/admin stop is a deliberate death — the cached runtime must be
    // invalidated so the next message recovers instead of hitting the aborted
    // SDK stream (whose queue no longer has a consumer).
    this.notifyDead("aborted");
  }

  close(): void {
    this.agentSession.close();
    this.status = "stopped";
    this.notifyDead("closed");
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }
}
