/**
 * streaming.test.ts — S3b (resilience plan Appendix A.7, Slice 2):
 * host streaming state machine — stream_event → client frames.
 *
 * Cases (A.7 Slice 2 numbering):
 *   ①  normal text/thinking delta forwarding + exact frame shapes;
 *   ②  compact control turn / no active user turn → no stream frames (gate ①);
 *   ③  <a2ui-json> scanner: torn OPEN tag, torn CLOSE tag, trailing text;
 *   ④  UTF-8 byte caps (multi-byte counted as bytes; frame 8 KiB / stream 256 KiB);
 *   ⑤  old-generation late deltas dropped;
 *   ⑥  thinking whole frame → final thinking_block, never persisted;
 *   ⑦  runtime death → no residual deltas + exactly one stream_end per open stream;
 *   ⑧  thinking final first, same-stream text deltas keep flowing (block-level finalize);
 *   ⑨  multiple streamIds before one result — independent start/end per stream;
 *   ⑩  assistant_message carries streamId/blockIndex (additive correlation);
 *   ⑪  A2UI split association: pre-card text correlated, a2ui_block lifecycle
 *       metadata only, post-card text independent (no correlation);
 *   ⑫  malformed-A2UI retry notice must NOT claim the preview correlation;
 *   ⑬  whole-frame-only provider: no synthesized stream frames, lazy thinking id;
 *   ⑭  kill-switch regression: AGENT_STREAMING_ENABLED=false → zero stream frames.
 *
 * Run: DB_PATH=/tmp/s3b-streaming.db JWT_SECRET=test npx tsx server/streaming.test.ts
 */

import assert from "node:assert/strict";
import { Session } from "./session.js";
import { chatStore } from "./chat-store.js";
import { eventStore } from "./event-store.js";
import { DEFAULT_ORG_ID } from "./request-context.js";
import type { WSClient } from "./types.js";
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

// ─── Fake runtime (mirrors session-resilience.test.ts contract) ────────
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
  /** Local-style death: the SDK stream itself ends + death listener fires. */
  endStream(reason = "local_sdk_stream_ended"): void {
    this.status = "crashed";
    this.notify(reason);
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }
  /** Docker-style death: dead, stream still open (late frames drain). */
  die(reason = "ws_closed"): void {
    this.status = "crashed";
    this.notify(reason);
  }
  pushEvent(event: RuntimeEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }
}

// ─── Fake WS subscriber: captures broadcast frames ─────────────────────
function makeSubscriber() {
  const frames: any[] = [];
  const client = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => {
      try {
        frames.push(JSON.parse(s));
      } catch {
        /* ignore malformed */
      }
    },
    sessionId: null as string | null,
  } as unknown as WSClient;
  return { client, frames };
}

async function makeHarness(tag: string, opts: { recovery?: (o: AgentRuntimeOptions) => Promise<AgentRuntime> } = {}) {
  const userId = `s3b-${tag}-user`;
  const chat = chatStore.createChat(userId, `S3b ${tag}`, DEFAULT_ORG_ID);
  const chatId = chat.id;
  let rt: FakeRT | undefined;
  const factory = () => {
    rt = new FakeRT();
    return rt;
  };
  const session = new Session(chatId, factory, undefined, userId, {
    role: "user",
    orgId: DEFAULT_ORG_ID,
    ...(opts.recovery ? { recovery: opts.recovery } : {}),
  });
  session.setUserId(userId);
  const { client, frames } = makeSubscriber();
  session.subscribe(client);
  await flush();
  return { session, rt: rt!, userId, chatId, frames };
}

// ─── stream_event builders (SDKPartialAssistantMessage.event shapes) ───
const se = (event: any) => ({ type: "stream_event", event }) as RuntimeEvent;
const msgStart = () => se({ type: "message_start", message: {} });
const blkStart = (index: number, kind: "text" | "thinking" | "tool_use") =>
  se({ type: "content_block_start", index, content_block: { type: kind } });
