/**
 * Contract tests for the frozen Runtime Protocol v0 + ResolvedExecutionPolicy
 * + ClaudeEventNormalizer (M0.5). Parity case IDs P-* reference
 * docs/02-architecture/runtime-harness-coupling-inventory.md §7.
 *
 * Run: npx tsx server/runtime-protocol.test.ts   (also via test:runtime-protocol)
 * Pure unit tests — no Session/Runtime/DB/network dependency.
 */

import assert from "node:assert/strict";
import {
  CLAUDE_ENGINE_CAPABILITIES,
  FrameSequenceTracker,
  MAX_FRAME_BYTES,
  MAX_TOOL_PAYLOAD_CHARS,
  ProtocolViolationError,
  RUNTIME_PROTOCOL_VERSION,
  maxPromisableLevel,
  parseFrame,
  scanForEnginePrivateFields,
  serializeFrame,
  type EngineCapabilities,
  type ProtocolFrame,
  type PlatformRuntimeEvent,
} from "./platform-runtime-protocol.js";
import {
  PolicyValidationError,
  approvalRequiredToolIds,
  createResolvedExecutionPolicy,
  type ResolvedExecutionPolicyInput,
} from "./resolved-execution-policy.js";
import {
  ClaudeEventNormalizer,
  boundedText,
  redactSecrets,
} from "./claude-event-normalizer.js";

let passed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.error(`  FAIL - ${name}\n    ${(err as Error).message}`);
    }
  })();
}

// --- helpers -----------------------------------------------------------------

function policyInput(overrides: Partial<ResolvedExecutionPolicyInput> = {}): ResolvedExecutionPolicyInput {
  return {
    modelRef: "platform-default",
    exposedToolIds: ["Read", "Grep", "Glob", "Write", "Edit", "Bash", "Skill"],
    allowedToolIds: ["Read", "Grep", "Glob", "Skill"],
    deniedToolIds: [],
    mcpServers: [],
    workspacePolicy: { roots: [{ path: "/workspace", access: "rw" }] },
    networkPolicy: { egress: "none" },
    resourcePolicy: { maxTurns: 100 },
    ...overrides,
  };
}

const n = new ClaudeEventNormalizer();

// --- protocol framing ----------------------------------------------------------

await test("serialize/parse roundtrip", () => {
  const frame = { v: RUNTIME_PROTOCOL_VERSION, seq: 1, kind: "event", body: { type: "turn_completed" } } as const;
  const parsed = parseFrame(serializeFrame(frame));
  assert.equal(parsed.seq, 1);
  assert.equal(parsed.body.type, "turn_completed");
});

await test("version mismatch rejected on serialize AND parse", () => {
  assert.throws(() => serializeFrame({ v: "9", seq: 1, kind: "event", body: { type: "close" } }), ProtocolViolationError);
  assert.throws(() => parseFrame(JSON.stringify({ v: "1", seq: 1, kind: "event", body: { type: "close" } })), ProtocolViolationError);
});

await test("oversize frame rejected", () => {
  const big: ProtocolFrame = { v: RUNTIME_PROTOCOL_VERSION, seq: 1, kind: "event", body: { type: "assistant_text", text: "x".repeat(MAX_FRAME_BYTES), final: false } };
  assert.throws(() => serializeFrame(big), /MAX_FRAME_BYTES/);
});

await test("seq rules: duplicate → idempotent drop, gap → fail closed, 0 → invalid", () => {
  const t = new FrameSequenceTracker();
  assert.equal(t.observe(1), "accept");
  assert.equal(t.observe(2), "accept");
  assert.equal(t.observe(2), "drop-duplicate"); // re-delivery is a no-op
  assert.throws(() => t.observe(4), ProtocolViolationError); // gap
  assert.throws(() => t.observe(0), ProtocolViolationError);
});

