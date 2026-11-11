/**
 * Focused tests — M3-S1 runtime integration pieces: Claude harness adapter
 * (policy→query compile, SDK→event mapping, capability honesty), the
 * MicrosandboxAgentRuntime minimal lifecycle (DI launcher: create/start/
 * send/stream/abort/close/status + unavailable fail-closed + disconnect
 * cleanup), the Guest entry credential boundary, and the additive-export
 * regression for the existing local/docker surface.
 *
 * Run: npx tsx server/m3-s1-runtime.test.ts   (DI only — no real msb/SDK)
 */
import assert from "node:assert/strict";
import {
  CLAUDE_HARNESS_CAPABILITIES,
  ClaudeHarnessAdapter,
  compileClaudeQueryConfig,
} from "../worker/harness/claude-harness-adapter.js";
import {
  DENY_ALL_CREDENTIAL_BROKER,
  createWorkerSession,
} from "../worker/local-agent-entry.js";
import {
  MicrosandboxAgentRuntime,
  MicrosandboxUnavailableError,
  buildMsbRunArgv,
  createMicrosandboxRuntime,
  type WorkerLauncher,
} from "./microsandbox-runtime.js";
import {
  MicrosandboxPolicyError,
  PINNED_GUEST_IMAGE,
  PINNED_MSB_VERSION,
  createMicrosandboxLaunchPolicy,
  type MicrosandboxLaunchPolicyInput,
} from "./microsandbox-policy.js";
import { compilePolicyInput, createResolvedExecutionPolicy } from "./resolved-execution-policy.js";
import { WorkerProtocolEndpoint } from "./local-agent-worker-protocol.js";
import { serializeFrame, type PlatformRuntimeEvent } from "./platform-runtime-protocol.js";
import * as agentRuntimeModule from "./agent-runtime.js";
import { validateLocalSandboxSettings, defaultSettings } from "./runtime-settings.js";

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
function launchInput(over: Partial<MicrosandboxLaunchPolicyInput> = {}): MicrosandboxLaunchPolicyInput {
  return {
    msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE,
    memoryMb: 512, cpuCores: 1, workspaceRoots: [{ path: "/workspace", access: "rw" }],
    networkEgress: "none", idleTimeout: "60s", ...over,
  };
}
function resolvedPolicy() {
  return createResolvedExecutionPolicy(
    compilePolicyInput(
      { sdkOptions: { tools: ["Read", "Write"], allowedTools: ["Read"] }, mounts: [{ hostPath: "/h", containerPath: "/workspace", readonly: false }] },
      { defaultModel: "opus", memoryMb: 512, cpuCores: 1 },
    ),
  );
}

// ─── HA: Claude harness adapter ─────────────────────────────────────────────

