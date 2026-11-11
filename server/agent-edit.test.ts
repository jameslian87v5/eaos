// Octop absorption M7a — user-side Agent edit-field extension tests.
//
// Coverage (plan Task 1):
//   - owner PATCHes name / welcomeMessage / quickPrompts successfully; GET
//     round-trips the stored values (server persistence, not client state);
//   - quickPrompts uses the M6a stored shape {title, prompt}[] (the client
//     read path — App.tsx starter / ChatWindow — renders that shape; the plan
//     prose said "string[]" but a second column format would break the starter
//     contract, so the M6a shape + M6a bounds are authoritative here);
//   - invalid inputs (over count, over length, non-object entries, blank or
//     over-length name, over-length welcomeMessage) → 400 with ZERO partial
//     write — agents + chats rows byte-identical to the pre-request state;
//   - quickPrompts null / [] clears the starter;
//   - cross-user PATCH → 404 (no existence leak); org_admin same-org may edit;
//   - forged body keys (ownerUserId/orgId/status/templateId/appId) are ignored
//     — never land in the DB;
//   - audit lands on the OWNER's timeline, records field names + length/count,
//     never the plaintext (name/welcome/prompt text must not appear in the
//     payload JSON);
//   - existing fields (description) still work after the extraction into
//     createAgentEditRoutes() (regression).
//
// Run: DB_PATH=/tmp/m7a-edit.db ENTITLEMENTS_FILE=/tmp/m7a-ent.json AGENT_CAPABILITIES_FILE=/tmp/m7a-act.json npx tsx server/agent-edit.test.ts
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import express from "express";

const DB_PATH = process.env.DB_PATH ?? "/tmp/m7a-edit.db";
const ENT_FILE = process.env.ENTITLEMENTS_FILE ?? "/tmp/m7a-ent.json";
const ACT_FILE = process.env.AGENT_CAPABILITIES_FILE ?? "/tmp/m7a-act.json";
for (const f of [DB_PATH, ENT_FILE, ACT_FILE]) {
  try { rmSync(f, { recursive: true, force: true }); } catch {}
}
mkdirSync("/tmp", { recursive: true });
writeFileSync(ENT_FILE, JSON.stringify({ version: 1, entries: [] }, null, 2));

const db = (await import("./database.js")).default;
const { agentService } = await import("./agent-service.js");
const { createExpertAgent } = await import("./agent-builder.js");
const { createAgentEditRoutes } = await import("./agent-edit-routes.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
import type { RequestContext } from "./request-context.js";

const ORG = DEFAULT_ORG_ID;
const USER = "m7a-user";
const OTHER = "m7a-other";
const ORG_ADMIN = "m7a-orgadmin";

for (const [id, role] of [
  [USER, "user"],
  [OTHER, "user"],
  [ORG_ADMIN, "org_admin"],
] as const) {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', ?, ?, 'active')`
  ).run(id, id, role, ORG);
}

