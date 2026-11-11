/**
 * microsandbox-runtime.ts — AgentRuntime peer adapter for the local
 * MicroVM sandbox (M3-S1 minimal lifecycle; M3-S3B egress loop).
 *
 * Peer of LocalAgentRuntime / DockerAgentRuntime — NOT yet wired into Session
 * (that is the next stage's small-step integration; production stays
 * local/docker). The adapter:
 *   - validates the launch policy + probes the pinned runtime at CONSTRUCTION
 *     (createMicrosandboxRuntime throws MicrosandboxUnavailableError — it
 *     NEVER silently degrades to the plain local runtime);
 *   - drives the minimal lifecycle create/start/send/stream/abort/close/status
 *     through the local-agent-worker protocol (frames, seq, handshake,
 *     timeouts) over an injectable PUSH-MODEL WorkerLauncher (one persistent
 *     `msb exec --stream` duplex per session — M3-S3B; exec-per-frame broke
 *     the Host's rxSeq continuity and the runtime_ready-first rule);
 *   - answers Guest `model_request` intents through the Host credential proxy
 *     (M3-S3B): requestId anti-forgery + governed model stamping; the proxy's
 *     result returns as a `model_result` command. Credentials NEVER cross.
 *   - yields PlatformRuntimeEvent frames on getEventStream (structurally
 *     RuntimeEvent-compatible: {type: string, …});
 *   - keeps Host authority: runId/approval/audit stay Host-side; this adapter
 *     only transports already-governed commands.
 *
 * DI: launcher + clock injected; tests never need a real msb.
 */

import {
  MicrosandboxPolicyError,
  createMicrosandboxLaunchPolicy,
  probeMicrosandboxRuntime,
  type MicrosandboxLaunchPolicy,
  type MicrosandboxAvailability,
} from "./microsandbox-policy.js";
import type { AgentRuntime, RuntimeEvent, RuntimeStatus } from "./agent-runtime.js";
import {
  WorkerProtocolEndpoint,
  type WorkerTransport,
} from "./local-agent-worker-protocol.js";
import type { PlatformRuntimeCommand, PlatformRuntimeEvent, HistoryReplayMessage } from "./platform-runtime-protocol.js";
import type { ResolvedExecutionPolicy } from "./resolved-execution-policy.js";
import type { MicrosandboxMetricsCollector } from "./microsandbox-metrics.js";

