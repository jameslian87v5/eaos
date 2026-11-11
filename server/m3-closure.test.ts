/**
 * Focused tests — M3 closure (must-have tail items):
 *   TC.*  Guest tool_use / approval / A2UI end-to-end through the real worker
 *         session (allow / approval-approve / approval-deny / policy-deny
 *         paths; zero network/command capability is structural);
 *   Q.*   workspace write-layer HARD quota (msb mount quota compilation);
 *   N.*   concurrency cap (explicit reject) + orphan reclamation +
 *         startup-failure cleanup;
 *   S.*   guest image release-signature verification (fail closed).
 *
 * All fakes injected — no network, no real msb. CRED is a FAKE marker.
 *
 * Run: npx tsx server/m3-closure.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { createWorkerSession } from "../worker/local-agent-entry.js";
import { ClaudeHarnessAdapter } from "../worker/harness/claude-harness-adapter.js";
import { WorkerProtocolEndpoint } from "./local-agent-worker-protocol.js";
import type { PlatformRuntimeEvent } from "./platform-runtime-protocol.js";
import { compilePolicyInput, createResolvedExecutionPolicy } from "./resolved-execution-policy.js";
import {
  buildMsbRunArgv,
  createMicrosandboxRuntime,
  MicrosandboxUnavailableError,
  type WorkerLauncher,
} from "./microsandbox-runtime.js";
import {
  createMicrosandboxLaunchPolicy,
  guestEngineStatus,
  GUEST_IMAGE_RELEASE_SIGNATURES,
  PINNED_GUEST_IMAGE,
  PINNED_GUEST_IMAGE_DIGEST,
  PINNED_MSB_VERSION,
  WORKSPACE_QUOTA_BOUNDS,
} from "./microsandbox-policy.js";
import {
  createSandboxConcurrencyLimiter,
  reapOrphanMicrovmSandboxes,
  resolveMaxConcurrentSandboxes,
} from "./microsandbox-concurrency.js";
import { createLocalSandboxRuntimeFactory } from "./local-sandbox-runtime.js";
import { defaultSettings } from "./runtime-settings.js";

let passed = 0;
let failed = 0;
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
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, what: string, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await tick(5); }
  throw new Error(`timeout waiting for ${what}`);
}

// ─── fixtures ────────────────────────────────────────────────────────────────

/**
 * Real temp dir standing in for the guest workspace. It IS the policy root
 * (containerPath === hostPath), so the path guard validates real paths AND the
 * tool executor touches the REAL filesystem — no shadow mapping. R1-4: the
 * policy root is the REALPATH form so `realpathSync(file)` resolves to a path
 * under the root (macOS /var → /private/var symlink would break the prefix
 * match otherwise).
 */
const WS = realpathSync(mkdtempSync(join(tmpdir(), "m3-closure-ws-")));

function policyFixture(over: { tools?: string[]; allowed?: string[]; denied?: string[]; maxTurns?: number } = {}) {
  const compiled = compilePolicyInput(
    {
      sdkOptions: {
        model: "opus",
        tools: over.tools ?? ["Read", "Write", "Edit", "Bash", "show_ui"],
        allowedTools: over.allowed ?? ["Read"],
        ...(over.denied ? { disallowedTools: over.denied } : {}),
      },
      mounts: [{ hostPath: WS, containerPath: WS, readonly: false }],
    },
    { defaultModel: "opus", memoryMb: 512, cpuCores: 1 },
  );
  return createResolvedExecutionPolicy({
    ...compiled,
    egress: { mode: "host-proxy" },
    resourcePolicy: { ...compiled.resourcePolicy, ...(over.maxTurns !== undefined ? { maxTurns: over.maxTurns } : {}) },
  });
}

function guestHarness() {
  const sent: string[] = [];
  const endpoint = new WorkerProtocolEndpoint({ send: (t) => sent.push(t), close: () => {} });
  const session = createWorkerSession({ endpoint, adapter: new ClaudeHarnessAdapter() });
  const events = (): PlatformRuntimeEvent[] => sent.map((t) => (JSON.parse(t) as { body: PlatformRuntimeEvent }).body);
  return { session, events };
}

const toolUseBody = (id: string, name: string, input: unknown) =>
  JSON.stringify({ content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 5, output_tokens: 2 } });
const textBody = (text: string) =>
  JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 2 } });

function startTurn(h: ReturnType<typeof guestHarness>, policy = policyFixture()) {
  h.session.handleCommand({ type: "start", policy });
  h.session.handleCommand({ type: "send_message", runId: "run-1", content: "hello" });
  const mr = h.events().find((e) => e.type === "model_request") as Extract<PlatformRuntimeEvent, { type: "model_request" }>;
  assert.ok(mr, "turn opens with a model_request intent");
  return mr;
}
const modelRequests = (h: ReturnType<typeof guestHarness>) =>
  h.events().filter((e): e is Extract<PlatformRuntimeEvent, { type: "model_request" }> => e.type === "model_request");

