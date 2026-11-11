// Stage 2 (evt_20260817124649) — coarse global model management. Focused proof
// for the codex-agreed Stage 2 boundary:
//   - runtime-settings.json gains defaultModel + models:[{alias,enabled}] (NO
//     models.json); defaultModel must be an ENABLED alias (hard gate on save,
//     fail-safe degrade on read of a hand-edited file);
//   - sdkOptions.model is set ONLY by CapabilityProvider.resolve (control→data
//     bridge); nothing client-supplied can reach it;
//   - local: LocalAgentRuntime → AgentSessionOptions.model → query (AGENT_MODEL
//     env = compatibility fallback only);
//   - docker: AGENT_SDK_OPTIONS carries bundle.sdkOptions (model included);
//     agent-entry prefers sdkOptions.model over AGENT_MODEL;
//   - coarse only: NO per-agent model, org entitlement, realModelId mapping,
//     cost, multi-provider routing, or new admin module.
//
// Layer A/B/C/D: service + pure-function level. Layer E: HTTP (admin gate +
// validation surfaced as 400).
//
// NOTE: runtime-settings resolves data/ from process.cwd() at module load with
// NO env override, so this test chdir's into a scratch dir FIRST (before any
// dynamic import) — it must never touch the repo's real data/runtime-settings.json.
//
// Run: npx tsx server/model-management.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import os from "node:os";

const PORT = "3998";
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "model-mgmt-test-"));
process.chdir(SCRATCH); // BEFORE dynamic imports — data/ resolves under scratch
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.PORT = PORT;
process.env.JWT_SECRET = "model-mgmt-test-secret-strong-3f7a";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.RUNTIME_MODE = "local";
delete process.env.AGENT_MODEL; // deterministic fallback-chain tests

const {
  getRuntimeSettings,
  saveRuntimeSettings,
  defaultSettings,
  sanitizeModelAliases,
} = await import("./runtime-settings.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { resolveLocalModel } = await import("./ai-client.js");
const { buildLocalSessionOptions } = await import("./agent-runtime.js");

await import("./server.js"); // boot for layer E (admin-gated settings routes)

const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}
const settingsFile = path.join(SCRATCH, "data", "runtime-settings.json");

// ─── A: runtime-settings — defaults, hard gate, read fail-safe, sanitize ──
// A1. Fresh boot defaults mirror the historical hard-coded behavior ("opus").
{
  const s = getRuntimeSettings(true);
  ok("A1 defaults: defaultModel opus + one enabled alias", s.defaultModel === "opus" && s.models.length === 1 && s.models[0].alias === "opus" && s.models[0].enabled === true, JSON.stringify(s.models));
}

// A2. Hard gate: unknown defaultModel rejected on save.
{
  assert.throws(() => saveRuntimeSettings({ defaultModel: "ghost-model" }), /Invalid defaultModel/);
  ok("A2 unknown defaultModel rejected", true);
}

// A3. Hard gate: disabling the CURRENT default (without switching) rejected.
{
  assert.throws(() => saveRuntimeSettings({ models: [{ alias: "opus", enabled: false }] }), /Invalid defaultModel/);
  ok("A3 disabling current default rejected", true);
}

// A4. Hard gate: switching default to a DISABLED alias rejected.
{
  assert.throws(() =>
    saveRuntimeSettings({ models: [{ alias: "opus", enabled: true }, { alias: "glm-4.7", enabled: false }], defaultModel: "glm-4.7" })
  , /Invalid defaultModel/);
  ok("A4 switch to disabled alias rejected", true);
}

// A5. Legal flow: add alias → enable → switch default → persisted.
{
  const s1 = saveRuntimeSettings({ models: [{ alias: "opus", enabled: true }, { alias: "glm-4.7", enabled: true }], defaultModel: "glm-4.7" });
  ok("A5a switch default to enabled alias ok", s1.defaultModel === "glm-4.7" && s1.models.length === 2);
  const s2 = getRuntimeSettings(true);
  ok("A5b persisted to disk + re-read", s2.defaultModel === "glm-4.7", settingsFile);
  // Old default may now be disabled legally (it is no longer the default).
  const s3 = saveRuntimeSettings({ models: [{ alias: "opus", enabled: false }, { alias: "glm-4.7", enabled: true }] });
  ok("A5c disabling a NON-default alias ok", s3.models.find((m) => m.alias === "opus")?.enabled === false);
  saveRuntimeSettings({ models: [{ alias: "opus", enabled: true }, { alias: "glm-4.7", enabled: true }], defaultModel: "glm-4.7" });
}