const textDelta = (index: number, text: string) =>
  se({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const thinkDelta = (index: number, thinking: string) =>
  se({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });
const msgStop = () => se({ type: "message_stop" });
const sysThinkingTokens = (estimated_tokens: number) =>
  ({ type: "system", subtype: "thinking_tokens", estimated_tokens }) as RuntimeEvent;
const assistantTextFrame = (text: string) =>
  ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as RuntimeEvent;
const assistantThinkingFrame = (thinking: string) =>
  ({ type: "assistant", message: { content: [{ type: "thinking", thinking }] } }) as RuntimeEvent;
const resultFrame = () => ({ type: "result", subtype: "success" }) as RuntimeEvent;

const streamFrames = (frames: any[]) =>
  frames.filter((f) => f.type === "stream_start" || f.type === "stream_delta" || f.type === "stream_end");
const deltasOf = (frames: any[]) => frames.filter((f) => f.type === "stream_delta");

const VALID_FORM_BLOCK = {
  type: "form",
  title: "部署方案",
  fields: [
    {
      id: "plan",
      type: "select",
      label: "方案",
      required: true,
      options: [
        { label: "A", value: "local" },
        { label: "B", value: "container" },
      ],
    },
  ],
  actions: [{ id: "submit", label: "提交", style: "primary" }],
};

// ─── ① frame shapes + text/thinking forwarding ──────────────────────────
{
  const { session, rt, chatId, frames } = await makeHarness("c1");
  session.sendMessage("hello");
  await flush();

  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "thinking"));
  rt.pushEvent(thinkDelta(0, "思考片段"));
  rt.pushEvent(blkStart(1, "text"));
  rt.pushEvent(textDelta(1, "你好"));
  rt.pushEvent(msgStop());
  await flush(30);

  const sf = streamFrames(frames);
  const starts = sf.filter((f) => f.type === "stream_start");
  assert.equal(starts.length, 1, "① exactly one stream_start per stream");
  const streamId = starts[0].streamId;
  assert.ok(typeof streamId === "string" && streamId.length > 0, "① stream_start carries host-minted streamId");
  assert.deepEqual(starts[0], { type: "stream_start", chatId, streamId }, "① stream_start exact shape");

  const ds = deltasOf(frames);
  assert.equal(ds.length, 2, "① one delta per forwarded payload");
  assert.deepEqual(
    ds[0],
    { type: "stream_delta", chatId, streamId, index: 0, kind: "thinking", delta: "思考片段" },
    "① thinking delta shape (kind/index keyed)"
  );
  assert.deepEqual(
    ds[1],
    { type: "stream_delta", chatId, streamId, index: 1, kind: "text", delta: "你好" },
    "① text delta shape"
  );

  const ends = sf.filter((f) => f.type === "stream_end");
  assert.equal(ends.length, 1, "① exactly one stream_end at message_stop");

  // Preview-only: deltas never persist.
  const stored = chatStore.getMessages(chatId).filter((m: any) => m.role === "assistant");
  assert.equal(stored.length, 0, "① delta frames are not persisted");
  session.close();
  console.log("✓ ① text/thinking delta forwarding + frame shapes");
}

// ─── ② compact control turn / no active user turn → silent ──────────────
{
  const { session, rt, frames } = await makeHarness("c2");
  session.sendMessage("hi");
  await flush();

  // Compact control turn window (gate ①: awaitingAutoCompactResult).
  (session as any).awaitingAutoCompactResult = true;
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "compact 期间的 delta"));
  rt.pushEvent(msgStop());
  await flush(30);
  assert.equal(streamFrames(frames).length, 0, "② compact control turn emits zero stream frames");

  (session as any).awaitingAutoCompactResult = false;
  rt.pushEvent(resultFrame());
  await flush(20);

  // No active user turn at all (turn finalized by result).
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "无活动 turn 的 delta"));
  rt.pushEvent(msgStop());
  await flush(30);
  assert.equal(streamFrames(frames).length, 0, "② no active user_turn → zero stream frames");
  session.close();
  console.log("✓ ② compact/no-active-turn delta suppression (gate ①)");
}

