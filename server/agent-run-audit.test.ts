/**
 * agent-run-audit.test.ts — Agent OS M3 (plan §7): runId execution audit closure.
 *
 * Proof coverage (plan §7 验收):
 *  - P1. One user-message execution → one stable runId; a second user message
 *        gets a NEW runId. (runId uniqueness + turn boundary)
 *  - P2. Run-start snapshot is frozen: principal type, org, app, agent,
 *        agentSession, configVersion, capability IDs, model, start time.
 *  - P3. Existing agent_events (approval request/decision, tool_use,
 *        tool_result, result) are linked by run_id — verified by querying
 *        the run's redacted event summary.
 *  - P4. Four run statuses: success / failed / tool_rejected / stopped — all
 *        queryable, status consistent with events.
 *  - P5. Admin-only access: user + org_admin + cross-org admin all get null
 *        (existence hidden), same-org admin gets the detail.
 *  - P6. No raw payload leakage: the event summary NEVER carries toolInput,
 *        toolOutput, message bodies, subject, AppKey/Token, or raw payloads.
 *
 * The test drives a REAL Session through sendMessage + a fake runtime event
 * stream, so runs are minted/finalized through the production code path
 * (Session.sendMessage → agentRunService.startRun; handleSDKMessage("result")
 * → finalizeRun). No private counters.
 *
 * Run: DB_PATH=/tmp/m3-run-audit.db JWT_SECRET=test npx tsx server/agent-run-audit.test.ts
 *
 * See docs/开发计划/agent-os-overall-plan.md §7.
 */
import assert from "node:assert/strict";
import { Session } from "./session.js";
import { chatStore } from "./chat-store.js";
import { eventStore } from "./event-store.js";
import { agentRunService } from "./agent-run-service.js";
import { DEFAULT_ORG_ID } from "./request-context.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  RuntimeEvent,
  RuntimeStatus,
} from "./agent-runtime.js";
import db from "./database.js";

