/**
 * local-sandbox-lifecycle.test.ts — M5-S4 A+B: lifecycle controller + health
 * probe + turn watchdog + startup timeout.
 *
 * Covers artifact test cases 3–8:
 *   3. idle 5min + no busy/pending → close runtime + delete Session + release limiter
 *   4. busy + pending approval + pending A2UI → no reclaim
 *   5. browser subscriber only + no task → still reclaimable
 *   6. heartbeat consecutive failures → running→crashed, sandbox removed, slot released
 *   7. turn watchdog → exactly one timeout terminal; late terminal suppressed
 *   8. startup timeout → clean half-started sandbox
 *
 * Run: npx tsx server/local-sandbox-lifecycle.test.ts
 */
import assert from "node:assert/strict";
import { createMicrosandboxRuntime, type WorkerLauncher, type MicrosandboxRuntimeOptions } from "./microsandbox-runtime.js";
import { createLocalSandboxLifecycleController, type LocalSandboxLifecycleController } from "./local-sandbox-lifecycle-controller.js";
import { createSandboxConcurrencyLimiter } from "./microsandbox-concurrency.js";
import type { RuntimeEvent } from "./agent-runtime.js";

let passed = 0, failed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
function atest(name: string, fn: () => Promise<void> | void): void { tests.push([name, fn]); }
async function main(): Promise<void> {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

const READY_LINE = JSON.stringify({
  v: "0", seq: 1, kind: "event",
  body: { type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } },
});
const TURN_DONE_LINE = (runId: string, seq: number) => JSON.stringify({ v: "0", seq, kind: "event", body: { type: "turn_completed", runId, finalText: "ok" } });
const TURN_FAILED_LINE = (runId: string, seq: number, category = "error") => JSON.stringify({ v: "0", seq, kind: "event", body: { type: "turn_failed", runId, category, message: "guest failed" } });

function scriptedLauncher(handlers: { onCommand?: (seq: number, body: { type: string }) => Array<{ type: string; [k: string]: unknown }> | string[] } = {}): WorkerLauncher & { sent: string[]; removed: boolean; stopped: boolean; sinkRef: ((t: string) => void) | null; emit: (line: string) => void } {
  let sink: ((t: string) => void) | null = null;
  const sent: string[] = [];
  let removed = false, stopped = false;
  // Track Guest event seq — each emitted event must use the next seq.
  let nextGuestSeq = 0;
  const emit = (body: { type: string; [k: string]: unknown } | string): string => {
    if (typeof body === "string") return body;
    nextGuestSeq += 1;
    return JSON.stringify({ v: "0", seq: nextGuestSeq, kind: "event", body });
  };
  return {
    setSink(s) { sink = s; },
    async start() {},
    send(frameText: string) {
      sent.push(frameText);
      let parsed: { seq: number; body: { type: string } };
      try { parsed = JSON.parse(frameText); } catch { return; }
      const out = handlers.onCommand?.(parsed.seq, parsed.body) ?? [];
      for (const item of out) {
        const line = typeof item === "string" ? item : emit(item);
        sink?.(line);
      }
    },
    async stop() { stopped = true; },
    async remove() { removed = true; },
    get sent() { return sent; },
    get removed() { return removed; },
    get stopped() { return stopped; },
    get sinkRef() { return sink; },
    emit(line: string) {
      // Re-emit with the next seq (late terminal test). Parse + bump seq.
      try {
        const p = JSON.parse(line) as { seq: number; body: unknown };
        nextGuestSeq += 1;
        const rebumped = JSON.stringify({ ...p, seq: nextGuestSeq });
        sink?.(rebumped);
      } catch {
        sink?.(line);
      }
    },
  } as WorkerLauncher & { sent: string[]; removed: boolean; stopped: boolean; sinkRef: ((t: string) => void) | null; emit: (line: string) => void };
}