// ─── TC: Guest tool_use / approval / A2UI end-to-end ─────────────────────────

atest("TC.1 allow path — Read (allowed) executes against the REAL workspace, tool events flow, and the SAME turn continues with a tool_result message", async () => {
  writeFileSync(join(WS, "note.txt"), "quota-proof-content", "utf8");
  const h = guestHarness();
  await startTurn(h);
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("t1", "Read", { file_path: join(WS, "note.txt") }) });
  await waitUntil(() => modelRequests(h).length === 2, "continuation model_request");
  assert.ok(h.events().some((e) => e.type === "tool_requested" && (e as { toolName?: string }).toolName === "Read"), "tool_requested emitted");
  assert.ok(h.events().some((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "t1" && (e as { success?: boolean }).success === true), "tool_result success");
  const continuation = modelRequests(h)[1];
  assert.equal(continuation.requestId, "run-1", "continuation reuses the SAME host-issued runId (one logical turn)");
  const payload = JSON.parse(continuation.payload) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ name?: string }> };
  assert.ok(Array.isArray(payload.tools) && payload.tools.some((t) => t.name === "Read"), "implemented+exposed tools are advertised");
  const last = payload.messages.at(-1);
  const trs = Array.isArray(last?.content) ? (last!.content as Array<{ type: string; tool_use_id?: string; content?: string }>) : [];
  assert.equal(trs[0]?.type, "tool_result");
  assert.equal(trs[0]?.tool_use_id, "t1");
  assert.equal(trs[0]?.content, "quota-proof-content", "Read returned the real file content");
  // Terminal response closes the turn.
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: textBody("done") });
  await waitUntil(() => h.events().some((e) => e.type === "turn_completed"), "turn_completed");
});

atest("TC.2 approval APPROVE path — Write parks on approval_request; approved verdict executes the write; nothing runs before the verdict", async () => {
  const h = guestHarness();
  await startTurn(h);
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("t2", "Write", { file_path: join(WS, "approved.txt"), content: "written-after-approval" }) });
  await waitUntil(() => h.events().some((e) => e.type === "approval_request"), "approval_request parked");
  const appr = h.events().find((e) => e.type === "approval_request") as Extract<PlatformRuntimeEvent, { type: "approval_request" }>;
  assert.equal(appr.toolName, "Write");
  assert.equal(appr.toolCallId, "t2");
  assert.match(String(appr.input ?? ""), /approved\.txt/, "bounded input preview");
  assert.ok(!existsSync(join(WS, "approved.txt")), "NOTHING is written before the verdict");
  assert.equal(modelRequests(h).length, 1, "turn pauses — no continuation while parked");
  h.session.handleCommand({ type: "approval_result", requestId: appr.requestId, approved: true });
  await waitUntil(() => existsSync(join(WS, "approved.txt")), "approved write executed");
  assert.equal(readFileSync(join(WS, "approved.txt"), "utf8"), "written-after-approval");
  await waitUntil(() => modelRequests(h).length === 2, "continuation after approval");
});

atest("TC.3 approval DENY path — rejected Write executes NOTHING and reports the refusal to the model", async () => {
  const h = guestHarness();
  await startTurn(h);
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("t3", "Write", { file_path: join(WS, "denied.txt"), content: "x" }) });
  await waitUntil(() => h.events().some((e) => e.type === "approval_request"), "approval_request parked");
  const appr = h.events().find((e) => e.type === "approval_request") as Extract<PlatformRuntimeEvent, { type: "approval_request" }>;
  h.session.handleCommand({ type: "approval_result", requestId: appr.requestId, approved: false });
  await waitUntil(() => h.events().some((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "t3"), "tool_result refusal");
  const tr = h.events().find((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "t3") as { success?: boolean; output?: string };
  assert.equal(tr.success, false);
  assert.match(tr.output ?? "", /denied by user approval/);
  assert.ok(!existsSync(join(WS, "denied.txt")), "deny = zero writes");
});

