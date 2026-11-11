/**
 * session-resilience.test.ts — S2 (resilience plan): dead-Session self-healing.
 *
 * Covers the S2 required automated coverage:
 *   T1  dead runtime + next user message → governed recovery + one replay;
 *   T2  three concurrent sends during recovery → one recovery, FIFO delivery;
 *   T3  undelivered buffered record replayed; dispatched in-flight record
 *       NOT replayed (at-most-once) + visible interruption error;
 *   T4  old-generation late event ignored (no pollution of the new run);
 *   T5  user stop invalidates an in-flight recovery (no zombie runtime);
 *   T6  suspended org / quota denial → no ensureRuntime, durable visible error;
 *   T7  per-user and per-org rebuild rate-limit denial;
 *   T8  local runtime death parity (stream-end fires the death signal);
 *   T9  per-key in-flight ensure dedup + stop closes a late in-flight result.
 *   T10 (rev) serialized user_turn dispatch → events linked to their own runIds;
 *   T11 (rev) queued-but-undispatched turn replays with NO false interruption error;
 *   T12 (rev) initial ensure pending → queue and wait (no false dead-runtime recovery).
 *   T13 (rev2) initial-pending listener consumes the installed runtime's events;
 *   T14 (rev2) dispatch throw + recovery rejection → no dangling 'running' run;
 *   T15 (rev2) turn-local command state follows the dispatched record.
 *   T16 (rev3) initial-ensure rejection + recovery SUCCESS → no durable error.
 *   T17 (rev3) initial-ensure rejection + recovery FAILURE → exactly ONE error.
 *   T18 (rev3) standalone legacy A2UI submit is a user turn (terminal ownership).
 *   T19 (rev3) auto-compact control turn serializes queue advancement.
 *   T20 (rev3) widget_context emitted at dispatch with the minted runId.
 *   T21 (rev4) compact control dies with the runtime → gates reset, B/C in order, no /compact replay.
 *   T22 (rev4) compact_boundary is audit-only — no early dispatch before the compact result.
 *   T23 (rev4) a direct send during compact control QUEUES (no direct dispatch).
 *   T24 (rev4) stream error after death → exactly ONE durable error.
 *
 * Run: DB_PATH=/tmp/s2-resilience.db JWT_SECRET=test npx tsx server/session-resilience.test.ts
 */

import assert from "node:assert/strict";
import { Session } from "./session.js";
import { chatStore } from "./chat-store.js";
import { eventStore } from "./event-store.js";
import db from "./database.js";
import { DEFAULT_ORG_ID } from "./request-context.js";
import { createGovernedRecovery } from "./runtime-recovery.js";
import { RebuildRateLimiter, RebuildRateLimitError } from "./rebuild-rate-limiter.js";
import { ContainerManager } from "./container-manager.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  RuntimeEvent,
  RuntimeStatus,
} from "./agent-runtime.js";
import type { CapabilityBundle } from "./capability-provider.js";

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ─── Fake runtime: controllable death + delivery recording ────────────
// Mirrors DockerAgentRuntime's death contract (idempotent listener fire,
// immediate fire on late registration) while keeping the event stream open
// after death — exactly the "half-dead predecessor still draining" case T4
// needs.
class FakeRT implements AgentRuntime {
  sent: string[] = [];
  closed = false;
  private status: RuntimeStatus = "running";
  private deathListener: ((reason: string) => void) | null = null;
  private deathNotified = false;
  private queue: RuntimeEvent[] = [];
  private wake: (() => void) | null = null;
  private streamError: Error | null = null;

  setDeathListener(listener: (reason: string) => void): void {
    this.deathListener = listener;
    if (this.deathNotified) listener("already_dead");
  }
  private notify(reason: string) {
    if (this.deathNotified) return;
    this.deathNotified = true;
    this.deathListener?.(reason);
  }

  sendMessage(content: string): void {
    if (this.status !== "running" && this.status !== "starting") {
      throw new Error("Agent runtime unreachable: container IPC not connected");
    }
    this.sent.push(content);
  }
  handleApprovalResponse(): boolean {
    return false;
  }
  abort(): void {
    this.status = "stopping";
    this.notify("aborted");
  }
  close(): void {
    this.status = "removed";
    this.closed = true;
    this.wake?.();
    this.wake = null;
    this.notify("closed");
  }
  getStatus(): RuntimeStatus {
    return this.status;
  }
  async *getEventStream(): AsyncIterable<RuntimeEvent> {
    while (!this.closed) {
      // S2 rev4 (T24): injected stream failure throws INTO the consumer loop.
      if (this.streamError) {
        const e = this.streamError;
        this.streamError = null;
        throw e;
      }
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }
  /** T24: make the in-flight event stream throw (after a death notice). */
  failStream(err: Error): void {
    this.streamError = err;
    this.wake?.();
    this.wake = null;
  }
  /** Simulate a docker WS-close-style death: dead, stream still open. */
  die(reason = "ws_closed"): void {
    this.status = "crashed";
    this.notify(reason);
  }
  /** Simulate the LOCAL runtime's death: the SDK stream itself ends and the
   * death listener fires from the stream's finalization (production wiring in
   * LocalAgentRuntime.getEventStream). */
  endStream(reason = "local_sdk_stream_ended"): void {
    this.status = "crashed";
    this.notify(reason);
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }
  pushEvent(event: RuntimeEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }
}

// ─── Harness ───────────────────────────────────────────────────────────

interface HarnessOpts {
  recovery?: (opts: AgentRuntimeOptions) => Promise<AgentRuntime>;
}

async function makeHarness(tag: string, opts: HarnessOpts = {}) {
  const userId = `s2-${tag}-user`;
  const chat = chatStore.createChat(userId, `S2 ${tag}`, DEFAULT_ORG_ID);
  const chatId = chat.id;
  let rt: FakeRT | undefined;
  const factory = (fopts?: AgentRuntimeOptions) => {
    rt = new FakeRT();
    void fopts;
    return rt;
  };
  const session = new Session(chatId, factory, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    ...(opts.recovery ? { recovery: opts.recovery } : {}),
  });
  session.setUserId(userId);
  await flush();
  return { session, rt: rt!, userId, chatId };
}

function messagesOf(userId: string, chatId: string) {
  return chatStore.getMessages(chatId);
}

function systemErrors(userId: string, chatId: string): string[] {
  return messagesOf(userId, chatId)
    .filter((m: any) => m.role === "system" && m.isError)
    .map((m: any) => m.content as string);
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await flush(5);
  }
  throw new Error("timeout waiting for condition");
}

