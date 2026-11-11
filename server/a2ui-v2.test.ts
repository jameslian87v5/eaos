// A2UI v2 — S2 blocking-flow regressions (Codex S2 review fixes).
// Run: A2UI_ENABLED=true npx tsx server/a2ui-v2.test.ts  (chdir's to a scratch dir)
//
// Locks the four review findings:
//   1. lifecycle union — pending registered BEFORE notify (idle protection on
//      a sole live card), released to false only when both sets are empty
//   2. forged WS values — required/type/options validated against the pending
//      block; invalid submit does NOT consume the card
//   3. tool blockIds carry an unambiguous prefix — late/repeat/forged tool ids
//      are rejected outright, never reaching the legacy prose user-message
//      path; legacy (digit-led) ids still do
//   4. (ai-client env wall is unit-checked indirectly via timeoutWall logic;
//      the query-options wiring is exercised by capability-provider-local)
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import type { AgentRuntime, RuntimeEvent, RuntimeStatus } from "./agent-runtime.js";

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "a2ui-v2-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.JWT_SECRET = "a2ui-v2-test-secret-9f3a";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";
process.env.A2UI_ENABLED = "true";

const { chatStore } = await import("./chat-store.js");
const { Session } = await import("./session.js");
const { validateShowUiValues, A2UI_LIMITS } = await import("./a2ui-schema.js");
import type { A2UIBlock } from "./a2ui-types.js";
import type { ShowUiResult } from "./a2ui-schema.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ─── Fixtures ─────────────────────────────────────────────────
class StubRuntime implements AgentRuntime {
  sent: string[] = [];
  forwarded: Array<{ requestId: string; result: ShowUiResult }> = [];
  private q: Array<RuntimeEvent | null> = [];
  private waiters: Array<(v: RuntimeEvent | null) => void> = [];
  sendMessage(content: string): void {
    this.sent.push(content);
  }
  /** Inject an event as if the runtime produced it (docker IPC pattern). */
  push(ev: RuntimeEvent): void {
    const w = this.waiters.shift();
    if (w) w(ev);
    else this.q.push(ev);
  }
  /** Terminate the event stream (docker crash / WS close). */
  endStream(): void {
    const w = this.waiters.shift();
    if (w) w(null);
    else this.q.push(null);
  }
  async *getEventStream(): AsyncIterableIterator<RuntimeEvent> {
    for (;;) {
      const ev = await new Promise<RuntimeEvent | null>((resolve) => {
        const v = this.q.shift();
        if (v !== undefined) resolve(v);
        else this.waiters.push(resolve);
      });
      if (ev === null) return;
      yield ev;
    }
  }
  forwardA2UiResult(requestId: string, result: ShowUiResult): void {
    this.forwarded.push({ requestId, result });
  }
  abort(): void {}
  close(): void {}
  getStatus(): RuntimeStatus {
    return "running";
  }
}

const formBlock: A2UIBlock = {
  type: "form",
  title: "部署方案",
  fields: [
    { id: "plan", type: "select", label: "方案", required: true,
      options: [{ label: "A", value: "local" }, { label: "B", value: "container" }] },
    { id: "replicas", type: "number", label: "副本数", required: true },
    { id: "monitoring", type: "boolean", label: "监控" },
    { id: "note", type: "text", label: "备注" },
  ],
  actions: [{ id: "submit", label: "提交", style: "primary" }],
} as unknown as A2UIBlock;

const ORG = "default-org";
const user = { id: "a2ui-u1" };
const chat = chatStore.createChat(user.id, "a2ui-chat", ORG);

function makeSession() {
  const stub = new StubRuntime();
  const pendingCalls: boolean[] = [];
  const session = new Session(chat.id, () => stub, {
    onSubscriberCountChange: () => {},
    onAgentBusyChange: () => {},
    onPendingApprovalChange: (_u: string, _c: string, pending: boolean) => pendingCalls.push(pending),
  }, user.id);
  session.setUserId(user.id);
  return { session, stub, pendingCalls };
}

