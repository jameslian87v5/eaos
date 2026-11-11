/**
 * Focused tests — M3-S3B: Host egress credential proxy + the Guest↔Host
 * model-call loop.
 *
 * Covers the S3B acceptance asks:
 *   EP.* proxy: request allow/deny, credential missing, target validation
 *               (scheme + private addresses), timeout, oversize
 *               request/response, error/body redaction, config resolution;
 *   LR.* loop:  Guest intent out (no credential/model choice), Host
 *               requestId anti-forgery + governed model stamping, redacted
 *               model_result → platform events via the committed adapter,
 *               fail-closed refusals, Guest-no-key structural guarantee.
 *
 * All fakes are injected (env/fetch/resolver) — no network, no real msb.
 * CRED is a FAKE marker value, never a real key.
 *
 * Run: npx tsx server/m3-s3b-egress.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMMITTED_EGRESS_PATH,
  COMMITTED_EGRESS_PROVIDER,
  MAX_REQUEST_BYTES,
  ModelEgressProxy,
  resolveModelEgressTarget,
  type ModelEgressCallRequest,
} from "./model-egress-proxy.js";
import { serializeFrame, type PlatformRuntimeEvent } from "./platform-runtime-protocol.js";
import { WorkerProtocolEndpoint } from "./local-agent-worker-protocol.js";
import { createWorkerSession } from "../worker/local-agent-entry.js";
import { ClaudeHarnessAdapter } from "../worker/harness/claude-harness-adapter.js";
import {
  createMicrosandboxRuntime,
  type WorkerLauncher,
} from "./microsandbox-runtime.js";
import {
  PINNED_GUEST_IMAGE,
  PINNED_MSB_VERSION,
  type MicrosandboxLaunchPolicyInput,
} from "./microsandbox-policy.js";
import { compilePolicyInput, createResolvedExecutionPolicy } from "./resolved-execution-policy.js";

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

/** FAKE credential marker — never a real key; proves absence everywhere. */
const CRED = "TEST-SECRET-CREDENTIAL-MARKER-000";
const PUBLIC_ADDR = "93.184.216.34";
type FetchSpy = NonNullable<import("./model-egress-proxy.js").ModelEgressProxyDeps["fetch"]>;

/** Build a proxy over a fully controlled env + optional fetch spy.
 *  env is captured BY REFERENCE — tests can rotate/remove values after
 *  construction to prove call-time fail-closed behavior. */
function makeProxy(
  envOver: Record<string, string | undefined>,
  fetchImpl?: FetchSpy,
  resolveHost?: (h: string) => Promise<string[]>,
): ModelEgressProxy {
  return new ModelEgressProxy({
    env: () => envOver,
    ...(resolveHost ? { resolveHost } : { resolveHost: async () => [PUBLIC_ADDR] }),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
const OK_BODY = JSON.stringify({ content: [{ type: "text", text: "proxied answer" }], usage: { input_tokens: 3, output_tokens: 4 } });
const VALID_PAYLOAD = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });

// ─── EP: egress proxy validation + redaction ────────────────────────────────

atest("EP.1: allow — committed provider/path on a public https target; connection PINNED to the validated address, authority preserved; Host stamps the governed model; credential reaches ONLY the provider call", async () => {
  let fetched: import("./model-egress-proxy.js").EgressHttpRequest | null = null;
  const proxy = makeProxy(
    { MODEL_EGRESS_BASE_URL: "https://api.provider.example/", ANTHROPIC_AUTH_TOKEN: CRED },
    (req) => {
      fetched = { ...req, headers: { ...req.headers } };
      return Promise.resolve({ status: 200, text: async () => OK_BODY });
    },
  );
  const res = await proxy.execute(
    { requestId: "r1", provider: "claude", path: "/v1/messages", payload: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "smuggled-model", stream: true }) },
    "opus",
  );
  assert.equal(res.ok, true, res.error);
  assert.equal(res.status, 200);
  assert.equal(fetched!.url, `https://${PUBLIC_ADDR}/v1/messages`, "connection targets the VALIDATED address, not a re-resolvable hostname");
  assert.equal(fetched!.hostHeader, "api.provider.example", "original authority preserved as Host/TLS identity");
  const sent = JSON.parse(fetched!.body) as { model: string; stream: boolean };
  assert.equal(sent.model, "opus", "Guest-smuggled model must be OVERWRITTEN by the governed modelRef");
  assert.equal(sent.stream, false, "stream forced off (request/response loop)");
  assert.equal(fetched!.headers.authorization, `Bearer ${CRED}`, "credential travels ONLY in the provider header");
  assert.ok(!res.body!.includes(CRED), "credential never in the returned body");
  assert.ok(!res.error, "no error on success");
});