function eventsOfType(userId: string, chatId: string, type: string) {
  return eventStore
    .getEventsByChat(userId, chatId)
    .filter((e) => e.eventType === type)
    .map((e) => JSON.parse(e.payloadJson));
}

const makeFakeBundle = (): CapabilityBundle =>
  ({ sdkOptions: { tools: ["Read"], allowedTools: ["Read"] } } as unknown as CapabilityBundle);

// ─── T1: dead runtime + next user message → recovery + ONE replay ──────
{
  let recoveryCalls = 0;
  const { session, rt: rt1, userId, chatId } = await makeHarness("t1", {
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });

  rt1.die();
  session.sendMessage("hello after death");
  await waitUntil(() => recoveryCalls === 1);
  await flush();

  assert.equal(recoveryCalls, 1, "T1: exactly one governed recovery");
  const dead = eventsOfType(userId, chatId, "runtime_dead");
  assert.equal(dead.length, 1, "T1: runtime_dead audit event recorded");
  assert.equal(dead[0].reason, "ws_closed");
  const recovered = eventsOfType(userId, chatId, "runtime_recovered");
  assert.equal(recovered.length, 1, "T1: runtime_recovered audit event recorded");
  // ONE replay: the post-death message reached the NEW runtime exactly once.
  const newRt = (session as any).runtime as FakeRT;
  assert.deepEqual(newRt.sent, ["hello after death"], "T1: message replayed exactly once to the new runtime");
  assert.ok(!rt1.sent.includes("hello after death"), "T1: old (dead) runtime never received it");
  session.close();
  console.log("✓ T1 dead runtime + next message → one governed recovery + one replay");
}

// ─── T2: three concurrent sends during recovery → one recovery, FIFO ───
{
  let recoveryCalls = 0;
  let releaseRecovery!: (rt: FakeRT) => void;
  const recovery = () =>
    new Promise<AgentRuntime>((res) => {
      recoveryCalls++;
      releaseRecovery = res as unknown as (rt: FakeRT) => void;
    });
  const { session, rt: rt1 } = await makeHarness("t2", { recovery });

  rt1.die();
  session.sendMessage("m1");
  session.sendMessage("m2");
  session.sendMessage("m3");
  await flush();
  assert.equal(recoveryCalls, 1, "T2: three concurrent sends → ONE recovery (deduped)");

  const rt2 = new FakeRT();
  releaseRecovery(rt2);
  // S2 rev (Codex P1): serialized dispatch — m1 delivers first; m2/m3 wait
  // for m1's result frame, then advance one at a time. FIFO order intact.
  await waitUntil(() => rt2.sent.length === 1);
  assert.deepEqual(rt2.sent, ["m1"], "T2: only m1 dispatched before its result");
  rt2.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => rt2.sent.length === 2);
  assert.deepEqual(rt2.sent, ["m1", "m2"], "T2: m2 dispatched after m1's result");
  rt2.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => rt2.sent.length === 3);
  assert.deepEqual(rt2.sent, ["m1", "m2", "m3"], "T2: FIFO delivery, one turn at a time");
  rt2.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await flush();
  assert.ok(rt2.sent.length === 3, "T2: no duplicate deliveries");
  session.close();
  console.log("✓ T2 three concurrent sends during recovery → one recovery, serialized FIFO delivery");
}

// ─── T3: buffered record replayed; in-flight record NOT replayed ───────
{
  let recoveryCalls = 0;
  const { session, rt: rt1, userId, chatId } = await makeHarness("t3", {
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });

  // "first" IS dispatched (in-flight, unconfirmed) before the death.
  session.sendMessage("first");
  assert.deepEqual(rt1.sent, ["first"], "T3: first message dispatched pre-death");
  rt1.die(); // death mid-turn: in-flight turn can never complete
  await waitUntil(() => systemErrors(userId, chatId).some((c) => c.includes("本轮回复未完成")));
  // Visible interruption error persisted (S1 durable path).
  assert.ok(
    systemErrors(userId, chatId).some((c) => c.includes("本轮回复未完成")),
    "T3: in-flight turn surfaced a durable interruption error"
  );

  // "second" is buffered AFTER the death → replayable.
  session.sendMessage("second");
  await waitUntil(() => recoveryCalls === 1);
  await flush();
  const rt2 = (session as any).runtime as FakeRT;
  assert.deepEqual(rt2.sent, ["second"], "T3: only the never-dispatched record was replayed");
  assert.ok(!rt2.sent.includes("first"), "T3: dispatched-but-unconfirmed record NOT replayed (at-most-once)");
  session.close();
  console.log("✓ T3 buffered record replayed; in-flight record not replayed (at-most-once)");
}

// ─── T4: old-generation late event ignored ─────────────────────────────
{
  const { session, rt: rt1, userId, chatId } = await makeHarness("t4", {
    recovery: async () => new FakeRT(),
  });
  session.sendMessage("before");
  await flush();
  rt1.die();
  session.sendMessage("trigger recovery");
  await waitUntil(() => Boolean((session as any).runtime && (session as any).runtime !== rt1));
  const before = messagesOf(userId, chatId).length;

  // The half-dead OLD runtime now emits a late assistant event.
  rt1.pushEvent({ type: "assistant", message: { content: "LATE FROM OLD GENERATION" } });
  await flush(50);
  const polluted = messagesOf(userId, chatId).some(
    (m: any) => (m.content as string)?.includes("LATE FROM OLD GENERATION")
  );
  assert.ok(!polluted, "T4: late event from the old generation was dropped (not persisted/broadcast)");
  assert.equal(messagesOf(userId, chatId).length, before, "T4: message history unchanged by the late event");
  session.close();
  console.log("✓ T4 old-generation late event ignored");
}

// ─── T5: user stop invalidates an in-flight recovery ────────────────────
{
  let recoveryCalls = 0;
  let releaseRecovery!: (rt: FakeRT) => void;
  const recovery = () =>
    new Promise<AgentRuntime>((res) => {
      recoveryCalls++;
      releaseRecovery = res as unknown as (rt: FakeRT) => void;
    });
  const { session, rt: rt1, userId, chatId } = await makeHarness("t5", { recovery });

  rt1.die();
  session.sendMessage("during recovery");
  await waitUntil(() => recoveryCalls === 1);

  // User stops while the rebuild is in flight.
  session.stop();
  const rt2 = new FakeRT();
  releaseRecovery(rt2);
  await flush(50);
  assert.ok(rt2.closed, "T5: stale recovery result was CLOSED, not installed");
  assert.equal(eventsOfType(userId, chatId, "runtime_recovered").length, 0, "T5: no runtime_recovered event");
  assert.equal((session as any).runtime, rt1, "T5: the zombie runtime was never installed");
  assert.ok(eventsOfType(userId, chatId, "runtime_recovery_discarded").length === 1, "T5: discard audited");
  session.close();
  console.log("✓ T5 user stop invalidates in-flight recovery (no zombie runtime)");
}

