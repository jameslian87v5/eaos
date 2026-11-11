import Dockerode from "dockerode";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { gunzipSync } from "zlib";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  RuntimeEvent,
  RuntimeStatus,
} from "./agent-runtime.js";
import {
  CONTAINER_WS_PORT,
  type IPCToContainer,
  type IPCFromContainer,
} from "./ipc-protocol.js";
import { getRuntimeSettings } from "./runtime-settings.js";
import { isA2UIEnabled } from "./a2ui-prompt.js";
import { resolveSubmitTimeoutMs } from "./a2ui-tool.js";
import { isStreamingEnabled } from "./streaming-config.js";

const docker = new Dockerode();

const AGENT_IMAGE_NAME = "eaos-agent:latest";
const CONTAINER_PREFIX = "eaos-agent-";
const VOLUME_PREFIX = "agent-workspace-";
const CLAUDE_HOME_VOLUME_PREFIX = "agent-claude-home-";
const WORKSPACE_MOUNT = "/workspace";
const CLAUDE_HOME_MOUNT = "/root/.claude";

// Task 2 (P0.2): the container's WS IPC port maps to the VM's LOOPBACK only.
// Dockerode omits HostIp → binds 0.0.0.0 (all interfaces), which would expose
// the raw agent IPC to whatever the VM's firewall lets through. The host
// platform connects via ws://localhost:<hostPort>, so loopback is sufficient
// for warm/cold resume. Guarded by server/docker-runtime-network.test.ts.
export function buildAgentPortBindings(hostPort: number): {
  "9100/tcp": Array<{ HostIp: "127.0.0.1"; HostPort: string }>;
} {
  // Key derives from the shared constant so ExposedPorts and PortBindings can
  // never drift apart; the asserted type keeps the plan's literal contract.
  return {
    [`${CONTAINER_WS_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }],
  } as { "9100/tcp": Array<{ HostIp: "127.0.0.1"; HostPort: string }> };
}

export interface DockerRuntimeOptions extends AgentRuntimeOptions {
  chatId: string;
  // Host port to map (auto-assigned if not provided)
  hostPort?: number;
  // API key to forward to container
  apiKey?: string;
  // Claude session ID for resume
  claudeSessionId?: string;
}

export class DockerAgentRuntime implements AgentRuntime {
  private status: RuntimeStatus = "starting";
  private containerId: string | null = null;
  private ws: WebSocket | null = null;
  private hostPort: number;
  private options: DockerRuntimeOptions;
  private eventQueue: RuntimeEvent[] = [];
  private eventWaiters: ((event: RuntimeEvent | null) => void)[] = [];
  private closed = false;
  private onSessionId?: (sessionId: string) => void;
  private sessionIdCaptured = false;
  // S2 (resilience plan): idempotent death notification. Exactly one fire per
  // runtime lifecycle (WS close / container-stopped IPC / close() / failed
  // initialize); a listener registered after death fires immediately.
  private deathListener: ((reason: string) => void) | null = null;
  private deathNotified = false;
  private deathReason: string | null = null;

  constructor(options: DockerRuntimeOptions) {
    this.options = options;
    this.hostPort = options.hostPort || (30000 + Math.floor(Math.random() * 10000));
    this.onSessionId = options.onSessionId;
  }

  setDeathListener(listener: (reason: string) => void): void {
    this.deathListener = listener;
    if (this.deathNotified) {
      listener(this.deathReason!);
    }
  }

  private notifyDead(reason: string) {
    if (this.deathNotified) return;
    this.deathNotified = true;
    this.deathReason = reason;
    this.deathListener?.(reason);
  }

  // Must be called after construction to start the container and connect
  async initialize(): Promise<void> {
    try {
      await this.startContainer();
      await this.connectWebSocket();
      this.status = "running";
    } catch (err) {
      this.status = "crashed";
      this.notifyDead("initialize_failed");
      this.pushEvent({
        type: "error",
        error: `Failed to initialize container: ${(err as Error).message}`,
      });
      this.closeEventStream();
      throw err;
    }
  }

  // Reconnect to an existing running container (warm resume — no new container)
  async initializeReconnect(existingContainerId: string): Promise<void> {
    try {
      this.containerId = existingContainerId;
      await this.connectWebSocket();
      this.status = "running";
    } catch (err) {
      this.status = "crashed";
      this.notifyDead("reconnect_failed");
      this.pushEvent({
        type: "error",
        error: `Failed to reconnect to container: ${(err as Error).message}`,
      });
      this.closeEventStream();
      throw err;
    }
  }

  private async startContainer(): Promise<void> {
    const settings = getRuntimeSettings();
    const containerName = `${CONTAINER_PREFIX}${this.options.chatId.slice(0, 8)}-${uuidv4().slice(0, 6)}`;
    const volumeName = `${VOLUME_PREFIX}${this.options.chatId}`;
    const claudeHomeVolumeName = `${CLAUDE_HOME_VOLUME_PREFIX}${this.options.chatId}`;

    // Ensure workspace volume exists
    try {
      await docker.createVolume({ Name: volumeName });
    } catch {
      // Volume may already exist — that's fine
    }
    try {
      await docker.createVolume({ Name: claudeHomeVolumeName });
    } catch {
      // Volume may already exist — that's fine
    }

    const env: string[] = [
      `AGENT_WS_PORT=${CONTAINER_WS_PORT}`,
    ];

    // Forward API key
    if (this.options.apiKey) {
      env.push(`ANTHROPIC_API_KEY=${this.options.apiKey}`);
    } else if (process.env.ANTHROPIC_API_KEY) {
      env.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }
    // M8a: bearer-token deployments (e.g. Zhipu GLM-compatible endpoint) auth
    // with ANTHROPIC_AUTH_TOKEN instead of ANTHROPIC_API_KEY. Without this
    // forwarding the in-container CLI has no credential at all ("Not logged
    // in"). If both are present the SDK prefers AUTH_TOKEN (bearer).
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      env.push(`ANTHROPIC_AUTH_TOKEN=${process.env.ANTHROPIC_AUTH_TOKEN}`);
    }
    if (process.env.ANTHROPIC_BASE_URL) {
      env.push(`ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
    }
    if (process.env.AGENT_MODEL) {
      env.push(`AGENT_MODEL=${process.env.AGENT_MODEL}`);
    }
    if (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
      env.push(`CLAUDE_CODE_MAX_OUTPUT_TOKENS=${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS}`);
    }

    // Forward the Bailian (DashScope) key to the container as ENV ONLY — never
    // inside AGENT_SDK_OPTIONS (that blob is logged/inspectable). The in-process
    // platform-web-tools factory reads it from process.env inside the container.
    if (process.env.DASHSCOPE_API_KEY) {
      env.push(`DASHSCOPE_API_KEY=${process.env.DASHSCOPE_API_KEY}`);
    }

    // Forward tool config
    if (this.options.tools) {
      env.push(`AGENT_TOOLS=${JSON.stringify(this.options.tools)}`);
    }
    if (this.options.allowedTools) {
      env.push(`AGENT_ALLOWED_TOOLS=${JSON.stringify(this.options.allowedTools)}`);
    }

    // Plan Task 4: forward the user-memory quota so the in-container PreToolUse
    // hook can enforce it at the tool boundary (Write/Edit to /user-memory/MEMORY.md).
    env.push(`USER_MEMORY_QUOTA_BYTES=${settings.userMemoryQuotaBytes}`);

    // A2UI v2 (S3): gate + timeout budget. Decided HERE at container build
    // time (无热重载 convention — flip A2UI_ENABLED and stop/restart the
    // runtime). The container raises its own SDK timeout walls from
    // A2UI_SUBMIT_TIMEOUT_MS at boot.
    env.push(`AGENT_A2UI_ENABLED=${isA2UIEnabled() ? "true" : "false"}`);
    env.push(`A2UI_SUBMIT_TIMEOUT_MS=${resolveSubmitTimeoutMs()}`);

    // S3b (Appendix A.1): forward the streaming kill-switch so host and
    // container stay consistent (AGENT_STREAMING_ENABLED=false → the
    // container's SDK emits whole frames only, matching the host's
    // no-stream_event handling).
    env.push(`AGENT_STREAMING_ENABLED=${isStreamingEnabled() ? "true" : "false"}`);

    // Resume session
    if (this.options.claudeSessionId) {
      env.push(`CLAUDE_SESSION_ID=${this.options.claudeSessionId}`);
    }

    // Serialize full sdkOptions for agent-entry.ts consumption.
    // tools/allowedTools already passed as separate env vars above.
    // Do NOT log full content — may contain prompts or future secrets.
    const bundle = this.options.capabilityBundle;
    if (bundle?.sdkOptions) {
      const { tools: _t, allowedTools: _a, ...sdkRest } = bundle.sdkOptions;
      env.push(`AGENT_SDK_OPTIONS=${JSON.stringify(sdkRest)}`);
    }

    // Apply CapabilityBundle env (allowlisted — only bundle-specified keys)
    if (bundle?.env) {
      for (const [k, v] of Object.entries(bundle.env)) {
        env.push(`${k}=${v}`);
      }
    }

    // Build bind mounts: workspace + claude-home + capability mounts
    const binds: string[] = [
      `${volumeName}:${WORKSPACE_MOUNT}`,
      `${claudeHomeVolumeName}:${CLAUDE_HOME_MOUNT}`,
    ];

    // Append capability mounts (e.g. /opt/agent/plugins, /opt/agent/mcp)
    if (bundle?.mounts) {
      for (const m of bundle.mounts) {
        const suffix = m.readonly ? ":ro" : "";
        binds.push(`${m.hostPath}:${m.containerPath}${suffix}`);
      }
    }

    const container = await (docker.createContainer as any)({
      Image: AGENT_IMAGE_NAME,
      name: containerName,
      WorkingDir: WORKSPACE_MOUNT,  // cwd = /workspace — Claude Code project workspace
      Labels: {
        "app": "eaos-agent",
        "chatId": this.options.chatId,
        "runtimeType": "docker",
      },
      Env: env,
      ExposedPorts: { [`${CONTAINER_WS_PORT}/tcp`]: {} },
      HostConfig: {
        // Task 2 (P0.2): loopback-only IPC binding (see buildAgentPortBindings).
        PortBindings: buildAgentPortBindings(this.hostPort),
        Binds: binds,
        // Resource limits from runtime-settings (applied to new runtimes only)
        Memory: settings.memoryMb * 1024 * 1024,
        CpuPeriod: 100000,
        CpuQuota: Math.round(settings.cpuCores * 100000),
        AutoRemove: true,
      },
    });

    await container.start();
    this.containerId = container.id;
    console.log(`[DockerRuntime] Container ${containerName} started on 127.0.0.1:${this.hostPort}`);
  }

  private async connectWebSocket(): Promise<void> {
    const maxRetries = 20;
    const retryDelay = 500; // ms

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.tryConnect();
        return;
      } catch {
        if (i < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }
    }
    throw new Error(`Failed to connect to container WebSocket after ${maxRetries} retries`);
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${this.hostPort}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Connection timeout"));
      }, 3000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.setupMessageHandler(ws);
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupMessageHandler(ws: WebSocket) {
    ws.on("message", (data) => {
      try {
        const msg: IPCFromContainer = JSON.parse(data.toString());

        switch (msg.type) {
          case "sdk_event":
            this.pushEvent(msg.event as RuntimeEvent);
            break;
          case "a2ui_request":
            // Blocking show_ui from the container. Routed into the session
            // event stream (same pattern as sdk_event); Session.handleSDKMessage
            // owns persistence/broadcast/pending and calls forwardA2UiResult
            // with the terminal result.
            this.pushEvent({
              type: "a2ui_request",
              requestId: msg.requestId,
              block: msg.block,
              ...(msg.timeoutSec !== undefined ? { timeoutSec: msg.timeoutSec } : {}),
            } as unknown as RuntimeEvent);
            break;
          case "session_id":
            if (!this.sessionIdCaptured) {
              this.sessionIdCaptured = true;
              this.onSessionId?.(msg.sessionId);
            }
            break;
          case "error":
            this.pushEvent({ type: "error", error: msg.error });
            break;
          case "stopped":
            this.status = "stopped";
            this.notifyDead("container_stopped");
            this.closeEventStream();
            break;
          case "pong":
            // Heartbeat response
            break;
        }
      } catch (err) {
        console.error("[DockerRuntime] Failed to parse container message:", err);
      }
    });

    ws.on("close", () => {
      console.log("[DockerRuntime] Container WebSocket closed");
      if (this.status === "running") {
        this.status = "crashed";
        // S2 (resilience plan): the cache owner (Session) must learn the
        // runtime died — this is the root fix for the dead-cache bug. No
        // user-visible error event here (S1 round-2): the stream termination
        // is surfaced exactly-once by Session.onRuntimeStreamEnded.
        this.notifyDead("ws_closed");
        this.closeEventStream();
      }
    });

    ws.on("error", (err) => {
      console.error("[DockerRuntime] WebSocket error:", err);
    });
  }

  // --- Event stream management ---

  private pushEvent(event: RuntimeEvent) {
    if (this.eventWaiters.length > 0) {
      const waiter = this.eventWaiters.shift()!;
      waiter(event);
    } else {
      this.eventQueue.push(event);
    }
  }

  private closeEventStream() {
    this.closed = true;
    // Resolve all waiters with null to signal end
    for (const waiter of this.eventWaiters) {
      waiter(null);
    }
    this.eventWaiters = [];
  }

  private nextEvent(): Promise<RuntimeEvent | null> {
    if (this.eventQueue.length > 0) {
      return Promise.resolve(this.eventQueue.shift()!);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.eventWaiters.push(resolve);
    });
  }

  // --- AgentRuntime interface ---

  sendMessage(content: string): void {
    // S1 (resilience plan): delivery failure must be explicit — a dead IPC
    // silently swallowing user turns is the root bug this stage fixes.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agent runtime unreachable: container IPC not connected");
    }
    this.sendToContainer({ type: "user_message", content });
  }

  // A2UI v2 (S3): route a terminal show_ui result back to the container's
  // parked handler. Best-effort — a closed WS means the container is gone
  // (its own timer/gracefulShutdown cancels the call).
  forwardA2UiResult(requestId: string, result: import("./a2ui-schema.js").ShowUiResult): void {
    this.sendToContainer({ type: "a2ui_response", requestId, result });
  }

  async *getEventStream(): AsyncIterable<RuntimeEvent> {
    while (true) {
      const event = await this.nextEvent();
      if (event === null) break;
      yield event;
    }
  }

  handleApprovalResponse(response: { id: string; approved: boolean; message?: string }): boolean {
    // S1 (resilience plan): success only after a REAL forward. Returning true
    // on a dead IPC faked a "forwarded/decided" audit trail and left the
    // pending approval hanging as if the container had consumed it.
    // Contract: `false` = "not handled by this runtime" (local-mode stubs);
    // a FAILED docker forward THROWS so Session can distinguish the two.
    const sent = this.sendToContainer({
      type: "approval_response",
      id: response.id,
      approved: response.approved,
      message: response.message,
    });
    if (!sent) {
      throw new Error("approval forward failed: container IPC not connected");
    }
    return true;
  }

  abort(): void {
    this.sendToContainer({ type: "abort" });
    this.status = "stopping";
  }

  async close(): Promise<void> {
    this.status = "stopping";
    this.closeEventStream();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Stop container
    if (this.containerId) {
      try {
        const container = docker.getContainer(this.containerId);
        await container.stop({ t: 5 });
      } catch (err) {
        // Container may already be stopped/removed
        console.log("[DockerRuntime] Container stop error (may be expected):", (err as Error).message);
      }
      this.containerId = null;
    }

    this.status = "removed";
    this.notifyDead("closed");
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  getContainerId(): string | null {
    return this.containerId;
  }

  getHostPort(): number {
    return this.hostPort;
  }

  // --- Private helpers ---

  private sendToContainer(msg: IPCToContainer): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    console.warn("[DockerRuntime] Cannot send - WebSocket not connected");
    return false;
  }
}

