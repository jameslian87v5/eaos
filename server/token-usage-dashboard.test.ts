// M3 (evt_20260818053834) — org token usage dashboard. Focused proof for the
// M3 boundary (docs/开发计划/model-and-token-management-plan.md §7, §8.2, §9-M3):
//   - aggregation by day/user/agent/chat over the EXISTING result-event stream
//     (4 token dims, no price fields anywhere);
//   - date-range filter + pagination (groups total, limit/offset);
//   - org isolation server-side from JWT orgId: admin cross-org, org_admin
//     own-org only (foreign :id → 404), plain user → 403;
//   - budget card: monthly limit/used/remaining/near/over (quota-service reuse).
//
// NOT tested here (out of M3): Auto Compact (M4), provider import (M5),
// billing (M6), CSV export (deferred — not in the event scope).
//
// Run: npx tsx server/token-usage-dashboard.test.ts  (chdir's to a scratch dir)
import assert from "node:assert/strict";
import path from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import os from "node:os";

const PORT = "3995";
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "token-usage-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.PORT = PORT;
process.env.JWT_SECRET = "token-usage-test-secret-strong-9b2c";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

const db = (await import("./database.js")).default;
const { chatStore } = await import("./chat-store.js");
const svc = await import("./token-usage-service.js");
const { setQuota } = await import("./quota-service.js");

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

// NOTE: user rows go in AFTER server boot (ensureAdminExists seeds only into
// an empty users table) — chats/agents rows carry no user FK and can go first.
const u1 = "tu-u1", u2 = "tu-u2";
const chatA = chatStore.createChat(u1, "chatA", ORG);   // same-id agents row created by the store
const chatB = chatStore.createChat(u2, "chatB", ORG);
const chatC = chatStore.createChat(u1, "chatC", ORG_B);

// Seed result events. created_at is settable via raw INSERT (bypasses the
// store's datetime('now') default) so date filtering is deterministic.
// usage shape mirrors session.ts: payload_json.$.usage.{...}Tokens.
let seq = 0;
function seedResult(chatId: string, userId: string, when: string, usage: Record<string, number>) {
  const sid = `sess-${chatId}`;
  db.prepare(
    `INSERT OR IGNORE INTO agent_sessions (id, user_id, chat_id, runtime_type, status) VALUES (?, ?, ?, 'local', 'stopped')`
  ).run(sid, userId, chatId);
  db.prepare(
    `INSERT INTO agent_events (id, user_id, chat_id, agent_session_id, sequence, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'result', ?, ?)`
  ).run(`ev-${++seq}`, userId, chatId, sid, seq, JSON.stringify({ usage }), when);
}

// Time-safe seed dates: fixed days of the CURRENT UTC month. The budget
// window is [monthStart, nextMonthStart) with no now-cap (quota-service
// stmts.getTokenUsageMonthly), so days 10–12 land inside it on ANY run date —
// absolute literals (e.g. 2026-08-xx) age out of the window and zero the
// budget card (A6b). Days 10–12 exist in every month; A3b's empty-range probe
// uses 13–20, which never overlaps the seeds.
const SEED_MONTH = new Date().toISOString().slice(0, 7); // "YYYY-MM" (UTC)
const DAY1 = `${SEED_MONTH}-10`;
const DAY2 = `${SEED_MONTH}-12`;
const DAY_B = `${SEED_MONTH}-11`;

// Day DAY1: chatA(u1) 100/10/1/2; chatB(u2) 200/20/2/4  → org totals 300/30/3/6
seedResult(chatA.id, u1, `${DAY1} 05:00:00`, { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 1, cacheReadTokens: 2 });
seedResult(chatB.id, u2, `${DAY1} 09:30:00`, { inputTokens: 200, outputTokens: 20, cacheCreationTokens: 2, cacheReadTokens: 4 });
// Day DAY2: chatA(u1) 1000/100/10/20
seedResult(chatA.id, u1, `${DAY2} 23:59:59`, { inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 10, cacheReadTokens: 20 });
// ORG_B (must NEVER appear in ORG queries): 999999/…
seedResult(chatC.id, u1, `${DAY_B} 00:00:00`, { inputTokens: 999999, outputTokens: 999999, cacheCreationTokens: 999999, cacheReadTokens: 999999 });
// A pre-Stage-1 result row with NO usage → 0 tokens, still counts a turn.
seedResult(chatA.id, u1, `${DAY1} 12:00:00`, {});

// ─── A: service aggregation ───────────────────────────────────

// A1. By day (org-scoped; ORG_B row excluded; legacy no-usage row counts a turn).
{
  const r = svc.queryTokenUsage({ orgId: ORG, groupBy: "day", limit: 50, offset: 0 });
  ok("A1a two day groups", r.groups === 2 && r.items.length === 2, JSON.stringify(r.items.map((i) => i.key)));
  const d10 = r.items.find((i) => i.key === DAY1)!;
  ok("A1b day sums 4 dims + turns (incl. legacy 0-token row)",
    d10.inputTokens === 300 && d10.outputTokens === 30 && d10.cacheCreationTokens === 3 && d10.cacheReadTokens === 6 && d10.turns === 3,
    JSON.stringify(d10));
  ok("A1c totals match grand total", r.totals.inputTokens === 1300 && r.totals.turns === 4, JSON.stringify(r.totals));
  ok("A1d org-B usage never leaks", r.totals.inputTokens < 999999);
}