// ─── T6: suspended org / quota denial → no ensure, durable error ───────
{
  const fakeBundle = makeFakeBundle();
  const mkDeps = (deny: () => void) => ({
    assertOrgActive: deny,
    assertQuota: () => {},
    resolve: () => fakeBundle,
    computeConfigVersion: () => "v-test",
    ensureRuntime: async () => {
      throw new Error("ensureRuntime must NOT be called when governance denies");
    },
    rateLimiter: new RebuildRateLimiter(),
    allowedToolsOverride: null,
  });
  const principal = { userId: "s2-t6-user", chatId: "t6-chat", role: "user" as const, orgId: DEFAULT_ORG_ID };

  // 6a: org suspended (OrgNotActiveError shape).
  {
    const { session, rt, userId, chatId } = await makeHarness("t6a", {
      recovery: createGovernedRecovery(
        principal,
        mkDeps(() => {
          const e = new Error("org suspended");
          (e as any).name = "OrgNotActiveError";
          throw e;
        }),
        "docker"
      ),
    });
    rt.die();
    session.sendMessage("blocked by org gate");
    await waitUntil(() => systemErrors(userId, chatId).length > 0);
    assert.ok(
      systemErrors(userId, chatId).some((c) => c.includes("org_not_active")),
      "T6a: durable visible error names the governance category"
    );
    const failed = eventsOfType(userId, chatId, "runtime_recovery_failed");
    assert.equal(failed.length, 1, "T6a: one recovery-failure audit event");
    assert.equal(failed[0].category, "org_not_active");
    assert.strictEqual((session as any).runtime, rt, "T6a: no new runtime installed");
    session.close();
  }
  // 6b: quota exceeded (QuotaExceededError shape).
  {
    const { session, rt, userId, chatId } = await makeHarness("t6b", {
      recovery: createGovernedRecovery(
        principal,
        mkDeps(() => {
          const e = new Error("concurrent runtimes quota exceeded");
          (e as any).name = "QuotaExceededError";
          throw e;
        }),
        "docker"
      ),
    });
    rt.die();
    session.sendMessage("blocked by quota gate");
    await waitUntil(() => systemErrors(userId, chatId).length > 0);
    const failed = eventsOfType(userId, chatId, "runtime_recovery_failed");
    assert.equal(failed[0].category, "quota_exceeded", "T6b: quota denial categorized");
    session.close();
  }
  console.log("✓ T6 suspended org / quota denial → no ensureRuntime, durable visible error");
}

// ─── T7: rebuild rate-limit denial (per-user and per-org) ──────────────
{
  // 7a: limiter unit contract with an injected clock.
  {
    let t = 1000;
    const limiter = new RebuildRateLimiter({ maxPerUser: 2, maxPerOrg: 3, now: () => t });
    limiter.check("u1", "org1");
    limiter.check("u1", "org1");
    try {
      limiter.check("u1", "org1");
      assert.fail("7a: per-user limit should have thrown");
    } catch (err) {
      assert.ok(err instanceof RebuildRateLimitError, "7a: per-user RebuildRateLimitError");
      assert.equal((err as RebuildRateLimitError).scope, "user", "7a: scope=user");
    }
    // Window slides: 61s later the same user is allowed again.
    t += 61_000;
    limiter.check("u1", "org1"); // org bucket now [t]
    limiter.check("u2", "org1"); // org bucket [t, t] (u2's user bucket is fresh)
    limiter.check("u3", "org1"); // org bucket [t, t, t] — at maxPerOrg
    try {
      limiter.check("u4", "org1"); // u4's user bucket is fresh — only ORG can deny
      assert.fail("7a: per-org limit should have thrown");
    } catch (err) {
      assert.ok(err instanceof RebuildRateLimitError, "7a: per-org RebuildRateLimitError");
      assert.equal((err as RebuildRateLimitError).scope, "org", "7a: scope=org");
    }
  }
  // 7b: denial flows through the governed recovery → S1 durable error + audit.
  {
    let t = 0;
    let ensureCalls = 0;
    const recovery = createGovernedRecovery(
      { userId: "s2-t7-user", chatId: "t7-chat", role: "user", orgId: DEFAULT_ORG_ID },
      {
        assertOrgActive: () => {},
        assertQuota: () => {},
        resolve: () => makeFakeBundle(),
        computeConfigVersion: () => "v-test",
        ensureRuntime: async () => {
          ensureCalls++;
          return new FakeRT();
        },
        rateLimiter: new RebuildRateLimiter({ maxPerUser: 1, maxPerOrg: 5, now: () => t }),
        allowedToolsOverride: null,
      },
      "docker"
    );
    const { session, rt: rt1, userId, chatId } = await makeHarness("t7b", { recovery });
    rt1.die();
    session.sendMessage("first rebuild allowed");
    await waitUntil(() => Boolean((session as any).runtime && (session as any).runtime !== rt1));
    assert.equal(ensureCalls, 1, "7b: first rebuild passed the limiter");

    // Second death within the window → denied.
    const rt2 = (session as any).runtime as FakeRT;
    rt2.die();
    session.sendMessage("second rebuild denied");
    await waitUntil(() => systemErrors(userId, chatId).some((c) => c.includes("rebuild_rate_limited")));
    assert.equal(ensureCalls, 1, "7b: ensureRuntime NOT called after the rate-limit denial");
    const failed = eventsOfType(userId, chatId, "runtime_recovery_failed");
    assert.ok(
      failed.some((f) => f.category === "rebuild_rate_limited"),
      "7b: rate-limit denial audited with category"
    );
    session.close();
  }
  console.log("✓ T7 per-user and per-org rebuild rate-limit denial");
}