atest("EP.2: deny — unknown provider / unknown path fail closed before any fetch", async () => {
  let called = 0;
  const proxy = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, () => { called++; return Promise.resolve({ status: 200, text: async () => OK_BODY }); });
  const p = await proxy.execute({ requestId: "r", provider: "openai", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(p.ok, false); assert.match(p.error!, /not the committed engine/);
  const q = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/chat/completions", payload: VALID_PAYLOAD }, "opus");
  assert.equal(q.ok, false); assert.match(q.error!, /not the committed endpoint/);
  assert.equal(called, 0, "denied requests never reach the provider");
});

atest("EP.3: credential missing at call time → fail closed, no credential-shaped leak in the error", async () => {
  const env: Record<string, string | undefined> = { MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED };
  const proxy = makeProxy(env, () => Promise.resolve({ status: 200, text: async () => OK_BODY }));
  // credential vanishes between construction and the call (rotation/env drift)
  delete env.ANTHROPIC_AUTH_TOKEN;
  const r = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(r.ok, false, "constructor-time presence does not buy call-time trust");
  assert.match(r.error!, /host credential absent/);
  assert.ok(!r.error!.includes(CRED));
  assert.equal(resolveModelEgressTarget({ env: () => ({}) }), null, "unconfigured env resolves to null target");
});

atest("EP.4: target validation — non-https scheme and private/loopback/link-local/metadata addresses are refused", async () => {
  let called = 0;
  const spy: FetchSpy = () => { called++; return Promise.resolve({ status: 200, text: async () => OK_BODY }); };
  const http = makeProxy({ MODEL_EGRESS_BASE_URL: "http://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, spy);
  assert.match((await http.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus")).error!, /not https/);
  for (const bad of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "169.254.169.254", "::1", "fd12::1"]) {
    const proxy = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, spy, async () => [bad]);
    const r = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
    assert.equal(r.ok, false, `${bad} must be refused`);
    assert.match(r.error!, /non-public address/);
  }
  // IP-literal base URL is checked without DNS
  const literal = makeProxy({ MODEL_EGRESS_BASE_URL: "https://10.0.0.9", ANTHROPIC_AUTH_TOKEN: CRED }, spy);
  assert.match((await literal.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus")).error!, /non-public address/);
  // unresolvable host fails closed
  const dead = makeProxy({ MODEL_EGRESS_BASE_URL: "https://no-such.host.example", ANTHROPIC_AUTH_TOKEN: CRED }, spy, async () => { throw new Error("ENOTFOUND"); });
  assert.match((await dead.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus")).error!, /does not resolve/);
  assert.equal(called, 0, "no refused target ever reached the provider");
});

atest("EP.4b: DNS rebinding / TOCTOU — DNS is consulted ONCE; the connection is PINNED to the validated address; a rebind between check and connect cannot reach the provider transport", async () => {
  // The hostile resolver hands back a public address, then (were the proxy to
  // re-resolve) a private one — a classic rebinding flip.
  let resolves = 0;
  let fetched: import("./model-egress-proxy.js").EgressHttpRequest | null = null;
  const proxy = makeProxy(
    { MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED },
    (req) => {
      fetched = { ...req, headers: { ...req.headers } };
      return Promise.resolve({ status: 200, text: async () => OK_BODY });
    },
    async () => { resolves++; return resolves === 1 ? [PUBLIC_ADDR] : ["10.6.6.6"]; },
  );
  const r = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(r.ok, true, r.error);
  assert.equal(resolves, 1, "hostname resolved exactly once — no second lookup between validation and connect");
  assert.equal(fetched!.url, `https://${PUBLIC_ADDR}/v1/messages`, "transport target is the PINNED validated address, never the hostname again");
  assert.equal(fetched!.hostHeader, "api.provider.example", "Host header + TLS identity stay on the real authority");

  // Second call sees the flipped (private) DNS answer — refused before transport.
  const r2 = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(r2.ok, false, "rebound answer must be refused");
  assert.match(r2.error!, /non-public address/);
});

atest("EP.4c: IPv4-mapped IPv6 — ::ffff:x.x.x.x (dotted + hex) is normalized to IPv4 BEFORE the refusal checks (loopback/RFC1918/link-local/metadata/CGNAT)", async () => {
  let called = 0;
  const spy: FetchSpy = () => { called++; return Promise.resolve({ status: 200, text: async () => OK_BODY }); };
  for (const mapped of [
    "::ffff:127.0.0.1",      // loopback (dotted)
    "::ffff:10.1.2.3",       // RFC1918 (dotted)
    "::ffff:192.168.0.5",    // RFC1918 (dotted)
    "::ffff:169.254.169.254", // link-local/metadata (dotted)
    "::ffff:100.64.0.1",     // CGNAT alias (dotted)
    "::ffff:7f00:1",         // loopback (hex 127.0.0.1)
    "::ffff:a00:203",        // RFC1918 (hex 10.0.2.3)
  ]) {
    const proxy = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, spy, async () => [mapped]);
    const r = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
    assert.equal(r.ok, false, `${mapped} must be refused`);
    assert.match(r.error!, /non-public address/);
  }
  // Positive control: a MAPPED PUBLIC address normalizes through and the
  // connection pins to the UNWRAPPED IPv4.
  let fetched: import("./model-egress-proxy.js").EgressHttpRequest | null = null;
  const ok = makeProxy(
    { MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED },
    (req) => { fetched = { ...req, headers: { ...req.headers } }; return Promise.resolve({ status: 200, text: async () => OK_BODY }); },
    async () => [`::ffff:${PUBLIC_ADDR}`],
  );
  const good = await ok.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(good.ok, true, good.error);
  assert.equal(fetched!.url, `https://${PUBLIC_ADDR}/v1/messages`, "mapped-public unwraps to the IPv4 pin");
  assert.equal(called, 0, "none of the refused mapped forms ever reached transport");
});

atest("EP.5: timeout — a stalled provider is aborted by OUR timer and reported as a bounded timeout error", async () => {
  // The fake honors the abort signal like real fetch — only the proxy's own
  // timer can turn the rejection into "timeout" (transport AbortErrors are not).
  const proxy = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, (req) => new Promise((_res, rej) => {
    req.signal.addEventListener("abort", () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      rej(e);
    });
  }));
  const t0 = Date.now();
  const r = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD, timeoutMs: 1000 }, "opus");
  assert.equal(r.ok, false);
  assert.match(r.error!, /egress timeout after 1000ms/);
  assert.ok(Date.now() - t0 >= 950, "timeout honored (clamped floor 1s)");
});

atest("EP.6: oversize — request >256KB refused pre-fetch; response >1MB refused post-fetch; malformed payloads refused", async () => {
  let called = 0;
  const proxy = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, () => { called++; return Promise.resolve({ status: 200, text: async () => OK_BODY }); });
  const big = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(MAX_REQUEST_BYTES) }] }) }, "opus");
  assert.equal(big.ok, false); assert.match(big.error!, /payload exceeds/);
  const notJson = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: "not-json" }, "opus");
  assert.match(notJson.error!, /not valid JSON/);
  const emptyMsgs = await proxy.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: JSON.stringify({ messages: [] }) }, "opus");
  assert.match(emptyMsgs.error!, /non-empty messages array/);
  assert.equal(called, 0, "none of the above reached the provider");

  const fat = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, () => Promise.resolve({ status: 200, text: async () => "y".repeat(1024 * 1024 + 1) }));
  const r = await fat.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(r.ok, false); assert.match(r.error!, /response exceeds/);
  assert.equal(r.body, undefined, "oversize body is never returned");
});