// --- Static helpers ---

async function removeVolumeWithRetry(volumeName: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const volume = docker.getVolume(volumeName);
      await volume.remove();
      console.log(`[DockerRuntime] Removed volume ${volumeName}`);
      return;
    } catch (err) {
      const message = (err as Error).message;
      if (!message.includes("volume is in use") || attempt === maxAttempts) {
        console.log(`[DockerRuntime] Volume ${volumeName} removal skipped:`, message);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

/**
 * Write a file into the workspace named volume using putArchive on a helper container.
 * Uses tar to avoid stdin/hijack protocol pollution and shell command injection.
 */
export async function writeFileToVolume(
  chatId: string,
  containerPath: string,
  content: Buffer
): Promise<void> {
  const volumeName = getWorkspaceVolumeName(chatId);

  // Ensure volume exists
  try {
    await docker.createVolume({ Name: volumeName });
  } catch {
    // Already exists
  }

  // Decompose containerPath: strip /workspace prefix and use the rest as tar entry name.
  // e.g. /workspace/input/test.txt → tar entry "input/test.txt", extract at /workspace
  const relativePath = containerPath.replace(/^\/workspace\//, ""); // e.g. "input/test.txt"

  // Create a helper container (kept stopped — putArchive doesn't need it running)
  // AutoRemove: false because we remove it ourselves after putArchive
  const helper = await (docker.createContainer as any)({
    Image: AGENT_IMAGE_NAME,
    Cmd: ["true"],
    HostConfig: {
      Binds: [`${volumeName}:${WORKSPACE_MOUNT}`],
    },
  });

  try {
    // Build a minimal tar archive in memory
    const tar = buildTarOneFile(relativePath, content);

    // putArchive extracts the tar into `dir` inside the container's filesystem
    // This works even on a created-but-not-started container
    await helper.putArchive(tar, { path: WORKSPACE_MOUNT });

    console.log(`[DockerRuntime] Wrote ${content.length} bytes to volume ${volumeName}:${containerPath}`);
  } finally {
    // Clean up helper container
    try { await helper.remove({ force: true }); } catch { /* ignore */ }
  }
}

/**
 * Build a minimal POSIX tar archive containing a single file.
 * No external dependency needed — the tar format header is 512 bytes.
 */
function buildTarOneFile(filename: string, content: Buffer): Buffer {
  // TAR header: 512 bytes
  const header = Buffer.alloc(512, 0);

  // Name (0..99) — truncate to 100 bytes
  const nameBytes = Buffer.from(filename, "utf8").subarray(0, 100);
  nameBytes.copy(header, 0);

  // Mode (100..107) — 0644
  Buffer.from("0000644\0", "ascii").copy(header, 100);

  // UID (108..115) — 0
  Buffer.from("0000000\0", "ascii").copy(header, 108);

  // GID (116..123) — 0
  Buffer.from("0000000\0", "ascii").copy(header, 116);

  // Size (124..135) — octal, 11 chars + null
  const sizeOctal = content.length.toString(8).padStart(11, "0");
  Buffer.from(sizeOctal + "\0", "ascii").copy(header, 124);

  // Mtime (136..147) — current time in octal
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0");
  Buffer.from(mtime + "\0", "ascii").copy(header, 136);

  // Type flag (156) — '0' = regular file
  header[156] = 0x30; // ASCII '0'

  // Compute checksum (148..155): sum of all header bytes, treating checksum field as spaces
  Buffer.from("        ", "ascii").copy(header, 148); // 8 spaces placeholder
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  const csOctal = checksum.toString(8).padStart(6, "0");
  Buffer.from(csOctal + "\0 ", "ascii").copy(header, 148);

  // Data blocks: content padded to 512-byte boundary
  const padding = (512 - (content.length % 512)) % 512;
  const dataBlock = Buffer.concat([content, Buffer.alloc(padding, 0)]);

  // End-of-archive: two 512-byte zero blocks
  const endBlocks = Buffer.alloc(1024, 0);

  return Buffer.concat([header, dataBlock, endBlocks]);
}

/**
 * Demultiplex a Docker log stream (stdout/stderr multiplexed format).
 * Each frame: [streamType(1), padding(3), frameSize(4 BE), data(frameSize)]
 * Without this, binary files are corrupted by the 8-byte frame headers.
 */
function demuxDockerLogStream(buffer: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buffer.length) {
    const frameSize = buffer.readUInt32BE(i + 4);
    if (frameSize === 0 || i + 8 + frameSize > buffer.length) break;
    const streamType = buffer[i];
    if (streamType === 1) { // stdout only
      chunks.push(buffer.subarray(i + 8, i + 8 + frameSize));
    }
    i += 8 + frameSize;
  }
  return Buffer.concat(chunks);
}

/**
 * Collect a Node.js readable stream into a single Buffer.
 */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks);
}