// ─── M5-S2: bounded redaction for runtime_error messages ────────────────────
// The adapter surfaces `runtime_error{category, message}` frames for transport,
// start, and cleanup failures. The raw underlying error (msb stderr slices,
// duplex exit reasons, environment paths) can include host paths, env values,
// or credential-looking tokens. `redactRuntimeError` strips those before the
// frame is pushed onto the event stream — the category is preserved, the
// bounded message keeps the operational signal (e.g. "msb run failed") but
// never the raw bytes.
const REDACT_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  // Long hex/base64-ish tokens (>=24 chars, typical secret length). Keeps
  // short sha256 prefixes (digest pins) which are <= 12 chars after "sha256:".
  { re: /[A-Za-z0-9_\-]{24,}/g, replacement: "[redacted]" },
  // Bearer / x-api-key / sk- / key- style tokens (explicit prefix variants).
  { re: /(?:Bearer|x-api-key|sk-|key-)\s*[^\s"']+/gi, replacement: "[redacted]" },
  // ANTHROPIC_* / MODEL_EGRESS_* env var names with values.
  { re: /\b(ANTHROPIC_[A-Z_]+|MODEL_EGRESS_[A-Z_]+)\s*[=:]\s*[^\s"']+/g, replacement: "$1=[redacted]" },
  // Host paths (/Users/<user>, /home/<user>, /private/tmp/<...>, /opt/agent/...).
  // Keeps the sandbox-name token (eaos-microvm-<ts>) which is operational.
  { re: /\/(?:Users|home|private)\/[^\s"'<>]+/g, replacement: "[path]" },
  // email-style addresses (paranoia for relay credentials).
  { re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, replacement: "[email]" },
];

export function redactRuntimeError(message: string): string {
  if (typeof message !== "string" || message.length === 0) return "";
  // Clamp the input first so a pathological stderr doesn't blow the regex O(n).
  const bounded = message.length > 500 ? message.slice(0, 500) + " …[truncated]" : message;
  let out = bounded;
  for (const { re, replacement } of REDACT_PATTERNS) {
    out = out.replace(re, replacement as string);
  }
  return out;
}
import type { ModelEgressProxy } from "./model-egress-proxy.js";
import { spawnSync, spawn } from "node:child_process";
import * as readline from "node:readline";
// M1 R5 semantics (Defect A): a directory-valued MSB_LIBKRUNFW_PATH must NOT
// reach msb (it treats the var as a file path). Single source: the M1/M2
// host-runner used by every verified probe.
// @ts-expect-error — .mjs experiment module has no type declarations
import { runtimeEnv as msbRuntimeEnv } from "../experiments/microsandbox-local-runtime/host-runner.mjs";

export { MicrosandboxPolicyError };

/** Diagnosable unavailability — thrown by the factory; never a silent fallback. */
export class MicrosandboxUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail: MicrosandboxAvailability,
  ) {
    super(message);
    this.name = "MicrosandboxUnavailableError";
  }
}

// ─── Worker launcher (transport to the Guest) ───────────────────────────────

/**
 * PUSH-MODEL launcher (M3-S3B). The Guest worker is a LONG-LIVED process
 * speaking newline-delimited JSON frames over ONE persistent duplex — a
 * request/response `exchange` cannot serve that (fresh process per frame
 * breaks Host-side rxSeq continuity + the runtime_ready-first handshake).
 */
export interface WorkerLauncher {
  /**
   * Attach the inbound frame sink + fatal transport-error callback. MUST be
   * called before start(); the launcher delivers every Guest frame line here.
   */
  setSink(sink: (frameText: string) => void, onError: (e: Error) => void): void;
  /** Create + start the guest worker. Resolves when the duplex is up. */
  start(): Promise<void>;
  /** Deliver one frame (JSON line) to the Guest. Fire-and-forget. */
  send(frameText: string): void;
  /** Stop the sandbox (state kept for resume). */
  stop(): Promise<void>;
  /** Remove the sandbox entirely. */
  remove(): Promise<void>;
}

/**
 * Minimal structural view of the persistent duplex child (DI seam for tests;
 * the default wraps node:child_process.spawn).
 */
export interface WorkerDuplexProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  on(event: "error", listener: (err: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): void;
}

export interface MsbHostMount {
  /** Absolute host path, no '..' (must be a REAL path — msb rejects symlinked
   * sources, e.g. use /private/tmp not /tmp on macOS). */
  hostPath: string;
  /** Guest mount point — must be a policy workspaceRoots path. */
  guestPath: string;
  readonly: boolean;
}

export interface MsbLauncherOptions {
  policy: MicrosandboxLaunchPolicy;
  sandboxName: string;
  /**
   * Host-side halves of the policy workspace roots. Every policy root MUST be
   * covered exactly once with matching access; extras are refused (fail
   * closed in buildMsbRunArgv).
   */
  hostMounts?: ReadonlyArray<MsbHostMount>;
  /** Command that serves the worker protocol inside the guest. */
  carrierCommand?: string[];
  /** Injected one-shot spawn (DI for tests) — run/stop/rm control calls. */
  run?: (argv: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => { status: number | null; stdout: string; stderr: string; timedOut: boolean };
  /** Injected persistent duplex spawn (DI for tests) — exec --stream child. */
  spawnChild?: (argv: string[], opts: { env: NodeJS.ProcessEnv }) => WorkerDuplexProcess;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const ABS_NO_TRAVERSAL = (p: string) => p.startsWith("/") && !p.split("/").includes("..");

/**
 * Credential-bearing env vars are STRIPPED from every spawned msb child
 * (M3-S3B): even if an msb version forwarded its caller environment into the
 * Guest, the model credentials would not be in it. The Host proxy reads them
 * from the Host process directly — the launcher never needs them.
 */
const CREDENTIAL_ENV_KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "MODEL_EGRESS_CREDENTIAL"] as const;
function stripCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of CREDENTIAL_ENV_KEYS) delete out[k];
  return out;
}

/**
 * Compile the launch policy into REAL `msb run` flags. Verified against the
 * pinned msb 0.6.18 binary on this host (darwin-arm64):
 *   --max-cpus <INT>                (fractional values are REJECTED by msb)
 *   --max-memory <SIZE>             (e.g. 512M)
 *   --mount-dir <SOURCE:DEST[:ro]>  (ro is kernel-enforced in the guest)
 * Any policy constraint msb cannot express → throw (fail closed, never
 * validated-then-ignored). Mount coverage is bidirectional: every policy
 * root must have exactly one host mount with matching access, and extra
 * mounts are refused.
 */
export function buildMsbRunArgv(
  policy: MicrosandboxLaunchPolicy,
  sandboxName: string,
  hostMounts: ReadonlyArray<MsbHostMount>,
): string[] {
  const bad = (msg: string): never => {
    throw new MicrosandboxPolicyError(msg);
  };
  // msb only accepts whole cores (empirically: `--max-cpus 0.5` is refused).
  // A fractional policy is inexpressible → refuse rather than round.
  if (!Number.isInteger(policy.cpuCores)) {
    bad(`cpuCores ${policy.cpuCores} is fractional — msb only accepts integer --max-cpus (fail closed, no rounding)`);
  }
  const net = policy.networkEgress === "none"
    ? ["--no-net", "--net-strict"]
    : ["--net-default", "deny", "--net-strict", ...policy.declaredHosts.flatMap((h) => ["--net-rule", `allow:${h}:443`])];

  const seen = new Set<string>();
  for (const m of hostMounts) {
    if (!ABS_NO_TRAVERSAL(String(m.hostPath ?? ""))) bad(`hostMount hostPath must be absolute without '..': ${m.hostPath}`);
    if (seen.has(m.guestPath)) bad(`duplicate host mount for guest path ${m.guestPath}`);
    seen.add(m.guestPath);
    const root = policy.workspaceRoots.find((r) => r.path === m.guestPath);
    if (!root) {
      throw new MicrosandboxPolicyError(`host mount '${m.hostPath}:${m.guestPath}' targets a guest path outside the policy workspace roots (extra mount refused)`);
    }
    if (m.readonly !== (root.access === "ro")) {
      bad(`host mount for ${m.guestPath} access mismatch: mount readonly=${m.readonly} vs policy access='${root.access}'`);
    }
  }
  for (const root of policy.workspaceRoots) {
    if (!seen.has(root.path)) {
      bad(`policy workspace root ${root.path} (${root.access}) has no host mount — the constraint would be silently dropped (fail closed)`);
    }
  }
  // M3 closure — HARD write quota on every WRITABLE mount: msb enforces
  // `quota=<size>` at the mount layer (verified against msb 0.6.18 --help:
  // "OPTIONS may include `quota=<size>`"), so a runaway Guest write physically
  // fails (EDQUOT/ENOSPC) instead of filling the Host disk. Read-only mounts
  // get no quota option (nothing to write). A policy quota that cannot be
  // attached (e.g. no rw mount) would be silently dropped → refused here.
  if (policy.workspaceQuotaMb !== undefined && !hostMounts.some((m) => !m.readonly)) {
    bad("workspaceQuotaMb set but no writable mount exists to attach it to (fail closed, never validated-then-ignored)");
  }
  const mountArgs = hostMounts.flatMap((m) => {
    const opts: string[] = [];
    if (m.readonly) opts.push("ro");
    if (!m.readonly && policy.workspaceQuotaMb !== undefined) opts.push(`quota=${policy.workspaceQuotaMb}M`);
    const optSuffix = opts.length > 0 ? `:${opts.join(",")}` : "";
    return ["--mount-dir", `${m.hostPath}:${m.guestPath}${optSuffix}`];
  });

  return [
    // `msb create` boots an IDLE sandbox that lives until idle-timeout/stop
    // (verified live, M3-S3B: `msb run -d … -- true` goes "stopped" the moment
    // the one-shot command exits — exec then has nothing to attach to; and
    // foreground `msb run` blocks while the sandbox lives). The persistent
    // `msb exec --stream` carrier is the sandbox's workload.
    "create", "--name", sandboxName,
    "--security", "restricted",
    ...net,
    "--idle-timeout", policy.idleTimeout,
    "--max-cpus", String(policy.cpuCores),
    "--max-memory", `${policy.memoryMb}M`,
    ...mountArgs,
    policy.guestImage,
  ];
}

/**
 * Real msb-backed launcher. ONE persistent `msb exec --stream <name> --
 * carrier` duplex per session (M3-S3B): stdin carries Host→Guest frames,
 * stdout lines are Guest→Host frames delivered to the attached sink. The
 * default carrier runs the COMPILED worker entry baked into the pinned
 * eaos-guest image (docker/guest/Dockerfile, M3-S3A) — no .ts sources and
 * no build toolchain exist in the Guest at runtime.
 */
export function createMsbWorkerLauncher(opts: MsbLauncherOptions): WorkerLauncher {
  const { policy, sandboxName } = opts;
  // Eager compile: inexpressible constraints fail launcher CONSTRUCTION
  // (before any spawn), so the runtime surfaces them as setup errors.
  const runArgv = buildMsbRunArgv(policy, sandboxName, opts.hostMounts ?? []);
  const carrier = opts.carrierCommand ?? ["node", "/opt/agent/dist/worker/local-agent-entry.js"];
  const run =
    opts.run ??
    ((argv: string[], o: { timeoutMs: number; env: NodeJS.ProcessEnv }) => {
      const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: o.timeoutMs, env: o.env });
      const err = r.error as NodeJS.ErrnoException | undefined;
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: err?.code === "ETIMEDOUT" };
    });
  const spawnChild =
    opts.spawnChild ??
    ((argv: string[], o: { env: NodeJS.ProcessEnv }): WorkerDuplexProcess => {
      const c = spawn(argv[0], argv.slice(1), { env: o.env });
      return {
        stdin: c.stdin,
        stdout: c.stdout as unknown as NodeJS.ReadableStream,
        on: (ev, l) => c.on(ev, l as never),
        once: (ev, l) => c.once(ev, l as never),
        kill: (sig) => c.kill(sig),
      };
    });
  const env = stripCredentialEnv(opts.env ?? (() => { try { return msbRuntimeEnv(); } catch { return process.env; } })());
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const msb = (args: string[], t = timeoutMs) => run([policy.msbPath, ...args], { timeoutMs: t, env });

  let sink: ((frame: string) => void) | null = null;
  let onError: ((e: Error) => void) | null = null;
  let child: WorkerDuplexProcess | null = null;

  const killChild = () => {
    if (!child) return;
    try { child.kill("SIGTERM"); } catch { /* best-effort */ }
    child = null;
  };

  return {
    setSink(s, onErr) {
      sink = s;
      onError = onErr;
    },
    async start() {
      if (!sink || !onError) throw new Error("worker launcher: sink not attached before start()");
      const r = msb(runArgv);
      if (r.status !== 0) throw new Error(`msb run failed: ${r.stderr.slice(0, 200)}`);
      // Persistent duplex for the WHOLE session (msb exec --stream: "Stream
      // stdin/stdout bidirectionally without a PTY — safe for JSON lines").
      const c = spawnChild([policy.msbPath, "exec", "--stream", sandboxName, "--", ...carrier], { env });
      child = c;
      const rl = readline.createInterface({ input: c.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const text = line.trim();
        if (text && sink) sink(text);
      });
      c.on("error", (err) => onError?.(new Error(`worker duplex: ${err.message}`)));
      c.once("exit", (code) => {
        if (child !== c) return; // intentional kill (stop/remove) — not an error
        child = null;
        onError?.(new Error(`worker duplex exited unexpectedly (code ${code ?? "null"})`));
      });
    },
    send(frameText: string) {
      if (!child) {
        onError?.(new Error("worker duplex not running (frame dropped)"));
        return;
      }
      child.stdin.write(`${frameText}\n`);
    },
    async stop() {
      killChild();
      const r = msb(["stop", sandboxName]);
      if (r.status !== 0) throw new Error(`msb stop failed: ${r.stderr.slice(0, 200)}`);
    },
    async remove() {
      killChild();
      // R5 Defect C parity: stop before remove (rm fails on a running sandbox).
      try { msb(["stop", sandboxName], 10_000); } catch { /* best-effort */ }
      const r = msb(["rm", sandboxName]);
      if (r.status !== 0) throw new Error(`msb rm failed: ${r.stderr.slice(0, 200)}`);
    },
  };
}