// A6. Read fail-safe: hand-edited file with unknown/disabled default degrades
//     to the first ENABLED alias; all-disabled degrades to platform default.
//     Full invariant (codex evt_20260818022809): the read/normalize path must
//     ALWAYS return models containing defaultModel with enabled=true.
  const invariant = (s: ReturnType<typeof getRuntimeSettings>, label: string) =>
    ok(label, s.models.some((m) => m.alias === s.defaultModel && m.enabled === true),
      `defaultModel=${s.defaultModel}, models=${JSON.stringify(s.models)}`);
{
  fs.writeFileSync(settingsFile, JSON.stringify({ defaultModel: "hand-edited-ghost", models: [{ alias: "opus", enabled: true }, { alias: "glm-4.7", enabled: false }] }));
  const a = getRuntimeSettings(true);
  ok("A6a hand-edited unknown default degrades to first enabled", a.defaultModel === "opus");
  invariant(a, "A6a invariant: default is an enabled member of models");
  fs.writeFileSync(settingsFile, JSON.stringify({ defaultModel: "opus", models: [{ alias: "opus", enabled: false }] }));
  const b = getRuntimeSettings(true);
  ok("A6b all-disabled degrades to platform default alias", b.defaultModel === defaultSettings.defaultModel);
  invariant(b, "A6b invariant: default RE-ENABLED in the returned models list");
  // Absent-alias variant: all-disabled list NOT containing the fallback alias →
  // the fallback alias must be INSERTED as enabled.
  fs.writeFileSync(settingsFile, JSON.stringify({ defaultModel: "glm-4.7", models: [{ alias: "glm-4.7", enabled: false }, { alias: "glm-4.6", enabled: false }] }));
  const c = getRuntimeSettings(true);
  ok("A6b2 absent fallback alias gets inserted enabled", c.defaultModel === defaultSettings.defaultModel
    && c.models.some((m) => m.alias === defaultSettings.defaultModel && m.enabled === true)
    && c.models.length === 3, JSON.stringify(c.models));
  // Legacy file (pre-Stage-2, no model fields) keeps historical behavior.
  fs.writeFileSync(settingsFile, JSON.stringify({ idleStopMs: 60000 }));
  const legacy = getRuntimeSettings(true);
  ok("A6c legacy file without model fields → opus default, behavior unchanged", legacy.defaultModel === "opus" && legacy.models[0].enabled === true);
}

// A7. Alias sanitize: trim, malformed dropped, dupes dropped (keep first), cap 20.
{
  const many = Array.from({ length: 30 }, (_, i) => ({ alias: `m-${i}`, enabled: true }));
  const s = sanitizeModelAliases([
    { alias: "  glm-4.7  ", enabled: 1 }, // trimmed, truthy enabled
    { alias: "bad alias!", enabled: true }, // malformed → dropped
    { alias: "", enabled: true }, // empty → dropped
    null, // shapeless → dropped
    { alias: "glm-4.7", enabled: false }, // dupe → dropped
    ...many,
  ]);
  ok("A7 sanitize: trim/malformed/dupe dropped, cap 20, first entry wins", s.length === 20 && s[0].alias === "glm-4.7" && s[0].enabled === true, JSON.stringify(s.slice(0, 3)));
}

// ─── B: resolve() is the ONLY model injection point ──────────────────────
{
  saveRuntimeSettings({ models: [{ alias: "opus", enabled: true }, { alias: "glm-4.7", enabled: true }], defaultModel: "glm-4.7" });
  const local = capabilityProvider.resolve({ runtimeType: "local" } as any);
  const docker = capabilityProvider.resolve({ runtimeType: "docker" } as any);
  ok("B1 resolve injects settings.defaultModel into sdkOptions.model", local.sdkOptions.model === "glm-4.7", String(local.sdkOptions.model));
  ok("B2 local + docker runtimes receive the SAME model", docker.sdkOptions.model === local.sdkOptions.model);
  // Client-inject boundary: a model field stuffed into the resolve context is
  // IGNORED — resolve reads runtime-settings only.
  const forged = capabilityProvider.resolve({ runtimeType: "local", model: "evil-alias" } as any);
  ok("B3 ctx-injected model ignored (client cannot inject)", forged.sdkOptions.model === "glm-4.7");
}