/**
 * Extract the first regular file from a tar (plain or gzip-compressed).
 * Handles Docker getArchive output which may:
 *   - be gzip-compressed (magic 1f 8b)
 *   - have PAX extended header blocks (type 'x'/'g') or directory entries before the file
 * Iterates through all entries, skipping non-regular ones, returns first regular file data.
 */
function extractFileFromTar(tarBuffer: Buffer): Buffer | null {
  // Decompress if gzip
  let buf = tarBuffer;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = gunzipSync(buf); } catch { return null; }
  }

  let offset = 0;
  while (offset + 512 <= buf.length) {
    // End-of-archive: two consecutive zero blocks
    if (buf.subarray(offset, offset + 512).every((b) => b === 0)) break;

    // Size field: bytes 124–135, octal string
    const sizeStr = buf.subarray(offset + 124, offset + 136).toString("ascii").replace(/[\0 ]/g, "").trim();
    const fileSize = parseInt(sizeStr, 8);
    if (isNaN(fileSize) || fileSize < 0) return null;

    // Type flag: byte 156 ('0' or '\0' = regular file)
    const typeFlag = String.fromCharCode(buf[offset + 156]);
    if (typeFlag === "0" || typeFlag === "\0") {
      if (offset + 512 + fileSize > buf.length) return null;
      return Buffer.from(buf.subarray(offset + 512, offset + 512 + fileSize));
    }

    // Skip non-regular entry (directory, PAX header, GNU long name, etc.)
    const dataBlocks = Math.ceil(fileSize / 512) * 512;
    offset += 512 + dataBlocks;
  }
  return null;
}

