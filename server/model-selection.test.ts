// M2 (evt_20260818052215) — Chat/Agent model selection & effective resolution.
// Focused proof for the M2 boundary (docs/开发计划/model-and-token-management-plan.md §3.2, §7, §8.1):
//   - precedence Chat > Agent > org > platform, each level validated
//     平台启用 ∩ 组织授权 (read-path degradation, never a runtime error);
//   - WRITE gate: only usable aliases may be stored (no frontend model injection);
//   - resolve() bridge: sdkOptions.model comes from resolveEffectiveModel for
//     BOTH local and docker call sites (control→data iron law);
//   - configVersion flips on a model change → drift surfaced (NO hot-switch);
//   - HTTP permissions: owner / org_admin own-org / admin; other user and
//     foreign org_admin → 404; invalid model strings → 400.
//
// NOT tested here (out of M2): token dashboard (M3), auto-compact (M4),
// provider import (M5), billing (M6).
//
// Run: npx tsx server/model-selection.test.ts  (chdir's to a scratch dir first —
// runtime-settings resolves data/ from cwd and must never touch the repo copy)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import os from "node:os";

const PORT = "3996";
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "model-selection-test-"));
process.chdir(SCRATCH); // BEFORE dynamic imports — data/ resolves under scratch
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.PORT = PORT;
process.env.JWT_SECRET = "model-selection-test-secret-strong-9b2c";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

