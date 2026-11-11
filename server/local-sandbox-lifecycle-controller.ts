/**
 * local-sandbox-lifecycle-controller.ts — M5-S4 A: Host-led lifecycle.
 *
 * The Host is the runtime lifecycle + health authoritative (artifact §A).
 * `msb idle-timeout` is a backstop only — it cannot express "no user task"
 * because the persistent `msb exec --stream` carrier keeps the sandbox
 * alive regardless of whether a turn is in flight.
 *
 * This controller tracks per-chat activity state and, on a bounded scan
 * interval, reclaims sandboxes that have been idle longer than `idleStopMs`
 * with no in-flight turn, no pending approval, and no pending A2UI.
 * Browser subscribers alone do NOT block reclaim (artifact §A: subscriber
 * count is diagnostic only).
 *
 * Frozen invariants (artifact §A):
 *   1. idle = idleStopMs elapsed + no in-flight turn + no pending approval
 *      + no pending A2UI + browser WS doesn't block.
 *   2. Default idleStopMs = 5 minutes (admin still configurable).
 *   3. Scan every 30s (bounded; no busy-poll).
 *   4. On reclaim: Session.close() + delete from sessions Map + release
 *      limiter slot + agent_sessions.status=stopped, cleanup_reason=idle_timeout.
 *   5. busy/pending approval/pending A2UI = protection — no reclaim.
 *
 * The controller is deliberately decoupled from Session/Docker
 * ContainerManager — it does not touch MicroVM internals; it calls the
 * injected `closeRuntime(chatId)` callback (which calls Session.close())
 * and the injected limiter (which releases the slot).
 */

import type { SandboxConcurrencyLimiter } from "./microsandbox-concurrency.js";

export interface LocalSandboxLifecycleControllerOptions {
  /** Idle reclaim threshold (ms). Default 5 minutes (300,000). */
  idleStopMs?: number;
  /** Scan interval (ms). 0 = disable auto-scan (tests call scan() manually). Default 30,000. */
  scanIntervalMs?: number;
  /** Concurrency limiter (releases the slot on reclaim). */
  limiter?: SandboxConcurrencyLimiter;
  /**
   * Called when a chat is reclaimed. MUST be idempotent. M5-S4 R2: receives
   * the cleanupReason so the callback can persist agent_sessions.status +
   * cleanup_reason BEFORE (or atomically with) deleting the sessions Map
   * entry — avoids the bug where a separate markStopped callback scanned
   * the sessions Map AFTER deletion and couldn't find the userId.
   */
  closeRuntime: (chatId: string, cleanupReason: string) => Promise<void> | void;
  /** Called after reclaim to delete the chat from the sessions Map (host-side). */
  deleteSession?: (chatId: string) => void;
  /** Called after reclaim to mark agent_sessions.status=stopped, cleanup_reason=idle_timeout. */
  markStopped?: (chatId: string, cleanupReason: string) => void;
  /** Clock injection (tests). Default Date.now. */
  now?: () => number;
  /** Setinterval handle unref (don't keep event loop alive). Default true. */
  unref?: boolean;
}

interface ChatState {
  lastActivityAt: number;
  isAgentBusy: boolean;
  hasPendingApproval: boolean;
  hasPendingA2UI: boolean;
  subscriberCount: number;
  lastHeartbeatAt: number;
  consecutiveHeartbeatFailures: number;
  /** Slot key in the limiter (released on reclaim). */
  slotKey?: string;
}

export interface LocalSandboxLifecycleController {
  /** Record activity for a chat (user message, Guest event, turn terminal, etc.). */
  touch(chatId: string, reason?: string): void;
  /** Update agent-busy flag (in-flight turn). */
  setBusy(chatId: string, busy: boolean): void;
  /** Update pending-approval flag (blocks reclaim). */
  setPendingApproval(chatId: string, pending: boolean): void;
  /** Update pending-A2UI flag (blocks reclaim). */
  setPendingA2UI(chatId: string, pending: boolean): void;
  /** Update subscriber count (diagnostic only — does NOT block reclaim). */
  setSubscriberCount(chatId: string, count: number): void;
  /** Record a heartbeat probe result (updates lastHeartbeatAt + failure counter). */
  recordHeartbeat(chatId: string, ok: boolean): void;
  /** Register a chat that holds a limiter slot (released on reclaim). */
  registerSlot(chatId: string, slotKey: string): void;
  /** Remove a chat from tracking (closed externally — e.g. user-initiated stop). */
  remove(chatId: string): void;
  /** One scan pass — reclaims idle, unprotected chats. Returns reclaimed chatIds. */
  scan(): Promise<readonly string[]>;
  /** Stop the auto-scan timer (shutdown). */
  stop(): void;
  /** Read-only snapshot of tracked state (diagnostics). */
  snapshot(): ReadonlyArray<{ chatId: string } & ChatState>;
}

