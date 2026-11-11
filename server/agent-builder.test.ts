// Octop absorption M6a — governed expert creation contract tests.
//
// Coverage (plan Task 1):
//   - GET options returns only user-entitled ∩ default-app allowlist ∩
//     active/valid resources; templates are static presets;
//   - successful create persists agent + per-Agent prompt + starter metadata
//     (templateId/welcomeMessage/quickPrompts) + activation, in one flow;
//   - unknown template / over-length fields / empty-name rejected;
//   - tampered capabilityIds (not entitled, or outside app allowlist) reject
//     the WHOLE creation — no agent row, no activation, no starter;
//   - mid-flow write failure compensates (agent deleted, no half-built state);
//   - activation keys are cleaned when an agent is deleted (no orphan keys);
//   - another user cannot read/edit this agent's starter (ownership scoping);
//   - duplicate create with same payload creates distinct agents only via
//     separate calls (client busy-guard is the single-submit mechanism —
//     server still never leaves half state).
//
// Run: DB_PATH=/tmp/m6a-agent-builder.db ENTITLEMENTS_FILE=/tmp/m6a-entitlements.json AGENT_CAPABILITIES_FILE=/tmp/m6a-agent-capabilities.json npx tsx server/agent-builder.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import express from "express";

const DB_PATH = process.env.DB_PATH ?? "/tmp/m6a-agent-builder.db";
const ENT_FILE = process.env.ENTITLEMENTS_FILE ?? "/tmp/m6a-entitlements.json";
const ACT_FILE = process.env.AGENT_CAPABILITIES_FILE ?? "/tmp/m6a-agent-capabilities.json";
for (const f of [DB_PATH, ENT_FILE, ACT_FILE]) {
  try { rmSync(f, { recursive: true, force: true }); } catch {}
}
mkdirSync("/tmp", { recursive: true });
writeFileSync(ENT_FILE, JSON.stringify({ version: 1, entries: [] }, null, 2));

