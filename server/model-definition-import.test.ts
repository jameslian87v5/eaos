// M6 (evt_20260818112121) — Anthropic-only 模型定义 JSON 导入. Focused proof for
// the M6 boundary (简化模型接入，仅 Anthropic 协议):
//   - protocol 固定 anthropic-compatible（其余值拒绝，无 OpenAI-compatible）;
//   - 明文 apiKey 拒绝；apiKeyEnv 只存环境变量名（key-value 形态也拒绝）;
//   - baseUrl 仅目录元数据：落 model_catalog.base_url，绝不进入运行时解析
//     （resolveEffectiveModel 输出无 baseUrl，运行时用部署的 ANTHROPIC_BASE_URL）;
//   - 导入只写 model_catalog（不碰 org entitlements / policy / Chat override）;
//   - admin-only 路由；org_admin + user 403；批量上限 100；审计无凭证。
//
// Run: npx tsx server/model-definition-import.test.ts  (chdir's to a scratch dir)
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const PORT = "3992";
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "model-def-import-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.PORT = PORT;
process.env.JWT_SECRET = "model-def-import-test-secret-9c1e";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

const db = (await import("./database.js")).default;
const {
  importModelDefinition, listModels, resolveEffectiveModel,
  setOrgModelPolicy, setChatModelOverride, getChatModelSelection,
} = await import("./model-catalog.js");
const { chatStore } = await import("./chat-store.js");

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const ORG = "default-org";
const u1 = "mdi-u1";
const chatA = chatStore.createChat(u1, "chatA", ORG);

const validDef = {
  id: "claude-sonnet-5",
  name: "claude-sonnet-5",
  vendor: "anthropic",
  baseUrl: "https://api.anthropic.com",
  protocol: "anthropic-compatible",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  supportsToolCall: true,
  supportsImages: true,
  supportsReasoning: false,
  maxInputTokens: 1000000,
  maxOutputTokens: 64000,
};

// ─── A: service-layer validation + persistence ────────────────

// A1. Valid import persists ALL 10 fields onto one catalog row.
{
  const r = importModelDefinition(validDef);
  ok("A1a valid → imported", r.status === "imported" && r.modelId != null, JSON.stringify(r));
  const row = listModels().find((m) => m.alias === "claude-sonnet-5")!;
  ok("A1b vendor → provider column", row.provider === "anthropic", row.provider);
  ok("A1c id → modelId column", row.modelId === "claude-sonnet-5", String(row.modelId));
  ok("A1d baseUrl stored as metadata", row.baseUrl === "https://api.anthropic.com", String(row.baseUrl));
  ok("A1e protocol stored", row.protocol === "anthropic-compatible", String(row.protocol));
  ok("A1f apiKeyEnv stores the env-var NAME (not a key)", row.apiKeyEnv === "ANTHROPIC_API_KEY", String(row.apiKeyEnv));
  ok("A1g capability flags persisted",
    row.supportsToolCall === true && row.supportsImages === true && row.supportsReasoning === false,
    JSON.stringify([row.supportsToolCall, row.supportsImages, row.supportsReasoning]));
  ok("A1h token limits persisted",
    row.maxInputTokens === 1000000 && row.maxOutputTokens === 64000,
    JSON.stringify([row.maxInputTokens, row.maxOutputTokens]));
  ok("A1i maxInputTokens backfills contextWindowTokens", row.contextWindowTokens === 1000000, String(row.contextWindowTokens));
}

// A2. Plaintext apiKey is REJECTED (req 3) — never reaches the DB.
{
  const r = importModelDefinition({ ...validDef, name: "leaky", apiKey: "sk-ant-plain-secret" } as never);
  ok("A2a plaintext apiKey → invalid", r.status === "invalid" && /apiKey/.test(r.error ?? ""), JSON.stringify(r));
  ok("A2b rejected row not persisted", !listModels().some((m) => m.alias === "leaky"));
}

// A3. apiKeyEnv carrying a key VALUE (long/whitespace) is rejected — only
//     env-var NAMES pass, so a pasted secret can't hide in that field either.
{
  const long = "sk-ant-api03-" + "x".repeat(48);
  const r = importModelDefinition({ ...validDef, name: "env-leak", apiKeyEnv: long });
  ok("A3a key-value in apiKeyEnv → invalid", r.status === "invalid" && /env-var name/.test(r.error ?? ""), JSON.stringify(r));
  const r2 = importModelDefinition({ ...validDef, name: "env-leak2", apiKeyEnv: "has space" });
  ok("A3b whitespace env name → invalid", r2.status === "invalid", JSON.stringify(r2));
  ok("A3c neither persisted", !listModels().some((m) => m.alias === "env-leak" || m.alias === "env-leak2"));
}