atest("EP.7: redaction — provider errors/bodies echoing the credential come back scrubbed", async () => {
  const leakyError = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, () => Promise.resolve({ status: 500, text: async () => `upstream boom key=${CRED} authorization: Bearer ${CRED}` }));
  const e = await leakyError.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(e.ok, false);
  assert.ok(!e.error!.includes(CRED), "credential value scrubbed from error");
  assert.match(e.error!, /\*\*\*/);
  const leakyBody = makeProxy({ MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED }, () => Promise.resolve({ status: 200, text: async () => `{"echo":"${CRED}"}` }));
  const b = await leakyBody.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(b.ok, true);
  assert.ok(!b.body!.includes(CRED), "credential value scrubbed from body");
});

atest("EP.8: config resolution — env precedence maps credential KIND only (value never surfaces)", () => {
  const t = resolveModelEgressTarget({ env: () => ({ MODEL_EGRESS_BASE_URL: "https://a.example/", ANTHROPIC_AUTH_TOKEN: CRED }) });
  assert.equal(t?.provider, COMMITTED_EGRESS_PROVIDER);
  assert.equal(t?.baseUrl, "https://a.example");
  assert.equal(t?.credentialKind, "authorization-bearer");
  const k = resolveModelEgressTarget({ env: () => ({ ANTHROPIC_BASE_URL: "https://b.example", ANTHROPIC_API_KEY: CRED }) });
  assert.equal(k?.credentialKind, "x-api-key");
  assert.equal(k?.baseUrl, "https://b.example");
  assert.ok(!JSON.stringify(t).includes(CRED) && !JSON.stringify(k).includes(CRED), "target config carries no credential value");
  assert.equal(resolveModelEgressTarget({ env: () => ({ ANTHROPIC_AUTH_TOKEN: CRED }) }), null, "no base URL → null");
  assert.equal(resolveModelEgressTarget({ env: () => ({ MODEL_EGRESS_BASE_URL: "https://a.example" }) }), null, "no credential → null");
});

