/**
 * Focused tests — local-sandbox-runtime (M3-S2 Session wiring): runtime-mode
 * guard, availability gate (msb config / guest engine assets / credential
 * proxy / resource expressibility / real host paths), bundle→hostMounts +
 * workspace-roots mapping through the one-way compiler, and the Session
 * boundary (unavailability propagates — NO silent local fallback).
 *
 * Run: DB_PATH=/tmp/test-local-sandbox-runtime.db JWT_SECRET=test npx tsx server/local-sandbox-runtime.test.ts
 */
import assert from "node:assert/strict";
import {
  KNOWN_RUNTIME_MODES,
  applyAllowedToolsNarrowing,
  assertKnownRuntimeMode,
  checkLocalSandboxAvailability,
  createLocalSandboxRuntimeFactory,
} from "./local-sandbox-runtime.js";
import { MicrosandboxUnavailableError, type WorkerLauncher } from "./microsandbox-runtime.js";
import { withPlatformEventAdapter } from "./platform-event-adapter.js";
import { sdkCliCheckApplies } from "./sdk-cli-check.js";
import { PolicyValidationError } from "./resolved-execution-policy.js";
import { defaultSettings } from "./runtime-settings.js";
import { Session } from "./session.js";
import { chatStore } from "./chat-store.js";
import { eventStore } from "./event-store.js";
import db from "./database.js";
import { DEFAULT_ORG_ID } from "./request-context.js";
import type { CapabilityBundle } from "./capability-provider.js";
import type { AgentRuntime, RuntimeStatus } from "./agent-runtime.js";

let passed = 0;
let failed = 0;
type Runtime0 = { type: string; [k: string]: unknown };
const tests: Array<[string, () => Promise<void> | void]> = [];
function atest(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}
async function main(): Promise<void> {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

function bundleFixture(over: Partial<CapabilityBundle> = {}): CapabilityBundle {
  return {
    sdkOptions: {
      tools: ["Read", "Grep"],
      allowedTools: ["Read"],
      model: "opus",
      ...over.sdkOptions,
    },
    mounts: [
      { hostPath: "/private/tmp/lsw-skills/x", containerPath: "/opt/agent/plugins/x", readonly: true },
      ...(over.mounts ?? []),
    ],
    env: {},
    ...over,
  } as CapabilityBundle;
}
/** All-green DI deps: engine assets present, proxy ready, real paths OK.
 *  egressTarget is PINNED so green-path tests are deterministic regardless of
 *  the dev shell's ANTHROPIC_ / MODEL_EGRESS_ environment. */
const GREEN_DEPS = {
  engineStatus: () => ({ ok: true, missing: [] }),
  credentialProxyReady: () => true,
  egressTarget: () => ({ provider: "claude" as const, baseUrl: "https://model-egress.example.com", credentialKind: "x-api-key" as const }),
  realpath: (p: string) => p, // argv is captured by the run seam; msb never spawns
};

// ─── SW.1: runtime-mode guard ────────────────────────────────────────────────

atest("SW.1: unknown RUNTIME_MODE refuses; the three known modes pass", () => {
  for (const m of KNOWN_RUNTIME_MODES) assert.doesNotThrow(() => assertKnownRuntimeMode(m));
  assert.throws(() => assertKnownRuntimeMode("k8s"), /unknown RUNTIME_MODE 'k8s'/);
  assert.throws(() => assertKnownRuntimeMode(""), /unknown RUNTIME_MODE ''/);
});

// ─── SW.2: availability gate (default deps = today's honest state) ──────────

atest("SW.2: default availability with NO msb/env config is BLOCKED — engine assets + egress proxy (+ msb config), all reasons reported", () => {
  const saved = { MSB_PATH: process.env.MSB_PATH, MODEL_EGRESS_BASE_URL: process.env.MODEL_EGRESS_BASE_URL, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  delete process.env.MSB_PATH;
  delete process.env.MODEL_EGRESS_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = checkLocalSandboxAvailability({
      chatId: "sw2",
      bundle: bundleFixture(),
      workspaceHostDir: "/private/tmp/lsw-ws-sw2",
      deps: { realpath: (p) => p },
    });
    assert.equal(r.ok, false);
    const joined = r.reasons.join(" | ");
    assert.match(joined, /MSB_PATH not configured/);
    assert.match(joined, /guest engine unavailable.*digest not probeable/);
    assert.match(joined, /model egress proxy not configured/);
    assert.equal(r.reasons.length, 3, `exactly the three reasons, got: ${joined}`);
    // The factory surfaces them as ONE diagnosable throw — no local fallback.
    assert.throws(
      () => createLocalSandboxRuntimeFactory({
        chatId: "sw2",
        bundle: bundleFixture(),
        workspaceHostDir: "/private/tmp/lsw-ws-sw2",
        deps: { realpath: (p) => p },
      }),
      (e: unknown) => {
        assert.ok(e instanceof MicrosandboxUnavailableError);
        assert.match(e.message, /guest engine unavailable/);
        return true;
      },
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v !== undefined) process.env[k] = v; }
  }
});