await test("parseFrame rejects bad JSON / kind / body", () => {
  assert.throws(() => parseFrame("not-json"), ProtocolViolationError);
  assert.throws(() => parseFrame(JSON.stringify({ v: "0", seq: 1, kind: "banana", body: { type: "close" } })), ProtocolViolationError);
  assert.throws(() => parseFrame(JSON.stringify({ v: "0", seq: 1, kind: "event", body: {} })), ProtocolViolationError);
});

// --- R1 adversarial additions (fix round 1, evt_20260915074905) -----------------

await test("R1: wire whitelist + kind/type consistency enforced on parse AND serialize", () => {
  // kind/type mismatch: "close" is a command type, cannot ride kind:"event"
  assert.throws(
    () => parseFrame(JSON.stringify({ v: "0", seq: 1, kind: "event", body: { type: "close" } })),
    ProtocolViolationError,
  );
  // unknown event type
  assert.throws(
    () => parseFrame(JSON.stringify({ v: "0", seq: 1, kind: "event", body: { type: "pwn" } })),
    /unknown frame body type/,
  );
  // unknown command type
  assert.throws(
    () => parseFrame(JSON.stringify({ v: "0", seq: 1, kind: "command", body: { type: "pwn" } })),
    /unknown frame body type/,
  );
  // event type under command kind and vice versa
  assert.throws(
    () => parseFrame(JSON.stringify({ v: "0", seq: 1, kind: "command", body: { type: "assistant_text" } })),
    ProtocolViolationError,
  );
  // serialize side catches the same bug class in OUR OWN outbound frames
  assert.throws(
    () => serializeFrame({ v: RUNTIME_PROTOCOL_VERSION, seq: 1, kind: "event", body: { type: "close" } }),
    ProtocolViolationError,
  );
  // a well-formed command frame still parses
  const ok = parseFrame(JSON.stringify({ v: "0", seq: 7, kind: "command", body: { type: "compact" } }));
  assert.equal(ok.seq, 7);
  assert.equal(ok.body.type, "compact");
});

await test("R1: parseFrame rejects invalid seq (0 / fractional) as malformed framing", () => {
  const body = { type: "runtime_error", category: "engine", message: "x" };
  assert.throws(() => parseFrame(JSON.stringify({ v: "0", seq: 0, kind: "event", body })), ProtocolViolationError);
  assert.throws(() => parseFrame(JSON.stringify({ v: "0", seq: 1.5, kind: "event", body })), ProtocolViolationError);
});

await test("R1: MAX_FRAME_BYTES enforced as UTF-8 BYTES on both directions (multibyte bypass closed)", () => {
  // 90k CJK chars = 90k UTF-16 units (< cap by char count) but 270k UTF-8 bytes (> cap)
  const big: ProtocolFrame = {
    v: RUNTIME_PROTOCOL_VERSION,
    seq: 1,
    kind: "event",
    body: { type: "assistant_text", text: "你".repeat(90_000), final: false },
  };
  assert.ok(JSON.stringify(big).length < MAX_FRAME_BYTES, "char-count precondition");
  assert.throws(() => serializeFrame(big), /MAX_FRAME_BYTES/);
  // inbound direction: oversized raw text rejected BEFORE JSON parsing
  assert.throws(() => parseFrame("x".repeat(MAX_FRAME_BYTES + 1)), /MAX_FRAME_BYTES/);
  assert.throws(() => parseFrame(`{"x":"${"你".repeat(90_000)}"}`), /MAX_FRAME_BYTES/);
});

// --- neutrality invariant --------------------------------------------------------

