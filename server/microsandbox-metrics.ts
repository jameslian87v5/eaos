/**
 * microsandbox-metrics.ts — M5-S3: per-runtime lifecycle metrics + diagnostics.
 *
 * Records ONLY operational signals: boot/recovery/stop timing, status
 * transitions, failure category + redacted message, and the governed
 * resource policy envelope. NEVER records: prompt content, original
 * subject, credentials, or raw tool payloads.
 *
 * Bounded in-memory ring buffer (no unbounded growth); safe to expose
 * via an admin diagnostics endpoint or pipe to structured logs.
 */

export type MicrosandboxRuntimePhase =
  | "booting" // msb create → runtime_ready
  | "running" // runtime_ready received
  | "stopping" // abort issued / close started
  | "stopped" // close completed cleanly
  | "crashed"; // transport error / watchdog fired / start failed

export interface MicrosandboxMetricsEvent {
  /** ISO timestamp — when the event was recorded. */
  ts: string;
  /** Sandbox name (ops/diagnostics — matches `msb list` output). */
  sandboxName: string;
  /** Current phase after this event. */
  phase: MicrosandboxRuntimePhase;
  /** Lifecycle milestone that produced this event. */
  kind:
    | "boot_start"
    | "boot_ready"
    | "boot_failed"
    | "cold_resume_start"
    | "cold_resume_ready"
    | "turn_terminal"
    | "runtime_error"
    | "stop_start"
    | "stop_done"
    | "crash";
  /** Elapsed ms for the milestone (boot/recovery/stop), or null for point-in-time events. */
  elapsedMs: number | null;
  /** Terminal category for `turn_terminal` / `runtime_error` / `crash` (never carries payload). */
  category?: string;
  /** Redacted failure message (already passed through redactRuntimeError). */
  message?: string;
  /** Whether this runtime was started with a resumeToken (cold-recovery path). */
  resumed: boolean;
  /** Resource policy envelope at boot time (governed, not runtime-measured). */
  resourcePolicy?: {
    memoryMb: number;
    cpuCores: number;
    workspaceQuotaMb: number;
  };
}

export interface MicrosandboxMetricsOptions {
  /** Max events retained per runtime (default 64). */
  maxEvents?: number;
  /** Sink for structured log lines (default: no-op). The caller wires stderr/JSON. */
  log?: (e: MicrosandboxMetricsEvent) => void;
  /** Now() injection for deterministic tests. */
  now?: () => number;
}

export class MicrosandboxMetricsCollector {
  private readonly events: MicrosandboxMetricsEvent[] = [];
  private readonly max: number;
  private readonly log: (e: MicrosandboxMetricsEvent) => void;
  private readonly now: () => number;
  private bootStartMs: number | null = null;
  private stopStartMs: number | null = null;

  constructor(opts: MicrosandboxMetricsOptions = {}) {
    this.max = opts.maxEvents ?? 64;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  private record(e: Omit<MicrosandboxMetricsEvent, "ts">): void {
    const full: MicrosandboxMetricsEvent = { ts: new Date(this.now()).toISOString(), ...e };
    this.events.push(full);
    if (this.events.length > this.max) this.events.shift();
    this.log(full);
  }

  /** Boot starts when the runtime's startTask begins (msb create dispatched). */
  noteBootStart(sandboxName: string, resumed: boolean, resourcePolicy: { memoryMb: number; cpuCores: number; workspaceQuotaMb: number }): void {
    this.bootStartMs = this.now();
    this.record({ sandboxName, phase: "booting", kind: resumed ? "cold_resume_start" : "boot_start", elapsedMs: null, resumed, resourcePolicy });
  }

  /** runtime_ready received — the sandbox is ready to accept turns. */
  noteBootReady(sandboxName: string, resumed: boolean): void {
    const elapsed = this.bootStartMs !== null ? this.now() - this.bootStartMs : null;
    this.record({ sandboxName, phase: "running", kind: resumed ? "cold_resume_ready" : "boot_ready", elapsedMs: elapsed, resumed });
    this.bootStartMs = null;
  }

  /** Boot failed before runtime_ready (start error, transport, etc.). */
  noteBootFailed(sandboxName: string, resumed: boolean, category: string, message: string): void {
    const elapsed = this.bootStartMs !== null ? this.now() - this.bootStartMs : null;
    this.record({ sandboxName, phase: "crashed", kind: "boot_failed", elapsedMs: elapsed, resumed, category, message });
    this.bootStartMs = null;
  }

  /** A turn reached terminal state (completed or failed). */
  noteTurnTerminal(sandboxName: string, category: string): void {
    this.record({ sandboxName, phase: "running", kind: "turn_terminal", elapsedMs: null, resumed: false, category });
  }

  /** A runtime_error was emitted (transport/cleanup/protocol). */
  noteRuntimeError(sandboxName: string, category: string, message: string): void {
    this.record({ sandboxName, phase: "crashed", kind: "runtime_error", elapsedMs: null, resumed: false, category, message });
  }

  /** Stop/close started. */
  noteStopStart(sandboxName: string): void {
    this.stopStartMs = this.now();
    this.record({ sandboxName, phase: "stopping", kind: "stop_start", elapsedMs: null, resumed: false });
  }

  /** Stop/close completed cleanly. */
  noteStopDone(sandboxName: string): void {
    const elapsed = this.stopStartMs !== null ? this.now() - this.stopStartMs : null;
    this.record({ sandboxName, phase: "stopped", kind: "stop_done", elapsedMs: elapsed, resumed: false });
    this.stopStartMs = null;
  }

  /** Crash (transport exit, watchdog, etc.) — distinct from boot_failed. */
  noteCrash(sandboxName: string, category: string, message: string): void {
    this.record({ sandboxName, phase: "crashed", kind: "crash", elapsedMs: null, resumed: false, category, message });
  }

  /** Snapshot the bounded event log (oldest → newest). */
  snapshot(): readonly MicrosandboxMetricsEvent[] {
    return [...this.events];
  }

  /** Reset (tests only). */
  reset(): void {
    this.events.length = 0;
    this.bootStartMs = null;
    this.stopStartMs = null;
  }
}

/** Shared process-wide collector (admin diagnostics can snapshot it). */
let sharedCollector: MicrosandboxMetricsCollector | null = null;
export function sharedMicrosandboxMetrics(): MicrosandboxMetricsCollector {
  if (!sharedCollector) sharedCollector = new MicrosandboxMetricsCollector();
  return sharedCollector;
}
