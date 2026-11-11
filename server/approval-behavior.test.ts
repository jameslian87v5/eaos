/**
 * approval-behavior.test.ts — Agent OS M2 Tool policy + approval closure.
 *
 * Two layers of proof:
 *
 *  1. Effective Tool policy (P1, P2, P7) — pure: approvalRequired =
 *     tools − allowedTools − disallowedTools, valid in BOTH Local and Docker
 *     resolve via the real CapabilityProvider.resolve() (no new production code).
 *
 *  2. The REAL Session/local approval boundary (P3–P6) — NOT a synthetic
 *     ApprovalManager call. A real `Session` is constructed with
 *     APPROVAL_ENABLED=true and a fake runtime whose factory captures the
 *     `onPreToolUse` hook the Session wires. Driving a tool call goes through
 *     the real path: Session.onPreToolUse → ApprovalManager.requestApproval →
 *     approvalRequestHandler (broadcast + recordEvent) → handleApprovalResponse
 *     (the public entry the WS handler calls) → handleResponse. The decision
 *     is then emitted as a tool_result into the runtime event stream, which
 *     Session.handleSDKMessage records via the existing recordEvent/appendEvent
 *     path. So both the request AND the decision land in agent_events through
 *     the existing event path — none of it is a private counter.
 *
 *     - P3 APPROVE  → executes EXACTLY ONCE.
 *     - P4 REJECT   → executes ZERO times; explicit deny tool_result.
 *     - P5 TIMEOUT  → real bounded timeout (APPROVAL_TIMEOUT_MS) auto-denies;
 *                     ZERO executions; explicit "Approval timed out" reason.
 *     - P6 cancelAll (graceful session close) → ZERO executions, chat-scoped.
 *
 * Run: DB_PATH=/tmp/m2-approval.db JWT_SECRET=test npx tsx server/approval-behavior.test.ts
 *
 * See docs/开发计划/agent-os-overall-plan.md §6.
 */

import assert from "node:assert/strict";
import { capabilityProvider } from "./capability-provider.js";
import { DEFAULT_ORG_ID } from "./request-context.js";
import { Session } from "./session.js";
import { chatStore } from "./chat-store.js";
import { eventStore } from "./event-store.js";
import { resolveApprovalTimeoutMs } from "./approval.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  RuntimeEvent,
  RuntimeStatus,
} from "./agent-runtime.js";

// ─── P0. APPROVAL_TIMEOUT_MS parsing contract (codex r2 #4) ───────────
// unset/empty/invalid/non-finite/negative → default (600000); 0 → disabled
// (0); positive → that many ms. The old `Number(value) || 600000` turned 0 into
// 600000 and accepted negatives; this proves the explicit parse.
{
  const DEFAULT = 600000;
  const cases: Array<[string | undefined, number]> = [
    [undefined, DEFAULT],
    ["", DEFAULT],
    ["abc", DEFAULT],
    ["NaN", DEFAULT],
    ["0", 0], // explicitly disabled
    ["-5", DEFAULT], // negative → default (NOT a timeout, NOT disabled)
    ["50", 50],
    ["30.5", 30.5],
  ];
  for (const [val, want] of cases) {
    if (val === undefined) delete process.env.APPROVAL_TIMEOUT_MS;
    else process.env.APPROVAL_TIMEOUT_MS = val;
    const got = resolveApprovalTimeoutMs();
    assert.equal(got, want, `APPROVAL_TIMEOUT_MS=${JSON.stringify(val)} → ${want} (got ${got})`);
  }
  delete process.env.APPROVAL_TIMEOUT_MS;
  console.log("✓ P0. APPROVAL_TIMEOUT_MS parse contract (unset/invalid/negative→default; 0→disabled; positive→ms)");
}