const userCtx: RequestContext = { userId: USER, role: "user", orgId: ORG };

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// Route harness (m6a pattern): actor override via x-test-actor header, no auth.
const app = express();
app.use((req, _res, next) => {
  const who = String(req.headers["x-test-actor"] ?? "");
  if (who === USER) Object.assign(req, { userId: USER, userRole: "user", orgId: ORG });
  else if (who === OTHER) Object.assign(req, { userId: OTHER, userRole: "user", orgId: ORG });
  else if (who === ORG_ADMIN) Object.assign(req, { userId: ORG_ADMIN, userRole: "org_admin", orgId: ORG });
  next();
});
app.use("/api/agents", createAgentEditRoutes());
const server = app.listen(0);
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function patch(agentId: string, actor: string, body: unknown) {
  return fetch(`${BASE}/api/agents/${agentId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": actor },
    body: JSON.stringify(body),
  });
}

/** Snapshot the full agents + chats row for zero-partial-write assertions. */
function snapshot(agentId: string): string {
  const a = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId);
  const c = db.prepare(`SELECT * FROM chats WHERE id = ?`).get(agentId);
  return JSON.stringify({ a, c });
}

function auditPayloads(agentId: string, owner: string): unknown[] {
  return db
    .prepare(
      `SELECT payload_json FROM agent_events WHERE user_id = ? AND chat_id = ? AND event_type = 'agent_profile_updated' ORDER BY sequence`
    )
    .all(owner, agentId)
    .map((r) => JSON.parse((r as { payload_json: string }).payload_json));
}

// Create one expert for USER via the M6a chain (blank template, no caps).
const agent = createExpertAgent(userCtx, {
  templateId: "blank",
  name: "翻译助手",
  description: "中英互译",
  welcomeMessage: "原始欢迎语",
  quickPrompts: [{ title: "翻译这句话", prompt: "请翻译：" }],
});
const agentId = agent.id;

// ─── Section 1: owner edits the three new fields ───────────────

{
  const before = snapshot(agentId);
  const res = await patch(agentId, USER, {
    name: "会议纪要专家",
    welcomeMessage: "新的欢迎语",
    quickPrompts: [
      { title: "总结会议", prompt: "请总结本次会议要点" },
      { title: "提取行动项", prompt: "请提取行动项并标注负责人" },
    ],
  });
  ok("owner PATCH new fields → 200", res.status === 200, `status=${res.status} body=${await res.text()}`);
  const after = agentService.getChat(agentId)!;
  ok("name edit lands on the live title", after.title === "会议纪要专家", `title=${after.title}`);
  ok("welcomeMessage persisted", after.welcomeMessage === "新的欢迎语", `welcome=${after.welcomeMessage}`);
  ok(
    "quickPrompts persisted in M6a shape",
    Array.isArray(after.quickPrompts) &&
      after.quickPrompts.length === 2 &&
      after.quickPrompts[0].title === "总结会议",
    `quickPrompts=${JSON.stringify(after.quickPrompts)}`
  );
  ok("chats row changed (title is the live display name)", snapshot(agentId) !== before);

  // Audit: field names + length/count, never plaintext.
  const events = auditPayloads(agentId, USER);
  const last = events[events.length - 1] as {
    changedFields: string[];
    changes: Record<string, { action: string; length?: number; count?: number }>;
  };
  ok(
    "audit lists the edited fields",
    ["name", "welcomeMessage", "quickPrompts"].every((f) => last.changedFields.includes(f)),
    `changedFields=${last.changedFields.join(",")}`
  );
  const payloadJson = JSON.stringify(last);
  ok(
    "audit has no plaintext (name/welcome/prompt text absent)",
    !payloadJson.includes("会议纪要专家") &&
      !payloadJson.includes("新的欢迎语") &&
      !payloadJson.includes("总结会议") &&
      !payloadJson.includes("请翻译"),
    `payload=${payloadJson}`
  );
  ok(
    "audit records counts/lengths, not values",
    typeof last.changes.quickPrompts?.count === "number" &&
      typeof last.changes.welcomeMessage?.length === "number"
  );
  ok("audit actor is the owner", (last as { actor?: { userId?: string } }).actor?.userId === USER);
}

// ─── Section 2: invalid inputs → 400, zero partial write ───────

const goodSnapshot = () => snapshot(agentId);

const invalidCases: Array<[string, Record<string, unknown>]> = [
  ["quickPrompts > 6 items", { quickPrompts: Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` })) }],
  ["quickPrompts non-array", { quickPrompts: "not-an-array" }],
  ["quickPrompts non-object entry", { quickPrompts: ["plain string"] }],
  ["quickPrompts entry missing prompt", { quickPrompts: [{ title: "只有标题" }] }],
  ["quickPrompts title too long (>50)", { quickPrompts: [{ title: "x".repeat(51), prompt: "p" }] }],
  ["quickPrompts prompt too long (>500)", { quickPrompts: [{ title: "t", prompt: "x".repeat(501) }] }],
  ["name blank", { name: "   " }],
  ["name over 64 chars", { name: "x".repeat(65) }],
  ["name non-string", { name: 42 }],
  ["welcomeMessage over 1000 chars", { welcomeMessage: "x".repeat(1001) }],
];

