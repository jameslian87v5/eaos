// M4 (evt_20260818054910) — 上下文可见性与 Auto Compact 阈值守卫. Focused proof
// for the M4 boundary (docs/开发计划/model-and-token-management-plan.md §4.2/§4.3 phase 1):
//   - platform/org compaction policy: clamp bands (组织值受平台上限约束),
//     narrow-only enabled, read-back re-clamp when the platform is lowered;
//   - turn-boundary trigger wiring in Session (stub runtime): fires AFTER the
//     result event, exactly once per boundary, never re-triggers on the
//     /compact turn's own result, releases on compact_boundary;
//   - explicit compact events recorded (auto_compact + compact_boundary) and
//     the Chat context visibility endpoint (estimate / cumulative / last
//     compact) with owner-scoped access.
//
// NOT tested here (out of M4): Provider import (M5), Billing (M6), real SDK
// /compact semantics (stub runtime proves OUR wiring only).
//
// Run: npx tsx server/context-compaction.test.ts  (chdir's to a scratch dir)
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import type { AgentRuntime, RuntimeEvent, RuntimeStatus } from "./agent-runtime.js";

const PORT = "3994";
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "context-compact-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.PORT = PORT;
process.env.JWT_SECRET = "context-compact-test-secret-4d1e";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

const db = (await import("./database.js")).default;
const { chatStore } = await import("./chat-store.js");
const cp = await import("./compact-policy.js");
const { getChatUsageStats, getChatLastCompact } = await import("./token-usage-service.js");
const { saveRuntimeSettings } = await import("./runtime-settings.js");
const { Session } = await import("./session.js");

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// ─── Fixtures ─────────────────────────────────────────────────
const ORG = "default-org";
const ORG_B = "org-b";
db.prepare(`INSERT OR IGNORE INTO organizations (id, name, status) VALUES ('${ORG_B}', 'B 部', 'active')`).run();

const u1 = "cc-u1";
const chatA = chatStore.createChat(u1, "chatA", ORG);

// Pin the platform default explicitly (file-backed settings in the scratch dir).
saveRuntimeSettings({ contextCompaction: { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 } });

// ─── A: policy service ────────────────────────────────────────

// A1. No org row → platform default, source=platform.
{
  const eff = cp.getEffectiveCompaction(ORG);
  ok("A1a absent overlay → platform default", eff.source === "platform" && eff.enabled && eff.thresholdTokens === 100_000 && eff.keepRecentTurns === 10, JSON.stringify(eff));
  ok("A1b null orgId → platform default", cp.getEffectiveCompaction(null).source === "platform");
}

// A2. Org overlay within caps is honored as-is.
{
  const { policy } = cp.setOrgCompactPolicy(ORG, { enabled: true, thresholdTokens: 50_000, keepRecentTurns: 5 });
  ok("A2a org overlay stored", policy.source === "org" && policy.enabled && policy.thresholdTokens === 50_000 && policy.keepRecentTurns === 5, JSON.stringify(policy));
  const eff = cp.getEffectiveCompaction(ORG);
  ok("A2b effective picks org overlay", eff.source === "org" && eff.thresholdTokens === 50_000);
}

// A3. 组织值受平台上限约束: caps = hard band ∩ CURRENT platform setting, and
//     the platform setting doubles as the org CEILING.
{
  const caps = cp.getCompactionCaps();
  ok("A3a caps derived from platform config", caps.maxThresholdTokens === 100_000 && caps.maxKeepRecentTurns === 10, JSON.stringify(caps));
  const r = cp.setOrgCompactPolicy(ORG, { thresholdTokens: 500_000, keepRecentTurns: 99 });
  ok("A3b over-cap values clamped + reported",
    r.stored.thresholdTokens === 100_000 && r.stored.keepRecentTurns === 10 &&
    r.clamped.includes("thresholdTokens") && r.clamped.includes("keepRecentTurns"),
    JSON.stringify(r));
  // Stricter (lower) values are always allowed.
  const r2 = cp.setOrgCompactPolicy(ORG, { thresholdTokens: 20_000, keepRecentTurns: 2 });
  ok("A3c stricter values pass unclamped", r2.stored.thresholdTokens === 20_000 && r2.stored.keepRecentTurns === 2 && r2.clamped.length === 0, JSON.stringify(r2));
  cp.setOrgCompactPolicy(ORG, { thresholdTokens: 50_000, keepRecentTurns: 5 });
}