atest("HA.1a: compile maps policy one-way (tools/model/derived approval shape)", () => {
  const cfg = compileClaudeQueryConfig(resolvedPolicy());
  assert.equal(cfg.engineId, "claude");
  assert.equal(cfg.model, "opus");
  assert.deepEqual(cfg.tools, ["Read", "Write"]);
  assert.deepEqual(cfg.allowedTools, ["Read"]);
  assert.deepEqual(cfg.disallowedTools, []);
  assert.deepEqual(cfg.mcpServers, {});
});
atest("HA.1b: resume token compiles through (engine session resume)", () => {
  const cfg = compileClaudeQueryConfig(resolvedPolicy(), { resume: "eng-sess-1" });
  assert.equal(cfg.resume, "eng-sess-1");
  assert.equal(compileClaudeQueryConfig(resolvedPolicy()).resume, undefined);
});
atest("HA.1c: adapter re-checks the governed MCP root (defense in depth)", () => {
  const p = createResolvedExecutionPolicy(
    compilePolicyInput({ sdkOptions: { mcpServers: { ok: { command: "/opt/agent/mcp/srv" } } }, mounts: [] }, { defaultModel: "opus" }),
  );
  assert.equal(compileClaudeQueryConfig(p).mcpServers.ok.command, "/opt/agent/mcp/srv");
});
atest("HA.2a: SDK init → runtime_ready with adapter capabilities; session capture neutral", () => {
  const a = new ClaudeHarnessAdapter();
  const evts = a.mapSdkMessage({ type: "system", subtype: "init", session_id: "raw-sdk-id" });
  assert.equal(evts[0].type, "runtime_ready");
  assert.equal(evts[0].engineSessionId, "raw-sdk-id"); // neutral field name
  const evts2 = a.mapSdkMessage({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
  assert.equal(evts2[0].type, "assistant_text");
});
atest("HA.2b: tool_use/tool_result map to neutral toolCallId events", () => {
  const a = new ClaudeHarnessAdapter();
  const t = a.mapSdkMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "/w/x" } }] } });
  assert.equal(t[0].type, "tool_requested");
  assert.equal((t[0] as { toolCallId: string }).toolCallId, "tu_1");
  const r = a.mapSdkMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } });
  assert.equal(r[0].type, "tool_result");
});
atest("HA.2c: result maps turn_completed with usage+cost; failed subtype → turn_failed", () => {
  const a = new ClaudeHarnessAdapter();
  const ok = a.mapSdkMessage({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.01, duration_ms: 1200 });
  const completed = ok.find((e) => e.type === "turn_completed") as { usage?: { inputTokens: number }; costUsd?: number; durationMs?: number };
  assert.equal(completed.usage?.inputTokens, 5);
  assert.equal(completed.costUsd, 0.01);
  assert.equal(completed.durationMs, 1200);
  const bad = a.mapSdkMessage({ type: "result", subtype: "error_during_execution", message: "boom" });
  assert.equal(bad.some((e) => e.type === "turn_failed"), true);
});
atest("HA.3: capabilities honest — a2ui/mcp false until proven in a real Guest", () => {
  assert.equal(CLAUDE_HARNESS_CAPABILITIES.a2ui, false);
  assert.equal(CLAUDE_HARNESS_CAPABILITIES.mcp, false);
  // everything else declared true is exercised by HA.* above
  assert.equal(CLAUDE_HARNESS_CAPABILITIES.streamingText, true);
  assert.equal(CLAUDE_HARNESS_CAPABILITIES.preToolApproval, true); // approval mapping in normalizer (P-APP-01, regression suite)
});

// ─── WE: worker entry credential boundary ───────────────────────────────────

/** Guest-side session harness: capture outbound events via the transport. */
function workerHarness() {
  const sent: string[] = [];
  const endpoint = new WorkerProtocolEndpoint({ send: (t) => sent.push(t) });
  const session = createWorkerSession({ endpoint, adapter: new ClaudeHarnessAdapter() });
  const sentEvents = (): PlatformRuntimeEvent[] => sent.map((t) => (JSON.parse(t) as { body: PlatformRuntimeEvent }).body);
  return { endpoint, session, sentEvents };
}

atest("WE.1: deny-all broker refuses start with policy category (fail closed)", () => {
  assert.equal(DENY_ALL_CREDENTIAL_BROKER.available, false);
  const { session, sentEvents } = workerHarness();
  session.handleCommand({ type: "start", policy: {} as never });
  assert.equal(sentEvents().some((e) => e.type === "turn_failed" && e.category === "policy"), true);
});
atest("WE.2: send_message before start refused (protocol category)", () => {
  const { session, sentEvents } = workerHarness();
  session.handleCommand({ type: "send_message", runId: "r", content: "x" });
  assert.equal(sentEvents().some((e) => e.type === "runtime_error" && e.category === "protocol"), true);
});

// ─── MR: MicrosandboxAgentRuntime lifecycle (DI launcher) ───────────────────

/** Scripted launcher (push model, M3-S3B): succeeds/fails on demand; records
 *  frame traffic; optionally delivers synthetic Guest frames per Host send. */
function scriptedLauncher(script: { start?: Error; onSend?: (frame: string, deliver: (guestLine: string) => void) => void }): WorkerLauncher & { frames: string[]; stopped: boolean; removed: boolean } {
  let sink: ((t: string) => void) | null = null;
  const launcher = {
    frames: [] as string[],
    stopped: false,
    removed: false,
    setSink(s: (t: string) => void) { sink = s; },
    async start() { if (script.start) throw script.start; },
    send(t: string) {
      launcher.frames.push(t);
      script.onSend?.(t, (line) => sink?.(line));
    },
    async stop() { launcher.stopped = true; },
    async remove() { launcher.removed = true; },
  };
  return launcher;
}
/** Push-model helper: answer the Host `start` command with runtime_ready. */
function replyReady(frame: string, deliver: (guestLine: string) => void): void {
  const body = (JSON.parse(frame) as { body?: { type?: string } }).body;
  if (body?.type === "start") deliver(readyLine(1));
}
function readyLine(seq: number): string {
  return serializeFrame({ v: "0", seq, kind: "event", body: { type: "runtime_ready", capabilities: { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true } } });
}

