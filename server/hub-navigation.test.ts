// R5c controlled Skill Hub navigation. Run: npx tsx server/hub-navigation.test.ts
// Fails until server/hub-navigation.ts is implemented.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r5c-nav-"));
process.env.DB_PATH = path.join(TMP, "nav.db");
process.env.ENTITLEMENTS_FILE = path.join(TMP, "ent.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(TMP, "ac.json");
fs.writeFileSync(process.env.ENTITLEMENTS_FILE, JSON.stringify({ entries: [] }));
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE, JSON.stringify({ agents: {} }));

const db = (await import("./database.js")).default;
const { orgService } = await import("./org-service.js");
const { orgNamespaceMappingService } = await import("./org-namespace-mapping.js");
const { buildHubLaunchResponse } = await import("./hub-navigation.js");

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`${name}: ${(e as Error).message}`); }
}

orgService.create("org-a", "Org A");
orgService.create("org-b", "Org B");
orgNamespaceMappingService.upsert("org-a", "team-a");
orgNamespaceMappingService.upsert("org-b", "team-b");

const HUB_URL = "https://hub.example.internal";

// ─── 1. admin launch: URL only, no token/orgId/role in response ────────
ok("1. admin launch — no token/orgId/role leakage", () => {
  const res = buildHubLaunchResponse(
    { userId: "admin-1", role: "admin", orgId: "default-org" },
    { hubBaseUrl: HUB_URL },
  );
  assert.ok(res.url, "returns a launch URL");
  assert.equal(res.url, HUB_URL, "URL is the bare hub base — no path/query baked for admin");
  const json = JSON.stringify(res);
  assert.ok(!json.includes("token"), "no token in response");
  assert.ok(!json.includes("orgId"), "no platform orgId in response");
  assert.ok(!json.includes("role"), "no role in response");
  assert.ok(!res.url.includes("token="), "no token query param in URL");
});

// ─── 2. org_admin launch: verified base URL only — NO guessed /ns/ route ─
ok("2. org_admin launch — verified base URL only, no guessed /ns/ route", () => {
  const res = buildHubLaunchResponse(
    { userId: "oa-1", role: "org_admin", orgId: "org-a" },
    { hubBaseUrl: HUB_URL },
  );
  assert.equal(res.url, HUB_URL, "URL is the bare verified hub base (no /ns/ deep-link — route is NOT R5b-verified)");
  assert.ok(!res.url.includes("/ns/"), "NO guessed /ns/<slug> route (unverified — prohibited by R5c)");
  assert.ok(!res.url.includes("team-a") && !res.url.includes("team-b"), "no namespace slug baked into URL");
  const json = JSON.stringify(res);
  assert.ok(!json.includes("token"), "no token");
  assert.ok(!json.includes("orgId"), "no platform orgId");
  assert.ok(!json.includes("role"), "no role");
});

// ─── 3. user launch: verified base URL only, no leakage ──────────────────
ok("3. user launch — verified base URL only, no leakage", () => {
  const res = buildHubLaunchResponse(
    { userId: "u-1", role: "user", orgId: "org-b" },
    { hubBaseUrl: HUB_URL },
  );
  assert.equal(res.url, HUB_URL, "URL is the bare verified hub base");
  assert.ok(!res.url.includes("/ns/"), "no guessed /ns/ route");
  const json = JSON.stringify(res);
  assert.ok(!json.includes("token"), "no token");
  assert.ok(!json.includes("orgId"), "no orgId");
  assert.ok(!json.includes("role"), "no role");
});

// ─── 4. unauthenticated ctx rejected (route is auth-gated; this asserts ─
//         the service refuses to build for a missing ctx) ────────────────
ok("4. missing hub base rejected", () => {
  assert.throws(
    () => buildHubLaunchResponse({ userId: "u", role: "user", orgId: "org-a" }, { hubBaseUrl: "" }),
    /hub base/i,
  );
});

// ─── 5. org with no mapping: admin still gets bare URL; org_admin gets bare ─
ok("5. no mapping → bare URL (no namespace), still no leakage", () => {
  const res = buildHubLaunchResponse(
    { userId: "u", role: "user", orgId: "org-nomapping" },
    { hubBaseUrl: HUB_URL },
  );
  assert.equal(res.url, HUB_URL, "no mapping → bare hub URL, no namespace baked");
  const json = JSON.stringify(res);
  assert.ok(!json.includes("token") && !json.includes("orgId") && !json.includes("role"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