// A4. Read-back re-clamp: lowering the platform immediately caps a stored org
//     row that was legal under the old ceiling (stale values never effective).
{
  const { policy } = cp.setOrgCompactPolicy(ORG, { thresholdTokens: 80_000, keepRecentTurns: 8 });
  ok("A4a stored under old ceiling", policy.thresholdTokens === 80_000);
  saveRuntimeSettings({ contextCompaction: { enabled: true, thresholdTokens: 60_000, keepRecentTurns: 6 } });
  const eff = cp.getEffectiveCompaction(ORG);
  ok("A4b lowered platform re-clamps stored org value on read", eff.thresholdTokens === 60_000 && eff.keepRecentTurns === 6, JSON.stringify(eff));
  saveRuntimeSettings({ contextCompaction: { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 } });
  cp.setOrgCompactPolicy(ORG, { thresholdTokens: 50_000, keepRecentTurns: 5 });
}

// A5. Narrow-only enabled: platform-off wins even when the org row says on.
{
  saveRuntimeSettings({ contextCompaction: { enabled: false, thresholdTokens: 100_000, keepRecentTurns: 10 } });
  const r = cp.setOrgCompactPolicy(ORG, { enabled: true });
  ok("A5a stored.enabled kept as requested", r.stored.enabled === true, JSON.stringify(r.stored));
  ok("A5b effective stays OFF (org can only narrow)", r.policy.enabled === false, JSON.stringify(r.policy));
  // Platform back on → org row (on) becomes effective.
  saveRuntimeSettings({ contextCompaction: { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 } });
  ok("A5c platform re-enabled → org overlay effective", cp.getEffectiveCompaction(ORG).enabled === true);
  // Org turning itself off is always allowed.
  cp.setOrgCompactPolicy(ORG, { enabled: false });
  ok("A5d org may disable for itself", cp.getEffectiveCompaction(ORG).enabled === false);
  cp.setOrgCompactPolicy(ORG, { enabled: true });
}

// A6. Hard validation.
{
  assert.throws(() => cp.setOrgCompactPolicy("no-such-org", { thresholdTokens: 50_000 }), /Organization not found/);
  ok("A6a unknown org rejected", true);
  assert.throws(() => cp.setOrgCompactPolicy(ORG, { thresholdTokens: "abc" }), /thresholdTokens must be a finite number/);
  ok("A6b non-numeric value rejected", true);
}

// A7. Pure decision fn + estimate.
{
  const p = { enabled: true, thresholdTokens: 50_000, keepRecentTurns: 5 };
  ok("A7a estimate = input + cacheCreation + cacheRead (no output)",
    cp.contextEstimateTokens({ inputTokens: 30_000, cacheCreationTokens: 10_000, cacheReadTokens: 15_000 }) === 55_000);
  ok("A7b no policy → no trigger", cp.evaluateAutoCompact(null, 999_999, false).reason === "no_policy");
  ok("A7c disabled → no trigger", cp.evaluateAutoCompact({ ...p, enabled: false }, 999_999, false).reason === "disabled");
  ok("A7d in-flight → no trigger", cp.evaluateAutoCompact(p, 999_999, true).reason === "in_flight");
  ok("A7e no usage → no trigger", cp.evaluateAutoCompact(p, null, false).reason === "no_usage");
  ok("A7f below threshold → no trigger", cp.evaluateAutoCompact(p, 49_999, false).reason === "below_threshold");
  const hit = cp.evaluateAutoCompact(p, 50_000, false);
  ok("A7g at/above threshold → trigger", hit.trigger && hit.reason === "threshold_reached" && hit.thresholdTokens === 50_000);
}

// ─── B: Session turn-boundary wiring (stub runtime) ───────────