// ─── ③ A2UI tag scanner: torn open/close tags across deltas ─────────────
{
  const { session, rt, frames } = await makeHarness("c3");
  session.sendMessage("hi");
  await flush();

  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "看这个 "));        // forwarded
  rt.pushEvent(textDelta(0, "<a2ui-"));         // torn OPEN prefix — held
  rt.pushEvent(textDelta(0, 'json>{"type":"form"')); // open completes, interior suppressed
  rt.pushEvent(textDelta(0, "</a2ui-j"));       // torn CLOSE prefix — interior suppressed
  rt.pushEvent(textDelta(0, "son> 尾部文本"));   // close completes, trailing text forwarded
  rt.pushEvent(msgStop());
  await flush(30);

  const ds = deltasOf(frames);
  const forwarded = ds.map((f) => f.delta).join("|");
  assert.equal(forwarded, "看这个 | 尾部文本", "③ only exterior text forwarded, torn tags handled");
  assert.ok(!forwarded.includes("json>") || forwarded.includes("看这个 "), "③ tag interior never leaks");
  assert.ok(!forwarded.includes("a2ui-json"), "③ no tag fragments forwarded");
  session.close();
  console.log("✓ ③ torn OPEN/CLOSE tag suppression + trailing text");
}

// ─── ④ UTF-8 byte caps (frame 8 KiB / stream 256 KiB) ──────────────────
{
  const { session, rt, frames } = await makeHarness("c4");
  session.sendMessage("hi");
  await flush();

  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  // Multi-byte metric: 2730 × "字" = 8190 bytes (≤ cap, JS length 2730 << 8192 —
  // proves Buffer.byteLength, not string length). 2731 × 3 = 8193 bytes → dropped.
  rt.pushEvent(textDelta(0, "字".repeat(2730)));
  rt.pushEvent(textDelta(0, "字".repeat(2731)));
  await flush(30);
  let ds = deltasOf(frames);
  assert.equal(ds.length, 1, "④ per-frame cap: multi-byte 8193-byte frame dropped, 8190-byte frame kept");

  // Stream cap: cumulative text+thinking bytes ≤ 256 KiB. Already at 8190
  // (the "字" frame above); 31 × 8192-byte ASCII frames bring it to 262142,
  // the 32nd would exceed the combined cap → stream capped, later deltas stop.
  for (let i = 0; i < 32; i++) rt.pushEvent(textDelta(0, "a".repeat(8192)));
  await flush(50);
  ds = deltasOf(frames);
  assert.equal(ds.length, 32, "④ stream cap: 1 + 31 frames = 262142 bytes forwarded, 32nd dropped");
  rt.pushEvent(textDelta(0, "after cap"));
  rt.pushEvent(textDelta(0, "still after cap"));
  await flush(30);
  ds = deltasOf(frames);
  assert.equal(ds.length, 32, "④ capped stream forwards nothing further");
  assert.ok(!ds.some((f) => f.delta.includes("after cap")), "④ post-cap delta absent");
  session.close();
  console.log("✓ ④ UTF-8 byte caps (multi-byte frame metric + stream cap)");
}

// ─── ⑤ old-generation late deltas dropped ───────────────────────────────
{
  let recoveryCalls = 0;
  const { session, rt: rt1, frames } = await makeHarness("c5", {
    recovery: async () => {
      recoveryCalls++;
      return new FakeRT();
    },
  });
  session.sendMessage("m1");
  await flush();
  rt1.pushEvent(msgStart());
  rt1.pushEvent(blkStart(0, "text"));
  rt1.pushEvent(textDelta(0, "旧 generation 的 delta"));
  await flush(20);
  assert.equal(streamFrames(frames).filter((f) => f.type === "stream_delta").length, 1, "⑤ pre-death delta forwarded");

  rt1.die();
  session.sendMessage("m2"); // triggers governed recovery → generation bump
  await waitUntil(() => recoveryCalls === 1);
  await flush(20);

  rt1.pushEvent(textDelta(0, "迟到旧帧"));
  rt1.pushEvent(msgStop());
  await flush(30);
  const ds = deltasOf(frames);
  assert.ok(!ds.some((f) => f.delta === "迟到旧帧"), "⑤ old-generation late delta dropped");
  session.close();
  console.log("✓ ⑤ old-generation late delta suppression");
}