// ─── Fake runtime: pushes events into the stream Session consumes ──────
class FakeRuntime implements AgentRuntime {
  opts: AgentRuntimeOptions;
  private buffer: RuntimeEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  constructor(opts: AgentRuntimeOptions) {
    this.opts = opts;
  }
  sendMessage(): void {}
  handleApprovalResponse(): boolean {
    return false;
  }
  abort(): void {}
  close(): void {
    this.closed = true;
    const w = this.waiters.shift();
    if (w) w();
  }
  getStatus(): RuntimeStatus {
    return "running";
  }
  async *getEventStream(): AsyncIterable<RuntimeEvent> {
    while (!this.closed) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  private wake(): void {
    const w = this.waiters.shift();
    if (w) w();
  }
  /** Push a raw SDK-shaped event into the stream Session.handleSDKMessage reads. */
  pushEvent(msg: RuntimeEvent): void {
    this.buffer.push(msg);
    this.wake();
  }
}

const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// Read the Session's in-flight runId (production field; accessed for assertion
// only, same pattern as approval-behavior.test's pendingRequestIds).
function currentRunId(session: Session): string | null {
  return (session as unknown as { currentRunId: string | null }).currentRunId;
}

interface Harness {
  session: Session;
  rt: FakeRuntime;
  userId: string;
  chatId: string;
}

async function makeHarness(userId = "m3-user", orgId = DEFAULT_ORG_ID): Promise<Harness> {
  const chat = chatStore.createChat(userId, "M3 run audit chat", orgId);
  const chatId = chat.id;
  let rt: FakeRuntime | undefined;
  const factory = (opts?: AgentRuntimeOptions) => {
    rt = new FakeRuntime(opts ?? ({} as AgentRuntimeOptions));
    return rt;
  };
  // runCtx carries role + orgId so Session can mint runs.
  const session = new Session(chatId, factory, undefined, userId, { role: "admin", orgId });
  session.setUserId(userId);
  session.sendMessage("hello"); // mints runId + starts listening
  await flush();
  return { session, rt: rt!, userId, chatId };
}

// ─── P1 + P2. One run per user message; snapshot frozen ───────────────
{
  const h = await makeHarness("m3-snapshot");
  const runId = currentRunId(h.session);
  assert.ok(runId, "sendMessage mints a non-null runId");
  assert.equal(typeof runId, "string");
  assert.ok(runId!.length > 0, "runId is a non-empty string");

  // P2: admin (same org) can fetch the frozen snapshot while the run is running.
  const detail = agentRunService.getRun(runId!, { role: "admin", orgId: DEFAULT_ORG_ID });
  assert.ok(detail, "admin same-org sees the running run");
  assert.equal(detail!.run.id, runId, "run detail id matches");
  assert.equal(detail!.run.status, "running", "status is 'running' before result");
  assert.equal(detail!.run.agentId, h.chatId, "agentId frozen = chatId (same-id bridge)");
  assert.equal(detail!.run.appId, "default-app", "appId frozen from DB (default-app)");
  assert.equal(detail!.run.orgId, DEFAULT_ORG_ID, "orgId frozen");
  assert.equal(detail!.run.principalType, "user", "principalType=user for platform user");
  assert.ok(detail!.run.configVersion && detail!.run.configVersion.length > 0, "configVersion frozen (non-empty sha)");
  assert.ok(detail!.run.startedAt, "startedAt frozen");
  // capability_ids is [] for a chat with no activation/entitlement → stored NULL.
  assert.equal(detail!.run.capabilityIds, null, "capabilityIds NULL when none resolved (no raw array leaked)");
  // model frozen at start (platform default alias resolves even on a fresh DB).
  assert.ok(detail!.run.model && detail!.run.model.length > 0, "model frozen at run start");

  // Finalize so the next subtest starts clean.
  h.rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: 0.01,
    duration_ms: 500,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  await flush();
  assert.equal(currentRunId(h.session), null, "currentRunId cleared after result");

  // P1: a SECOND user message gets a NEW runId.
  h.session.sendMessage("second");
  await flush();
  const runId2 = currentRunId(h.session);
  assert.ok(runId2 && runId2 !== runId, "second user message → new runId");
  h.rt.pushEvent({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 1 });
  await flush();
  console.log("✓ P1+P2. one runId per user message; second message → new runId; start snapshot frozen (principal/org/app/agent/configVersion/model)");
}

// ─── P3. Existing agent_events linked by run_id; redacted summary ──────
{
  const h = await makeHarness("m3-linkage");
  const runId = currentRunId(h.session)!;
  // Drive a tool_use + tool_result + result through the event stream so they
  // get recorded via the existing recordEvent/appendEvent path (stamped with
  // the current runId).
  h.rt.pushEvent({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tu-1", name: "Write", input: { path: "/tmp/secret", content: "CREDENTIALS=sk-leaked" } }],
    },
  } as RuntimeEvent);
  await flush();
  h.rt.pushEvent({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "wrote file", is_error: false }],
    },
  } as RuntimeEvent);
  await flush();
  h.rt.pushEvent({
    type: "result",
    subtype: "success",
    result: "the assistant text with <a2ui-json>{}</a2ui-json>",
    total_cost_usd: 0.02,
    duration_ms: 300,
    usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
  });
  await flush();

  // Verify raw agent_events rows DO carry the runId linkage.
  const rawEvents = eventStore.getEventsByRun(runId, 50, 0);
  const types = rawEvents.map((e) => e.eventType);
  assert.ok(types.includes("tool_use"), "tool_use event linked to runId");
  assert.ok(types.includes("tool_result"), "tool_result event linked to runId");
  assert.ok(types.includes("result"), "result event linked to runId");
  // Every event for this run carries the SAME runId.
  assert.ok(rawEvents.every((e) => e.runId === runId), "all run events carry the same runId");

  // P3 + P6: the redacted summary returned by getRun strips raw payloads.
  const detail = agentRunService.getRun(runId, { role: "admin", orgId: DEFAULT_ORG_ID })!;
  const summary = detail.events;
  const tu = summary.find((e) => e.eventType === "tool_use")!;
  assert.equal(tu.toolName, "Write", "tool_use summary carries toolName");
  // CRITICAL: the sensitive tool input (path with "secret", the CREDENTIALS
  // value) and the tool_result output body MUST NOT appear in the summary.
  const summaryJson = JSON.stringify(summary);
  assert.ok(!summaryJson.includes("CREDENTIALS"), "no credential payload leaked in summary");
  assert.ok(!summaryJson.includes("/tmp/secret"), "no tool input path leaked in summary");
  assert.ok(!summaryJson.includes("wrote file"), "no tool_result output body leaked in summary");
  assert.ok(!summaryJson.includes("a2ui-json"), "no message body / a2ui tags leaked in summary");
  // result summary carries only non-sensitive totals.
  const res = summary.find((e) => e.eventType === "result")!;
  assert.equal(res.success, true, "result summary carries success flag");
  assert.equal(res.costUsd, 0.02, "result summary carries cost");
  assert.equal(res.durationMs, 300, "result summary carries duration");
  // Run-level totals also redacted: usageJson is totals only, no per-event raw.
  const usage = detail.run.usageJson ? JSON.parse(detail.run.usageJson) : null;
  assert.ok(usage && typeof usage === "object", "run usage totals present");
  assert.ok(!JSON.stringify(usage).includes("CREDENTIALS"), "no credential in usage totals");
  console.log("✓ P3+P6. agent_events linked by run_id; redacted summary carries no raw payload / toolInput / toolOutput / message body / credentials");
}