// A4. protocol gate: anything ≠ anthropic-compatible is invalid (req 1 — no
//     OpenAI-compatible, no dual protocol). Absent protocol defaults to the
//     fixed value.
{
  const r = importModelDefinition({ ...validDef, name: "oa-model", protocol: "openai-compatible" });
  ok("A4a openai-compatible → invalid", r.status === "invalid" && /anthropic-compatible/.test(r.error ?? ""), JSON.stringify(r));
  const r2 = importModelDefinition({ ...validDef, name: "oa-model2", protocol: "anthropic" });
  ok("A4b near-miss protocol → invalid", r2.status === "invalid", JSON.stringify(r2));
  const r3 = importModelDefinition({ ...validDef, name: "no-proto", protocol: undefined });
  ok("A4c absent protocol → defaults to anthropic-compatible",
    r3.status === "imported" && listModels().find((m) => m.alias === "no-proto")?.protocol === "anthropic-compatible",
    JSON.stringify(r3));
}

// A5. Required-field validation: id and name.
{
  ok("A5a missing id → invalid", importModelDefinition({ ...validDef, id: "  " }).status === "invalid");
  ok("A5b missing name → invalid", importModelDefinition({ ...validDef, name: "" }).status === "invalid");
  ok("A5c invalid alias grammar → invalid", importModelDefinition({ ...validDef, name: "bad alias!" }).status === "invalid");
  ok("A5d invalid vendor grammar → invalid", importModelDefinition({ ...validDef, vendor: "not!!a vendor" }).status === "invalid");
}

// A6. Upsert-by-alias: same name+vendor → updated (single row, enabled
//     preserved); cross-vendor same alias → conflict (no clobber).
{
  const first = listModels().find((m) => m.alias === "claude-sonnet-5")!;
  db.prepare(`UPDATE model_catalog SET enabled = 0 WHERE alias = 'claude-sonnet-5'`).run();
  const r = importModelDefinition({ ...validDef, maxInputTokens: 500000 });
  ok("A6a re-import same vendor → updated", r.status === "updated" && r.modelId === first.id, JSON.stringify(r));
  const row = listModels().filter((m) => m.alias === "claude-sonnet-5");
  ok("A6b still one row, enabled preserved (import never flips enabled)",
    row.length === 1 && row[0].enabled === false && row[0].maxInputTokens === 500000,
    JSON.stringify(row.map((x) => [x.enabled, x.maxInputTokens])));
  const c = importModelDefinition({ ...validDef, vendor: "other-vendor" });
  ok("A6c cross-vendor same alias → conflict (no clobber)",
    c.status === "conflict" && listModels().find((m) => m.alias === "claude-sonnet-5")?.provider === "anthropic",
    JSON.stringify(c));
}

// A7. baseUrl is METADATA ONLY (req 5): an attacker-controlled baseUrl is
//     stored verbatim but never reaches model resolution or the capability
//     bundle — the runtime keeps the single deployed ANTHROPIC_BASE_URL.
{
  const r = importModelDefinition({ ...validDef, name: "evil-base", baseUrl: "https://evil.example.com/v1" });
  ok("A7a arbitrary baseUrl accepted as catalog metadata", r.status === "imported", JSON.stringify(r));
  const eff = resolveEffectiveModel({ orgId: ORG });
  ok("A7b resolution output carries no baseUrl (alias only)",
    typeof eff.alias === "string" && !("baseUrl" in eff), JSON.stringify(eff));
  const { capabilityProvider } = await import("./capability-provider.js");
  const bundle = capabilityProvider.resolve({ chatId: chatA.id });
  const flat = JSON.stringify(bundle);
  ok("A7c capability bundle (control→data bridge) carries no catalog baseUrl",
    !flat.includes("evil.example.com") && !("baseUrl" in bundle.sdkOptions),
    flat.slice(0, 160));
  ok("A7d bundle's model is an ALIAS, not a URL",
    bundle.sdkOptions.model == null || !/https?:\/\//.test(bundle.sdkOptions.model),
    String(bundle.sdkOptions.model));
}