atest("EP.9: auth failures identify the credential KIND without exposing its value", async () => {
  for (const status of [401, 403]) {
    const bearer = makeProxy(
      { MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_AUTH_TOKEN: CRED },
      () => Promise.resolve({ status, text: async () => `provider body contains ${CRED}` }),
    );
    const result = await bearer.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.error, `auth failed (${status}) using authorization-bearer (ANTHROPIC_AUTH_TOKEN)`);
    assert.ok(!result.error!.includes(CRED), "auth diagnostic never contains the credential value");
  }

  const apiKey = makeProxy(
    { MODEL_EGRESS_BASE_URL: "https://api.provider.example", ANTHROPIC_API_KEY: CRED },
    () => Promise.resolve({ status: 401, text: async () => `provider body contains ${CRED}` }),
  );
  const keyResult = await apiKey.execute({ requestId: "r", provider: "claude", path: "/v1/messages", payload: VALID_PAYLOAD }, "opus");
  assert.equal(keyResult.error, "auth failed (401) using x-api-key (ANTHROPIC_API_KEY)");
  assert.ok(!keyResult.error!.includes(CRED), "API-key diagnostic never contains the credential value");
});

// ─── LR: the Guest↔Host loop ────────────────────────────────────────────────

function launchInput(over: Partial<MicrosandboxLaunchPolicyInput> = {}): MicrosandboxLaunchPolicyInput {
  return {
    msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE,
    memoryMb: 512, cpuCores: 1, workspaceRoots: [{ path: "/workspace", access: "rw" }],
    networkEgress: "none", idleTimeout: "60s", ...over,
  };
}
function hostProxyPolicy() {
  return createResolvedExecutionPolicy({
    ...compilePolicyInput(
      { sdkOptions: { tools: ["Read"], allowedTools: ["Read"] }, mounts: [{ hostPath: "/h", containerPath: "/workspace", readonly: false }] },
      { defaultModel: "opus", memoryMb: 512, cpuCores: 1 },
    ),
    egress: { mode: "host-proxy" },
  });
}
/** Push-model launcher the TEST controls: records Host frames, `deliver`
 *  injects Guest event lines into the runtime sink at will. */
function pushLauncher() {
  let sink: ((t: string) => void) | null = null;
  const frames: string[] = [];
  const launcher: WorkerLauncher = {
    setSink(s) { sink = s; },
    async start() {},
    send(t: string) { frames.push(t); },
    async stop() {},
    async remove() {},
  };
  const deliver = (body: PlatformRuntimeEvent) => sink?.(serializeFrame({ v: "0", seq: ++seqCounter, kind: "event", body }));
  let seqCounter = 0;
  return { launcher, frames, deliver };
}
const CAPS = { streamingText: true, structuredToolEvents: true, preToolApproval: true, sessionResume: true, tokenUsage: true, costUsage: true, mcp: false, a2ui: false, abort: true, contextCompaction: true };