await test("P-NEUTRAL: every platform event type serializes without engine-private fields", () => {
  const samples: PlatformRuntimeEvent[] = [
    { type: "runtime_ready", capabilities: CLAUDE_ENGINE_CAPABILITIES },
    { type: "session_updated", engineSessionId: "abc" },
    { type: "assistant_text", text: "hi", final: false },
    { type: "tool_requested", toolCallId: "t1", toolName: "Write", input: { file_path: "/workspace/a.txt" } },
    { type: "tool_result", toolCallId: "t1", success: true, output: "ok" },
    { type: "approval_request", requestId: "r1", toolName: "Bash", toolCallId: "t2", input: { command: "ls" } },
    { type: "a2ui_request", requestId: "r2", block: { title: "x" }, timeoutSec: 60 },
    { type: "workspace_changed", paths: ["output/a.txt"] },
    { type: "turn_completed", usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.01, durationMs: 100 },
    { type: "turn_failed", category: "engine", message: "boom" },
    { type: "runtime_error", category: "protocol", message: "gap" },
    { type: "context_compacted", preTokens: 10, postTokens: 5, trigger: "manual" },
  ];
  for (const ev of samples) {
    assert.deepEqual(scanForEnginePrivateFields(ev), [], ev.type);
  }
  // And the guard actually fires on engine-private payloads:
  assert.deepEqual(scanForEnginePrivateFields({ session_id: "x", inner: { tool_use_id: "y" } }), ["$.session_id", "$.inner.tool_use_id"]);
});

// --- policy construction / validation ----------------------------------------------

await test("P-POL-01: approvalRequired is derived exposed − allowed − denied", () => {
  const p = createResolvedExecutionPolicy(policyInput());
  assert.deepEqual(approvalRequiredToolIds(p), ["Write", "Edit", "Bash"]);
  const p2 = createResolvedExecutionPolicy(policyInput({ deniedToolIds: ["Bash"] }));
  assert.deepEqual(approvalRequiredToolIds(p2), ["Write", "Edit"]);
});

await test("P-POL-01: allowed/denied outside exposed fail closed", () => {
  assert.throws(() => createResolvedExecutionPolicy(policyInput({ allowedToolIds: ["Read", "WebSearch"] })), PolicyValidationError);
  assert.throws(() => createResolvedExecutionPolicy(policyInput({ deniedToolIds: ["Nuke"] })), PolicyValidationError);
});

await test("P-POL-01: allowed ∩ denied = ∅ enforced", () => {
  assert.throws(() => createResolvedExecutionPolicy(policyInput({ deniedToolIds: ["Read"] })), /both allowed and denied/);
});

await test("empty exposedToolIds is valid (L0/L1 text-only engines)", () => {
  const p = createResolvedExecutionPolicy(policyInput({ exposedToolIds: [], allowedToolIds: [], deniedToolIds: [] }));
  assert.deepEqual(approvalRequiredToolIds(p), []);
});

await test("stdio MCP command must be absolute, traversal-free, uniquely named", () => {
  assert.throws(() => createResolvedExecutionPolicy(policyInput({ mcpServers: [{ name: "m", transport: "stdio", command: "relative/path" }] })), PolicyValidationError);
  assert.throws(() => createResolvedExecutionPolicy(policyInput({ mcpServers: [{ name: "m", transport: "stdio", command: "/opt/agent/mcp/../../etc/x" }] })), PolicyValidationError);
  assert.throws(() =>
    createResolvedExecutionPolicy(policyInput({
      mcpServers: [
        { name: "m", transport: "stdio", command: "/opt/agent/mcp/a" },
        { name: "m", transport: "stdio", command: "/opt/agent/mcp/b" },
      ],
    })), /duplicate mcp server name/);
});

await test("network egress + resource bounds validated", () => {
  assert.throws(() => createResolvedExecutionPolicy(policyInput({ networkPolicy: { egress: "any" } as never })), PolicyValidationError);
  assert.throws(() => createResolvedExecutionPolicy(policyInput({ resourcePolicy: { maxMemoryMb: -1 } })), PolicyValidationError);
});

// --- capability grading (reverse-check vs M0 matrix) ---------------------------------

await test("capability levels: Claude → L4 (committed)", () => {
  assert.equal(maxPromisableLevel(CLAUDE_ENGINE_CAPABILITIES), 4);
});

await test("capability levels: Codex-shaped (no pre-exec approval) caps at L1 — matches M0 matrix", () => {
  const codexLike: EngineCapabilities = {
    ...CLAUDE_ENGINE_CAPABILITIES,
    preToolApproval: false,
    a2ui: false,
    contextCompaction: false,
    mcp: true,
    sessionResume: true,
    tokenUsage: true,
  };
  assert.equal(maxPromisableLevel(codexLike), 1);
});

