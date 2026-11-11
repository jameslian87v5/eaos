import Dockerode from "dockerode";
import { eventStore, type AgentSessionRecord } from "./event-store.js";
import { chatStore } from "./chat-store.js";
import { DockerAgentRuntime, type DockerRuntimeOptions, getWorkspaceVolumeName, getClaudeHomeVolumeName } from "./docker-runtime.js";
import type { AgentRuntime, AgentRuntimeOptions } from "./agent-runtime.js";
import { resolvePolicy, type RuntimePolicy } from "./runtime-policy.js";
import { getRuntimeSettings } from "./runtime-settings.js";
import { buildResolvedSnapshot } from "./capability-diagnostics.js";
import { revokeConnectorTokensForRuntime } from "./connector-capability-token.js";
import type { SDKInitSnapshot } from "./session.js";

const docker = new Dockerode();

const AGENT_IMAGE = "eaos-agent:latest";
const CONTAINER_LABEL = "app=eaos-agent";
// Pre-rename deployments ran containers under this label; reconcile must keep
// recognizing them so they age out naturally instead of becoming invisible.
const LEGACY_CONTAINER_LABEL = "app=simple-chatapp-agent";

// Fixed intervals (not policy-driven)
const HEALTH_INTERVAL_MS = 30 * 1000;           // health check every 30s
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;       // idle sweep every 60s

export type StopByChatIdResult = {
  status: "stopped" | "not_found" | "already_stopped";
  chatId: string;
};

export type ManagedRuntimeView = {
  userId: string;
  chatId: string;
  status: string;
  containerId: string | null;
  hostPort: number | null;
  restoreMode: string | null;
  restartCount: number;
  subscriberCount: number;
  isAgentBusy: boolean;
  hasPendingApproval: boolean;
  lastActivityAt: string | null;
  idleMs: number | null;
  lastError: string | null;
  sdkInit: SDKInitSnapshot | null;
};

export type ContainerStatus =
  | "creating" | "starting" | "ready" | "running"
  | "idle" | "paused" | "resuming"
  | "stopping" | "stopped" | "removed"
  | "unhealthy" | "crashed";

interface ManagedRuntime {
  runtime: DockerAgentRuntime;
  sessionRecord: AgentSessionRecord;
  lastActivity: number; // epoch ms
  healthMissed: number;
  subscriberCount: number;    // WebSocket subscribers watching this chat
  hasPendingApproval: boolean; // pending tool approval in flight
  isAgentBusy: boolean;       // agent currently executing
}

export class ContainerManager {
  private runtimes = new Map<string, ManagedRuntime>(); // key: "userId:chatId"
  // S2 (resilience plan): per-key in-flight ensure dedup. Concurrent ensure
  // calls (session recreation racing governed recovery, burst sends) join the
  // SAME promise — one container, one ownership outcome.
  private inflightEnsures = new Map<string, Promise<AgentRuntime>>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private policy: RuntimePolicy;

  constructor() {
    this.policy = resolvePolicy();
    console.log(`[ContainerManager] Policy: idleStopMs=${this.policy.idleStopMs}, protectBusy=${this.policy.protectWhenBusy}, protectApproval=${this.policy.protectWhenPendingApproval}, protectSubscribers=${this.policy.protectWhenSubscribers}`);
  }

  // --- Lifecycle: ensure a running runtime ---

  async ensureRuntime(
    userId: string,
    chatId: string,
    options?: AgentRuntimeOptions
  ): Promise<AgentRuntime> {
    const key = `${userId}:${chatId}`;
    const inflight = this.inflightEnsures.get(key);
    if (inflight) return inflight;
    const p = this.doEnsureRuntime(userId, chatId, options).finally(() => {
      if (this.inflightEnsures.get(key) === p) this.inflightEnsures.delete(key);
    });
    this.inflightEnsures.set(key, p);
    return p;
  }

