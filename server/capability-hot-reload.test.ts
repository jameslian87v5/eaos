/**
 * capability-hot-reload.test.ts — M8g (capability hot reload) unit tests.
 *
 * Turn-boundary voluntary runtime swap on control-plane configVersion drift:
 *   H1  drift at sendMessage → close old runtime + governed recovery (with
 *       captured claudeSessionId as resume) + message dispatched exactly once
 *       to the NEW runtime;
 *   H2  no drift → no swap (same runtime keeps serving);
 *   H3  no probe injected → hot reload disabled, messaging unaffected;
 *   H4  safe-window iron rule: an active or queued turn defers the swap; the
 *       swap fires only at a fully idle result boundary;
 *   H5  probe throws → no swap, no error surfaced, message still dispatches;
 *   H6  no recovery fn → probe present but swap never fires (local-sandbox
 *       branch semantics);
 *   H7  runtime_hot_reload audit is metadata-only (version hashes only).
 *   H9  involuntary (crash) recovery re-syncs the builtConfigVersion
 *       baseline — the result boundary performs ZERO additional swap of the
 *       just-installed runtime (Codex P1 regression);
 *   H10 a stale listener loop's delayed finally must not reject a NEW
 *       generation's pending A2UI card — only its own generation's cards
 *       cancel; the live card survives and resolves on submit (Codex P1
 *       regression).
 *
 * Run: DB_PATH=/tmp/m8g-hot-reload.db JWT_SECRET=test npx tsx server/capability-hot-reload.test.ts
 */

import assert from "node:assert/strict";
import { Session } from "./session.js";
import { chatStore } from "./chat-store.js";
import { eventStore } from "./event-store.js";
import { DEFAULT_ORG_ID } from "./request-context.js";
import type { A2UIBlock } from "./a2ui-types.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  RuntimeEvent,
  RuntimeStatus,
} from "./agent-runtime.js";

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

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

// ─── Fake runtime: mirrors the death contract, records deliveries ──────
class FakeRT implements AgentRuntime {
  sent: string[] = [];
  closed = false;
  private status: RuntimeStatus = "running";
  private deathListener: ((reason: string) => void) | null = null;
  private deathNotified = false;
  private queue: RuntimeEvent[] = [];
  private wake: (() => void) | null = null;

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
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }
  pushEvent(event: RuntimeEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }
}

interface HarnessOpts {
  recovery?: (opts: AgentRuntimeOptions) => Promise<AgentRuntime>;
  configVersionProbe?: () => string;
  reportSessionId?: boolean;
}

async function makeHarness(tag: string, opts: HarnessOpts = {}) {
  const userId = `m8g-${tag}-user`;
  const chat = chatStore.createChat(userId, `M8g ${tag}`, DEFAULT_ORG_ID);
  const chatId = chat.id;
  const runtimes: FakeRT[] = [];
  const factory = (fopts?: AgentRuntimeOptions) => {
    const rt = new FakeRT();
    runtimes.push(rt);
    if (opts.reportSessionId) {
      fopts?.onSessionId?.(`sid-${tag}-${runtimes.length}`);
    }
    return rt;
  };
  const session = new Session(chatId, factory, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    ...(opts.recovery ? { recovery: opts.recovery } : {}),
    ...(opts.configVersionProbe ? { configVersionProbe: opts.configVersionProbe } : {}),
  });
  session.setUserId(userId);
  await flush();
  return { session, rt: runtimes[0]!, runtimes, userId, chatId };
}

// ─── H1: drift at sendMessage → swap + resume + exactly-once delivery ──
{
  let version = "v1";
  let recoveryOpts: AgentRuntimeOptions | null = null;
  const recoveryRts: FakeRT[] = [];
  const { session, rt: rt1, userId, chatId } = await makeHarness("h1", {
    configVersionProbe: () => version,
    reportSessionId: true,
    recovery: async (opts) => {
      recoveryOpts = opts;
      const rt = new FakeRT();
      recoveryRts.push(rt);
      return rt;
    },
  });

  session.sendMessage("turn one");
  rt1.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  // Wait for the turn to be FINALIZED (result frame consumed), not merely
  // dispatched — the swap guard requires a fully idle boundary.
  await waitUntil(() => rt1.sent.length === 1 && (session as any).activeRecords.length === 0);

  version = "v2"; // control plane changed
  session.sendMessage("turn two");
  await waitUntil(() => recoveryRts.length === 1 && recoveryRts[0].sent.length === 1);
  await flush();

  assert.ok(rt1.closed, "H1: old runtime closed by the swap");
  assert.deepEqual(rt1.sent, ["turn one"], "H1: old runtime kept its history only");
  assert.equal((recoveryOpts as any)?.resume, "sid-h1-1", "H1: swap injects the captured claudeSessionId as resume");
  assert.deepEqual(recoveryRts[0].sent, ["turn two"], "H1: message dispatched exactly once to the NEW runtime");
  const hot = eventsOfType(userId, chatId, "runtime_hot_reload");
  assert.equal(hot.length, 1, "H1: one runtime_hot_reload audit event");
  assert.deepEqual(
    Object.keys(hot[0]).sort(),
    ["from", "to"],
    "H1/H7: hot-reload audit is metadata-only (version hashes)"
  );
  assert.equal(hot[0].from, "v1");
  assert.equal(hot[0].to, "v2");
  const recovered = eventsOfType(userId, chatId, "runtime_recovered");
  assert.equal(recovered.length, 1, "H1: recovery installed the new runtime");
  session.close();
  console.log("✓ H1 drift at sendMessage → swap + resume + exactly-once delivery");
}