// A8. Import writes model_catalog ONLY (req 4): org entitlements / org policy
//     / Chat+Agent overrides are untouched, and .env is never touched (no fs
//     write path exists in this module — proven by absence of env mutation).
{
  const before = JSON.stringify({
    entitlements: db.prepare(`SELECT * FROM org_model_entitlements WHERE org_id = ?`).all(ORG),
    policy: db.prepare(`SELECT * FROM org_model_policy WHERE org_id = ?`).get(ORG),
    chatOverride: db.prepare(`SELECT model_override FROM chats WHERE id = ?`).get(chatA.id),
  });
  const envBefore = process.env.ANTHROPIC_BASE_URL;
  importModelDefinition({ ...validDef, name: "isolation-probe", vendor: "anthropic" });
  const after = JSON.stringify({
    entitlements: db.prepare(`SELECT * FROM org_model_entitlements WHERE org_id = ?`).all(ORG),
    policy: db.prepare(`SELECT * FROM org_model_policy WHERE org_id = ?`).get(ORG),
    chatOverride: db.prepare(`SELECT model_override FROM chats WHERE id = ?`).get(chatA.id),
  });
  ok("A8a import leaves org policy/entitlements/chat override untouched", before === after, `before=${before} after=${after}`);
  ok("A8b import never mutates process.env (no .env rewrite)", process.env.ANTHROPIC_BASE_URL === envBefore);
  // The imported alias is NOT usable by the org until an org_admin/admin
  // explicitly entitles it (deny-default).
  const { listUsableModelAliases } = await import("./model-catalog.js");
  ok("A8c imported alias NOT auto-authorized for the org (deny-default)",
    !listUsableModelAliases(ORG).includes("isolation-probe"),
    JSON.stringify(listUsableModelAliases(ORG)));

  // A9. Provider code pasted into `name` (the common mistake) → invalid WITH a
  //     hint pointing at the id field. The bracket code itself stays legal in id.
  {
    const r = importModelDefinition({ ...validDef, name: "glm-5.3[1m]", id: "glm-5.3[1m]", vendor: "zhipu" });
    const err = r.status === "invalid" ? r.error ?? "" : "";
    ok("A9a bracket code as name → invalid",
      r.status === "invalid" && /Invalid name/.test(err), JSON.stringify(r));
    ok("A9b error hints at the id field",
      /"id"/.test(err) && /management alias/.test(err), JSON.stringify(err));
  }
}

// ─── B: runtime passes model_id, not alias (evt_20260819132308) ──
// Regression of the live 400 [1214][modelCode：不存在]: the §3.2 winner must
// hand the SDK the catalog's REAL provider name (model_id); alias stays the
// management key (selector / entitlements / overrides).