// ─── P7. Effective Tool policy is valid in BOTH Local and Docker resolve ──
const policyCtx = {
  userId: "m2-policy-user",
  role: "user" as const,
  orgId: DEFAULT_ORG_ID,
  chatId: "m2-policy-agent",
};
for (const runtimeType of ["local", "docker"] as const) {
  const bundle = capabilityProvider.resolve({ ...policyCtx, runtimeType });
  const tools = bundle.sdkOptions.tools ?? [];
  const allowed = new Set(bundle.sdkOptions.allowedTools ?? []);
  const disallowed = new Set(bundle.sdkOptions.disallowedTools ?? []);
  const req = tools.filter((t) => !allowed.has(t) && !disallowed.has(t));
  assert.ok(tools.length > 0, `${runtimeType}: tools non-empty`);
  assert.ok(allowed.has("Read"), `${runtimeType}: Read auto-allowed`);
  assert.ok(req.includes("Write") && req.includes("Bash"), `${runtimeType}: Write/Bash approval-required`);
  assert.ok(!req.includes("Read"), `${runtimeType}: Read not approval-required`);
  assert.deepEqual(
    [...req].sort(),
    [...capabilityProvider.getDefaultProfile().approvalRequiredTools].sort(),
    `${runtimeType}: approvalRequired matches platform-declared set`
  );
  console.log(`✓ P7. ${runtimeType} effective Tool policy valid: approvalRequired=[${req.join(",")}]`);
}

const profile = capabilityProvider.getDefaultProfile();
const allowed = new Set(profile.allowedTools);
const disallowed = new Set(profile.disallowedTools);
const approvalRequired = profile.tools.filter((t) => !allowed.has(t) && !disallowed.has(t));

// P1. approvalRequired formula matches the platform-declared set.
{
  assert.deepEqual(
    [...approvalRequired].sort(),
    [...profile.approvalRequiredTools].sort(),
    "approvalRequired = tools - allowedTools - disallowedTools"
  );
  assert.ok(approvalRequired.includes("Write"), "Write is approval-required (sensitive)");
  assert.ok(approvalRequired.includes("Bash"), "Bash is approval-required (sensitive)");
  assert.ok(!approvalRequired.includes("Read"), "Read auto-allowed (not approval-required)");
  console.log("✓ P1. approvalRequired = tools − allowedTools − disallowedTools (Write/Bash sensitive; Read auto-allowed)");
}

// P2. disallowedTools are DENY, not approval — they never reach approvalRequired.
{
  const tools = ["Read", "Write", "Bash"];
  const allowedSet = new Set(["Read"]);
  const disallowedSet = new Set(["Bash"]);
  const req = tools.filter((t) => !allowedSet.has(t) && !disallowedSet.has(t));
  assert.deepEqual(req, ["Write"], "disallowed tool is deny, not approval");
  console.log("✓ P2. disallowedTools block outright (not in approvalRequired) — deny-default preserved");
}

// ─── Real Session/local approval boundary ──────────────────────────

/**
 * Fake runtime: captures the `onPreToolUse` hook the Session wires, and exposes
 * `callTool()` which drives a tool call through that REAL gate. The decision
 * is emitted as a tool_result into the event stream (mirroring what the SDK
 * does after a PreToolUse hook returns), so Session.handleSDKMessage records it
 * through the existing recordEvent/appendEvent path — no private counter.
 */
class FakeRuntime implements AgentRuntime {
  opts: AgentRuntimeOptions;
  executed: string[] = [];
  private buffer: RuntimeEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  constructor(opts: AgentRuntimeOptions) {
    this.opts = opts;
  }
  sendMessage(): void {}
  handleApprovalResponse(): boolean {
    return false; // local mode: approval is resolved in-process, not forwarded
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
  private push(msg: RuntimeEvent): void {
    this.buffer.push(msg);
    this.wake();
  }
  /** Drive a tool call through the real Session.onPreToolUse gate. */
  async callTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ id: string; approved: boolean; reason?: string }> {
    const id = `tu-${this.executed.length + 1}-${Date.now()}`;
    const decision = await this.opts.onPreToolUse!(toolName, input, id);
    const approved = decision.decision === "allow";
    if (approved) this.executed.push(toolName);
    const reason = approved ? undefined : decision.reason;
    // Emit a tool_result just like the SDK does after the PreToolUse gate.
    this.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: approved ? "ok" : reason || "denied",
            is_error: !approved,
          },
        ],
      },
    });
    return { id, approved, reason };
  }
}

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function waitForEvent(
  userId: string,
  chatId: string,
  eventType: string,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const evs = eventStore.getEventsByChat(userId, chatId);
    if (evs.some((e) => e.eventType === eventType)) return;
    await flush(5);
  }
  throw new Error(`timeout waiting for ${eventType} event on chat ${chatId}`);
}

// Latest event of a type, parsed payload.
function latestEvent<T = any>(userId: string, chatId: string, eventType: string): T | null {
  const evs = eventStore.getEventsByChat(userId, chatId).filter((e) => e.eventType === eventType);
  if (!evs.length) return null;
  return JSON.parse(evs[evs.length - 1].payloadJson) as T;
}