// ─── H2: no drift → no swap ─────────────────────────────────────────────
{
  const { session, rt: rt1, userId, chatId } = await makeHarness("h2", {
    configVersionProbe: () => "same-version",
    recovery: async () => new FakeRT(),
  });
  session.sendMessage("a");
  rt1.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => rt1.sent.length === 1);
  session.sendMessage("b");
  await waitUntil(() => rt1.sent.length === 2);
  assert.ok(!rt1.closed, "H2: runtime never swapped without drift");
  assert.equal(eventsOfType(userId, chatId, "runtime_hot_reload").length, 0, "H2: no hot-reload event");
  session.close();
  console.log("✓ H2 no drift → same runtime keeps serving");
}

// ─── H3: no probe → hot reload disabled, messaging unaffected ───────────
{
  const { session, rt: rt1, userId, chatId } = await makeHarness("h3", {
    recovery: async () => new FakeRT(),
  });
  session.sendMessage("hello");
  await waitUntil(() => rt1.sent.length === 1);
  assert.ok(!rt1.closed, "H3: no probe → no swap");
  assert.equal(eventsOfType(userId, chatId, "runtime_hot_reload").length, 0, "H3: no hot-reload event");
  session.close();
  console.log("✓ H3 no probe → hot reload disabled, messaging unaffected");
}

// ─── H4: active/queued turn defers; swap only at a fully idle boundary ──
{
  let version = "v1";
  const recoveryRts: FakeRT[] = [];
  const { session, rt: rt1, userId, chatId } = await makeHarness("h4", {
    configVersionProbe: () => version,
    recovery: async () => {
      const rt = new FakeRT();
      recoveryRts.push(rt);
      return rt;
    },
  });

  session.sendMessage("turn A"); // dispatched on v1 (no drift yet) → ACTIVE
  await waitUntil(() => rt1.sent.length === 1);

  version = "v2"; // drift appears while turn A is in flight
  session.sendMessage("turn B"); // maybeHotSwap guard: active turn → queues, no swap
  await flush(30);
  assert.ok(!rt1.closed, "H4: active turn blocks the swap at send entry");
  assert.equal(recoveryRts.length, 0, "H4: no recovery while a turn is active/queued");

  rt1.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent); // A completes → B dispatches
  await waitUntil(() => rt1.sent.length === 2);
  await flush(30);
  assert.ok(!rt1.closed, "H4: queued-then-active B still blocks the boundary swap");

  rt1.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent); // B completes → idle
  await waitUntil(() => rt1.closed && recoveryRts.length === 1);
  assert.equal(
    eventsOfType(userId, chatId, "runtime_hot_reload").length,
    1,
    "H4: swap fired exactly once at the idle boundary"
  );
  assert.equal(rt1.sent.length, 2, "H4: both turns ran on the old runtime (no mid-flight kill)");
  session.close();
  console.log("✓ H4 safe window: active/queued turn defers; swap at idle boundary only");
}

// ─── H5: probe throws → no swap, no user-visible error ──────────────────
{
  let shouldThrow = false;
  const { session, rt: rt1, userId, chatId } = await makeHarness("h5", {
    configVersionProbe: () => {
      if (shouldThrow) throw new Error("control plane read failed");
      return "v1";
    },
    recovery: async () => new FakeRT(),
  });
  session.sendMessage("first");
  await waitUntil(() => rt1.sent.length === 1);
  rt1.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await flush();
  shouldThrow = true;
  session.sendMessage("second");
  await waitUntil(() => rt1.sent.length === 2);
  assert.ok(!rt1.closed, "H5: probe failure must not swap");
  assert.equal(eventsOfType(userId, chatId, "runtime_hot_reload").length, 0, "H5: no hot-reload event");
  session.close();
  console.log("✓ H5 probe throws → no swap, no error, message dispatched");
}