await test("capability levels: no abort / no streaming → L0", () => {
  assert.equal(maxPromisableLevel({ ...CLAUDE_ENGINE_CAPABILITIES, abort: false }), 0);
  assert.equal(maxPromisableLevel({ ...CLAUDE_ENGINE_CAPABILITIES, streamingText: false }), 0);
  assert.equal(maxPromisableLevel({ ...CLAUDE_ENGINE_CAPABILITIES, structuredToolEvents: false }), 1);
  assert.equal(maxPromisableLevel({ ...CLAUDE_ENGINE_CAPABILITIES, tokenUsage: false }), 2);
  assert.equal(maxPromisableLevel({ ...CLAUDE_ENGINE_CAPABILITIES, a2ui: false }), 3);
});

// --- normalizer contract tests ---------------------------------------------------------

await test("P-INIT-01: system/init → runtime_ready once; diagnostics NOT mapped", () => {
  const ev = n.push({ type: "system", subtype: "init", session_id: "s-1", slash_commands: ["/compact"], model: "opus", mcp_servers: [] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "runtime_ready");
  const ready = ev[0] as Extract<PlatformRuntimeEvent, { type: "runtime_ready" }>;
  assert.equal(ready.engineSessionId, "s-1");
  assert.equal(ready.capabilities, CLAUDE_ENGINE_CAPABILITIES);
  assert.deepEqual(scanForEnginePrivateFields(ready), []);
  // second init frame: no duplicate runtime_ready
  assert.equal(n.push({ type: "system", subtype: "init" }).length, 0);
});

await test("P-SESS-01: late session capture → session_updated exactly once", () => {
  const nn = new ClaudeEventNormalizer();
  nn.push({ type: "system", subtype: "init" }); // no session_id
  const ev = nn.push({ type: "assistant", session_id: "s-2", message: { content: [] } });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "session_updated");
  assert.equal((ev[0] as { engineSessionId: string }).engineSessionId, "s-2");
  // later frames carrying the same id: silent
  assert.equal(nn.push({ type: "assistant", session_id: "s-2", message: { content: [] } }).length, 0);
});

await test("P-TXT-01: assistant content blocks → assistant_text + tool_requested", () => {
  const ev = n.push({
    type: "assistant",
    message: { content: [
      { type: "text", text: "Looking at the file" },
      { type: "tool_use", id: "tu-1", name: "Write", input: { file_path: "/workspace/a.txt", content: "x" } },
    ] },
  });
  assert.deepEqual(ev.map((e) => e.type), ["assistant_text", "tool_requested"]);
  const tool = ev[1] as Extract<PlatformRuntimeEvent, { type: "tool_requested" }>;
  assert.equal(tool.toolCallId, "tu-1");
  assert.equal(tool.toolName, "Write");
  assert.deepEqual(tool.input, { file_path: "/workspace/a.txt", content: "x" });
});

await test("P-TXT-02: result-only text deduped when already streamed; emitted when not", () => {
  const nn = new ClaudeEventNormalizer();
  nn.push({ type: "assistant", message: { content: [{ type: "text", text: "Final answer: 42" }] } });
  const ev1 = nn.push({ type: "result", subtype: "success", result: "Final answer: 42", usage: { input_tokens: 3, output_tokens: 5 } });
  // dedup: no second assistant_text, but turn_completed still lands
  assert.deepEqual(ev1.map((e) => e.type), ["turn_completed"]);

  const ev2 = nn.push({ type: "result", subtype: "success", result: "Only in result", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.deepEqual(ev2.map((e) => e.type), ["assistant_text", "turn_completed"]);
  assert.equal((ev2[0] as { final: boolean }).final, true);
});

await test("P-TOOL-01: tool input redaction + payload bounds", () => {
  const ev = n.push({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "ls", api_key: "sk-secret", nested: { auth_token: "t" } } }] },
  });
  const tool = ev[0] as Extract<PlatformRuntimeEvent, { type: "tool_requested" }>;
  assert.deepEqual(tool.input, { command: "ls", api_key: "[redacted]", nested: { auth_token: "[redacted]" } });
  assert.equal(boundedText("x".repeat(6000)).length < 6000, true);
  assert.match(boundedText("x".repeat(6000)), /truncated/);
});

