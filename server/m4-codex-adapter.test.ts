/**
 * Focused tests — M4-S1 Codex harness adapter (probe-grounded, fail-closed):
 *   CM.*  mapCodexEvent: real `codex exec --json` fixtures → platform events
 *         (simple-turn + tool-turn; streamingText=false → final-only text,
 *         structuredToolEvents=true → post-hoc tool_result, tokenUsage=true,
 *         sessionResume via thread_id → session_updated).
 *   CG.*  compileCodexExecConfig: capability negotiation FAILS CLOSED —
 *         approval-required / mcp / host-proxy egress all refused; sandbox
 *         derived from exposed+allowed tool set; resume token compiles.
 *   CX.*  capability honesty: maxPromisableLevel(CODEX_HARNESS_CAPABILITIES)
 *         === 0 (abort+streamingText are hard L0 gates; proven structured
 *         tools/usage/resume don't elevate codex past L0); ENGINE_MATRIX
 *         codex row active@L0, pi/deepseek planned with next-probe prerequisites.
 *   CN.*  neutrality: no engine-private keys leak through the mapping
 *         (scanForEnginePrivateFields on every emitted event is empty).
 *
 * NO real codex invocation, NO Guest — codex is absent from eaos-guest:0.1.4
 * (real Guest smoke is an explicit BLOCKER in the probe evidence doc).
 *
 * Run: npx tsx server/m4-codex-adapter.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CODEX_ENGINE_CAPABILITIES,
  ENGINE_MATRIX,
  maxPromisableLevel,
  scanForEnginePrivateFields,
} from "./platform-runtime-protocol.js";
import { createResolvedExecutionPolicy, type ResolvedExecutionPolicy } from "./resolved-execution-policy.js";
import {
  CodexHarnessAdapter,
  CodexPolicyRefusalError,
  CODEX_ENGINE_ID,
  CODEX_HARNESS_CAPABILITIES,
  compileCodexExecConfig,
} from "../worker/harness/codex-harness-adapter.js";

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
  const text = readFileSync(join(__dirname, "fixtures", "codex", name), "utf8");
  return text.split("\n").filter((l) => l.trim().length > 0);
}

function textOnlyPolicy(over: Partial<Parameters<typeof createResolvedExecutionPolicy>[0]> = {}): ResolvedExecutionPolicy {
  return createResolvedExecutionPolicy({
    modelRef: "gpt-5.6-sol",
    exposedToolIds: [],
    allowedToolIds: [],
    deniedToolIds: [],
    mcpServers: [],
    workspacePolicy: { roots: [{ path: "/workspace", access: "rw" }] },
    networkPolicy: { egress: "none" },
    resourcePolicy: {},
    ...over,
  });
}

function mapAll(adapter: CodexHarnessAdapter, lines: string[]) {
  return lines.flatMap((l) => adapter.mapCodexEvent(l));
}

// ─── CM: JSONL → platform event mapping (real fixtures) ──────────────────

atest("CM.1: simple-turn fixture → session_updated + assistant_text(final) + turn_completed(usage)", () => {
  const adapter = new CodexHarnessAdapter();
  const events = mapAll(adapter, loadFixtureLines("simple-turn.jsonl"));
  const types = events.map((e) => e.type);

  // thread.started{thread_id} → session_updated (sessionResume proven)
  const su = events.find((e) => e.type === "session_updated");
  assert.ok(su && su.type === "session_updated", "session_updated emitted");
  assert.equal(su!.type === "session_updated" ? su.engineSessionId : undefined, "01a0b259-24aa-7b43-aaf4-c8584154501e");

  // agent_message → assistant_text(final=true); streamingText=false → NO delta
  const at = events.filter((e) => e.type === "assistant_text");
  assert.equal(at.length, 1, "exactly one assistant_text (final, no streaming delta)");
  assert.equal(at[0]!.type === "assistant_text" ? at[0].text : "", "codex-ok");
  assert.equal(at[0]!.type === "assistant_text" ? at[0].final : false, true);

  // error item → runtime_error{engine} (non-fatal warning, turn still completes)
  const re = events.find((e) => e.type === "runtime_error");
  assert.ok(re && re.type === "runtime_error" && re.category === "engine", "error item → runtime_error{engine}");

  // turn.completed → turn_completed{usage}; costUsage=false → no costUsd
  const tc = events.find((e) => e.type === "turn_completed");
  assert.ok(tc && tc.type === "turn_completed", "turn_completed emitted");
  if (tc!.type === "turn_completed") {
    assert.equal(tc.usage?.inputTokens, 20988);
    assert.equal(tc.usage?.outputTokens, 7); // reasoning folded (0 here)
    assert.equal(tc.usage?.cacheReadTokens, 0); // cached_input_tokens
    assert.equal(tc.costUsd, undefined, "costUsage=false → no costUsd");
  }
  assert.ok(!types.includes("tool_requested"), "no tool_requested (preToolApproval=false, fail-closed)");
  assert.ok(!types.includes("tool_result"), "no tool in simple turn");
});

atest("CM.2: tool-turn fixture → command_execution DROPPED (no tool_result synthesized); text + usage only", () => {
  const adapter = new CodexHarnessAdapter();
  const events = mapAll(adapter, loadFixtureLines("tool-turn.jsonl"));
  const types = events.map((e) => e.type);

  // ★ FAIL-CLOSED GOVERNANCE: NO tool_result AND NO tool_requested for ANY
  // command_execution. post-hoc commands are ungovernable; surfacing them as
  // tool_result would (via platform-event-adapter) synthesize the appearance
  // of a governed/authorized tool call. Dropped instead — Host workspace scan
  // is the side-effect governance path, not this event stream.
  assert.equal(events.filter((e) => e.type === "tool_result").length, 0, "zero tool_result (post-hoc ungovernable → dropped)");
  assert.equal(events.filter((e) => e.type === "tool_requested").length, 0, "zero tool_requested (preToolApproval=false)");
  assert.equal(events.filter((e) => e.type === "approval_request").length, 0, "zero approval_request (no synthesized authorization)");

  // two assistant_text (the pre-command + post-command agent_messages)
  const at = events.filter((e) => e.type === "assistant_text");
  assert.equal(at.length, 2);
  assert.ok(at.every((e) => e.type === "assistant_text" && e.final), "all final (streamingText=false)");

  // error item still surfaces as runtime_error{engine}
  assert.ok(events.some((e) => e.type === "runtime_error" && e.category === "engine"));

  // turn_completed usage: reasoning_output_tokens folded into outputTokens
  const tc = events.find((e) => e.type === "turn_completed");
  assert.ok(tc && tc.type === "turn_completed", "turn_completed present");
  if (tc && tc.type === "turn_completed") {
    assert.equal(tc.usage?.inputTokens, 78404);
    assert.equal(tc.usage?.outputTokens, 453 + 223); // output + reasoning
    assert.equal(tc.usage?.cacheReadTokens, 33024);
  }
  // No codex command output (aggregated_output) crosses the boundary at all.
  assert.ok(!types.includes("tool_result"), "no tool_result in any form");
});

atest("CM.3: malformed line → runtime_error{protocol}, not a throw", () => {
  const adapter = new CodexHarnessAdapter();
  const out = adapter.mapCodexEvent("{not json");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, "runtime_error");
  assert.equal(out[0]!.type === "runtime_error" ? out[0].category : undefined, "protocol");
});

atest("CM.4: empty line + unknown event type → drop silently (no fabrication)", () => {
  const adapter = new CodexHarnessAdapter();
  assert.deepEqual(adapter.mapCodexEvent(""), []);
  assert.deepEqual(adapter.mapCodexEvent("   "), []);
  assert.deepEqual(adapter.mapCodexEvent(JSON.stringify({ type: "future.unknown.event" })), []);
  assert.deepEqual(adapter.mapCodexEvent(JSON.stringify({ type: "item.completed", item: { id: "x", type: "future_tool" } })), []);
});

atest("CM.5: turn.started and item.started emit nothing (no pre-execution signal)", () => {
  const adapter = new CodexHarnessAdapter();
  assert.deepEqual(adapter.mapCodexEvent(JSON.stringify({ type: "turn.started" })), []);
  assert.deepEqual(
    adapter.mapCodexEvent(JSON.stringify({ type: "item.started", item: { id: "i", type: "command_execution", status: "in_progress" } })),
    [],
  );
});

// ─── CG: compileCodexExecConfig fail-closed capability negotiation ───────

atest("CG.1: text-only policy compiles to read-only sandbox, no resume", () => {
  const cfg = compileCodexExecConfig(textOnlyPolicy());
  assert.equal(cfg.engineId, CODEX_ENGINE_ID);
  assert.equal(cfg.model, "gpt-5.6-sol");
  assert.equal(cfg.sandbox, "read-only", "no destructive tools → read-only (deny-default)");
  assert.equal(cfg.skipGitRepoCheck, true);
  assert.equal(cfg.json, true);
  assert.equal(cfg.resume, undefined);
});

atest("CG.2: destructive+allowed policy compiles to workspace-write sandbox", () => {
  const cfg = compileCodexExecConfig(
    textOnlyPolicy({
      exposedToolIds: ["Bash", "Read"],
      allowedToolIds: ["Bash", "Read"],
      deniedToolIds: [],
    }),
  );
  assert.equal(cfg.sandbox, "workspace-write", "Bash exposed+allowed → workspace-write");
});

atest("CG.3: resume token compiles through (sessionResume proven)", () => {
  const cfg = compileCodexExecConfig(textOnlyPolicy(), { resume: "01a0b259-24aa-7b43-aaf4-c8584154501e" });
  assert.equal(cfg.resume, "01a0b259-24aa-7b43-aaf4-c8584154501e");
});

atest("CG.4: approval-required tool → CodexPolicyRefusalError (preToolApproval=false, fail closed)", () => {
  // Bash exposed but NOT allowed → approvalRequired=[Bash]; codex can't gate.
  assert.throws(
    () =>
      compileCodexExecConfig(
        textOnlyPolicy({ exposedToolIds: ["Bash", "Read"], allowedToolIds: ["Read"], deniedToolIds: [] }),
      ),
    (err: Error) => err instanceof CodexPolicyRefusalError && /cannot pre-approve/.test(err.message),
  );
});

atest("CG.5: any MCP server → CodexPolicyRefusalError (mcp=false, fail closed)", () => {
  assert.throws(
    () =>
      compileCodexExecConfig(
        textOnlyPolicy({
          mcpServers: [{ name: "ext", transport: "stdio", command: "/opt/agent/mcp/ext" }],
        }),
      ),
    (err: Error) => err instanceof CodexPolicyRefusalError && /mcp not proven/.test(err.message),
  );
});

atest("CG.6: host-proxy egress → CodexPolicyRefusalError (codex runs own model loop; credential boundary unsatisfiable)", () => {
  assert.throws(
    () => compileCodexExecConfig(textOnlyPolicy({ egress: { mode: "host-proxy" } })),
    (err: Error) =>
      err instanceof CodexPolicyRefusalError && /credential-proxy egress/.test(err.message),
  );
});

// ─── CX: capability honesty + engine matrix ──────────────────────────────

atest("CX.1: CODEX_HARNESS_CAPABILITIES === CODEX_ENGINE_CAPABILITIES (adapter = engine authority)", () => {
  assert.deepEqual(CODEX_HARNESS_CAPABILITIES, CODEX_ENGINE_CAPABILITIES);
  // Proven-and-surfaceable booleans exactly:
  assert.equal(CODEX_HARNESS_CAPABILITIES.sessionResume, true);
  assert.equal(CODEX_HARNESS_CAPABILITIES.tokenUsage, true);
  // structuredToolEvents=false: codex EMITS command items but they are
  // post-hoc/ungovernable → adapter DROPS them (engine raw emission ≠ adapter
  // surface). See CM.2.
  // Unproven/unsurfaceable → false (no emulation):
  for (const k of ["streamingText", "structuredToolEvents", "preToolApproval", "costUsage", "mcp", "a2ui", "abort", "contextCompaction"] as const) {
    assert.equal(CODEX_HARNESS_CAPABILITIES[k], false, `${k} false`);
  }
});

atest("CX.2: maxPromisableLevel(codex) === 0 (abort+streamingText are hard L0 gates)", () => {
  // The platform ladder requires abort AND streamingText from L1 up. Codex
  // has neither (exec runs to completion; JSONL is final-only). The proven
  // sessionResume/tokenUsage are real but do NOT elevate codex past L0 —
  // this is the authoritative floor, not a downgrade.
  assert.equal(maxPromisableLevel(CODEX_HARNESS_CAPABILITIES), 0);
});

atest("CX.3: ENGINE_MATRIX — codex active+NOT deployable; claude active+deployable; pi/deepseek planned", () => {
  const codex = ENGINE_MATRIX.find((r) => r.engineId === "codex");
  assert.ok(codex, "codex row present");
  assert.equal(codex!.status, "active", "adapter exists + probed");
  assert.equal(codex!.adapter, "CodexHarnessAdapter");
  assert.equal(codex!.deployable, false, "codex NOT deployable (not in Guest image, not Worker-wired, host-proxy refused)");

  const claude = ENGINE_MATRIX.find((r) => r.engineId === "claude");
  assert.ok(claude && claude.status === "active" && claude.maxLevel === 4 && claude.deployable === true, "claude active+deployable@L4");

  for (const id of ["pi", "deepseek"] as const) {
    const row = ENGINE_MATRIX.find((r) => r.engineId === id);
    assert.ok(row && row.status === "planned" && row.deployable === false && row.nextProbePrerequisite, `${id} planned + not deployable + has prerequisite`);
  }
  assert.match(ENGINE_MATRIX.find((r) => r.engineId === "pi")!.nextProbePrerequisite!, /Pi harness binary/);
  assert.match(ENGINE_MATRIX.find((r) => r.engineId === "deepseek")!.nextProbePrerequisite!, /DeepSeek harness/);
});

// ─── CS: consumer proof — post-hoc codex events CANNOT create a governed tool call ─
//
// Feeds codex adapter output through the REAL consumer (platformEventToSdkMessages,
// the PlatformRuntimeEvent→SDK translator the Session actually consumes) and proves
// no tool_use / tool_result / approval SDK block can emerge from any codex mapping.

import { platformEventToSdkMessages } from "./platform-event-adapter.js";

atest("CS.1: tool-turn fixture through the real consumer → ZERO tool_result/tool_use/approval SDK blocks", () => {
  const adapter = new CodexHarnessAdapter();
  const events = mapAll(adapter, loadFixtureLines("tool-turn.jsonl"));
  const sdkMsgs = events.flatMap((e) => platformEventToSdkMessages(e as Parameters<typeof platformEventToSdkMessages>[0]));
  const sdkTypes = sdkMsgs.map((m) => (m as { type?: string }).type);

  // The real consumer would, for a tool_result PlatformRuntimeEvent, emit a
  // SDK user(tool_result block) → tool_result record + broadcast = a governed
  // tool call appearance. Codex MUST NOT be able to trigger that.
  assert.equal(sdkMsgs.filter((m) => (m as { type?: string }).type === "user").length, 0, "no user(tool_result) SDK block");
  // assistant blocks are FINE (assistant_text → assistant text block); the
  // danger is an assistant block carrying a tool_use CONTENT block. Inspect.
  const assistantMsgs = sdkMsgs.filter((m) => (m as { type?: string }).type === "assistant");
  const toolUseBlocks = assistantMsgs.flatMap((m) => {
    const content = (m as { message?: { content?: unknown } }).message?.content;
    return Array.isArray(content) ? content.filter((b) => (b as { type?: string }).type === "tool_use") : [];
  });
  assert.equal(toolUseBlocks.length, 0, "no tool_use content block in any assistant message");
  // approval_request would route to handleApprovalResponse — codex must not.
  assert.equal(sdkMsgs.filter((m) => (m as { type?: string }).type === "approval_request").length, 0, "no approval_request SDK block");
  // Only assistant_text → assistant(text) + runtime_error{engine} → result(error)
  // + turn_completed → result(success). No governed tool surface.
  assert.ok(sdkTypes.includes("assistant"), "assistant_text surfaces (text only)");
  assert.ok(sdkTypes.includes("result"), "turn_completed/runtime_error → result");
});

atest("CS.2: a hostile raw codex command_execution line cannot force a governed tool_result through the consumer", () => {
  const adapter = new CodexHarnessAdapter();
  // Even a 'successful' command (exit 0, completed) must not synthesize success.
  const hostile = adapter.mapCodexEvent(
    JSON.stringify({
      type: "item.completed",
      item: { id: "evil_1", type: "command_execution", command: "rm -rf /", exit_code: 0, status: "completed", aggregated_output: "done" },
    }),
  );
  assert.equal(hostile.length, 0, "command_execution dropped (no event at all)");
  const sdkMsgs = hostile.flatMap((e) => platformEventToSdkMessages(e as Parameters<typeof platformEventToSdkMessages>[0]));
  assert.equal(sdkMsgs.length, 0, "nothing reaches the consumer");
});

// ─── CO: opaque ids — raw codex ids never parsed/used for auth/tenancy/policy ─────

atest("CO.1: raw codex item.id / thread_id never surface as policy-meaningful keys; under drop, no id crosses at all", () => {
  const adapter = new CodexHarnessAdapter();
  const all = mapAll(adapter, loadFixtureLines("tool-turn.jsonl"));
  // command_execution ids (item_2, item_3) must NOT appear as toolCallId in
  // any event — they don't, because command_execution is dropped entirely.
  // thread_id surfaces ONLY as engineSessionId (neutral, opaque value — never
  // parsed for auth/tenancy/policy by the adapter; it's a resume token).
  for (const e of all) {
    if (e.type === "session_updated") {
      // engineSessionId is an opaque value; the adapter never inspects it.
      assert.equal(typeof e.engineSessionId, "string");
    } else {
      // no event carries a toolCallId (command_execution dropped)
      assert.equal("toolCallId" in e, false);
    }
  }
  // The adapter source has NO parsing of item.id for auth/policy (structural):
  // mapCodexEvent only reads item.id to drop the item (command_execution) or
  // to ignore it. No branch treats it as a principal, tenant, or policy key.
  const src = readFileSync(join(__dirname, "..", "worker", "harness", "codex-harness-adapter.ts"), "utf8");
  assert.ok(!/item\.id.*auth|item\.id.*tenant|item\.id.*policy/.test(src), "no auth/tenant/policy use of item.id");
});

// ─── CN: neutrality (no engine-private fields cross the boundary) ─────────

atest("CN.1: no engine-private keys leak through the codex mapping (both fixtures)", () => {
  const adapter = new CodexHarnessAdapter();
  const all = [...mapAll(adapter, loadFixtureLines("simple-turn.jsonl")), ...mapAll(adapter, loadFixtureLines("tool-turn.jsonl"))];
  // thread_id surfaces ONLY as engineSessionId (neutral, opaque); raw codex
  // item.id / item.type / exit_code / aggregated_output do NOT cross at all
  // (command_execution is dropped post-hoc). scanForEnginePrivateFields checks
  // keys recursively and finds nothing.
  const leaks = all.flatMap((e) => scanForEnginePrivateFields(e));
  assert.deepEqual(leaks, [], "no engine-private keys in mapped events");
});

void main();
