/**
 * local-agent-worker-protocol.ts — Host↔Guest Worker transport (M3-S1).
 *
 * Layering (plan §5.1): the platform protocol v0 (platform-runtime-protocol.ts)
 * defines the CLOSED command/event surfaces. This module adds the TRANSPORT
 * semantics a long-lived local Worker needs:
 *   - version handshake (first event MUST be runtime_ready with the engine's
 *     capabilities — no engine-private fields, enforced by scanner);
 *   - per-direction sequence/idempotency (duplicate seq → drop-duplicate;
 *     gap → ProtocolViolationError, fail closed);
 *   - bounded frames (MAX_FRAME_BYTES both directions — inherited);
 *   - per-command ACK timeout + disconnect failure semantics: a command that
 *     is not observable by the peer within `commandTimeoutMs` fails closed
 *     with category "timeout" / "io" — the Host NEVER hangs on a dead Guest;
 *   - NO raw engine passthrough: every outbound frame is scanned for
 *     engine-private keys (scanForEnginePrivateFields) before it leaves the
 *     Worker side, and the Host side drops+flags any frame carrying them.
 *
 * DI by design: transport + clock are injected; tests never need a real
 * sandbox. Nothing here knows about msb/Docker — it is pure framing state.
 */

import {
  FrameSequenceTracker,
  MAX_FRAME_BYTES,
  ProtocolViolationError,
  RUNTIME_PROTOCOL_VERSION,
  parseFrame,
  scanForEnginePrivateFields,
  serializeFrame,
  type PlatformRuntimeCommand,
  type PlatformRuntimeEvent,
  type ProtocolFrame,
} from "./platform-runtime-protocol.js";

export { MAX_FRAME_BYTES, RUNTIME_PROTOCOL_VERSION, ProtocolViolationError };

export const WORKER_PROTOCOL_LAYER = "local-agent-worker/v1" as const;

/** Default per-command observability timeout (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Max concurrent unobserved commands per direction (headroom above the
 * protocol's closed command surface — a flooding Host fails closed). */
export const MAX_INFLIGHT_COMMANDS = 64;
/** Grace for late events after disconnect (ms) before pending fail-closed. */
export const DISCONNECT_GRACE_MS = 2_000;

export type WorkerTransportStatus = "open" | "closed";

export interface WorkerTransport {
  /** Deliver one serialized frame to the peer. Throws on broken transport. */
  send(text: string): void;
  close?(): void;
}

export interface PendingCommand {
  readonly frame: ProtocolFrame;
  readonly type: string;
  readonly enqueuedAt: number;
  /** Set once the peer has OBSERVED the command (seq consumed remotely or —
   * in this S1 transport model — once it was handed to `transport.send`). */
  observed: boolean;
}

export type WorkerSideEvent =
  | { kind: "event"; event: PlatformRuntimeEvent; frame: ProtocolFrame }
  | { kind: "duplicate-dropped"; seq: number }
  | { kind: "command-timeout"; type: string; seq: number }
  | { kind: "transport-failed"; error: string };

/**
 * One endpoint of the worker transport. The HOST constructs one side; the
 * GUEST entry constructs the mirrored side (commands ⇄ events directions
 * swap). State machine per direction is independent (seq tracks are per-side).
 */
export class WorkerProtocolEndpoint {
  private readonly txSeq = new FrameSequenceTracker();
  private readonly rxSeq = new FrameSequenceTracker();
  private readonly pending = new Map<number, PendingCommand>();
  private readonly observers = new Set<(e: WorkerSideEvent) => void>();
  private handshakeSeen = false;
  private closed = false;
  private closedAt = 0;