// ─── C: local chain (pure seams — no real SDK query started) ─────────────
{
  const withBundle = buildLocalSessionOptions({
    capabilityBundle: { sdkOptions: { model: "glm-4.7", tools: ["Read"] }, mounts: [], env: {} } as any,
  });
  ok("C1 LocalAgentRuntime forwards bundle sdkOptions.model", withBundle.model === "glm-4.7");
  const noBundle = buildLocalSessionOptions({});
  ok("C2 no bundle → model undefined (fallback chain applies)", noBundle.model === undefined);
  // resolveLocalModel precedence: bundle > AGENT_MODEL env > "opus".
  ok("C3a bundle model wins over env", resolveLocalModel("glm-4.7", "env-model") === "glm-4.7");
  ok("C3b AGENT_MODEL env is the compatibility fallback", resolveLocalModel(undefined, "env-model") === "env-model");
  ok("C3c historical default when nothing set", resolveLocalModel(undefined, undefined) === "opus");
  ok("C3d empty-string bundle falls through to env", resolveLocalModel("", "env-model") === "env-model");
}

// ─── D: docker chain (container script is not importable — source contract) ──
{
  const entry = fs.readFileSync(new URL("../docker/agent-entry.ts", import.meta.url), "utf8");
  ok(
    "D1 agent-entry precedence sdkOptions.model > AGENT_MODEL > opus",
    /model:\s*sdkOptions\.model\s*\|\|\s*process\.env\.AGENT_MODEL\s*\|\|\s*"opus"/.test(entry)
  );
  const dr = fs.readFileSync(new URL("./docker-runtime.ts", import.meta.url), "utf8");
  ok(
    "D2 docker-runtime forwards full sdkOptions (only tools/allowedTools split out) → model rides AGENT_SDK_OPTIONS",
    /const \{ tools: _t, allowedTools: _a, \.\.\.sdkRest \} = bundle\.sdkOptions/.test(dr) && /AGENT_SDK_OPTIONS=\$\{JSON\.stringify\(sdkRest\)\}/.test(dr)
  );
}

// ─── E: HTTP — admin-only PUT + validation surfaced as 400 ───────────────
{
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "__probe__", password: "__probe__" }) });
      break;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const db = (await import("./database.js")).default;
  db.prepare(`UPDATE users SET must_change_password = 0 WHERE username = 'admin'`).run();
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
  ok("E1 admin login", login.ok);
  const token = ((await login.json()) as { token: string }).token;

  // E2: legal save round-trips through the admin route.
  const put = await fetch(`${BASE}/api/admin/runtime/settings`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ models: [{ alias: "opus", enabled: true }, { alias: "glm-4.7", enabled: true }], defaultModel: "opus" }),
  });
  ok("E2 PUT with enabled default ok", put.ok);
  const got = (await (await fetch(`${BASE}/api/admin/runtime/settings`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
  ok("E3 GET returns models + defaultModel", got.settings.defaultModel === "opus" && Array.isArray(got.settings.models) && got.settings.models.length === 2);

  // E4: invalid default → 400 (server-side hard gate, not just UI guard).
  const bad = await fetch(`${BASE}/api/admin/runtime/settings`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ models: [{ alias: "opus", enabled: false }], defaultModel: "opus" }),
  });
  ok("E4 PUT disabling current default → 400", bad.status === 400, String(bad.status));

  // E5: non-admin cannot touch model config (client-inject boundary at HTTP).
  // Mint the JWT directly (stub user has no valid bcrypt hash) — token shape
  // mirrors auth.ts: {userId, username, role, orgId, tokenVersion:1}; the
  // middleware's verifyUserTokenCurrent then passes (active, v1, org match)
  // and the request reaches the admin-only role gate → real 403.
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, org_id, status, must_change_password)
     VALUES ('u-mm', 'mm-user', 'x', 'mm', 'user', 'default-org', 'active', 0)`
  ).run();
  const { default: jwt } = await import("jsonwebtoken");
  const userToken = jwt.sign(
    { userId: "u-mm", username: "mm-user", role: "user", orgId: "default-org", tokenVersion: 1 },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" }
  );
  const forbidden = await fetch(`${BASE}/api/admin/runtime/settings`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultModel: "evil-alias" }),
  });
  ok("E5 non-admin PUT → 403 (client cannot inject model)", forbidden.status === 403, String(forbidden.status));
}

console.log(`\n${pass} passed, 0 failed`);
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(0);