const mc = await import("./model-catalog.js");
const db = (await import("./database.js")).default;
const { chatStore } = await import("./chat-store.js");
const { getRuntimeSettings } = await import("./runtime-settings.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { computeConfigVersion } = await import("./capability-version.js");

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

mc.ensureModelCatalogSeeded(); // opus (platform default) + runtime-settings aliases
const glm47 = mc.createModel({ alias: "glm-4.7", provider: "zhipu" });
const glm46 = mc.createModel({ alias: "glm-4.6", provider: "zhipu" });
const glmX = mc.createModel({ alias: "glm-x", provider: "zhipu" }); // platform-enabled, NOT entitled
mc.setOrgModelPolicy(ORG, {
  defaultModelId: glm47.id,
  models: [
    { modelId: mc.listModels().find((m) => m.alias === "opus")!.id, enabled: true },
    { modelId: glm47.id, enabled: true },
    { modelId: glm46.id, enabled: true },
  ],
});

// NOTE: user rows are inserted AFTER server boot — inserting before would make
// ensureAdminExists skip creating the admin (it seeds only into an empty users
// table). Sections A–C only need the chats/agents rows, which carry no user FK.
const u1 = "u-m2-owner";
const chat = chatStore.createChat(u1, "m2-test", ORG);
const chatId = chat.id;
const chatB = chatStore.createChat(u1, "m2-test-b", ORG_B);

// ─── A: service precedence + degradation (§3.2) ───────────────

// A1. No override → org default. (M6-fix evt_20260819132308: shape now also
// carries modelId + runtimeModel; this row has no model_id → legacy fallback.)
assert.deepEqual(mc.resolveEffectiveModel({ chatId }),
  { alias: "glm-4.7", modelId: null, runtimeModel: "glm-4.7", source: "org" });
ok("A1 no override → org default", true);

// A2. Agent-level override wins over org default.
mc.setAgentModelOverride(chatId, "glm-4.6");
ok("A2 agent override → source agent",
  mc.resolveEffectiveModel({ chatId }).source === "agent" && mc.resolveEffectiveModel({ chatId }).alias === "glm-4.6");

// A3. Chat-level override beats agent-level.
mc.setChatModelOverride(chatId, "opus");
ok("A3 chat override beats agent",
  mc.resolveEffectiveModel({ chatId }).source === "chat" && mc.resolveEffectiveModel({ chatId }).alias === "opus");

// A4. Clearing the chat override falls back to the agent level.
mc.setChatModelOverride(chatId, null);
ok("A4 cleared chat override → agent level", mc.resolveEffectiveModel({ chatId }).source === "agent");

// A5. Dangling override degrades (platform-disabled candidate skipped).
mc.updateModel(glm46.id, { enabled: false });
ok("A5 disabled agent-override degrades to org default",
  mc.resolveEffectiveModel({ chatId }).source === "org" && mc.resolveEffectiveModel({ chatId }).alias === "glm-4.7");

// A6. De-authorized override degrades the same way (entitlement revoked).
mc.setOrgModelPolicy(ORG, { models: [] }); // wipes entitlements (REPLACE semantics), default falls away
ok("A6 unentitled candidates degrade to platform",
  mc.resolveEffectiveModel({ chatId }).source === "platform" && mc.resolveEffectiveModel({ chatId }).alias === getRuntimeSettings(true).defaultModel);

// A7. No chatId (boot-time default bundle) → platform default.
ok("A7 no chatId → platform default", mc.resolveEffectiveModel({}).source === "platform");

// A8. Deny-default org (no entitlements) still resolves to the platform default
//     — the runtime keeps working; the org just has no choices.
ok("A8 deny-default org chat → platform default", mc.resolveEffectiveModel({ chatId: chatB.id }).alias === getRuntimeSettings(true).defaultModel);

// A9. WRITE hard gate — categorical errors.
assert.throws(() => mc.setChatModelOverride(chatId, "gpt-evil"), /Unknown model/);
ok("A9a unknown alias rejected", true);
assert.throws(() => mc.setChatModelOverride(chatId, "glm-x"), /not authorized/);
ok("A9b org-unentitled alias rejected", true);
assert.throws(() => mc.setAgentModelOverride(chatId, "glm-x"), /not authorized/);
ok("A9c agent-level gate equally enforced", true);
assert.throws(() => mc.setChatModelOverride("no-such-chat", "opus"), /Chat not found/);
ok("A9d unknown chat rejected", true);

// A10. Selection view: available = 平台启用 ∩ 组织授权 (glm-4.6 disabled,
//      glm-x unentitled — neither may appear even though both rows exist).
mc.setOrgModelPolicy(ORG, {
  defaultModelId: glm47.id,
  models: [
    { modelId: mc.listModels().find((m) => m.alias === "opus")!.id, enabled: true },
    { modelId: glm47.id, enabled: true },
  ],
});
const sel = mc.getChatModelSelection(chatId)!;
ok("A10 available list excludes disabled/unentitled",
  JSON.stringify(sel.available) === JSON.stringify(["glm-4.7", "opus"]) && sel.effective.alias === "glm-4.7",
  JSON.stringify(sel.available));

// ─── B: resolve() bridge (control→data iron law) ──────────────

// B1. resolve() injects the EFFECTIVE model for the chat (local bundle shape).
const bundle = capabilityProvider.resolve({ userId: u1, chatId, role: "user", runtimeType: "local", orgId: ORG });
ok("B1 resolve() model = effective model (org default)", bundle.sdkOptions.model === "glm-4.7", String(bundle.sdkOptions.model));

// B2. Chat override flows through resolve().
mc.setChatModelOverride(chatId, "opus");
ok("B2 chat override reaches sdkOptions.model", capabilityProvider.resolve({ chatId, orgId: ORG }).sdkOptions.model === "opus");
mc.setChatModelOverride(chatId, null);

// B3. No chatId → the ctx-less resolution (default-org fallback). Consistent
//     with resolveEffectiveModel({}); with NO org policy set it IS the platform
//     default (that exact case is locked by test:model-management B).
ok("B3 resolve() without chatId mirrors resolveEffectiveModel({})",
  capabilityProvider.resolve({ runtimeType: "local" }).sdkOptions.model === mc.resolveEffectiveModel({}).alias);

// ─── C: configVersion drift (§8.1 — no hot-switch, change is detectable) ──

const ownerCtx = { userId: u1, role: "user" as const, orgId: ORG };
const cv0 = computeConfigVersion(ownerCtx, chatId);
mc.setChatModelOverride(chatId, "opus");
const cv1 = computeConfigVersion(ownerCtx, chatId);
ok("C1 model change flips configVersion", cv0 !== cv1, `${cv0} vs ${cv1}`);
mc.setChatModelOverride(chatId, null);
ok("C2 clearing restores the original version (deterministic)", computeConfigVersion(ownerCtx, chatId) === cv0);

// ─── E: docker injection source-contract ──────────────────────
// Both production call sites (docker + local) build the bundle via
// capabilityProvider.resolve({ ..., chatId, ... }) — the effective model rides
// the SAME bundle into the container env; agent-entry consumption is locked by
// the Stage 2 regexes (test:model-management D).
{
  const src = fs.readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  ok("E1 docker call site resolves with chatId (effective model rides the bundle)",
    /runtimeType:\s*"docker",\s*\n\s*orgId,/.test(src) && src.includes("capabilityBundle: bundle"));
}

// ─── D: HTTP + permissions ────────────────────────────────────

await import("./server.js"); // boot (runs seed — no-op now)
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
    `INSERT INTO users (id, username, password_hash, role, org_id, status, must_change_password)
     VALUES ('${u1}',       'm2owner', 'x', 'user',      '${ORG}',   'active', 0),
            ('u-m2-other', 'm2other', 'x', 'user',      '${ORG}',   'active', 0),
            ('u-m2-oa',    'm2oa',    'x', 'org_admin', '${ORG}',   'active', 0),
            ('u-m2-ob',    'm2ob',    'x', 'org_admin', '${ORG_B}', 'active', 0)`
  ).run();
  const ownerToken = mint(u1, "m2owner", "user", ORG);
  const otherToken = mint("u-m2-other", "m2other", "user", ORG);
  const oaToken = mint("u-m2-oa", "m2oa", "org_admin", ORG);
  const obToken = mint("u-m2-ob", "m2ob", "org_admin", ORG_B);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  // D2. Owner GET — selector payload (override/effective/available).
  const g = await fetch(`${BASE}/api/chats/${chatId}/model`, { headers: auth(ownerToken) });
  const gb = (await g.json()) as any;
  ok("D2a owner GET → 200", g.status === 200, String(g.status));
  ok("D2b payload shows effective + source + available",
    gb.effective.alias === "glm-4.7" && gb.effective.source === "org" && Array.isArray(gb.available) && gb.available.length === 2,
    JSON.stringify(gb.effective));

  // D3. Owner PUT — valid alias.
  const p1 = await fetch(`${BASE}/api/chats/${chatId}/model`, { method: "PUT", headers: auth(ownerToken), body: JSON.stringify({ modelAlias: "opus" }) });
  const p1b = (await p1.json()) as any;
  ok("D3a owner PUT valid alias → 200 + configChanged", p1.ok && p1b.configChanged === true && p1b.appliesTo === "next_runtime", String(p1.status));
  ok("D3b effective now chat-level", p1b.effective.alias === "opus" && p1b.effective.source === "chat");

  // D4. Frontend injection attempts → 400 (server-side validation 铁律).
  const p2 = await fetch(`${BASE}/api/chats/${chatId}/model`, { method: "PUT", headers: auth(ownerToken), body: JSON.stringify({ modelAlias: "gpt-evil" }) });
  ok("D4a unknown model string → 400", p2.status === 400, String(p2.status));
  const p3 = await fetch(`${BASE}/api/chats/${chatId}/model`, { method: "PUT", headers: auth(ownerToken), body: JSON.stringify({ modelAlias: "glm-x" }) });
  ok("D4b org-unentitled model → 400", p3.status === 400, String(p3.status));
  const p4 = await fetch(`${BASE}/api/chats/${chatId}/model`, { method: "PUT", headers: auth(ownerToken), body: JSON.stringify({ modelAlias: 123 }) });
  ok("D4c non-string alias → 400", p4.status === 400, String(p4.status));

  // D5. Restore: clear the chat override.
  const p5 = await fetch(`${BASE}/api/chats/${chatId}/model`, { method: "PUT", headers: auth(ownerToken), body: JSON.stringify({ modelAlias: null }) });
  ok("D5 clear override → 200, back to org default", p5.ok && ((await p5.json()) as any).effective.source === "org", String(p5.status));

  // D6. Permission matrix.
  const otherGet = await fetch(`${BASE}/api/chats/${chatId}/model`, { headers: auth(otherToken) });
  ok("D6a other same-org user GET → 404", otherGet.status === 404, String(otherGet.status));
  const otherPut = await fetch(`${BASE}/api/chats/${chatId}/model`, { method: "PUT", headers: auth(otherToken), body: JSON.stringify({ modelAlias: "opus" }) });
  ok("D6b other same-org user PUT → 404", otherPut.status === 404, String(otherPut.status));
  const obGet = await fetch(`${BASE}/api/chats/${chatId}/model`, { headers: auth(obToken) });
  ok("D6c foreign org_admin GET → 404 (no existence leak)", obGet.status === 404, String(obGet.status));
  const adminGet = await fetch(`${BASE}/api/chats/${chatId}/model`, { headers: auth(adminToken) });
  ok("D6d admin GET → 200 (cross-org)", adminGet.status === 200, String(adminGet.status));

  // D7. Agent-level PUT by own-org org_admin; chat GET then reports the agent source.
  const a1 = await fetch(`${BASE}/api/agents/${chatId}/model`, { method: "PUT", headers: auth(oaToken), body: JSON.stringify({ modelAlias: "opus" }) });
  ok("D7a org_admin (own org) PUT agent-level → 200", a1.ok, String(a1.status));
  const a2 = await fetch(`${BASE}/api/chats/${chatId}/model`, { headers: auth(ownerToken) });
  const a2b = (await a2.json()) as any;
  ok("D7b agent override visible via chat GET (source=agent)",
    a2b.override === "opus" && a2b.overrideSource === "agent" && a2b.effective.source === "agent", JSON.stringify(a2b.effective));

  // D8. Chat-level PUT by admin also allowed; unknown agent id → 404.
  const a3 = await fetch(`${BASE}/api/agents/no-such-agent/model`, { method: "PUT", headers: auth(adminToken), body: JSON.stringify({ modelAlias: "opus" }) });
  ok("D8a unknown agent id → 404", a3.status === 404, String(a3.status));
  const a4 = await fetch(`${BASE}/api/chats/${chatId}/model`, { method: "PUT", headers: auth(adminToken), body: JSON.stringify({ modelAlias: "glm-4.7" }) });
  ok("D8b admin PUT chat-level → 200", a4.ok, String(a4.status));
  // chat-level glm-4.7 beats the agent-level opus (precedence proof over HTTP)
  const a5 = await fetch(`${BASE}/api/chats/${chatId}/model`, { headers: auth(ownerToken) });
  ok("D8c chat-level beats agent-level over HTTP", ((await a5.json()) as any).effective.source === "chat");

  // D9. Governance audit rows (metadata-only) were written.
  const audits = db.prepare(`SELECT action FROM governance_audit_log WHERE action = 'model_override.update'`).all() as Array<{ action: string }>;
  ok("D9 model_override.update audits recorded", audits.length >= 3, String(audits.length));

  // D10. History preserved: no messages/agent_sessions churn from a model PUT.
  const msgs = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`).get(chatId) as { n: number };
  ok("D10 model PUT does not touch conversation history", msgs.n === 0, String(msgs.n));
}

console.log(`\n${pass} passed, 0 failed`);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(0);