function fakeProxy(result: { ok: boolean; status: number; body?: string; error?: string }) {
  const calls: Array<{ req: ModelEgressCallRequest; model: string }> = [];
  return {
    calls,
    proxy: {
      execute: async (req: ModelEgressCallRequest, model: string) => { calls.push({ req, model }); return result; },
    } as unknown as ModelEgressProxy,
  };
}

/** Guest-side harness: real worker session, captured outbound events. */
function guestHarness() {
  const sent: string[] = [];
  const endpoint = new WorkerProtocolEndpoint({ send: (t) => sent.push(t) });
  const session = createWorkerSession({ endpoint, adapter: new ClaudeHarnessAdapter() });
  const events = (): PlatformRuntimeEvent[] => sent.map((t) => (JSON.parse(t) as { body: PlatformRuntimeEvent }).body);
  return { session, events };
}

atest("LR.1: Host runtime — start→ready, send_message→model_request answered via proxy with the GOVERNED model; model intents never surface on the platform stream", async () => {
  const { launcher, frames, deliver } = pushLauncher();
  const { calls, proxy } = fakeProxy({ ok: true, status: 200, body: OK_BODY });
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: hostProxyPolicy(), skipProbe: true, launcher, egress: { proxy, modelRef: "opus" } });
  await tick();
  deliver({ type: "runtime_ready", capabilities: CAPS });
  await waitUntil(() => rt.getStatus() === "running", "runtime_ready");
  const surfaced: PlatformRuntimeEvent[] = [];
  const reader = (async () => { for await (const e of rt.getEventStream()) surfaced.push(e as PlatformRuntimeEvent); })();
  rt.sendMessage("hello");
  // The simulated Guest turns the send_message into a model_request intent:
  deliver({ type: "model_request", requestId: "local-sandbox-s1-1", provider: "claude", path: COMMITTED_EGRESS_PATH, payload: VALID_PAYLOAD });
  await waitUntil(() => frames.some((f) => JSON.parse(f).body.type === "model_result"), "Host answered with model_result");
  const answer = JSON.parse(frames.find((f) => JSON.parse(f).body.type === "model_result")!).body as { type: string; requestId: string; ok: boolean; body: string };
  assert.equal(answer.type, "model_result");
  assert.equal(answer.requestId, "local-sandbox-s1-1");
  assert.equal(answer.ok, true);
  assert.equal(answer.body, OK_BODY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "opus", "Host stamps the governed modelRef");
  assert.equal(calls[0].req.provider, "claude");
  assert.ok(!surfaced.some((e) => e.type === "model_request"), "model_request is loop-internal, never a platform-visible event");
  await rt.close();
  void reader;
});

atest("LR.2: requestId anti-forgery — a Guest intent the Host did NOT issue is refused without touching the proxy", async () => {
  const { launcher, frames, deliver } = pushLauncher();
  const { calls, proxy } = fakeProxy({ ok: true, status: 200, body: OK_BODY });
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: hostProxyPolicy(), skipProbe: true, launcher, egress: { proxy, modelRef: "opus" } });
  await tick();
  deliver({ type: "runtime_ready", capabilities: CAPS });
  await waitUntil(() => rt.getStatus() === "running", "runtime_ready");
  deliver({ type: "model_request", requestId: "forged-run", provider: "claude", path: COMMITTED_EGRESS_PATH, payload: VALID_PAYLOAD });
  await waitUntil(() => frames.some((f) => JSON.parse(f).body.type === "model_result"), "forged intent answered fail-closed");
  const answer = JSON.parse(frames.find((f) => JSON.parse(f).body.type === "model_result")!).body as { ok: boolean; error?: string };
  assert.equal(answer.ok, false);
  assert.match(answer.error!, /not issued by the host/);
  assert.equal(calls.length, 0, "proxy never executed");
  await rt.close();
});