// ─── The runtime adapter ─────────────────────────────────────────────────────

export interface MicrosandboxRuntimeOptions {
  /** Launch policy input — validated + probed at construction (fail closed). */
  launchPolicy: Parameters<typeof createMicrosandboxLaunchPolicy>[0];
  /** The governed execution policy handed to the worker (start command). */
  policy: ResolvedExecutionPolicy;
  /** Engine resume token (engineSessionId) for cold resume, if any. */
  resumeToken?: string;
  /**
   * M5-S4 C: bounded history snapshot for cold recovery (engine-neutral
   * replay). When non-empty, the Host includes `history` in the start
   * command and the Guest seeds its conversation before runtime_ready.
   * restoreMode is reported as "history_replay" (NOT Claude SDK resume).
   * The snapshot is already bounded/redacted (last 20, ≤40k chars, text-only
   * user+assistant — no tool payload/credentials/A2UI internal).
   */
  history?: ReadonlyArray<HistoryReplayMessage>;
  /**
   * Host-side halves of the launch policy workspace roots. REQUIRED on the
   * real default-launcher path: empty/missing mounts fail closed at
   * construction (buildMsbRunArgv refuses uncovered policy roots). Tests
   * injecting a custom `launcher` may omit them.
   */
  hostMounts?: ReadonlyArray<MsbHostMount>;
  launcher?: WorkerLauncher;
  /**
   * DI seam for the DEFAULT launcher path (tests observe the real spawn/argv
   * without a msb binary). Ignored when `launcher` is injected.
   */
  launcherDeps?: { run?: MsbLauncherOptions["run"]; spawnChild?: MsbLauncherOptions["spawnChild"]; env?: NodeJS.ProcessEnv; timeoutMs?: number };
  /**
   * M3-S3B egress loop: the Host credential proxy + the governed modelRef the
   * Host stamps on every Guest model_request (the Guest cannot choose it).
   * Absent = every model_request is refused (fail closed; matches a deny-all
   * Guest broker — the start handshake itself fails in that mode).
   */
  egress?: { proxy: ModelEgressProxy; modelRef: string };
  commandTimeoutMs?: number;
  now?: () => number;
  /**
   * M5-S2: bounded abort interval (ms). When `abort()` is called, a watchdog
   * forces a single terminal `turn_failed{category:"aborted"}` onto the event
   * stream if the worker doesn't ack a terminal within this window. Default
   * 5000ms. 0 disables the watchdog (tests that inject a never-acking worker
   * use a small value to keep the test fast).
   */
  abortTimeoutMs?: number;
  /** Skip the binary probe (tests with an injected launcher). */
  skipProbe?: boolean;
  probeDeps?: Parameters<typeof probeMicrosandboxRuntime>[1];
  /**
   * M5-S4 B: startup handshake timeout (ms). If `runtime_ready` is not
   * received within this window, the runtime converges to `crashed` and
   * cleans up the half-started sandbox. Default 30,000ms. 0 disables
   * (tests that inject a never-ready worker use a small value).
   */
  startupTimeoutMs?: number;
  /**
   * M5-S4 B: heartbeat probe interval (ms). After `runtime_ready`, the Host
   * sends a `ping` every interval. Default 15,000ms. 0 disables heartbeat
   * (tests that inject a custom transport use a small value or 0).
   */
  heartbeatIntervalMs?: number;
  /**
   * M5-S4 B: window (ms) the Host waits for a `pong` before counting one
   * heartbeat failure. Default 10,000ms. Must be < heartbeatIntervalMs to
   * avoid overlap; clamped otherwise.
   */
  heartbeatTimeoutMs?: number;
  /**
   * M5-S4 B: consecutive heartbeat failures before converging to `crashed`.
   * Default 3 (matches the artifact spec).
   */
  maxHeartbeatFailures?: number;
  /**
   * M5-S4 B: per-turn watchdog (ms). Armed on `sendMessage`; cancelled on
   * any real terminal (turn_completed/turn_failed). On fire, emits exactly
   * one synthetic `turn_failed{category:"timeout"}` + converges to crashed.
   * Default 180,000ms (3 minutes). 0 disables (tests use a small value).
   */
  turnWatchdogMs?: number;
  /**
   * R1-2: fired EXACTLY ONCE when the runtime transitions to a fatal state
   * (async startTask failure or transport error) — lets the factory release
   * the concurrency slot without waiting for an explicit close. The factory
   * guards with its own releaseOnce so close+fatal never double-release.
   */
  onFatal?: () => void;
  /**
   * M5-S3: optional metrics collector. If provided, the runtime records
   * boot/recovery/stop timing, status transitions, failure category +
   * redacted message, and the governed resource policy envelope. NEVER
   * receives prompt content, original subject, credentials, or raw tool
   * payloads (those never enter this runtime's code path).
   */
  metrics?: MicrosandboxMetricsCollector;
  /** M5-S3: the governed resource policy to surface in metrics events. */
  metricsResourcePolicy?: { memoryMb: number; cpuCores: number; workspaceQuotaMb: number };
}