atest("TC.4 policy-deny path — unexposed tool AND Bash both execute NOTHING (zero network/command capability is structural)", async () => {
  const src = readFileSync(new URL("../worker/local-agent-entry.ts", import.meta.url), "utf8");
  // Structural: the worker can neither spawn commands nor open sockets — no
  // such IMPORT exists (comments may mention the names; the import is the capability).
  const imports = src.split("\n").filter((l) => l.startsWith("import ")).join("\n");
  assert.ok(!/child_process/.test(imports), "worker cannot spawn commands — no child_process import");
  assert.ok(!/node:(http|https|net|dgram|tls)/.test(imports), "worker has no network capability — no network module imports");
  const h = guestHarness();
  await startTurn(h); // tools=[Read,Write,Edit,Bash], allowed=[Read]
  h.session.handleCommand({
    type: "model_result", requestId: "run-1", ok: true, status: 200,
    body: JSON.stringify({
      content: [
        { type: "tool_use", id: "t4a", name: "WebFetch", input: { url: "https://evil.example" } },
        { type: "tool_use", id: "t4b", name: "Bash", input: { command: "curl https://evil.example" } },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    }),
  });
  await waitUntil(() => h.events().some((e) => e.type === "approval_request" && (e as { toolName?: string }).toolName === "Bash"), "Bash parks for approval");
  const appr = h.events().find((e) => e.type === "approval_request") as Extract<PlatformRuntimeEvent, { type: "approval_request" }>;
  h.session.handleCommand({ type: "approval_result", requestId: appr.requestId, approved: true });
  await waitUntil(() => modelRequests(h).length === 2, "continuation after both refusals");
  const outputs = h.events()
    .filter((e) => e.type === "tool_result")
    .map((e) => String((e as { output?: string }).output ?? ""))
    .join(" | ");
  assert.match(outputs, /not in the exposed tool set/, "unexposed tool refused without execution");
  assert.match(outputs, /not implemented in the MicroVM guest worker/, "even an APPROVED Bash fails closed — no command execution exists");
});

atest("TC.5 A2UI path — show_ui becomes a2ui_request with BOTH chips filtered; the submission returns as the tool_result inside the continuation", async () => {
  const h = guestHarness();
  await startTurn(h);
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("t5", "show_ui", { timeoutSec: 30, items: [{ type: "form", id: "f", fields: [{ id: "name", label: "Name", fieldType: "text" }] }] }) });
  await waitUntil(() => h.events().some((e) => e.type === "a2ui_request"), "a2ui_request parked");
  const a2 = h.events().find((e) => e.type === "a2ui_request") as Extract<PlatformRuntimeEvent, { type: "a2ui_request" }>;
  assert.equal(a2.requestId, "a2ui-t5");
  assert.equal(a2.timeoutSec, 30, "timeoutSec forwarded for the host deadline");
  assert.ok(!h.events().some((e) => e.type === "tool_requested" && (e as { toolName?: string }).toolName === "show_ui"), "no tool_use chip — the card IS the UI");
  assert.equal(modelRequests(h).length, 1, "turn parks while the card is live");
  h.session.handleCommand({ type: "a2ui_result", requestId: "a2ui-t5", result: { status: "submitted", actionId: "ok", values: { name: "Ada" } } });
  await waitUntil(() => modelRequests(h).length === 2, "continuation after a2ui");
  assert.ok(!h.events().some((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "t5"), "no tool_result chip either (card IS the UI)");
  const payload = JSON.parse(modelRequests(h)[1].payload) as { messages: Array<{ role: string; content: unknown }> };
  const trs = payload.messages.at(-1)!.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>;
  const tr = trs.find((b) => b.tool_use_id === "t5")!;
  assert.equal(tr.is_error, false);
  assert.match(tr.content ?? "", /submitted/, "submitted values flow back as the tool result");
});

atest("TC.6 fail-closed edges — unsolicited verdicts are protocol errors; abort during a parked approval fails the turn with no continuation and no write", async () => {
  const h = guestHarness();
  await startTurn(h);
  h.session.handleCommand({ type: "approval_result", requestId: "appr-ghost", approved: true });
  assert.ok(h.events().some((e) => e.type === "runtime_error" && (e as { message?: string }).message?.includes("unsolicited approval_result")), "unsolicited verdict refused");

  const h2 = guestHarness();
  await startTurn(h2);
  h2.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("t6", "Write", { file_path: join(WS, "aborted.txt"), content: "x" }) });
  await waitUntil(() => h2.events().some((e) => e.type === "approval_request"), "approval parked");
  h2.session.handleCommand({ type: "abort", runId: "run-1" });
  await waitUntil(() => h2.events().some((e) => e.type === "turn_failed" && (e as { category?: string }).category === "aborted"), "turn_failed aborted");
  await tick(50);
  assert.equal(modelRequests(h2).length, 1, "no continuation after abort");
  assert.ok(!existsSync(join(WS, "aborted.txt")), "aborted approval wrote nothing");
  // Late verdict after abort → unsolicited (protocol error), never a write.
  h2.session.handleCommand({ type: "approval_result", requestId: "appr-t6", approved: true });
  assert.ok(h2.events().some((e) => e.type === "runtime_error" && (e as { message?: string }).message?.includes("unsolicited approval_result")));
  assert.ok(!existsSync(join(WS, "aborted.txt")));
});