await test("P-TOOL-02: tool_result mapping (is_error→success inversion, content join, truncation)", () => {
  const ev = n.push({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: true, content: [{ text: "line1" }, { text: "line2" }] }] },
  });
  const tr = ev[0] as Extract<PlatformRuntimeEvent, { type: "tool_result" }>;
  assert.equal(tr.toolCallId, "tu-1");
  assert.equal(tr.success, false);
  assert.equal(tr.output, "line1\nline2");
});

await test("P-A2UI-02: internal show_ui tool_use/tool_result produce no events", () => {
  const nn = new ClaudeEventNormalizer();
  assert.equal(nn.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "ui-1", name: "show_ui", input: {} }] } }).length, 0);
  assert.equal(nn.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ui-1", content: "submitted" }] } }).length, 0);
});

await test("P-APR-01: docker approval frame → neutral shape + redaction", () => {
  const ev = n.push({ type: "approval_request", id: "ap-1", toolName: "Bash", toolInput: { command: "rm -rf /tmp/x", password: "hunter2" }, toolUseId: "tu-9" });
  const apr = ev[0] as Extract<PlatformRuntimeEvent, { type: "approval_request" }>;
  assert.equal(apr.requestId, "ap-1");
  assert.equal(apr.toolName, "Bash");
  assert.equal(apr.toolCallId, "tu-9");
  assert.deepEqual(apr.input, { command: "rm -rf /tmp/x", password: "[redacted]" });
  assert.deepEqual(scanForEnginePrivateFields(apr), []);
});

await test("P-A2UI-01: a2ui_request passthrough with timeoutSec; invalid timeout dropped", () => {
  const ev = n.push({ type: "a2ui_request", requestId: "a-1", block: { title: "Confirm" }, timeoutSec: 300 });
  const a = ev[0] as Extract<PlatformRuntimeEvent, { type: "a2ui_request" }>;
  assert.equal(a.requestId, "a-1");
  assert.equal(a.timeoutSec, 300);
  assert.deepEqual(a.block, { title: "Confirm" });
  assert.equal(n.push({ type: "a2ui_request", requestId: "a-2", block: {}, timeoutSec: 0 }).length, 0);
});

await test("P-RES-01: failed result → turn_failed (no turn_completed)", () => {
  const ev = n.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "kaboom" });
  assert.deepEqual(ev.map((e) => e.type), ["assistant_text", "turn_failed"]);
  const tf = ev[1] as Extract<PlatformRuntimeEvent, { type: "turn_failed" }>;
  assert.equal(tf.category, "engine");
  assert.equal(tf.message, "kaboom");
});

await test("P-RES-02: usage/cost/duration mapped snake_case → camelCase (quota-service compatible)", () => {
  const ev = n.push({
    type: "result", subtype: "success", result: "",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    total_cost_usd: 0.033, duration_ms: 1500,
  });
  const tc = ev[0] as Extract<PlatformRuntimeEvent, { type: "turn_completed" }>;
  assert.deepEqual(tc.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 });
  assert.equal(tc.costUsd, 0.033);
  assert.equal(tc.durationMs, 1500);
  // neutral field names only
  assert.deepEqual(scanForEnginePrivateFields(tc), []);
});

await test("P-CMP-01: compact_boundary → context_compacted", () => {
  const ev = n.push({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 100, post_tokens: 40, trigger: "manual" } });
  const cc = ev[0] as Extract<PlatformRuntimeEvent, { type: "context_compacted" }>;
  assert.equal(cc.preTokens, 100);
  assert.equal(cc.postTokens, 40);
  assert.equal(cc.trigger, "manual");
});