interface QueueItem {
  event: PlatformRuntimeEvent;
}

class EventQueue {
  private items: QueueItem[] = [];
  private waiters: Array<(item: QueueItem | null) => void> = [];
  private ended = false;
  push(event: PlatformRuntimeEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ event });
      return;
    }
    this.items.push({ event });
  }
  end(): void {
    this.ended = true;
    for (const w of this.waiters) w(null); // parked readers terminate cleanly
    this.waiters = [];
  }
  get isEnded(): boolean {
    return this.ended;
  }
  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    const next = async (): Promise<IteratorResult<RuntimeEvent>> => {
      if (this.items.length > 0) return { value: this.items.shift()!.event as RuntimeEvent, done: false };
      if (this.ended) return { value: undefined as unknown as RuntimeEvent, done: true };
      const item = await new Promise<QueueItem | null>((resolve) => this.waiters.push(resolve));
      if (item === null) return { value: undefined as unknown as RuntimeEvent, done: true };
      return { value: item.event as RuntimeEvent, done: false };
    };
    return { next };
  }
}

/** Endpoint→launcher bridge: outbound frames go straight down the duplex.
 *  Inbound frames arrive via the launcher sink (push model, M3-S3B). */
class DirectTransport implements WorkerTransport {
  constructor(private readonly launcher: WorkerLauncher) {}
  send(text: string): void {
    this.launcher.send(text);
  }
  close(): void {
    /* launcher lifecycle is owned by the runtime */
  }
}