/**
 * Read a file from the workspace named volume using getArchive (binary-safe).
 * Uses Docker's tar-based archive API instead of cat + log stream multiplexing,
 * which corrupts binary files (DOCX/ZIP, PDF, images) via 8-byte frame headers.
 */
export async function readFileFromVolume(
  chatId: string,
  containerPath: string
): Promise<Buffer | null> {
  const volumeName = getWorkspaceVolumeName(chatId);

  // A stopped helper container is sufficient — getArchive works without starting it
  const helper = await (docker.createContainer as any)({
    Image: AGENT_IMAGE_NAME,
    Cmd: ["true"],
    HostConfig: {
      Binds: [`${volumeName}:${WORKSPACE_MOUNT}`],
    },
  });

  try {
    const archiveStream = await helper.getArchive({ path: containerPath }) as NodeJS.ReadableStream;
    const tarBuffer = await streamToBuffer(archiveStream);
    const isGzip = tarBuffer.length >= 2 && tarBuffer[0] === 0x1f && tarBuffer[1] === 0x8b;
    console.log(`[DockerRuntime] getArchive returned ${tarBuffer.length} bytes, gzip=${isGzip}, for ${containerPath}`);
    const content = extractFileFromTar(tarBuffer);
    if (content) {
      console.log(`[DockerRuntime] Extracted ${content.length} bytes from volume ${volumeName}:${containerPath}`);
    } else {
      console.warn(`[DockerRuntime] extractFileFromTar returned null for ${containerPath}, tarBuffer[0..3]=${tarBuffer.subarray(0, 4).toString("hex")}`);
    }
    return content;
  } catch {
    return null;
  } finally {
    await helper.remove({ force: true }).catch(() => {});
  }
}