const db = (await import("./database.js")).default;
const { agentService } = await import("./agent-service.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { getBuilderOptions, createExpertAgent, AgentBuilderError, EXPERT_TEMPLATES } = await import("./agent-builder.js");
const { createAgentBuilderRoutes } = await import("./agent-builder-routes.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
import type { RequestContext } from "./request-context.js";
const { getPromptSettings } = await import("./prompt-settings.js");

const ORG = DEFAULT_ORG_ID;
const USER = "m6a-user";
const OTHER = "m6a-other";
const userCtx: RequestContext = { userId: USER, role: "user", orgId: ORG };
const otherCtx: RequestContext = { userId: OTHER, role: "user", orgId: ORG };

for (const [id, role] of [[USER, "user"], [OTHER, "user"]] as const) {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', ?, ?, 'active')`
  ).run(id, id, role, ORG);
}

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

async function expectCode(name: string, fn: () => unknown, code: string): Promise<void> {
  let threw = false;
  let got = "";
  try {
    fn();
  } catch (err) {
    threw = true;
    got = err instanceof AgentBuilderError ? err.code : "(not AgentBuilderError)";
  }
  ok(name, threw && got === code, `threw=${threw} code=${got} (want ${code})`);
}

function activationKeys(): Record<string, string[]> {
  if (!fs.existsSync(ACT_FILE)) return {};
  return JSON.parse(fs.readFileSync(ACT_FILE, "utf8"));
}

// Seed entitlements: USER gets hello-skill (user-scope allow); OTHER gets
// minimal-plugin. hello-skill is also placed in the default-app allowlist
// (see below) while minimal-plugin is NOT — that exercises the app-allowlist
// leg of the intersection on top of entitlement.
entitlementService.setEntitlements(
  { userId: "m6a-admin", role: "admin", orgId: ORG },
  "hello-skill",
  [{ scopeType: "user", scopeId: USER, effect: "allow" }]
);
entitlementService.setEntitlements(
  { userId: "m6a-admin", role: "admin", orgId: ORG },
  "minimal-plugin",
  [{ scopeType: "user", scopeId: OTHER, effect: "allow" }]
);
// default-app allowlist: ONLY hello-skill (denies minimal-plugin cross-app).
db.prepare(
  `INSERT INTO application_capabilities (id, app_id, resource_id, enabled) VALUES ('m6a-cap-1', 'default-app', 'hello-skill', 1)`
).run();

// ─── Section 1: options ───────────────────────────────────────

{
  const opts = getBuilderOptions(userCtx);
  ok("options: ≥4 templates incl. blank", opts.templates.length >= 4 && opts.templates.some((t) => t.id === "blank"));
  ok("options: template fields are the preset shape", opts.templates.every((t) =>
    typeof t.id === "string" && typeof t.name === "string" && typeof t.systemPrompt === "string" &&
    Array.isArray(t.quickPrompts) && t.quickPrompts.length <= 6));

  const ids = opts.capabilities.map((c) => c.resourceId);
  ok("options: only entitled ∩ app-allowlisted ∩ valid resources",
    ids.includes("hello-skill") && !ids.includes("minimal-plugin"),
    `ids=${ids.join(",")}`);
  ok("options: capability entries carry type/name", opts.capabilities.every((c) => c.type && c.name));

  const otherOpts = getBuilderOptions(otherCtx);
  ok("options: other user sees only their own entitlement (and none pass the app allowlist)",
    !otherOpts.capabilities.some((c) => c.resourceId === "hello-skill"));

  ok("options: templates are immutable presets (module state not mutated by caller)",
    (() => { (opts.templates[0] as { name: string }).name = "tampered"; return EXPERT_TEMPLATES[0].name !== "tampered"; })());
}

// ─── Section 2: successful create ─────────────────────────────

{
  const agent = createExpertAgent(userCtx, {
    templateId: "doc-analysis",
    name: "我的文档专家",
    description: "分析文档",
    systemPrompt: "你是文档分析专家",
    welcomeMessage: "你好，我来帮你分析文档",
    quickPrompts: [
      { title: "总结文档", prompt: "帮我总结这份文档的要点" },
      { title: "", prompt: "" },
      { title: " 提取数据 ", prompt: " 提取文档中的关键数据 " },
    ],
    capabilityIds: ["hello-skill"],
  });

  ok("create: returns agent with starter",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent.id) &&
    agent.title === "我的文档专家" && agent.userId === USER && agent.appId === "default-app" && agent.orgId === ORG);
  ok("create: starter persisted on read model",
    agent.templateId === "doc-analysis" && agent.welcomeMessage === "你好，我来帮你分析文档" &&
    agent.quickPrompts?.length === 2 && agent.quickPrompts[0].title === "总结文档" &&
    agent.quickPrompts[1].title === "提取数据" && agent.quickPrompts[1].prompt === "提取文档中的关键数据");

  const reloaded = agentService.getChat(agent.id);
  ok("create: starter survives re-read (server persistence, not client state)",
    reloaded?.templateId === "doc-analysis" && reloaded?.welcomeMessage === "你好，我来帮你分析文档" && reloaded?.quickPrompts?.length === 2);

  const prompt = agentService.getAgentPromptOverrides(agent.id);
  ok("create: per-Agent prompt override persisted", prompt.systemPrompt === "你是文档分析专家");

  const act = activationKeys()[agent.id];
  ok("create: activation persisted for selected capability", JSON.stringify(act) === JSON.stringify(["hello-skill"]));

  const resolved = agentCapabilityService.resolveEnabledResourceIds(userCtx, agent.id);
  ok("create: created agent resolves the activated capability through the guard chain",
    resolved.includes("hello-skill"));

  // Owner visibility + cross-owner denial.
  ok("create: agent listed for owner", agentService.getAllChats(USER).some((a) => a.id === agent.id));
  ok("create: NOT listed for another user", !agentService.getAllChats(OTHER).some((a) => a.id === agent.id));
  ok("create: another user cannot resolve capabilities for this agent",
    !agentCapabilityService.resolveEnabledResourceIds(otherCtx, agent.id).includes("hello-skill"));
}

// ─── Section 3: validation rejections (no residue) ────────────