atest("TC.7 tool-round cap — a model looping on tools hits the policy cap and fails closed (no unbounded loop)", async () => {
  const h = guestHarness();
  await startTurn(h, policyFixture({ maxTurns: 1 }));
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("t7", "Read", { file_path: join(WS, "note.txt") }) });
  await waitUntil(() => h.events().some((e) => e.type === "turn_failed" && (e as { category?: string }).category === "policy"), "cap reached");
  assert.match((h.events().find((e) => e.type === "turn_failed") as { message?: string }).message ?? "", /tool round cap/);
  assert.equal(modelRequests(h).length, 1, "no second intent after the cap");
});

// ─── Q: workspace write-layer HARD quota ─────────────────────────────────────

// ─── Q: workspace write-layer HARD quota ─────────────────────────────────────

/** Fake one-shot `run` + duplex spawn for the DEFAULT launcher path (argv
 *  capture without ANY real spawn — the sandbox kills real spawns of the
 *  nonexistent msb binary). */
const fakeLauncherDeps = (calls?: string[][]) => ({
  run: (argv: string[]) => { calls?.push(argv); return { status: 0, stdout: "", stderr: "", timedOut: false }; },
  spawnChild: () => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    on: () => {},
    once: () => {},
    kill: () => {},
  }),
  env: {},
});

const Q_MOUNTS = [
  { hostPath: "/private/tmp/m3c-ws", guestPath: "/workspace", readonly: false },
  { hostPath: "/private/tmp/m3c-skills", guestPath: "/opt/agent/plugins/x", readonly: true },
];

atest("Q.1 quota compiles into the REAL msb argv — rw mount carries quota=<N>M, ro mount stays ro-only", () => {
  const policy = createMicrosandboxLaunchPolicy({
    msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE,
    memoryMb: 512, cpuCores: 1,
    workspaceRoots: [{ path: "/workspace", access: "rw" }, { path: "/opt/agent/plugins/x", access: "ro" }],
    networkEgress: "none", idleTimeout: "60s", workspaceQuotaMb: 512,
  });
  const argv = buildMsbRunArgv(policy, "sbx", Q_MOUNTS);
  const mounts: string[] = [];
  argv.forEach((a, i) => { if (argv[i - 1] === "--mount-dir") mounts.push(a); });
  assert.deepEqual(mounts.sort(), [
    "/private/tmp/m3c-skills:/opt/agent/plugins/x:ro",
    "/private/tmp/m3c-ws:/workspace:quota=512M", // hard, host-enforced
  ]);
});

atest("Q.2 quota without a writable mount is REFUSED (never validated-then-ignored); bad quota values fail policy validation", () => {
  const roPolicy = createMicrosandboxLaunchPolicy({
    msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE,
    memoryMb: 512, cpuCores: 1,
    workspaceRoots: [{ path: "/opt/agent/plugins/x", access: "ro" }],
    networkEgress: "none", idleTimeout: "60s", workspaceQuotaMb: 512,
  });
  assert.throws(() => buildMsbRunArgv(roPolicy, "sbx", [Q_MOUNTS[1]]), /no writable mount/);
  const mk = (q: number) => createMicrosandboxLaunchPolicy({
    msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE,
    memoryMb: 512, cpuCores: 1, workspaceRoots: [{ path: "/workspace", access: "rw" }],
    networkEgress: "none", idleTimeout: "60s", workspaceQuotaMb: q,
  });
  assert.throws(() => mk(WORKSPACE_QUOTA_BOUNDS.minMb - 1), /workspaceQuotaMb/);
  assert.throws(() => mk(512.5), /workspaceQuotaMb/);
  assert.equal(mk(WORKSPACE_QUOTA_BOUNDS.minMb).workspaceQuotaMb, WORKSPACE_QUOTA_BOUNDS.minMb);
});

atest("Q.3 settings → HARD quota: the factory compiles maxWorkspaceMb into the mount argv AND the resolved policy resourcePolicy", () => {
  const calls: string[][] = [];
  const factory = createLocalSandboxRuntimeFactory({
    chatId: "q3",
    bundle: {
      sdkOptions: { model: "opus", tools: ["Read"], allowedTools: ["Read"] },
      mounts: [{ hostPath: "/private/tmp/m3c-skills", containerPath: "/opt/agent/plugins/x", readonly: true }],
      env: {},
    },
    workspaceHostDir: "/private/tmp/m3c-ws-q3",
    msbPath: "/x/msb",
    settings: { ...defaultSettings, maxWorkspaceMb: 256 },
    deps: {
      engineStatus: () => ({ ok: true, missing: [] }),
      credentialProxyReady: () => true,
      egressTarget: () => ({ provider: "claude" as const, baseUrl: "https://api.example", credentialKind: "authorization-bearer" as const }),
      realpath: (p) => p,
      limiter: createSandboxConcurrencyLimiter(8),
      runtimeDeps: { skipProbe: true, launcherDeps: fakeLauncherDeps(calls) },
    },
  });
  const rt = factory({});
  const argv = calls.find((a) => a.includes("create"));
  assert.ok(argv, "create argv captured");
  const ws = argv.find((a, i) => argv[i - 1] === "--mount-dir" && a.startsWith("/private/tmp/m3c-ws-q3:"));
  assert.equal(ws, "/private/tmp/m3c-ws-q3:/workspace:quota=256M", "settings maxWorkspaceMb → hard mount quota");
  void rt.close();
});

