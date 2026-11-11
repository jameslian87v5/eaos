/**
 * Focused tests — local-agent-worker-protocol (M3-S1): framing bounds,
 * sequence/idempotency, handshake, timeouts, disconnect cleanup, neutrality
 * enforcement. DI only; no real sandbox.
 *
 * Run: npx tsx server/local-agent-worker-protocol.test.ts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_INFLIGHT_COMMANDS,
  WorkerProtocolEndpoint,
  type WorkerTransport,
} from "./local-agent-worker-protocol.js";
import { RUNTIME_PROTOCOL_VERSION, serializeFrame, type ProtocolFrame } from "./platform-runtime-protocol.js";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

/** Capturing transport: records sent frames; host side feeds inbound by hand. */
function capture() {
  const sent: string[] = [];
  const transport: WorkerTransport = { send: (t) => sent.push(t) };
  return { sent, transport };
}
function eventFrame(seq: number, body: Record<string, unknown>): string {
  return serializeFrame({ v: RUNTIME_PROTOCOL_VERSION, seq, kind: "event", body: body as ProtocolFrame["body"] });
}
function readyFrame(seq: number): string {
  return eventFrame(seq, {
    type: "runtime_ready",
    capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: true, a2ui: true, abort: true, contextCompaction: true },
  });
}

// --- WP.1: command path ---
test("WP.1a: sendCommand frames versioned sequential commands", () => {
  const { sent, transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  ep.sendCommand({ type: "start", policy: {} as never });
  ep.sendCommand({ type: "send_message", runId: "r1", content: "hi" });
  const f0 = JSON.parse(sent[0]) as ProtocolFrame;
  const f1 = JSON.parse(sent[1]) as ProtocolFrame;
  assert.equal(f0.seq, 1);
  assert.equal(f1.seq, 2);
  assert.equal(f0.kind, "command");
  assert.equal(f0.body.type, "start");
});
test("WP.1b: in-flight cap fails closed on flooding", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  for (let i = 0; i < MAX_INFLIGHT_COMMANDS; i++) ep.sendCommand({ type: "abort", runId: `r${i}` });
  assert.throws(() => ep.sendCommand({ type: "abort", runId: "overflow" }), /cap exceeded/);
});

// --- WP.2: event path + handshake ---
test("WP.2a: first event must be runtime_ready (worker hello)", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  const out = ep.handleEventFrame(eventFrame(1, { type: "assistant_text", text: "x", final: false }));
  assert.equal(out.length, 0); // rejected + endpoint failed closed
  assert.equal(ep.isClosed, true);
});
test("WP.2b: handshake accepted; later events flow", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  const out = [
    ...ep.handleEventFrame(readyFrame(1)),
    ...ep.handleEventFrame(eventFrame(2, { type: "assistant_text", text: "hello", final: true })),
  ];
  assert.equal(out[0].kind, "event");
  assert.equal((out[1] as { event: { type: string } }).event.type, "assistant_text");
});
test("WP.2c: duplicate seq idempotent drop; gap fails closed", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  ep.handleEventFrame(readyFrame(1));
  const dup = ep.handleEventFrame(eventFrame(1, { type: "assistant_text", text: "x", final: false }));
  assert.equal(dup[0].kind, "duplicate-dropped");
  assert.equal(ep.isClosed, false);
  const gap = ep.handleEventFrame(eventFrame(9, { type: "assistant_text", text: "y", final: false }));
  assert.equal(gap.length, 0);
  assert.equal(ep.isClosed, true); // sequence gap = protocol violation = close
});
test("WP.2d: kind mismatch (event frame into command path) fails closed", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  const r = ep.handleCommandFrame(readyFrame(1));
  assert.equal(r.command, undefined);
  assert.equal(ep.isClosed, true);
});
test("WP.2e: sequence gap on inbound COMMAND path fails closed (not thrown)", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  const ok = serializeFrame({ v: RUNTIME_PROTOCOL_VERSION, seq: 1, kind: "command", body: { type: "send_message", runId: "r", content: "x" } as never });
  assert.equal(ep.handleCommandFrame(ok).command?.type, "send_message");
  const gap = serializeFrame({ v: RUNTIME_PROTOCOL_VERSION, seq: 5, kind: "command", body: { type: "abort", runId: "r" } as never });
  const r = ep.handleCommandFrame(gap); // must NOT throw out of the handler
  assert.equal(r.command, undefined);
  assert.equal(ep.isClosed, true); // gap = protocol violation = endpoint closed
});