atest("MR.1: invalid launch policy → MicrosandboxPolicyError at construction", () => {
  assert.throws(() => createMicrosandboxRuntime({ launchPolicy: launchInput({ memoryMb: 99999 }), policy: resolvedPolicy(), skipProbe: true, launcher: scriptedLauncher({}) }), MicrosandboxPolicyError);
});
atest("MR.2: unavailable pinned runtime → MicrosandboxUnavailableError, never local fallback", () => {
  const probeDeps = { stat: () => null }; // binary absent
  assert.throws(
    () => createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), skipProbe: false, probeDeps }),
    (e: unknown) => e instanceof MicrosandboxUnavailableError && /unavailable/.test(e.message),
  );
});
atest("MR.3: happy lifecycle — start→ready→send→events stream (DI)", async () => {
  const launcher = scriptedLauncher({ onSend: replyReady });
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), skipProbe: true, launcher });
  // start task runs async; give it a tick
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(launcher.frames.length, 1); // start command sent
  const events: Runtime0[] = [];
  const reader = (async () => { for await (const e of rt.getEventStream()) events.push(e as Runtime0); })();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.getStatus(), "running");
  rt.sendMessage("hello");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(launcher.frames.length, 2);
  const sendFrame = JSON.parse(launcher.frames[1]);
  assert.equal(sendFrame.body.type, "send_message");
  await rt.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(launcher.removed, true);
  assert.equal(rt.getStatus(), "stopped");
  void reader;
});
atest("MR.4: launcher start failure → crashed + runtime_error event, diagnosable", async () => {
  const launcher = scriptedLauncher({ start: new Error("msb run failed: no HVF") });
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), skipProbe: true, launcher });
  const events: Runtime0[] = [];
  const reader = (async () => { for await (const e of rt.getEventStream()) events.push(e as Runtime0); })();
  await new Promise((r) => setTimeout(r, 10));
  await rt.close();
  await reader;
  assert.equal(rt.getStatus(), "crashed");
  assert.equal(events.some((e) => e.type === "runtime_error" && String((e as { message?: unknown }).message).includes("msb run failed")), true);
});
atest("MR.5: sendMessage while handshake pending → queued, flushed on ready (no drop, no error)", async () => {
  // Handshake is delayed past the first user message: the runtime must queue
  // it (pendingMessages FIFO) instead of erroring, and flush it once ready.
  const launcher = scriptedLauncher({
    onSend: (frame, deliver) => {
      const body = (JSON.parse(frame) as { body?: { type?: string } }).body;
      if (body?.type === "start") setTimeout(() => deliver(readyLine(1)), 40);
    },
  });
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), skipProbe: true, launcher });
  const events: Runtime0[] = [];
  const reader = (async () => { for await (const e of rt.getEventStream()) events.push(e as Runtime0); })();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.getStatus(), "starting");
  rt.sendMessage("early");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.some((e) => e.type === "runtime_error"), false);
  const dispatchedEarly = launcher.frames.filter((f) => (JSON.parse(f) as { body?: { type?: string } }).body?.type === "send_message");
  assert.equal(dispatchedEarly.length, 0);
  await new Promise((r) => setTimeout(r, 60)); // ready arrives → queued message flushes
  const sendFrames = launcher.frames.map((f) => JSON.parse(f) as { body?: { type?: string; content?: string } }).filter((f) => f.body?.type === "send_message");
  assert.equal(sendFrames.length, 1);
  assert.equal(sendFrames[0].body?.content, "early");
  assert.equal(events.some((e) => e.type === "runtime_error"), false);
  await rt.close();
  await reader;
});
atest("MR.5b: pending-message overflow → protocol error (bounded FIFO, still no silent drop)", async () => {
  const launcher = scriptedLauncher({}); // handshake never completes
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), skipProbe: true, launcher });
  const events: Runtime0[] = [];
  const reader = (async () => { for await (const e of rt.getEventStream()) events.push(e as Runtime0); })();
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 9; i++) rt.sendMessage(`m${i}`); // 8 fill the FIFO, 9th overflows
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.some((e) => e.type === "runtime_error" && (e as { category?: unknown }).category === "protocol" && String((e as { message?: unknown }).message).includes("too many messages queued")), true);
  await rt.close();
  await reader;
});
atest("MR.6: resume token rides the start command (engine session resume)", async () => {
  const launcher = scriptedLauncher({ onSend: replyReady });
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), resumeToken: "eng-42", skipProbe: true, launcher });
  await new Promise((r) => setTimeout(r, 10));
  const startFrame = JSON.parse(launcher.frames[0]);
  assert.equal(startFrame.body.resumeToken, "eng-42");
  await rt.close();
});
atest("MR.7: approval routing parity — handleApprovalResponse forwards approval_result", async () => {
  const launcher = scriptedLauncher({ onSend: replyReady });
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), skipProbe: true, launcher });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.handleApprovalResponse({ id: "req-1", approved: false }), true);
  await new Promise((r) => setTimeout(r, 10));
  const frame = JSON.parse(launcher.frames[1]);
  assert.equal(frame.body.type, "approval_result");
  assert.equal(frame.body.approved, false);
  await rt.close();
});