// ─── N: concurrency cap + resource reclamation ───────────────────────────────

atest("N.1 limiter — max DISTINCT agents enforced, same-key REJECTED (no re-entry), release frees; env override resolves", () => {
  const l = createSandboxConcurrencyLimiter(2);
  assert.deepEqual(l.tryAcquire("a"), { ok: true });
  assert.deepEqual(l.tryAcquire("b"), { ok: true });
  const c = l.tryAcquire("c");
  assert.equal(c.ok, false, "third DISTINCT agent rejected");
  assert.match((c as { reason: string }).reason, /concurrency cap reached \(2\/2/);
  // R1-2: same-key re-acquire is REJECTED (no refcount, no unlimited re-entry)
  const re = l.tryAcquire("a");
  assert.equal(re.ok, false, "same-key re-entry rejected");
  assert.match((re as { reason: string }).reason, /already holds a slot/);
  assert.deepEqual([...l.heldKeys()].sort(), ["a", "b"]);
  l.release("a");
  assert.deepEqual(l.tryAcquire("c"), { ok: true }, "freed slot reusable");
  assert.equal(resolveMaxConcurrentSandboxes({}), 4, "default cap");
  assert.equal(resolveMaxConcurrentSandboxes({ LOCAL_SANDBOX_MAX_CONCURRENT: "9" }), 9);
  assert.equal(resolveMaxConcurrentSandboxes({ LOCAL_SANDBOX_MAX_CONCURRENT: "0" }), 4, "nonsense falls back to default");
});

atest("N.1b: max=1 limiter — same-key re-entry REJECTED; after release can re-acquire (replacement path)", () => {
  const l = createSandboxConcurrencyLimiter(1);
  assert.deepEqual(l.tryAcquire("chat:a"), { ok: true });
  const re = l.tryAcquire("chat:a");
  assert.equal(re.ok, false, "max=1 same-key re-entry rejected");
  l.release("chat:a");
  assert.deepEqual(l.tryAcquire("chat:a"), { ok: true }, "after release, can re-acquire for the same chat");
});

atest("N.2 factory rejects at the cap and releases on close (REJECT policy, no queue)", async () => {
  const mk = (chatId: string, limiter: ReturnType<typeof createSandboxConcurrencyLimiter>) =>
    createLocalSandboxRuntimeFactory({
      chatId,
      bundle: { sdkOptions: { model: "opus", tools: [], allowedTools: [] }, mounts: [], env: {} },
      workspaceHostDir: `/private/tmp/m3c-${chatId}`,
      msbPath: "/x/msb",
      deps: {
        engineStatus: () => ({ ok: true, missing: [] }),
        credentialProxyReady: () => true,
        egressTarget: () => ({ provider: "claude" as const, baseUrl: "https://api.example", credentialKind: "authorization-bearer" as const }),
        realpath: (p: string) => p,
        limiter,
        runtimeDeps: { skipProbe: true, launcherDeps: fakeLauncherDeps() },
      },
    });
  const limiter = createSandboxConcurrencyLimiter(1);
  const rt = mk("chat-a", limiter)({});
  assert.throws(
    () => mk("chat-b", limiter)({}),
    (e: unknown) => e instanceof MicrosandboxUnavailableError && /concurrency cap/.test(e.message),
    "second DISTINCT sandbox rejected with the cap reason",
  );
  await rt.close();
  mk("chat-b", limiter)({}); // slot released on close → next start admitted
});

atest("N.3 startup-failure cleanup — a failed launcher.start() removes the sandbox and reports crashed (no leftover)", async () => {
  const ops: string[] = [];
  const launcher: WorkerLauncher = {
    setSink: () => {},
    async start() { throw new Error("exec duplex spawn failed"); },
    send: () => {},
    async stop() { ops.push("stop"); },
    async remove() { ops.push("remove"); },
  };
  const rt = createMicrosandboxRuntime({
    launchPolicy: {
      msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE,
      memoryMb: 512, cpuCores: 1, workspaceRoots: [{ path: "/workspace", access: "rw" }],
      networkEgress: "none", idleTimeout: "60s",
    },
    policy: policyFixture(),
    skipProbe: true,
    launcher,
  });
  const events: PlatformRuntimeEvent[] = [];
  void (async () => { for await (const e of rt.getEventStream()) events.push(e as PlatformRuntimeEvent); })();
  await waitUntil(() => rt.getStatus() === "crashed", "crashed status");
  await waitUntil(() => ops.includes("remove"), "sandbox removed");
  assert.deepEqual(ops, ["remove"], "startup failure → sandbox REMOVED (stop only as fallback)");
  await waitUntil(() => events.some((e) => e.type === "runtime_error" && (e as { message?: string }).message?.includes("sandbox start failed")), "start failure surfaced");
  await rt.close();
});

atest("N.4 orphan reaper — untracked eaos-microvm-* sandboxes are stop+rm'd; tracked + foreign names untouched; failures refuse to guess", () => {
  const stops: string[] = [];
  const rms: string[] = [];
  const mkRun = (listBody: string | null) =>
    (argv: string[], _o: { timeoutMs: number; env: NodeJS.ProcessEnv }) => {
      if (argv.includes("list")) return { status: 0, stdout: listBody ?? "", stderr: "" };
      if (argv.includes("stop")) { stops.push(argv[argv.length - 1]); return { status: 0, stdout: "", stderr: "" }; }
      if (argv.includes("rm")) { rms.push(argv[argv.length - 1]); return { status: 0, stdout: "", stderr: "" }; }
      return { status: 1, stdout: "", stderr: "unexpected" };
    };
  const list = JSON.stringify([
    { name: "eaos-microvm-tracked" },
    { name: "eaos-microvm-orphan" },
    { name: "chatapp-microvm-legacy" },
    { name: "someone-elses-sandbox" },
  ]);
  const r = reapOrphanMicrovmSandboxes("/x/msb", ["eaos-microvm-tracked"], { run: mkRun(list), env: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reaped, ["eaos-microvm-orphan", "chatapp-microvm-legacy"], "legacy prefix still reaped after identity rename");
  assert.deepEqual(stops, ["eaos-microvm-orphan", "chatapp-microvm-legacy"]);
  assert.deepEqual(rms, ["eaos-microvm-orphan", "chatapp-microvm-legacy"], "tracked + foreign names untouched");
  assert.equal(reapOrphanMicrovmSandboxes("/x/msb", [], { run: () => ({ status: 1, stdout: "", stderr: "boom" }), env: {} }).ok, false, "list failure → refuse");
  assert.equal(reapOrphanMicrovmSandboxes("/x/msb", [], { run: mkRun("not-json"), env: {} }).ok, false, "unparseable → refuse");
  assert.equal(reapOrphanMicrovmSandboxes("/x/msb", [], { run: mkRun(JSON.stringify({ nope: 1 })), env: {} }).ok, false, "unexpected shape → refuse");
});

// ─── S: guest image release-signature verification ───────────────────────────

atest("S.1 valid chain — pinned digest + valid release signature → engine gate ok (digest pin + checksum + probes unchanged)", () => {
  const r = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST);
  assert.deepEqual(r, { ok: true, missing: [] });
});

atest("S.2 missing signature — a re-pinned digest without release sign-off is UNAVAILABLE", () => {
  const r = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST, { signatures: {} });
  assert.equal(r.ok, false);
  assert.match(r.missing.join(" "), /no release signature/);
});