// ─── ⑥ thinking whole frame → final thinking_block, never persisted ─────
{
  const { session, rt, userId, chatId, frames } = await makeHarness("c6");
  session.sendMessage("hi");
  await flush();
  rt.pushEvent(sysThinkingTokens(123));
  rt.pushEvent(assistantThinkingFrame("完整思考内容"));
  await flush(20);

  const tb = frames.filter((f) => f.type === "thinking_block");
  assert.equal(tb.length, 1, "⑥ one thinking_block for the whole frame");
  assert.equal(tb[0].content, "完整思考内容");
  assert.equal(tb[0].final, true, "⑥ thinking_block is final");
  assert.equal(tb[0].estimatedTokens, 123, "⑥ estimate attached (metadata)");
  assert.ok(typeof tb[0].streamId === "string", "⑥ lazy stream identity minted");

  const stored = chatStore.getMessages(chatId);
  assert.ok(!stored.some((m: any) => String(m.content).includes("完整思考内容")), "⑥ thinking never persisted to messages");
  const payloads = eventStore
    .getEventsByChat(userId, chatId)
    .map((e) => e.payloadJson);
  assert.ok(!payloads.some((p) => p.includes("完整思考内容")), "⑥ thinking content never lands in agent_events");
  session.close();
  console.log("✓ ⑥ thinking final frame, no persistence");
}

// ─── ⑦ runtime death → no residual deltas + one stream_end ─────────────
{
  const { session, rt, frames } = await makeHarness("c7");
  session.sendMessage("hi");
  await flush();
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "部分回复"));
  await flush(20);

  rt.die(); // docker-style: dead, stream still draining
  await flush(20);
  rt.pushEvent(textDelta(0, "死亡后的残留 delta"));
  rt.pushEvent(msgStop());
  await flush(30);
  const ds = deltasOf(frames);
  assert.ok(!ds.some((f) => f.delta === "死亡后的残留 delta"), "⑦ no residual delta after death");

  rt.endStream(); // local-style stream end → terminal sweep
  await flush(30);
  const ends = frames.filter((f) => f.type === "stream_end");
  assert.equal(ends.length, 1, "⑦ sweep emits exactly one stream_end for the open stream");
  session.close();
  console.log("✓ ⑦ death: residual delta suppressed + stream_end sweep");
}

// ─── ⑧ thinking final first, text deltas keep flowing ───────────────────
{
  const { session, rt, frames } = await makeHarness("c8");
  session.sendMessage("hi");
  await flush();
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "thinking"));
  rt.pushEvent(thinkDelta(0, "思考增量"));
  rt.pushEvent(assistantThinkingFrame("思考全文")); // block-level final (V5 order)
  rt.pushEvent(blkStart(1, "text"));
  rt.pushEvent(textDelta(1, "正文增量")); // same stream, AFTER the thinking final
  rt.pushEvent(thinkDelta(0, "迟到 thinking delta")); // block already final → dropped
  await flush(30);

  const tb = frames.filter((f) => f.type === "thinking_block");
  assert.equal(tb.length, 1, "⑧ thinking final broadcast");
  const ds = deltasOf(frames);
  assert.ok(ds.some((f) => f.kind === "text" && f.delta === "正文增量"), "⑧ text delta still flows after thinking final");
  assert.ok(!ds.some((f) => f.kind === "thinking" && f.delta === "迟到 thinking delta"), "⑧ late delta onto final block dropped");
  session.close();
  console.log("✓ ⑧ block-level finalize does not end the stream");
}