// ─── T8: local runtime death parity ─────────────────────────────────────
{
  let recoveryCalls = 0;
  const { session, rt: rt1, userId, chatId } = await makeHarness("t8", {
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });
  session.sendMessage("turn in flight");
  await flush();
  assert.deepEqual(rt1.sent, ["turn in flight"], "T8: turn dispatched to the local runtime");

  // LOCAL death shape: the SDK stream ENDS and the death listener fires from
  // the stream finalization (production wiring: LocalAgentRuntime.getEventStream).
  rt1.endStream();
  await waitUntil(() => eventsOfType(userId, chatId, "runtime_dead").length === 1);
  await flush();
  assert.equal(eventsOfType(userId, chatId, "runtime_dead").length, 1, "T8: death signal fired on stream end");
  assert.ok(
    systemErrors(userId, chatId).some((c) => c.includes("本轮回复未完成")),
    "T8: in-flight turn interrupted with a visible error"
  );

  // Next message → governed recovery (same trigger as docker parity).
  session.sendMessage("after local death");
  await waitUntil(() => recoveryCalls === 1);
  await flush();
  const rt2 = (session as any).runtime as FakeRT;
  assert.deepEqual(rt2.sent, ["after local death"], "T8: post-death message replayed to the rebuilt local runtime");
  assert.ok(!rt2.sent.includes("turn in flight"), "T8: in-flight turn not replayed");
  session.close();
  console.log("✓ T8 local runtime death parity (stream-end fires death → recovery on next message)");
}

// ─── T9: per-key in-flight ensure dedup + stop closes late result ──────
{
  class TestCM extends ContainerManager {
    public ensureCalls = 0;
    public result: FakeRT = new FakeRT();
    public release: (() => void) | null = null;
    protected async doEnsureRuntime(
      _userId: string,
      _chatId: string,
      _options?: AgentRuntimeOptions
    ): Promise<AgentRuntime> {
      this.ensureCalls++;
      if (this.release) {
        await new Promise<void>((r) => {
          this.release = r;
        });
      } else {
        await flush(10);
      }
      return this.result;
    }
  }

  // 9a: concurrent ensures for the same key join ONE execution.
  {
    const cm = new TestCM();
    const p1 = cm.ensureRuntime("u9", "c9");
    const p2 = cm.ensureRuntime("u9", "c9");
    const p3 = cm.ensureRuntime("u9", "c9");
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(cm.ensureCalls, 1, "9a: one doEnsureRuntime execution for concurrent calls");
    assert.strictEqual(r1, r2, "9a: all callers got the same runtime instance");
    assert.strictEqual(r2, r3, "9a: all callers got the same runtime instance (2)");
  }
  // 9b: different keys do NOT dedup.
  {
    const cm = new TestCM();
    await Promise.all([cm.ensureRuntime("u9", "c1"), cm.ensureRuntime("u9", "c2")]);
    assert.equal(cm.ensureCalls, 2, "9b: different keys run independently");
  }
  // 9c: a failed ensure is cleaned up and retryable; joiners share the failure.
  {
    class FailCM extends ContainerManager {
      public calls = 0;
      protected async doEnsureRuntime(): Promise<AgentRuntime> {
        this.calls++;
        throw new Error("docker down");
      }
    }
    const cm = new FailCM();
    const [e1, e2] = await Promise.allSettled([
      cm.ensureRuntime("u9", "cf"),
      cm.ensureRuntime("u9", "cf"),
    ]);
    assert.equal(e1.status, "rejected", "9c: first caller rejected");
    assert.equal(e2.status, "rejected", "9c: joiner rejected with the same failure");
    assert.equal((e1 as PromiseRejectedResult).reason.message, "docker down");
    assert.equal(cm.calls, 1, "9c: the concurrent pair executed doEnsureRuntime ONCE");
    // Map cleaned → the NEXT call retries instead of joining a dead promise.
    await assert.rejects(() => cm.ensureRuntime("u9", "cf"), /docker down/);
    assert.equal(cm.calls, 2, "9c: retry after failure executes doEnsureRuntime again");
  }
  // 9d: stop arriving during an in-flight ensure closes the late result.
  {
    class SlowCM extends ContainerManager {
      public result = new FakeRT();
      public release: (() => void) | null = null;
      protected async doEnsureRuntime(): Promise<AgentRuntime> {
        await new Promise<void>((r) => {
          this.release = r;
        });
        return this.result;
      }
    }
    const cm = new SlowCM();
    const ensure = cm.ensureRuntime("u9", "cs");
    await waitUntil(() => cm.release !== null); // doEnsureRuntime parked
    const stopDone = cm.stopRuntime("u9", "cs", "admin_stop");
    cm.release!();
    await ensure;
    await stopDone;
    assert.ok(cm.result.closed, "9d: late in-flight ensure result was closed by the stop");
  }
  console.log("✓ T9 per-key in-flight ensure dedup + stop closes a late result");
}

// ─── T10 (S2 rev, Codex P1): serialized dispatch → per-run event linkage ─
{
  const { session, rt, userId, chatId } = await makeHarness("t10");
  session.sendMessage("turn A");
  session.sendMessage("turn B");
  await flush();
  assert.deepEqual(rt.sent, ["turn A"], "T10: only the FIRST turn dispatched before its result");

  rt.pushEvent({ type: "assistant", message: { content: "answer A" } } as RuntimeEvent);
  rt.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => rt.sent.length === 2);
  assert.deepEqual(rt.sent, ["turn A", "turn B"], "T10: turn B dispatched only after turn A's result");

  rt.pushEvent({ type: "assistant", message: { content: "answer B" } } as RuntimeEvent);
  rt.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await flush();

  // Per-run audit linkage: each turn's assistant_message + result events are
  // stamped with THAT turn's runId (the Codex-reproduced P1 failure stamped
  // everything with the latest scalar currentRunId, leaving run 1 with zero
  // linked events).
  const all = eventStore.getEventsByChat(userId, chatId).filter((e) => e.runId);
  const runIds = [...new Set(all.map((e) => e.runId!))];
  assert.equal(runIds.length, 2, "T10: exactly two runs linked to events");
  const eventsOf = (runId: string) => all.filter((e) => e.runId === runId).map((e) => e.eventType);
  const runA = eventsOf(runIds[0]);
  const runB = eventsOf(runIds[1]);
  assert.ok(runA.includes("assistant_message") && runA.includes("result"), "T10: run 1 has its own assistant+result events");
  assert.ok(runB.includes("assistant_message") && runB.includes("result"), "T10: run 2 has its own assistant+result events");
  assert.equal(runA.filter((t) => t === "assistant_message").length, 1, "T10: run 1 has exactly one assistant event");
  assert.equal(runB.filter((t) => t === "assistant_message").length, 1, "T10: run 2 has exactly one assistant event");
  // Both runs finalized (no 'running' leftovers).
  session.close();
  console.log("✓ T10 serialized dispatch → events linked to their own runIds");
}