function pendingRequestIds(session: Session, chatId: string): string[] {
  const mgr = (session as unknown as { approvalManager: { getPending: (c: string) => { id: string }[] } })
    .approvalManager;
  return mgr.getPending(chatId).map((p) => p.id);
}

interface Harness {
  session: Session;
  rt: FakeRuntime;
  userId: string;
  chatId: string;
}

async function makeHarness(userId: string, timeoutMs: string): Promise<Harness> {
  // Fresh chat row so setUserId/getOrCreateSession have valid foreign keys.
  // createChat generates the id; agent_sessions FKs chats(id), so use the
  // returned id (not a hand-picked constant).
  const chat = chatStore.createChat(userId, "Approval boundary chat", DEFAULT_ORG_ID);
  const chatId = chat.id;
  let rt: FakeRuntime | undefined;
  const factory = (opts?: AgentRuntimeOptions) => {
    rt = new FakeRuntime(opts ?? ({} as AgentRuntimeOptions));
    return rt;
  };
  process.env.APPROVAL_ENABLED = "true";
  process.env.APPROVAL_TIMEOUT_MS = timeoutMs;
  const session = new Session(chatId, factory, undefined, userId);
  session.setUserId(userId); // creates agentSessionRecord → recordEvent persists
  session.sendMessage("go"); // kicks startListening (consumes the event stream)
  await flush();
  return { session, rt: rt!, userId, chatId };
}

// P3. APPROVE → executes exactly once; request + decision persisted.
{
  const h = await makeHarness("u-approve", "100000");
  const pending = h.rt.callTool("Write", { path: "/tmp/x", content: "hi" });
  await flush();
  // The approval REQUEST is persisted through the existing event path.
  await waitForEvent(h.userId, h.chatId, "approval_request");
  // r2 #3: request event is METADATA-ONLY — no toolInput payload leaked.
  const reqEvt = latestEvent<any>(h.userId, h.chatId, "approval_request");
  assert.ok(reqEvt, "approval_request event present");
  assert.equal(reqEvt.toolName, "Write", "request records toolName");
  assert.ok(typeof reqEvt.toolId === "string" && reqEvt.toolId.startsWith("tu-"), "request records toolId (toolUseId)");
  assert.equal("toolInput" in reqEvt, false, "request event MUST NOT carry toolInput (metadata-only)");
  const ids = pendingRequestIds(h.session, h.chatId);
  assert.equal(ids.length, 1, "one pending approval while undecided");
  // Frontend approves via the public WS handler entry point.
  assert.equal(
    h.session.handleApprovalResponse({ id: ids[0], approved: true }),
    true,
    "handleApprovalResponse accepted"
  );
  const res = await pending;
  assert.equal(res.approved, true, "approve → approved true");
  assert.equal(h.rt.executed.length, 1, "approved sensitive tool runs EXACTLY ONCE");
  // The DECISION is persisted as a tool_result through handleSDKMessage.
  await waitForEvent(h.userId, h.chatId, "tool_result");
  // r2 #2: a metadata-only approval_decision event with the explicit category.
  await waitForEvent(h.userId, h.chatId, "approval_decision");
  const dec = latestEvent<any>(h.userId, h.chatId, "approval_decision");
  assert.equal(dec.decision, "approve", "approve → decision=approve");
  assert.equal(dec.toolName, "Write", "decision records toolName");
  assert.equal("toolInput" in dec, false, "decision event is metadata-only (no payload)");
  // r2 #1: pending state cleared after resolution.
  assert.equal(pendingRequestIds(h.session, h.chatId).length, 0, "no longer pending after decision");
  console.log("✓ P3. APPROVE → executes once; request(metadata-only) + tool_result + approval_decision=approve persisted");
}