// --- WP.3: bounds + neutrality ---
test("WP.3a: oversized inbound frame rejected before parse", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  // Build RAW (serializeFrame would refuse to construct it — that outbound
  // guard is WP-covered in platform tests; here we test the inbound guard).
  const huge = JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, seq: 1, kind: "event", body: { type: "assistant_text", text: "x".repeat(300_000), final: false } });
  assert.ok(Buffer.byteLength(huge, "utf8") > 256 * 1024);
  ep.handleEventFrame(huge);
  assert.equal(ep.isClosed, true);
});
test("WP.3b: engine-private fields in OUTBOUND event refused + closed", () => {
  // session_updated/engineSessionId is the NEUTRAL form — must pass.
  const { sent, transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  ep.sendEvent({ type: "session_updated", engineSessionId: "eng-1" });
  assert.equal(sent.length, 1);
  // The private-key scan must catch a nested raw session_id.
  assert.throws(
    () => ep.sendEvent({ type: "tool_result", toolCallId: "t", success: true, output: { session_id: "leak" } }),
    /engine-private/,
  );
  assert.equal(ep.isClosed, true);
});
test("WP.3c: engine-private fields in INBOUND event dropped + closed", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  ep.handleEventFrame(readyFrame(1));
  const leak = serializeFrame({ v: RUNTIME_PROTOCOL_VERSION, seq: 2, kind: "event", body: { type: "assistant_text", text: "x", final: false, claudeSessionId: "leak" } as never });
  const out = ep.handleEventFrame(leak);
  assert.equal(out.length, 0);
  assert.equal(ep.isClosed, true);
});
test("WP.3d: engine-private fields in OUTBOUND command refused + closed (nothing sent)", () => {
  const { sent, transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  assert.throws(
    () => ep.sendCommand({ type: "send_message", runId: "r", content: "x", claudeSessionId: "leak" } as never),
    /engine-private/,
  );
  assert.equal(ep.isClosed, true);
  assert.equal(sent.length, 0); // refused BEFORE the frame left the endpoint
});
test("WP.3e: engine-private fields in INBOUND command dropped + closed", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  const leak = serializeFrame({ v: RUNTIME_PROTOCOL_VERSION, seq: 1, kind: "command", body: { type: "send_message", runId: "r", content: "x", claudeSessionId: "leak" } as never });
  const r = ep.handleCommandFrame(leak);
  assert.equal(r.command, undefined);
  assert.equal(ep.isClosed, true);
});

// --- WP.4: timeout + disconnect semantics ---
test("WP.4a: command timeout sweep fails closed after DEFAULT_COMMAND_TIMEOUT_MS", () => {
  const { transport } = capture();
  let clock = 0;
  const ep = new WorkerProtocolEndpoint(transport, { now: () => clock, commandTimeoutMs: 1000 });
  ep.sendCommand({ type: "send_message", runId: "r", content: "x" });
  clock = 999;
  assert.equal(ep.sweepTimeouts().length, 0);
  clock = 1001;
  const swept = ep.sweepTimeouts();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].kind, "command-timeout");
});
test("WP.4b: close() → pending commands fail after disconnect grace", () => {
  const { transport } = capture();
  let clock = 1000;
  const ep = new WorkerProtocolEndpoint(transport, { now: () => clock });
  ep.sendCommand({ type: "send_message", runId: "r", content: "x" });
  ep.close();
  clock = 1500;
  assert.equal(ep.sweepTimeouts().length, 0); // still in grace
  clock = 3000 + DEFAULT_COMMAND_TIMEOUT_MS;
  const swept = ep.sweepTimeouts().filter((e) => e.kind === "command-timeout");
  assert.equal(swept.length, 1);
});
test("WP.4c: closed endpoint refuses new traffic (fail closed, no zombie)", () => {
  const { transport } = capture();
  const ep = new WorkerProtocolEndpoint(transport);
  ep.close();
  assert.throws(() => ep.sendCommand({ type: "close" }), /closed/);
  assert.throws(() => ep.sendEvent({ type: "turn_completed" }), /closed/);
  assert.equal(ep.handleEventFrame(readyFrame(1)).length, 0);
});

// --- WP.5: timeout default sanity ---
test("WP.5: sane defaults exported", () => {
  assert.ok(DEFAULT_COMMAND_TIMEOUT_MS >= 5000 && DEFAULT_COMMAND_TIMEOUT_MS <= 120_000);
  assert.ok(MAX_INFLIGHT_COMMANDS >= 8);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