// ─── V: validateShowUiValues (review #2) ──────────────────────
{
  const v = validateShowUiValues(formBlock, {});
  ok("V1 missing required → rejected", v.ok === false, JSON.stringify(v));

  ok("V2 wrong type (number as string) → rejected",
    validateShowUiValues(formBlock, { plan: "local", replicas: "3" }).ok === false);

  ok("V3 out-of-options select → rejected",
    validateShowUiValues(formBlock, { plan: "rogue", replicas: 3 }).ok === false);

  ok("V4 non-array multi-select → rejected",
    validateShowUiValues({ ...formBlock, fields: [
      ...(formBlock as { fields: Array<{ id: string }> }).fields,
      { id: "tags", type: "multi-select", label: "标签",
        options: [{ label: "x", value: "x" }] },
    ] } as unknown as A2UIBlock, { plan: "local", replicas: 3, tags: "x" }).ok === false);

  const good = validateShowUiValues(formBlock, {
    plan: "container", replicas: 2, monitoring: true, note: "hi", injected: "evil",
  });
  ok("V5 valid pass drops unknown keys",
    good.ok === true && good.ok && good.values.plan === "container" && good.values.replicas === 2
      && !("injected" in good.values), JSON.stringify(good));

  ok("V6 optional fields may be omitted",
    validateShowUiValues(formBlock, { plan: "local", replicas: 1 }).ok === true);

  const cf = validateShowUiValues({ type: "confirm", title: "t", actions: [{ id: "ok", label: "OK" }] } as A2UIBlock, { anything: 1 });
  ok("V7 non-form block ignores values", cf.ok === true && cf.ok && Object.keys(cf.values).length === 0);

  // Codex S2 edge review: required multi-select [] = missing answer.
  const msBlock = {
    type: "form", title: "t",
    fields: [{ id: "tags", type: "multi-select", label: "标签", required: true,
      options: [{ label: "x", value: "x" }, { label: "y", value: "y" }] }],
    actions: [{ id: "ok", label: "OK" }],
  } as unknown as A2UIBlock;
  ok("V8 required multi-select [] → rejected",
    validateShowUiValues(msBlock, { tags: [] }).ok === false);
  const msFields = msBlock as unknown as { fields: Array<Record<string, unknown>> };
  const msOpt = validateShowUiValues({ ...msBlock, fields: [{ ...msFields.fields[0]!, required: false }] } as unknown as A2UIBlock, { tags: [] });
  ok("V9 optional multi-select [] treated as absent",
    msOpt.ok === true && msOpt.ok && !("tags" in msOpt.values));

  // Unconditional membership: a hand-built choice field with no options
  // (schema would reject it) rejects every submitted value.
  const noOpts = { ...msBlock, fields: [{ id: "tags", type: "select", label: "标签" }] } as unknown as A2UIBlock;
  ok("V10 option-less choice (hand-built) rejects any value",
    validateShowUiValues(noOpts, { tags: "x" }).ok === false);

  // Codex S2 final review: 201 duplicates of a legal value must not sail
  // through into the tool_result.
  const flood = { tags: Array(A2UI_LIMITS.maxOptions + 1).fill("x") };
  ok("V11 multi-select array > maxOptions → rejected",
    validateShowUiValues(msBlock, flood).ok === false);
}

