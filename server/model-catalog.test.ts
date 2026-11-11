// M1 (evt_20260818050653) — Model Catalog + org model policy. Focused proof for
// the M1 boundary (docs/开发计划/model-and-token-management-plan.md §9-M1):
//   - runtime-settings compat seed (one-time, idempotent);
//   - catalog CRUD validation (admin-only at the route layer);
//   - org policy hard gate: default must be platform-ENABLED and org-entitled;
//   - effective = platform-enabled ∩ org-entitled (deny-default), default
//     falls back to the platform default (read-path fail-safe);
//   - disable/delete cascades: a disabled/deleted model never remains an org
//     default, entitlements removed on delete (§10 admin acceptance);
//   - permissions: catalog writes admin-only; org_admin edits ONLY own-org
//     policy (foreign org → 404, not 403); plain user → 403;
//   - governance audits written (metadata-only).
//
// NOT tested here (out of M1): chat-level selection (M2), token dashboard (M3),
// auto-compact (M4), provider /models import (M5).
//
// Run: npx tsx server/model-catalog.test.ts  (chdir's to a scratch dir first —
// runtime-settings resolves data/ from cwd and must never touch the repo copy)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import os from "node:os";

const PORT = "3997";
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "model-catalog-test-"));
process.chdir(SCRATCH); // BEFORE dynamic imports — data/ resolves under scratch
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.PORT = PORT;
process.env.JWT_SECRET = "model-catalog-test-secret-strong-9b2c";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

const mc = await import("./model-catalog.js");
const db = (await import("./database.js")).default;
const { getRuntimeSettings } = await import("./runtime-settings.js");

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// ─── A: service layer ─────────────────────────────────────────

// A1. Compat seed: empty catalog ← runtime-settings models; idempotent.
{
  const seeded = mc.ensureModelCatalogSeeded();
  const defaults = getRuntimeSettings(true);
  ok("A1a seed creates one row per runtime-settings alias", seeded === defaults.models.length && seeded > 0, `seeded=${seeded}`);
  const models = mc.listModels();
  ok("A1b seeded rows mirror alias + enabled state", models.some((m) => m.alias === "opus" && m.enabled === true), JSON.stringify(models.map((m) => `${m.alias}:${m.enabled}`)));
  ok("A1c seed is idempotent (second call no-op)", mc.ensureModelCatalogSeeded() === 0);
}

const ORG = "default-org";
const ORG_B = "org-b";
db.prepare(`INSERT OR IGNORE INTO organizations (id, name, status) VALUES ('${ORG_B}', 'B 部', 'active')`).run();

// A2. createModel validation.
{
  const m = mc.createModel({ alias: "glm-4.7", provider: "zhipu", modelId: "glm-4.7-flash", contextWindowTokens: 128000, description: "test" });
  ok("A2a create ok", m.alias === "glm-4.7" && m.enabled === true && m.modelId === "glm-4.7-flash");
  assert.throws(() => mc.createModel({ alias: "glm-4.7" }), /already exists/);
  ok("A2b duplicate alias rejected", true);
  assert.throws(() => mc.createModel({ alias: "bad alias!" }), /Invalid alias/);
  ok("A2c malformed alias rejected", true);
  assert.throws(() => mc.createModel({ alias: "ok-alias", provider: "bad provider!" }), /Invalid provider/);
  ok("A2d malformed provider rejected", true);
  assert.throws(() => mc.createModel({ alias: "ok-alias", contextWindowTokens: -5 }), /positive integer/);
  ok("A2e non-positive context window rejected", true);
}

// A3. updateModel validation.
{
  const target = mc.listModels().find((m) => m.alias === "opus")!;
  assert.throws(() => mc.updateModel(target.id, { alias: "glm-4.7" }), /already exists/);
  ok("A3a rename to existing alias rejected", true);
  assert.throws(() => mc.updateModel("no-such-id", { enabled: false }), /not found/);
  ok("A3b unknown id rejected", true);
}