/**
 * List regular files in a directory of the workspace named volume.
 * Uses a Python helper (guaranteed available in agent image) for reliable listing.
 * Returns [{name, size}] for each regular file found.
 */
export async function listFilesInVolume(
  chatId: string,
  dirPath: string
): Promise<Array<{ name: string; size: number }>> {
  const volumeName = getWorkspaceVolumeName(chatId);
  // Python one-liner: list files with sizes, return JSON array
  const pyScript = `import os,json;d='${dirPath}';r=[{'name':f,'size':os.path.getsize(os.path.join(d,f))} for f in os.listdir(d) if os.path.isfile(os.path.join(d,f))] if os.path.isdir(d) else [];print(json.dumps(r))`;

  try {
    const container = await (docker.createContainer as any)({
      Image: AGENT_IMAGE_NAME,
      Cmd: ["python3", "-c", pyScript],
      HostConfig: {
        Binds: [`${volumeName}:${WORKSPACE_MOUNT}`],
        AutoRemove: true,
      },
    });
    await container.start();
    const logs = await container.logs({ follow: true, stdout: true, stderr: false });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      logs.on("data", (chunk: Buffer) => chunks.push(chunk));
      logs.on("end", resolve);
      logs.on("error", reject);
    });
    await container.wait().catch(() => {});
    const json = demuxDockerLogStream(Buffer.concat(chunks)).toString("utf8").trim();
    return JSON.parse(json || "[]");
  } catch {
    return [];
  }
}

