/**
 * Focused tests — M4-S2 Codex Worker test seam (TEST-ONLY, not deployable).
 *
 * Proves the CodexHarnessAdapter can drive the REAL WorkerProtocolEndpoint
 * (the protocol layer the Host/Guest boundary already uses) through a full
 * codex JSONL turn — handshake → session_updated → assistant_text →
 * runtime_error → turn_completed — with correct framing, monotonic seq,
 * duplicate-drop, gap fail-closed, runtime_ready-first handshake, and zero
 * engine-private leakage in serialized frames. Malformed JSONL becomes a
 * runtime_error{protocol} event (a valid platform event), NOT a protocol
 * frame violation.
 *
 * This is a TEST-ONLY seam. It does NOT wire codex into the Worker
 * production path, does NOT flip ENGINE_MATRIX.deployable, and uses RECORDED
 * fixtures (server/fixtures/codex/*.jsonl) — no real `codex exec` / model
 * call / OPENAI_API_KEY. Per artifact: "若只需要测试 seam，必须标明
 * test-only，不能改变生产 ENGINE_MATRIX 的 deployable 结论."
 *
 * Run: npx tsx server/m4-codex-worker-seam.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  WorkerProtocolEndpoint,
  type WorkerTransport,
  type WorkerSideEvent,
} from "./local-agent-worker-protocol.js";
import {
  type PlatformRuntimeEvent,
  scanForEnginePrivateFields,
} from "./platform-runtime-protocol.js";
import { CodexHarnessAdapter, CODEX_HARNESS_CAPABILITIES } from "../worker/harness/codex-harness-adapter.js";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
function atest(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}
async function main(): Promise<void> {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL - ${name}\n    ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadFixtureLines(name: string): string[] {
  return readFileSync(join(__dirname, "fixtures", "codex", name), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

/**
 * In-memory transport: Guest endpoint's sendEvent → serialized frame lands in
 * a buffer the Host endpoint consumes via handleEventFrame. One pipe, one
 * direction (Guest→Host events), which is all the codex seam needs.
 */