// ─── H6: no recovery fn → probe present, swap never fires ───────────────
{
  let version = "v2"; // drift from construction baseline (v1 probed? no probe at all)
  const { session, rt: rt1, userId, chatId } = await makeHarness("h6", {
    configVersionProbe: () => version,
    // NO recovery injected (local-sandbox semantics)
  });
  session.sendMessage("hello");
  await waitUntil(() => rt1.sent.length === 1);
  assert.ok(!rt1.closed, "H6: without a recovery fn the swap must never fire");
  assert.equal(eventsOfType(userId, chatId, "runtime_hot_reload").length, 0, "H6: no hot-reload event");
  session.close();
  console.log("✓ H6 no recovery fn → swap never fires (messaging unaffected)");
}

// ─── H8: stale teardown error must NOT surface after a swap ─────────────
// The user-visible bug this encodes: LocalAgentRuntime.close() aborts the
// SDK child, and the stream's rejection ("Operation aborted") can land
// AFTER the recovery installed the new generation (installRuntime resets
// runtimeDead). The old loop's catch must drop it — no durable error event,
// no red banner, no interrupted-run marking for the LIVE turn.
{
  let version = "v1";
  const recoveryRts: FakeRT[] = [];
  // Old runtime that throws a DELAYED teardown error once its stream ends.
  class AbortingRT extends FakeRT {
    override async *getEventStream(): AsyncIterable<RuntimeEvent> {
      yield* super.getEventStream();
      await flush(30); // land AFTER the recovery install (gen bump)
      throw new Error("Operation aborted");
    }
  }
  const userId = "m8g-h8-user";
  const chat = chatStore.createChat(userId, "M8g h8", DEFAULT_ORG_ID);
  const chatId = chat.id;
  const runtimes: FakeRT[] = [];
  const session = new Session(chatId, () => {
    const rt = runtimes.length === 0 ? new AbortingRT() : new FakeRT();
    runtimes.push(rt);
    return rt;
  }, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    configVersionProbe: () => version,
    recovery: async () => {
      const rt = new FakeRT();
      recoveryRts.push(rt);
      return rt;
    },
  });
  session.setUserId(userId);
  await flush();

  session.sendMessage("turn one");
  runtimes[0].pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => runtimes[0].sent.length === 1 && (session as any).activeRecords.length === 0);

  version = "v2"; // drift → swap; old runtime throws 30ms AFTER install
  session.sendMessage("turn two");
  await waitUntil(() => recoveryRts.length === 1 && recoveryRts[0].sent.length === 1);
  await flush(80); // let the delayed abort rejection land on the stale loop

  assert.deepEqual(recoveryRts[0].sent, ["turn two"], "H8: message dispatched exactly once to the NEW runtime");
  assert.equal(
    eventsOfType(userId, chatId, "error").length, 0,
    "H8: stale teardown error NEVER surfaces (no error event / red banner)"
  );
  assert.equal(eventsOfType(userId, chatId, "runtime_hot_reload").length, 1, "H8: swap still audited exactly once");
  session.close();
  console.log("✓ H8 stale teardown error suppressed (no durable error, live turn intact)");
}