// ─── P4. Four run statuses ─────────────────────────────────────────────
// (a) success — already covered above; assert status persisted.
{
  const h = await makeHarness("m3-success");
  const runId = currentRunId(h.session)!;
  h.rt.pushEvent({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 1 });
  await flush();
  const detail = agentRunService.getRun(runId, { role: "admin", orgId: DEFAULT_ORG_ID })!;
  assert.equal(detail.run.status, "success", "success run → status=success");
  console.log("✓ P4a. success run → status=success");
}

// (b) failed — non-success result, no prior rejection.
{
  const h = await makeHarness("m3-failed");
  const runId = currentRunId(h.session)!;
  h.rt.pushEvent({ type: "result", subtype: "error_max_turns", result: "", total_cost_usd: 0.5, duration_ms: 9000 });
  await flush();
  const detail = agentRunService.getRun(runId, { role: "admin", orgId: DEFAULT_ORG_ID })!;
  assert.equal(detail.run.status, "failed", "non-success result → status=failed");
  console.log("✓ P4b. failed run → status=failed");
}

// (c) tool_rejected — non-success result preceded by a reject approval_decision.
{
  const h = await makeHarness("m3-rejected");
  const runId = currentRunId(h.session)!;
  // Record a reject decision on this run through the existing event path.
  // (In production this is recorded by Session.onPreToolUse after
  // handleApprovalResponse; here we exercise the same appendEvent path.)
  eventStore.appendEvent(
    h.userId,
    h.chatId,
    (h.session as unknown as { agentSessionRecord: { id: string } }).agentSessionRecord.id,
    "approval_decision",
    { id: "ap-1", toolName: "Bash", decision: "reject", reason: "user denied" },
    runId
  );
  await flush();
  h.rt.pushEvent({ type: "result", subtype: "error_max_turns", result: "", total_cost_usd: 0.3, duration_ms: 4000 });
  await flush();
  const detail = agentRunService.getRun(runId, { role: "admin", orgId: DEFAULT_ORG_ID })!;
  assert.equal(detail.run.status, "tool_rejected", "non-success + prior reject decision → status=tool_rejected");
  // The reject decision shows in the redacted summary.
  const dec = detail.events.find((e) => e.eventType === "approval_decision")!;
  assert.equal(dec.decision, "reject", "reject decision visible in summary");
  assert.equal(dec.toolName, "Bash", "reject decision toolName visible");
  assert.ok(!JSON.stringify(dec).includes("reason"), "reason field not surfaced (metadata-light)"); // decision + toolName only by redaction
  console.log("✓ P4c. tool_rejected run → status=tool_rejected (reject decision flips non-success)");
}

// (d) stopped — aborted before any result.
{
  const h = await makeHarness("m3-stopped");
  const runId = currentRunId(h.session)!;
  h.session.stop();
  await flush();
  assert.equal(currentRunId(h.session), null, "currentRunId cleared after stop");
  const detail = agentRunService.getRun(runId, { role: "admin", orgId: DEFAULT_ORG_ID })!;
  assert.equal(detail.run.status, "stopped", "aborted run → status=stopped");
  assert.ok(detail.run.endedAt, "stopped run has endedAt");
  console.log("✓ P4d. stopped run → status=stopped (abort marks running run stopped)");
}