export class MicrosandboxAgentRuntime implements AgentRuntime {
  private statusValue: RuntimeStatus = "starting";
  private readonly queue = new EventQueue();
  private readonly endpoint: WorkerProtocolEndpoint;
  private readonly launcher: WorkerLauncher;
  private started = false;
  private startError: string | null = null;
  private sendSeq = 0;
  /**
   * User messages can arrive while the MicroVM handshake is still in flight.
   * Keep a small FIFO here instead of dropping the first turn with a
   * `sendMessage before runtime_ready` protocol error. The Session receives a
   * synchronous RuntimeFactory, while the worker launch is asynchronous.
   */
  private readonly pendingMessages: string[] = [];
  private static readonly MAX_PENDING_MESSAGES = 8;
  /** M5-S2: abort watchdog handle — ensures a stuck abort still produces a
   *  single terminal `turn_failed{aborted}` within the bounded interval. */
  private abortTimer: ReturnType<typeof setTimeout> | null = null;
  /** M5-S2: the runId the abort applies to — the watchdog needs it to emit the
   *  synthetic terminal. */
  private abortingRunId: string | null = null;
  /**
   * M5-S2 (R2): runIds finalized by the abort watchdog. A late real terminal
   * from the Guest for one of these is suppressed so the platform stream sees
   * exactly one terminal per abort. Bounded by issuedRunIds membership and
   * pruned on new run start — a subsequent run is unaffected.
   */
  private readonly watchdogFinalizedRunIds = new Set<string>();
  // ─── M5-S4 B: health probe + turn watchdog + startup timeout ──────────────
  /** Startup handshake timer — armed in startTask, cancelled on runtime_ready. */
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether runtime_ready has been received (gates heartbeat start). */
  private runtimeReadyReceived = false;
  /** Heartbeat interval timer — armed on runtime_ready, stopped on close/crash. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending pong timer — one per ping; fire = one heartbeat failure. */
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive heartbeat failures (pong missing within window). */
  private heartbeatFailures = 0;
  /** Whether a pong is currently pending (guards against double-clear). */
  private pongPending = false;
  /** Per-turn watchdog — armed on sendMessage, cancelled on real terminal. */
  private turnWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** The runId the turn watchdog applies to (for synthetic terminal). */
  private turnWatchdogRunId: string | null = null;
  /**
   * runIds finalized by the TURN watchdog. Distinct from the abort watchdog
   * set conceptually but merged into `watchdogFinalizedRunIds` so a single
   * suppression check in ingest() covers both. Added here when the turn
   * watchdog fires; a late real terminal for this run is suppressed.
   */
  /** runIds THIS Host issued (anti-forgery: Guest model_request must match). */
  private readonly issuedRunIds = new Set<string>();
  /** Sandbox name (ops/diagnostics + smoke guest-env verification). */
  readonly sandboxName: string;

  private constructor(
    private readonly opts: MicrosandboxRuntimeOptions,
    private readonly launchPolicy: MicrosandboxLaunchPolicy,
    sandboxName: string,
  ) {
    this.sandboxName = sandboxName;
    this.launcher =
      opts.launcher ??
      createMsbWorkerLauncher({
        policy: launchPolicy,
        sandboxName,
        // Host-only mounts flow into the REAL msb argv; missing ones fail
        // closed inside buildMsbRunArgv at construction (never spawn half-
        // governed). launcherDeps is the test observation seam for this path.
        hostMounts: opts.hostMounts ?? [],
        ...(opts.launcherDeps ?? {}),
      });
    // Push model: inbound Guest frames arrive on the sink; transport errors
    // fail the runtime (never a silent frame drop).
    this.launcher.setSink(
      (frame) => this.ingest(frame),
      (e) => {
        // M5-S2: redact transport-error messages — stderr slices / duplex
        // exit reasons can carry host paths or credential-bearing strings.
        this.queue.push({ type: "runtime_error", category: "io", message: redactRuntimeError(`worker transport: ${e.message}`) });
        if (this.statusValue !== "crashed") {
          this.statusValue = "crashed";
          this.opts.metrics?.noteCrash(this.sandboxName, "io", redactRuntimeError(`worker transport: ${e.message}`));
          this.opts.onFatal?.();
        }
      },
    );
    this.endpoint = new WorkerProtocolEndpoint(
      new DirectTransport(this.launcher),
      { commandTimeoutMs: opts.commandTimeoutMs, now: opts.now, role: "host" },
    );
    // M5-S3: record boot/recovery start (msb create dispatched).
    if (this.opts.metrics && this.opts.metricsResourcePolicy) {
      this.opts.metrics.noteBootStart(this.sandboxName, !!this.opts.resumeToken, this.opts.metricsResourcePolicy);
    }
    void this.startTask();
  }

  /** Factory: validate + probe + construct. Throws MicrosandboxUnavailableError. */
  static create(opts: MicrosandboxRuntimeOptions): MicrosandboxAgentRuntime {
    // ① policy validation — fail closed on ANY violation.
    const policy = createMicrosandboxLaunchPolicy(opts.launchPolicy);
    // ② pinned-runtime probe — unavailable ⇒ diagnosable throw, no fallback.
    if (!opts.skipProbe) {
      const probe = probeMicrosandboxRuntime(policy, opts.probeDeps);
      if (!probe.available) {
        throw new MicrosandboxUnavailableError(`local-sandbox runtime unavailable: ${probe.reason}`, probe);
      }
    }
    return new MicrosandboxAgentRuntime(opts, policy, `eaos-microvm-${Date.now()}`);
  }