  // `protected` (not private) so the S2 in-flight dedup contract is
  // unit-testable via a subclass overriding the executor without Docker.
  protected async doEnsureRuntime(
    userId: string,
    chatId: string,
    options?: AgentRuntimeOptions
  ): Promise<AgentRuntime> {
    const key = `${userId}:${chatId}`;

    // Check in-memory first
    const existing = this.runtimes.get(key);
    if (existing && existing.runtime.getStatus() === "running") {
      this.markActivity(key);
      return existing.runtime;
    }

    // Check DB for existing session
    const dbSession = eventStore.getOrCreateSession(userId, chatId, "docker");

    // Decide: warm resume, cold resume, or fresh start
    if (dbSession.containerId && dbSession.status === "running") {
      // Try warm resume: reconnect to existing container
      try {
        return await this.warmResume(key, userId, chatId, dbSession, options);
      } catch (err) {
        const errMsg = (err as Error).message;
        console.log(`[ContainerManager] Warm resume failed for ${key}:`, errMsg);
        // Mark DB as paused so subsequent logic can cold-resume
        eventStore.updateStatus(dbSession.id, "paused");
        eventStore.updateLastError(dbSession.id, `warm_resume_failed: ${errMsg}`);
        dbSession.status = "paused";
      }
    }

    if (dbSession.claudeSessionId) {
      // Cold resume: new container with persisted claudeSessionId
      return await this.coldResume(key, userId, chatId, dbSession, options);
    }

    // Fresh start (no claudeSessionId to resume from)
    return await this.freshStart(key, userId, chatId, dbSession, options);
  }

  // --- Warm resume: reconnect to existing container ---

  /**
   * Record the resolved capability snapshot (MP4c). Called after a container is
   * (re)created from a fresh resolve — coldResume / freshStart / fallbackFromMessages.
   * Best-effort: an audit-write failure must never break runtime creation.
   */
  private recordResolvedSnapshot(
    userId: string,
    chatId: string,
    session: AgentSessionRecord,
    options?: AgentRuntimeOptions
  ) {
    if (!options?.capabilityBundle || !options.configVersion) return;
    try {
      eventStore.appendEvent(
        userId,
        chatId,
        session.id,
        "resolved_snapshot",
        buildResolvedSnapshot(options.capabilityBundle, options.configVersion)
      );
    } catch (err) {
      console.error("[ContainerManager] Failed to record resolved_snapshot:", err);
    }
  }

  private async warmResume(
    key: string,
    userId: string,
    chatId: string,
    session: AgentSessionRecord,
    options?: AgentRuntimeOptions
  ): Promise<AgentRuntime> {
    // Verify container is actually running via Docker
    const container = docker.getContainer(session.containerId!);
    const info = await container.inspect();
    if (!info.State.Running) {
      throw new Error("Container not running");
    }

    // R1 (MP4c): detect control-plane drift since the last resolve. If the
    // current configVersion differs from the last resolved_snapshot, the running
    // container is stale. Record it; only force a rebuild when the admin opts in
    // (autoRebuildOnConfigDrift) — otherwise warm resume promises continuity and
    // drift is surfaced via the diagnostics stale badge + manual Stop/Rebuild.
    if (options?.configVersion) {
      const last = eventStore.getLatestEventByType(userId, chatId, "resolved_snapshot");
      let lastVersion: string | undefined;
      if (last) {
        try {
          lastVersion = (JSON.parse(last.payloadJson) as { configVersion?: string }).configVersion;
        } catch {
          /* malformed payload — treat as no comparable version */
        }
      }
      if (lastVersion && lastVersion !== options.configVersion) {
        try {
          eventStore.appendEvent(userId, chatId, session.id, "runtime_config_stale", {
            resolvedVersion: lastVersion,
            currentVersion: options.configVersion,
          });
        } catch (err) {
          console.error("[ContainerManager] Failed to record runtime_config_stale:", err);
        }
        console.warn(
          `[ContainerManager] Config drift on warm resume ${key}: ${lastVersion} → ${options.configVersion}`
        );
        if (getRuntimeSettings().autoRebuildOnConfigDrift) {
          throw new Error(`config_version_stale: ${lastVersion} → ${options.configVersion}`);
        }
      }
    }

    const runtime = new DockerAgentRuntime({
      ...options,
      chatId,
      hostPort: session.hostPort || undefined,
      claudeSessionId: session.claudeSessionId || undefined,
      onSessionId: (sid) => this.handleSessionId(session.id, sid),
    });

    // Reconnect to existing container — no new container creation
    await runtime.initializeReconnect(session.containerId!);

    this.runtimes.set(key, {
      runtime,
      sessionRecord: session,
      lastActivity: Date.now(),
      healthMissed: 0,
      subscriberCount: 0,
      hasPendingApproval: false,
      isAgentBusy: false,
    });

    eventStore.updateStatus(session.id, "running");
    eventStore.updateActivity(session.id);
    console.log(`[ContainerManager] Warm resumed ${key}`);
    return runtime;
  }