// ─── SW.3/SW.4: green-path wiring (DI) — mapping through the compiler ───────

function fakeLauncher(framesBySeq: Map<number, string[]>): WorkerLauncher {
  let sink: ((t: string) => void) | null = null;
  return {
    setSink(s) { sink = s; },
    async start() {},
    send(frameText: string) {
      const seq = Number(JSON.parse(frameText).seq) as number;
      for (const line of framesBySeq.get(seq) ?? []) sink?.(line);
    },
    async stop() {},
    async remove() {},
  };
}
const READY_LINE = JSON.stringify({
  v: "0", seq: 1, kind: "event",
  body: { type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } },
});
atest("SW.3: green factory returns an AgentRuntime; start frame carries governed policy incl. workspace roots", async () => {
  const captured: string[] = [];
  const launcher = fakeLauncher(new Map([[1, [READY_LINE]]]));
  const wrap: WorkerLauncher = {
    setSink: (s, o) => launcher.setSink(s, o),
    start: () => launcher.start(),
    send: (t) => { captured.push(t); launcher.send(t); },
    stop: () => launcher.stop(),
    remove: () => launcher.remove(),
  };
  const factory = createLocalSandboxRuntimeFactory({
    chatId: "sw3",
    bundle: bundleFixture(),
    workspaceHostDir: "/private/tmp/lsw-ws-sw3",
    msbPath: "/private/tmp/microsandbox-verify/msb",
    deps: { ...GREEN_DEPS, runtimeDeps: { skipProbe: true, launcher: wrap } },
  });
  const rt: AgentRuntime = factory({ resume: "eng-sess-3" });
  assert.equal(typeof rt.sendMessage, "function");
  assert.equal(typeof rt.getEventStream, "function");
  await new Promise((r) => setTimeout(r, 80)); // startTask: start cmd → handshake
  const startFrame = captured.map((t) => JSON.parse(t) as Runtime0).find((f) => (f.body as Runtime0).type === "start");
  assert.ok(startFrame, "start command captured");
  const policyRoots = ((startFrame.body as Runtime0).policy as { workspacePolicy: { roots: Array<{ path: string; access: string }> } }).workspacePolicy.roots;
  assert.deepEqual(
    policyRoots.map((r) => [r.path, r.access]),
    [["/workspace", "rw"], ["/opt/agent/plugins/x", "ro"]],
  );
  assert.equal((startFrame.body as Runtime0).resumeToken, "eng-sess-3");
  void rt.close();
});

atest("SW.3b: a message sent during MicroVM startup is queued and dispatched after runtime_ready", async () => {
  const sent: Runtime0[] = [];
  let sink: ((text: string) => void) | null = null;
  const launcher: WorkerLauncher = {
    setSink(s) { sink = s; },
    async start() {},
    send(frameText) {
      const frame = JSON.parse(frameText) as Runtime0;
      sent.push(frame);
      if ((frame.body as Runtime0).type === "start") {
        setTimeout(() => sink?.(READY_LINE), 25);
      }
    },
    async stop() {},
    async remove() {},
  };
  const factory = createLocalSandboxRuntimeFactory({
    chatId: "sw3b",
    bundle: bundleFixture(),
    workspaceHostDir: "/private/tmp/lsw-ws-sw3b",
    msbPath: "/private/tmp/microsandbox-verify/msb",
    deps: { ...GREEN_DEPS, runtimeDeps: { skipProbe: true, launcher } },
  });
  const rt = factory({});
  rt.sendMessage("你好");
  await flush10(8);
  assert.equal(sent.filter((f) => (f.body as Runtime0).type === "send_message").length, 0, "message waits for runtime_ready");
  await wait10(
    () => sent.some((f) => (f.body as Runtime0).type === "send_message" && (f.body as Runtime0).content === "你好"),
    "queued message dispatch",
  );
  await rt.close();
});