// A4/A5. Org policy hard gate + effective resolution.
{
  const opus = mc.listModels().find((m) => m.alias === "opus")!;
  const glm = mc.listModels().find((m) => m.alias === "glm-4.7")!;

  assert.throws(() => mc.setOrgModelPolicy(ORG, { defaultModelId: "no-such-model", models: [] }), /Unknown defaultModelId/);
  ok("A4a unknown defaultModelId rejected", true);
  assert.throws(() => mc.setOrgModelPolicy(ORG, { defaultModelId: glm.id, models: [{ modelId: "no-such", enabled: true }] }), /Unknown modelId/);
  ok("A4b unknown entitlement modelId rejected", true);
  assert.throws(() => mc.setOrgModelPolicy(ORG, { defaultModelId: glm.id, models: [{ modelId: opus.id, enabled: true }] }), /not an enabled model/);
  ok("A4c default not entitled rejected (deny-default)", true);

  const p = mc.setOrgModelPolicy(ORG, {
    defaultModelId: glm.id,
    models: [ { modelId: opus.id, enabled: true }, { modelId: glm.id, enabled: true } ],
  });
  ok("A4d valid policy saved", p.defaultAlias === "glm-4.7" && p.effective.defaultSource === "org");
  ok("A4e effective = platform-enabled ∩ org-entitled", p.effective.models.length === 2 && p.effective.models.some((m) => m.alias === "opus"));

  // A5. No org default → platform default fallback (read-path fail-safe).
  const p2 = mc.setOrgModelPolicy(ORG, { defaultModelId: null, models: [ { modelId: glm.id, enabled: true } ] });
  ok("A5 no org default → platform default source", p2.effective.defaultSource === "platform" && p2.effective.defaultAlias === getRuntimeSettings(true).defaultModel);

  // Deny-default: org with NO entitlements sees nothing.
  const empty = mc.getOrgModelPolicy(ORG_B);
  ok("A5b unconfigured org → deny-default 0 effective models", empty.effective.models.length === 0);
}

// A6. Disable cascade: disabling an org's default model clears the default.
{
  const glm = mc.listModels().find((m) => m.alias === "glm-4.7")!;
  mc.setOrgModelPolicy(ORG, { defaultModelId: glm.id, models: [{ modelId: glm.id, enabled: true }] });
  ok("A6a precondition: org default is glm-4.7", mc.orgsUsingModelAsDefault(glm.id).includes(ORG));
  const disabled = mc.updateModel(glm.id, { enabled: false });
  ok("A6b disable clears org defaults (§10 invariant)", disabled.enabled === false && !mc.orgsUsingModelAsDefault(glm.id).includes(ORG));
  const p = mc.getOrgModelPolicy(ORG);
  ok("A6c policy degrades to platform default after disable", p.effective.defaultSource === "platform" && !p.effective.models.some((m) => m.id === glm.id));
}

// A7. Delete cascade: entitlements gone, default NULL, platform-disabled model
//     cannot be re-set as default.
{
  const glm = mc.listModels().find((m) => m.alias === "glm-4.7")!;
  mc.deleteModel(glm.id);
  const p = mc.getOrgModelPolicy(ORG);
  ok("A7a delete removes entitlement rows (entries all disabled)", p.entries.every((e) => e.modelId !== glm.id || !e.enabled));
  ok("A7b deleted model cannot be a default", p.defaultModelId !== glm.id);
  assert.throws(() => mc.setOrgModelPolicy(ORG, { defaultModelId: glm.id, models: [] }), /Unknown defaultModelId/);
  ok("A7c deleted modelId rejected on policy write", true);
}

// ─── E: HTTP + permissions ────────────────────────────────────