  private async startTask(): Promise<void> {
    // M5-S4 B: arm the startup handshake watchdog — if runtime_ready doesn't
    // arrive within the window, converge to crashed + clean up the half-
    // started sandbox. Disarmed on the first runtime_ready in ingest().
    this.armStartupTimeout();
    try {
      await this.launcher.start();
      this.endpoint.sendCommand({
        type: "start",
        ...(this.opts.resumeToken ? { resumeToken: this.opts.resumeToken } : {}),
        ...(this.opts.history && this.opts.history.length > 0 ? { history: this.opts.history } : {}),
        policy: this.opts.policy,
      });
      // Handshake verdict arrives as runtime_ready (or turn_failed on the
      // credential deny-all broker) via ingest(); status flips there.
    } catch (e: unknown) {
      this.startError = e instanceof Error ? e.message : String(e);
      this.statusValue = "crashed";
      this.cancelStartupTimeout();
      // M3 closure — startup-failure cleanup: a partially-started sandbox
      // (e.g. `msb create` booted but the exec duplex failed) must not be left
      // running. Best-effort remove, then stop; failures are reported on the
      // stream (the no-orphans backstop is reapOrphanMicrovmSandboxes).
      try {
        await this.launcher.remove();
      } catch {
        try { await this.launcher.stop(); } catch { /* best-effort */ }
      }
      this.queue.push({ type: "runtime_error", category: "io", message: redactRuntimeError(`sandbox start failed: ${this.startError}`) });
      this.opts.metrics?.noteBootFailed(this.sandboxName, !!this.opts.resumeToken, "io", redactRuntimeError(`sandbox start failed: ${this.startError}`));
      this.opts.onFatal?.(); // R1-2: release the concurrency slot proactively
    }
  }

  /** Guest frame → protocol validation → platform events → stream. */
  private ingest(frameText: string): void {
    for (const e of this.endpoint.handleEventFrame(frameText)) {
      if (e.kind === "event") {
        const evt = e.event;
        if (evt.type === "runtime_ready") {
          this.started = true;
          this.statusValue = "running";
          this.runtimeReadyReceived = true;
          // M5-S4 B: startup handshake completed — cancel the startup timer.
          this.cancelStartupTimeout();
          // M5-S4 B: start periodic heartbeat probes (cancelled on close/crash).
          this.startHeartbeat();
          this.opts.metrics?.noteBootReady(this.sandboxName, !!this.opts.resumeToken);
          this.flushPendingMessages();
        }
        if (evt.type === "pong") {
          // M5-S4 B: Guest health-probe response — reset failure counter,
          // clear the pending pong timer. The heartbeat interval timer keeps
          // running; the next ping will be sent on its next tick.
          this.handlePongReceived();
          continue; // not a user-visible event — never on the platform stream
        }
        if (evt.type === "model_request") {
          // Internal egress loop (M3-S3B) — answered Host-side; never surfaced
          // on the platform event stream (it is not a user-visible turn event).
          this.handleModelRequest(evt);
          continue;
        }
        // M5-S2: any real terminal event for the aborting run cancels the
        // watchdog — the Guest acked, so no synthetic terminal is needed.
        if (evt.type === "turn_failed" || evt.type === "turn_completed") {
          // R2: if the watchdog already finalized this run, the late Guest
          // terminal is suppressed — exactly one terminal per abort, no
          // false late success. Bounded by issuedRunIds membership.
          const runId = (evt as { runId?: string }).runId;
          if (runId && this.watchdogFinalizedRunIds.has(runId)) {
            continue;
          }
          this.cancelAbortWatchdog();
          // M5-S4 B: cancel the per-turn watchdog — a real terminal arrived.
          this.cancelTurnWatchdog();
          // M5-S3: record terminal (category only — no payload).
          this.opts.metrics?.noteTurnTerminal(this.sandboxName, (evt as { category?: string }).category ?? evt.type);
        }
        if (evt.type === "runtime_error") {
          // M5-S3 R2: Guest-originated runtime_error messages are NOT pre-
          // redacted by the transport/start paths (unlike the Host-side
          // push sites above). Redact before BOTH metrics recording and
          // queueing — a Guest frame can carry host paths, sk- tokens, or
          // MODEL_EGRESS_* values, and neither the platform event stream
          // nor the metrics ring buffer may leak them.
          const rawMsg = (evt as { message?: string }).message ?? "";
          const redacted = redactRuntimeError(rawMsg);
          const sanitized = { ...evt, message: redacted };
          this.opts.metrics?.noteRuntimeError(this.sandboxName, (evt as { category?: string }).category ?? "internal", redacted);
          this.queue.push(sanitized);
          continue;
        }
        this.queue.push(evt);
      }
      // duplicate-dropped: idempotent no-op; transport-failed already closed.
    }
  }