{
  const before = db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number };
  const keysBefore = Object.keys(activationKeys()).length;

  await expectCode("unknown template rejected", () =>
    createExpertAgent(userCtx, { templateId: "no-such-template", name: "x" }), "unknown_template");
  await expectCode("empty name rejected (blank template without a name)", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "   " }), "invalid_name");
  await expectCode("over-long name rejected", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "x".repeat(65) }), "invalid_name");
  await expectCode("over-long description rejected", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "x", description: "d".repeat(201) }), "invalid_description");
  await expectCode("over-long welcome rejected", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "x", welcomeMessage: "w".repeat(501) }), "invalid_welcome");
  await expectCode("over-long system prompt rejected", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "x", systemPrompt: "s".repeat(getPromptSettings().maxSystemPromptChars + 1) }), "invalid_system_prompt");
  await expectCode("too many quick prompts rejected", () =>
    createExpertAgent(userCtx, {
      templateId: "blank", name: "x",
      quickPrompts: Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` })),
    }), "invalid_quick_prompts");
  await expectCode("over-long quick prompt title rejected", () =>
    createExpertAgent(userCtx, {
      templateId: "blank", name: "x",
      quickPrompts: [{ title: "t".repeat(51), prompt: "p" }],
    }), "invalid_quick_prompts");
  await expectCode("tampered un-entitled capability rejects the whole create", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "x", capabilityIds: ["minimal-plugin"] }), "capability_not_allowed");
  await expectCode("cross-app (outside default-app allowlist) capability rejected", () =>
    createExpertAgent(otherCtx, { templateId: "blank", name: "x", capabilityIds: ["minimal-plugin"] }), "capability_not_allowed");
  await expectCode("unknown capability id rejected", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "x", capabilityIds: ["ghost-skill"] }), "capability_not_allowed");

  const after = db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number };
  ok("rejections leave no agent rows", after.c === before.c, `before=${before.c} after=${after.c}`);
  ok("rejections leave no activation keys", Object.keys(activationKeys()).length === keysBefore);
}

// ─── Section 4: mid-flow failure compensation ─────────────────

{
  const originalAct = fs.readFileSync(ACT_FILE, "utf8");
  const keysBefore = Object.keys(activationKeys());

  // Make the activation store unwritable (path occupied by a directory) so the
  // write fails AFTER the agent row exists — creation must roll everything back.
  rmSync(ACT_FILE, { force: true });
  mkdirSync(ACT_FILE); // directory at the file path → writeFileSync will throw

  await expectCode("mid-flow activation write failure compensated", () =>
    createExpertAgent(userCtx, {
      templateId: "project-assistant",
      name: "补偿测试",
      capabilityIds: ["hello-skill"],
      clientRequestId: "compensate-test-id-0001",
    }), "create_failed");

  rmSync(ACT_FILE, { recursive: true, force: true });
  writeFileSync(ACT_FILE, originalAct);

  const leftovers = db.prepare(`SELECT id FROM agents WHERE name = ?`).all("补偿测试");
  ok("compensation: no half-built agent row (starter+prompt live on that row)", leftovers.length === 0);
  ok("compensation: activation store unchanged (no new key, no lost key)",
    JSON.stringify(Object.keys(activationKeys())) === JSON.stringify(keysBefore));
  ok("compensation: idempotency ledger row removed (retry re-creates cleanly)",
    (db.prepare(`SELECT COUNT(*) c FROM agent_builder_requests WHERE request_id = ?`).get("compensate-test-id-0001") as { c: number }).c === 0);
}

// ─── Section 5: deletion cleans activation keys ───────────────

{
  const agent = createExpertAgent(userCtx, { templateId: "blank", name: "待删除", capabilityIds: ["hello-skill"] });
  ok("delete-prep: activation key exists", agent.id in activationKeys());
  const deleted = agentService.deleteChat(agent.id);
  ok("delete: agent deleted", deleted === true && agentService.getChat(agent.id) === undefined);
  ok("delete: activation key removed (no orphan)", !(agent.id in activationKeys()));
}

// ─── Section 6: route contract (admin-only? no — any authed user) ──

{
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const who = String(req.headers["x-test-actor"] ?? "");
    // x-test-org overrides the (normally server-trusted) orgId so the route
    // denial tests can point at a suspended / quota-capped test org.
    const orgId = String(req.headers["x-test-org"] ?? ORG);
    if (who === "user") Object.assign(req, { userId: USER, userRole: "user", orgId });
    else if (who === "other") Object.assign(req, { userId: OTHER, userRole: "user", orgId });
    else if (who === "admin") Object.assign(req, { userId: "m6a-admin", userRole: "admin", orgId });
    else if (who === "anon") { /* no identity */ }
    next();
  });
  app.use("/api/agent-builder", createAgentBuilderRoutes());
  const server = app.listen(0);
  const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const optsRes = await fetch(`${BASE}/api/agent-builder/options`, { headers: { "x-test-actor": "user" } });
  const opts = await optsRes.json();
  ok("route GET options: 200 with templates + capabilities",
    optsRes.status === 200 && opts.templates.length >= 4 && opts.capabilities.some((c: { resourceId: string }) => c.resourceId === "hello-skill"));

  const createRes = await fetch(`${BASE}/api/agent-builder`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-actor": "user" },
    body: JSON.stringify({
      templateId: "plan-writing",
      name: "方案撰写专家",
      capabilityIds: ["hello-skill"],
    }),
  });
  const created = await createRes.json();
  ok("route POST create: 201 with agent + starter defaults from template",
    createRes.status === 201 && created.agent.title === "方案撰写专家" &&
    created.agent.templateId === "plan-writing" && typeof created.agent.welcomeMessage === "string" &&
    Array.isArray(created.agent.quickPrompts) && created.agent.quickPrompts.length > 0);

  const tamperRes = await fetch(`${BASE}/api/agent-builder`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-actor": "user" },
    body: JSON.stringify({ templateId: "blank", name: "越权", capabilityIds: ["ghost"] }),
  });
  const tamper = await tamperRes.json();
  ok("route POST create: tampered capability → 403 denied + code", tamperRes.status === 403 && tamper.code === "capability_not_allowed");
  const tamperedAgent = db.prepare(`SELECT id FROM agents WHERE name = '越权'`).get();
  ok("route POST create: tampered request left no agent", tamperedAgent === undefined);

  const badBody = await fetch(`${BASE}/api/agent-builder`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-actor": "user" },
    body: JSON.stringify({ name: "no-template" }),
  });
  ok("route POST create: missing templateId → 400", badBody.status === 400);

  server.close();
}

// ─── Section 7: fix-round governance gates (denial + zero residue) ──

{
  const { provisionOrg, transitionOrgStatus } = await import("./org-governance.js");
  const { setQuota } = await import("./quota-service.js");

  const agentsBefore = (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c;
  const keysBefore = Object.keys(activationKeys()).length;
  const ledgerBefore = (db.prepare(`SELECT COUNT(*) c FROM agent_builder_requests`).get() as { c: number }).c;

  // A suspended org: provision, then suspend. (provisionOrg needs an actor.)
  await provisionOrg({
    id: "m6a-org-susp", name: "M6a Suspended Org",
    firstAdminUsername: "m6a-susp-admin", firstAdminPassword: "susp-pw-12345678",
    actorUserId: "m6a-admin", actorRole: "admin",
  });
  await transitionOrgStatus({ orgId: "m6a-org-susp", action: "suspend", actorUserId: "m6a-admin", actorRole: "admin" });
  const suspCtx: RequestContext = { userId: USER, role: "user", orgId: "m6a-org-susp" };
  await expectCode("suspended org → org_not_active (service)", () =>
    createExpertAgent(suspCtx, { templateId: "blank", name: "被拒绝" }), "org_not_active");

  // A quota-capped org: maxAgents = 0 denies every create.
  await provisionOrg({
    id: "m6a-org-q", name: "M6a Quota Org",
    firstAdminUsername: "m6a-q-admin", firstAdminPassword: "quota-pw-1234567",
    actorUserId: "m6a-admin", actorRole: "admin",
  });
  setQuota("m6a-org-q", { maxAgents: 0 });
  const quotaCtx: RequestContext = { userId: USER, role: "user", orgId: "m6a-org-q" };
  await expectCode("quota-exhausted org → quota_exceeded (service)", () =>
    createExpertAgent(quotaCtx, { templateId: "blank", name: "被拒绝" }), "quota_exceeded");

  // Route-level denial codes preserve the platform contract (403 / 429).
  const app7 = express();
  app7.use(express.json({ limit: "64kb" }));
  app7.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, {
      userId: USER, userRole: "user",
      orgId: String(req.headers["x-test-org"] ?? ORG),
    });
    next();
  });
  app7.use("/api/agent-builder", createAgentBuilderRoutes());
  const server7 = app7.listen(0);
  const BASE7 = `http://127.0.0.1:${(server7.address() as { port: number }).port}`;
  const body7 = { templateId: "blank", name: "路由拒绝" };

  const suspRes = await fetch(`${BASE7}/api/agent-builder`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-org": "m6a-org-susp" },
    body: JSON.stringify(body7),
  });
  const suspBody = await suspRes.json();
  ok("route: suspended org → 403 org_not_active", suspRes.status === 403 && suspBody.code === "org_not_active");

  const quotaRes = await fetch(`${BASE7}/api/agent-builder`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-org": "m6a-org-q" },
    body: JSON.stringify(body7),
  });
  const quotaBody = await quotaRes.json();
  ok("route: quota-exhausted org → 429 quota_exceeded (dimension=agents)",
    quotaRes.status === 429 && quotaBody.code === "quota_exceeded" && quotaBody.dimension === "agents");

  // Zero residue: no agent rows, no activation keys, no ledger rows.
  const agentsAfter = (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c;
  ok("denials leave zero residue (agents)", agentsAfter === agentsBefore, `before=${agentsBefore} after=${agentsAfter}`);
  ok("denials leave zero residue (activation keys)", Object.keys(activationKeys()).length === keysBefore);
  ok("denials leave zero residue (idempotency ledger)",
    (db.prepare(`SELECT COUNT(*) c FROM agent_builder_requests`).get() as { c: number }).c === ledgerBefore);

  // Admin is exempt from BOTH gates (parity with the legacy create routes):
  // an admin can create in a suspended org with zero quota.
  const adminSuspCtx: RequestContext = { userId: "m6a-admin", role: "admin", orgId: "m6a-org-susp" };
  const adminAgent = createExpertAgent(adminSuspCtx, { templateId: "blank", name: "管理员豁免" });
  ok("admin exempt from org-status + quota gates", adminAgent.userId === "m6a-admin" && adminAgent.orgId === "m6a-org-susp");
  server7.close();
}

// ─── Section 8: fix-round idempotency (retry + concurrent + owner scoping) ──

{
  const agentsBefore = (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c;
  const REQ_ID = "m6a-idem-req-00000001";

  const first = createExpertAgent(userCtx, { templateId: "blank", name: "幂等一次", clientRequestId: REQ_ID });
  // Same request id, called again (retry) → SAME agent, no duplicate.
  const second = createExpertAgent(userCtx, { templateId: "blank", name: "幂等一次", clientRequestId: REQ_ID });
  ok("retry with same clientRequestId returns the SAME agent", first.id === second.id);
  ok("retry created no duplicate agent row",
    (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c === agentsBefore + 1);
  ok("idempotency ledger has exactly one row for the request id",
    (db.prepare(`SELECT COUNT(*) c FROM agent_builder_requests WHERE request_id = ?`).get(REQ_ID) as { c: number }).c === 1);

  // Another user reusing the SAME request id → rejected, never a cross-owner replay.
  await expectCode("cross-owner reuse of a request id rejected", () =>
    createExpertAgent(otherCtx, { templateId: "blank", name: "越权重放", clientRequestId: REQ_ID }), "invalid_client_request_id");
  // Malformed request ids rejected.
  await expectCode("too-short clientRequestId rejected", () =>
    createExpertAgent(userCtx, { templateId: "blank", name: "短id", clientRequestId: "short" }), "invalid_client_request_id");

  // Fix round 2 — cross-ORG same-user replay (user migration scenario): the
  // ledger row's owner matches, but the hydrated Agent lives in the OLD org;
  // the read model is the tenant authority, so the replay is rejected with NO
  // new agent and NO ledger mutation.
  {
    const agentsBeforeX = (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c;
    const ledgerBeforeX = (db.prepare(`SELECT COUNT(*) c FROM agent_builder_requests`).get() as { c: number }).c;
    const xReqId = "m6a-cross-org-req-001";
    createExpertAgent(userCtx, { templateId: "blank", name: "orgA的Agent", clientRequestId: xReqId });
    const migratedCtx: RequestContext = { userId: USER, role: "user", orgId: "m6a-org-q" };
    await expectCode("same-user CROSS-ORG replay rejected (tenant boundary)", () =>
      createExpertAgent(migratedCtx, { templateId: "blank", name: "orgB重放", clientRequestId: xReqId }), "invalid_client_request_id");
    const agentsAfterX = (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c;
    const ledgerAfterX = (db.prepare(`SELECT COUNT(*) c FROM agent_builder_requests`).get() as { c: number }).c;
    ok("cross-org rejection created no new agent", agentsAfterX === agentsBeforeX + 1, `before=${agentsBeforeX} after=${agentsAfterX}`);
    ok("cross-org rejection mutated no ledger row", ledgerAfterX === ledgerBeforeX + 1);
  }

  // Fix round 2 — replay-before-gates PRESERVED for the SAME org: after the
  // org's quota fills up (or the org is suspended), a retry of the SAME org's
  // successful create still replays the same agent instead of 429/403.
  {
    const { provisionOrg: provisionRetry } = await import("./org-governance.js");
    const { setQuota: setQuotaRetry } = await import("./quota-service.js");
    await provisionRetry({
      id: "m6a-org-retry", name: "M6a Retry Org",
      firstAdminUsername: "m6a-retry-admin", firstAdminPassword: "retry-pw-123456",
      actorUserId: "m6a-admin", actorRole: "admin",
    });
    const retryCtx: RequestContext = { userId: USER, role: "user", orgId: "m6a-org-retry" };
    const rReqId = "m6a-same-org-retry-01";
    const original = createExpertAgent(retryCtx, { templateId: "blank", name: "重放源", clientRequestId: rReqId });
    setQuotaRetry("m6a-org-retry", { maxAgents: 0 }); // quota now exhausted
    const replayed = createExpertAgent(retryCtx, { templateId: "blank", name: "重放源", clientRequestId: rReqId });
    ok("same-org retry AFTER quota exhaustion replays the same agent (not 429)",
      replayed.id === original.id, `${original.id} vs ${replayed.id}`);
  }

  // Concurrent POSTs with the same request id (route level): both 201, same agent id.
  const app8 = express();
  app8.use(express.json({ limit: "64kb" }));
  app8.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { userId: USER, userRole: "user", orgId: ORG });
    next();
  });
  app8.use("/api/agent-builder", createAgentBuilderRoutes());
  const server8 = app8.listen(0);
  const BASE8 = `http://127.0.0.1:${(server8.address() as { port: number }).port}`;
  const concurrentBody = { templateId: "blank", name: "并发幂等", clientRequestId: "m6a-concurrent-req-01" };
  const agentsBeforeConcurrent = (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c;
  const [r1, r2] = await Promise.all([
    fetch(`${BASE8}/api/agent-builder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(concurrentBody) }),
    fetch(`${BASE8}/api/agent-builder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(concurrentBody) }),
  ]);
  const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
  ok("concurrent POSTs: both 201, same agent id (exactly one Agent)",
    r1.status === 201 && r2.status === 201 && b1.agent.id === b2.agent.id &&
    (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c === agentsBeforeConcurrent + 1);
  // HTTP retry replay: same id, one agent.
  const r3 = await fetch(`${BASE8}/api/agent-builder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(concurrentBody) });
  const b3 = await r3.json();
  ok("HTTP retry with same clientRequestId replays the same agent",
    r3.status === 201 && b3.agent.id === b1.agent.id &&
    (db.prepare(`SELECT COUNT(*) c FROM agents`).get() as { c: number }).c === agentsBeforeConcurrent + 1);
  server8.close();
}

// ─── Section 9: fix-round admin options (governed app-bounded pool) ──

{
  const adminCtx: RequestContext = { userId: "m6a-admin", role: "admin", orgId: ORG };
  const adminOpts = getBuilderOptions(adminCtx);
  const adminIds = adminOpts.capabilities.map((c) => c.resourceId);
  ok("admin options: full governed pool substituted (hello-skill visible)",
    adminIds.includes("hello-skill"), `ids=${adminIds.join(",")}`);
  ok("admin options: app allowlist still applies (minimal-plugin excluded)",
    !adminIds.includes("minimal-plugin"));

  // Admin create: entitlement bypassed, allowlist + validity still enforced.
  const adminAgent = createExpertAgent(adminCtx, {
    templateId: "blank", name: "管理员建Agent", capabilityIds: ["hello-skill"],
  });
  ok("admin create: can activate an entitled-to-nobody capability (governed)",
    adminAgent.id in activationKeys() && (activationKeys()[adminAgent.id] ?? []).includes("hello-skill"));
  await expectCode("admin create: app-allowlist boundary still denies minimal-plugin", () =>
    createExpertAgent(adminCtx, { templateId: "blank", name: "越权", capabilityIds: ["minimal-plugin"] }), "capability_not_allowed");

  // Route level: admin options listing shows the governed pool.
  const app9 = express();
  app9.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { userId: "m6a-admin", userRole: "admin", orgId: ORG });
    next();
  });
  app9.use("/api/agent-builder", createAgentBuilderRoutes());
  const server9 = app9.listen(0);
  const BASE9 = `http://127.0.0.1:${(server9.address() as { port: number }).port}`;
  const adminOptsRes = await (await fetch(`${BASE9}/api/agent-builder/options`)).json();
  ok("route: admin GET options lists the governed pool (non-empty)",
    Array.isArray(adminOptsRes.capabilities) && adminOptsRes.capabilities.some((c: { resourceId: string }) => c.resourceId === "hello-skill"));
  server9.close();
}

// Cleanup: drop the default-app allowlist row so other test files aren't affected.
db.prepare(`DELETE FROM application_capabilities WHERE id = 'm6a-cap-1'`).run();

console.log(`\nAll ${pass} assertions passed.`);
process.exit(0);