function greenLaunchPolicy(): MicrosandboxRuntimeOptions["launchPolicy"] {
  return {
    msbPath: "/tmp/msb", msbVersion: "0.6.18", guestImage: "eaos-guest:0.1.4",
    memoryMb: 512, cpuCores: 1,
    workspaceRoots: [{ path: "/workspace", access: "rw" as const }],
    networkEgress: "none" as const, idleTimeout: "30s", workspaceQuotaMb: 256,
  };
}
function greenPolicy(): MicrosandboxRuntimeOptions["policy"] {
  return {
    modelRef: "opus", exposedToolIds: ["Read"], allowedToolIds: ["Read"], deniedToolIds: [],
    mcpServers: [], workspacePolicy: { roots: [{ path: "/workspace", access: "rw" }] },
    networkPolicy: { egress: "none" },
    resourcePolicy: { maxMemoryMb: 512, maxCpuCores: 1, workspaceQuotaMb: 256 },
  } as MicrosandboxRuntimeOptions["policy"];
}

async function drainEvents(rt: { getEventStream(): AsyncIterable<RuntimeEvent> }, until: (e: RuntimeEvent) => boolean, ms = 200): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  const iter = rt.getEventStream()[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<RuntimeEvent>>((r) => setTimeout(() => r({ value: undefined as unknown as RuntimeEvent, done: true }), Math.max(10, deadline - Date.now()))),
    ]);
    if (next.done) break;
    out.push(next.value);
    if (until(next.value)) break;
  }
  return out;
}

// ─── Test 6: heartbeat consecutive failures → crashed ──────────────────────

atest("TC.HB1: 3 consecutive pong failures → running→crashed, sandbox removed, onFatal fired", async () => {
  let fatalFired = false;
  const launcher = scriptedLauncher({
    onCommand: (_seq, body) => {
      if (body.type === "start") return [{ type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } }];
      return []; // ping gets no response (stuck worker)
    },
  });
  const rt = createMicrosandboxRuntime({
    launchPolicy: greenLaunchPolicy(), policy: greenPolicy(), hostMounts: [],
    skipProbe: true, launcher,
    heartbeatIntervalMs: 20, heartbeatTimeoutMs: 10, maxHeartbeatFailures: 3,
    onFatal: () => { fatalFired = true; },
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(rt.getStatus(), "crashed", "runtime converged to crashed after 3 pong failures");
  assert.ok(launcher.removed, "sandbox removed on heartbeat crash");
  assert.ok(fatalFired, "onFatal fired (slot released)");
  await rt.close();
});

atest("TC.HB2: pong resets failure counter — runtime stays running", async () => {
  const launcher = scriptedLauncher({
    onCommand: (_seq, body) => {
      if (body.type === "start") return [{ type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } }];
      if (body.type === "ping") return [{ type: "pong" }];
      return [];
    },
  });
  const rt = createMicrosandboxRuntime({
    launchPolicy: greenLaunchPolicy(), policy: greenPolicy(), hostMounts: [],
    skipProbe: true, launcher,
    heartbeatIntervalMs: 20, heartbeatTimeoutMs: 10, maxHeartbeatFailures: 3,
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(rt.getStatus(), "running", "runtime stays running when pong arrives");
  await rt.close();
});

// ─── Test 7: turn watchdog → exactly one timeout terminal; late terminal suppressed ─

atest("TC.TW1: worker never emits terminal → turn watchdog fires exactly one turn_failed{timeout}", async () => {
  let fatalFired = false;
  const launcher = scriptedLauncher({
    onCommand: (_seq, body) => {
      if (body.type === "start") return [{ type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } }];
      return []; // send_message: NO terminal response (worker stuck)
    },
  });
  const rt = createMicrosandboxRuntime({
    launchPolicy: greenLaunchPolicy(), policy: greenPolicy(), hostMounts: [],
    skipProbe: true, launcher,
    heartbeatIntervalMs: 0, // disable heartbeat for this test
    turnWatchdogMs: 50,
    onFatal: () => { fatalFired = true; },
  });
  await new Promise((r) => setTimeout(r, 30));
  rt.sendMessage("hello");
  const events = await drainEvents(rt, (e) => (e as { type: string }).type === "turn_failed", 200);
  const timeouts = events.filter((e) => {
    const evt = e as { type: string; category?: string };
    return evt.type === "turn_failed" && evt.category === "timeout";
  });
  assert.strictEqual(timeouts.length, 1, "exactly one turn_failed{timeout} emitted");
  assert.ok(fatalFired, "onFatal fired after turn watchdog");
  assert.strictEqual(rt.getStatus(), "crashed", "runtime crashed after turn watchdog");
  await rt.close();
});

atest("TC.TW2: late Guest terminal after turn watchdog is suppressed", async () => {
  const launcher = scriptedLauncher({
    onCommand: (_seq, body) => {
      if (body.type === "start") return [{ type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } }];
      return []; // send_message: no immediate terminal
    },
  });
  const rt = createMicrosandboxRuntime({
    launchPolicy: greenLaunchPolicy(), policy: greenPolicy(), hostMounts: [],
    skipProbe: true, launcher,
    heartbeatIntervalMs: 0,
    turnWatchdogMs: 50,
  });
  await new Promise((r) => setTimeout(r, 30));
  rt.sendMessage("hello");
  // Drain past the watchdog interval — collect all events (runtime_ready + watchdog).
  const events = await drainEvents(rt, (e) => (e as { type: string }).type === "turn_failed", 200);
  const watchdogTerminals = events.filter((e) => (e as { type: string }).type === "turn_failed");
  assert.strictEqual(watchdogTerminals.length, 1, "one turn_failed from watchdog");
  // Now emit a LATE terminal from the Guest — it must be suppressed.
  launcher.emit(JSON.stringify({ v: "0", seq: 0, kind: "event", body: { type: "turn_completed", runId: "local-sandbox-s1-1", finalText: "ok" } }));
  await new Promise((r) => setTimeout(r, 30));
  const more = await drainEvents(rt, () => false, 30);
  const lateTerminals = more.filter((e) => {
    const evt = e as { type: string };
    return evt.type === "turn_completed" || evt.type === "turn_failed";
  });
  assert.strictEqual(lateTerminals.length, 0, "late Guest terminal suppressed (no second terminal)");
  await rt.close();
});