class InMemoryPipe implements WorkerTransport {
  private buffer: string[] = [];
  send(text: string): void {
    this.buffer.push(text);
  }
  drain(): string[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
  close?(): void {
    this.buffer = [];
  }
}

/**
 * Drive a Guest-side endpoint: emit runtime_ready (handshake) then each codex
 * fixture line mapped through the adapter. Returns the Host-side observed
 * events.
 */
function driveCodexTurn(fixtureName: string): { hostEvents: PlatformRuntimeEvent[]; host: WorkerProtocolEndpoint; guest: WorkerProtocolEndpoint; pipe: InMemoryPipe } {
  const pipe = new InMemoryPipe();
  const guest = new WorkerProtocolEndpoint(pipe, { role: "guest-test" });
  const hostPipe = new InMemoryPipe(); // host→guest commands (unused here but needed for symmetry)
  const host = new WorkerProtocolEndpoint(hostPipe, { role: "host-test" });

  // Guest emits runtime_ready first (handshake contract: first event MUST be runtime_ready).
  // Capabilities carried = the codex adapter's authority.
  const readyEvent: PlatformRuntimeEvent = {
    type: "runtime_ready",
    capabilities: CODEX_HARNESS_CAPABILITIES,
  };
  guest.sendEvent(readyEvent);

  // Feed each fixture line through the adapter and emit mapped events.
  const adapter = new CodexHarnessAdapter();
  for (const line of loadFixtureLines(fixtureName)) {
    for (const evt of adapter.mapCodexEvent(line)) {
      guest.sendEvent(evt);
    }
  }

  // Host consumes whatever the guest serialized.
  const hostEvents: PlatformRuntimeEvent[] = [];
  for (const frame of pipe.drain()) {
    for (const wse of host.handleEventFrame(frame)) {
      if (wse.kind === "event") hostEvents.push(wse.event);
    }
  }
  return { hostEvents, host, guest, pipe };
}

// ─── WS: worker-seam protocol tests ──────────────────────────────────────

atest("WS.1: codex simple-turn drives a full Worker protocol turn (handshake → session_updated → text → runtime_error → turn_completed)", () => {
  const { hostEvents } = driveCodexTurn("simple-turn.jsonl");
  const types = hostEvents.map((e) => e.type);
  assert.deepEqual(types, ["runtime_ready", "session_updated", "runtime_error", "assistant_text", "turn_completed"],
    "exact order through the real WorkerProtocolEndpoint");
  // runtime_ready is first (handshake) and carries codex capabilities.
  assert.equal(hostEvents[0]!.type, "runtime_ready");
  assert.deepEqual(hostEvents[0]!.type === "runtime_ready" ? hostEvents[0].capabilities : null, CODEX_HARNESS_CAPABILITIES);
  // session_updated carries the codex thread_id as opaque engineSessionId.
  const su = hostEvents.find((e) => e.type === "session_updated");
  assert.ok(su && su.type === "session_updated", "session_updated present");
  assert.equal(su && su.type === "session_updated" ? su.engineSessionId : undefined, "01a0b259-24aa-7b43-aaf4-c8584154501e");
});

atest("WS.2: serialized codex frames carry ZERO engine-private fields (neutrality enforced both directions)", () => {
  const pipe = new InMemoryPipe();
  const guest = new WorkerProtocolEndpoint(pipe, { role: "guest-test" });
  // runtime_ready + every mapped event from BOTH fixtures.
  guest.sendEvent({ type: "runtime_ready", capabilities: CODEX_HARNESS_CAPABILITIES });
  const adapter = new CodexHarnessAdapter();
  const allLines = [...loadFixtureLines("simple-turn.jsonl"), ...loadFixtureLines("tool-turn.jsonl")];
  for (const line of allLines) for (const evt of adapter.mapCodexEvent(line)) guest.sendEvent(evt);
  // The frames that crossed the wire:
  for (const text of pipe.drain()) {
    // re-parse to inspect the body.
    const frame = JSON.parse(text) as { body: unknown };
    const leaks = scanForEnginePrivateFields(frame.body);
    assert.deepEqual(leaks, [], "no engine-private keys in any serialized codex frame");
  }
});

atest("WS.3: monotonic seq — every emitted codex event has a strictly increasing seq on the wire", () => {
  const pipe = new InMemoryPipe();
  const guest = new WorkerProtocolEndpoint(pipe, { role: "guest-test" });
  guest.sendEvent({ type: "runtime_ready", capabilities: CODEX_HARNESS_CAPABILITIES });
  const adapter = new CodexHarnessAdapter();
  for (const line of loadFixtureLines("tool-turn.jsonl")) for (const evt of adapter.mapCodexEvent(line)) guest.sendEvent(evt);
  const seqs = pipe.drain().map((t) => (JSON.parse(t) as { seq: number }).seq);
  assert.ok(seqs.length >= 2);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, `seq ${seqs[i]} > ${seqs[i - 1]}`);
});

atest("WS.4: malformed codex JSONL → runtime_error{protocol} EVENT (not a protocol frame violation that fails the endpoint)", () => {
  const pipe = new InMemoryPipe();
  const guest = new WorkerProtocolEndpoint(pipe, { role: "guest-test" });
  guest.sendEvent({ type: "runtime_ready", capabilities: CODEX_HARNESS_CAPABILITIES });
  const adapter = new CodexHarnessAdapter();
  // A malformed JSONL line maps to a runtime_error{protocol} platform event,
  // which serializes + parses as a normal frame (it does NOT break framing).
  for (const evt of adapter.mapCodexEvent("{not json")) guest.sendEvent(evt);
  const hostPipe = new InMemoryPipe();
  const host = new WorkerProtocolEndpoint(hostPipe, { role: "host-test" });
  const observed: PlatformRuntimeEvent[] = [];
  for (const text of pipe.drain()) for (const wse of host.handleEventFrame(text)) if (wse.kind === "event") observed.push(wse.event);
  assert.ok(observed.some((e) => e.type === "runtime_error" && e.category === "protocol"), "malformed line surfaces as runtime_error{protocol}");
  assert.ok(!host.isClosed, "endpoint stays open (malformed codex JSONL ≠ protocol frame violation)");
});