// ─── T11 (S2 rev, Codex P2): queued turn replays without false interruption ─
{
  let recoveryCalls = 0;
  const { session, rt: rt1, userId, chatId } = await makeHarness("t11", {
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });
  // Death BEFORE the message: no dispatched turn exists, so the death
  // cleanup must NOT produce a durable interruption error for the turn that
  // has not even been sent yet (the Codex-reproduced P2 sequence).
  rt1.die();
  session.sendMessage("queued while dead");
  await waitUntil(() => recoveryCalls === 1);
  await flush();
  assert.equal(recoveryCalls, 1, "T11: one governed recovery");
  const newRt = (session as any).runtime as FakeRT;
  assert.deepEqual(newRt.sent, ["queued while dead"], "T11: queued turn replayed exactly once");
  assert.equal(systemErrors(userId, chatId).length, 0, "T11: NO durable interruption error for a never-dispatched turn");
  // The replayed turn completes normally: exactly one result.
  newRt.pushEvent({ type: "assistant", message: { content: "recovered answer" } } as RuntimeEvent);
  newRt.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await flush();
  const results = eventsOfType(userId, chatId, "result");
  assert.equal(results.length, 1, "T11: exactly one result for the replayed turn");
  assert.equal(systemErrors(userId, chatId).length, 0, "T11: still no interruption error after completion");
  session.close();
  console.log("✓ T11 queued-but-undispatched turn → replay, no false interruption error");
}

// ─── T12 (S2 rev, Codex P3): initial ensure pending ≠ dead runtime ──────
{
  let recoveryCalls = 0;
  const userId = "s2-t12-user";
  const chat = chatStore.createChat(userId, "S2 t12", DEFAULT_ORG_ID);
  const chatId = chat.id;
  let releaseEnsure!: (rt: FakeRT) => void;
  const ensurePromise = new Promise<AgentRuntime>((res) => {
    releaseEnsure = res as unknown as (rt: FakeRT) => void;
  });
  const session = new Session(chatId, ensurePromise, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });
  session.setUserId(userId);
  // Message arrives while the INITIAL ensure is still pending.
  session.sendMessage("during initial ensure");
  await flush();
  assert.equal(recoveryCalls, 0, "T12: NO governed recovery while the initial ensure is pending");
  assert.equal((session as any).initialEnsurePending, true, "T12: pending flag set");
  const rt = new FakeRT();
  releaseEnsure(rt);
  await waitUntil(() => rt.sent.length === 1);
  assert.deepEqual(rt.sent, ["during initial ensure"], "T12: message dispatched once the initial ensure resolves");
  assert.equal(recoveryCalls, 0, "T12: recovery STILL not called (no wasted rebuild token / double resolve)");
  assert.equal((session as any).runtimeGeneration, 1, "T12: exactly ONE runtime install (one generation)");
  assert.equal(eventsOfType(userId, chatId, "runtime_recovered").length, 0, "T12: no recovery events");
  assert.equal(eventsOfType(userId, chatId, "runtime_dead").length, 0, "T12: no death events");
  session.close();
  console.log("✓ T12 initial ensure pending → queue and wait, no false recovery");
}

// ─── T13 (S2 rev2, Codex fix 1): initial-pending listener consumes events ─
{
  let recoveryCalls = 0;
  const userId = "s2-t13-user";
  const chat = chatStore.createChat(userId, "S2 t13", DEFAULT_ORG_ID);
  const chatId = chat.id;
  let releaseEnsure!: (rt: FakeRT) => void;
  const ensurePromise = new Promise<AgentRuntime>((res) => {
    releaseEnsure = res as unknown as (rt: FakeRT) => void;
  });
  const session = new Session(chatId, ensurePromise, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });
  session.setUserId(userId);
  // Send while the initial ensure is pending, then resolve the runtime. The
  // listener started at send time must serve the INSTALLED runtime (the old
  // pre-captured generation check exited on the install's own bump and left
  // the container's events unconsumed).
  session.sendMessage("during initial ensure");
  const rt = new FakeRT();
  releaseEnsure(rt);
  await waitUntil(() => rt.sent.length === 1);
  rt.pushEvent({ type: "assistant", message: { content: "answer from first runtime" } } as RuntimeEvent);
  rt.pushEvent({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 1 } as RuntimeEvent);
  await flush();

  const texts = messagesOf(userId, chatId).map((m: any) => m.content as string);
  assert.ok(texts.includes("answer from first runtime"), "T13: assistant event was CONSUMED and persisted");
  const linked = eventStore.getEventsByChat(userId, chatId).filter((e) => e.runId);
  assert.ok(linked.some((e) => e.eventType === "result"), "T13: result event linked to a runId");
  const running = db
    .prepare(`SELECT COUNT(*) as c FROM agent_runs WHERE chat_id = ? AND status = 'running'`)
    .get(chatId) as { c: number };
  assert.equal(running.c, 0, "T13: no run left 'running' — the consumed result finalized it");
  assert.equal((session as any).runtimeGeneration, 1, "T13: exactly ONE install/generation");
  assert.equal(recoveryCalls, 0, "T13: recovery still never called (INV-5 intact)");
  assert.equal((session as any).isListening, true, "T13: exactly one listener still serving the long-lived stream");
  session.close();
  console.log("✓ T13 initial-pending listener serves the installed runtime (events consumed, run finalized)");
}

// ─── T14 (S2 rev2, Codex fix 2): dispatch throw leaves no 'running' run ──
{
  const userId = "s2-t14-user";
  const chat = chatStore.createChat(userId, "S2 t14", DEFAULT_ORG_ID);
  const chatId = chat.id;
  class ThrowingRT extends FakeRT {
    sendMessage(): void {
      throw new Error("Agent runtime unreachable: container IPC not connected");
    }
  }
  const rt = new ThrowingRT();
  const session = new Session(chatId, () => rt, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    recovery: async () => {
      throw new Error("org suspended");
    },
  });
  session.setUserId(userId);
  await flush();
  session.sendMessage("will throw");
  await flush();
  // Delivery threw + recovery rejected: exactly one visible error, no
  // active/queued records, and NO dangling 'running' run row.
  assert.equal(systemErrors(userId, chatId).length, 1, "T14: exactly one visible error (recovery rejection)");
  assert.equal((session as any).queuedRecords.length, 0, "T14: zero queued records");
  assert.equal((session as any).activeRecords.length, 0, "T14: zero active records");
  const running = db
    .prepare(`SELECT COUNT(*) as c FROM agent_runs WHERE chat_id = ? AND status = 'running'`)
    .get(chatId) as { c: number };
  assert.equal(running.c, 0, "T14: no 'running' run row remains (mint happens only after send succeeds)");
  session.close();
  console.log("✓ T14 dispatch throw + recovery rejection → one error, no records, no dangling run");
}