// B1. alias != modelId → runtime injection uses modelId.
{
  importModelDefinition({ ...validDef, name: "glm-5.3", id: "glm-5.3-x", vendor: "zhipu" });
  const row = listModels().find((m) => m.alias === "glm-5.3")!;
  ok("B1a fixture has alias != modelId", row.modelId === "glm-5.3-x" && row.alias === "glm-5.3");
  // Entitle + default the org to it, then put a chat override on chatA.
  setOrgModelPolicy(ORG, { models: [{ modelId: row.id, enabled: true }], defaultModelId: row.id });
  const eff = resolveEffectiveModel({ chatId: chatA.id });
  ok("B1b resolution reports alias AND modelId distinctly",
    eff.alias === "glm-5.3" && eff.modelId === "glm-5.3-x" && eff.source === "org", JSON.stringify(eff));
  ok("B1c runtimeModel = modelId (what the SDK needs)", eff.runtimeModel === "glm-5.3-x");
  const { capabilityProvider } = await import("./capability-provider.js");
  const bundle = capabilityProvider.resolve({ chatId: chatA.id, orgId: ORG });
  ok("B1d sdkOptions.model (control→data bridge) = modelId, not alias",
    bundle.sdkOptions.model === "glm-5.3-x", String(bundle.sdkOptions.model));

  // B2. Chat override path also translates (precedence level 1).
  setChatModelOverride(chatA.id, "glm-5.3");
  const eff2 = resolveEffectiveModel({ chatId: chatA.id });
  ok("B2a chat override wins by ALIAS", eff2.source === "chat" && eff2.alias === "glm-5.3", JSON.stringify(eff2));
  ok("B2b chat override still injects modelId",
    capabilityProvider.resolve({ chatId: chatA.id, orgId: ORG }).sdkOptions.model === "glm-5.3-x");

  // B3. Selection API distinguishes the two for the UI.
  const sel = getChatModelSelection(chatA.id)!;
  ok("B3a selection API returns alias + effective.modelId",
    sel.override === "glm-5.3" && sel.effective.alias === "glm-5.3" && sel.effective.modelId === "glm-5.3-x",
    JSON.stringify(sel));

  // B4. Legacy row (model_id NULL) → alias fallback, pre-M6 behavior.
  db.prepare(`UPDATE model_catalog SET model_id = NULL WHERE alias = 'glm-5.3'`).run();
  const eff3 = resolveEffectiveModel({ chatId: chatA.id });
  ok("B4a legacy row: modelId null, runtimeModel falls back to alias",
    eff3.modelId === null && eff3.runtimeModel === "glm-5.3", JSON.stringify(eff3));
  ok("B4b bridge injects alias for legacy rows",
    capabilityProvider.resolve({ chatId: chatA.id, orgId: ORG }).sdkOptions.model === "glm-5.3");
  db.prepare(`UPDATE model_catalog SET model_id = 'glm-5.3-x' WHERE alias = 'glm-5.3'`).run();

  // B5. model_id edit flips configVersion (warm-resume drift surfaced).
  const { computeConfigVersion } = await import("./capability-version.js");
  const ctx = { orgId: ORG, role: "user" } as never;
  const v1 = computeConfigVersion(ctx, chatA.id);
  db.prepare(`UPDATE model_catalog SET model_id = 'glm-5.3-y' WHERE alias = 'glm-5.3'`).run();
  const v2 = computeConfigVersion(ctx, chatA.id);
  ok("B5 model_id change under same alias flips configVersion", v1 !== v2, `${v1} vs ${v2}`);
  db.prepare(`UPDATE model_catalog SET model_id = 'glm-5.3-x' WHERE alias = 'glm-5.3'`).run();

  // B6. Authorization semantics unchanged (alias-keyed, deny-default).
  importModelDefinition({ ...validDef, name: "unentitled", id: "unentitled-id", vendor: "zhipu" });
  const unentitled = listModels().find((m) => m.alias === "unentitled")!;
  const sel2 = getChatModelSelection(chatA.id)!;
  ok("B6a unentitled alias not in org-selectable list",
    !sel2.available.includes("unentitled"), JSON.stringify(sel2.available));
  ok("B6b entitlement table still keys by catalog row id (unchanged shape)",
    (db.prepare(`SELECT model_id, enabled FROM org_model_entitlements WHERE org_id = ?`).all(ORG) as Array<{ model_id: string; enabled: number }>)
      .some((e) => e.model_id === unentitled.id && e.enabled === 1) === false);

  // B7. `[1m]`-suffixed provider codes pass through VERBATIM (evt_20260819132834):
  // the bracket code is a legal Zhipu Coding Plan modelCode — never stripped,
  // rejected, or normalized. Only the ALIAS grammar forbids brackets (management
  // key); model_id is free-form (trimmed only).
  importModelDefinition({ ...validDef, name: "zhipu-coding-1m", id: "glm-5.3[1m]", vendor: "zhipu" });
  const row1m = listModels().find((m) => m.alias === "zhipu-coding-1m")!;
  ok("B7a [1m] model_id stored verbatim (no normalization)",
    row1m.modelId === "glm-5.3[1m]", JSON.stringify(row1m.modelId));
  setOrgModelPolicy(ORG, { models: [{ modelId: row1m.id, enabled: true }], defaultModelId: row1m.id });
  const eff1m = resolveEffectiveModel({ chatId: chatA.id });
  ok("B7b runtimeModel carries the bracket code verbatim",
    eff1m.alias === "zhipu-coding-1m" && eff1m.runtimeModel === "glm-5.3[1m]", JSON.stringify(eff1m));
  ok("B7c sdkOptions.model = glm-5.3[1m] exactly (SDK maps it, we don't touch it)",
    capabilityProvider.resolve({ chatId: chatA.id, orgId: ORG }).sdkOptions.model === "glm-5.3[1m]");
}



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
     VALUES ('${u1}', 'mdi1', 'x', '用户一', 'user', '${ORG}', 'active', 0),
            ('mdi-oa', 'mdioa', 'x', NULL, 'org_admin', '${ORG}', 'active', 0)`
  ).run();
  const oaToken = mint("mdi-oa", "mdioa", "org_admin", ORG);
  const userToken = mint(u1, "mdi1", "user", ORG);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const jsonH = { "Content-Type": "application/json" };

  // C2. Permission matrix: admin only.
  ok("C2a org_admin → 403",
    (await fetch(`${BASE}/api/admin/models/import-json`, { method: "POST", headers: { ...auth(oaToken), ...jsonH }, body: JSON.stringify({ models: [] }) })).status === 403);
  ok("C2b user → 403",
    (await fetch(`${BASE}/api/admin/models/import-json`, { method: "POST", headers: { ...auth(userToken), ...jsonH }, body: JSON.stringify({ models: [] }) })).status === 403);
  ok("C2c anonymous → 401",
    (await fetch(`${BASE}/api/admin/models/import-json`, { method: "POST", headers: jsonH, body: JSON.stringify({ models: [] }) })).status === 401);

  // C3. Body-shape validation.
  ok("C3a models not array → 400",
    (await fetch(`${BASE}/api/admin/models/import-json`, { method: "POST", headers: { ...auth(adminToken), ...jsonH }, body: JSON.stringify({ models: "nope" }) })).status === 400);
  ok("C3b empty models → 400",
    (await fetch(`${BASE}/api/admin/models/import-json`, { method: "POST", headers: { ...auth(adminToken), ...jsonH }, body: JSON.stringify({ models: [] }) })).status === 400);
  ok("C3c batch > 100 → 400",
    (await fetch(`${BASE}/api/admin/models/import-json`, { method: "POST", headers: { ...auth(adminToken), ...jsonH }, body: JSON.stringify({ models: Array.from({ length: 101 }, () => validDef) }) })).status === 400);

  // C4. Single-object body (no {models} wrapper) is accepted.
  const single = await fetch(`${BASE}/api/admin/models/import-json`, {
    method: "POST", headers: { ...auth(adminToken), ...jsonH },
    body: JSON.stringify({ ...validDef, name: "http-single" }),
  });
  const singleB = (await single.json()) as any;
  ok("C4 bare object → 200 + imported", single.status === 200 && singleB.results?.[0]?.status === "imported", JSON.stringify(singleB).slice(0, 160));

  // C5. Batch round-trip with per-model statuses (imported / invalid apiKey /
  //     invalid protocol / conflict).
  const batch = await fetch(`${BASE}/api/admin/models/import-json`, {
    method: "POST", headers: { ...auth(adminToken), ...jsonH },
    body: JSON.stringify({ models: [
      { ...validDef, name: "http-batch" },                                    // imported
      { ...validDef, name: "http-key", apiKey: "sk-plain" },                  // invalid (plaintext key)
      { ...validDef, name: "http-oa", protocol: "openai-compatible" },        // invalid (protocol)
      { ...validDef, name: "http-single", vendor: "renamed-vendor" },         // conflict (cross-vendor)
    ] }),
  });
  const batchB = (await batch.json()) as any;
  ok("C5a batch → 200, 4 results",
    batch.status === 200 && batchB.results?.length === 4, JSON.stringify(batchB).slice(0, 200));
  ok("C5b per-model statuses",
    batchB.results[0].status === "imported" && batchB.results[1].status === "invalid"
    && batchB.results[2].status === "invalid" && batchB.results[3].status === "conflict",
    JSON.stringify(batchB.results));
  ok("C5c summary counts", batchB.summary?.imported === 1 && batchB.summary?.invalid === 2 && batchB.summary?.conflict === 1, JSON.stringify(batchB.summary));

  // C6. Audit: action=model.import_definition recorded; NO credential
  //     material in any audit row (metadata-only).
  const audits = db.prepare(
    `SELECT action, reason_summary FROM governance_audit_log WHERE action = 'model.import_definition'`
  ).all() as Array<{ action: string; reason_summary: string }>;
  ok("C6a audit row exists", audits.length >= 1, JSON.stringify(audits));
  ok("C6b audit metadata-only (counts or denial), no key/baseUrl payload",
    audits.every((a) =>
      (/imported=\d+/.test(a.reason_summary ?? "") || a.reason_summary === "admin only") &&
      !/sk-|Bearer|api[_-]?key\s*[:=]|evil\.example\.com/i.test(a.reason_summary ?? "")),
    JSON.stringify(audits));
  const allAudit = db.prepare(`SELECT reason_summary, object_id FROM governance_audit_log`).all() as Array<{ reason_summary: string }>;
  ok("C6c no plaintext key anywhere in the audit log",
    allAudit.every((a) => !/sk-plain|sk-ant/.test(a.reason_summary ?? "")));
}

console.log(`\nmodel-definition-import: ${pass} assertions passed`);
process.exit(0);