  // --- Cold resume: new container with claudeSessionId ---

  private async coldResume(
    key: string,
    userId: string,
    chatId: string,
    session: AgentSessionRecord,
    options?: AgentRuntimeOptions
  ): Promise<AgentRuntime> {
    console.log(`[ContainerManager] Cold resume ${key} with claudeSessionId=${session.claudeSessionId}`);

    try {
      const runtime = new DockerAgentRuntime({
        ...options,
        chatId,
        claudeSessionId: session.claudeSessionId || undefined,
        onSessionId: (sid) => this.handleSessionId(session.id, sid),
      });

      await runtime.initialize();
      this.recordResolvedSnapshot(userId, chatId, session, options);

      eventStore.updateContainerInfo(
        session.id,
        runtime.getContainerId()!,
        `eaos-agent-${chatId.slice(0, 8)}`,
        runtime.getHostPort(),
        getWorkspaceVolumeName(chatId),
        getClaudeHomeVolumeName(chatId)
      );
      eventStore.updateLastError(session.id, null);
      eventStore.updateRestoreMode(session.id, "claude_resume");
      eventStore.incrementRestart(session.id);
      eventStore.updateActivity(session.id);

      this.runtimes.set(key, {
        runtime,
        sessionRecord: { ...session, containerId: runtime.getContainerId(), status: "running" },
        lastActivity: Date.now(),
        healthMissed: 0,
        subscriberCount: 0,
        hasPendingApproval: false,
        isAgentBusy: false,
      });

      console.log(`[ContainerManager] Cold resumed ${key}`);
      return runtime;
    } catch (err) {
      const errMsg = (err as Error).message;
      console.warn(`[ContainerManager] Claude resume failed for ${key}, falling back to messages:`, errMsg);
      // Record the resume failure for diagnostics before attempting fallback
      eventStore.updateLastError(session.id, `claude_resume_failed: ${errMsg}`);
      return this.fallbackFromMessages(key, userId, chatId, session, options);
    }
  }

  // --- Fallback: rebuild context from DB messages ---

  private async fallbackFromMessages(
    key: string,
    userId: string,
    chatId: string,
    session: AgentSessionRecord,
    options?: AgentRuntimeOptions
  ): Promise<AgentRuntime> {
    console.log(`[ContainerManager] Fallback from messages for ${key}`);

    // Start a fresh container (no claudeSessionId)
    const runtime = new DockerAgentRuntime({
      ...options,
      chatId,
      onSessionId: (sid) => this.handleSessionId(session.id, sid),
    });

    await runtime.initialize();
    this.recordResolvedSnapshot(userId, chatId, session, options);

    // Load history and send as context to the new agent
    const messages = chatStore.getMessages(chatId);
    if (messages.length > 0) {
      const contextLines = messages.map((m) =>
        `[${m.role}]: ${m.content}`
      ).join("\n");
      const contextMsg = `[System: This is a resumed conversation. Previous messages:\n${contextLines}\n\nPlease continue the conversation from where it left off.]`;
      try {
        // S1: the context handoff is a runtime delivery — a dead IPC must not
        // crash the resume path (the runtime will be marked crashed by the
        // caller's health sweep instead of silently faking a resume).
        runtime.sendMessage(contextMsg);
      } catch (err) {
        console.error(
          `[ContainerManager] from_messages context delivery failed for ${key}:`,
          (err as Error).message
        );
      }
    }

    eventStore.updateContainerInfo(
      session.id,
      runtime.getContainerId()!,
      `eaos-agent-${chatId.slice(0, 8)}`,
      runtime.getHostPort(),
      getWorkspaceVolumeName(chatId),
      getClaudeHomeVolumeName(chatId)
    );
    eventStore.updateRestoreMode(session.id, "from_messages");
    eventStore.updateCleanupReason(session.id, "resume_fallback");
    eventStore.incrementRestart(session.id);
    eventStore.updateActivity(session.id);

    this.runtimes.set(key, {
      runtime,
      sessionRecord: { ...session, containerId: runtime.getContainerId(), status: "running" },
      lastActivity: Date.now(),
      healthMissed: 0,
      subscriberCount: 0,
      hasPendingApproval: false,
      isAgentBusy: false,
    });

    console.log(`[ContainerManager] Fallback from messages complete for ${key}`);
    return runtime;
  }