  constructor(
    private readonly transport: WorkerTransport,
    private readonly opts: {
      commandTimeoutMs?: number;
      now?: () => number;
      /** Role label for diagnostics only. */
      role?: string;
    } = {},
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Commands sent (tx) — Host→Guest direction. Fails closed on violations. */
  sendCommand(command: PlatformRuntimeCommand): ProtocolFrame {
    if (this.closed) throw new ProtocolViolationError("endpoint closed");
    const unobserved = [...this.pending.values()].filter((p) => !p.observed).length;
    if (unobserved >= MAX_INFLIGHT_COMMANDS) {
      throw new ProtocolViolationError(`in-flight command cap exceeded (${MAX_INFLIGHT_COMMANDS})`);
    }
    // Neutrality applies to BOTH directions: an outbound command carrying
    // engine-private structure is refused AND poisons the endpoint.
    const leaks = scanForEnginePrivateFields(command);
    if (leaks.length > 0) {
      this.failClosed(new ProtocolViolationError(`engine-private fields in outbound command: ${leaks.join(", ")}`));
      throw new ProtocolViolationError(`engine-private fields in outbound command: ${leaks.join(", ")}`);
    }
    const seq = this.nextTxSeq();
    const frame: ProtocolFrame = { v: RUNTIME_PROTOCOL_VERSION, seq, kind: "command", body: command };
    const text = serializeFrame(frame); // closed surface + byte bound enforced here
    this.transport.send(text);
    // observed=false: transport.send success does NOT prove peer liveness —
    // only an accepted inbound event does (see handleEventFrame).
    this.pending.set(seq, {
      frame,
      type: command.type,
      enqueuedAt: (this.opts.now ?? Date.now)(),
      observed: false,
    });
    return frame;
  }

  /** Guest→Host direction: validate, enforce sequence rules + neutrality. */
  handleEventFrame(text: string): WorkerSideEvent[] {
    const out: WorkerSideEvent[] = [];
    const verdict = this.parseInbound(text, "event");
    if (verdict.error) {
      this.failClosed(verdict.error);
      return out;
    }
    const frame = verdict.frame as ProtocolFrame;
    // Sequence gap = protocol violation. Caught here and turned into a
    // fail-closed close + empty result — NEVER propagated out of the handler.
    let action: "accept" | "drop-duplicate";
    try {
      action = this.rxSeq.observe(frame.seq);
    } catch (e) {
      this.failClosed(e instanceof ProtocolViolationError ? e : new ProtocolViolationError(`sequence violation on inbound event: ${String(e)}`));
      return out;
    }
    if (action === "drop-duplicate") {
      out.push({ kind: "duplicate-dropped", seq: frame.seq });
      return out;
    }
    const event = frame.body as PlatformRuntimeEvent;
    // Handshake: the FIRST event must be runtime_ready (worker hello).
    if (!this.handshakeSeen) {
      if (event.type !== "runtime_ready") {
        this.failClosed(new ProtocolViolationError(`first event must be runtime_ready, got '${event.type}'`));
        return out;
      }
      this.handshakeSeen = true;
    }
    // Accepted event = proof the peer is alive and consuming: all pending
    // commands are now observed (their timeout clocks stop here).
    for (const p of this.pending.values()) p.observed = true;
    out.push({ kind: "event", event, frame });
    this.emit(out);
    return out;
  }

  /** Host side receiving commands (mirror for the Guest endpoint). */
  handleCommandFrame(text: string): { command?: PlatformRuntimeCommand; frame?: ProtocolFrame } {
    const verdict = this.parseInbound(text, "command");
    if (verdict.error) {
      this.failClosed(verdict.error);
      return {};
    }
    const frame = verdict.frame as ProtocolFrame;
    let action: "accept" | "drop-duplicate";
    try {
      action = this.rxSeq.observe(frame.seq);
    } catch (e) {
      this.failClosed(e instanceof ProtocolViolationError ? e : new ProtocolViolationError(`sequence violation on inbound command: ${String(e)}`));
      return {};
    }
    if (action === "drop-duplicate") return {}; // idempotent: duplicates are no-ops
    return { command: frame.body as PlatformRuntimeCommand, frame };
  }

  /** Serialize an event on the Worker (Guest) side. Enforces neutrality. */
  sendEvent(event: PlatformRuntimeEvent): ProtocolFrame {
    if (this.closed) throw new ProtocolViolationError("endpoint closed");
    const leaks = scanForEnginePrivateFields(event);
    if (leaks.length > 0) {
      // Engine-private structure trying to cross the boundary — refuse the
      // frame AND poison the endpoint (fail closed, never degrade).
      this.failClosed(new ProtocolViolationError(`engine-private fields in outbound event: ${leaks.join(", ")}`));
      throw new ProtocolViolationError(`engine-private fields in outbound event: ${leaks.join(", ")}`);
    }
    const seq = this.nextTxSeq();
    const frame: ProtocolFrame = { v: RUNTIME_PROTOCOL_VERSION, seq, kind: "event", body: event };
    this.transport.send(serializeFrame(frame));
    return frame;
  }

  /** Fail any command whose peer-observability timed out (Host side sweep). */
  sweepTimeouts(): WorkerSideEvent[] {
    const now = (this.opts.now ?? Date.now)();
    const out: WorkerSideEvent[] = [];
    if (this.closed && now - this.closedAt > DISCONNECT_GRACE_MS) {
      for (const [seq, p] of this.pending) {
        out.push({ kind: "command-timeout", type: p.type, seq });
        this.pending.delete(seq);
      }
      return out;
    }
    // Purge observed entries first (peer proved liveness; nothing pending).
    for (const [seq, p] of this.pending) {
      if (p.observed) this.pending.delete(seq);
    }
    const timeout = this.opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    for (const [seq, p] of this.pending) {
      if (now - p.enqueuedAt > timeout) {
        out.push({ kind: "command-timeout", type: p.type, seq });
        this.pending.delete(seq);
      }
    }
    this.emit(out);
    return out;
  }

  /** Close the endpoint; all pending commands fail closed after grace. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closedAt = (this.opts.now ?? Date.now)();
    try {
      this.transport.close?.();
    } catch {
      /* best-effort */
    }
  }

  onEvent(observer: (e: WorkerSideEvent) => void): void {
    this.observers.add(observer);
  }

  private emit(events: WorkerSideEvent[]): void {
    for (const e of events) for (const o of this.observers) o(e);
  }

  private nextTxSeq(): number {
    const next = this.txSeq.last + 1;
    this.txSeq.observe(next);
    return next;
  }

  private parseInbound(
    text: string,
    kind: "command" | "event",
  ): { frame?: ProtocolFrame; error?: ProtocolViolationError } {
    if (this.closed) return { error: new ProtocolViolationError("endpoint closed") };
    let bytes: number;
    try {
      bytes = Buffer.byteLength(text, "utf8");
    } catch {
      return { error: new ProtocolViolationError("frame is not a string") };
    }
    if (bytes > MAX_FRAME_BYTES) {
      return { error: new ProtocolViolationError(`frame exceeds MAX_FRAME_BYTES (${bytes})`) };
    }
    try {
      const frame = parseFrame(text);
      if (frame.kind !== kind) {
        return { error: new ProtocolViolationError(`expected kind '${kind}', got '${frame.kind}'`) };
      }
      // Neutrality BOTH directions: inbound commands are scanned exactly like
      // inbound events (the Guest must never smuggle private structure back).
      const leaks = scanForEnginePrivateFields(frame.body);
      if (leaks.length > 0) {
        return { error: new ProtocolViolationError(`engine-private fields in inbound ${kind}: ${leaks.join(", ")}`) };
      }
      return { frame };
    } catch (e) {
      return { error: e instanceof ProtocolViolationError ? e : new ProtocolViolationError("frame is not valid JSON") };
    }
  }

  private failClosed(error: ProtocolViolationError): void {
    this.close();
    this.emit([{ kind: "transport-failed", error: error.message }]);
  }
}