// ─── L/F/T: session flow with a broadcast spy (the blockId is generated
// server-side; the subscriber frame is the natural capture point) ─────────
{
  const { session, stub, pendingCalls } = makeSession();
  const frames: Array<Record<string, unknown>> = [];
  const fakeWs = {
    readyState: 1,
    OPEN: 1,
    send: (raw: string) => frames.push(JSON.parse(raw)),
    sessionId: "",
  } as never;
  (session as unknown as { subscribe(c: never): void }).subscribe(fakeWs);

  const promise = session.handleA2UiToolCall({ block: formBlock });
  ok("L1 registered BEFORE notify → hook saw true", pendingCalls[pendingCalls.length - 1] === true,
    JSON.stringify(pendingCalls));
  await flush();
  const blockFrame = frames.find((f) => f.type === "a2ui_block");
  ok("L3 a2ui_block broadcast carried tool-prefixed id",
    !!blockFrame && String(blockFrame.blockId).startsWith("tool-"), JSON.stringify(blockFrame?.blockId));
  const blockId = String(blockFrame!.blockId);

  ok("L4 hook true while pending", pendingCalls[pendingCalls.length - 1] === true);

  let resolved: ShowUiResult | null = null;
  promise.then((r) => { resolved = r; });

  // Invalid values must NOT consume the card (review #2).
  session.handleA2UISubmit({ blockId, actionId: "submit", values: { plan: "rogue", replicas: 1 } });
  await flush();
  ok("F1 invalid values → card still pending", resolved === null && pendingCalls[pendingCalls.length - 1] === true);

  session.handleA2UISubmit({ blockId, actionId: "submit", values: { plan: "container", replicas: 2, injected: "x" } });
  await flush();
  const finalResult = resolved as ShowUiResult | null;
  ok("L5 valid submit resolved same turn",
    finalResult?.status === "submitted" && (finalResult as { values: { plan?: string } }).values.plan === "container",
    JSON.stringify(finalResult));
  ok("L6 hook false after both sets empty", pendingCalls[pendingCalls.length - 1] === false, JSON.stringify(pendingCalls));
  ok("L7 no user message forged for tool origin",
    !stub.sent.some((s) => s.includes("[A2UI 提交]")) &&
    !chatStore.getMessages(chat.id).some((m) => m.content.includes("[A2UI 提交]")));

  // ─── T: late/repeat/forged tool ids (review #3) ─────────────
  const msgCount = chatStore.getMessages(chat.id).length;
  session.handleA2UISubmit({ blockId, actionId: "submit", values: { plan: "local", replicas: 1 } });
  await flush();
  ok("T1 repeat submit on consumed tool id → no message, no runtime send",
    chatStore.getMessages(chat.id).length === msgCount && stub.sent.length === 0);

  session.handleA2UISubmit({ blockId: "tool-9999999999-forged", actionId: "submit", values: {} });
  await flush();
  ok("T2 unknown prefixed id → rejected outright",
    chatStore.getMessages(chat.id).length === msgCount && stub.sent.length === 0);

  session.handleA2UISubmit({ blockId: "1690000000000-abcdef", actionId: "ok", values: {} });
  await flush();
  ok("T3 legacy digit-led id → legacy prose path preserved",
    chatStore.getMessages(chat.id).some((m) => m.role === "user" && m.content.includes("[A2UI 提交]")) &&
    stub.sent.some((s) => s.includes("[A2UI 提交]")));
}