export function createLocalSandboxLifecycleController(
  opts: LocalSandboxLifecycleControllerOptions,
): LocalSandboxLifecycleController {
  const idleStopMs = opts.idleStopMs ?? 300_000;
  const scanIntervalMs = opts.scanIntervalMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const unref = opts.unref ?? true;
  const states = new Map<string, ChatState>();

  const ensure = (chatId: string): ChatState => {
    let s = states.get(chatId);
    if (!s) {
      s = {
        lastActivityAt: now(),
        isAgentBusy: false,
        hasPendingApproval: false,
        hasPendingA2UI: false,
        subscriberCount: 0,
        lastHeartbeatAt: now(),
        consecutiveHeartbeatFailures: 0,
      };
      states.set(chatId, s);
    }
    return s;
  };

  const ctrl: LocalSandboxLifecycleController = {
    touch(chatId, _reason) {
      const s = ensure(chatId);
      s.lastActivityAt = now();
    },
    setBusy(chatId, busy) {
      const s = ensure(chatId);
      s.isAgentBusy = busy;
      if (busy) s.lastActivityAt = now(); // busy = activity
    },
    setPendingApproval(chatId, pending) {
      const s = ensure(chatId);
      s.hasPendingApproval = pending;
      if (pending) s.lastActivityAt = now();
    },
    setPendingA2UI(chatId, pending) {
      const s = ensure(chatId);
      s.hasPendingA2UI = pending;
      if (pending) s.lastActivityAt = now();
    },
    setSubscriberCount(chatId, count) {
      const s = ensure(chatId);
      s.subscriberCount = Math.max(0, Math.floor(count));
      // subscriberCount is diagnostic only — does NOT update lastActivityAt.
    },
    recordHeartbeat(chatId, ok) {
      const s = ensure(chatId);
      s.lastHeartbeatAt = now();
      if (ok) {
        s.consecutiveHeartbeatFailures = 0;
      } else {
        s.consecutiveHeartbeatFailures += 1;
      }
    },
    registerSlot(chatId, slotKey) {
      const s = ensure(chatId);
      s.slotKey = slotKey;
    },
    remove(chatId) {
      states.delete(chatId);
    },
    async scan() {
      const t = now();
      const reclaimed: string[] = [];
      for (const [chatId, s] of states) {
        // Protection: busy / pending approval / pending A2UI → skip.
        if (s.isAgentBusy) continue;
        if (s.hasPendingApproval) continue;
        if (s.hasPendingA2UI) continue;
        // Idle check: lastActivityAt older than idleStopMs → reclaim.
        const idleFor = t - s.lastActivityAt;
        if (idleFor < idleStopMs) continue;
        // Reclaim: close runtime + release limiter slot + delete session.
        // M5-S4 R2: closeRuntime receives the cleanupReason so it can
        // persist agent_sessions.status=stopped + cleanup_reason BEFORE
        // deleting the sessions Map entry (avoids stale `running` rows).
        const cleanupReason = "idle_timeout";
        try {
          await opts.closeRuntime(chatId, cleanupReason);
        } catch (e) {
          console.warn(`[lifecycle] closeRuntime('${chatId}') failed during idle reclaim: ${(e as Error).message}`);
        }
        if (s.slotKey) {
          try { opts.limiter?.release(s.slotKey); } catch { /* best-effort */ }
        }
        opts.deleteSession?.(chatId);
        opts.markStopped?.(chatId, cleanupReason);
        states.delete(chatId);
        reclaimed.push(chatId);
      }
      return reclaimed;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    snapshot() {
      return [...states.entries()].map(([chatId, s]) => ({ chatId, ...s }));
    },
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (scanIntervalMs > 0) {
    timer = setInterval(() => { void ctrl.scan(); }, scanIntervalMs);
    if (unref && typeof timer.unref === "function") timer.unref();
  }

  return ctrl;
}