// A2. By user / by agent / by chat labels.
{
  const byUser = svc.queryTokenUsage({ orgId: ORG, groupBy: "user", limit: 50, offset: 0 });
  const u1Row = byUser.items.find((i) => i.key === u1)!;
  ok("A2a user grouping sums per user", u1Row.inputTokens === 1100 && u1Row.turns === 3, JSON.stringify(u1Row));
  ok("A2b user label falls back to id when the users row does not exist yet (inserted post-boot below)",
    u1Row.label === u1, JSON.stringify(u1Row));
  const byAgent = svc.queryTokenUsage({ orgId: ORG, groupBy: "agent", limit: 50, offset: 0 });
  const aA = byAgent.items.find((i) => i.key === chatA.id)!;
  ok("A2c agent grouping by same-id agent", aA.inputTokens === 1100 && aA.label === "chatA", JSON.stringify(aA));
  const byChat = svc.queryTokenUsage({ orgId: ORG, groupBy: "chat", limit: 50, offset: 0 });
  ok("A2d chat grouping by chat title", byChat.items.some((i) => i.key === chatB.id && i.label === "chatB" && i.inputTokens === 200));
}

// A3. Date range: inclusive both ends; UTC string compare.
{
  const only10 = svc.queryTokenUsage({ orgId: ORG, groupBy: "day", from: DAY1, to: DAY1, limit: 50, offset: 0 });
  ok("A3a from/to same day → one group", only10.groups === 1 && only10.totals.inputTokens === 300, JSON.stringify(only10.totals));
  const none = svc.queryTokenUsage({ orgId: ORG, groupBy: "day", from: `${SEED_MONTH}-13`, to: `${SEED_MONTH}-20`, limit: 50, offset: 0 });
  ok("A3b empty range → zero groups, zero totals", none.groups === 0 && none.totals.total === 0 && none.totals.turns === 0);
  assert.throws(() => svc.queryTokenUsage({ orgId: ORG, groupBy: "day", from: "2026/08/10", limit: 5, offset: 0 }), /Invalid from/);
  ok("A3c malformed date rejected", true);
}

// A4. Drill-down filters.
{
  const byUserChatA = svc.queryTokenUsage({ orgId: ORG, groupBy: "day", userId: u1, chatId: chatA.id, limit: 50, offset: 0 });
  ok("A4a user+chat filter", byUserChatA.totals.inputTokens === 1100 && byUserChatA.totals.turns === 3, JSON.stringify(byUserChatA.totals));
  // A foreign-org chat id simply yields nothing (org filter is ANDed first).
  const crossOrg = svc.queryTokenUsage({ orgId: ORG, groupBy: "day", chatId: chatC.id, limit: 50, offset: 0 });
  ok("A4b foreign-org chatId yields empty (no leak)", crossOrg.groups === 0 && crossOrg.totals.total === 0);
}

// A5. Pagination.
{
  const page1 = svc.queryTokenUsage({ orgId: ORG, groupBy: "user", limit: 1, offset: 0 });
  ok("A5a limit=1 → 1 item of 2 groups", page1.items.length === 1 && page1.groups === 2);
  const page2 = svc.queryTokenUsage({ orgId: ORG, groupBy: "user", limit: 1, offset: 1 });
  ok("A5b offset page 2 → the other user", page2.items.length === 1 && page2.items[0].key !== page1.items[0].key);
  const huge = svc.queryTokenUsage({ orgId: ORG, groupBy: "day", limit: 99999, offset: 0 });
  ok("A5c limit clamped to 200", huge.limit === 200);
}

// A6. Budget card (monthly window — seeds above always land in the current
//     UTC month by construction, so absolute usage dims are assertable).
{
  setQuota(ORG, { maxTokensMonthly: 10_000_000, tokenAlertThresholdPct: 80 });
  const b = svc.getOrgTokenBudget(ORG);
  ok("A6a budget carries limit/used/remaining/status",
    b.limit === 10_000_000 && typeof b.used === "number" && b.remaining === Math.max(0, b.limit - b.used) && ["normal", "near", "over"].includes(b.status),
    JSON.stringify({ limit: b.limit, used: b.used, status: b.status }));
  // near threshold math via the same quota-service derivation
  ok("A6b usage dims carried", b.usage.turns === 4 && b.usage.inputTokens === 1300, JSON.stringify(b.usage));
  setQuota(ORG, { maxTokensMonthly: 1300 }); // used(1300) >= limit → over
  ok("A6c over status derived", svc.getOrgTokenBudget(ORG).status === "over");
  setQuota(ORG, { maxTokensMonthly: 10_000_000, tokenAlertThresholdPct: 80 });
}