atest("TC.TW3: real terminal cancels turn watchdog — no false timeout", async () => {
  const launcher = scriptedLauncher({
    onCommand: (_seq, body) => {
      if (body.type === "start") return [{ type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } }];
      if (body.type === "send_message") return [{ type: "turn_completed", runId: "local-sandbox-s1-1", finalText: "ok" }];
      return [];
    },
  });
  const rt = createMicrosandboxRuntime({
    launchPolicy: greenLaunchPolicy(), policy: greenPolicy(), hostMounts: [],
    skipProbe: true, launcher,
    heartbeatIntervalMs: 0,
    turnWatchdogMs: 50,
  });
  await new Promise((r) => setTimeout(r, 30));
  rt.sendMessage("hello");
  const events = await drainEvents(rt, (e) => (e as { type: string }).type === "turn_completed", 100);
  assert.ok(events.some((e) => (e as { type: string }).type === "turn_completed"), "real terminal arrived");
  // Wait past the watchdog interval — it should NOT fire (cancelled).
  const late = await drainEvents(rt, (e) => (e as { type: string }).type === "turn_failed", 80);
  assert.strictEqual(late.length, 0, "no false turn watchdog timeout after real terminal");
  await rt.close();
});

// ─── Test 8: startup timeout → clean half-started sandbox ───────────────────

atest("TC.ST1: runtime_ready never arrives → startup timeout → crashed + sandbox removed", async () => {
  let fatalFired = false;
  const launcher = scriptedLauncher({ onCommand: () => [] });
  const rt = createMicrosandboxRuntime({
    launchPolicy: greenLaunchPolicy(), policy: greenPolicy(), hostMounts: [],
    skipProbe: true, launcher,
    startupTimeoutMs: 40,
    heartbeatIntervalMs: 0,
    onFatal: () => { fatalFired = true; },
  });
  const events = await drainEvents(rt, (e) => (e as { type: string }).type === "runtime_error", 200);
  const startupErr = events.filter((e) => {
    const evt = e as { type: string; category?: string; message?: string };
    return evt.type === "runtime_error" && evt.category === "timeout" && (evt.message ?? "").includes("startup handshake");
  });
  assert.strictEqual(startupErr.length, 1, "startup timeout runtime_error emitted exactly once");
  assert.strictEqual(rt.getStatus(), "crashed", "runtime crashed after startup timeout");
  assert.ok(launcher.removed, "half-started sandbox removed");
  assert.ok(fatalFired, "onFatal fired (slot released)");
  await rt.close();
});