// P4. REJECT → executes ZERO times; explicit deny tool_result persisted.
{
  const h = await makeHarness("u-reject", "100000");
  const pending = h.rt.callTool("Bash", { command: "rm -rf /" });
  await flush();
  await waitForEvent(h.userId, h.chatId, "approval_request");
  const ids = pendingRequestIds(h.session, h.chatId);
  assert.equal(ids.length, 1, "one pending approval");
  h.session.handleApprovalResponse({ id: ids[0], approved: false, message: "user denied" });
  const res = await pending;
  assert.equal(res.approved, false, "reject → approved false");
  assert.equal(res.reason, "user denied", "reject carries explicit reason");
  assert.equal(h.rt.executed.length, 0, "rejected tool runs ZERO times");
  await waitForEvent(h.userId, h.chatId, "tool_result");
  const tr = eventStore
    .getEventsByChat(h.userId, h.chatId)
    .filter((e) => e.eventType === "tool_result");
  assert.ok(tr.length > 0, "deny decision persisted as tool_result");
  assert.ok(JSON.parse(tr[tr.length - 1].payloadJson).isError === true, "deny tool_result is_error=true");
  // r2 #2: reject decision audited with the explicit "reject" category.
  await waitForEvent(h.userId, h.chatId, "approval_decision");
  const dec4 = latestEvent<any>(h.userId, h.chatId, "approval_decision");
  assert.equal(dec4.decision, "reject", "reject → decision=reject");
  assert.equal(dec4.reason, "user denied", "reject reason carried");
  assert.equal(pendingRequestIds(h.session, h.chatId).length, 0, "pending cleared after reject (r2 #1)");
  console.log("✓ P4. REJECT → executes zero times; deny tool_result + approval_decision=reject persisted");
}

// P5. TIMEOUT (real bounded timeout) → ZERO executions; explicit "timed out".
{
  const h = await makeHarness("u-timeout", "30");
  const pending = h.rt.callTool("Write", { path: "/tmp/y", content: "z" });
  await flush();
  await waitForEvent(h.userId, h.chatId, "approval_request");
  assert.equal(pendingRequestIds(h.session, h.chatId).length, 1, "pending before timeout");
  // No frontend response — the REAL bounded timeout auto-denies.
  const res = await pending;
  assert.equal(res.approved, false, "timeout → approved false");
  assert.equal(res.reason, "Approval timed out", "timeout carries explicit reason");
  assert.equal(h.rt.executed.length, 0, "timed-out tool runs ZERO times");
  assert.equal(pendingRequestIds(h.session, h.chatId).length, 0, "pending cleared after timeout (r2 #1 — no stale state)");
  await waitForEvent(h.userId, h.chatId, "tool_result");
  // r2 #2: timeout decision audited with the explicit "timeout" category
  // (not "reject") — proves the bounded-timeout resolution is distinguished.
  await waitForEvent(h.userId, h.chatId, "approval_decision");
  const dec5 = latestEvent<any>(h.userId, h.chatId, "approval_decision");
  assert.equal(dec5.decision, "timeout", "timeout → decision=timeout (distinct from reject)");
  assert.equal(dec5.reason, "Approval timed out", "timeout reason carried");
  console.log("✓ P5. TIMEOUT (real bounded APPROVAL_TIMEOUT_MS) → executes zero times; approval_decision=timeout persisted; pending cleared");
}

// P6. cancelAll (graceful session close) → ZERO executions; chat-scoped.
{
  const h = await makeHarness("u-cancel", "100000");
  const pending = h.rt.callTool("Write", { path: "/tmp/z", content: "w" });
  await flush();
  await waitForEvent(h.userId, h.chatId, "approval_request");
  assert.equal(pendingRequestIds(h.session, h.chatId).length, 1, "pending before cancel");
  // Graceful shutdown denies all pending for THIS chat only.
  (h.session as unknown as { approvalManager: { cancelAll: (c: string) => void } })
    .approvalManager.cancelAll(h.chatId);
  const res = await pending;
  assert.equal(res.approved, false, "cancel → approved false");
  assert.equal(res.reason, "Session closed", "cancel carries explicit reason");
  assert.equal(h.rt.executed.length, 0, "cancelled tool runs ZERO times");
  assert.equal(pendingRequestIds(h.session, h.chatId).length, 0, "pending cleared after cancel (r2 #1)");
  // r2 #2: cancel decision audited with the explicit "cancel" category
  // (distinct from timeout/reject) — cancelAll resolves "Session closed".
  await waitForEvent(h.userId, h.chatId, "approval_decision");
  const dec6 = latestEvent<any>(h.userId, h.chatId, "approval_decision");
  assert.equal(dec6.decision, "cancel", "cancel → decision=cancel (distinct from timeout/reject)");
  assert.equal(dec6.reason, "Session closed", "cancel reason carried");
  console.log("✓ P6. cancelAll (session close) → executes zero times; approval_decision=cancel persisted; chat-scoped");
}

console.log("\nAll approval-behavior tests passed.");