  // --- Fresh start ---

  private async freshStart(
    key: string,
    userId: string,
    chatId: string,
    session: AgentSessionRecord,
    options?: AgentRuntimeOptions
  ): Promise<AgentRuntime> {
    console.log(`[ContainerManager] Fresh start ${key}`);

    const runtime = new DockerAgentRuntime({
      ...options,
      chatId,
      onSessionId: (sid) => this.handleSessionId(session.id, sid),
    });

    await runtime.initialize();
    this.recordResolvedSnapshot(userId, chatId, session, options);

    eventStore.updateContainerInfo(
      session.id,
      runtime.getContainerId()!,
      `eaos-agent-${chatId.slice(0, 8)}`,
      runtime.getHostPort(),
      getWorkspaceVolumeName(chatId),
      getClaudeHomeVolumeName(chatId)
    );
    eventStore.updateLastError(session.id, null);
    eventStore.updateRestoreMode(session.id, "fresh");
    eventStore.updateActivity(session.id);

    this.runtimes.set(key, {
      runtime,
      sessionRecord: { ...session, containerId: runtime.getContainerId(), status: "running" },
      lastActivity: Date.now(),
      healthMissed: 0,
      subscriberCount: 0,
      hasPendingApproval: false,
      isAgentBusy: false,
    });

    console.log(`[ContainerManager] Fresh started ${key}`);
    return runtime;
  }

  // --- Activity tracking ---

  markActivity(key: string) {
    const managed = this.runtimes.get(key);
    if (managed) {
      managed.lastActivity = Date.now();
      managed.healthMissed = 0;
      eventStore.updateActivity(managed.sessionRecord.id);
    }
  }

  markActivityByChat(userId: string, chatId: string) {
    this.markActivity(`${userId}:${chatId}`);
  }

  // --- Session ID capture ---

  private handleSessionId(sessionRecordId: string, claudeSessionId: string) {
    eventStore.updateClaudeSessionId(sessionRecordId, claudeSessionId);
  }

  // --- Stop a specific runtime ---

  async stopRuntime(userId: string, chatId: string, reason = "user_request"): Promise<void> {
    const key = `${userId}:${chatId}`;
    // Octop absorption M1b: runtime stop is IMMEDIATE token revocation — every
    // internal-mcp capability token minted for this runtime dies now (a warm
    // reconnect/rebuild mints a fresh token on its next resolve()).
    revokeConnectorTokensForRuntime(key);
    const managed = this.runtimes.get(key);

    console.log(`[ContainerManager] Stopping ${key}: ${reason}`);
    if (managed) {
      try {
        await managed.runtime.close();
      } catch (err) {
        console.error(`[ContainerManager] Error closing runtime ${key}:`, err);
      }
      eventStore.updateStatus(managed.sessionRecord.id, "stopped");
      eventStore.updateCleanupReason(managed.sessionRecord.id, reason);
      this.runtimes.delete(key);
    }

    // S2: an ensure that was still in flight when the stop arrived would
    // otherwise install a container AFTER the stop — a zombie nobody owns.
    // Join the in-flight promise and close its result so stop and recovery
    // observe ONE ownership outcome. The runtimes-map entry it created (if
    // any) is removed by the next health sweep (close() → status "removed").
    const inflight = this.inflightEnsures.get(key);
    if (inflight) {
      try {
        const rt = await inflight;
        await rt.close();
        console.log(`[ContainerManager] Closed late in-flight ensure result for ${key}`);
      } catch {
        // The in-flight ensure itself failed — nothing to close.
      }
      this.runtimes.delete(key);
    }
  }