// ─── LA: msb run argv compilation (policy → REAL verified 0.6.18 flags) ─────

const LA_MOUNTS = [{ hostPath: "/private/tmp/m3-ws", guestPath: "/workspace", readonly: false }];
function argvOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
atest("LA.1: policy compiles into empirically verified msb 0.6.18 flags", () => {
  const argv = buildMsbRunArgv(createMicrosandboxLaunchPolicy(launchInput()), "sbx", LA_MOUNTS);
  assert.equal(argv[0], "create", "idle boot: run -d goes stopped when the one-shot command exits (verified live)");
  assert.equal(argvOf(argv, "--name"), "sbx");
  assert.equal(argvOf(argv, "--max-cpus"), "1");
  assert.equal(argvOf(argv, "--max-memory"), "512M");
  assert.equal(argvOf(argv, "--mount-dir"), "/private/tmp/m3-ws:/workspace");
  assert.equal(argvOf(argv, "--security"), "restricted");
  assert.equal(argvOf(argv, "--idle-timeout"), "60s");
  assert.ok(argv.includes("--no-net") && argv.includes("--net-strict"));
  assert.ok(argv.includes(PINNED_GUEST_IMAGE));
});
atest("LA.2: ro root compiles ':ro'; fractional cpu is inexpressible → fail closed", () => {
  // Envelope-legal fractional policy, but msb only accepts integer --max-cpus
  // (verified live: `--max-cpus 0.5` rejected) — refuse instead of rounding.
  const frac = createMicrosandboxLaunchPolicy(launchInput({ cpuCores: 0.5 }));
  assert.throws(() => buildMsbRunArgv(frac, "sbx", LA_MOUNTS), /fractional/);
  const ro = createMicrosandboxLaunchPolicy(launchInput({ workspaceRoots: [{ path: "/workspace", access: "ro" }] }));
  const argv = buildMsbRunArgv(ro, "sbx", [{ hostPath: "/private/tmp/m3-ws", guestPath: "/workspace", readonly: true }]);
  assert.equal(argvOf(argv, "--mount-dir"), "/private/tmp/m3-ws:/workspace:ro");
});
atest("LA.3: mount coverage bidirectional + access-checked (fail closed)", () => {
  const p = createMicrosandboxLaunchPolicy(launchInput());
  assert.throws(() => buildMsbRunArgv(p, "sbx", []), /no host mount/); // uncovered policy root
  assert.throws(
    () => buildMsbRunArgv(p, "sbx", [...LA_MOUNTS, { hostPath: "/private/tmp/extra", guestPath: "/extra", readonly: true }]),
    /outside the policy workspace roots/, // extra mount refused
  );
  assert.throws(
    () => buildMsbRunArgv(p, "sbx", [{ hostPath: "/private/tmp/m3-ws", guestPath: "/workspace", readonly: true }]),
    /access mismatch/, // mounts must faithfully express policy access — either direction of mismatch is refused
  );
  assert.throws(
    () => buildMsbRunArgv(p, "sbx", [{ hostPath: "/private/tmp/../x", guestPath: "/workspace", readonly: false }]),
    /absolute/, // host path traversal refused
  );
  assert.throws(
    () => buildMsbRunArgv(p, "sbx", [...LA_MOUNTS, { hostPath: "/private/tmp/dup", guestPath: "/workspace", readonly: false }]),
    /duplicate/, // duplicate guest path refused
  );
});

