import type { WSClient } from "./types.js";
import { type AgentRuntime, type RuntimeFactory, createLocalRuntime } from "./agent-runtime.js";
import { chatStore } from "./chat-store.js";
import { ApprovalManager, type ApprovalResponse } from "./approval.js";
import { eventStore, type AgentEventType, type AgentSessionRecord } from "./event-store.js";
import { fileWorkspaceService } from "./file-workspace-service.js";
import * as userMemoryService from "./user-memory-service.js";
import { splitA2UISegments, hasCompleteA2UIBlock, extractFailedA2UIRaw, A2UI_OPEN_TAG, A2UI_CLOSE_TAG } from "./a2ui-parser.js";
import type { A2UIBlock } from "./a2ui-types.js";
import { isA2UIEnabled } from "./a2ui-prompt.js";
import { SHOW_UI_TOOL_NAME, resolveShowUiTimeout } from "./a2ui-tool.js";
import { validateShowUiValues, parseShowUiArgs, type ShowUiCall, type ShowUiResult } from "./a2ui-schema.js";
import { wrapRuntimeInput, contextSummary, type TurnContext } from "./widget-context.js";
import { evaluateTokenTurn, type TokenUsage } from "./quota-service.js";
import { getEffectiveCompaction, contextEstimateTokens, evaluateAutoCompact } from "./compact-policy.js";
// Agent OS M3 (plan §7): runId execution audit. Session mints a runId at
// sendMessage, stamps every recorded event with it, and finalizes the run at
// the result event. The run row + redacted event summary live in
// agent-run-service.ts; this is the single data-plane call site.
import { agentRunService } from "./agent-run-service.js";
import type { Role } from "./request-context.js";
import type { SessionRecoveryFn } from "./runtime-recovery.js";
import { GovernedRecoveryError } from "./runtime-recovery.js";
import { v4 as uuidv4 } from "uuid";
import { A2UIDeltaScanner } from "./streaming-scanner.js";
import { isStreamingEnabled } from "./streaming-config.js";

/** Cheap stable hash for dedup; not cryptographic. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `${s.length}-${h}`;
}

/** Coerce a raw SDK `usage` object to non-negative integers; null when the
 *  event carried no usage object (old runtimes / command-only turns). Never
 *  throws — a malformed usage must not fail the result event. */
function extractTokenUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const inputTokens = num(r.input_tokens);
  const outputTokens = num(r.output_tokens);
  const cacheCreationTokens = num(r.cache_creation_input_tokens);
  const cacheReadTokens = num(r.cache_read_input_tokens);
  const total = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  return total === 0 ? null : { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, total };
}

const RUNTIME_MODE = process.env.RUNTIME_MODE || "local";

/**
 * A2UI v2 — unambiguous prefix for tool-origin blockIds (Codex S2 review #3).
 * Legacy prose ids are `${Date.now()}-${rand}` (digit-led), client history ids
 * are `hist-…`. A submit for a prefixed id that is not pending is a
 * repeat/late/forged tool submit → rejected outright; it can NEVER fall into
 * the legacy user-message path, regardless of any eviction bound.
 */
const A2UI_TOOL_BLOCK_ID_PREFIX = "tool-";

// ─── S3b (resilience plan Appendix A): host streaming state ─────────────
// Whole frames stay authoritative (persistence / A2UI splitting / result
// finalization); deltas are an in-memory preview ONLY. streamId is
// host-minted at `message_start` (V7: SDK uuids carry no correlation
// semantics) and terminalized at `message_stop` or the run-terminal sweep.
interface StreamBlock {
  kind: "text" | "thinking";
  // A.3 block map: the streaming preview unit is the BLOCK, not the message.
  // A final frame (thinking_block / assistant_message with correlation)
  // finalizes exactly one (streamId, index, kind) block — a thinking final
  // arriving before the stream's later text deltas is normal (V5).
  final: boolean;
}

interface StreamState {
  // SDK content-block index → block info (registered at content_block_start).
  blocks: Map<number, StreamBlock>;
  // Cumulative forwarded text+thinking bytes (A.3 gate ③, UTF-8 metric).
  bytes: number;
  capped: boolean;
  // Cross-delta partial-prefix scanner for <a2ui-json> tags (A.3).
  scanner: A2UIDeltaScanner;
}

// A.4 byte caps (UTF-8, Buffer.byteLength — NOT JS string length). Initial
// values per Appendix A.8; whole frames are the constant fallback.
const STREAM_FRAME_MAX_BYTES = 8192;
const STREAM_TOTAL_MAX_BYTES = 256 * 1024;

/**
 * S2 dispatch record contract (plan §S2-5). `user_turn` records mint a runId;
 * `internal` records (A2UI submits, regeneration feedback) attach to the
 * current active user turn and never mint their own.
 */
interface DispatchRecord {
  kind: "user_turn" | "internal";
  content: string;
  runId: string | null;
  // S2 rev2 (Codex fix 3): turn-local presentation state rides ON the record.
  // It is applied when the record DISPATCHES — a queued /compact must not
  // flip the active turn's result rendering (currentTurnIsCommand must
  // describe the dispatched turn, not the latest send).
  isCommand?: boolean;
  // S2 rev3 (Codex INV-D): redacted widget-context summary rides the record so
  // the audit event is emitted AT DISPATCH with the turn's minted runId — a
  // queued turn must never write it early with runId:null.
  widgetContext?: Record<string, unknown> | null;
}

// Optional hooks for ContainerManager state sync (Docker mode only)
export interface ContainerLifecycleHooks {
  onSubscriberCountChange(userId: string, chatId: string, count: number): void;
  onAgentBusyChange(userId: string, chatId: string, busy: boolean): void;
  onPendingApprovalChange(userId: string, chatId: string, pending: boolean): void;
}

export interface SDKInitSnapshot {
  model?: string;
  cwd?: string;
  tools: string[];
  slashCommands: string[];
  skills: string[];
  plugins: Array<{ name?: string; path?: string }>;
  mcpServers: string[]; // Phase 3: MCP server names the SDK connected to at init
  raw?: Record<string, unknown>;
}

// Agent OS M2 (r2 #2): categorize an approval resolution for the metadata-only
// `approval_decision` audit event. Sources: approved=true → approve; else the
// message is matched against the two constant deny reasons ApprovalManager
// emits (timeout / session-closed) so the category is deterministic, not a
// substring guess.
function categorizeApprovalDecision(
  response: ApprovalResponse
): "approve" | "reject" | "timeout" | "cancel" {
  if (response.approved) return "approve";
  const reason = response.message || "";
  if (reason === "Approval timed out") return "timeout";
  if (reason === "Session closed") return "cancel";
  return "reject";
}

// Session manages a single chat conversation with a long-lived agent
export class Session {
  public readonly chatId: string;
  public userId: string = "unknown";
  private subscribers: Set<WSClient> = new Set();
  private runtime: AgentRuntime | null = null;
  private runtimeReady: Promise<AgentRuntime>;
  // ─── S2 (resilience plan): dead-runtime self-healing state ─────────
  // Dispatch records replace the S1-era string buffer. A record captures the
  // delivery contract: `kind` (user turns vs internal feedback), the wrapped
  // runtime input, and the runId the turn's events are stamped with. The
  // active-record state machine: a record becomes active when DISPATCHED;
  // it is finalized by its turn's `result` frame or by a delivery error;
  // queued (never-dispatched) records advance FIFO and are the ONLY ones
  // replayed after recovery (at-most-once: dispatched-but-unconfirmed turns
  // are marked interrupted, never re-sent).
  //
  // S2 rev state model (Codex contract) — explicit flag tuple, not inferred
  // from runtime===null or the scalar currentRunId:
  //   initial pending : initialEnsurePending=true
  //                    → queue + wait; NO recovery, NO rebuild token, NO 2nd install
  //   initial failed  : initialEnsurePending=false, runtimeDead=true (never installed)
  //                    → governed recovery on next user action
  //   ready idle      : runtime alive, activeRecords=[]
  //                    → dispatch head record
  //   active turn     : runtime alive, activeRecords=[exactly one user_turn]
  //                    → process events; next user_turn waits (INV-1)
  //   dead with active: runtimeDead=true, activeRecords=[dispatched/unconfirmed]
  //                    → mark interrupted, never replay (INV-4)
  //   dead with queued: runtimeDead=true, activeRecords=[]
  //                    → governed recovery, then replay queued (INV-3)
  //   recovering      : recoveryInFlight!=null
  //                    → one deduped governed recovery (INV-6 epoch guard)
  //   stopped/closed  : closedFlag=true / recoveryEpoch bumped
  //                    → never install an in-flight recovery result
  private queuedRecords: DispatchRecord[] = [];
  private activeRecords: DispatchRecord[] = [];
  // Set when the runtime death listener fires; cleared when a recovered
  // runtime is installed. Recovery is triggered by the NEXT user message —
  // death alone never starts a rebuild.
  private runtimeDead = false;
  // True while the constructor's INITIAL runtime ensure is still unsettled.
  // A sendMessage arriving in that window must queue and wait for the promise
  // (install + flush) — triggering governed recovery here would race the
  // initial ensure, burn a rebuild-rate token, double-resolve the bundle, and
  // install twice. Only a REJECTED promise or a death notification is a
  // recovery trigger (S2 rev, Codex P3).
  private initialEnsurePending = false;
  // Monotonic per-Session runtime generation. The event listener captures it
  // at loop start; events from a runtime of an older generation (late frames
  // from a half-dead predecessor) are dropped, and the OLD loop's cleanup is
  // skipped once a newer generation owns the session.
  private runtimeGeneration = 0;
  // Bumped by stop()/close() — an in-flight recovery completing after an
  // invalidation must NOT install its runtime (zombie prevention).
  private recoveryEpoch = 0;
  private closedFlag = false;
  private recoveryInFlight: Promise<void> | null = null;
  // Server-injected governed recovery (see runtime-recovery.ts). Session never
  // touches ContainerManager/ensureRuntime directly — governance is re-run by
  // the owner of the control plane (server.ts). Absent → S1 fail-fast.
  private recoveryFn: SessionRecoveryFn | null = null;
  private runtimeOptions: Record<string, unknown> = {};
  private pendingFileNotices: string[] = [];
  private availableSlashCommands: string[] = [];
  private sdkInitSnapshot: SDKInitSnapshot | null = null;
  private currentTurnIsCommand = false;
  private sessionAllowedTools: Set<string> = new Set();
  private pendingApprovalById: Map<string, string> = new Map(); // id → toolName
  private isListening = false;
  private agentSessionRecord: AgentSessionRecord | null = null;
  private pendingClaudeSessionId: string | null = null;
  // M8g (capability hot reload): the SDK session id of the CURRENT runtime, for
  // resume on a voluntary swap (local mode; docker cold-resumes from the DB id).
  // Updated by the onSessionId callback every time a runtime reports its id.
  private claudeSessionId: string | null = null;
  // M8g: server-injected control-plane version probe (computeConfigVersion
  // closure). Null → hot reload disabled for this session (local-sandbox branch
  // injects no probe and no recovery fn).
  private configVersionProbe: (() => string) | null = null;
  // M8g: configVersion the current runtime was built from. Probed at
  // construction, re-synced on every swap, and re-synced by triggerRecovery
  // (the recovery resolves from a fresh control-plane read, so its install
  // reflects the probe taken at trigger time); drift at a safe turn boundary
  // triggers the swap.
  private builtConfigVersion: string | null = null;
  // M4 (Auto Compact, plan §4.3 phase 1) + S2 rev4: the compact CONTROL turn
  // state — `idle → compact_control_in_flight (/compact sent) → idle (compact
  // result completes the control turn)`. autoCompactInFlight gates BOTH
  // enqueueOrDispatch and flushQueuedRecords (queue release ONLY on the
  // compact result; compact_boundary is audit-only); awaitingAutoCompactResult
  // identifies the control turn's own result frame (run-unlinked) and makes
  // the trigger exactly-once — the /compact turn's result NEVER re-evaluates
  // the threshold. Runtime death terminalizes the control turn (gates reset +
  // auto_compact_interrupted audit, never replayed).
  private autoCompactInFlight = false;
  private awaitingAutoCompactResult = false;

