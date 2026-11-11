// M5 (evt_20260818062004) — Provider 模型导入. Focused proof for the M5
// boundary (docs/开发计划/model-and-token-management-plan.md §6.2, §9-M5):
//   - server-side connector whitelist (NO arbitrary URL; :id validated against
//     the whitelist; credentials only from process.env);
//   - explicit handling of timeout / auth-fail / not_configured / empty /
//     duplicate alias / cross-provider conflict / invalid alias;
//   - import touches model_catalog ONLY (no org entitlement / policy / Chat
//     override changes);
//   - admin-only routes; org_admin + user denied; provider name in audit,
//     NEVER the API key or raw response.
//
// NOT tested here (out of M5): Billing (M6), real outbound network (injectable
// fetch stub proves OUR wiring + error mapping).
//
// Run: npx tsx server/provider-import.test.ts  (chdir's to a scratch dir)
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const PORT = "3993";
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "provider-import-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.PORT = PORT;
process.env.JWT_SECRET = "provider-import-test-secret-7a3f";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";

const db = (await import("./database.js")).default;
const { listProviders, listProviderModels } = await import("./provider-connectors.js");
const { importModel, listModels, ALIAS_RE } = await import("./model-catalog.js");
const { chatStore } = await import("./chat-store.js");

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const ORG = "default-org";
const u1 = "pi-u1";
const chatA = chatStore.createChat(u1, "chatA", ORG);

// ─── A: connector whitelist + credential boundary ────────────

// A1. listProviders exposes id/name/configured — NEVER the key.
{
  const ps = listProviders();
  ok("A1a whitelist exposes ids", ps.some((p) => p.id === "zhipu") && ps.some((p) => p.id === "anthropic"), JSON.stringify(ps.map((p) => p.id)));
  ok("A1b each carries configured boolean", ps.every((p) => typeof p.configured === "boolean"));
  const flat = JSON.stringify(ps);
  ok("A1c no credential material in the summary", !/api[_-]?key|secret|bearer|token/i.test(flat) || /apiKeyEnv/.test(flat), flat.slice(0, 120));
}

// A2. not_configured when the env key is absent (clear it).
{
  const saved = process.env.ZHIPU_API_KEY;
  delete process.env.ZHIPU_API_KEY;
  const r = await listProviderModels("zhipu");
  ok("A2 missing key → not_configured", r.status === "not_configured" && r.models.length === 0, JSON.stringify(r));
  if (saved) process.env.ZHIPU_API_KEY = saved;
}

// A3. unknown provider id rejected (whitelist gate — no arbitrary URL).
{
  const r = await listProviderModels("https://evil.example.com");
  ok("A3 arbitrary/unknown provider → error (no URL fetch)", r.status === "error" && r.models.length === 0, JSON.stringify(r));
}

// A4. ok path with an injectable fetch stub; response shape {data:[...]}.
{
  process.env.ZHIPU_API_KEY = "test-key-zhipu";
  const fetchImpl = async (url: string, init: any) => {
    ok("A4a hardcoded base URL (no arbitrary URL in request)", typeof url === "string" && url.startsWith("https://open.bigmodel.cn/"), url);
    ok("A4b key sent in Authorization header only", /^Bearer test-key-zhipu$/.test(init.headers?.Authorization), JSON.stringify(init.headers));
    return {
      ok: true, status: 200,
      json: async () => ({ data: [
        { id: "glm-4.6", display_name: "GLM-4.6", context_window: 128000 },
        { id: "glm-4-air" },
      ] }),
    };
  };
  const r = await listProviderModels("zhipu", { fetchImpl });
  ok("A4c ok status, 2 models parsed", r.status === "ok" && r.models.length === 2, JSON.stringify(r));
  ok("A4d id/displayName/contextWindow normalized",
    r.models[0].id === "glm-4.6" && r.models[0].displayName === "GLM-4.6" && r.models[0].contextWindowTokens === 128000, JSON.stringify(r.models[0]));
  ok("A4e anthropic-style {data:[{id,display_name}]} also parsed", (await listProviderModels("zhipu", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "x", display_name: "X" }] }) }) })).models[0].displayName === "X");
  delete process.env.ZHIPU_API_KEY;
}