atest("SW.4: green factory on the DEFAULT launcher path compiles both mounts into the real argv", async () => {
  const calls: string[][] = [];
  const factory = createLocalSandboxRuntimeFactory({
    chatId: "sw4",
    bundle: bundleFixture(),
    workspaceHostDir: "/private/tmp/lsw-ws-sw4",
    msbPath: "/private/tmp/microsandbox-verify/msb",
    deps: {
      ...GREEN_DEPS,
      runtimeDeps: {
        skipProbe: true,
        launcherDeps: { run: (argv: string[]) => { calls.push(argv); return { status: 0, stdout: "", stderr: "", timedOut: false }; }, env: {} },
      },
    },
  });
  const rt = factory({});
  await new Promise((r) => setTimeout(r, 50));
  const runArgv = calls.find((a) => a.includes("create"));
  assert.ok(runArgv, "default-path msb create argv captured");
  const mounts: string[] = [];
  runArgv.forEach((a, i) => { if (runArgv[i - 1] === "--mount-dir") mounts.push(a); });
  // M3 closure: the rw workspace mount carries the HARD write quota compiled
  // from settings.maxWorkspaceMb (default 1024) — not just displayed anymore.
  assert.deepEqual(mounts.sort(), ["/private/tmp/lsw-skills/x:/opt/agent/plugins/x:ro", `/private/tmp/lsw-ws-sw4:/workspace:quota=${defaultSettings.maxWorkspaceMb}M`]);
  void rt.close();
});

// ─── SW.5–8: every blocking condition fails closed (never silently narrowed) ─

atest("SW.5: fractional cpuCores settings are inexpressible → blocked", () => {
  const r = checkLocalSandboxAvailability({
    chatId: "sw5", bundle: bundleFixture(), workspaceHostDir: "/private/tmp/lsw-ws",
    msbPath: "/x/msb", settings: { ...defaultSettings, cpuCores: 0.5 }, deps: GREEN_DEPS,
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" | "), /fractional/);
});

atest("SW.6: memory outside the MicroVM envelope → blocked by validateLocalSandboxSettings", () => {
  const r = checkLocalSandboxAvailability({
    chatId: "sw6", bundle: bundleFixture(), workspaceHostDir: "/private/tmp/lsw-ws",
    msbPath: "/x/msb", settings: { ...defaultSettings, memoryMb: 8192 }, deps: GREEN_DEPS,
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" | "), /envelope/);
});

atest("SW.7: bundle MCP outside /opt/agent/mcp/ → compiler refuses (fail closed)", () => {
  assert.throws(
    () => createLocalSandboxRuntimeFactory({
      chatId: "sw7",
      bundle: bundleFixture({ sdkOptions: { tools: ["Read"], allowedTools: ["Read"], mcpServers: { evil: { command: "/usr/bin/curl" } } } as CapabilityBundle["sdkOptions"] }),
      workspaceHostDir: "/private/tmp/lsw-ws",
      msbPath: "/x/msb",
      deps: GREEN_DEPS,
    }),
    PolicyValidationError,
  );
});