/** Remove the workspace volume for a chat (used when deleting a chat) */
export async function removeWorkspaceVolume(chatId: string): Promise<void> {
  await removeVolumeWithRetry(`${VOLUME_PREFIX}${chatId}`);
}

/** Remove the Claude Code home volume for a chat (used when deleting a chat) */
export async function removeClaudeHomeVolume(chatId: string): Promise<void> {
  await removeVolumeWithRetry(`${CLAUDE_HOME_VOLUME_PREFIX}${chatId}`);
}

/** Get workspace volume name for a chat */
export function getWorkspaceVolumeName(chatId: string): string {
  return `${VOLUME_PREFIX}${chatId}`;
}

/** Get Claude Code home volume name for a chat */
export function getClaudeHomeVolumeName(chatId: string): string {
  return `${CLAUDE_HOME_VOLUME_PREFIX}${chatId}`;
}

// Factory function for DockerAgentRuntime
export function createDockerRuntime(chatId: string, apiKey?: string, claudeSessionId?: string) {
  return (options?: AgentRuntimeOptions): AgentRuntime => {
    const runtime = new DockerAgentRuntime({
      ...options,
      chatId,
      apiKey,
      claudeSessionId,
    });
    // Initialize is async - caller must await it separately
    // The runtime will push an error event if initialization fails
    runtime.initialize().catch((err) => {
      console.error("[DockerRuntime] Initialization failed:", err);
    });
    return runtime;
  };
}