// ─── T15 (S2 rev2, Codex fix 3): command state follows dispatched record ─
{
  const { session, rt, userId, chatId } = await makeHarness("t15");
  session.sendMessage("normal turn A");
  session.sendMessage("/compact");
  await flush();
  assert.deepEqual(rt.sent, ["normal turn A"], "T15: A dispatched; the queued /compact waits");
  assert.equal((session as any).currentTurnIsCommand, false, "T15: active turn A is NOT a command turn");
  // A's result renders as a normal assistant turn.
  rt.pushEvent({ type: "assistant", message: { content: "answer A" } } as RuntimeEvent);
  rt.pushEvent({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 1 } as RuntimeEvent);
  await waitUntil(() => rt.sent.length === 2);
  assert.deepEqual(rt.sent, ["normal turn A", "/compact"], "T15: /compact dispatched after A's result");
  assert.equal((session as any).currentTurnIsCommand, true, "T15: command flag flipped at /compact DISPATCH");
  // B's result text renders as a command result (broadcast), NOT as a
  // persisted assistant message.
  rt.pushEvent({ type: "result", subtype: "success", result: "compact output", total_cost_usd: 0, duration_ms: 1 } as RuntimeEvent);
  await flush();
  const texts = messagesOf(userId, chatId).map((m: any) => m.content as string);
  assert.ok(texts.includes("answer A"), "T15: A's result text persisted as an assistant message (normal rendering)");
  assert.ok(!texts.includes("compact output"), "T15: B's result text NOT persisted as chat (command_result rendering)");
  session.close();
  console.log("✓ T15 turn-local command state follows the dispatched record, not the queued send");
}

// ─── T16 (S2 rev3, Codex INV-A): initial rejection + recovery success ────
{
  const userId = "s2-t16-user";
  const chat = chatStore.createChat(userId, "S2 t16", DEFAULT_ORG_ID);
  const chatId = chat.id;
  let recoveryCalls = 0;
  const session = new Session(
    chatId,
    Promise.reject(new Error("initial ensure rejected")),
    undefined,
    userId,
    {
      role: "user",
      orgId: DEFAULT_ORG_ID,
      recovery: async () => {
        recoveryCalls++;
        return new FakeRT();
      },
    }
  );
  session.setUserId(userId);
  await flush();
  session.sendMessage("after initial rejection");
  await waitUntil(() => recoveryCalls === 1);
  await flush();
  const rt2 = (session as any).runtime as FakeRT;
  assert.deepEqual(rt2.sent, ["after initial rejection"], "T16: message replayed after successful recovery");
  assert.equal(systemErrors(userId, chatId).length, 0, "T16: NO durable error — initial rejection was transient (INV-A)");
  assert.equal(eventsOfType(userId, chatId, "runtime_recovery_failed").length, 0, "T16: no recovery-failure audit");
  session.close();
  console.log("✓ T16 initial-ensure rejection + recovery success → no durable error");
}

// ─── T17 (S2 rev3, Codex INV-A): initial rejection + recovery failure ────
{
  const userId = "s2-t17-user";
  const chat = chatStore.createChat(userId, "S2 t17", DEFAULT_ORG_ID);
  const chatId = chat.id;
  const session = new Session(
    chatId,
    Promise.reject(new Error("initial ensure rejected")),
    undefined,
    userId,
    {
      role: "user",
      orgId: DEFAULT_ORG_ID,
      recovery: async () => {
        throw new Error("org suspended");
      },
    }
  );
  session.setUserId(userId);
  await flush();
  session.sendMessage("trigger recovery failure");
  await waitUntil(() => systemErrors(userId, chatId).length > 0);
  assert.equal(
    systemErrors(userId, chatId).length,
    1,
    "T17: exactly ONE durable error — the recovery failure owns the outcome (INV-A)"
  );
  session.close();
  console.log("✓ T17 initial-ensure rejection + recovery failure → exactly one durable error");
}

// ─── T18 (S2 rev3, Codex INV-B): standalone A2UI submit has terminal ownership ─
{
  // 18a: dispatched-then-died → visible interruption + run stopped, never replayed.
  {
    let recoveryCalls = 0;
    const { session, rt: rt1, userId, chatId } = await makeHarness("t18a", {
      recovery: async () => {
        recoveryCalls++;
        return new FakeRT();
      },
    });
    session.handleA2UISubmit({
      blockId: "legacy-1",
      actionId: "confirm",
      actionLabel: "确认",
      values: { q: "a" },
    });
    await flush();
    assert.equal(rt1.sent.length, 1, "T18a: standalone submit dispatched as a user turn");
    assert.ok(rt1.sent[0].includes("[A2UI 提交]"), "T18a: submit content delivered");
    const runningRows = db
      .prepare(`SELECT id FROM agent_runs WHERE chat_id = ? AND status = 'running'`)
      .all(chatId) as Array<{ id: string }>;
    assert.equal(runningRows.length, 1, "T18a: the submit turn minted its own run");
    const submitRunId = runningRows[0].id;
    rt1.die();
    await waitUntil(() => systemErrors(userId, chatId).some((c) => c.includes("本轮回复未完成")));
    const stopped = db
      .prepare(`SELECT status FROM agent_runs WHERE id = ?`)
      .get(submitRunId) as { status: string } | undefined;
    assert.equal(stopped?.status, "stopped", "T18a: dispatched-unconfirmed submit run marked stopped");
    session.sendMessage("next after submit death");
    await waitUntil(() => recoveryCalls === 1);
    await flush();
    const rt2 = (session as any).runtime as FakeRT;
    assert.deepEqual(
      rt2.sent,
      ["next after submit death"],
      "T18a: dispatched submit NOT replayed (at-most-once); the new message delivered"
    );
    session.close();
  }
  // 18b: never dispatched (queued while dead) → triggers recovery, replayed once.
  {
    let recoveryCalls = 0;
    const { session, rt: rt1, userId, chatId } = await makeHarness("t18b", {
      recovery: async () => {
        recoveryCalls++;
        return new FakeRT();
      },
    });
    rt1.die();
    session.handleA2UISubmit({
      blockId: "legacy-2",
      actionId: "confirm",
      actionLabel: "确认",
      values: { q: "b" },
    });
    await waitUntil(() => recoveryCalls === 1);
    await flush();
    const rt2 = (session as any).runtime as FakeRT;
    assert.equal(rt2.sent.length, 1, "T18b: never-dispatched submit triggered recovery and replayed exactly once");
    assert.ok(rt2.sent[0].includes("[A2UI 提交]"), "T18b: submit content replayed");
    assert.equal(systemErrors(userId, chatId).length, 0, "T18b: no false interruption for a never-dispatched submit");
    session.close();
  }
  console.log("✓ T18 standalone legacy A2UI submit → user turn with terminal ownership");
}