  // --- Health check loop ---

  startHealthChecks() {
    if (this.healthTimer) return;

    this.healthTimer = setInterval(() => {
      for (const [key, managed] of this.runtimes) {
        const status = managed.runtime.getStatus();
        if (status === "crashed" || status === "stopped" || status === "removed") {
          console.log(`[ContainerManager] Runtime ${key} is ${status}, cleaning up`);
          eventStore.updateStatus(managed.sessionRecord.id, status);
          if (status === "crashed") {
            eventStore.updateLastError(managed.sessionRecord.id, "Container connection lost");
            eventStore.updateCleanupReason(managed.sessionRecord.id, "container_crashed");
          }
          this.runtimes.delete(key);
        }
      }
    }, HEALTH_INTERVAL_MS);
  }

  // --- Subscriber & state tracking (called by Session layer) ---

  updateSubscriberCount(userId: string, chatId: string, count: number) {
    const managed = this.runtimes.get(`${userId}:${chatId}`);
    if (managed) managed.subscriberCount = count;
  }

  updateAgentBusy(userId: string, chatId: string, busy: boolean) {
    const managed = this.runtimes.get(`${userId}:${chatId}`);
    if (managed) managed.isAgentBusy = busy;
  }

  updatePendingApproval(userId: string, chatId: string, pending: boolean) {
    const managed = this.runtimes.get(`${userId}:${chatId}`);
    if (managed) managed.hasPendingApproval = pending;
  }

  // --- Idle detection loop ---
  // Per LOCAL_DEV_PLAN.md:
  //   - chat 没有 WebSocket subscriber
  //   - Agent 当前不在执行
  //   - 没有 pending approval
  //   - 空闲超过 30 分钟