// ─── R2: default launcher path wires hostMounts into the real argv ─────────

const R2_MOUNTS = [{ hostPath: "/private/tmp/r2-ws", guestPath: "/workspace", readonly: false }];
function observingRun(sink: string[][]) {
  return (argv: string[]) => {
    sink.push(argv);
    return { status: 0, stdout: "", stderr: "", timedOut: false };
  };
}
atest("R2.1: default launcher (no injection) spawns full argv incl. mounts", async () => {
  const calls: string[][] = [];
  const rt = createMicrosandboxRuntime({
    launchPolicy: launchInput(),
    policy: resolvedPolicy(),
    skipProbe: true,
    hostMounts: R2_MOUNTS,
    launcherDeps: { run: observingRun(calls), env: {}, timeoutMs: 1_000 },
  });
  await new Promise((r) => setTimeout(r, 50)); // startTask fires async start()
  const runArgv = calls.find((a) => a.includes("create"));
  assert.ok(runArgv, "msb create argv captured on the default path");
  assert.equal(argvOf(runArgv, "--max-cpus"), "1");
  assert.equal(argvOf(runArgv, "--max-memory"), "512M");
  assert.equal(argvOf(runArgv, "--mount-dir"), "/private/tmp/r2-ws:/workspace");
  await rt.close();
});
atest("R2.2: default launcher WITHOUT hostMounts fails closed at construction", () => {
  assert.throws(
    () => createMicrosandboxRuntime({
      launchPolicy: launchInput(),
      policy: resolvedPolicy(),
      skipProbe: true,
      launcherDeps: { run: observingRun([]), env: {} }, // no hostMounts
    }),
    (err: unknown) => {
      assert.ok(err instanceof MicrosandboxPolicyError);
      assert.match(err.message, /no host mount/); // policy root uncovered → refuse before any spawn
      return true;
    },
  );
});
atest("R2.3: default launcher with MISMATCHED hostMounts fails closed", () => {
  assert.throws(
    () => createMicrosandboxRuntime({
      launchPolicy: launchInput(),
      policy: resolvedPolicy(),
      skipProbe: true,
      hostMounts: [{ hostPath: "/private/tmp/r2-ws", guestPath: "/workspace", readonly: true }], // policy says rw
      launcherDeps: { run: observingRun([]), env: {} },
    }),
    (err: unknown) => {
      assert.ok(err instanceof MicrosandboxPolicyError);
      assert.match(err.message, /access mismatch/);
      return true;
    },
  );
});

// ─── RG: additive-export regression (local/docker untouched) ────────────────

atest("RG.1: existing runtime surface unchanged + new export additive", () => {
  assert.equal(typeof agentRuntimeModule.createLocalRuntime, "function");
  assert.equal(typeof agentRuntimeModule.LocalAgentRuntime, "function");
  assert.equal(typeof agentRuntimeModule.buildLocalSessionOptions, "function");
  assert.equal(typeof agentRuntimeModule.createMicrosandboxRuntime, "function"); // new, additive
  assert.equal(typeof agentRuntimeModule.MicrosandboxUnavailableError, "function");
});
atest("RG.2: validateLocalSandboxSettings — defaults pass, out-of-envelope fails closed", () => {
  const cfg = validateLocalSandboxSettings(defaultSettings);
  assert.equal(cfg.memoryMb, defaultSettings.memoryMb);
  assert.equal(cfg.defaultModel, defaultSettings.defaultModel);
  assert.throws(() => validateLocalSandboxSettings({ ...defaultSettings, memoryMb: 8192 }), /memoryMb/);
  assert.throws(() => validateLocalSandboxSettings({ ...defaultSettings, cpuCores: 8 }), /cpuCores/);
});
atest("RG.3: AgentRuntime interface contract intact (structural check on MicrosandboxAgentRuntime)", () => {
  // peer adapter implements the SAME interface consumed by Session
  const rt: MicrosandboxAgentRuntime = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: resolvedPolicy(), skipProbe: true, launcher: scriptedLauncher({}) });
  const asInterface: agentRuntimeModule.AgentRuntime = rt;
  assert.equal(typeof asInterface.sendMessage, "function");
  assert.equal(typeof asInterface.abort, "function");
  assert.equal(typeof asInterface.close, "function");
  assert.equal(typeof asInterface.getStatus, "function");
  void asInterface.getEventStream();
});

// Run after all atest() registrations above.
void main();