atest("LR.3: no egress wiring — every Guest model intent is refused (fail closed, Guest never hangs)", async () => {
  const { launcher, frames, deliver } = pushLauncher();
  const rt = createMicrosandboxRuntime({ launchPolicy: launchInput(), policy: hostProxyPolicy(), skipProbe: true, launcher });
  await tick();
  deliver({ type: "runtime_ready", capabilities: CAPS });
  await waitUntil(() => rt.getStatus() === "running", "runtime_ready");
  rt.sendMessage("hello");
  await tick();
  deliver({ type: "model_request", requestId: "local-sandbox-s1-1", provider: "claude", path: COMMITTED_EGRESS_PATH, payload: VALID_PAYLOAD });
  await waitUntil(() => frames.some((f) => JSON.parse(f).body.type === "model_result"), "unconfigured proxy answered fail-closed");
  const answer = JSON.parse(frames.find((f) => JSON.parse(f).body.type === "model_result")!).body as { ok: boolean; error?: string };
  assert.equal(answer.ok, false);
  assert.match(answer.error!, /proxy not configured/);
  await rt.close();
});

atest("LR.4: Guest worker host-proxy loop — intent out (no model/credential), redacted result in → platform events via the committed adapter", () => {
  const { session, events } = guestHarness();
  session.handleCommand({ type: "start", policy: hostProxyPolicy() });
  assert.ok(events().some((e) => e.type === "runtime_ready"), "policy egress host-proxy gates the engine start");

  session.handleCommand({ type: "send_message", runId: "run-1", content: "hello" });
  const mr = events().find((e) => e.type === "model_request") as Extract<PlatformRuntimeEvent, { type: "model_request" }>;
  assert.ok(mr, "send_message becomes a model_request intent");
  assert.equal(mr.requestId, "run-1");
  assert.equal(mr.provider, "claude");
  assert.equal(mr.path, "/v1/messages");
  const payload = JSON.parse(mr.payload) as { messages: Array<{ role: string; content: string }>; model?: string };
  assert.deepEqual(payload.messages, [{ role: "user", content: "hello" }]);
  assert.equal(payload.model, undefined, "Guest payload carries NO model selection — the Host stamps it");
  assert.ok(!mr.payload.includes(CRED), "no credential in the intent");

  session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: OK_BODY });
  assert.ok(events().some((e) => e.type === "assistant_text" && (e as { text?: string }).text === "proxied answer"), "provider text → assistant_text");
  assert.ok(events().some((e) => e.type === "turn_completed"), "terminal turn_completed");
  const tc = events().find((e) => e.type === "turn_completed") as { usage?: { inputTokens?: number } };
  assert.equal(tc.usage?.inputTokens, 3, "usage mapped through the normalizer");

  // conversation history rides the NEXT intent (multi-turn Guest state)
  session.handleCommand({ type: "send_message", runId: "run-2", content: "again" });
  const mr2 = events().filter((e) => e.type === "model_request").pop() as Extract<PlatformRuntimeEvent, { type: "model_request" }>;
  const p2 = JSON.parse(mr2.payload) as { messages: Array<{ role: string; content: string }> };
  assert.equal(p2.messages.length, 3, "user + assistant + user");
  assert.equal(p2.messages[1].role, "assistant");
  assert.equal(p2.messages[1].content, "proxied answer");

  // failed result → engine-category turn failure with the sanitized error
  session.handleCommand({ type: "model_result", requestId: "run-2", ok: false, status: 401, error: "egress refused: provider rejected" });
  assert.ok(events().some((e) => e.type === "turn_failed" && (e as { category?: string }).category === "engine"));

  // unsolicited / stale result after the turn closed → protocol error, never fed to the conversation
  session.handleCommand({ type: "model_result", requestId: "run-2", ok: false, status: 0, error: "late" });
  assert.ok(events().some((e) => e.type === "runtime_error" && (e as { category?: string }).category === "protocol"), "unsolicited model_result refused");
});

atest("LR.5: Guest-no-key — worker entry never reads process.env; no frame anywhere carries the credential", () => {
  const src = readFileSync(new URL("../worker/local-agent-entry.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("process.env"), "Guest worker must never read process.env (host credentials live Host-side only)");
  const { session, events } = guestHarness();
  session.handleCommand({ type: "start", policy: hostProxyPolicy() });
  session.handleCommand({ type: "send_message", runId: "run-1", content: "hello" });
  session.handleCommand({ type: "model_result", requestId: "run-1", ok: true, status: 200, body: OK_BODY });
  assert.ok(!JSON.stringify(events()).includes(CRED), "no credential in any Guest-emitted frame");
});

void main();