atest("S.3 tampered signature / wrong key — INVALID, fail closed exactly like a digest mismatch", () => {
  const sig = GUEST_IMAGE_RELEASE_SIGNATURES[PINNED_GUEST_IMAGE];
  const bad = (sig[0] === "c" ? "b" : "c") + sig.slice(1); // flip first hex char
  const r = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST, { signatures: { [PINNED_GUEST_IMAGE]: bad } });
  assert.equal(r.ok, false);
  assert.match(r.missing.join(" "), /release signature INVALID/);
  // A DIFFERENT key's valid signature does not verify under the PLATFORM key.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const foreign = edSign(null, Buffer.from(`${PINNED_GUEST_IMAGE}@${PINNED_GUEST_IMAGE_DIGEST}`), privateKey).toString("hex");
  const r2 = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST, {
    signatures: { [PINNED_GUEST_IMAGE]: foreign },
    signingPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  assert.equal(r2.ok, true, "sanity: same-payload signature verifies under its own key");
  const r3 = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST, { signatures: { [PINNED_GUEST_IMAGE]: foreign } });
  assert.equal(r3.ok, false, "foreign-key signature does not verify under the PLATFORM key");
  assert.match(r3.missing.join(" "), /release signature INVALID|not verifiable/);
});

atest("S.4 signature covers image+digest as a unit — signing a different payload does not verify", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pubPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const wrongPayload = edSign(null, Buffer.from(`other-image@${PINNED_GUEST_IMAGE_DIGEST}`), privateKey).toString("hex");
  const r = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST, {
    signatures: { [PINNED_GUEST_IMAGE]: wrongPayload },
    signingPublicKey: pubPem,
  });
  assert.equal(r.ok, false);
  assert.match(r.missing.join(" "), /release signature INVALID|not verifiable/);
});