// ─── T19 (S2 rev3, Codex INV-C): auto-compact serializes queue advancement ─
{
  const { session, rt, userId, chatId } = await makeHarness("t19");
  // Low org threshold so A's usage crosses it (org overlay, narrow-only band).
  db.prepare(
    `INSERT OR REPLACE INTO org_compact_policy (org_id, enabled, threshold_tokens, keep_recent_turns, updated_at)
     VALUES (?, 1, 1000, 1, datetime('now'))`
  ).run(DEFAULT_ORG_ID);
  session.sendMessage("A high usage");
  session.sendMessage("B queued");
  await flush();
  assert.deepEqual(rt.sent, ["A high usage"], "T19: A dispatched; B queued behind it");

  // A's result carries usage above the threshold → auto-compact fires in the
  // SAME result handler. B must NOT dispatch there.
  rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "answer A",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 5000, output_tokens: 10 },
  } as RuntimeEvent);
  await flush();
  assert.deepEqual(rt.sent, ["A high usage", "/compact"], "T19: compact control turn sent after A's result");
  assert.ok(!rt.sent.includes("B queued"), "T19: queued B NOT dispatched in the handler that sent /compact");

  // compact_boundary arrives (releases the in-flight gate), then the compact
  // control turn's own result completes — only then does B dispatch.
  rt.pushEvent({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { pre_tokens: 5000, post_tokens: 500, trigger: "auto" },
  } as RuntimeEvent);
  await flush();
  assert.ok(!rt.sent.includes("B queued"), "T19: B still not dispatched before the compact result (boundary alone does not advance while a flush trigger is pending)");
  rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "compact done",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 100, output_tokens: 1 },
  } as RuntimeEvent);
  await waitUntil(() => rt.sent.includes("B queued"));
  assert.deepEqual(
    rt.sent,
    ["A high usage", "/compact", "B queued"],
    "T19: B dispatched only AFTER the compact control turn completed"
  );

  // Compact result is run-unlinked and never finalized B's run: B's run is
  // still open here, and is finalized by B's OWN result below.
  const resultRows = eventStore
    .getEventsByChat(userId, chatId)
    .filter((e) => e.eventType === "result");
  assert.equal(resultRows.length, 2, "T19: A result + compact result recorded");
  assert.equal(
    resultRows.filter((e) => !e.runId).length,
    1,
    "T19: the compact control turn's result is run-UNLINKED"
  );
  const bRun = db
    .prepare(`SELECT id FROM agent_runs WHERE chat_id = ? AND status = 'running'`)
    .all(chatId) as Array<{ id: string }>;
  assert.equal(bRun.length, 1, "T19: B's run still open — compact result did not consume/finalize it");
  rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "answer B",
    total_cost_usd: 0,
    duration_ms: 1,
  } as RuntimeEvent);
  await flush();
  const stillRunning = db
    .prepare(`SELECT COUNT(*) as c FROM agent_runs WHERE chat_id = ? AND status = 'running'`)
    .get(chatId) as { c: number };
  assert.equal(stillRunning.c, 0, "T19: B's run finalized by B's own result");
  session.close();
  console.log("✓ T19 auto-compact control turn → serialized queue advancement, run-unlinked result");
}

// ─── T20 (S2 rev3, Codex INV-D): widget_context at dispatch with runId ───
{
  // Parked recovery so the queued window is observable before dispatch.
  let releaseRecovery!: (rt: FakeRT) => void;
  const recovery = () =>
    new Promise<AgentRuntime>((res) => {
      releaseRecovery = res as unknown as (rt: FakeRT) => void;
    });
  const { session, rt: rt1, userId, chatId } = await makeHarness("t20", { recovery });
  rt1.die();
  // Queued behind a dead runtime: no early widget_context with runId:null.
  session.sendMessage("queued with widget ctx", {
    pageSessionId: "ps-1",
    pageContext: { url: "https://x/app", title: "App" },
  });
  await flush();
  assert.equal(
    eventsOfType(userId, chatId, "widget_context").length,
    0,
    "T20: NO early widget_context while the turn is queued"
  );
  releaseRecovery(new FakeRT());
  await waitUntil(() => eventsOfType(userId, chatId, "widget_context").length === 1);
  const rt2 = (session as any).runtime as FakeRT;
  assert.equal(rt2.sent.length, 1, "T20: turn dispatched after recovery");
  const wcRows = eventStore
    .getEventsByChat(userId, chatId)
    .filter((e) => e.eventType === "widget_context");
  assert.equal(wcRows.length, 1, "T20: widget_context emitted exactly once at dispatch");
  assert.ok(Boolean(wcRows[0]?.runId), "T20: widget_context linked to the turn's MINTED runId (INV-D)");
  session.close();
  console.log("✓ T20 widget_context emitted at dispatch with the minted runId");
}

// ─── shared: enable a low org compaction threshold for the round-4 tests ──
const setLowCompactThreshold = () =>
  db
    .prepare(
      `INSERT OR REPLACE INTO org_compact_policy (org_id, enabled, threshold_tokens, keep_recent_turns, updated_at)
       VALUES (?, 1, 1000, 1, datetime('now'))`
    )
    .run(DEFAULT_ORG_ID);