  startIdleDetection() {
    if (this.idleTimer) return;

    this.idleTimer = setInterval(async () => {
      if (this.shuttingDown) return;

      const now = Date.now();
      // Live idle threshold from runtime-settings (admin-editable, no restart needed)
      const idleStopMs = getRuntimeSettings().idleStopMs;
      for (const [key, managed] of this.runtimes) {
        const idleMs = now - managed.lastActivity;

        // Protection rules — all driven by RuntimePolicy
        if (this.policy.protectWhenSubscribers && managed.subscriberCount > 0) continue;
        if (this.policy.protectWhenBusy && managed.isAgentBusy) continue;
        if (this.policy.protectWhenPendingApproval && managed.hasPendingApproval) continue;

        if (idleMs > idleStopMs) {
          console.log(`[ContainerManager] Stopping idle runtime ${key} (${Math.round(idleMs / 1000)}s idle, 0 subscribers)`);
          await this.stopRuntime(
            managed.sessionRecord.userId,
            managed.sessionRecord.chatId,
            "idle_timeout"
          );
          eventStore.updateStatus(managed.sessionRecord.id, "stopped");
        }
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  // --- Runtime status (for GET /api/chats/:id/runtime) ---

  getRuntimeStatus(userId: string, chatId: string) {
    const key = `${userId}:${chatId}`;
    const managed = this.runtimes.get(key);
    const dbSession = eventStore.getSessionByChat(userId, chatId);

    if (!dbSession) {
      return { status: "none", message: "No agent session found for this chat" };
    }

    // In-memory state takes precedence for live status
    const liveStatus = managed?.runtime.getStatus() ?? dbSession.status;

    return {
      status: liveStatus,
      restoreMode: dbSession.restoreMode,
      containerId: dbSession.containerId,
      hostPort: dbSession.hostPort,
      claudeSessionId: dbSession.claudeSessionId,
      restartCount: dbSession.restartCount,
      workspaceVolume: dbSession.workspaceVolume,
      claudeHomeVolume: dbSession.claudeHomeVolume,
      lastActivityAt: dbSession.lastActivityAt,
      lastError: dbSession.lastError,
      cleanupReason: dbSession.cleanupReason,
      // Live in-memory state (null if container not in memory)
      isAgentBusy: managed?.isAgentBusy ?? false,
      subscriberCount: managed?.subscriberCount ?? 0,
      hasPendingApproval: managed?.hasPendingApproval ?? false,
      // Volume bytes: requires docker exec — deferred to future
      workspaceBytes: null,
      claudeHomeBytes: null,
    };
  }

  // --- Startup reconciliation ---

  async reconcile(): Promise<void> {
    console.log("[ContainerManager] Reconciling containers...");

    // Get DB records that think they have running containers
    const dbSessions = eventStore.getActiveDockerSessions();

    // List actual Docker containers with our label. NOTE: multiple values in
    // one label filter are AND-ed by the Docker API, so the current + legacy
    // labels need separate queries merged by Id.
    const byLabel = await Promise.all(
      [CONTAINER_LABEL, LEGACY_CONTAINER_LABEL].map((l) =>
        docker.listContainers({ all: true, filters: { label: [l] } })
      )
    );
    const seen = new Map<string, Dockerode.ContainerInfo>();
    for (const c of byLabel.flat()) seen.set(c.Id, c);
    const containers = [...seen.values()];
    const runningIds = new Set(containers.map((c) => c.Id));

    for (const session of dbSessions) {
      if (session.containerId && !runningIds.has(session.containerId)) {
        // DB says running but Docker says gone → mark as paused (can cold resume)
        console.log(`[ContainerManager] Orphaned session ${session.userId}:${session.chatId}, marking paused`);
        eventStore.updateStatus(session.id, "paused");
      }
    }

    // Clean up containers that we don't know about
    for (const containerInfo of containers) {
      const id = containerInfo.Id;
      const knownIds = dbSessions.map((s) => s.containerId);
      if (!knownIds.includes(id)) {
        console.log(`[ContainerManager] Unknown container ${id.slice(0, 12)}, stopping`);
        try {
          const container = docker.getContainer(id);
          await container.stop({ t: 5 });
        } catch {
          // Already stopped
        }
      }
    }

    console.log(`[ContainerManager] Reconciliation complete: ${dbSessions.length} DB sessions, ${containers.length} Docker containers`);
  }

  // --- Delete chat: stop container + remove volume + clean DB ---
  // Per LOCAL_DEV_PLAN.md:
  //   校验 userId → stop/remove container → 删除 volume → 删除 DB records

  async deleteChat(userId: string, chatId: string): Promise<void> {
    const key = `${userId}:${chatId}`;
    console.log(`[ContainerManager] Deleting chat ${key}`);

    // Stop runtime if running
    await this.stopRuntime(userId, chatId, "chat_deleted");

    // Remove per-chat volumes if policy allows
    if (this.policy.deleteChatRemovesVolumes) {
      const { removeWorkspaceVolume, removeClaudeHomeVolume } = await import("./docker-runtime.js");
      await removeWorkspaceVolume(chatId);
      await removeClaudeHomeVolume(chatId);
    }

    // Clean DB records (events + session)
    eventStore.deleteByChat(userId, chatId);
  }

  /** Expose resolved policy for admin API / diagnostics. */
  getPolicy(): RuntimePolicy {
    return { ...this.policy };
  }

  // --- Graceful shutdown ---

  async shutdownAll(reason = "server_shutdown"): Promise<void> {
    this.shuttingDown = true;

    // Stop timers
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }

    console.log(`[ContainerManager] Shutting down all runtimes: ${reason}`);
    const promises: Promise<void>[] = [];
    for (const [key, managed] of this.runtimes) {
      promises.push(
        this.stopRuntime(managed.sessionRecord.userId, managed.sessionRecord.chatId, reason)
      );
    }
    await Promise.allSettled(promises);
    console.log("[ContainerManager] All runtimes shut down");
  }

  // --- Image management ---

  async ensureImage(): Promise<boolean> {
    try {
      const image = docker.getImage(AGENT_IMAGE);
      await image.inspect();
      return true;
    } catch {
      console.log(`[ContainerManager] Image ${AGENT_IMAGE} not found, needs build`);
      return false;
    }
  }

  // --- Info ---

  getActiveCount(): number {
    return this.runtimes.size;
  }

  getAllRuntimes(sdkInitByChatId: Map<string, SDKInitSnapshot | null> = new Map()): ManagedRuntimeView[] {
    const now = Date.now();
    const result: ManagedRuntimeView[] = [];
    const seenChatIds = new Set<string>();

    // In-memory runtimes first — live state takes precedence
    for (const [, managed] of this.runtimes) {
      const { userId, chatId } = managed.sessionRecord;
      seenChatIds.add(chatId);
      const dbSession = eventStore.getSessionByChat(userId, chatId);
      result.push({
        userId,
        chatId,
        status: managed.runtime.getStatus(),
        containerId: dbSession?.containerId ?? null,
        hostPort: dbSession?.hostPort ?? null,
        restoreMode: dbSession?.restoreMode ?? null,
        restartCount: dbSession?.restartCount ?? 0,
        subscriberCount: managed.subscriberCount,
        isAgentBusy: managed.isAgentBusy,
        hasPendingApproval: managed.hasPendingApproval,
        lastActivityAt: dbSession?.lastActivityAt ?? null,
        idleMs: now - managed.lastActivity,
        lastError: dbSession?.lastError ?? null,
        sdkInit: sdkInitByChatId.get(chatId) ?? null,
      });
    }

    // DB sessions not yet in memory (e.g., after server restart before warm reconnect)
    for (const s of eventStore.getActiveDockerSessions()) {
      if (seenChatIds.has(s.chatId)) continue;
      result.push({
        userId: s.userId,
        chatId: s.chatId,
        status: s.status,
        containerId: s.containerId ?? null,
        hostPort: s.hostPort ?? null,
        restoreMode: s.restoreMode ?? null,
        restartCount: s.restartCount ?? 0,
        subscriberCount: 0,
        isAgentBusy: false,
        hasPendingApproval: false,
        lastActivityAt: s.lastActivityAt ?? null,
        idleMs: null,
        lastError: s.lastError ?? null,
        sdkInit: sdkInitByChatId.get(s.chatId) ?? null,
      });
    }

    return result;
  }

  async stopByChatId(chatId: string): Promise<StopByChatIdResult> {
    // Case 1: runtime is live in memory
    for (const [, managed] of this.runtimes) {
      if (managed.sessionRecord.chatId === chatId) {
        await this.stopRuntime(managed.sessionRecord.userId, chatId, "admin_stop");
        return { status: "stopped", chatId };
      }
    }

    // Case 2: DB-known session not yet in memory (server restart / pre-warm-resume)
    const activeSessions = eventStore.getActiveDockerSessions();
    const dbSession = activeSessions.find((s) => s.chatId === chatId);

    if (!dbSession) {
      return { status: "not_found", chatId };
    }

    if (dbSession.status === "stopped" || dbSession.status === "removed") {
      return { status: "already_stopped", chatId };
    }

    // Try to stop the container directly via Dockerode
    if (dbSession.containerId) {
      try {
        const container = docker.getContainer(dbSession.containerId);
        const info = await container.inspect();
        if (info.State.Running) {
          await container.stop({ t: 10 });
          console.log(`[ContainerManager] Admin force-stopped container ${dbSession.containerId.slice(0, 12)} for chat ${chatId}`);
        }
      } catch (err) {
        console.warn(`[ContainerManager] Admin stop container for ${chatId}:`, (err as Error).message);
      }
    }

    eventStore.updateStatus(dbSession.id, "stopped");
    eventStore.updateCleanupReason(dbSession.id, "admin_stop");
    return { status: "stopped", chatId };
  }

}

export const containerManager = new ContainerManager();