for (const [label, body] of invalidCases) {
  const snap = goodSnapshot();
  // Combined payload: a VALID field rides along so we prove the 400 blocks the
  // whole write, not just the offending field.
  const res = await patch(agentId, USER, { ...body, description: "should-not-land" });
  ok(`${label} → 400`, res.status === 400, `status=${res.status}`);
  ok(`${label} → zero partial write`, snapshot(agentId) === snap);
}

// ─── Section 3: null / [] clears the starter ───────────────────

{
  const res = await patch(agentId, USER, { quickPrompts: null, welcomeMessage: null });
  ok("null clears starter → 200", res.status === 200, `status=${res.status}`);
  const after = agentService.getChat(agentId)!;
  ok("quickPrompts cleared to null", after.quickPrompts === null, `got=${JSON.stringify(after.quickPrompts)}`);
  ok("welcomeMessage cleared to null", after.welcomeMessage === null);

  await patch(agentId, USER, {
    quickPrompts: [{ title: "重新加一条", prompt: "内容" }],
    welcomeMessage: "再来一次欢迎语",
  });
  const res2 = await patch(agentId, USER, { quickPrompts: [] });
  ok("empty array also clears → 200", res2.status === 200);
  ok("[] clears quickPrompts", agentService.getChat(agentId)!.quickPrompts === null);
}

// ─── Section 4: ownership ──────────────────────────────────────

{
  const snap = goodSnapshot();
  const res = await patch(agentId, OTHER, { name: "黑客改名" });
  ok("cross-user PATCH → 404 (no existence leak)", res.status === 404, `status=${res.status}`);
  ok("cross-user PATCH → zero write", snapshot(agentId) === snap);

  const res2 = await patch(agentId, OTHER, { welcomeMessage: "x" });
  ok("cross-user PATCH (other field) → 404", res2.status === 404);

  // org_admin same org keeps its existing edit rights (not expanded).
  const res3 = await patch(agentId, ORG_ADMIN, { description: "org_admin 修改的描述" });
  ok("org_admin same-org PATCH → 200 (existing semantics kept)", res3.status === 200, `status=${res3.status}`);
  ok("org_admin edit landed", agentService.getChat(agentId)!.description === "org_admin 修改的描述");
}

// ─── Section 5: forged control-plane keys are ignored ──────────

{
  const snap = goodSnapshot();
  const rowBefore = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId) as Record<string, unknown>;
  const res = await patch(agentId, USER, {
    name: "合法改名",
    ownerUserId: "attacker",
    orgId: "evil-org",
    status: "archived",
    templateId: "doc-analysis",
    appId: "copilot",
  });
  ok("forged keys PATCH → 200 (ignored)", res.status === 200, `status=${res.status}`);
  const rowAfter = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId) as Record<string, unknown>;
  ok(
    "forged ownerUserId/orgId/status/templateId/appId never land",
    rowAfter.owner_user_id === rowBefore.owner_user_id &&
      rowAfter.org_id === rowBefore.org_id &&
      rowAfter.status === rowBefore.status &&
      rowAfter.template_id === rowBefore.template_id &&
      rowAfter.app_id === rowBefore.app_id,
    JSON.stringify({ owner: rowAfter.owner_user_id, org: rowAfter.org_id, status: rowAfter.status, template: rowAfter.template_id, app: rowAfter.app_id })
  );
  ok("the legit field in the same request still applies", agentService.getChat(agentId)!.title === "合法改名");
}

// ─── Section 6: persistence after re-read + legacy fields ──────

{
  const res = await patch(agentId, USER, { description: "回归描述" });
  ok("legacy description field still works (extraction regression)", res.status === 200, `status=${res.status}`);
  ok("description persisted", agentService.getChat(agentId)!.description === "回归描述");
}

// ─── Section 7: empty whitelist ────────────────────────────────

{
  const res = await patch(agentId, USER, { templateId: "doc-analysis" });
  ok("templateId-only PATCH → 400 (read-only, not an updatable field)", res.status === 400, `status=${res.status}`);
}

server.close();
console.log(`\nAll ${pass} assertions passed.`);