// ─── T21 (S2 rev4): compact control dies with the runtime ────────────────
{
  setLowCompactThreshold();
  let recoveryCalls = 0;
  const { session, rt: rt1, userId, chatId } = await makeHarness("t21", {
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });
  session.sendMessage("A high usage");
  session.sendMessage("B queued");
  await flush();
  rt1.pushEvent({
    type: "result",
    subtype: "success",
    result: "answer A",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 5000, output_tokens: 10 },
  } as RuntimeEvent);
  await flush();
  assert.deepEqual(rt1.sent, ["A high usage", "/compact"], "T21: compact control turn in flight");
  // Runtime dies mid-compaction; C arrives and triggers governed recovery.
  rt1.die();
  session.sendMessage("C after death");
  await waitUntil(() => recoveryCalls === 1);
  await flush();
  // Compact gates terminalized by the death.
  assert.equal((session as any).autoCompactInFlight, false, "T21: compact control gate reset on death");
  assert.equal((session as any).awaitingAutoCompactResult, false, "T21: awaiting gate reset on death");
  assert.ok(
    eventsOfType(userId, chatId, "auto_compact_interrupted").length === 1,
    "T21: metadata-only interrupted-compact audit recorded"
  );
  const rt2 = (session as any).runtime as FakeRT;
  // B dispatches first (FIFO), C waits for B's result; /compact is NOT replayed.
  await waitUntil(() => rt2.sent.length === 1);
  assert.equal(rt2.sent[0], "B queued", "T21: B dispatched first after recovery");
  assert.ok(!rt2.sent.includes("/compact"), "T21: /compact NOT replayed");
  rt2.pushEvent({ type: "result", subtype: "success", result: "answer B", total_cost_usd: 0, duration_ms: 1 } as RuntimeEvent);
  await waitUntil(() => rt2.sent.includes("C after death"));
  assert.deepEqual(
    rt2.sent,
    ["B queued", "C after death"],
    "T21: B then C in order, serialized"
  );
  session.close();
  console.log("✓ T21 compact death → gates reset, B/C in order, /compact not replayed");
}

// ─── T22 (S2 rev4): compact_boundary is audit-only (no queue release) ────
{
  setLowCompactThreshold();
  const { session, rt, userId, chatId } = await makeHarness("t22");
  session.sendMessage("A high usage");
  session.sendMessage("B queued");
  await flush();
  rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "answer A",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 5000, output_tokens: 10 },
  } as RuntimeEvent);
  await flush();
  assert.deepEqual(rt.sent, ["A high usage", "/compact"], "T22: compact in flight, B queued");
  // Boundary arrives — audit only, gate stays closed...
  rt.pushEvent({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { pre_tokens: 5000, post_tokens: 500, trigger: "auto" },
  } as RuntimeEvent);
  await flush();
  assert.equal((session as any).autoCompactInFlight, true, "T22: boundary did NOT release the gate");
  // ...and a NEW user send before the compact result also stays queued.
  session.sendMessage("C before compact result");
  await flush();
  assert.deepEqual(
    rt.sent,
    ["A high usage", "/compact"],
    "T22: neither B nor the new send dispatched before the compact result"
  );
  // Compact result completes the control turn → queued turns dispatch in order.
  rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "compact done",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 100, output_tokens: 1 },
  } as RuntimeEvent);
  await waitUntil(() => rt.sent.includes("B queued"));
  assert.ok(!rt.sent.includes("C before compact result"), "T22: C waits for B's result (serialized)");
  // Compact result stays run-unlinked and is NOT persisted as B's assistant output.
  const resultRows = eventStore
    .getEventsByChat(userId, chatId)
    .filter((e) => e.eventType === "result");
  assert.equal(
    resultRows.filter((e) => !e.runId).length,
    1,
    "T22: the compact control turn's result is run-UNLINKED"
  );
  const texts = messagesOf(userId, chatId).map((m: any) => m.content as string);
  assert.ok(!texts.includes("compact done"), "T22: compact result not persisted as assistant chat");
  rt.pushEvent({ type: "result", subtype: "success", result: "answer B", total_cost_usd: 0, duration_ms: 1 } as RuntimeEvent);
  await waitUntil(() => rt.sent.includes("C before compact result"));
  assert.deepEqual(
    rt.sent,
    ["A high usage", "/compact", "B queued", "C before compact result"],
    "T22: queued turns dispatched only after the compact result, in FIFO order"
  );
  session.close();
  console.log("✓ T22 compact_boundary audit-only; dispatch only after compact result");
}

// ─── T23 (S2 rev4): a direct send during compact control QUEUES ───────────
{
  setLowCompactThreshold();
  const { session, rt } = await makeHarness("t23");
  session.sendMessage("A high usage");
  await flush();
  rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "answer A",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 5000, output_tokens: 10 },
  } as RuntimeEvent);
  await flush();
  assert.deepEqual(rt.sent, ["A high usage", "/compact"], "T23: compact control began with an EMPTY queue");
  // New send before the compact result: must QUEUE, not direct-dispatch.
  session.sendMessage("direct send during compact");
  await flush();
  assert.ok(
    !rt.sent.includes("direct send during compact"),
    "T23: send during compact control QUEUED (enqueueOrDispatch gated)"
  );
  rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "compact done",
    total_cost_usd: 0,
    duration_ms: 1,
    usage: { input_tokens: 100, output_tokens: 1 },
  } as RuntimeEvent);
  await waitUntil(() => rt.sent.includes("direct send during compact"));
  assert.deepEqual(
    rt.sent,
    ["A high usage", "/compact", "direct send during compact"],
    "T23: queued send dispatched only after the compact result completed"
  );
  session.close();
  console.log("✓ T23 direct send during compact control queues instead of dispatching");
}

// ─── T24 (S2 rev4): stream error after death → ONE durable terminal ──────
{
  const { session, rt, userId, chatId } = await makeHarness("t24");
  session.sendMessage("turn in flight");
  await flush();
  assert.deepEqual(rt.sent, ["turn in flight"], "T24: turn dispatched");
  const runRows = db
    .prepare(`SELECT id FROM agent_runs WHERE chat_id = ? AND status = 'running'`)
    .all(chatId) as Array<{ id: string }>;
  assert.equal(runRows.length, 1, "T24: the turn's run is open");
  const runId = runRows[0].id;
  // Death notification first (finalizeInterruptedTurns: one visible error +
  // run marked stopped), THEN the stream itself throws into the listener.
  rt.die();
  await waitUntil(() => systemErrors(userId, chatId).some((c) => c.includes("本轮回复未完成")));
  rt.failStream(new Error("sdk stream blew up"));
  await flush(50);
  assert.equal(
    systemErrors(userId, chatId).length,
    1,
    "T24: exactly ONE durable error — the post-death stream error was suppressed"
  );
  const runRow = db.prepare(`SELECT status FROM agent_runs WHERE id = ?`).get(runId) as
    | { status: string }
    | undefined;
  assert.equal(runRow?.status, "stopped", "T24: the active turn's run is marked stopped");
  session.close();
  console.log("✓ T24 local stream error after death → single durable terminal error");
}

console.log("\nAll session-resilience (S2) tests passed.");