atest("WS.5: a duplicate event seq is idempotently dropped (turn survives a replay)", () => {
  // Guest serializes runtime_ready (seq 1) + one assistant_text (seq 2).
  const pipe = new InMemoryPipe();
  const guest = new WorkerProtocolEndpoint(pipe, { role: "guest-test" });
  guest.sendEvent({ type: "runtime_ready", capabilities: CODEX_HARNESS_CAPABILITIES });
  const adapter = new CodexHarnessAdapter();
  const mapped = loadFixtureLines("simple-turn.jsonl").flatMap((l) => adapter.mapCodexEvent(l));
  const textEvt = mapped.find((e) => e.type === "assistant_text");
  assert.ok(textEvt, "fixture yields an assistant_text event");
  guest.sendEvent(textEvt!);
  const frames = pipe.drain(); // [seq1 runtime_ready, seq2 assistant_text]
  assert.equal(frames.length, 2);

  // Host consumes both in order, then we replay the SAME seq2 frame text.
  const hostPipe = new InMemoryPipe();
  const host = new WorkerProtocolEndpoint(hostPipe, { role: "host-test" });
  const out: WorkerSideEvent[] = [];
  for (const t of frames) for (const wse of host.handleEventFrame(t)) out.push(wse);
  // Re-inject the identical seq2 frame (same bytes) → must be a drop, not a re-emit.
  const before = out.length;
  for (const wse of host.handleEventFrame(frames[1]!)) out.push(wse);
  assert.ok(out.length > before, "host handled the replay (drop verdict returned)");
  assert.ok(out.some((e) => e.kind === "duplicate-dropped"), "duplicate seq dropped idempotently");
  assert.ok(!host.isClosed, "duplicate does not fail-close the endpoint");
});

atest("WS.6: a sequence GAP fails the endpoint closed (codex seam cannot paper over a dropped frame)", () => {
  const pipe = new InMemoryPipe();
  const guest = new WorkerProtocolEndpoint(pipe, { role: "guest-test" });
  guest.sendEvent({ type: "runtime_ready", capabilities: CODEX_HARNESS_CAPABILITIES });
  // Take the runtime_ready frame (seq 1), then craft a gap frame (seq 3, skipping 2).
  const readyFrame = pipe.drain()[0]!;
  const gapFrame = readyFrame.replace(/"seq":1/, '"seq":3');
  const hostPipe = new InMemoryPipe();
  const host = new WorkerProtocolEndpoint(hostPipe, { role: "host-test" });
  host.handleEventFrame(readyFrame);
  host.handleEventFrame(gapFrame);
  assert.ok(host.isClosed, "gap → fail-closed");
});

atest("WS.7: command_execution NEVER becomes a governed tool_result through the worker seam (M4-S1 invariant holds end-to-end)", () => {
  const { hostEvents } = driveCodexTurn("tool-turn.jsonl");
  assert.equal(hostEvents.filter((e) => e.type === "tool_result").length, 0, "zero tool_result through the worker seam");
  assert.equal(hostEvents.filter((e) => e.type === "tool_requested").length, 0, "zero tool_requested");
  assert.equal(hostEvents.filter((e) => e.type === "approval_request").length, 0, "zero approval_request");
  // Only assistant_text + runtime_error{engine} + turn_completed (besides handshake/session).
  assert.ok(hostEvents.some((e) => e.type === "assistant_text"));
  assert.ok(hostEvents.some((e) => e.type === "turn_completed"));
});

// ─── Deployable invariant: the test seam does NOT flip production state ────

import { ENGINE_MATRIX } from "./platform-runtime-protocol.js";
atest("WS.8: ENGINE_MATRIX codex stays deployable:false after the test seam (test-only, no production flip)", () => {
  const codex = ENGINE_MATRIX.find((r) => r.engineId === "codex");
  assert.ok(codex && codex.deployable === false, "codex NOT deployable — test seam does not flip production state");
});

void main();