// ─── H9: involuntary recovery syncs the baseline — zero additional swap ──
// The Codex P1 reproduction: runtime built at v1 dies, the control plane
// moves to v2, the next message triggers INVOLUNTARY governed recovery which
// resolves/installs v2. Without re-syncing builtConfigVersion at recovery
// time, the result boundary sees baseline=v1 vs probe=v2 and closes the
// just-installed runtime for a redundant second rebuild.
{
  let version = "v1";
  const recoveryRts: FakeRT[] = [];
  const { session, rt: rt1, userId, chatId } = await makeHarness("h9", {
    configVersionProbe: () => version,
    recovery: async () => {
      const rt = new FakeRT();
      recoveryRts.push(rt);
      return rt;
    },
  });

  session.sendMessage("turn one");
  rt1.pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => rt1.sent.length === 1 && (session as any).activeRecords.length === 0);

  rt1.abort(); // idle runtime dies (death notification only — no turn in flight)
  version = "v2"; // control plane changed while dead
  session.sendMessage("turn two"); // dead → involuntary recovery installs the v2 runtime
  await waitUntil(() => recoveryRts.length === 1 && recoveryRts[0].sent.length === 1);
  await flush();

  // Result boundary on the JUST-INSTALLED runtime — this is where the stale
  // baseline used to fire a second swap.
  recoveryRts[0].pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => (session as any).activeRecords.length === 0);
  await flush(30);

  assert.equal(eventsOfType(userId, chatId, "runtime_hot_reload").length, 0,
    "H9: NO redundant swap after involuntary recovery installed the fresh version");
  assert.equal(eventsOfType(userId, chatId, "runtime_recovered").length, 1,
    "H9: exactly one recovery (no second rebuild / rate-limit token burned)");
  assert.ok(!recoveryRts[0].closed, "H9: the recovered runtime keeps serving");
  assert.equal(recoveryRts.length, 1, "H9: recovery ran exactly once");

  session.sendMessage("turn three"); // still served by the SAME recovered runtime
  await waitUntil(() => recoveryRts[0].sent.length === 2);
  session.close();
  console.log("✓ H9 involuntary recovery syncs the baseline — zero additional swap");
}

// ─── H10: stale listener finally must not kill a new generation's card ────
// The Codex P1 reproduction: a hot swap leaves the old stream draining while
// the new runtime is installed; the NEW generation opens a pending A2UI card;
// the old loop's DELAYED finally then runs — it must not reject the live card
// (its own generation's cards still cancel, new-generation cards survive).
{
  let version = "v1";
  const recoveryRts: FakeRT[] = [];
  // Old runtime whose stream termination lands 30ms AFTER the swap installed
  // the new generation (same delayed-teardown shape as H8).
  class DelayedEndRT extends FakeRT {
    override async *getEventStream(): AsyncIterable<RuntimeEvent> {
      yield* super.getEventStream();
      await flush(30);
      throw new Error("Operation aborted");
    }
  }
  const userId = "m8g-h10-user";
  const chat = chatStore.createChat(userId, "M8g h10", DEFAULT_ORG_ID);
  const chatId = chat.id;
  const runtimes: FakeRT[] = [];
  const session = new Session(chatId, () => {
    const rt = runtimes.length === 0 ? new DelayedEndRT() : new FakeRT();
    runtimes.push(rt);
    return rt;
  }, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    configVersionProbe: () => version,
    recovery: async () => {
      const rt = new FakeRT();
      recoveryRts.push(rt);
      return rt;
    },
  });
  session.setUserId(userId);
  await flush();

  session.sendMessage("turn one");
  runtimes[0].pushEvent({ type: "result", subtype: "success" } as RuntimeEvent);
  await waitUntil(() => runtimes[0].sent.length === 1 && (session as any).activeRecords.length === 0);

  version = "v2"; // drift → swap; old runtime's stream ends 30ms after install
  session.sendMessage("turn two");
  await waitUntil(() => recoveryRts.length === 1 && recoveryRts[0].sent.length === 1);
  await flush(10);

  // The NEW generation opens a pending A2UI card while the old loop's
  // finally is still pending.
  const cardPromise = session.handleA2UiToolCall({
    block: {
      type: "form",
      title: "确认",
      fields: [{ id: "note", type: "text", label: "备注" }],
      actions: [{ id: "submit", label: "提交", style: "primary" }],
    } as unknown as A2UIBlock,
  });
  const pendingMap = (session as any).pendingA2UiTool as Map<string, unknown>;
  assert.equal(pendingMap.size, 1, "H10: new-generation pending card registered");

  await flush(80); // let the delayed old-stream teardown + stale finally land

  assert.equal(pendingMap.size, 1, "H10: the new generation's pending card SURVIVED the stale finally");
  assert.equal(
    eventsOfType(userId, chatId, "error").length, 0,
    "H10: stale loop emits no error"
  );
  // The card is still functional: a submit resolves it (not a cancel).
  const blockId = [...pendingMap.keys()][0] as string;
  session.handleA2UISubmit({ blockId, actionId: "submit", values: { note: "ok" } });
  const cardResult = await cardPromise;
  assert.equal(cardResult.status, "submitted", "H10: surviving card resolves as submitted, not cancelled");
  assert.equal(pendingMap.size, 0, "H10: card consumed by the submit");
  assert.equal(eventsOfType(userId, chatId, "runtime_hot_reload").length, 1, "H10: swap audited exactly once");
  session.close();
  console.log("✓ H10 stale listener finally leaves the new generation's pending A2UI card alive");
}

console.log("\nM8g capability hot reload: all 9 test groups passed.");