await test("redactSecrets: depth + array bounds, non-secret strings untouched", () => {
  const out = redactSecrets({ ok: "plain", apiKey: "s" }) as Record<string, unknown>;
  assert.equal(out.ok, "plain");
  assert.equal(out.apiKey, "[redacted]");
  // Nest deeper than MAX_REDACT_DEPTH: the leaf must be masked by the budget.
  let deepValue: unknown = "leaf";
  for (let i = 0; i < 10; i += 1) deepValue = { nested: deepValue };
  const wrapped = redactSecrets({ deep: deepValue }) as { deep: unknown };
  let cursor: unknown = wrapped.deep;
  let hops = 0;
  while (cursor && typeof cursor === "object" && "nested" in (cursor as Record<string, unknown>)) {
    cursor = (cursor as Record<string, unknown>).nested;
    hops += 1;
  }
  assert.ok(hops >= 6, "walked a meaningful depth");
  assert.equal(cursor, "[depth-exceeded]");
});

await test("unknown frame types are dropped (closed event surface)", () => {
  assert.equal(n.push({ type: "stream_event", something: true }).length, 0);
  assert.equal(n.push(null).length, 0);
});

// --- R1 normalizer adversarial additions ----------------------------------------

await test("R1: redactSecrets view is GLOBALLY bounded — serialized view ≤ declared cap, secrets still masked", () => {
  const wide: Record<string, unknown> = { apiKey: "must-be-masked" };
  for (let i = 0; i < 500; i += 1) wide[`k${i}`] = "x".repeat(100); // ~52KB raw
  const view = redactSecrets(wide) as Record<string, unknown>;
  assert.equal(view.apiKey, "[redacted]"); // masking survives truncation
  assert.ok(
    JSON.stringify(view).length <= MAX_TOOL_PAYLOAD_CHARS,
    `serialized view ${JSON.stringify(view).length} exceeds declared cap`,
  );
  // deep + wide mixed payload also stays under the cap (secret at shallow depth)
  let deep: unknown = { pad: "y".repeat(4000) };
  for (let i = 0; i < 10; i += 1) deep = { nested: deep, arr: new Array(40).fill("z".repeat(200)) };
  const deepView = JSON.stringify(redactSecrets({ apiKey: "shallow-secret", root: deep }));
  assert.ok(deepView.length <= MAX_TOOL_PAYLOAD_CHARS, `deep view ${deepView.length} exceeds cap`);
  assert.ok(deepView.includes("[redacted]"));
});

await test("R1: per-turn state reset — identical text still emits as final in the NEXT turn", () => {
  const nn = new ClaudeEventNormalizer();
  nn.push({ type: "assistant", message: { content: [{ type: "text", text: "Done: 42" }] } });
  // in-turn dedup holds: streamed text suppresses the identical final text
  const t1 = nn.push({ type: "result", subtype: "success", result: "Done: 42" });
  assert.deepEqual(t1.map((e) => e.type), ["turn_completed"]);
  // NEXT turn, result-only (no streamed assistant frame): must NOT be deduped
  const t2 = nn.push({ type: "result", subtype: "success", result: "Done: 42" });
  assert.deepEqual(t2.map((e) => e.type), ["assistant_text", "turn_completed"]);
  assert.equal((t2[0] as { final: boolean }).final, true);
});

await test("R1: unclosed internal tool ids hard-capped (FIFO) — newest filtered, oldest evicted", () => {
  const nn = new ClaudeEventNormalizer();
  for (let i = 0; i < 300; i += 1) {
    nn.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `ui-${i}`, name: "show_ui", input: {} }] } });
  }
  // newest id still filtered → no chip event
  assert.equal(
    nn.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ui-299", content: "ok" }] } }).length,
    0,
  );
  // evicted oldest id degrades to a normal tool_result event (bounded memory)
  const ev = nn.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ui-0", content: "late" }] } });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "tool_result");
});

// --- summary ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