  // Agent OS M3 (plan §7): the stable runId for the in-flight user-message
  // execution. Minted at sendMessage; cleared at result/stop. Null before the
  // first turn and between turns. Warm reconnect reuses the same in-memory
  // Session so currentRunId survives naturally; cold resume = new Session and a
  // fresh runId on the next sendMessage (the prior run was already finalized or
  // marked stopped before the container was torn down).
  private currentRunId: string | null = null;
  // The control-plane call context used to mint runs (role + orgId, both
  // server-trusted — set once at construction from getOrCreateSession).
  private runRole: Role = "user";
  private runOrgId: string | null = null;

  // ─── A2UI v2 (S2): blocking show_ui channel ─────────────────────
  // Pending tool-origin blocks keyed by blockId. INDEPENDENT of
  // pendingApprovalById — lifecycle (idle protection) reports the UNION.
  private pendingA2UiTool = new Map<
    string,
    {
      block: A2UIBlock;
      respond: (result: ShowUiResult) => void;
      timer: ReturnType<typeof setTimeout>;
      // M8g fix (Codex P1): generation that created the card. A stale
      // listener loop's cleanup cancels only its OWN generation's cards — a
      // hot swap drains the old stream while the new runtime already serves,
      // and an unscoped reject would kill the new generation's live card.
      gen: number;
    }
  >();
  // tool_use ids of show_ui calls, so the matching tool_result frames can be
  // filtered from the chat (no tool chip — the card IS the UI). Entries are
  // consumed (deleted) by the tool_result branch.
  private a2uiToolUseIds = new Set<string>();

  // ─── S3b (Appendix A): streaming preview state ────────────────────
  // Open streams keyed by host-minted streamId (insertion order = FIFO for
  // whole-frame block correlation). Delta frames never persist (A.6).
  private openStreams: Map<string, StreamState> = new Map();
  // The stream currently being fed by message_start..message_stop. The
  // host↔runtime transports are single-connection ordered (A2), so a
  // positional pointer is the correlation for content_block_* events.
  private currentStreamId: string | null = null;
  // Latest `system:thinking_tokens` estimate (metadata only) — attached to
  // thinking_block final frames (A.4 estimatedTokens?).
  private lastThinkingTokenEstimate: number | null = null;

  private approvalManager: ApprovalManager | null = null;
  private lifecycleHooks: ContainerLifecycleHooks | null = null;

  constructor(
    chatId: string,
    runtimeOrFactory: RuntimeFactory | Promise<AgentRuntime> = createLocalRuntime,
    lifecycleHooks?: ContainerLifecycleHooks,
    userId?: string,
    runCtx?: {
      role?: Role;
      orgId?: string;
      recovery?: SessionRecoveryFn;
      configVersionProbe?: () => string;
    }
  ) {
    this.lifecycleHooks = lifecycleHooks || null;
    this.chatId = chatId;
    if (runCtx?.role) this.runRole = runCtx.role;
    if (runCtx?.orgId) this.runOrgId = runCtx.orgId;
    if (runCtx?.recovery) this.recoveryFn = runCtx.recovery;
    // M8g: probe + baseline. Best-effort — a probe failure merely disables hot
    // reload for this session (messaging is never blocked by diagnostics).
    if (runCtx?.configVersionProbe) {
      this.configVersionProbe = runCtx.configVersionProbe;
      try {
        this.builtConfigVersion = this.configVersionProbe();
      } catch {
        this.builtConfigVersion = null;
      }
    }

    // Plan Task 2: provision the authenticated user's MEMORY.md before the local
    // runtime is built so its dir exists for realpathRoots confinement. The host
    // file is the single source of truth (docker bind-mounts the same dir).
    if (userId) {
      try {
        userMemoryService.ensureMemory(userId);
      } catch (err) {
        console.warn(`[Session ${chatId}] user memory provisioning failed:`, (err as Error).message);
      }
    }

    // Read tool config from environment or use defaults
    const approvalEnabled = process.env.APPROVAL_ENABLED === "true";
    const allowedTools = process.env.ALLOWED_TOOLS
      ? process.env.ALLOWED_TOOLS.split(",").map((t) => t.trim())
      : undefined;

    if (approvalEnabled) {
      this.approvalManager = new ApprovalManager();
      this.approvalManager.setApprovalRequestHandler((request) => {
        this.pendingApprovalById.set(request.id, request.toolName);
        this.broadcast({
          type: "approval_request",
          id: request.id,
          toolName: request.toolName,
          toolInput: request.toolInput,
          toolUseId: request.toolUseId,
          chatId: this.chatId,
        });
        // Agent OS M2: persist the approval request through the existing event
        // path (recordEvent -> eventStore.appendEvent), mirroring the docker
        // IPC branch in handleSDKMessage ("approval_request"). METADATA ONLY —
        // {toolName, toolId} — never the toolInput payload (codex r2 #3: docker
        // intentionally records only toolName + toolId; local now matches).
        this.recordEvent("approval_request", {
          toolName: request.toolName,
          toolId: request.toolUseId,
        });
        // Notify lifecycle: pending approval in flight
        this.notifyPendingChange();
      });
    }

    const runtimeOptions = {
      allowedTools,
      // L1 local-mode confinement: path-taking tools confined to this chat's
      // workspace dir, PLUS the authenticated user's memory dir (plan Task 2:
      // memory is an approved root, but cwd stays the chat workspace — the root
      // is NOT widened to data/ or the repo root).
      workspaceRoots: userId
        ? [fileWorkspaceService.getHostDir(this.chatId), userMemoryService.getHostDir(userId)]
        : [fileWorkspaceService.getHostDir(this.chatId)],
      // Plan Task 4: exact-path auto-write target for local mode.
      userMemoryPath: userId ? userMemoryService.getHostFile(userId) : undefined,
      onPreToolUse: approvalEnabled
        ? async (toolName: string, toolInput: unknown, toolUseId: string) => {
            // Auto-approve if user previously chose "always allow" for this tool
            if (this.sessionAllowedTools.has(toolName)) {
              return { decision: "allow" as const };
            }
            const response = await this.approvalManager!.requestApproval(
              this.chatId,
              toolName,
              toolInput as Record<string, unknown>,
              toolUseId
            );
            // Agent OS M2 (r2 #1 + #2): clear Session pending state for EVERY
            // resolution path (approve/reject/timeout/cancel) and persist a
            // metadata-only decision event. handleApprovalResponse only runs for
            // frontend-responded approvals; timeout + cancelAll resolve the
            // promise WITHOUT it, so without this clear the pending entry stays
            // lifecycle-protected/stale and no decision is audited.
            this.clearPendingApproval(response.id);
            this.recordEvent("approval_decision", {
              id: response.id,
              toolName,
              decision: categorizeApprovalDecision(response),
              reason: response.message || null,
            });
            if (response.approved) {
              return { decision: "allow" as const };
            } else {
              return {
                decision: "deny" as const,
                reason: response.message || "User denied this operation",
              };
            }
          }
        : undefined,
      onSessionId: (sessionId: string) => {
        console.log(`[Session ${this.chatId}] Captured claude session_id: ${sessionId}`);
        // M8g: remember the live id — a voluntary swap resumes from it.
        this.claudeSessionId = sessionId;
        if (this.agentSessionRecord) {
          eventStore.updateClaudeSessionId(this.agentSessionRecord.id, sessionId);
        } else {
          this.pendingClaudeSessionId = sessionId;
        }
      },
      // A2UI v2 (S2): blocking show_ui callback for the LOCAL runtime (docker
      // S3 builds its own in-container instance and speaks IPC instead — it
      // ignores this field). Gated at runtime BUILD time per the 无热重载
      // convention, same as the prose prompt in capability-provider.
      ...(isA2UIEnabled()
        ? { onShowUi: (call: ShowUiCall) => this.awaitShowUiSubmit(call) }
        : {}),
    };

    // S2: capture the full runtime options so the server-injected recovery can
    // rebuild with the same approval/session callbacks (governed recovery
    // overrides tools/allowedTools/bundle from a FRESH control-plane resolve).
    this.runtimeOptions = runtimeOptions;

    // Support both sync RuntimeFactory and async Promise<AgentRuntime>
    if (typeof runtimeOrFactory === "function") {
      // Synchronous factory (LocalAgentRuntime)
      this.installRuntime(runtimeOrFactory(runtimeOptions));
      this.runtimeReady = Promise.resolve(this.runtime!);
    } else {
      // Async runtime (Docker via containerManager.ensureRuntime)
      this.initialEnsurePending = true;
      this.runtimeReady = runtimeOrFactory.then((rt) => {
        this.initialEnsurePending = false;
        this.installRuntime(rt);
        this.flushQueuedRecords();
        return rt;
      });
      // S2: the INITIAL ensure itself failed (org denied at construction,
      // Docker down, ...). The runtime is dead-on-arrival. The failure is
      // surfaced either by the listener loop (S1 error path, when a turn
      // arrives) or by governed recovery (S2) — this catch only marks the
      // cache dead so the next user message triggers recovery instead of
      // hitting a permanently rejected runtimeReady.
      this.runtimeReady.catch((err: unknown) => {
        this.initialEnsurePending = false;
        this.runtimeDead = true;
        console.error(`[Session ${this.chatId}] initial runtime ensure failed:`, (err as Error).message);
        // Records queued while the ensure was pending still need a path to
        // the agent. Death alone never rebuilds; queued records do (they are
        // already persisted user turns whose invariant must hold).
        if (this.queuedRecords.length > 0) this.triggerRecovery();
      });
    }
  }

  // ─── S2: runtime install / death / recovery ─────────────────────

  /**
   * Install a runtime as the session's current one: bump the generation,
   * clear the dead flag, and register the death listener. Used by BOTH the
   * constructor path and governed recovery — one ownership outcome.
   */
  private installRuntime(rt: AgentRuntime): number {
    this.runtime = rt;
    this.runtimeDead = false;
    const gen = ++this.runtimeGeneration;
    rt.setDeathListener?.((reason) => this.handleRuntimeDeath(rt, reason));
    return gen;
  }

  /**
   * Runtime death notification (idempotent per runtime — the runtimes
   * guarantee exactly one fire). Invalidates the cached runtime; does NOT
   * start recovery (the next user message owns that trigger). Also performs
   * the turn-level cleanup for any dispatched-but-unconfirmed record: those
   * turns can never complete and are marked interrupted, never replayed
   * (at-most-once).
   */
  private handleRuntimeDeath(rt: AgentRuntime, reason: string) {
    if (rt !== this.runtime) return; // stale runtime (already replaced)
    if (this.runtimeDead) return;
    this.runtimeDead = true;
    // Metadata-only audit (no payloads) + lightweight status frame old
    // clients ignore.
    this.recordEvent("runtime_dead", { reason });
    this.broadcast({ type: "runtime_status", status: "dead", reason, chatId: this.chatId });
    this.finalizeInterruptedTurns();
  }

  /**
   * S1's stream-end cleanup body, callable from both death notification and
   * the listener loop's finally. Idempotent: every step is guarded by the
   * state it clears.
   */
  private finalizeInterruptedTurns() {
    // S2 rev4 (Codex round 4): the compact CONTROL turn dies with the runtime.
    // Reset both gates, audit metadata-only, and never replay /compact (it
    // was sent directly — it is NOT a queued record). After governed
    // recovery, queued user records dispatch normally.
    if (this.autoCompactInFlight || this.awaitingAutoCompactResult) {
      this.autoCompactInFlight = false;
      this.awaitingAutoCompactResult = false;
      this.recordEvent("auto_compact_interrupted", {});
    }
    // S2 rev (Codex P2): only DISPATCHED records are interrupted. A queued
    // (never-dispatched) record is replayable — a late death listener must
    // not turn it into a durable "本轮回复未完成" error. The guard is the
    // active-record set, not currentRunId (which no longer points at queued
    // turns).
    if (this.activeRecords.length > 0 && this.currentRunId) {
      this.broadcastError("Agent 运行时已断开，本轮回复未完成");
      this.markCurrentRunInterrupted();
    }
    // Records that were dispatched but never confirmed: their runs are
    // already marked interrupted above (markRunningAsStopped is
    // session-scoped). Finalize the records so FIFO state stays truthful.
    this.activeRecords = [];
    // Docker-mode pending approvals die with the stream — clear the pending
    // map so lifecycle protection doesn't hold a dead runtime hostage; the
    // container-side hook times out on its own.
    if (this.pendingApprovalById.size > 0) {
      this.pendingApprovalById.clear();
      this.notifyPendingChange();
    }
    if (this.lifecycleHooks && this.userId !== "unknown") {
      this.lifecycleHooks.onAgentBusyChange(this.userId, this.chatId, false);
    }
  }