// ─── D: docker IPC boundary (S3 review #2/#4) ─────────────────
{
  const { session, stub, pendingCalls } = makeSession();
  const frames: Array<Record<string, unknown>> = [];
  const fakeWs = { readyState: 1, OPEN: 1, send: (raw: string) => frames.push(JSON.parse(raw)), sessionId: "" } as never;
  (session as unknown as { subscribe(c: never): void }).subscribe(fakeWs);
  session.sendMessage("kick"); // startListening consumes the stub stream

  // D1: VALID a2ui_request → persisted + broadcast + pending + forwardable.
  const before = chatStore.getMessages(chat.id).length;
  stub.push({ type: "a2ui_request", requestId: "req-1", block: formBlock } as RuntimeEvent);
  await flush();
  const d1frame = frames.find((f) => f.type === "a2ui_block");
  ok("D1 valid request persisted+broadcast with tool-prefixed id",
    chatStore.getMessages(chat.id).length === before + 1 &&
    !!d1frame && String(d1frame.blockId).startsWith("tool-"));
  // S4 follow-up: the synthetic assistant message embeds the live blockId as
  // `<!--a2ui-id:<id>-->` so history replay can re-derive it (the legacy
  // parser's validate() strips unknown keys, so the id rides in a comment).
  const synth = chatStore.getMessages(chat.id).at(-1);
  ok("D1b persisted message carries the a2ui-id comment",
    !!synth && synth.content.includes(`<!--a2ui-id:${String(d1frame!.blockId)}-->`));
  ok("D2 hook true while docker pending", pendingCalls[pendingCalls.length - 1] === true);

  // D3: MALFORMED block → rejected at host boundary, nothing persisted,
  // container receives invalid_block.
  stub.push({ type: "a2ui_request", requestId: "req-2", block: { type: "form", title: "broken" } } as RuntimeEvent);
  await flush();
  ok("D3 malformed block → invalid_block forwarded, nothing persisted",
    stub.forwarded.some((f) => f.requestId === "req-2" && f.result.status === "invalid_block") &&
    chatStore.getMessages(chat.id).length === before + 1);

  // D4: submit resolves via forward to the container correlation id.
  session.handleA2UISubmit({
    blockId: String(d1frame!.blockId), actionId: "submit",
    values: { plan: "local", replicas: 1 },
  });
  await flush();
  ok("D4 submit forwarded to container requestId",
    stub.forwarded.some((f) => f.requestId === "req-1" && f.result.status === "submitted"));

  // D5: stream termination cancels live pendings + releases lifecycle
  // (review #4): stale idle-protection must not survive a dead runtime.
  stub.push({ type: "a2ui_request", requestId: "req-3", block: formBlock } as RuntimeEvent);
  await flush();
  const d5frame = [...frames].reverse().find((f) => f.type === "a2ui_block");
  let d5resolved: ShowUiResult | null = null;
  // Re-request then end the stream; the pending promise resolves cancelled.
  // (We can't reach the promise directly — assert via hook release + no leak.)
  void d5resolved;
  stub.endStream();
  await flush();
  ok("D5 stream end → pending cancelled, lifecycle released",
    pendingCalls[pendingCalls.length - 1] === false);
  ok("D6 cancelled result forwarded for req-3",
    stub.forwarded.some((f) => f.requestId === "req-3" && f.result.status === "cancelled"));
}

// ─── D7/D8: envelope validation (S3 follow-up review), fresh session —
// the previous block ended its stream (D5), and a2ui_request needs a live
// consumer. ────────────────────────────────────────────────────────────
{
  const { session, stub, pendingCalls } = makeSession();
  const frames: Array<Record<string, unknown>> = [];
  const fakeWs = { readyState: 1, OPEN: 1, send: (raw: string) => frames.push(JSON.parse(raw)), sessionId: "" } as never;
  (session as unknown as { subscribe(c: never): void }).subscribe(fakeWs);
  session.sendMessage("kick");

  // D7: missing requestId → rejected, nothing persisted, nothing forwarded
  // (no correlation key to forward to; String(undefined) must not become one).
  const beforeD7 = chatStore.getMessages(chat.id).length;
  stub.push({ type: "a2ui_request", block: formBlock } as RuntimeEvent);
  await flush();
  ok("D7 missing requestId → rejected, no persistence, no forward",
    chatStore.getMessages(chat.id).length === beforeD7 && stub.forwarded.length === 0);

  // D8: per-call timeoutSec travels the envelope — host expires at the
  // per-call deadline (1s) and forwards timeout. A dropped envelope
  // timeoutSec would leave this pending for the 15-min default.
  const confirmBlock = { type: "confirm", title: "确认", actions: [{ id: "ok", label: "好" }] } as unknown as A2UIBlock;
  stub.push({ type: "a2ui_request", requestId: "req-t", block: confirmBlock, timeoutSec: 1 } as RuntimeEvent);
  await flush(1500);
  ok("D8 envelope timeoutSec honored (1s deadline → timeout forwarded)",
    stub.forwarded.some((f) => f.requestId === "req-t" && f.result.status === "timeout") &&
    frames.some((f) => f.type === "a2ui_expired") &&
    pendingCalls[pendingCalls.length - 1] === false);
}

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