// ─── ⑨ multiple streamIds before one result ─────────────────────────────
{
  const { session, rt, frames } = await makeHarness("c9");
  session.sendMessage("hi");
  await flush();

  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "第一回合"));
  rt.pushEvent(msgStop());
  // tool loop elided — second SDK message mints a NEW streamId
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "第二回合"));
  rt.pushEvent(msgStop());
  rt.pushEvent(resultFrame());
  await flush(40);

  const sf = streamFrames(frames);
  const starts = sf.filter((f) => f.type === "stream_start");
  const ends = sf.filter((f) => f.type === "stream_end");
  assert.equal(starts.length, 2, "⑨ two stream_starts");
  assert.equal(ends.length, 2, "⑨ two stream_ends (message_stop), sweep adds none at result");
  assert.notEqual(starts[0].streamId, starts[1].streamId, "⑨ distinct host-minted streamIds");
  const ds = deltasOf(frames);
  assert.ok(ds.find((f) => f.delta === "第一回合")?.streamId === starts[0].streamId, "⑨ delta 1 attributed to stream 1");
  assert.ok(ds.find((f) => f.delta === "第二回合")?.streamId === starts[1].streamId, "⑨ delta 2 attributed to stream 2");
  session.close();
  console.log("✓ ⑨ independent streams per SDK message");
}

// ─── ⑩ assistant_message correlation fields ─────────────────────────────
{
  const { session, rt, chatId, frames } = await makeHarness("c10");
  session.sendMessage("hi");
  await flush();
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "流式正文"));
  rt.pushEvent(assistantTextFrame("最终正文")); // whole frame (V5: before message_stop)
  rt.pushEvent(msgStop());
  await flush(30);

  const am = frames.filter((f) => f.type === "assistant_message");
  assert.equal(am.length, 1, "⑩ single final assistant_message");
  const starts = frames.filter((f) => f.type === "stream_start");
  assert.equal(am[0].streamId, starts[0].streamId, "⑩ correlation streamId matches the open stream");
  assert.equal(am[0].blockIndex, 0, "⑩ correlation blockIndex = SDK content-block index");
  assert.equal(am[0].content, "最终正文");

  // Whole-frame authority persists exactly the content (schema unchanged).
  const stored = chatStore.getMessages(chatId).filter((m: any) => m.role === "assistant");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].content, "最终正文", "⑩ persisted content has no correlation fields");
  session.close();
  console.log("✓ ⑩ assistant_message carries streamId/blockIndex");
}

// ─── ⑪ A2UI split association rules ─────────────────────────────────────
{
  const { session, rt, chatId, frames } = await makeHarness("c11");
  session.sendMessage("hi");
  await flush();
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "卡前"));
  const whole = `卡前文本<a2ui-json>${JSON.stringify(VALID_FORM_BLOCK)}</a2ui-json>卡后文本`;
  rt.pushEvent(assistantTextFrame(whole));
  rt.pushEvent(msgStop());
  await flush(30);

  const starts = frames.filter((f) => f.type === "stream_start");
  const streamId = starts[0].streamId;
  const ams = frames.filter((f) => f.type === "assistant_message");
  assert.equal(ams.length, 2, "⑪ pre-card + post-card text segments");
  assert.equal(ams[0].content, "卡前文本");
  assert.equal(ams[0].streamId, streamId, "⑪ FIRST text segment exclusively carries the correlation");
  assert.equal(ams[0].blockIndex, 0);
  assert.equal(ams[1].content, "卡后文本");
  assert.equal(ams[1].streamId, undefined, "⑪ later text segments are independent entries (no correlation)");

  const cards = frames.filter((f) => f.type === "a2ui_block");
  assert.equal(cards.length, 1, "⑪ one a2ui_block");
  assert.equal(cards[0].streamId, streamId, "⑪ a2ui_block carries streamId as lifecycle metadata");
  assert.equal(cards[0].blockIndex, undefined, "⑪ a2ui_block is not a replacement target");

  // Raw content (with tags) is what lands in chatStore — history replay parity.
  const stored = chatStore.getMessages(chatId).filter((m: any) => m.role === "assistant");
  assert.equal(stored[0].content, whole, "⑪ persisted raw content unchanged");
  session.close();
  console.log("✓ ⑪ A2UI split association (exclusive replacement right)");
}