  /**
   * M8g (capability hot reload): voluntary turn-boundary runtime swap.
   *
   * Compares the control-plane configVersion (server-injected probe) against
   * the version the current runtime was built from. On drift, at a SAFE idle
   * boundary only, the runtime is closed and the EXISTING governed recovery
   * path rebuilds it from a fresh resolve — so an admin's enable/approve takes
   * effect on the NEXT turn without the user manually stopping the session.
   *
   * Iron-rule safe window (a swap here kills nothing): no in-flight or queued
   * turn, no pending approval, no pending A2UI card, no compact, no recovery
   * already running, runtime alive. Anything else defers to the next boundary.
   *
   * Local mode resumes the SDK session from the captured claudeSessionId
   * (history continuity); docker relies on its existing cold-resume (DB
   * claudeSessionId → CLAUDE_SESSION_ID env). The rebuild rate limiter (S2)
   * bounds swap frequency — hot reload cannot stampede.
   */
  private maybeHotSwap(): boolean {
    if (!this.recoveryFn || !this.configVersionProbe) return false;
    if (this.closedFlag || this.initialEnsurePending || this.recoveryInFlight) return false;
    if (!this.runtime || this.runtimeDead) return false; // dead → the next message already recovers fresh
    if (this.autoCompactInFlight || this.awaitingAutoCompactResult) return false;
    if (this.activeRecords.length > 0 || this.queuedRecords.length > 0) return false;
    if (this.pendingApprovalById.size > 0 || this.pendingA2UiTool.size > 0) return false;
    let current: string | null = null;
    try {
      current = this.configVersionProbe();
    } catch {
      return false; // diagnostics must never break messaging
    }
    if (!current || current === this.builtConfigVersion) return false;

    const from = this.builtConfigVersion;
    this.builtConfigVersion = current;
    // Metadata-only audit: version hashes, never payloads.
    this.recordEvent("runtime_hot_reload", { from, to: current });
    const oldRuntime = this.runtime;
    // Pre-mark dead so enqueueOrDispatch queues (not dispatches into a closing
    // runtime) and so close()'s own death listener (idempotent guard) is a
    // no-op — the swap event above replaces the runtime_dead audit.
    this.runtimeDead = true;
    const resumeId = this.claudeSessionId;
    // Close FIRST (sync part flips the runtime status out of "running", so
    // docker's ensureRuntime falls through to cold resume), teardown finishes
    // in the background; the death listener is idempotent-guarded above.
    void Promise.resolve(oldRuntime.close()).catch(() => { /* already gone */ });
    // Trigger SYNCHRONOUSLY with the swap options — a later no-arg trigger
    // from enqueueOrDispatch would otherwise win the dedup race and drop the
    // resume option.
    this.triggerRecovery(resumeId ? { resume: resumeId } : undefined);
    return true;
  }

  /**
   * Trigger governed recovery (deduped). Only fires when the runtime is
   * actually dead/absent and a recovery function was injected. The captured
   * epoch invalidates the result if stop()/close()/admin stop happened while
   * the rebuild was in flight — a stale result is closed, never installed.
   *
   * M8g: `swapOpts` (voluntary hot-reload path ONLY) is merged over the captured
   * runtimeOptions — carries `resume` so the rebuilt local runtime reloads the
   * SDK session history. The involuntary (crash) path stays byte-identical.
   */
  private triggerRecovery(swapOpts?: Record<string, unknown>): void {
    if (this.closedFlag || this.recoveryInFlight || !this.recoveryFn) return;
    if (this.initialEnsurePending) return; // initial ensure owns this window
    if (!this.runtimeDead && this.runtime !== null) return;
    // M8g fix (Codex P1): sync the baseline to the control-plane version this
    // recovery will resolve from. The recovery fn re-computes the version at
    // resolve time (microseconds after this probe), so the runtime it installs
    // is built from exactly this version. Without the sync, an INVOLUNTARY
    // (crash) recovery installs a fresh runtime while the baseline still holds
    // the pre-crash version — the next result boundary sees false drift and
    // swaps the just-installed runtime a second time (wasted rebuild +
    // rate-limit token). Best-effort: a probe failure keeps the old baseline
    // and never blocks recovery itself.
    if (this.configVersionProbe) {
      try {
        this.builtConfigVersion = this.configVersionProbe();
      } catch { /* diagnostics must never break recovery */ }
    }
    const epoch = this.recoveryEpoch;
    this.broadcast({ type: "runtime_status", status: "recovering", chatId: this.chatId });
    this.recoveryInFlight = (async () => {
      let installed = false;
      try {
        const rt = await this.recoveryFn!(
          (swapOpts
            ? { ...this.runtimeOptions, ...swapOpts }
            : this.runtimeOptions) as any
        );
        if (this.closedFlag || epoch !== this.recoveryEpoch) {
          // Zombie prevention: the session was stopped/closed while the
          // rebuild ran. Close the result — never install it.
          try {
            await rt.close();
          } catch { /* already gone */ }
          this.recordEvent("runtime_recovery_discarded", {});
          return;
        }
        this.installRuntime(rt);
        this.runtimeReady = Promise.resolve(rt);
        this.recordEvent("runtime_recovered", { generation: this.runtimeGeneration });
        this.broadcast({ type: "runtime_status", status: "recovered", chatId: this.chatId });
        // Restart the event listener for the new generation. isListening is
        // reset here; the OLD loop (if still draining a dying stream) breaks
        // on the generation check and skips its cleanup (new gen owns it).
        this.isListening = false;
        this.startListening().catch(() => { /* loop handles its own errors */ });
        installed = true;
      } catch (err) {
        // Governance denial (org inactive / quota / rate limit) or ensure
        // failure. One durable visible error; queued turns are finalized as
        // interrupted (NOT replayed — the user must re-send); no loading/busy
        // state is left behind.
        const gre = err instanceof GovernedRecoveryError ? err : null;
        const category = gre?.category ?? "recovery_failed";
        this.recordEvent("runtime_recovery_failed", { category });
        this.broadcastError(
          gre
            ? `Agent 恢复被治理拦截（${category}）：${gre.message}`
            : `Agent 恢复失败：${(err as Error).message}`
        );
        this.queuedRecords = [];
        this.finalizeInterruptedTurns();
        // runtimeDead stays true: the next message retries (flood-limited).
      } finally {
        this.recoveryInFlight = null;
        // Flush AFTER the in-flight marker is cleared — flushQueuedRecords
        // refuses to dispatch while a recovery is in flight, and the queued
        // records must not wait for the NEXT user message.
        if (installed) this.flushQueuedRecords();
      }
    })();
  }

  /**
   * Dispatch queued records FIFO while the runtime is alive. A delivery
   * failure stops the flush — the failed record went back to the queue head
   * and recovery was triggered.
   */
  private flushQueuedRecords(): void {
    while (
      this.queuedRecords.length > 0 &&
      this.runtime &&
      !this.runtimeDead &&
      !this.recoveryInFlight &&
      !this.initialEnsurePending &&
      // S2 rev3+rev4 (Codex INV-C / round 4): the compact CONTROL turn blocks
      // queue advancement until its own RESULT frame completes the control
      // turn. compact_boundary is an AUDIT EVENT ONLY — it never releases
      // this gate (round 4 model correction: single completion boundary, no
      // boundary/result race, no late-result token machine).
      !this.autoCompactInFlight &&
      !this.closedFlag
    ) {
      const record = this.queuedRecords[0];
      // S2 rev (Codex P1): serialized dispatch — a queued user turn waits for
      // the ACTIVE turn's result frame (the result handler re-flushes). Order
      // is preserved: no record dispatches past a blocked head user turn.
      if (record.kind === "user_turn" && this.activeRecords.length > 0) return;
      this.queuedRecords.shift();
      if (!this.dispatchRecord(record)) return;
    }
  }

  /**
   * S2: single entry for every outbound record. Queues while the runtime is
   * dead/absent/recovering or the initial ensure is pending (the next user
   * message owns the recovery trigger), dispatches otherwise. User turns are
   * STRICTLY SERIALIZED: a second user turn never dispatches while another
   * is active (no runtime-level turn correlation exists, so concurrent turns
   * would stamp all events with the latest currentRunId and mis-link the
   * audit trail — S2 rev, Codex P1).
   */
  private enqueueOrDispatch(record: DispatchRecord, errorLabel?: string): boolean {
    // S2 rev4 (Codex round 4): the compact CONTROL turn gates EVERY dispatch
    // path, not just the queue flush — a brand-new user message, standalone
    // A2UI submit, or internal feedback arriving while compaction is in
    // flight (queue empty, no active turn) must QUEUE, not direct-dispatch.
    // Control concurrency is gated by the compact flags, never by
    // activeRecords.
    if (
      this.initialEnsurePending ||
      this.runtimeDead ||
      !this.runtime ||
      this.recoveryInFlight ||
      this.autoCompactInFlight
    ) {
      this.queuedRecords.push(record);
      this.triggerRecovery();
      return false;
    }
    // S2 rev (Codex contract): internal records NEVER jump a queued user
    // turn when no turn is active — FIFO order is preserved. (When a user
    // turn IS active, an internal record dispatches immediately: it belongs
    // to that turn, e.g. a mid-turn A2UI submit.)
    if (record.kind === "internal" && this.activeRecords.length === 0 && this.queuedRecords.length > 0) {
      this.queuedRecords.push(record);
      return false;
    }
    if (
      record.kind === "user_turn" &&
      (this.activeRecords.length > 0 || this.queuedRecords.length > 0)
    ) {
      // Serialized dispatch + FIFO: the turn waits behind the active turn and
      // any earlier queued turns. flushQueuedRecords is a no-op while a turn
      // is active but advances the queue in the post-stop case.
      this.queuedRecords.push(record);
      this.flushQueuedRecords();
      return false;
    }
    return this.dispatchRecord(record, errorLabel);
  }

  /**
   * Dispatch ONE record. Returns true when delivered. A thrown delivery
   * means the message NEVER reached the wire → the record is safe to replay
   * (at-most-once holds); it returns to the queue head and recovery starts.
   * With no recovery function injected, the S1 fail-fast path applies
   * (durable visible error + interrupted run).
   */
  /** Agent OS M3 + S2 rev (Codex contract corr. #2): mint a runId at the
   * DISPATCH boundary. startRun sweeps prior 'running' rows stopped, so this
   * must never run while another turn of this session is still in flight. */
  private mintRun(): string | null {
    if (!this.agentSessionRecord || this.userId === "unknown" || !this.runOrgId) return null;
    try {
      return agentRunService.startRun({
        agentSessionId: this.agentSessionRecord.id,
        userId: this.userId,
        chatId: this.chatId,
        role: this.runRole,
        orgId: this.runOrgId,
      });
    } catch (err) {
      // Run audit MUST never break a user turn. The turn proceeds without
      // run linkage (degraded, not fatal).
      console.error("[Session] startRun failed:", err);
      return null;
    }
  }