await import("./server.js"); // boot (also runs the boot-time seed — no-op now)
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
  ok("E1 admin login", login.ok);
  const adminToken = ((await login.json()) as { token: string }).token;

  // org_admin (default-org) + plain user fixtures (stub hashes — minted JWTs).
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, org_id, status, must_change_password)
     VALUES ('u-oa', 'oa1', 'x', 'oa', 'org_admin', '${ORG}', 'active', 0),
            ('u-u',  'uu1', 'x', 'uu', 'user',      '${ORG}', 'active', 0)`
  ).run();
  const oaToken = mint("u-oa", "oa1", "org_admin", ORG);
  const userToken = mint("u-u", "uu1", "user", ORG);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  // E2. admin sees the full catalog.
  const listRes = await fetch(`${BASE}/api/admin/models`, { headers: auth(adminToken) });
  const listBody = (await listRes.json()) as any;
  ok("E2 admin list = platform scope, full catalog", listRes.ok && listBody.scope === "platform" && listBody.models.length >= 1);

  // E3. admin creates + validates via HTTP.
  const createRes = await fetch(`${BASE}/api/admin/models`, { method: "POST", headers: auth(adminToken), body: JSON.stringify({ alias: "glm-5", provider: "zhipu", contextWindowTokens: 200000 }) });
  ok("E3a admin POST create → 201", createRes.status === 201, String(createRes.status));
  const created = ((await createRes.json()) as any).model;
  const dupRes = await fetch(`${BASE}/api/admin/models`, { method: "POST", headers: auth(adminToken), body: JSON.stringify({ alias: "glm-5" }) });
  ok("E3b duplicate alias → 400", dupRes.status === 400, String(dupRes.status));

  // E4. org_admin: policy for own org (authorize glm-5 + default) via HTTP.
  const putPolicy = await fetch(`${BASE}/api/admin/orgs/${ORG}/model-policy`, {
    method: "PUT", headers: auth(oaToken),
    body: JSON.stringify({ defaultModelId: created.id, models: [{ modelId: created.id, enabled: true }] }),
  });
  ok("E4a org_admin PUT own-org policy ok", putPolicy.ok, String(putPolicy.status));
  const pol = ((await putPolicy.json()) as any).policy;
  ok("E4b policy effective default = org default", pol.effective.defaultAlias === "glm-5" && pol.effective.defaultSource === "org");

  // E5. org_admin boundary: foreign org → 404; catalog writes → 403.
  const foreignGet = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/model-policy`, { headers: auth(oaToken) });
  ok("E5a org_admin foreign-org policy → 404 (no existence leak)", foreignGet.status === 404, String(foreignGet.status));
  const foreignPut = await fetch(`${BASE}/api/admin/orgs/${ORG_B}/model-policy`, { method: "PUT", headers: auth(oaToken), body: JSON.stringify({}) });
  ok("E5b org_admin foreign-org PUT → 404", foreignPut.status === 404, String(foreignPut.status));
  const oaCreate = await fetch(`${BASE}/api/admin/models`, { method: "POST", headers: auth(oaToken), body: JSON.stringify({ alias: "evil" }) });
  ok("E5c org_admin POST model → 403", oaCreate.status === 403, String(oaCreate.status));
  const oaDel = await fetch(`${BASE}/api/admin/models/${created.id}`, { method: "DELETE", headers: auth(oaToken) });
  ok("E5d org_admin DELETE model → 403", oaDel.status === 403, String(oaDel.status));

  // E6. org_admin catalog view: own-org effective only, raw pool does NOT leak.
  const oaList = await fetch(`${BASE}/api/admin/models`, { headers: auth(oaToken) });
  const oaBody = (await oaList.json()) as any;
  ok("E6 org_admin list = org scope, entitled-only", oaList.ok && oaBody.scope === "org" && oaBody.models.every((m: any) => m.id === created.id) && oaBody.effectiveDefault === "glm-5",
    JSON.stringify(oaBody.models?.map((m: any) => m.alias)));

  // E7. plain user: everything model-related → 403.
  for (const [method, url] of [
    ["GET", "/api/admin/models"],
    ["POST", "/api/admin/models"],
    ["GET", `/api/admin/orgs/${ORG}/model-policy`],
    ["PUT", `/api/admin/orgs/${ORG}/model-policy`],
  ] as const) {
    const r = await fetch(`${BASE}${url}`, { method, headers: auth(userToken), body: method === "GET" ? undefined : JSON.stringify({}) });
    ok(`E7 user ${method} ${url} → 403`, r.status === 403, String(r.status));
  }

  // E8. Invalid default via HTTP → 400 (hard gate surfaced).
  const opusModel = ((await (await fetch(`${BASE}/api/admin/models`, { headers: auth(adminToken) })).json()) as any).models.find((m: any) => m.alias === "opus");
  const badPolicy = await fetch(`${BASE}/api/admin/orgs/${ORG}/model-policy`, {
    method: "PUT", headers: auth(adminToken),
    // default not in the entitled set
    body: JSON.stringify({ defaultModelId: opusModel.id, models: [{ modelId: created.id, enabled: true }] }),
  });
  ok("E8 default-not-entitled → 400", badPolicy.status === 400, String(badPolicy.status));

  // E9. admin disable-with-default cascade via HTTP reports cleared orgs.
  const disableRes = await fetch(`${BASE}/api/admin/models/${created.id}`, { method: "PUT", headers: auth(adminToken), body: JSON.stringify({ enabled: false }) });
  const disBody = (await disableRes.json()) as any;
  ok("E9 disable clears org default + reports it", disableRes.ok && Array.isArray(disBody.clearedOrgDefaults) && disBody.clearedOrgDefaults.includes(ORG), JSON.stringify(disBody.clearedOrgDefaults));

  // E10. governance audits written (metadata-only sink).
  const audits = db.prepare(`SELECT DISTINCT action FROM governance_audit_log WHERE action LIKE 'model%'`).all() as Array<{ action: string }>;
  const actions = new Set(audits.map((a) => a.action));
  ok("E10 model audits recorded", actions.has("model.create") && actions.has("model_policy.update") && actions.has("model.update"), JSON.stringify([...actions]));
}

console.log(`\n${pass} passed, 0 failed`);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(0);