// ─── P5. Admin-only access; existence hidden ─────────────────────────
{
  const h = await makeHarness("m3-access", DEFAULT_ORG_ID);
  const runId = currentRunId(h.session)!;
  h.rt.pushEvent({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 1 });
  await flush();

  // admin same-org → detail.
  assert.ok(agentRunService.getRun(runId, { role: "admin", orgId: DEFAULT_ORG_ID }), "admin same-org → detail");
  // user → null (hidden).
  assert.equal(agentRunService.getRun(runId, { role: "user", orgId: DEFAULT_ORG_ID }), null, "user → null (admin-only)");
  // org_admin → null (M3 defers org_admin access; hidden, not 403-disclosed).
  assert.equal(agentRunService.getRun(runId, { role: "org_admin", orgId: DEFAULT_ORG_ID }), null, "org_admin → null (deferred in M3)");
  // cross-org admin → null (existence hidden, not disclosed as 403).
  assert.equal(agentRunService.getRun(runId, { role: "admin", orgId: "other-org" }), null, "cross-org admin → null (hidden)");
  // non-existent runId → null (admin same-org).
  assert.equal(agentRunService.getRun("no-such-run", { role: "admin", orgId: DEFAULT_ORG_ID }), null, "non-existent runId → null");
  console.log("✓ P5. admin-only access; user + org_admin + cross-org + non-existent all hidden (null)");
}

// ─── Resume keeps runId (warm); new message mints new (cold boundary) ─
{
  // Warm reconnect: the SAME in-memory Session keeps its currentRunId across
  // messages within a turn. P3 already proved all events in a turn share one
  // runId. Here we prove a still-running run (no result yet) retains its runId
  // across a flush (simulating a reconnect window).
  // S2 rev (serialized dispatch): the next user message now WAITS for the
  // active turn's result — it can no longer mint a new run while the prior is
  // still running (that mid-run sweep was the exact corruption the return-fix
  // contract corr. #2 removed). The cold boundary is: result finalizes turn 1,
  // then the next message dispatches and mints a fresh runId.
  const h = await makeHarness("m3-resume");
  const runId1 = currentRunId(h.session)!;
  await flush(30); // simulate a reconnect/wait window — runId unchanged
  assert.equal(currentRunId(h.session), runId1, "warm: runId persists mid-run across a wait");
  // The DB row is still 'running'.
  let row = db.prepare(`SELECT status FROM agent_runs WHERE id = ?`).get(runId1) as { status: string };
  assert.equal(row.status, "running", "mid-run DB status stays 'running'");

  // Finalize turn 1 (success), then send the next message.
  h.rt.pushEvent({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 1 });
  await flush();
  row = db.prepare(`SELECT status FROM agent_runs WHERE id = ?`).get(runId1) as { status: string };
  assert.equal(row.status, "success", "turn 1 finalized by its result");
  h.session.sendMessage("resume-next");
  await flush();
  const runId2 = currentRunId(h.session)!;
  assert.ok(runId2 !== runId1, "new user message after the prior result → new runId");
  h.rt.pushEvent({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0, duration_ms: 1 });
  await flush();
  console.log("✓ Resume boundary: warm runId persists mid-run; next turn mints a new runId after the prior result");
}

// ─── Audit-volume boundary: exactly ONE fixed-size run row per execution ─
{
  const before = (db.prepare(`SELECT COUNT(*) as c FROM agent_runs`).get() as { c: number }).c;
  const h = await makeHarness("m3-volume");
  const runId = currentRunId(h.session)!;
  // Push MANY events (stream-like) — they must NOT create extra run rows.
  for (let i = 0; i < 20; i++) {
    h.rt.pushEvent({ type: "assistant", message: { content: [{ type: "text", text: `chunk ${i}` }] } } as RuntimeEvent);
  }
  await flush(30);
  h.rt.pushEvent({ type: "result", subtype: "success", result: "done", total_cost_usd: 0, duration_ms: 1 });
  await flush();
  const after = (db.prepare(`SELECT COUNT(*) as c FROM agent_runs`).get() as { c: number }).c;
  assert.equal(after - before, 1, "exactly ONE run row added for one execution (no per-event/per-chunk rows)");
  // The run row is fixed-size: no payload_json column on agent_runs at all.
  const cols = (db.prepare(`PRAGMA table_info(agent_runs)`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!cols.includes("payload_json"), "agent_runs has NO payload_json column (fixed-size row, no bodies)");
  assert.ok(!cols.includes("tool_input"), "agent_runs has NO tool_input column");
  assert.ok(!cols.includes("tool_output"), "agent_runs has NO tool_output column");
  console.log("✓ Audit volume: one fixed-size run row per execution; no payload/toolInput/toolOutput columns on agent_runs");
}

console.log("\nAll M3 runId audit tests passed.");