  private dispatchRecord(record: DispatchRecord, errorLabel = "消息未送达 Agent"): boolean {
    const rt = this.runtime;
    if (!rt) {
      this.queuedRecords.unshift(record);
      return false;
    }
    let delivered = false;
    try {
      rt.sendMessage(record.content);
      delivered = true;
    } catch (err) {
      // Delivery failed: the message NEVER reached the wire → the record is
      // safe to replay (at-most-once holds) and NO run was minted (S2 rev2,
      // Codex fix 2: minting before the send leaves a dangling 'running' row
      // when recovery later rejects).
      this.runtimeDead = true;
      if (this.recoveryFn) {
        this.queuedRecords.unshift(record);
        this.triggerRecovery();
      } else {
        // S1 fail-fast: the user message is persisted/broadcast, so the
        // failure MUST become a durable visible error instead of hanging.
        this.broadcastError(`${errorLabel}: ${(err as Error).message}`);
      }
      return false;
    }
    if (record.kind === "user_turn") {
      // S2 rev (Codex contract corr. #2) + rev2 fix 2: the run is minted only
      // AFTER the synchronous send succeeds. startRun sweeps the session's
      // prior 'running' row 'stopped' (never runs while another turn is in
      // flight — dispatch is serialized), and a throw now leaves no dangling
      // 'running' row at all.
      if (!record.runId) record.runId = this.mintRun();
      // S2 rev3 (Codex INV-D): turn-scoped audit events are emitted at
      // DISPATCH with THIS turn's minted runId — a queued turn's widget
      // context was previously written early with runId:null.
      if (record.widgetContext) {
        this.recordEvent("widget_context", record.widgetContext, record.runId);
      }
      // currentRunId is set AT DISPATCH: while the turn sits in the queue it
      // owns no events — a late death listener must not be able to
      // "interrupt" a turn that was never on the wire (Codex P2).
      this.activeRecords.push(record);
      this.currentRunId = record.runId;
      // S2 rev2 (Codex fix 3): turn-local presentation state follows the
      // DISPATCHED record, not the latest queued send — a queued /compact
      // must not flip the ACTIVE turn's result rendering.
      this.currentTurnIsCommand = record.isCommand ?? false;
      this.a2uiRetriesThisTurn = 0;
      // Busy is raised on real dispatch (not queueing) — a queued record has
      // nothing in flight and must not leave the UI loading during recovery.
      if (this.lifecycleHooks && this.userId !== "unknown") {
        this.lifecycleHooks.onAgentBusyChange(this.userId, this.chatId, true);
      }
    }
    return true;
  }

  /**
   * Persist an assistant text chunk and broadcast it. If the text contains
   * <a2ui-json> blocks, split it into ordered text + a2ui_block broadcasts.
   * The raw text (with tags) is what lands in chatStore so history replay
   * can re-parse identically.
   *
   * P0 guards:
   *   - Dedup (chatId-scoped, static): same chatId can momentarily host
   *     multiple Session instances (cold resume, concurrent WS subscribers).
   *     Instance-level dedup misses those — use a static per-chatId window.
   *   - Finalizer: if content has an open <a2ui-json> tag without a matching
   *     close, treat as partial — strip the dangling tail so it never reaches
   *     the UI as raw text.
   *   - Model-retry: if any <a2ui-json> block fails to parse, drop the
   *     current broadcast and send a structured feedback message to the
   *     runtime so the model can regenerate. Capped at MAX_A2UI_RETRIES per
   *     user turn (reset on each new user message) to avoid loops.
   */
  private static lastBroadcastByChat = new Map<string, { hash: string; ts: number }>();
  private static readonly DEDUP_WINDOW_MS = 10_000;
  private static readonly MAX_A2UI_RETRIES = 1;
  private static readonly A2UI_RETRY_NOTICE = "（交互卡片格式异常，正在让 Agent 修复…）";

  private a2uiRetriesThisTurn = 0;

  // S3b (A.4): correlation fields are additive on existing frames; the
  // persisted content is untouched (messages schema unchanged).
  private correlationFields(correlation?: { streamId: string; blockIndex: number }): Record<string, unknown> {
    return correlation ? { streamId: correlation.streamId, blockIndex: correlation.blockIndex } : {};
  }

  private broadcastAssistantText(
    rawContent: string,
    correlation?: { streamId: string; blockIndex: number }
  ) {
    // P0.2 finalizer guard: strip dangling <a2ui-json> open tag (no close yet)
    let content = rawContent;
    if (content.includes(A2UI_OPEN_TAG) && !content.includes(A2UI_CLOSE_TAG)) {
      const idx = content.indexOf(A2UI_OPEN_TAG);
      content = content.slice(0, idx).trimEnd();
      if (content) content += "\n\n_（交互卡片生成中…）_";
      else content = "_（交互卡片生成中…）_";
    }

    // P0.1 dedup: chatId-scoped static window.
    const hash = simpleHash(content);
    const now = Date.now();
    const last = Session.lastBroadcastByChat.get(this.chatId);
    if (last && last.hash === hash && now - last.ts < Session.DEDUP_WINDOW_MS) {
      return;
    }
    Session.lastBroadcastByChat.set(this.chatId, { hash, ts: now });

    // Model-retry: if any block failed to parse, request regeneration instead
    // of broadcasting broken UI. Skip this branch when we've already retried
    // in this turn or when retry is disabled.
    if (hasCompleteA2UIBlock(content) && this.a2uiRetriesThisTurn < Session.MAX_A2UI_RETRIES) {
      const failedRaw = extractFailedA2UIRaw(content);
      if (failedRaw) {
        this.a2uiRetriesThisTurn += 1;
        console.log(`[Session ${this.chatId}] A2UI parse failed, requesting retry (${this.a2uiRetriesThisTurn}/${Session.MAX_A2UI_RETRIES})`);
        // Don't persist — this is transient.
        this.broadcast({
          type: "assistant_message",
          content: `_${Session.A2UI_RETRY_NOTICE}_`,
          chatId: this.chatId,
        });
        this.requestA2UIRetry(failedRaw);
        return;
      }
    }

    chatStore.addMessage(this.chatId, { role: "assistant", content });
    this.recordEvent("assistant_message", { content });

    if (!hasCompleteA2UIBlock(content)) {
      this.broadcast({
        type: "assistant_message",
        content,
        chatId: this.chatId,
        ...this.correlationFields(correlation),
      });
      return;
    }

    const segments = splitA2UISegments(content);
    // S3b (A.3): exclusive replacement right — only the FIRST text segment
    // carries the correlation (a streamed block maps to at most one final
    // segment). Later text segments are independent display entries;
    // a2ui_block gets streamId as LIFECYCLE METADATA only (cards have no
    // streaming counterpart — tag interior deltas were withheld).
    let sawTextSegment = false;
    for (const seg of segments) {
      if (seg.kind === "text") {
        if (!seg.text.trim()) continue;
        const segCorrelation = sawTextSegment ? undefined : correlation;
        sawTextSegment = true;
        this.broadcast({
          type: "assistant_message",
          content: seg.text,
          chatId: this.chatId,
          ...this.correlationFields(segCorrelation),
        });
      } else {
        const blockId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.recordEvent("a2ui_block", { blockId, block: seg.block });
        this.broadcast({
          type: "a2ui_block",
          blockId,
          block: seg.block,
          chatId: this.chatId,
          ...(correlation ? { streamId: correlation.streamId } : {}),
        });
      }
    }
  }

  /**
   * Send a structured feedback message to the runtime asking the model to
   * regenerate the failed <a2ui-json> block. Not persisted to chatStore —
   * this is an internal protocol message, not user-visible history.
   */
  private requestA2UIRetry(failedRaw: string) {
    const preview = failedRaw.slice(0, 600);
    const feedback =
      `[系统反馈] 你上一条回复中的 <a2ui-json> 块解析失败，未渲染给用户。\n\n` +
      `常见原因：\n` +
      `1. 字符串值内部有未转义的双引号（用 \\" 转义，或改用中文引号『』）\n` +
      `2. 缺少逗号 / 括号未闭合\n` +
      `3. 字段类型或必填字段缺失（type/title/fields/actions）\n\n` +
      `原始输出（截断 600 字符）：\n\`\`\`\n${preview}\n\`\`\`\n\n` +
      `请直接重新输出完整的 <a2ui-json>{...}</a2ui-json> 块，` +
      `确保 JSON 合法、字段完整。不要解释、不要道歉，直接输出块。`;

    // S2: route through the dispatch-record contract. Internal feedback never
    // mints a runId — it attaches to the current active user turn.
    this.enqueueOrDispatch(
      { kind: "internal", content: feedback, runId: this.currentRunId },
      "A2UI 修复请求未送达 Agent"
    );
    this.startListening();
  }

  // ─── A2UI v2 (S2): blocking show_ui core ───────────────────────

  /**
   * Lifecycle signal for idle protection. Reports the UNION of approval
   * pendings and blocking-A2UI pendings (independent sets, per Codex plan
   * review): a pending card must keep the runtime alive exactly like a
   * pending approval, and "no pendings" only when BOTH sets are empty.
   */
  private notifyPendingChange() {
    if (this.lifecycleHooks && this.userId !== "unknown") {
      this.lifecycleHooks.onPendingApprovalChange(
        this.userId,
        this.chatId,
        this.pendingApprovalById.size > 0 || this.pendingA2UiTool.size > 0
      );
    }
  }

  /**
   * Blocking show_ui entry (LOCAL runtime: called directly as the SDK MCP
   * tool handler; DOCKER S3: invoked from the a2ui_request IPC event with
   * `forward` routing the result back to the container).
   *
   * Persists the block as a synthetic assistant message in the SAME wire
   * format as the legacy prose channel, so history replay renders
   * identically with zero client changes. Deliberately NOT via
   * broadcastAssistantText — that path carries dedup/finalizer/retry
   * machinery for model-generated prose; this payload already passed
   * schema validation at the tool boundary.
   */
  /**
   * Public entry for the blocking show_ui call. LOCAL runtime consumes it as
   * the SDK MCP tool handler (constructor wiring); DOCKER S3 invokes it from
   * the a2ui_request IPC event with `forward` routing the result back to the
   * container.
   */
  handleA2UiToolCall(
    call: ShowUiCall,
    opts?: { forward?: (result: ShowUiResult) => void }
  ): Promise<ShowUiResult> {
    return this.awaitShowUiSubmit(call, opts);
  }