atest("SW.8: workspace host path not real on disk → blocked", () => {
  const r = checkLocalSandboxAvailability({
    chatId: "sw8", bundle: bundleFixture(), workspaceHostDir: "/private/tmp/lsw-gone",
    msbPath: "/x/msb",
    deps: { ...GREEN_DEPS, realpath: () => { throw new Error("ENOENT"); } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(" | "), /not real on disk/);
});

// ─── SW.9: Session boundary — unavailability propagates, never a local fallback ─

atest("SW.9: Session construction propagates local-sandbox unavailability (fail closed, no local fallback)", () => {
  const unavailable = () => {
    throw new MicrosandboxUnavailableError("local-sandbox runtime unavailable: guest engine unavailable", { available: false, reason: "guest engine unavailable" });
  };
  // The sync factory throw escapes the Session constructor → getOrCreateSession
  // → WS handler renders the error. No session, no runtime, no local fallback.
  assert.throws(() => new Session("sw9-chat", unavailable), MicrosandboxUnavailableError);
});

// ─── SW.10: platform-event Session wiring (M3-S2 R1) ─────────────────────────
// A green fake local-sandbox runtime yields PLATFORM events; the adapter
// translates; the EXISTING Session drives assistant text, tool metadata,
// approval routing, run finalization, busy release and runtime errors.

class FakePlatformRuntime implements AgentRuntime {
  sent: string[] = [];
  approvalResults: Array<{ id: string; approved: boolean }> = [];
  private buffer: Runtime0[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  sendMessage(content: string): void { this.sent.push(content); }
  handleApprovalResponse(r: { id: string; approved: boolean }): boolean {
    this.approvalResults.push({ id: r.id, approved: r.approved });
    return true;
  }
  abort(): void {}
  close(): void { this.closed = true; this.wake(); }
  getStatus(): RuntimeStatus { return "running"; }
  async *getEventStream(): AsyncIterable<Runtime0> {
    while (!this.closed) {
      if (this.buffer.length) { yield this.buffer.shift()!; continue; }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  emit(evt: Runtime0): void { this.buffer.push(evt); this.wake(); }
  private wake(): void { const w = this.waiters.shift(); if (w) w(); }
}

const flush10 = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function wait10(pred: () => boolean, what: string, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await flush10(5); }
  throw new Error(`timeout waiting for ${what}`);
}

atest("SW.10: platform events drive the existing Session — text/tools/approval/run/busy/error", async () => {
  const userId = "sw10-user";
  const chat = chatStore.createChat(userId, "SW.10 platform wiring", DEFAULT_ORG_ID);
  const chatId = chat.id;
  const rt = new FakePlatformRuntime();
  const busyLog: boolean[] = [];
  const hooks = {
    onSubscriberCountChange: () => {},
    onAgentBusyChange: (_u: string, _c: string, busy: boolean) => { busyLog.push(busy); },
    onPendingApprovalChange: () => {},
  };
  const wsFrames: Runtime0[] = [];
  const fakeWs = { send: (d: string) => wsFrames.push(JSON.parse(d)), close: () => {}, isAlive: true } as unknown as import("ws").WebSocket;
  const session = new Session(
    chatId,
    () => withPlatformEventAdapter(rt),
    hooks,
    userId,
    { role: "user", orgId: DEFAULT_ORG_ID },
  );
  session.setUserId(userId); // agentSessionRecord → recordEvent/runs persist
  session.subscribe(fakeWs as never);
  session.sendMessage("turn one");
  await wait10(() => rt.sent.length === 1, "sendMessage reached the runtime");

  // assistant_text → broadcastAssistantText path
  rt.emit({ type: "assistant_text", text: "hello from the sandbox", final: true });
  await wait10(() => wsFrames.some((f) => f.type === "assistant_message" && f.content === "hello from the sandbox"), "assistant_message broadcast");

  // tool_requested → tool_use metadata (record + broadcast)
  rt.emit({ type: "tool_requested", toolCallId: "tc-1", toolName: "Write", input: { path: "/workspace/x" } });
  await wait10(() => wsFrames.some((f) => f.type === "tool_use" && f.toolId === "tc-1"), "tool_use broadcast");

  // approval_request → Session approval flow; response routed back to the runtime
  rt.emit({ type: "approval_request", requestId: "ar-1", toolName: "Write", toolCallId: "tc-1", input: { path: "/workspace/x" } });
  await wait10(() => wsFrames.some((f) => f.type === "approval_request" && f.id === "ar-1"), "approval_request broadcast");
  session.handleApprovalResponse({ id: "ar-1", approved: false, message: "no" });
  await wait10(() => rt.approvalResults.some((r) => r.id === "ar-1" && !r.approved), "approval routed back to runtime");

  // tool_result → tool_result metadata with isError
  rt.emit({ type: "tool_result", toolCallId: "tc-1", success: false, output: "denied" });
  await wait10(() => wsFrames.some((f) => f.type === "tool_result" && f.toolId === "tc-1" && f.isError === true), "tool_result broadcast");

  const latestRunStatus = () => (db.prepare("SELECT status FROM agent_runs WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1").get(chatId) as { status: string } | undefined)?.status;
  const runCount = () => (db.prepare("SELECT COUNT(*) AS c FROM agent_runs WHERE chat_id = ?").get(chatId) as { c: number }).c;
  // turn_completed → result success + run finalized + busy released
  rt.emit({ type: "turn_completed", usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01, durationMs: 42 });
  await wait10(() => wsFrames.some((f) => f.type === "result" && f.success === true), "result success broadcast");
  await wait10(() => latestRunStatus() === "success" && runCount() === 1, "agent_runs finalized success");
  const resultEvt = () => JSON.parse((eventStore.getEventsByChat(userId, chatId).filter((e) => e.eventType === "result").slice(-1)[0] ?? { payloadJson: "null" }).payloadJson);
  assert.equal(resultEvt().success, true);
  const ru = resultEvt().usage as { inputTokens: number; outputTokens: number } | undefined;
  assert.equal(ru?.inputTokens, 10, "usage.inputTokens captured");
  assert.equal(ru?.outputTokens, 5, "usage.outputTokens captured");

  // second turn fails → failed run + busy released again
  session.sendMessage("turn two");
  rt.emit({ type: "turn_failed", category: "engine", message: "x" });
  await wait10(() => wsFrames.some((f) => f.type === "result" && f.success === false), "result failure broadcast");
  const failedResult = wsFrames.find((f) => f.type === "result" && f.success === false);
  assert.match(String(failedResult?.error ?? ""), /^turn failed \(engine\)/, "failure result exposes a bounded engine error");
  await wait10(() => latestRunStatus() === "failed" && runCount() === 2, "agent_runs finalized failed");

  // runtime_error → surfaced through the existing result path (busy released)
  const framesBefore = wsFrames.length;
  rt.emit({ type: "runtime_error", category: "io", message: "sandbox died" });
  await wait10(() => wsFrames.length > framesBefore, "runtime_error surfaced");
  assert.ok(wsFrames.slice(framesBefore).some((f) => (f.type === "result" && f.success === false) || f.type === "error"));

  // context_compacted → existing compact_boundary path
  rt.emit({ type: "context_compacted", preTokens: 100, postTokens: 20, trigger: "manual" });
  await wait10(() => eventStore.getEventsByChat(userId, chatId).some((e) => e.eventType === "compact_boundary"), "compact_boundary recorded");

  // unknown future event → no-op, no crash, no frame
  const before = wsFrames.length;
  rt.emit({ type: "future_thing", payload: 1 } as unknown as Runtime0);
  await flush10(50);
  assert.equal(wsFrames.length, before, "unknown platform event produced no frame");

  // busy lifecycle: busy(true) on each send, busy(false) on each terminal result
  assert.deepEqual(busyLog, [true, false, true, false, false], "busy release on completion/failure/runtime_error");
  session.close();
  void session;
});

// ─── SW.11: ALLOWED_TOOLS narrowing reaches the resolved policy ──────────────

atest("SW.11: applyAllowedToolsNarrowing — resolved allowedToolIds carry the override (and unexposed override fails closed)", async () => {
  const captured: string[] = [];
  const launcher = fakeLauncher(new Map([[1, [READY_LINE]]]));
  const wrap: WorkerLauncher = {
    setSink: (s, o) => launcher.setSink(s, o),
    start: () => launcher.start(),
    send: (t) => { captured.push(t); launcher.send(t); },
    stop: () => launcher.stop(),
    remove: () => launcher.remove(),
  };
  const narrowed = applyAllowedToolsNarrowing(bundleFixture(), ["Grep"]); // Grep ⊆ exposed [Read,Grep]
  const factory = createLocalSandboxRuntimeFactory({
    chatId: "sw11",
    bundle: narrowed,
    workspaceHostDir: "/private/tmp/lsw-ws-sw11",
    msbPath: "/private/tmp/microsandbox-verify/msb",
    deps: { ...GREEN_DEPS, runtimeDeps: { skipProbe: true, launcher: wrap } },
  });
  const rt = factory({});
  await new Promise((r) => setTimeout(r, 80));
  const startFrame = captured.map((t) => JSON.parse(t) as Runtime0).find((f) => (f.body as Runtime0).type === "start");
  assert.ok(startFrame, "start command captured");
  const policy = (startFrame.body as Runtime0).policy as { allowedToolIds: string[] };
  assert.deepEqual(policy.allowedToolIds, ["Grep"], "override reached the resolved policy");
  void rt.close();
  // no-op without override (bundle unchanged → original allowedTools)
  const base = bundleFixture();
  assert.equal(applyAllowedToolsNarrowing(base, null), base, "null override → same bundle");
  assert.equal(applyAllowedToolsNarrowing(base, undefined), base, "undefined override → same bundle");
  // override naming an UNEXPOSED tool → policy compiler fails closed (subset check)
  assert.throws(
    () => createLocalSandboxRuntimeFactory({
      chatId: "sw11b",
      bundle: applyAllowedToolsNarrowing(bundleFixture(), ["NotATool"]),
      workspaceHostDir: "/private/tmp/lsw-ws",
      msbPath: "/x/msb",
      deps: GREEN_DEPS,
    }),
    PolicyValidationError,
    "unexposed override tool fails closed at policy compilation",
  );
});

// ─── SW.12: host SDK-CLI gate applies ONLY to local ──────────────────────────

atest("SW.12: sdkCliCheckApplies — local only (docker/local-sandbox skip the host check)", () => {
  assert.equal(sdkCliCheckApplies("local"), true);
  assert.equal(sdkCliCheckApplies("docker"), false);
  assert.equal(sdkCliCheckApplies("local-sandbox"), false);
  assert.equal(sdkCliCheckApplies(""), false);
});

// Run after all atest() registrations above.
void main();
