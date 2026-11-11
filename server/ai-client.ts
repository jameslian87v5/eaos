import { query, type HookCallback, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import { getRuntimeSettings } from "./runtime-settings.js";
import { realpathRoots, isPathAllowed, resolveToolPath } from "./workspace-guard.js";
import { decideMemoryWrite } from "./user-memory-permission.js";
import { buildUserMemoryPrompt } from "./user-memory-prompt.js";
import { getQuotaBytes } from "./user-memory-service.js";
import { createPlatformWebToolsServer } from "./platform-web-tools.js";
import { SHOW_UI_TOOL_NAME, resolveSubmitTimeoutMs } from "./a2ui-tool.js";
import { isStreamingEnabled } from "./streaming-config.js";

// Default tool configuration. Web search/fetch are the platform built-in
// tools served by the in-process `platform-web-tools` MCP server (added to
// query() mcpServers below); the SDK's own WebSearch/WebFetch are removed so
// the model sees exactly one search/fetch pair.
const DEFAULT_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "mcp__platform-web-tools__bailian_search",
  "mcp__platform-web-tools__web_fetch",
];

const SYSTEM_PROMPT = `You are a helpful AI assistant. You can help users with a wide variety of tasks including:
- Answering questions
- Writing and editing text
- Coding and debugging
- Analysis and research
- Creative tasks

Be concise but thorough in your responses.`;

type UserMessage = {
  type: "user";
  message: { role: "user"; content: string };
};

/**
 * M8a (plan §9) fail-closed decision for a tool that is NOT in allowedTools.
 * "Skill" is the sole allow-exemption: the capability layer injects it into
 * `tools` but deliberately keeps it out of allowedTools (SDK 0.2.133+
 * deprecated listing "Skill" in allowedTools), and invoking it only loads
 * skill instructions — the model's subsequent real tool calls each re-enter
 * the PreToolUse hook and pass their own guard (capability-provider
 * DEFAULT_PROFILE documents this exemption). Everything else denies: the
 * previous fall-through `{}` let any approval-gated tool auto-execute
 * silently whenever approval was disabled ("空放行").
 */
export function decideUnapprovedTool(
  tool: string
): { decision: "allow" } | { decision: "deny"; reason: string } {
  if (tool === "Skill") return { decision: "allow" };
  return {
    decision: "deny",
    reason: `Tool "${tool}" is not in this runtime's allowed tool set and approval is not enabled; denied (fail-closed).`,
  };
}

// Simple async queue - messages go in via push(), come out via async iteration
class MessageQueue {
  private messages: UserMessage[] = [];
  private waiting: ((msg: UserMessage) => void) | null = null;
  private closed = false;

  push(content: string) {
    if (this.closed) {
      // S1 (resilience plan): a closed queue means the SDK stream is gone —
      // enqueueing would silently swallow the message. Delivery must fail.
      throw new Error("Agent session closed: message not delivered to the SDK stream");
    }
    const msg: UserMessage = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };

    if (this.waiting) {
      // Someone is waiting for a message - give it to them
      this.waiting(msg);
      this.waiting = null;
    } else {
      // No one waiting - queue it
      this.messages.push(msg);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<UserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!;
      } else {
        // Wait for next message
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

export type PreToolUseHandler = (toolName: string, toolInput: unknown, toolUseId: string) => Promise<{ decision: 'allow' | 'deny'; reason?: string }>;

export interface AgentSessionOptions {
  // Tools available to the agent
  tools?: string[];
  // Tools that auto-execute without approval (subset of tools)
  allowedTools?: string[];
  disallowedTools?: string[];
  // Called for tools NOT in allowedTools. If not set, such tools are DENIED
  // (M8a fail-closed) — Skill is the sole exemption (capability-layer
  // injection, instruction-loading only).
  onPreToolUse?: PreToolUseHandler;
  // Claude session ID for resuming a previous session
  resume?: string;
  // Max agent turns per run (defaults to runtime-settings value)
  maxTurns?: number;
  // Stage 2 (coarse global model management): model alias from the capability
  // bundle (CapabilityProvider.resolve → runtime-settings.defaultModel).
  // Undefined when local runs without a bundle — resolveLocalModel falls back
  // to AGENT_MODEL env, then the historical default "opus".
  model?: string;
  // Local-mode confinement roots (L1 workspace guard). Path-taking tools
  // (Read/Grep/Glob/Write/Edit) are confined to these host dirs. Docker mode
  // ignores this — its confinement lives in docker/agent-entry.ts.
  workspaceRoots?: string[];
  // Authenticated user's MEMORY.md host path. When set: the memory instruction
  // is appended to the system prompt, and Write/Edit to EXACTLY this path are
  // auto-allowed (quota-enforced). See user-memory-permission.ts.
  userMemoryPath?: string;
  // Phase B: capability-bundle fields (when local resolves via the control plane).
  // skills/plugins use HOST paths (local has no container). MCP is never injected
  // in local (Phase C). When absent, query() falls back to DEFAULT_TOOLS + SYSTEM_PROMPT.
  skills?: string[] | "all";
  plugins?: Array<{ type: "local"; path: string }>;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  // A2UI v2 (S2): in-process SDK MCP servers (the blocking a2ui tool). When
  // non-empty, the query env also overrides the two SDK timeout walls so a
  // long-blocking show_ui call is not killed at the 60s default.
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Stage 2 (coarse global model management) — the LOCAL runtime model chain:
 * bundle model (CapabilityProvider.resolve → runtime-settings.defaultModel)
 * > AGENT_MODEL env (compatibility fallback) > historical default "opus".
 * Pure function (env injectable) so the precedence is unit-testable without
 * starting a real SDK query. The container entry mirrors this precedence
 * (sdkOptions.model > AGENT_MODEL > "opus").
 */
export function resolveLocalModel(bundleModel?: string, envModel: string | undefined = process.env.AGENT_MODEL): string {
  return bundleModel || envModel || "opus";
}

export class AgentSession {
  private queue = new MessageQueue();
  private outputIterator: AsyncIterator<any> | null = null;
  private abortController = new AbortController();

  constructor(options?: AgentSessionOptions) {
    // L1 workspace confinement: materialize + realpath the allowed roots so the
    // guard can resolve target paths against them. A freshly-created chat may
    // not yet have its workspace dir → mkdirSync first so realpath succeeds.
    const realRoots = realpathRoots(
      (options?.workspaceRoots ?? []).map((r) => {
        try {
          fs.mkdirSync(r, { recursive: true });
        } catch {
          /* ignore; realpathRoots skips roots that are still missing */
        }
        return r;
      }),
    );
    // cwd is defense-in-depth (relative paths resolve inside the jail). Absolute
    // paths are still enforced by the PreToolUse hook below — cwd alone is NOT
    // sufficient. See workspace-guard.ts "KNOWN LIMITATION" (L1 is not OS-level).
    const cwd = realRoots[0];

    // Plan Task 4: exact-path write target for the authenticated user's MEMORY.md.
    // ensureMemory() ran in getOrCreateSession before this runtime was constructed,
    // so the file exists and realpath resolves. Null when memory is not configured.
    const userMemoryRealPath = options?.userMemoryPath
      ? (() => { try { return fs.realpathSync(options.userMemoryPath!); } catch { return null; } })()
      : null;

    // Plan Task 3: memory instruction appended to the system prompt (local mode
    // does not consume the capability-provider prompt, so it is injected here).
    const memoryAppend = userMemoryRealPath ? buildUserMemoryPrompt(userMemoryRealPath) : "";
    const composedAppend = [options?.appendSystemPrompt, memoryAppend].filter(Boolean).join("\n\n");

    // Path-taking tools and the input field that carries the target path.
    const PATH_TOOL_ARG: Record<string, string> = {
      Read: "file_path",
      Write: "file_path",
      Edit: "file_path",
      Glob: "path",
      Grep: "path",
    };

    // A2UI v2 (S2): the SDK has TWO timeout walls that kill MCP tool calls
    // longer than 60s (CLAUDE_CODE_STREAM_CLOSE_TIMEOUT + MCP_TOOL_TIMEOUT).
    // The blocking show_ui call waits for a HUMAN (default 15 min), so when
    // in-process MCP servers are present each wall is raised to AT LEAST the
    // submit timeout + buffer — max(existing, wall), never below either
    // (Codex S2 review #4: a configured 60s value must not kill a 15-min
    // call; a deliberately larger value is respected). env REPLACES the
    // subprocess env (sdk.d.ts) — spread process.env back in.
    const mcpServers = options?.mcpServers;
    const a2uiTimeoutWall = resolveSubmitTimeoutMs() + 30_000;
    const timeoutWall = (name: string): string => {
      const existing = Number.parseInt(process.env[name] ?? "", 10);
      const floor = Number.isFinite(existing) && existing > 0 ? existing : 0;
      return String(Math.max(floor, a2uiTimeoutWall));
    };
    const queryEnv =
      mcpServers && Object.keys(mcpServers).length > 0
        ? {
            ...process.env,
            CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: timeoutWall("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT"),
            MCP_TOOL_TIMEOUT: timeoutWall("MCP_TOOL_TIMEOUT"),
          }
        : undefined;

    // Start the query immediately with the queue as input
    // Cast to any - SDK accepts simpler message format at runtime
    this.outputIterator = query({
      prompt: this.queue as any,
      options: {
        maxTurns: options?.maxTurns ?? getRuntimeSettings().maxTurns,
        model: resolveLocalModel(options?.model),
        tools: options?.tools || DEFAULT_TOOLS,
        allowedTools: options?.allowedTools || options?.tools || DEFAULT_TOOLS,
        ...(options?.disallowedTools?.length ? { disallowedTools: options.disallowedTools } : {}),
        ...(options?.skills?.length ? { skills: options.skills } : {}),
        ...(options?.plugins?.length ? { plugins: options.plugins } : {}),
        systemPrompt: options?.systemPrompt || SYSTEM_PROMPT,
        ...(composedAppend ? { appendSystemPrompt: composedAppend } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // S3b (Appendix A.1): partial/stream events for streaming preview.
        // Runtime infra switch — never part of a capability bundle. Kill
        // switch AGENT_STREAMING_ENABLED=false restores exact current
        // behavior (SDK emits whole frames only).
        ...(isStreamingEnabled() ? { includePartialMessages: true } : {}),
        // Platform invariant (mirrors docker resolve, capability-provider.ts:321):
        // SDK ignores ALL file-based MCP discovery (cwd/.mcp.json, user settings,
        // plugins, managed-mcp.json) and uses ONLY the mcpServers option. Without
        // this, a planted /workspace/.mcp.json would let local mode auto-connect to
        // an UNGOVERNED MCP server, bypassing the /opt/agent/mcp/ prefix guard.
        // Local mode never injects ordinary MCP via resolve() (no capabilityBundle),
        // so discovery must be fully suppressed. (found during L1 review, 2026-07-24)
        strictMcpConfig: true,
        // Platform built-in web tools (bailian_search + web_fetch) as an
        // in-process MCP instance. This is NOT ordinary MCP — it does NOT flow
        // through data/mcp.json → entitlement → app allowlist → mount → stdio.
        // It is Runtime code, created once per query() lifecycle here. The red
        // line (Local injects ZERO ordinary mcp via resolve()) is preserved:
        // ordinary mcpServers stays empty; only this Runtime base-tool instance
        // is added. DASHSCOPE_API_KEY is read from process ENV inside the
        // factory — never from sdkOptions (which is logged/inspectable).
        mcpServers: {
          "platform-web-tools": createPlatformWebToolsServer(),
        },
        persistSession: true,
        ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(queryEnv ? { env: queryEnv } : {}),
        ...(cwd ? { cwd } : {}),
        ...(options?.resume ? { resume: options.resume } : {}),
        abortController: this.abortController,
        // Hook mounts whenever local confinement OR approval is active. Local
        // mode always passes workspaceRoots (session.ts), so the path guard
        // always runs — even when approval (onPreToolUse) is disabled.
        hooks: realRoots.length > 0 || options?.onPreToolUse ? {
          PreToolUse: [{
            hooks: [async (input: any, toolUseID: string | undefined) => {
              const tool: string = input.tool_name;

              // A2UI v2 (S2): unconditional bypass for the in-process show_ui
              // tool. It is runtime infrastructure, not a destructive operation;
              // if it reached the approval flow below, the card would deadlock
              // (the user cannot approve a card that has not rendered). Exact
              // name match — NOT a prefix (no other mcp__a2ui__* may ride along).
              if (tool === SHOW_UI_TOOL_NAME) {
                return {};
              }

              // L1: deny Bash outright in local mode — arbitrary commands cannot
              // be path-validated. Profiles needing Bash must use docker runtime.
              if (tool === "Bash") {
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'deny' as const,
                    permissionDecisionReason:
                      'Bash is not permitted in local runtime (cannot confine arbitrary commands); use docker runtime.',
                  },
                };
              }

              // L1: confine path-taking tools REGARDLESS of allowedTools. This is
              // the core fix — previously allowedTools bypassed the hook entirely,
              // so Read/Grep/Glob could read ANY host path (cross-tenant leak).
              const pathArg = PATH_TOOL_ARG[tool];
              if (pathArg && cwd && realRoots.length > 0) {
                const target = (input.tool_input as Record<string, unknown>)?.[pathArg];
                if (typeof target === "string") {
                  // Resolve relative targets against the SDK cwd (workspace root),
                  // NOT process.cwd() — otherwise in-workspace relative paths
                  // (file.txt, src/a.ts) are mis-resolved and wrongly denied.
                  // (Codex review evt_20260724013725)
                  const candidate = resolveToolPath(target, cwd);
                  const check = isPathAllowed(candidate, realRoots);
                  if (!check.ok) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: check.reason ?? 'path is outside the workspace jail',
                      },
                    };
                  }
                }
              }

              // Plan Task 4: auto-allow Write/Edit to the authenticated user's
              // EXACT memory path (quota-enforced). Any other path — including
              // CLAUDE.md, /workspace/input, or another user's file — returns null
              // and falls through to the normal approval/deny flow unchanged.
              if (userMemoryRealPath && cwd) {
                const mem = decideMemoryWrite({
                  tool,
                  toolInput: input.tool_input as Record<string, unknown>,
                  userMemoryRealPath,
                  cwd,
                  quotaBytes: getQuotaBytes(),
                });
                if (mem) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: mem.decision,
                      permissionDecisionReason: mem.reason,
                    },
                  };
                }
              }

              // Approval flow for tools NOT in allowedTools.
              const allowed = options?.allowedTools || options?.tools || DEFAULT_TOOLS;
              if (allowed.includes(tool)) {
                return {};
              }
              // M8a fail-closed + Skill exemption — see decideUnapprovedTool.
              if (tool === "Skill") {
                return {};
              }
              if (options?.onPreToolUse) {
                const result = await options.onPreToolUse(tool, input.tool_input, toolUseID || '');
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: result.decision,
                    permissionDecisionReason: result.reason,
                  },
                };
              }
              const unapproved = decideUnapprovedTool(tool);
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: unapproved.decision,
                  ...(unapproved.decision === "deny" ? { permissionDecisionReason: unapproved.reason } : {}),
                },
              };
            }] as HookCallback[],
          }],
        } : undefined,
      },
    })[Symbol.asyncIterator]();
  }

  // Send a message to the agent
  sendMessage(content: string) {
    this.queue.push(content);
  }

  // Get the output stream
  async *getOutputStream() {
    if (!this.outputIterator) {
      throw new Error("Session not initialized");
    }
    while (true) {
      const { value, done } = await this.outputIterator.next();
      if (done) break;
      yield value;
    }
  }

  // Abort the current execution
  abort() {
    this.abortController.abort();
  }

  close() {
    this.abortController.abort();
    this.queue.close();
  }
}