  private awaitShowUiSubmit(
    call: ShowUiCall,
    opts?: { forward?: (result: ShowUiResult) => void }
  ): Promise<ShowUiResult> {
    const blockId = `${A2UI_TOOL_BLOCK_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const block = call.block;

    chatStore.addMessage(this.chatId, {
      role: "assistant",
      // A2UI v2 (S4): the synthetic message persists the block AND a sibling
      // blockId so history replay can re-derive the LIVE id (the legacy
      // parser's validate() strips unknown keys, so expandA2UIInHistory
      // reads blockId directly from the raw JSON before/after splitting).
      // Wrapped so legacy prose-parser ignores it (no leading brace → not a
      // block field); the parser regex captures it as text.
      content: `${A2UI_OPEN_TAG}${JSON.stringify(block)}${A2UI_CLOSE_TAG}` +
        `\n<!--a2ui-id:${blockId}-->`,
    });
    this.recordEvent("a2ui_block", { blockId, block, source: "tool" });
    this.broadcast({ type: "a2ui_block", blockId, block, chatId: this.chatId });

    const timeoutMs = resolveShowUiTimeout(call.timeoutSec);
    const promise = new Promise<ShowUiResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.finishPendingA2Ui(blockId, {
          status: "timeout",
          blockId,
          message: `等待用户提交超时（${Math.round(timeoutMs / 1000)} 秒）`,
        })) {
          // Client switch ignores unknown frames by default; S4 adds explicit
          // expired-marking. Broadcast AFTER finishing so state is consistent.
          this.broadcast({ type: "a2ui_expired", blockId, chatId: this.chatId });
        }
      }, timeoutMs);
      this.pendingA2UiTool.set(blockId, {
        block,
        timer,
        gen: this.runtimeGeneration,
        respond: (result) => {
          resolve(result);
          opts?.forward?.(result);
        },
      });
    });
    // Idle protection — AFTER registration (Codex S2 review #1): notify must
    // observe the pending already in the map, or a sole live card reports
    // false and loses container idle protection.
    this.notifyPendingChange();
    return promise;
  }

  /**
   * Terminal transition for a pending blocking card. Exactly-once: a missing
   * entry means the block already finished (submitted/timeout/cancelled) —
   * repeat/late submits return false and must NOT reach the legacy prose
   * path (that would forge a "[A2UI 提交]" user turn on top of the
   * tool_result).
   */
  private finishPendingA2Ui(blockId: string, result: ShowUiResult): boolean {
    const pending = this.pendingA2UiTool.get(blockId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingA2UiTool.delete(blockId);
    this.recordEvent("a2ui_tool_result", {
      blockId,
      status: result.status,
      ...("actionId" in result ? { actionId: result.actionId } : {}),
    });
    pending.respond(result);
    this.notifyPendingChange();
    return true;
  }

  /**
   * Cancel pending blocking cards (stop()/close() cancels ALL; a listener
   * loop's stream-end cleanup passes its own generation so a stale loop only
   * cancels the cards that died with ITS runtime). No leaked timers.
   */
  private rejectAllPendingA2Ui(reason: string, onlyGen?: number) {
    for (const [blockId, pending] of [...this.pendingA2UiTool.entries()]) {
      if (onlyGen !== undefined && pending.gen !== onlyGen) continue;
      this.finishPendingA2Ui(blockId, { status: "cancelled", blockId, message: reason });
    }
  }

  /**
   * Convert an A2UI submission into a structured user message and enqueue it
   * for the next agent turn. The model sees this as ordinary user input and
   * continues the task based on the submitted values.
   */
  handleA2UISubmit(submission: {
    blockId: string;
    actionId: string;
    actionLabel?: string;
    values: Record<string, string | number | boolean | string[]>;
  }) {
    // A2UI v2 (S2): tool-origin blocks resolve the blocking show_ui call —
    // values return as tool_result in the SAME SDK turn. Guards (Codex plan
    // review R1 + S2 review #2/#3): actionId must be one the block declared;
    // values validated against declared fields (required/type/options); a
    // prefixed id that is not pending is a repeat/late/forged submit →
    // rejected outright, NEVER falling through to the legacy prose path
    // (which would forge a "[A2UI 提交]" user turn).
    const pending = this.pendingA2UiTool.get(submission.blockId);
    if (pending) {
      const action = (pending.block.actions ?? []).find((a) => a.id === submission.actionId);
      if (!action) {
        console.warn(
          `[Session ${this.chatId}] a2ui_submit rejected: unknown actionId "${submission.actionId}" for block ${submission.blockId}`
        );
        return;
      }
      // Invalid values do NOT consume the card — it stays live for a
      // corrected resubmit; the model never sees a half-forged tool_result.
      const validated = validateShowUiValues(pending.block, submission.values);
      if (!validated.ok) {
        console.warn(
          `[Session ${this.chatId}] a2ui_submit rejected for block ${submission.blockId}: ${validated.error}`
        );
        return;
      }
      this.finishPendingA2Ui(submission.blockId, {
        status: "submitted",
        blockId: submission.blockId,
        actionId: submission.actionId,
        actionLabel: action.label,
        values: validated.values,
        submittedAt: new Date().toISOString(),
      });
      return;
    }

    // Prefixed-but-not-pending = repeat/late/unknown TOOL id → reject. The
    // prefix is unambiguous (legacy ids are digit-led), so no bounded
    // tombstone set is needed — this check cannot age out.
    if (submission.blockId.startsWith(A2UI_TOOL_BLOCK_ID_PREFIX)) {
      console.warn(
        `[Session ${this.chatId}] a2ui_submit rejected: tool block ${submission.blockId} is not pending (repeat/late submit)`
      );
      return;
    }

    const lines: string[] = [
      `[A2UI 提交] blockId=${submission.blockId} action=${submission.actionId}`,
    ];
    if (submission.actionLabel) {
      lines.push(`动作：${submission.actionLabel}`);
    }
    const entries = Object.entries(submission.values);
    if (entries.length > 0) {
      lines.push("提交内容：");
      for (const [k, v] of entries) {
        const formatted = Array.isArray(v)
          ? v.join(", ")
          : typeof v === "boolean"
            ? v ? "是" : "否"
            : String(v);
        lines.push(`- ${k}: ${formatted}`);
      }
    } else {
      lines.push("提交内容：（空）");
    }
    const content = lines.join("\n");

    // Mirror the standard user-send path: persist + broadcast + enqueue.
    chatStore.addMessage(this.chatId, { role: "user", content });
    this.broadcast({ type: "user_message", content, chatId: this.chatId });

    // S2 rev3 (Codex INV-B): terminal ownership for every persisted
    // user-visible input. A standalone legacy submit (no active user turn) IS
    // a user turn — it mints its own run, is visibly interrupted when
    // dispatched-but-unconfirmed, and triggers governed recovery when queued
    // (replayable only if never dispatched). With a user turn active it stays
    // an internal record attached to that turn (mid-turn A2UI feedback).
    const hasActiveUserTurn = this.activeRecords.some((r) => r.kind === "user_turn");
    const record: DispatchRecord = hasActiveUserTurn
      ? { kind: "internal", content, runId: this.currentRunId }
      : { kind: "user_turn", content, runId: null, isCommand: false };
    this.enqueueOrDispatch(record, "A2UI 提交未送达 Agent");
    this.startListening();
  }

  // Handle approval response from frontend
  handleApprovalResponse(response: ApprovalResponse) {
    // Capture toolName BEFORE deleting (the decision audit + always-allow
    // whitelist both need it).
    const toolName = this.pendingApprovalById.get(response.id);
    // If user chose "always allow", persist tool to session whitelist
    if (response.alwaysAllow && response.approved && toolName) {
      this.sessionAllowedTools.add(toolName);
    }
    this.pendingApprovalById.delete(response.id);

    // Docker mode: forward approval directly to container via IPC
    if (this.runtime?.handleApprovalResponse) {
      let forwarded: boolean;
      try {
        forwarded = this.runtime.handleApprovalResponse(response);
      } catch (err) {
        // S1: docker forward FAILED — the container never received the
        // decision. Never fake success: surface the failure, sync the (now
        // cleared) pending state, and let the container-side hook time out
        // on its own.
        this.notifyPendingChange();
        this.broadcastError(`审批决定未送达 Agent: ${(err as Error).message}`);
        return false;
      }
      if (forwarded) {
        // Agent OS M2 (r2 #2): audit the docker approval decision (metadata-only)
        // once it is successfully forwarded to the container.
        this.recordEvent("approval_decision", {
          id: response.id,
          toolName: toolName ?? null,
          decision: categorizeApprovalDecision(response),
          reason: response.message || null,
        });
        // A2UI v2: pending = approvals ∪ a2ui blocks (notifyPendingChange is
        // the superset of the former direct onPendingApprovalChange call).
        this.notifyPendingChange();
        return true;
      }
      // `false` (no throw) = "not handled by this runtime" (local-mode
      // stubs resolve approvals in-process) → fall through to the manager.
    }
    const result = this.approvalManager?.handleResponse(response) ?? false;
    this.notifyPendingChange();
    return result;
  }

  // Agent OS M2 (r2 #1): clear the pending-approval map + lifecycle flag for
  // a resolved request. Called by the local onPreToolUse path for EVERY
  // resolution (approve/reject/timeout/cancel) — handleApprovalResponse only
  // covers the frontend-responded path, so without this a timed-out local
  // approval would leave stale pending state (lifecycle-protected).
  private clearPendingApproval(requestId: string) {
    this.pendingApprovalById.delete(requestId);
    if (this.lifecycleHooks && this.userId !== "unknown") {
      this.lifecycleHooks.onPendingApprovalChange(this.userId, this.chatId, false);
    }
  }

  // Start listening to agent output (call once per runtime generation)
  private async startListening() {
    if (this.isListening) return;
    this.isListening = true;
    // S2 rev2 (Codex fix 1): resolve the runtime BEFORE deciding ownership.
    // A listener started while the INITIAL ensure was pending must serve the
    // runtime that the promise installs — the pre-captured generation check
    // exited on the install's OWN generation bump and left the container's
    // events unconsumed (`agent_runs` stuck 'running'). A listener whose
    // awaited promise resolves to an ALREADY-REPLACED runtime exits silently
    // (gen === -1): it consumed nothing, so it must not run the stream-end
    // cleanup — the current generation's listener owns pending state.
    let rt: AgentRuntime | null = null;
    let gen = -1;

    try {
      rt = await this.runtimeReady;
      if (rt !== this.runtime) return;
      // S2: the generation this loop serves. Late frames from an older
      // generation (a half-dead predecessor still draining) are dropped, and
      // an old loop's terminal cleanup is skipped once a newer generation
      // owns the session — it must not clear the NEW runtime's state.
      gen = this.runtimeGeneration;
      for await (const message of rt.getEventStream()) {
        if (gen !== this.runtimeGeneration) break;
        this.handleSDKMessage(message);
      }
    } catch (error) {
      // S2 rev3 (Codex INV-A): rt === null means the rejection came from the
      // awaited runtimeReady ITSELF (the initial ensure — a stream error can
      // only throw after rt is bound). With governed recovery injected, an
      // initial-ensure rejection is a TRANSIENT setup failure: the recovery
      // result owns the durable outcome (success → no error; failure → exactly
      // one recovery error). Only without recovery does the S1 fail-fast error
      // fire here.
      if (rt === null && this.recoveryFn) {
        console.error(
          `[Session ${this.chatId}] runtimeReady rejected; governed recovery owns the outcome:`,
          (error as Error).message
        );
        return;
      }
      console.error(`Error in session ${this.chatId}:`, error);
      // M8g: STALE loop — the runtime this loop consumed has already been
      // replaced (voluntary hot swap, or a recovery that finished installing).
      // Its teardown error is expected noise, never a user-visible failure:
      // the current generation's loop owns pending state, and the swap (or
      // crash) is already audited by its own event. Without this check the
      // old runtime's abort error leaks a durable red banner (and marks the
      // LIVE run interrupted) because installRuntime resets runtimeDead
      // before the dying stream's rejection lands.
      if (gen !== this.runtimeGeneration) return;
      // S2 rev4 (Codex round 4): if death handling already ran (death
      // listener / stream-end cleanup), the single terminal interruption
      // error was already surfaced and the run marked stopped — a stream
      // error arriving AFTER the death notification must not add a SECOND
      // durable error for the same turn.
      if (this.runtimeDead) return;
      this.broadcastError(`Agent 运行时错误: ${(error as Error).message}`);
      this.markCurrentRunInterrupted();
    } finally {
      // Stale resolution (gen === -1): this listener never owned a stream —
      // exit with NO cleanup; the current generation's listener owns pending
      // state and isListening.
      if (gen === -1) return;
      // A2UI v2 (Codex S3 review #4): stream termination (docker crash/WS
      // close, local SDK death) cancels live blocking cards — a stale
      // idle-protected pending must not hold cold recovery hostage until the
      // 15-min timeout. Timers cleared, model gets its cancelled result.
      // M8g fix (Codex P1): scoped to THIS loop's generation only. A hot swap
      // drains the old stream while the new runtime already serves; if the
      // new generation opened a pending card before this delayed finally
      // runs, an unscoped reject would kill the LIVE card. Cards of this
      // loop's generation died with its stream — those still cancel.
      this.rejectAllPendingA2Ui("Agent 运行时已断开", gen);
      if (gen === this.runtimeGeneration) {
        this.onRuntimeStreamEnded();
      }
      // else: a newer generation owns the session — its loop owns cleanup and
      // isListening. Do NOT reset isListening here (a concurrent reset would
      // let the next sendMessage spawn a duplicate consumer of the NEW stream).
    }
  }

  /**
   * S1: terminal handling when the runtime event stream is gone (ended or
   * errored). A turn that was still active can never complete now: surface a
   * durable error, finalize the run, clear stale approval state, and release
   * busy so the UI isn't left loading forever. Idempotent per termination —
   * the catch path above already finalized, so this only fires for silent
   * stream-ends (termination WITHOUT a result frame).
   */
  private onRuntimeStreamEnded() {
    // S3b (A.2): stream termination sweep — late message_stop will never
    // arrive; every open stream gets its terminal stream_end now.
    this.sweepOpenStreams();
    this.finalizeInterruptedTurns();
    // Allow the next sendMessage to re-enter listening. With S2 recovery the
    // next turn rebuilds the runtime and the listener restarts on the new
    // generation; without a recovery function the turn surfaces a delivery
    // error (S1 fail-fast) instead of silently doing nothing.
    this.isListening = false;
  }

  /** S1: finalize the in-flight run as interrupted (stopped), never 'running'. */
  private markCurrentRunInterrupted() {
    if (this.currentRunId && this.agentSessionRecord) {
      try {
        agentRunService.markRunningAsStopped(this.agentSessionRecord.id);
      } catch (err) {
        console.error("[Session] markRunningAsStopped (interrupted) failed:", err);
      }
      this.currentRunId = null;
    }
  }

  /**
   * Buffer a file-upload notice WITHOUT sending it to the agent.
   * The notice is prepended to the next user message so the agent only
   * responds when the user actually asks something, not on upload.
   */
  noteUploadedFile(content: string) {
    this.pendingFileNotices.push(content);
  }

  // Send a user message to the agent
  sendMessage(content: string, turnContext?: TurnContext) {
    // M8g (capability hot reload): check for control-plane drift BEFORE the
    // record is queued. A swap here is the ideal path — the record queues during
    // the rebuild (existing S2 queue+recovery flow) and dispatches fresh.
    this.maybeHotSwap();

    // Agent OS M3 (plan §7) + S2 rev (Codex contract corr. #2): the runId is
    // minted AT DISPATCH (dispatchRecord → mintRun), never here. startRun
    // sweeps the session's prior 'running' row 'stopped' — minting a turn
    // while it (or another) is queued would corrupt the active run's audit
    // row. A turn that never dispatches leaves no dangling 'running' row.
    // S2 rev2 (Codex fix 3): the same applies to the turn-local A2UI retry
    // budget and command flag — applied at dispatch, not at send.

    // Store user message (UI/history shows only what the user typed)
    chatStore.addMessage(this.chatId, {
      role: "user",
      content,
    });

    // Broadcast user message to subscribers
    this.broadcast({
      type: "user_message",
      content,
      chatId: this.chatId,
    });

    // Detect slash commands (e.g. /compact, /clear). These are processed
    // natively by the Claude Agent SDK in streaming input mode.
    // S2 rev2 (Codex fix 3): isCommand rides on the record and is applied at
    // DISPATCH — currentTurnIsCommand must describe the active dispatched
    // turn, not the latest queued send.
    const isCommand = content.trim().startsWith("/");

    // Prepend any buffered file notices to the content sent to the agent.
    // These give the agent file context but are not shown as user text.
    // Skip for slash commands — prepending text would corrupt the command.
    let agentContent = content;
    if (!isCommand && this.pendingFileNotices.length > 0) {
      agentContent = this.pendingFileNotices.join("\n") + "\n\n" + content;
      this.pendingFileNotices = [];
    }

    // Widget W4: wrap bounded page context into the runtime input ONLY. The
    // user message above is persisted/broadcast as the typed text; this wrapped
    // input is never stored. Context is fixed at send time (contract §5); the
    // audit carries a redacted summary (no payload).
    let widgetContextSummary: Record<string, unknown> | null = null;
    if (!isCommand && turnContext?.pageContext) {
      agentContent = wrapRuntimeInput(agentContent, turnContext.pageContext);
      widgetContextSummary = {
        ...contextSummary(turnContext.pageContext, turnContext.pageSessionId),
      };
    }

    // Send to agent via the S2 dispatch-record contract. A dead runtime
    // queues the record and triggers GOVERNED recovery (server-injected —
    // this class never rebuilds runtimes itself). With no recovery function
    // injected, the S1 fail-fast semantics apply (durable visible error).
    // S2 rev3 (Codex INV-D): the widget-context summary rides the record; the
    // audit event is emitted AT DISPATCH with the turn's minted runId.
    const record: DispatchRecord = {
      kind: "user_turn",
      content: agentContent,
      runId: null, // minted at dispatch (dispatchRecord → mintRun)
      isCommand,
      ...(widgetContextSummary ? { widgetContext: widgetContextSummary } : {}),
    };
    this.enqueueOrDispatch(record);

    // Start listening if not already
    if (!this.isListening) {
      this.startListening();
    }
  }

  private recordEvent(
    eventType: AgentEventType,
    payload: Record<string, unknown>,
    // S2 rev (Codex contract corr. #2): optional run stamp override.
    // Send-time events of a turn that has NOT dispatched yet
    // (widget_context) are recorded unlinked — the queued turn's run does
    // not exist until dispatch mints it.
    runId?: string | null
  ) {
    if (this.agentSessionRecord && this.userId !== "unknown") {
      try {
        eventStore.appendEvent(
          this.userId,
          this.chatId,
          this.agentSessionRecord.id,
          eventType,
          payload,
          // Agent OS M3: stamp every event with the in-flight runId (null for
          // lifecycle/audit events emitted outside a turn — appendEvent treats
          // null as "no run", preserving legacy behavior).
          runId !== undefined ? runId : this.currentRunId
        );
      } catch (err) {
        console.error("Failed to record event:", err);
      }
    }
  }

  // ─── S3b (Appendix A): stream_event handling ──────────────────────

  /**
   * A.3 gate ① — deltas (and stream lifecycle frames) flow ONLY during an
   * active dispatched user turn. Compact control turns, internal records
   * without an active user turn, and the awaitingAutoCompactResult window
   * are all silent (same semantics as the S2 compact gates).
   */
  private streamingTurnGateOpen(): boolean {
    return this.activeRecords.some((r) => r.kind === "user_turn") && !this.awaitingAutoCompactResult;
  }

  private handleStreamEvent(message: any) {
    if (!isStreamingEnabled()) return;
    const event = (message as { event?: any }).event;
    if (!event || typeof event.type !== "string") return;

    switch (event.type) {
      case "message_start": {
        // Gate ① hoisted to stream lifecycle: a compact/control turn mints
        // nothing (no stream_start the client would open for a stream whose
        // deltas are all suppressed). currentStreamId=null drops its deltas.
        if (!this.streamingTurnGateOpen()) {
          this.currentStreamId = null;
          return;
        }
        const streamId = uuidv4();
        this.openStreams.set(streamId, {
          blocks: new Map(),
          bytes: 0,
          capped: false,
          scanner: new A2UIDeltaScanner(),
        });
        this.currentStreamId = streamId;
        this.broadcast({ type: "stream_start", chatId: this.chatId, streamId });
        return;
      }

      case "message_stop": {
        // Single-stream close (A.2): exactly one stream_end, then removed.
        const streamId = this.currentStreamId;
        this.currentStreamId = null;
        if (streamId && this.openStreams.delete(streamId)) {
          this.broadcast({ type: "stream_end", chatId: this.chatId, streamId });
        }
        return;
      }

      case "content_block_start": {
        const st = this.currentStreamId ? this.openStreams.get(this.currentStreamId) : null;
        if (!st) return;
        // A.3: the tag scanner resets at every block boundary.
        st.scanner.reset();
        const blockType = (event.content_block as { type?: unknown } | undefined)?.type;
        if ((blockType === "text" || blockType === "thinking") && typeof event.index === "number") {
          st.blocks.set(event.index, { kind: blockType, final: false });
        }
        return;
      }

      case "content_block_delta": {
        const delta = event.delta as { type?: unknown; text?: unknown; thinking?: unknown } | undefined;
        const kind =
          delta?.type === "text_delta" ? "text"
          : delta?.type === "thinking_delta" ? "thinking"
          : null;
        if (!kind) return; // input_json_delta / signature_delta: non-goals (A.8)
        const streamId = this.currentStreamId;
        const st = streamId ? this.openStreams.get(streamId) : null;
        if (!st || typeof event.index !== "number") return;
        const block = st.blocks.get(event.index);
        if (block && block.final) return;
        if (st.capped) return;
        const payload =
          kind === "text"
            ? typeof delta?.text === "string" ? delta.text : null
            : typeof delta?.thinking === "string" ? delta.thinking : null;
        if (payload == null || payload.length === 0) return;

        // Gate ①: only during an active dispatched user turn.
        if (!this.streamingTurnGateOpen()) return;

        // Gate ② (text only): cross-delta partial-prefix tag scanner —
        // thinking deltas bypass it (A.3: thinking blocks cannot carry tags).
        const forwardable = kind === "text" ? st.scanner.feedText(payload) : payload;

        // Gate ③: UTF-8 byte caps (Buffer.byteLength, not string length).
        // Over-limit → stop forwarding; the whole frame is the fallback.
        const frameBytes = Buffer.byteLength(forwardable);
        if (frameBytes > STREAM_FRAME_MAX_BYTES) return;
        if (st.bytes + frameBytes > STREAM_TOTAL_MAX_BYTES) {
          st.capped = true;
          return;
        }
        if (frameBytes === 0) return;
        st.bytes += frameBytes;
        this.broadcast({
          type: "stream_delta",
          chatId: this.chatId,
          streamId,
          index: event.index,
          kind,
          delta: forwardable,
        });
        return;
      }

      default:
        // message_delta / content_block_stop / signature_delta: not
        // forwarded (A.2) — scanner reset happens at block START.
        return;
    }
  }

  /**
   * A.2/A.3 run-terminal sweep — result / error / stream termination /
   * runtime death: every still-open stream gets exactly one stream_end
   * (idempotent — entries are deleted on first close). Whole-frame
   * authority is untouched.
   */
  private sweepOpenStreams() {
    for (const streamId of [...this.openStreams.keys()]) {
      this.openStreams.delete(streamId);
      this.broadcast({ type: "stream_end", chatId: this.chatId, streamId });
    }
    this.currentStreamId = null;
  }

  /**
   * A.3 whole-frame text correlation: FIFO-match an open stream's
   * unfinalized text block and claim it (final) — the returned
   * (streamId, blockIndex) rides the assistant_message frame so the client
   * can finalize/replace exactly that preview block. Unmatched (e.g.
   * whole-frame-only provider) → undefined → plain frame.
   */
  private consumeTextBlockCorrelation(): { streamId: string; blockIndex: number } | undefined {
    for (const [streamId, st] of this.openStreams) {
      for (const [index, block] of st.blocks) {
        if (block.kind === "text" && !block.final) {
          block.final = true;
          return { streamId, blockIndex: index };
        }
      }
    }
    return undefined;
  }

  /**
   * A.2 thinking whole frame: broadcast a final thinking_block (never
   * persisted, A.6). FIFO-match an open stream's unfinalized thinking
   * block; whole-frame-only providers get a lazily-minted streamId that is
   * deliberately NOT added to openStreams (A.3) — thinking is never
   * silently dropped either way (V6).
   */
  private broadcastThinkingBlockFinal(content: string, frameBlockIndex: number) {
    let streamId: string | null = null;
    let index: number | null = null;
    for (const [sid, st] of this.openStreams) {
      for (const [i, block] of st.blocks) {
        if (block.kind === "thinking" && !block.final) {
          block.final = true;
          streamId = sid;
          index = i;
          break;
        }
      }
      if (streamId != null) break;
    }
    if (streamId == null || index == null) {
      streamId = uuidv4();
      index = frameBlockIndex;
    }
    this.broadcast({
      type: "thinking_block",
      chatId: this.chatId,
      streamId,
      index,
      content,
      ...(this.lastThinkingTokenEstimate != null ? { estimatedTokens: this.lastThinkingTokenEstimate } : {}),
      final: true,
    });
  }

  private handleSDKMessage(message: any) {
    // S3b (Appendix A.2): SDK partial/stream events — preview-only branch,
    // never persisted. Old runtimes (kill-switch off) never emit these.
    if (message.type === "stream_event") {
      this.handleStreamEvent(message);
      return;
    }
    if (message.type === "system") {
      // SDK init: capture discovered runtime capabilities for UI diagnostics.
      if (message.subtype === "init") {
        const slashCommands = Array.isArray(message.slash_commands) ? message.slash_commands : [];
        this.availableSlashCommands = slashCommands;
        // Phase 3: capture connected MCP server names. The SDK init message carries
        // mcp_servers (array of status objects or names); normalize to bare names so
        // diagnostics can diff resolved vs discovered MCP. See sdk.d.ts SystemInitMessage.
        const mcpServers = Array.isArray(message.mcp_servers)
          ? message.mcp_servers
              .map((s: unknown) =>
                typeof s === "string" ? s : (s as { name?: string; serverInfo?: { name?: string } })?.name ?? (s as { serverInfo?: { name?: string } })?.serverInfo?.name ?? ""
              )
              .filter((s: string) => s.length > 0)
          : [];
        this.sdkInitSnapshot = {
          model: typeof message.model === "string" ? message.model : undefined,
          cwd: typeof message.cwd === "string" ? message.cwd : undefined,
          tools: Array.isArray(message.tools) ? message.tools : [],
          slashCommands,
          skills: Array.isArray(message.skills) ? message.skills : [],
          plugins: Array.isArray(message.plugins) ? message.plugins : [],
          mcpServers,
          raw: message,
        };
        this.recordEvent("sdk_init", {
          model: this.sdkInitSnapshot.model,
          cwd: this.sdkInitSnapshot.cwd,
          tools: this.sdkInitSnapshot.tools,
          slashCommands: this.sdkInitSnapshot.slashCommands,
          skills: this.sdkInitSnapshot.skills,
          plugins: this.sdkInitSnapshot.plugins,
          mcpServers: this.sdkInitSnapshot.mcpServers,
        });
        this.broadcast({
          type: "slash_commands",
          commands: slashCommands,
          sdkInit: this.sdkInitSnapshot,
          chatId: this.chatId,
        });
      } else if (message.subtype === "thinking_tokens") {
        // S3b (Appendix A.2): thinking estimate rides the final
        // thinking_block frames. Metadata only — never a payload audit (A.6).
        const est = (message as { estimated_tokens?: unknown }).estimated_tokens;
        if (typeof est === "number" && Number.isFinite(est) && est >= 0) {
          this.lastThinkingTokenEstimate = est;
        }
      } else if (message.subtype === "compact_boundary") {
        // /compact finished — surface a lightweight notice
        const meta = message.compact_metadata || {};
        const preTokens = typeof meta.pre_tokens === "number" ? meta.pre_tokens : null;
        const postTokens = typeof meta.post_tokens === "number" ? meta.post_tokens : null;
        const trigger = typeof meta.trigger === "string" ? meta.trigger : null;
        // M4: persist the boundary so the Chat context chip ("最近 compact")
        // and org dashboards can show when compaction last happened (manual
        // /compact AND auto-compact both land here). S2 rev4 (Codex round 4):
        // AUDIT ONLY — the boundary does NOT release the compact control
        // gate; the control turn completes at its own result frame.
        this.recordEvent("compact_boundary", { preTokens, postTokens, trigger });
        this.broadcast({
          type: "system_notice",
          subtype: "compact",
          preTokens,
          trigger,
          chatId: this.chatId,
        });
      } else {
        // Unknown system subtype — log it so we can debug, and surface any
        // text payload as a command result so /context, /usage etc. are visible.
        console.log(`[Session ${this.chatId}] Unhandled system event subtype="${message.subtype}":`, JSON.stringify(message).slice(0, 500));
        const text =
          typeof message.result === "string" ? message.result :
          typeof message.content === "string" ? message.content :
          typeof message.message === "string" ? message.message :
          null;
        if (text && text.trim()) {
          this.broadcast({
            type: "command_result",
            output: text.slice(0, 5000),
            isError: false,
            chatId: this.chatId,
          });
        }
      }
      return;
    }
    if (message.type === "assistant") {
      const content = message.message.content;

      if (typeof content === "string") {
        this.broadcastAssistantText(content, this.consumeTextBlockCorrelation());
      } else if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) {
          const block = content[i];
          if (block.type === "text") {
            // S3b (A.4): additive correlation fields on the whole-frame
            // authority — the client uses them for exact block-level
            // finalize/replace of the streaming preview. Not persisted.
            this.broadcastAssistantText(block.text, this.consumeTextBlockCorrelation());
          } else if (block.type === "thinking") {
            // S3b (A.2): thinking whole frame — broadcast final block, never
            // persisted (A.6; V6: current prod silently DROPS these).
            this.broadcastThinkingBlockFinal(
              typeof block.thinking === "string" ? block.thinking : "",
              i
            );
          } else if (block.type === "tool_use") {
            this.recordEvent("tool_use", {
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input,
            });
            // A2UI v2: show_ui is runtime infrastructure — no tool chip (the
            // a2ui_block card IS the UI). Remember the id so the matching
            // tool_result is filtered too.
            if (block.name === SHOW_UI_TOOL_NAME) {
              if (typeof block.id === "string") this.a2uiToolUseIds.add(block.id);
              continue;
            }
            this.broadcast({
              type: "tool_use",
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input,
              chatId: this.chatId,
            });
          }
        }
      }
    } else if (message.type === "user") {
      // Tool results come back as "user" messages with tool_result content blocks
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const resultContent = Array.isArray(block.content)
              ? block.content.map((c: any) => c.text || "").join("\n")
              : typeof block.content === "string"
                ? block.content
                : "";
            this.recordEvent("tool_result", {
              toolId: block.tool_use_id,
              output: resultContent.slice(0, 5000),
              isError: block.is_error || false,
            });
            // A2UI v2: the show_ui tool_result (submit/timeout/cancelled) is
            // consumed by the model in-turn; the card already surfaced the
            // interaction. Consuming the id keeps the Set bounded.
            if (this.a2uiToolUseIds.delete(block.tool_use_id)) {
              continue;
            }
            this.broadcast({
              type: "tool_result",
              toolId: block.tool_use_id,
              output: resultContent.slice(0, 5000),
              isError: block.is_error || false,
              chatId: this.chatId,
            });
          }
        }
      }
    } else if (message.type === "approval_request") {
      // Docker container is requesting tool approval via IPC
      // Auto-approve if user previously chose "always allow" for this tool
      if (this.sessionAllowedTools.has(message.toolName)) {
        if (this.runtime?.handleApprovalResponse) {
          this.runtime.handleApprovalResponse({ id: message.id, approved: true });
        }
        return;
      }
      this.recordEvent("approval_request", {
        toolName: message.toolName,
        toolId: message.toolUseId,
      });
      this.pendingApprovalById.set(message.id, message.toolName);
      this.broadcast({
        type: "approval_request",
        id: message.id,
        toolName: message.toolName,
        toolInput: message.toolInput,
        toolUseId: message.toolUseId,
        chatId: this.chatId,
      });
      // Notify lifecycle: pending approval
      this.notifyPendingChange();
    } else if (message.type === "a2ui_request") {
      // A2UI v2 (S3): docker path — the container's blocking show_ui handler
      // shipped the block here. Same core as local (persist/broadcast/pending/
      // union lifecycle); `forward` routes the terminal result back over IPC.
      // HOST-BOUNDARY REVALIDATION (Codex S3 review #2 + envelope follow-up):
      // the IPC frame is untrusted input to THIS process — requestId must be
      // a non-empty bounded string (never String(undefined) → "undefined" as
      // a correlation key), the block must pass the same schema the local
      // path applies, and the ENVELOPE timeoutSec (the container's per-call
      // override — parseShowUiArgs can't see it, it's not a block field) is
      // validated here and threaded into the shared core.
      const requestId = message.requestId;
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 100) {
        console.warn(
          `[Session ${this.chatId}] a2ui_request rejected: requestId must be a non-empty string (≤100 chars)`
        );
        this.recordEvent("a2ui_tool_result", {
          status: "invalid_block",
          error: "missing or malformed requestId",
        });
        return;
      }
      const respondInvalid = (error: string) => {
        this.recordEvent("a2ui_tool_result", { requestId, status: "invalid_block" });
        try {
          this.runtime?.forwardA2UiResult?.(requestId, { status: "invalid_block", error });
        } catch (err) {
          console.warn(`[Session ${this.chatId}] a2ui_response forward failed:`, (err as Error).message);
        }
      };
      if (!message.block || typeof message.block !== "object") {
        respondInvalid("a2ui_request.block must be an object");
        return;
      }
      const parsed = parseShowUiArgs(message.block);
      if ("error" in parsed) {
        respondInvalid(parsed.error);
        return;
      }
      let timeoutSec: number | undefined;
      if (message.timeoutSec !== undefined) {
        if (
          typeof message.timeoutSec !== "number" ||
          !Number.isFinite(message.timeoutSec) ||
          message.timeoutSec < 1
        ) {
          respondInvalid("a2ui_request.timeoutSec must be a finite number >= 1");
          return;
        }
        timeoutSec = message.timeoutSec;
      }
      this.handleA2UiToolCall(
        { block: parsed.block, timeoutSec },
        {
          forward: (result) => {
            try {
              this.runtime?.forwardA2UiResult?.(requestId, result);
            } catch (err) {
              // Container gone (stop/crash): its own fallback timer/shutdown cancels the call.
              console.warn(`[Session ${this.chatId}] a2ui_response forward failed:`, (err as Error).message);
            }
          },
        }
      ).catch((err) =>
        console.error(`[Session ${this.chatId}] a2ui_request handling failed:`, err)
      );
    } else if (message.type === "error") {
      // S1: runtime/SDK error events must never be silently dropped — surface
      // them durably (persisted red banner + live error frame).
      const detail =
        typeof message.error === "string"
          ? message.error
          : typeof (message as any).message === "string"
            ? (message as any).message
            : JSON.stringify(message).slice(0, 300);
      // S3b (A.2): run-terminal error — sweep still-open streams first so
      // client preview blocks finalize before the error frame lands.
      this.sweepOpenStreams();
      this.broadcastError(detail);
    } else if (message.type === "result") {
      // S3b (A.2): run-terminal sweep — every still-open stream gets exactly
      // one stream_end (idempotent) before the result frame.
      this.sweepOpenStreams();
      // S2 rev3 (Codex INV-C): while awaitingAutoCompactResult is set, THIS
      // result frame belongs to the /compact CONTROL turn (sent directly,
      // run-less by design). It must stay run-unlinked and must never
      // finalize/consume the next user turn's run — B (if already dispatched
      // past a compact_boundary) keeps its own run linkage and is finalized
      // only by B's own result.
      const isCompactControlTurn = this.awaitingAutoCompactResult;
      // If this turn was a slash command, surface its textual output as a
      // command result so it renders as a system notice, not normal chat.
      if (this.currentTurnIsCommand && typeof message.result === "string" && message.result.trim()) {
        this.broadcast({
          type: "command_result",
          output: message.result.slice(0, 5000),
          isError: message.subtype !== "success",
          chatId: this.chatId,
        });
      } else if (message.subtype === "success" && typeof message.result === "string" && message.result.trim()) {
        // Some SDK/provider paths only emit the final text on the result event,
        // without a separate assistant message event. Treat that text as the
        // assistant response so the user does not see a silent completed turn.
        //
        // Route through broadcastAssistantText so that:
        //   (a) if the same content was already broadcast via the assistant
        //       event path, dedup catches it (Zhipu/Claude Code SDK emits both);
        //   (b) any <a2ui-json> blocks get split into a2ui_block broadcasts
        //       instead of leaking raw tags into the chat.
        this.broadcastAssistantText(message.result);
      }
      this.currentTurnIsCommand = false;
      // Stage 1 (token management): persist + broadcast the provider-reported
      // token breakdown from the result event. Both runtimes reach here with the
      // same shape (docker forwards the SDK event verbatim via sdk_event →
      // pushEvent), so one capture point covers local AND docker. Field names
      // are canonicalized to camelCase and MUST stay in sync with
      // quota-service's json_extract paths ($.usage.inputTokens etc.).
      const usage = extractTokenUsage(message.usage);
      // S2 rev3 (Codex INV-C): the compact control turn's result is recorded
      // run-UNLINKED (explicit null), never stamped with the active user
      // turn's runId.
      this.recordEvent(
        "result",
        {
          success: message.subtype === "success",
          cost: message.total_cost_usd,
          duration: message.duration_ms,
          ...(usage ? { usage } : {}),
        },
        isCompactControlTurn ? null : undefined
      );
      // Agent OS M3 (plan §7) + S2: finalize the run at its result event. The
      // result event itself is already stamped with currentRunId above. The
      // record state machine finalizes the OLDEST dispatched user turn (FIFO);
      // currentRunId moves to the next still-open record (null between turns).
      // Status resolves to success / failed / tool_rejected. Guarded so
      // platform-internal sub-turns (auto-compact, sent via runtime.sendMessage
      // directly) with no currentRunId are a no-op.
      const finished = isCompactControlTurn
        ? null
        : (this.activeRecords.find((r) => r.kind === "user_turn") ?? null);
      if (finished) {
        this.activeRecords = this.activeRecords.filter((r) => r !== finished);
      }
      const runIdToFinalize = isCompactControlTurn ? null : (finished?.runId ?? this.currentRunId);
      if (runIdToFinalize) {
        try {
          agentRunService.finalizeRun(runIdToFinalize, {
            success: message.subtype === "success",
            costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
            durationMs: typeof message.duration_ms === "number" ? message.duration_ms : null,
            usage: usage ?? null,
            model: this.sdkInitSnapshot?.model ?? null,
          });
        } catch (err) {
          console.error("[Session] finalizeRun failed:", err);
        }
      }
      const nextOpen = [...this.activeRecords].reverse().find((r) => r.kind === "user_turn") ?? null;
      this.currentRunId = nextOpen?.runId ?? null;
      this.broadcast({
        type: "result",
        success: message.subtype === "success",
        chatId: this.chatId,
        cost: message.total_cost_usd,
        duration: message.duration_ms,
        ...(message.subtype !== "success" && typeof message.result === "string"
          ? { error: message.result.slice(0, 300) }
          : {}),
        ...(usage ? { usage } : {}),
      });
      // Soft monthly budget check (alert-only, never blocks the turn). Org is
      // resolved server-side from the chat row — never client-supplied. Runs
      // AFTER the event is persisted so the monthly SUM already includes this
      // turn; evaluateTokenTurn derives the "before" total from the delta.
      const chat = this.userId !== "unknown" ? chatStore.getChat(this.chatId) : null;
      const orgId = chat?.orgId ?? null;
      if (usage && orgId) {
        evaluateTokenTurn(orgId, usage);
      }
      // Notify lifecycle: agent finished processing
      if (this.lifecycleHooks && this.userId !== "unknown") {
        this.lifecycleHooks.onAgentBusyChange(this.userId, this.chatId, false);
      }
      // Auto-scan /workspace/output for new agent-generated files (docker mode only)
      if (RUNTIME_MODE === "docker" && this.userId !== "unknown") {
        fileWorkspaceService.scanOutputFiles(this.userId, this.chatId)
          .then((newFiles) => {
            if (newFiles.length > 0) {
              this.broadcast({ type: "files_updated", chatId: this.chatId });
            }
          })
          .catch((err) => console.warn("[Session] scanOutputFiles error:", err));
      }

      // ─── M4 (plan §4.3 phase 1): turn-boundary Auto Compact ──────────
      // Platform-side threshold guard ONLY — no unverified native SDK
      // autocompact params (event M4-4). Fires strictly AFTER the turn ended
      // (不中断正在执行的 turn) and sends the EXISTING /compact command into
      // the same runtime stream, so Local and Docker behave identically (both
      // speak the SDK prompt stream). Exactly-once: the trigger's own command
      // turn never re-evaluates the threshold.
      if (this.awaitingAutoCompactResult) {
        this.awaitingAutoCompactResult = false;
        this.autoCompactInFlight = false;
        // S2 rev3 (Codex INV-C): the compact control turn has completed —
        // queued user turns may now dispatch (they were BLOCKED in this same
        // handler when /compact was sent). B mints its own run only here,
        // after the compact result, retaining its own run linkage.
        this.flushQueuedRecords();
      } else if (usage && orgId && this.runtime) {
        const policy = getEffectiveCompaction(orgId);
        const estimate = contextEstimateTokens(usage);
        const decision = evaluateAutoCompact(policy, estimate, this.autoCompactInFlight);
        if (decision.trigger) {
          this.autoCompactInFlight = true;
          this.awaitingAutoCompactResult = true;
          // The /compact turn renders as a command result, not chat text.
          this.currentTurnIsCommand = true;
          this.recordEvent("auto_compact", {
            estimateTokens: estimate,
            thresholdTokens: policy.thresholdTokens,
            keepRecentTurns: policy.keepRecentTurns,
            source: policy.source,
          });
          this.broadcast({
            type: "system_notice",
            subtype: "compact_auto",
            estimateTokens: estimate,
            thresholdTokens: policy.thresholdTokens,
            chatId: this.chatId,
          });
          console.log(
            `[Session ${this.chatId}] M4 auto-compact: estimate=${estimate} >= threshold=${policy.thresholdTokens} (${policy.source})`
          );
          try {
            this.runtime.sendMessage("/compact");
            // The compact command is a fresh busy cycle for lifecycle watchers
            // (busy went false above; re-raise before the sweep can idle-stop).
            if (this.lifecycleHooks && this.userId !== "unknown") {
              this.lifecycleHooks.onAgentBusyChange(this.userId, this.chatId, true);
            }
          } catch (err) {
            // S1: /compact undeliverable — release the exactly-once gates (no
            // result will ever arrive to release them) and surface the error.
            this.autoCompactInFlight = false;
            this.awaitingAutoCompactResult = false;
            this.broadcastError(`自动压缩命令未送达 Agent: ${(err as Error).message}`);
          }
        }
      }

      // S2 rev (Codex P1): serialized dispatch — the result frame finalizes
      // the turn and ADVANCES the FIFO. A user turn queued behind this one
      // dispatches now (after any turn-boundary auto-compact, so compaction
      // stays ordered before the next turn).
      this.flushQueuedRecords();

      // M8g: idle result boundary — if the flush left nothing active/queued
      // (guard checks), a drifted control plane swaps the runtime NOW so the
      // NEXT message runs on fresh capabilities without a manual stop. A
      // swap-in-background also defers cleanly behind auto-compact (guard).
      this.maybeHotSwap();
    }
  }

  getSDKInitSnapshot(): SDKInitSnapshot | null {
    return this.sdkInitSnapshot;
  }

  // Set the userId (called from server when we know the authenticated user)
  setUserId(userId: string) {
    if (this.userId === "unknown") {
      this.userId = userId;
      // Create/get agent session record
      this.agentSessionRecord = eventStore.getOrCreateSession(userId, this.chatId);
      // Flush any buffered claude session id
      if (this.pendingClaudeSessionId && this.agentSessionRecord) {
        eventStore.updateClaudeSessionId(this.agentSessionRecord.id, this.pendingClaudeSessionId);
        this.pendingClaudeSessionId = null;
      }
    }
  }

  subscribe(client: WSClient) {
    this.subscribers.add(client);
    client.sessionId = this.chatId;
    this.syncSubscriberCount();
    // Send cached slash commands so the command menu works immediately
    if (this.availableSlashCommands.length > 0 && client.readyState === client.OPEN) {
      client.send(
        JSON.stringify({
          type: "slash_commands",
          commands: this.availableSlashCommands,
          chatId: this.chatId,
        })
      );
    }
    // A2UI v2 (S2): replay LIVE pending cards so a refreshed client can still
    // submit them. Deferred one tick — server.ts sends the history frame
    // right AFTER subscribe() returns, and the replay must land AFTER it
    // (Codex plan review R1: history replay re-renders these blocks as inert
    // history; this frame re-arms the same blockId as interactive).
    if (this.pendingA2UiTool.size > 0 && client.readyState === client.OPEN) {
      setTimeout(() => {
        if (client.readyState !== client.OPEN) return;
        for (const [blockId, { block }] of this.pendingA2UiTool) {
          try {
            client.send(JSON.stringify({ type: "a2ui_block", blockId, block, chatId: this.chatId }));
          } catch {
            /* broadcast() cleanup removes closed subscribers */
          }
        }
      }, 0);
    }
  }

  unsubscribe(client: WSClient) {
    this.subscribers.delete(client);
    this.syncSubscriberCount();
  }

  private syncSubscriberCount() {
    if (this.lifecycleHooks && this.userId !== "unknown") {
      this.lifecycleHooks.onSubscriberCountChange(this.userId, this.chatId, this.subscribers.size);
    }
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  private broadcast(message: any) {
    const messageStr = JSON.stringify(message);
    for (const client of this.subscribers) {
      try {
        if (client.readyState === client.OPEN) {
          client.send(messageStr);
        }
      } catch (error) {
        console.error("Error broadcasting to client:", error);
        this.subscribers.delete(client);
      }
    }
  }

  private broadcastError(error: string) {
    this.recordEvent("error", { error });
    // S1: durable user-visible error — persist as a system message. ChatStore
    // encodes it into the storable form ([agent_error] prefix) and decodes on
    // every read, so history replay restores the red banner after refresh.
    // ChatStore's 10s role+content dedup naturally caps repeat error floods.
    try {
      chatStore.addMessage(this.chatId, {
        role: "system",
        content: error,
      });
    } catch (err) {
      console.error(`[Session ${this.chatId}] persist agent error failed:`, (err as Error).message);
    }
    this.broadcast({
      type: "error",
      error,
      chatId: this.chatId,
    });
  }

  // Stop the current agent execution
  stop() {
    // S2: invalidate any in-flight governed recovery — a rebuild completing
    // after a user stop must not install a zombie runtime.
    this.recoveryEpoch++;
    // A2UI v2: cancel pending blocking cards FIRST — the aborted SDK turn
    // must receive its cancelled tool_result, and no timer may outlive it.
    this.rejectAllPendingA2Ui("Agent 执行已被用户停止");
    // S2 rev (Codex P1): the aborted turn never reaches a result frame —
    // drop its record so serialized dispatch doesn't deadlock behind it.
    // Queued (never-dispatched) turns survive; they dispatch after the abort
    // settles or on the next user message.
    this.activeRecords = [];
    this.runtime?.abort();
    this.recordEvent("stopped", {});
    // Agent OS M3 (plan §7): an in-flight run that was aborted never reaches a
    // result event — mark it 'stopped' so it isn't left 'running' forever.
    if (this.currentRunId && this.agentSessionRecord) {
      try {
        agentRunService.markRunningAsStopped(this.agentSessionRecord.id);
      } catch (err) {
        console.error("[Session] markRunningAsStopped failed:", err);
      }
      this.currentRunId = null;
    }
    this.broadcast({
      type: "stopped",
      chatId: this.chatId,
    });
  }

  // Close the session
  close() {
    // S2: closing invalidates in-flight recovery permanently (closedFlag, not
    // just an epoch bump — a closed session must never install a runtime).
    this.recoveryEpoch++;
    this.closedFlag = true;
    // S2: the session is going away — no record may dispatch afterwards.
    this.activeRecords = [];
    this.queuedRecords = [];
    // Agent OS M3 (plan §7): mark any still-'running' run on this agent_session
    // 'stopped' — the session is going away and no result event will fire.
    if (this.agentSessionRecord) {
      try {
        agentRunService.markRunningAsStopped(this.agentSessionRecord.id);
      } catch (err) {
        console.error("[Session] markRunningAsStopped (close) failed:", err);
      }
    }
    this.currentRunId = null;
    // A2UI v2: reject any still-pending show_ui blocks — the session is going
    // away and no submit will ever arrive.
    this.rejectAllPendingA2Ui("会话已关闭");
    this.runtime?.close();
  }
}