atest("TC.ST2: runtime_ready arrives in time → startup timeout cancelled", async () => {
  const launcher = scriptedLauncher({
    onCommand: (_seq, body) => {
      if (body.type === "start") return [{ type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } }];
      return [];
    },
  });
  const rt = createMicrosandboxRuntime({
    launchPolicy: greenLaunchPolicy(), policy: greenPolicy(), hostMounts: [],
    skipProbe: true, launcher,
    startupTimeoutMs: 50,
    heartbeatIntervalMs: 0,
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(rt.getStatus(), "running", "runtime_ready arrived → startup timeout cancelled");
  const events = await drainEvents(rt, (e) => (e as { type: string }).type === "runtime_error", 30);
  const runtimeErrors = events.filter((e) => (e as { type: string }).type === "runtime_error");
  assert.strictEqual(runtimeErrors.length, 0, "no startup timeout runtime_error emitted");
  await rt.close();
});

// ─── Test 3: idle 5min + no busy/pending → close + delete + release ─────────

atest("TC.ID1: idle > idleStopMs + not busy + no pending → close runtime + release limiter slot", async () => {
  const limiter = createSandboxConcurrencyLimiter(4);
  const closed: string[] = [];
  const ctrl = createLocalSandboxLifecycleController({
    idleStopMs: 5, scanIntervalMs: 0,
    limiter,
    closeRuntime: (chatId) => { closed.push(chatId); return Promise.resolve(); },
    now: (() => { let t = 0; return () => (t += 100); })(), // +100ms per call
  });
  ctrl.touch("chat1", "user_message");
  ctrl.setBusy("chat1", false);
  ctrl.setPendingApproval("chat1", false);
  ctrl.setPendingA2UI("chat1", false);
  assert.ok(limiter.tryAcquire("chat:chat1").ok, "slot acquired");
  ctrl.registerSlot("chat1", "chat:chat1");
  await ctrl.scan();
  assert.ok(closed.includes("chat1"), "chat1 runtime closed on idle reclaim");
  assert.ok(limiter.tryAcquire("chat:chat1").ok, "slot released after idle reclaim");
});

// ─── Test 4: busy + pending approval + pending A2UI → no reclaim ────────────

atest("TC.ID2: busy + pending approval + pending A2UI → no reclaim", async () => {
  const closed: string[] = [];
  const ctrl = createLocalSandboxLifecycleController({
    idleStopMs: 10, scanIntervalMs: 0,
    closeRuntime: (chatId) => { closed.push(chatId); return Promise.resolve(); },
    now: (() => { let t = 0; return () => (t += 100); })(), // big time jumps to exceed idleStopMs
  });
  ctrl.touch("chat1", "user_message");
  // busy = true → should NOT reclaim
  ctrl.setBusy("chat1", true);
  ctrl.scan();
  assert.strictEqual(closed.length, 0, "busy runtime not reclaimed");
  // busy = false + pending approval → should NOT reclaim
  ctrl.setBusy("chat1", false);
  ctrl.setPendingApproval("chat1", true);
  ctrl.scan();
  assert.strictEqual(closed.length, 0, "pending approval blocks reclaim");
  // pending A2UI → should NOT reclaim
  ctrl.setPendingApproval("chat1", false);
  ctrl.setPendingA2UI("chat1", true);
  ctrl.scan();
  assert.strictEqual(closed.length, 0, "pending A2UI blocks reclaim");
  // All clear → should reclaim
  ctrl.setPendingA2UI("chat1", false);
  ctrl.scan();
  assert.ok(closed.includes("chat1"), "reclaimed when all protections clear");
});

// ─── Test 5: browser subscriber only + no task → still reclaimable ───────────

atest("TC.ID3: browser subscriber only + no task → still reclaimable (subscriber count does NOT block)", async () => {
  const closed: string[] = [];
  const ctrl = createLocalSandboxLifecycleController({
    idleStopMs: 10, scanIntervalMs: 0,
    closeRuntime: (chatId) => { closed.push(chatId); return Promise.resolve(); },
    now: (() => { let t = 0; return () => (t += 100); })(),
  });
  ctrl.touch("chat1", "user_message");
  ctrl.setBusy("chat1", false);
  ctrl.setPendingApproval("chat1", false);
  ctrl.setPendingA2UI("chat1", false);
  // Browser subscriber present — does NOT block idle reclaim.
  ctrl.setSubscriberCount("chat1", 1);
  ctrl.scan();
  assert.ok(closed.includes("chat1"), "browser subscriber alone does not block reclaim");
});

// ─── Test 9 regression: scan() with no tracked chats is a no-op ─────────────

atest("TC.ID4: scan() with no tracked chats is a no-op (no throw, no close)", async () => {
  const closed: string[] = [];
  const ctrl = createLocalSandboxLifecycleController({
    idleStopMs: 10, scanIntervalMs: 0,
    closeRuntime: (chatId) => { closed.push(chatId); return Promise.resolve(); },
    now: (() => Date.now()),
  });
  ctrl.scan(); // no chats tracked
  assert.strictEqual(closed.length, 0, "no chats → no close");
  // touch + then remove — scan is still safe.
  ctrl.touch("chat1", "user_message");
  ctrl.remove("chat1");
  ctrl.scan();
  assert.strictEqual(closed.length, 0, "removed chat → no close");
});

// ─── Test R2: idle scan persists agent_sessions.status + cleanup_reason ────
// Regression: closeRuntime previously deleted the sessions Map entry BEFORE
// markStopped could read userId from it — so agent_sessions stayed `running`.
// M5-S4 R2 fix: closeRuntime captures userId BEFORE delete, then persists
// status=stopped + cleanup_reason=idle_timeout atomically.
atest("TC.ID5: idle scan persists agent_sessions.status=stopped + cleanup_reason=idle_timeout (R2 regression)", async () => {
  // Simulate the server.ts wiring: a sessions Map keyed by `userId:chatId`,
  // and an eventStore stub that records updateStatus/updateCleanupReason.
  const sessionsMap = new Map<string, { close: () => Promise<void> }>();
  const sessionUpdates: Array<{ id: string; status: string; cleanupReason: string }> = [];
  // Simulated eventStore — records status + cleanup_reason updates.
  const fakeEventStore = {
    getSessionByChat(userId: string, chatId: string) {
      return { id: `session-${userId}-${chatId}`, userId, chatId };
    },
    updateStatus(id: string, status: string) {
      sessionUpdates.push({ id, status, cleanupReason: "" });
    },
    updateCleanupReason(id: string, cleanupReason: string) {
      // Merge with the prior updateStatus call.
      const last = sessionUpdates[sessionUpdates.length - 1];
      if (last && last.id === id && last.cleanupReason === "") {
        last.cleanupReason = cleanupReason;
      } else {
        sessionUpdates.push({ id, status: "", cleanupReason });
      }
    },
  };
  // Seed the sessions Map with one chat.
  sessionsMap.set("user1:chat1", {
    close: async () => { /* simulated session.close() */ },
  });
  const ctrl = createLocalSandboxLifecycleController({
    idleStopMs: 5, scanIntervalMs: 0,
    closeRuntime: async (chatId, cleanupReason) => {
      // This mirrors the server.ts wiring: capture userId BEFORE delete.
      let resolvedUserId: string | null = null;
      for (const [key, session] of sessionsMap) {
        if (key.endsWith(`:${chatId}`)) {
          resolvedUserId = key.slice(0, -(`:${chatId}`).length);
          await session.close();
          sessionsMap.delete(key);
          break;
        }
      }
      if (resolvedUserId) {
        const rec = fakeEventStore.getSessionByChat(resolvedUserId, chatId);
        if (rec) {
          fakeEventStore.updateStatus(rec.id, "stopped");
          fakeEventStore.updateCleanupReason(rec.id, cleanupReason);
        }
      }
    },
    deleteSession: () => {},
    markStopped: () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
  });
  ctrl.touch("chat1", "user_message");
  ctrl.setBusy("chat1", false);
  ctrl.setPendingApproval("chat1", false);
  ctrl.setPendingA2UI("chat1", false);
  await ctrl.scan();
  // Assert: agent_sessions row was marked stopped + cleanup_reason=idle_timeout.
  assert.strictEqual(sessionUpdates.length, 1, "exactly one updateStatus call");
  assert.strictEqual(sessionUpdates[0]!.status, "stopped", "status persisted as stopped");
  assert.strictEqual(sessionUpdates[0]!.cleanupReason, "idle_timeout", "cleanup_reason persisted as idle_timeout");
  // And the sessions Map entry was deleted (no stale runtime).
  assert.strictEqual(sessionsMap.size, 0, "sessions Map entry deleted");
});

main().catch((e) => { console.error(e); process.exit(1); });