// ─── R1 tests (narrow fixes on 6a3cca8) ──────────────────────────────────────

// R1-1: show_ui is in the REAL advertised tool schema when exposed, absent when not.

atest("R1.1a: show_ui appears in model_request.payload.tools ONLY when in the exposed policy set", async () => {
  const h = guestHarness();
  await startTurn(h); // default fixture exposes show_ui
  const payload = JSON.parse(modelRequests(h)[0].payload) as { tools?: Array<{ name?: string; input_schema?: { required?: string[]; properties?: Record<string, { type?: string; enum?: string[] }> } }> };
  assert.ok(Array.isArray(payload.tools), "tools array present");
  const sui = payload.tools.find((t) => t.name === "show_ui");
  assert.ok(sui, "show_ui advertised when exposed");
  assert.ok(sui!.input_schema, "show_ui carries an input_schema");
  // The schema matches the A2UI contract: type enum + title required + timeoutSec.
  const sch = sui!.input_schema!;
  assert.deepEqual(sch.required, ["type", "title"], "show_ui requires type + title");
  assert.deepEqual(sch.properties!.type!.enum, ["form", "confirm", "card", "list"], "show_ui type enum matches A2UI contract");
  assert.equal(sch.properties!.timeoutSec!.type, "integer", "timeoutSec is an integer");

  // show_ui NOT advertised when not in the exposed set
  const h2 = guestHarness();
  await startTurn(h2, policyFixture({ tools: ["Read", "Write"], allowed: ["Read"] }));
  const payload2 = JSON.parse(modelRequests(h2)[0].payload) as { tools?: Array<{ name?: string }> };
  assert.ok(!payload2.tools?.some((t) => t.name === "show_ui"), "show_ui absent when not exposed");
});

atest("R1.1b: show_ui called when NOT exposed → refused zero-exec (no a2ui_request, refusal rides the continuation)", async () => {
  const h = guestHarness();
  await startTurn(h, policyFixture({ tools: ["Read", "Write"], allowed: ["Read"] }));
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("r1b", "show_ui", { type: "form", title: "X", fields: [{ id: "a", label: "A", fieldType: "text" }] }) });
  // show_ui is NOT exposed → deny path: no card is parked, no tool_use chip
  // emitted (both chips filtered by the internal-tool id). The refusal
  // returns as a tool_result inside the continuation model_request.
  await waitUntil(() => modelRequests(h).length === 2, "continuation after refusal");
  await tick(30);
  assert.ok(!h.events().some((e) => e.type === "a2ui_request"), "no card shown for an unexposed show_ui");
  assert.ok(!h.events().some((e) => e.type === "tool_result"), "no tool_result event (both show_ui chips filtered)");
  const payload = JSON.parse(modelRequests(h)[1].payload) as { messages: Array<{ role: string; content: unknown }> };
  const trs = Array.isArray(payload.messages.at(-1)?.content) ? (payload.messages.at(-1)!.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) : [];
  const tr = trs.find((b) => b.tool_use_id === "r1b")!;
  assert.equal(tr.is_error, true);
  assert.match(tr.content ?? "", /not in the exposed tool set/);
});

// R1-2: async start failure releases the slot — can re-acquire without close.

atest("R1.2: async start failure releases the slot (onFatal) — can re-acquire the same chat without close", async () => {
  const ops: string[] = [];
  const launcher: WorkerLauncher = {
    setSink: () => {},
    async start() { throw new Error("exec duplex spawn failed"); },
    send: () => {},
    async stop() { ops.push("stop"); },
    async remove() { ops.push("remove"); },
  };
  const limiter = createSandboxConcurrencyLimiter(1);
  const mk = () =>
    createLocalSandboxRuntimeFactory({
      chatId: "r12",
      bundle: { sdkOptions: { model: "opus", tools: ["Read"], allowedTools: ["Read"] }, mounts: [], env: {} },
      workspaceHostDir: "/private/tmp/m3c-r12",
      msbPath: "/x/msb",
      deps: {
        engineStatus: () => ({ ok: true, missing: [] }),
        credentialProxyReady: () => true,
        egressTarget: () => ({ provider: "claude" as const, baseUrl: "https://api.example", credentialKind: "authorization-bearer" as const }),
        realpath: (p: string) => p,
        limiter,
        runtimeDeps: { skipProbe: true, launcher },
      },
    });
  const rt1 = mk()({});
  await waitUntil(() => rt1.getStatus() === "crashed", "first runtime crashed");
  await waitUntil(() => ops.includes("remove"), "cleanup ran");
  // Slot is released via onFatal — can start a new runtime for the SAME chat
  // without calling rt1.close() first.
  const rt2 = mk()({});
  assert.notEqual(rt2, rt1, "second runtime admitted for the same chat after async failure released the slot");
  await rt2.close();
  try { await rt1.close(); } catch { /* already crashed */ }
});