class StubRuntime implements AgentRuntime {
  sent: string[] = [];
  private queue: RuntimeEvent[] = [];
  private waiters: Array<(r: IteratorResult<RuntimeEvent>) => void> = [];
  sendMessage(content: string): void {
    this.sent.push(content);
  }
  push(ev: RuntimeEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  async *getEventStream(): AsyncIterable<RuntimeEvent> {
    for (;;) {
      const ev = await new Promise<RuntimeEvent>((resolve) => {
        const queued = this.queue.shift();
        if (queued) resolve(queued);
        else this.waiters.push((r) => resolve(r.value!));
      });
      yield ev;
    }
  }
  abort(): void {}
  close(): void {}
  getStatus(): RuntimeStatus {
    return "running";
  }
}

const flush = () => new Promise((r) => setTimeout(r, 50));

{
  const stub = new StubRuntime();
  const busy: boolean[] = [];
  const session = new Session(chatA.id, () => stub, {
    onSubscriberCountChange: () => {},
    onAgentBusyChange: (_u, _c, b) => busy.push(b),
    onPendingApprovalChange: () => {},
  });
  session.setUserId(u1); // creates the agent_session record → events persist

  // Org policy from A: threshold 50k / keep 5 / enabled.
  // B1. Turn 1 crosses the threshold (estimate 55k) → trigger AFTER the result.
  session.sendMessage("hello");
  stub.push({
    type: "result", subtype: "success", result: "answer text",
    usage: { input_tokens: 30_000, output_tokens: 2_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 15_000 },
  } as RuntimeEvent);
  await flush();
  ok("B1a /compact sent to the runtime at the turn boundary", stub.sent.includes("/compact"), JSON.stringify(stub.sent));
  const evTypes = (type: string) =>
    (db.prepare(`SELECT payload_json FROM agent_events WHERE chat_id = ? AND event_type = ? ORDER BY sequence`).all(chatA.id, type) as Array<{ payload_json: string }>);
  const results = evTypes("result");
  ok("B1b result event persisted with camelCase usage",
    results.length === 1 && JSON.parse(results[0].payload_json).usage.inputTokens === 30_000,
    results[0]?.payload_json);
  const autos = evTypes("auto_compact");
  ok("B1c explicit auto_compact audit event",
    autos.length === 1 && JSON.parse(autos[0].payload_json).thresholdTokens === 50_000,
    autos[0]?.payload_json);
  ok("B1d busy cycle: true (send) → false (result) → true (compact turn)",
    busy.length === 3 && busy[0] === true && busy[1] === false && busy[2] === true,
    JSON.stringify(busy));

  // B2. The /compact turn's own result NEVER re-evaluates (estimate still over).
  stub.push({
    type: "result", subtype: "success", result: "compacted",
    usage: { input_tokens: 60_000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as RuntimeEvent);
  await flush();
  ok("B2 exactly-once: no second /compact from the command turn's result", stub.sent.filter((s) => s === "/compact").length === 1, JSON.stringify(stub.sent));

  // B3. compact_boundary releases the gate and is persisted.
  stub.push({
    type: "system", subtype: "compact_boundary",
    compact_metadata: { pre_tokens: 55_000, post_tokens: 12_000, trigger: "auto" },
  } as unknown as RuntimeEvent);
  await flush();
  const bounds = evTypes("compact_boundary");
  ok("B3a compact_boundary event persisted",
    bounds.length === 1 && JSON.parse(bounds[0].payload_json).preTokens === 55_000,
    bounds[0]?.payload_json);

  // B4. A below-threshold turn does not trigger; a later crossing turn does.
  session.sendMessage("small turn");
  stub.push({
    type: "result", subtype: "success", result: "ok",
    usage: { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 100 },
  } as RuntimeEvent);
  await flush();
  ok("B4a below threshold → no trigger", stub.sent.filter((s) => s === "/compact").length === 1, JSON.stringify(stub.sent));
  session.sendMessage("big turn");
  stub.push({
    type: "result", subtype: "success", result: "ok",
    usage: { input_tokens: 40_000, output_tokens: 1_000, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 10_000 },
  } as RuntimeEvent);
  await flush();
  ok("B4b gate released by boundary → next crossing triggers again", stub.sent.filter((s) => s === "/compact").length === 2, JSON.stringify(stub.sent));
  // Drain the auto /compact turn's result so cumulative sums are deterministic.
  stub.push({ type: "result", subtype: "success", result: "compacted", usage: { input_tokens: 10_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as RuntimeEvent);
  await flush();
  stub.push({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 55_000, trigger: "auto" } } as unknown as RuntimeEvent);
  await flush();
  session.close();

  // B5. Chat-scoped read models for the visibility chip.
  const stats = getChatUsageStats(ORG, chatA.id);
  // results: 30k/2k/10k/15k + 60k/0.5k/0/0 + 0.1k×4 + 40k/1k/5k/10k + 10k/0.1k/0/0
  ok("B5a cumulative usage sums 4 dims",
    stats.usage.inputTokens === 140_100 && stats.usage.outputTokens === 3_700 &&
    stats.usage.cacheCreationTokens === 15_100 && stats.usage.cacheReadTokens === 25_100 && stats.usage.turns === 5,
    JSON.stringify(stats.usage));
  ok("B5b last-result estimate = input-side of the newest result", stats.lastResultEstimateTokens === 10_000, String(stats.lastResultEstimateTokens));
  const lc = getChatLastCompact(ORG, chatA.id);
  ok("B5c last compact = newest boundary", lc != null && lc.preTokens === 55_000 && lc.trigger === "auto", JSON.stringify(lc));
  ok("B5d foreign org sees nothing", getChatUsageStats(ORG_B, chatA.id).usage.turns === 0 && getChatLastCompact(ORG_B, chatA.id) === null);
}

// ─── C: HTTP + permissions ────────────────────────────────────

await import("./server.js");
const BASE = `http://127.0.0.1:${PORT}`;

{
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "__probe__", password: "__probe__" }) }); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
  const { default: jwt } = await import("jsonwebtoken");
  const mint = (userId: string, username: string, role: string, orgId: string) =>
    jwt.sign({ userId, username, role, orgId, tokenVersion: 1 }, process.env.JWT_SECRET!, { expiresIn: "1h" });

  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
  ok("C1 admin login", login.ok);
  const adminToken = ((await login.json()) as { token: string }).token;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, org_id, status, must_change_password)
     VALUES ('${u1}', 'cc1', 'x', '用户一', 'user', '${ORG}', 'active', 0),
            ('cc-u2', 'cc2', 'x', NULL, 'user', '${ORG}', 'active', 0),
            ('cc-oa', 'ccoa', 'x', NULL, 'org_admin', '${ORG}', 'active', 0),
            ('cc-ob', 'ccob', 'x', NULL, 'org_admin', '${ORG_B}', 'active', 0)`
  ).run();
  const oaToken = mint("cc-oa", "ccoa", "org_admin", ORG);
  const obToken = mint("cc-ob", "ccob", "org_admin", ORG_B);
  const userToken = mint(u1, "cc1", "user", ORG);
  const otherUserToken = mint("cc-u2", "cc2", "user", ORG);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const jsonHdr = { "Content-Type": "application/json" };

  // C2. GET compact-policy matrix.
  const gOwn = await fetch(`${BASE}/api/admin/orgs/${ORG}/compact-policy`, { headers: auth(oaToken) });
  const gOwnB = (await gOwn.json()) as any;
  ok("C2a org_admin own-org GET → 200 with caps",
    gOwn.status === 200 && gOwnB.source === "org" && gOwnB.caps?.maxThresholdTokens === 100_000 && gOwnB.platform?.thresholdTokens === 100_000,
    JSON.stringify(gOwnB).slice(0, 160));
  const gForeign = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/compact-policy`, { headers: auth(oaToken) });
  ok("C2b org_admin foreign org → 404 (no existence leak)", gForeign.status === 404, String(gForeign.status));
  const gUser = await fetch(`${BASE}/api/admin/orgs/${ORG}/compact-policy`, { headers: auth(userToken) });
  ok("C2c plain user → 403", gUser.status === 403, String(gUser.status));
  const gAdmin = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/compact-policy`, { headers: auth(adminToken) });
  ok("C2d admin cross-org GET → 200", gAdmin.status === 200);

  // C3. PUT: clamp + persist + response shape.
  const put = await fetch(`${BASE}/api/admin/orgs/${ORG}/compact-policy`, {
    method: "PUT", headers: { ...auth(oaToken), ...jsonHdr },
    body: JSON.stringify({ enabled: true, thresholdTokens: 300_000, keepRecentTurns: 50 }),
  });
  const putB = (await put.json()) as any;
  ok("C3a over-cap PUT clamped server-side",
    put.status === 200 && putB.stored.thresholdTokens === 100_000 && putB.stored.keepRecentTurns === 10 && putB.clamped.length === 2,
    JSON.stringify(putB).slice(0, 200));
  const gAfter = await fetch(`${BASE}/api/admin/orgs/${ORG}/compact-policy`, { headers: auth(oaToken) });
  ok("C3b clamped values persisted + read back", ((await gAfter.json()) as any).policy.thresholdTokens === 100_000);
  cp.setOrgCompactPolicy(ORG, { enabled: true, thresholdTokens: 50_000, keepRecentTurns: 5 });

  // C4. PUT validation + permissions.
  const putBad = await fetch(`${BASE}/api/admin/orgs/${ORG}/compact-policy`, {
    method: "PUT", headers: { ...auth(oaToken), ...jsonHdr }, body: JSON.stringify({ thresholdTokens: "soon" }),
  });
  ok("C4a non-numeric PUT → 400", putBad.status === 400, String(putBad.status));
  const putForeign = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/compact-policy`, {
    method: "PUT", headers: { ...auth(oaToken), ...jsonHdr }, body: JSON.stringify({ thresholdTokens: 50_000 }),
  });
  ok("C4b org_admin foreign PUT → 404", putForeign.status === 404, String(putForeign.status));
  const putUser = await fetch(`${BASE}/api/admin/orgs/${ORG}/compact-policy`, {
    method: "PUT", headers: { ...auth(userToken), ...jsonHdr }, body: JSON.stringify({ thresholdTokens: 50_000 }),
  });
  ok("C4c plain user PUT → 403", putUser.status === 403, String(putUser.status));
  const putGhost = await fetch(`${BASE}/api/admin/orgs/ghost-org/compact-policy`, {
    method: "PUT", headers: { ...auth(adminToken), ...jsonHdr }, body: JSON.stringify({ thresholdTokens: 50_000 }),
  });
  ok("C4d unknown org PUT → 404", putGhost.status === 404, String(putGhost.status));

  // C5. GET /api/chats/:id/context — owner view (fed by the B-section events).
  const ctxOwn = await fetch(`${BASE}/api/chats/${chatA.id}/context`, { headers: auth(userToken) });
  const ctx = (await ctxOwn.json()) as any;
  ok("C5a owner GET → 200 full shape",
    ctxOwn.status === 200 && ctx.context?.estimateTokens === 10_000 && ctx.context?.autoCompact?.thresholdTokens === 50_000 &&
    ctx.usage?.turns === 5 && ctx.lastCompact?.trigger === "auto" && ctx.model != null,
    JSON.stringify(ctx).slice(0, 220));
  const ctxOther = await fetch(`${BASE}/api/chats/${chatA.id}/context`, { headers: auth(otherUserToken) });
  ok("C5b non-owner user → 404 (no existence leak)", ctxOther.status === 404, String(ctxOther.status));
  const ctxOa = await fetch(`${BASE}/api/chats/${chatA.id}/context`, { headers: auth(oaToken) });
  ok("C5c own-org org_admin → 200", ctxOa.status === 200);
  const ctxOb = await fetch(`${BASE}/api/chats/${chatA.id}/context`, { headers: auth(obToken) });
  ok("C5d foreign-org org_admin → 404", ctxOb.status === 404, String(ctxOb.status));
}

console.log(`\ncontext-compaction: ${pass} assertions passed`);
process.exit(0);