// ─── ⑫ malformed A2UI retry notice does not claim the correlation ───────
{
  const { session, rt, frames } = await makeHarness("c12");
  session.sendMessage("hi");
  await flush();
  rt.pushEvent(msgStart());
  rt.pushEvent(blkStart(0, "text"));
  rt.pushEvent(textDelta(0, "即将出卡的预览"));
  const malformed = `预览文本<a2ui-json>{"type":"form",}</a2ui-json>`;
  rt.pushEvent(assistantTextFrame(malformed));
  rt.pushEvent(msgStop());
  await flush(30);

  const ams = frames.filter((f) => f.type === "assistant_message");
  const notice = ams.find((f) => String(f.content).includes("交互卡片格式异常"));
  assert.ok(notice, "⑫ retry notice broadcast");
  assert.equal(notice!.streamId, undefined, "⑫ retry notice carries NO correlation (preview not replaced)");
  assert.equal(notice!.blockIndex, undefined, "⑫ retry notice carries no blockIndex");
  // The regeneration request reached the runtime (internal record).
  const rtAny = (session as any).runtime as FakeRT;
  assert.ok(
    rtAny.sent.some((s) => s.includes("重新输出完整") || s.includes("a2ui-json")),
    "⑫ regeneration feedback dispatched to the runtime"
  );
  session.close();
  console.log("✓ ⑫ malformed-A2UI retry leaves the preview unclaimed");
}

// ─── ⑬ whole-frame-only provider ────────────────────────────────────────
{
  const { session, rt, frames } = await makeHarness("c13");
  session.sendMessage("hi");
  await flush();
  // NO stream events at all — provider emits whole frames only.
  rt.pushEvent(assistantThinkingFrame("整帧 provider 的思考"));
  rt.pushEvent(assistantTextFrame("整条正文"));
  rt.pushEvent(resultFrame());
  await flush(30);

  assert.equal(streamFrames(frames).length, 0, "⑬ no stream_start/delta/end synthesized");
  const tb = frames.filter((f) => f.type === "thinking_block");
  assert.equal(tb.length, 1, "⑬ thinking still surfaces (lazy identity, V6)");
  assert.ok(typeof tb[0].streamId === "string");
  assert.equal(tb[0].final, true);
  const am = frames.filter((f) => f.type === "assistant_message");
  assert.equal(am.length, 1);
  assert.equal(am[0].content, "整条正文");
  assert.equal(am[0].streamId, undefined, "⑬ plain whole-frame text has no correlation");
  session.close();
  console.log("✓ ⑬ whole-frame-only provider behavior");
}

// ─── ⑭ kill-switch regression ───────────────────────────────────────────
{
  const { session, rt, frames } = await makeHarness("c14");
  session.sendMessage("hi");
  await flush();
  process.env.AGENT_STREAMING_ENABLED = "false";
  try {
    rt.pushEvent(msgStart());
    rt.pushEvent(blkStart(0, "text"));
    rt.pushEvent(textDelta(0, "关闭后的 delta"));
    rt.pushEvent(assistantTextFrame("整帧兜底"));
    rt.pushEvent(msgStop());
    rt.pushEvent(resultFrame());
    await flush(30);
    assert.equal(streamFrames(frames).length, 0, "⑭ kill-switch: zero stream frames");
    const am = frames.filter((f) => f.type === "assistant_message");
    assert.equal(am.length, 1, "⑭ whole-frame path intact");
    assert.equal(am[0].content, "整帧兜底");
  } finally {
    process.env.AGENT_STREAMING_ENABLED = undefined;
  }
  session.close();
  console.log("✓ ⑭ AGENT_STREAMING_ENABLED=false restores whole-frame-only behavior");
}

console.log("\nAll streaming contract cases passed (①–⑭).");