  /**
   * Guest model-call intent → Host credential proxy → redacted model_result.
   * Anti-forgery: the requestId must be a runId THIS Host issued; the proxy
   * stamps the governed model (Guest-chosen model/provider/host never win);
   * every outcome — including internal errors — answers the Guest fail-closed
   * (an unanswered intent would hang the worker turn).
   */
  private handleModelRequest(evt: { requestId: string; provider: string; path: string; payload: string }): void {
    const deny = (error: string) => {
      this.endpoint.sendCommand({ type: "model_result", requestId: evt.requestId, ok: false, status: 0, error });
    };
    const egress = this.opts.egress;
    if (!egress) {
      deny("egress refused: host credential proxy not configured");
      return;
    }
    if (!this.issuedRunIds.has(evt.requestId)) {
      deny("egress refused: requestId was not issued by the host");
      return;
    }
    void egress.proxy
      .execute({ requestId: evt.requestId, provider: evt.provider, path: evt.path, payload: evt.payload }, egress.modelRef)
      .then((res) => {
        this.endpoint.sendCommand({
          type: "model_result",
          requestId: evt.requestId,
          ok: res.ok,
          status: res.status,
          ...(res.body !== undefined ? { body: res.body } : {}),
          ...(res.error !== undefined ? { error: res.error } : {}),
        });
      })
      .catch((e: unknown) => {
        deny(`egress internal: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  sendMessage(content: string): void {
    if (!this.started) {
      if (this.statusValue === "starting") {
        if (this.pendingMessages.length >= MicrosandboxAgentRuntime.MAX_PENDING_MESSAGES) {
          this.queue.push({
            type: "runtime_error",
            category: "protocol",
            message: redactRuntimeError("too many messages queued while sandbox startup is pending"),
          });
          return;
        }
        this.pendingMessages.push(content);
        return;
      }
      this.queue.push({ type: "runtime_error", category: "protocol", message: redactRuntimeError("sendMessage before runtime_ready (handshake pending or failed)") });
      return;
    }
    this.dispatchMessage(content);
  }

  private flushPendingMessages(): void {
    const pending = this.pendingMessages.splice(0);
    for (const content of pending) this.dispatchMessage(content);
  }

  private dispatchMessage(content: string): void {
    this.sendSeq += 1;
    const runId = `local-sandbox-s1-${this.sendSeq}`; // placeholder until Session wiring supplies the platform runId
    this.issuedRunIds.add(runId);
    // R2: a new turn starts — previously watchdog-finalized runIds are stale
    // and must not suppress a real terminal for this new run. Bounded clear.
    this.clearWatchdogFinalization();
    // M5-S4 B: arm the per-turn watchdog — a stuck Guest that never emits a
    // terminal still produces exactly one turn_failed{category:"timeout"}
    // within the bounded interval. Cancelled on any real terminal.
    this.armTurnWatchdog(runId);
    this.endpoint.sendCommand({
      type: "send_message",
      runId,
      content,
    });
  }

  handleApprovalResponse(response: { id: string; approved: boolean; message?: string }): boolean {
    if (!this.started) return false;
    this.endpoint.sendCommand({ type: "approval_result", requestId: response.id, approved: response.approved, ...(response.message ? { message: response.message } : {}) });
    return true;
  }

  forwardA2UiResult(requestId: string, result: unknown): void {
    if (!this.started) return;
    this.endpoint.sendCommand({ type: "a2ui_result", requestId, result });
  }

  abort(): void {
    if (!this.started) return;
    // M5-S2: bounded abort — send the abort command, then arm a watchdog so a
    // worker that never acks still produces a single terminal turn_failed
    // (category:"aborted") within the bounded interval. The watchdog is
    // cancelled on any real terminal event from the Guest (see ingest()).
    const runId = `local-sandbox-s1-${this.sendSeq}`;
    this.endpoint.sendCommand({ type: "abort", runId });
    this.statusValue = "stopping";
    this.armAbortWatchdog(runId);
  }

  /**
   * M5-S2: schedule a synthetic terminal if the worker doesn't ack. The
   * interval is `abortTimeoutMs ?? 5000`. Idempotent — a second `abort()`
   * reschedules on the new runId and the prior timer is cleared.
   */
  private armAbortWatchdog(runId: string): void {
    const ms = this.opts.abortTimeoutMs ?? 5000;
    if (ms <= 0) return;
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.abortingRunId = runId;
    this.abortTimer = setTimeout(() => {
      this.abortTimer = null;
      // Only fire if the abort is still outstanding — a real terminal from
      // the Guest would have cleared abortingRunId (see cancelAbortWatchdog).
      if (this.abortingRunId !== runId) return;
      this.abortingRunId = null;
      // R2: mark this run as finalized by the watchdog so a late real
      // terminal from the Guest is suppressed in ingest() (exactly one
      // terminal per abort; no false late success). Bounded by
      // issuedRunIds membership; cleared on the next sendMessage.
      this.watchdogFinalizedRunIds.add(runId);
      this.queue.push({
        type: "turn_failed",
        category: "aborted",
        message: "abort watchdog: worker did not ack within bounded interval",
      });
      if (this.statusValue === "stopping") this.statusValue = "crashed";
      this.opts.metrics?.noteCrash(this.sandboxName, "aborted", "abort watchdog: worker did not ack within bounded interval");
      this.opts.onFatal?.();
    }, ms);
    // Don't keep the event loop alive solely for the watchdog.
    if (typeof this.abortTimer?.unref === "function") this.abortTimer.unref();
  }

  private cancelAbortWatchdog(): void {
    if (this.abortTimer) {
      clearTimeout(this.abortTimer);
      this.abortTimer = null;
    }
    this.abortingRunId = null;
  }

  /**
   * R2: clear watchdog-finalized runId tracking. Called on close() (no late
   * terminal can arrive after close()) and on a new run start (stale
   * finalizations must not suppress a real terminal for the new run).
   */
  private clearWatchdogFinalization(): void {
    this.watchdogFinalizedRunIds.clear();
  }

  // ─── M5-S4 B: startup handshake timeout ─────────────────────────────────────
  /**
   * Arm the startup handshake watchdog. If `runtime_ready` is not received
   * within `startupTimeoutMs` (default 30s), converge to crashed + clean up
   * the half-started sandbox. Disarmed on the first runtime_ready.
   */
  private armStartupTimeout(): void {
    const ms = this.opts.startupTimeoutMs ?? 30_000;
    if (ms <= 0) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.runtimeReadyReceived) return; // raced — runtime_ready arrived
      if (this.statusValue !== "crashed") {
        this.statusValue = "crashed";
        const msg = redactRuntimeError("sandbox startup handshake timed out (runtime_ready not received within bounded interval)");
        this.queue.push({ type: "runtime_error", category: "timeout", message: msg });
        this.opts.metrics?.noteBootFailed(this.sandboxName, !!this.opts.resumeToken, "timeout", msg);
        this.opts.metrics?.noteCrash(this.sandboxName, "timeout", msg);
      }
      void this.cleanupHalfStartedSandbox();
      this.opts.onFatal?.();
    }, ms);
    if (typeof this.startupTimer?.unref === "function") this.startupTimer.unref();
  }

  private cancelStartupTimeout(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  // ─── M5-S4 B: heartbeat (ping/pong) ────────────────────────────────────────
  private startHeartbeat(): void {
    const interval = this.opts.heartbeatIntervalMs ?? 15_000;
    if (interval <= 0) return; // disabled (tests)
    this.stopHeartbeat();
    this.heartbeatFailures = 0;
    this.pongPending = false;
    this.heartbeatTimer = setInterval(() => {
      this.sendOneHeartbeat();
    }, interval);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.pongPending = false;
  }

  private sendOneHeartbeat(): void {
    if (this.statusValue === "crashed" || this.statusValue === "stopped" || this.statusValue === "stopping") {
      this.stopHeartbeat();
      return;
    }
    this.pongPending = true;
    try {
      this.endpoint.sendCommand({ type: "ping" });
    } catch {
      this.stopHeartbeat();
      return;
    }
    const interval = this.opts.heartbeatIntervalMs ?? 15_000;
    const window = Math.min(this.opts.heartbeatTimeoutMs ?? 10_000, interval - 1);
    const wait = window > 0 ? window : 1_000;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      if (!this.pongPending) return;
      this.pongPending = false;
      this.heartbeatFailures += 1;
      const max = this.opts.maxHeartbeatFailures ?? 3;
      if (this.heartbeatFailures >= max) {
        this.handleHeartbeatCrash();
      }
    }, wait);
    if (typeof this.pongTimer.unref === "function") this.pongTimer.unref();
  }

  private handlePongReceived(): void {
    this.pongPending = false;
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.heartbeatFailures = 0;
  }

  private handleHeartbeatCrash(): void {
    if (this.statusValue === "crashed") return;
    this.statusValue = "crashed";
    this.stopHeartbeat();
    const msg = redactRuntimeError(`heartbeat: ${this.opts.maxHeartbeatFailures ?? 3} consecutive pong failures (Guest worker unresponsive)`);
    this.queue.push({ type: "runtime_error", category: "timeout", message: msg });
    this.opts.metrics?.noteCrash(this.sandboxName, "timeout", msg);
    void this.cleanupHalfStartedSandbox();
    this.opts.onFatal?.();
  }

  // ─── M5-S4 B: per-turn watchdog ────────────────────────────────────────────
  private armTurnWatchdog(runId: string): void {
    const ms = this.opts.turnWatchdogMs ?? 180_000;
    if (ms <= 0) return; // disabled (tests)
    if (this.turnWatchdogTimer) clearTimeout(this.turnWatchdogTimer);
    this.turnWatchdogRunId = runId;
    this.turnWatchdogTimer = setTimeout(() => {
      this.turnWatchdogTimer = null;
      if (this.turnWatchdogRunId !== runId) return; // a new turn armed
      this.turnWatchdogRunId = null;
      this.watchdogFinalizedRunIds.add(runId);
      this.queue.push({
        type: "turn_failed",
        category: "timeout",
        message: "turn watchdog: no terminal event received within bounded interval (Guest stuck)",
      });
      if (this.statusValue !== "crashed") this.statusValue = "crashed";
      this.opts.metrics?.noteCrash(this.sandboxName, "timeout", "turn watchdog: no terminal event received within bounded interval");
      this.opts.onFatal?.();
    }, ms);
    if (typeof this.turnWatchdogTimer?.unref === "function") this.turnWatchdogTimer.unref();
  }

  private cancelTurnWatchdog(): void {
    if (this.turnWatchdogTimer) {
      clearTimeout(this.turnWatchdogTimer);
      this.turnWatchdogTimer = null;
    }
    this.turnWatchdogRunId = null;
  }

  private async cleanupHalfStartedSandbox(): Promise<void> {
    try {
      await this.launcher.remove();
    } catch {
      try { await this.launcher.stop(); } catch { /* best-effort — backstop is reaper */ }
    }
  }

  async close(): Promise<void> {
    // R2: clear watchdog finalization tracking — no late terminal can race
    // after close() returns. Paired with cancelAbortWatchdog above.
    this.cancelAbortWatchdog();
    this.clearWatchdogFinalization();
    // M5-S4 B: cancel all timers — no heartbeat/startup/turn-watchdog fires
    // after close begins. The sandbox is being torn down.
    this.cancelStartupTimeout();
    this.stopHeartbeat();
    this.cancelTurnWatchdog();
    this.opts.metrics?.noteStopStart(this.sandboxName);
    this.statusValue = this.statusValue === "crashed" ? "crashed" : "stopping";
    this.endpoint.close();
    try {
      await this.launcher.remove();
    } catch {
      try {
        await this.launcher.stop();
      } catch {
        // M3 closure: BOTH cleanup paths failed — the sandbox may be an
        // orphan. Surface it loudly (ops backstop: reapOrphanMicrovmSandboxes).
        this.queue.push({ type: "runtime_error", category: "io", message: redactRuntimeError("sandbox cleanup failed (stop and rm both errored — sandbox may need manual reaping)") });
      }
    }
    // A crashed runtime stays "crashed" — cleanup must not mask the failure.
    if (this.statusValue !== "crashed") this.statusValue = "stopped";
    this.opts.metrics?.noteStopDone(this.sandboxName);
    this.queue.end();
  }

  getStatus(): RuntimeStatus {
    if (this.startError && this.statusValue === "crashed") return "crashed";
    return this.statusValue;
  }

  getEventStream(): AsyncIterable<RuntimeEvent> {
    return this.queue;
  }
}

/** Convenience factory matching the RuntimeFactory shape (additive export). */
export function createMicrosandboxRuntime(opts: MicrosandboxRuntimeOptions): MicrosandboxAgentRuntime {
  return MicrosandboxAgentRuntime.create(opts);
}