// R1-3: sign-guest-image.mjs produces a signature accepted by guestEngineStatus; wrong key type exits non-zero.

atest("R1.3: sign-guest-image.mjs — temp ed25519 key → output signature accepted by guestEngineStatus; non-ed25519 key exits non-zero", () => {
  const tmpKey = mkdtempSync(join(tmpdir(), "m3c-sign-")) + "/key.pem";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(tmpKey, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const payload = `${PINNED_GUEST_IMAGE}@${PINNED_GUEST_IMAGE_DIGEST}`;
  const out = execFileSync("node", ["scripts/sign-guest-image.mjs", tmpKey, payload], { encoding: "utf8" });
  const sig = out.match(/signature:\s*([a-f0-9]+)/);
  assert.ok(sig, "script printed a hex signature");
  // The produced signature verifies under the temp public key
  const r = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST, {
    signatures: { [PINNED_GUEST_IMAGE]: sig![1] },
    signingPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  assert.equal(r.ok, true, "guestEngineStatus accepts the script-produced signature");

  // An RSA key is refused with a non-zero exit (catches the old asymmetricKeyType() bug)
  const { privateKey: rsaPriv } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaKey = mkdtempSync(join(tmpdir(), "m3c-sign-")) + "/rsa.pem";
  writeFileSync(rsaKey, rsaPriv.export({ type: "pkcs8", format: "pem" }).toString());
  let rsaExit = 0;
  try { execFileSync("node", ["scripts/sign-guest-image.mjs", rsaKey, payload], { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { rsaExit = (e as { status?: number }).status ?? 1; }
  assert.notEqual(rsaExit, 0, "non-ed25519 key exits non-zero (no TypeError crash)");
  rmSync(tmpKey, { force: true });
  rmSync(rsaKey, { force: true });
});

// R1-4: symlink escape — Read/Write/Edit through a symlink escaping the policy root are refused (zero I/O).

atest("R1.4: symlink escape — Read/Write through a symlink pointing OUTSIDE the policy root are refused with zero I/O", async () => {
  const outside = mkdtempSync(join(tmpdir(), "m3c-outside-"));
  writeFileSync(join(outside, "secret.txt"), "HOST-SECRET", "utf8");
  // Symlink inside the workspace pointing to an outside file
  try { symlinkSync(join(outside, "secret.txt"), join(WS, "escape-read")); } catch { /* already exists */ }
  // Symlink inside the workspace pointing to an outside WRITE target (dangling)
  try { symlinkSync(join(outside, "escape-write-target.txt"), join(WS, "escape-write")); } catch { /* already exists */ }

  const h = guestHarness();
  await startTurn(h); // Read is allowed

  // Read through the symlink → refused (realpath escapes)
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("e1", "Read", { file_path: join(WS, "escape-read") }) });
  await waitUntil(() => h.events().some((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "e1"), "Read refusal");
  const rtr = h.events().find((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "e1") as { success?: boolean; output?: string };
  assert.equal(rtr.success, false);
  assert.match(rtr.output ?? "", /escapes the policy workspace roots/);

  // Write through the symlink → even after approval, refused (symlink target escapes)
  h.session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: toolUseBody("e2", "Write", { file_path: join(WS, "escape-write"), content: "x" }) });
  await waitUntil(() => h.events().some((e) => e.type === "approval_request"), "Write approval parking");
  const appr = h.events().find((e) => e.type === "approval_request") as Extract<PlatformRuntimeEvent, { type: "approval_request" }>;
  h.session.handleCommand({ type: "approval_result", requestId: appr.requestId, approved: true });
  await waitUntil(() => h.events().some((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "e2"), "Write refusal");
  const wtr = h.events().find((e) => e.type === "tool_result" && (e as { toolCallId?: string }).toolCallId === "e2") as { success?: boolean; output?: string };
  assert.equal(wtr.success, false);
  assert.match(wtr.output ?? "", /escapes the writable policy roots/);
  assert.ok(!existsSync(join(outside, "escape-write-target.txt")), "zero I/O outside the workspace");

  rmSync(outside, { recursive: true, force: true });
});

// cleanup temp workspace (keep files for none — tests assert as they go)
process.on("exit", () => { try { rmSync(WS, { recursive: true, force: true }); } catch { /* best-effort */ } });

void main();