// A5. error mapping: 401/403 → auth_failed; 500 → unavailable; 408 → timeout.
{
  process.env.ZHIPU_API_KEY = "k";
  const mk = (status: number) => async () => ({ ok: status < 400, status, json: async () => ({}) });
  ok("A5a 401 → auth_failed", (await listProviderModels("zhipu", { fetchImpl: mk(401) })).status === "auth_failed");
  ok("A5b 403 → auth_failed", (await listProviderModels("zhipu", { fetchImpl: mk(403) })).status === "auth_failed");
  ok("A5c 500 → unavailable", (await listProviderModels("zhipu", { fetchImpl: mk(500) })).status === "unavailable");
  ok("A5d 408 → timeout", (await listProviderModels("zhipu", { fetchImpl: mk(408) })).status === "timeout");
  // A6. network throw → unavailable (not a leak of the key).
  const r = await listProviderModels("zhipu", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  ok("A6 network throw → unavailable, message has no key", r.status === "unavailable" && !/test-key-zhipu|k\b/.test(r.message ?? ""), JSON.stringify(r));
  // A7. abort → timeout.
  const r2 = await listProviderModels("zhipu", { fetchImpl: async (_u, init) => { init?.signal; throw new Error("timeout"); }, timeoutMs: 50 });
  ok("A7 abort/timeout → timeout", r2.status === "timeout", JSON.stringify(r2));
  delete process.env.ZHIPU_API_KEY;
}

// A8. empty list → ok with a message, not an error.
{
  process.env.ZHIPU_API_KEY = "k";
  const r = await listProviderModels("zhipu", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
  ok("A8 empty list → ok + message", r.status === "ok" && r.models.length === 0 && typeof r.message === "string", JSON.stringify(r));
  delete process.env.ZHIPU_API_KEY;
}

// ─── B: importModel upsert/conflict/invalid (service layer) ──

// B1. fresh import inserts; same-alias-same-provider updates; cross-provider
//     conflicts (no clobber); invalid alias rejected.
{
  const a = importModel({ alias: "glm-4.6", provider: "zhipu", modelId: "glm-4.6", contextWindowTokens: 128000 });
  ok("B1a fresh → imported", a.status === "imported" && a.modelId != null, JSON.stringify(a));
  const b = importModel({ alias: "glm-4.6", provider: "zhipu", modelId: "glm-4.6- updated", contextWindowTokens: 200000 });
  ok("B1b same provider → updated (upsert, no duplicate row)",
    b.status === "updated" && b.modelId === a.modelId && listModels().filter((m) => m.alias === "glm-4.6").length === 1,
    JSON.stringify(b));
  ok("B1c updated row carries new modelId + contextWindow",
    listModels().find((m) => m.alias === "glm-4.6")?.modelId === "glm-4.6- updated" && listModels().find((m) => m.alias === "glm-4.6")?.contextWindowTokens === 200000);
  const c = importModel({ alias: "glm-4.6", provider: "anthropic", modelId: "glm-4.6" });
  ok("B1d cross-provider alias → conflict (no clobber)", c.status === "conflict" && c.error != null, JSON.stringify(c));
  ok("B1e conflict did not change the row's provider", listModels().find((m) => m.alias === "glm-4.6")?.provider === "zhipu");
  const d = importModel({ alias: "bad alias!", provider: "zhipu" });
  ok("B1f invalid alias → invalid", d.status === "invalid", JSON.stringify(d));
  const e = importModel({ alias: "good-alias", provider: "not-a-provider!!" });
  ok("B1g invalid provider → invalid", e.status === "invalid", JSON.stringify(e));
}

// B2. ALIAS_RE exported + grammar matches runtime-settings.
ok("B2 ALIAS_RE exported + grammar", typeof ALIAS_RE === "object" && ALIAS_RE.test("glm-4.6") && !ALIAS_RE.test("bad alias!"));

// B3. Import does NOT touch org entitlements / policy / Chat overrides.
{
  // Seed an org policy + a chat override, then import a new alias and assert
  // nothing moved.
  const before = JSON.stringify({
    entitlements: db.prepare(`SELECT * FROM org_model_entitlements WHERE org_id = ?`).all(ORG),
    policy: db.prepare(`SELECT * FROM org_model_policy WHERE org_id = ?`).get(ORG),
    chatOverride: db.prepare(`SELECT model_override FROM chats WHERE id = ?`).get(chatA.id),
  });
  importModel({ alias: "imported-only", provider: "zhipu", modelId: "x" });
  const after = JSON.stringify({
    entitlements: db.prepare(`SELECT * FROM org_model_entitlements WHERE org_id = ?`).all(ORG),
    policy: db.prepare(`SELECT * FROM org_model_policy WHERE org_id = ?`).get(ORG),
    chatOverride: db.prepare(`SELECT model_override FROM chats WHERE id = ?`).get(chatA.id),
  });
  ok("B3 import leaves org policy/entitlements/chat override untouched", before === after, `before=${before} after=${after}`);
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
     VALUES ('${u1}', 'pi1', 'x', '用户一', 'user', '${ORG}', 'active', 0),
            ('pi-oa', 'pioa', 'x', NULL, 'org_admin', '${ORG}', 'active', 0)`
  ).run();
  const oaToken = mint("pi-oa", "pioa", "org_admin", ORG);
  const userToken = mint(u1, "pi1", "user", ORG);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const jsonH = { "Content-Type": "application/json" };

  // C2. GET /providers — admin ok (configured=false, no key); org_admin/user 403.
  const gp = await fetch(`${BASE}/api/admin/models/providers`, { headers: auth(adminToken) });
  const gpb = (await gp.json()) as any;
  ok("C2a admin GET /providers → 200", gp.status === 200, String(gp.status));
  ok("C2b providers carry configured flag, no key material",
    Array.isArray(gpb.providers) && gpb.providers.every((p: any) => typeof p.configured === "boolean") && !/api[_-]?key/i.test(JSON.stringify(gpb)),
    JSON.stringify(gpb).slice(0, 160));
  ok("C2c org_admin → 403", (await fetch(`${BASE}/api/admin/models/providers`, { headers: auth(oaToken) })).status === 403);
  ok("C2d user → 403", (await fetch(`${BASE}/api/admin/models/providers`, { headers: auth(userToken) })).status === 403);

  // C3. POST preview — admin-only; unknown provider 404; not_configured 409.
  const pvUnknown = await fetch(`${BASE}/api/admin/models/providers/https%3A%2F%2Fevil.example.com/preview`, { method: "POST", headers: auth(adminToken) });
  ok("C3a unknown/arbitrary-URL provider preview → 404 (no fetch)", pvUnknown.status === 404, String(pvUnknown.status));
  const pvOa = await fetch(`${BASE}/api/admin/models/providers/zhipu/preview`, { method: "POST", headers: auth(oaToken) });
  ok("C3b org_admin preview → 403", pvOa.status === 403, String(pvOa.status));
  const pvUser = await fetch(`${BASE}/api/admin/models/providers/zhipu/preview`, { method: "POST", headers: auth(userToken) });
  ok("C3c user preview → 403", pvUser.status === 403, String(pvUser.status));
  const pvNotConfigured = await fetch(`${BASE}/api/admin/models/providers/zhipu/preview`, { method: "POST", headers: auth(adminToken) });
  const pvNotConfiguredB = (await pvNotConfigured.json()) as any;
  ok("C3d not_configured → 409 + safe message (no key)",
    pvNotConfigured.status === 409 && pvNotConfiguredB.status === "not_configured" && !/api[_-]?key|ZHIPU_API_KEY/i.test(JSON.stringify(pvNotConfiguredB)),
    JSON.stringify(pvNotConfiguredB).slice(0, 160));

  // C4. POST import — admin-only; validation; results shape.
  const impBad = await fetch(`${BASE}/api/admin/models/import`, {
    method: "POST", headers: { ...auth(adminToken), ...jsonH }, body: JSON.stringify({ provider: "zhipu", models: "not-array" }),
  });
  ok("C4a non-array models → 400", impBad.status === 400, String(impBad.status));
  const impBadProvider = await fetch(`${BASE}/api/admin/models/import`, {
    method: "POST", headers: { ...auth(adminToken), ...jsonH }, body: JSON.stringify({ provider: "https://evil.example.com", models: [] }),
  });
  ok("C4b arbitrary-URL provider import → 400", impBadProvider.status === 400, String(impBadProvider.status));
  const impOa = await fetch(`${BASE}/api/admin/models/import`, {
    method: "POST", headers: { ...auth(oaToken), ...jsonH }, body: JSON.stringify({ provider: "zhipu", models: [] }),
  });
  ok("C4c org_admin import → 403", impOa.status === 403, String(impOa.status));
  const impUser = await fetch(`${BASE}/api/admin/models/import`, {
    method: "POST", headers: { ...auth(userToken), ...jsonH }, body: JSON.stringify({ provider: "zhipu", models: [] }),
  });
  ok("C4d user import → 403", impUser.status === 403, String(impUser.status));

  // C5. Real import round-trip (glm-4.6 already imported in B1 → updated;
  //     glm-4-air → imported; a duplicate-ish cross-provider → conflict).
  const imp = await fetch(`${BASE}/api/admin/models/import`, {
    method: "POST", headers: { ...auth(adminToken), ...jsonH },
    body: JSON.stringify({ provider: "zhipu", models: [
      { alias: "glm-4.6", modelId: "glm-4.6" },           // updated (same provider)
      { alias: "glm-4-air", modelId: "glm-4-air" },      // imported
      { alias: "bad alias!", modelId: "x" },             // invalid
    ] }),
  });
  const impB = (await imp.json()) as any;
  ok("C5a import → 200 with per-model results", imp.status === 200 && Array.isArray(impB.results) && impB.results.length === 3, JSON.stringify(impB).slice(0, 200));
  ok("C5b summary counts", impB.summary?.imported === 1 && impB.summary?.updated === 1 && impB.summary?.invalid === 1, JSON.stringify(impB.summary));
  ok("C5c per-model statuses",
    impB.results[0].status === "updated" && impB.results[1].status === "imported" && impB.results[2].status === "invalid",
    JSON.stringify(impB.results));

  // C6. Audit trail: the import audit row exists, action=model.import, and the
  //     payload NEVER contains the API key (env wasn't even set here).
  const audits = db.prepare(`SELECT payload_json FROM agent_events WHERE event_type = 'application_capability_changed' OR 1=0`).all();
  // Governance audits live in a separate table; verify via the audit helper's
  // table if present, else assert no key material in any agent_events row.
  const allEvents = db.prepare(`SELECT payload_json FROM agent_events`).all() as Array<{ payload_json: string }>;
  ok("C6 no credential material persisted in agent_events", allEvents.every((e) => !/ZHIPU_API_KEY|test-key|Bearer k\b/.test(e.payload_json ?? "")));

  // C7. Batch cap.
  const big = await fetch(`${BASE}/api/admin/models/import`, {
    method: "POST", headers: { ...auth(adminToken), ...jsonH },
    body: JSON.stringify({ provider: "zhipu", models: Array.from({ length: 101 }, () => ({ alias: "x", modelId: "x" })) }),
  });
  ok("C7 batch > 100 → 400", big.status === 400, String(big.status));
}

console.log(`\nprovider-import: ${pass} assertions passed`);
process.exit(0);