// A7. No price/billing fields in the payload surface.
{
  const r = svc.queryTokenUsage({ orgId: ORG, groupBy: "day", limit: 5, offset: 0 });
  const flat = JSON.stringify({ ...r, budget: svc.getOrgTokenBudget(ORG) }).toLowerCase();
  ok("A7 no price/cost/billing fields", !/price|cost|billing|currency/.test(flat), flat.slice(0, 120));
}

// ─── D: HTTP + permissions ────────────────────────────────────

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
  ok("D1 admin login", login.ok);
  const adminToken = ((await login.json()) as { token: string }).token;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, org_id, status, must_change_password)
     VALUES ('${u1}', 'tu1', 'x', '用户一', 'user', '${ORG}', 'active', 0),
            ('${u2}', 'tu2', 'x', '用户二', 'user', '${ORG}', 'active', 0),
            ('tu-oa', 'tuoa', 'x', NULL, 'org_admin', '${ORG}', 'active', 0),
            ('tu-ob', 'tuob', 'x', NULL, 'org_admin', '${ORG_B}', 'active', 0)`
  ).run();
  const oaToken = mint("tu-oa", "tuoa", "org_admin", ORG);
  const obToken = mint("tu-ob", "tuob", "org_admin", ORG_B);
  const userToken = mint(u1, "tu1", "user", ORG);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // D2. org_admin own org — full payload.
  const g = await fetch(`${BASE}/api/admin/orgs/${ORG}/token-usage?groupBy=user`, { headers: auth(oaToken) });
  const gb = (await g.json()) as any;
  ok("D2a org_admin own-org GET → 200", g.status === 200, String(g.status));
  ok("D2b payload = usage + budget, user label resolved",
    gb.usage?.groupBy === "user" && gb.usage.totals.inputTokens === 1300 && gb.budget?.limit === 10_000_000 &&
    gb.usage.items.some((i: any) => i.label === "用户一"),
    JSON.stringify(gb.usage?.items));
  ok("D2c no price fields in HTTP payload", !/price|cost|billing/i.test(JSON.stringify(gb)));

  // D3. Permission matrix.
  const foreign = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/token-usage`, { headers: auth(oaToken) });
  ok("D3a org_admin foreign org → 404 (no existence leak)", foreign.status === 404, String(foreign.status));
  const obOwn = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/token-usage`, { headers: auth(obToken) });
  const obBody = (await obOwn.json()) as any;
  ok("D3b ORG_B org_admin sees ONLY org-B usage (999999 input, 1 turn)",
    obOwn.status === 200 && obBody.usage.totals.inputTokens === 999999 && obBody.usage.totals.turns === 1,
    JSON.stringify(obBody.usage?.totals));
  const asAdmin = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/token-usage`, { headers: auth(adminToken) });
  ok("D3c admin cross-org → 200", asAdmin.status === 200, String(asAdmin.status));
  const asUser = await fetch(`${BASE}/api/admin/orgs/${ORG}/token-usage`, { headers: auth(userToken) });
  ok("D3d plain user → 403 (no org-level visibility)", asUser.status === 403, String(asUser.status));

  // D4. Query params.
  const badGroup = await fetch(`${BASE}/api/admin/orgs/${ORG}/token-usage?groupBy=evil`, { headers: auth(oaToken) });
  ok("D4a invalid groupBy → 400", badGroup.status === 400, String(badGroup.status));
  const badDate = await fetch(`${BASE}/api/admin/orgs/${ORG}/token-usage?from=2026-8-1`, { headers: auth(oaToken) });
  ok("D4b malformed date → 400", badDate.status === 400, String(badDate.status));
  const ranged = await fetch(`${BASE}/api/admin/orgs/${ORG}/token-usage?from=${DAY1}&to=${DAY1}&groupBy=day`, { headers: auth(oaToken) });
  ok("D4c from/to respected over HTTP", ((await ranged.json()) as any).usage.totals.inputTokens === 300);
  const paged = await fetch(`${BASE}/api/admin/orgs/${ORG}/token-usage?groupBy=user&limit=1&offset=1`, { headers: auth(oaToken) });
  const pagedBody = (await paged.json()) as any;
  ok("D4d pagination over HTTP (page 2 of 2 groups)",
    pagedBody.usage.items.length === 1 && pagedBody.usage.groups === 2 && pagedBody.usage.offset === 1,
    JSON.stringify(pagedBody.usage?.items?.map((i: any) => i.key)));
  const drill = await fetch(`${BASE}/api/admin/orgs/${ORG}/token-usage?groupBy=day&chatId=${chatA.id}`, { headers: auth(oaToken) });
  ok("D4e chatId drill-down over HTTP", ((await drill.json()) as any).usage.totals.inputTokens === 1100);
}

console.log(`\n${pass} passed, 0 failed`);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(0);
