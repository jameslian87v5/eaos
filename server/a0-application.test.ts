/**
 * a0-application.test.ts — Phase 6 (A0) adversarial unit tests.
 *
 * Tests the 4 cases Codex requested + adversarial edge cases:
 *   1. No app rows → passthrough (no upper bound)
 *   2. Enabled allowlist narrows the set
 *   3. All rows disabled → deny all
 *   4. Forged appId cannot broaden DB-owned app scope
 *   5. App key sign/verify (invalid, disabled, wrong prefix)
 *   6. configVersion changes when app allowlist changes
 *   7. configVersion distinguishes null (passthrough) vs [] (deny all)
 */

import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RequestContext } from "./request-context.js";

// ─── Set env vars BEFORE any imports that read them ──────────
const TMP_DB = "/tmp/test-a0-app.db";
const TMP_CAPS = "/tmp/test-a0-agent-capabilities.json";
const TMP_ENT = "/tmp/test-a0-entitlements.json";

process.env.DB_PATH = TMP_DB;
process.env.AGENT_CAPABILITIES_FILE = TMP_CAPS;
process.env.ENTITLEMENTS_FILE = TMP_ENT;

// Clean slate
rmSync(TMP_DB, { force: true });
rmSync(TMP_CAPS, { force: true });
rmSync(TMP_ENT, { force: true });

// ─── Dynamic imports (after env vars are set) ────────────────
const db = (await import("./database.js")).default;
const { applicationService } = await import("./application-service.js");
const { applicationCapabilitiesService } = await import("./application-capabilities.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { computeConfigVersion } = await import("./capability-version.js");

// ─── Test helpers ────────────────────────────────────────────

const adminCtx: RequestContext = { userId: "admin-1", role: "admin", orgId: "default-org" };
const userCtx: RequestContext = { userId: "user-1", role: "user", orgId: "default-org" };

function setupAgent(agentId: string, ownerId: string, appId: string): void {
  // Insert chats row (required by agents JOIN)
  db.prepare(
    `INSERT OR IGNORE INTO chats (id, user_id, title) VALUES (?, ?, ?)`
  ).run(agentId, ownerId, "Test Agent");
  // Insert agents row
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, org_id, owner_user_id, name, status, app_id)
     VALUES (?, 'default-org', ?, ?, 'active', ?)`
  ).run(agentId, ownerId, "Test Agent", appId);
}

function setAgentCapabilities(agentId: string, resourceIds: string[]): void {
  mkdirSync(path.dirname(TMP_CAPS), { recursive: true });
  let existing: Record<string, string[]> = {};
  try {
    existing = JSON.parse(readFileSync(TMP_CAPS, "utf8"));
  } catch {
    // file doesn't exist yet
  }
  existing[agentId] = resourceIds;
  writeFileSync(TMP_CAPS, JSON.stringify(existing, null, 2));
}

function setEntitlements(resourceId: string, scopeId: string, effect: "allow" | "deny"): void {
  const existing = entitlementService.listEntries(resourceId);
  // For test simplicity, just set a user-scope allow
  entitlementService.setEntitlements(adminCtx, resourceId, [
    { scopeType: "user", scopeId, effect },
  ]);
}

// ─── Test data constants ─────────────────────────────────────
const TEST_AGENT = "test-agent-001";
const TEST_AGENT_2 = "test-agent-002";
const APP_DEFAULT = "default-app";
const APP_RESTRICTED = "app-restricted";
const APP_DENY_ALL = "app-deny-all";
const RES_A = "resource-a";
const RES_B = "resource-b";
const RES_C = "resource-c";

// ─── Setup: create test applications ─────────────────────────
applicationService.createApplication({
  id: APP_RESTRICTED,
  name: "Restricted App",
  description: "Test app with allowlist",
});
applicationService.createApplication({
  id: APP_DENY_ALL,
  name: "Deny All App",
  description: "Test app with all capabilities disabled",
});

// ─── Test 1: No app rows → passthrough ───────────────────────
{
  setupAgent(TEST_AGENT, "user-1", APP_DEFAULT);
  setAgentCapabilities(TEST_AGENT, [RES_A, RES_B]);
  setEntitlements(RES_A, "user-1", "allow");
  setEntitlements(RES_B, "user-1", "allow");

  // default-app has no application_capabilities rows → null → passthrough
  const result = agentCapabilityService.resolveEnabledResourceIds(userCtx, TEST_AGENT);
  assert.equal(result.length, 2, "passthrough should return all enabled+entitled resources");
  assert.ok(result.includes(RES_A), "RES_A should be in passthrough result");
  assert.ok(result.includes(RES_B), "RES_B should be in passthrough result");

  // Also verify resolveAppAllowlist directly
  const allowlist = applicationCapabilitiesService.resolveAppAllowlist(APP_DEFAULT);
  assert.equal(allowlist, null, "default-app should have null allowlist (passthrough)");

  console.log("✓ Test 1: No app rows → passthrough");
}

// ─── Test 2: Enabled allowlist narrows ───────────────────────
{
  setupAgent(TEST_AGENT_2, "user-1", APP_RESTRICTED);
  setAgentCapabilities(TEST_AGENT_2, [RES_A, RES_B, RES_C]);
  setEntitlements(RES_A, "user-1", "allow");
  setEntitlements(RES_B, "user-1", "allow");
  setEntitlements(RES_C, "user-1", "allow");

  // Set app allowlist: only RES_A and RES_C enabled
  applicationCapabilitiesService.setAppCapabilities(APP_RESTRICTED, {
    resources: [
      { resourceId: RES_A, enabled: true },
      { resourceId: RES_B, enabled: false },
      { resourceId: RES_C, enabled: true },
    ],
  });

  const result = agentCapabilityService.resolveEnabledResourceIds(userCtx, TEST_AGENT_2);
  // RES_B is in activation + entitled but NOT in app allowlist (enabled=false) → excluded
  assert.equal(result.length, 2, "allowlist should narrow to 2 resources");
  assert.ok(result.includes(RES_A), "RES_A should pass (in allowlist)");
  assert.ok(result.includes(RES_C), "RES_C should pass (in allowlist)");
  assert.ok(!result.includes(RES_B), "RES_B should be excluded (allowlist disabled)");

  console.log("✓ Test 2: Enabled allowlist narrows the set");
}

// ─── Test 3: All rows disabled → deny all ────────────────────
{
  const agent3 = "test-agent-003";
  setupAgent(agent3, "user-1", APP_DENY_ALL);
  setAgentCapabilities(agent3, [RES_A, RES_B]);
  setEntitlements(RES_A, "user-1", "allow");
  setEntitlements(RES_B, "user-1", "allow");

  // Set all capabilities to disabled
  applicationCapabilitiesService.setAppCapabilities(APP_DENY_ALL, {
    resources: [
      { resourceId: RES_A, enabled: false },
      { resourceId: RES_B, enabled: false },
    ],
  });

  const allowlist = applicationCapabilitiesService.resolveAppAllowlist(APP_DENY_ALL);
  assert.ok(Array.isArray(allowlist), "deny-all app should return array (not null)");
  assert.equal(allowlist!.length, 0, "deny-all app should return empty array");

  const result = agentCapabilityService.resolveEnabledResourceIds(userCtx, agent3);
  assert.equal(result.length, 0, "all disabled → deny all → empty result");

  console.log("✓ Test 3: All rows disabled → deny all");
}

// ─── Test 4: Forged appId cannot broaden DB-owned app scope ──
{
  // TEST_AGENT_2 belongs to APP_RESTRICTED (allowlist: RES_A, RES_C only)
  // An attacker tries to pass appId=APP_DEFAULT (passthrough) to bypass the allowlist
  const dbAppId = applicationService.getAppIdForAgent(TEST_AGENT_2);
  assert.equal(dbAppId, APP_RESTRICTED, "DB should report APP_RESTRICTED");

  // Correct usage: pass DB-resolved appId to resolveEnabledResourceIdsForApp
  const correctResult = agentCapabilityService.resolveEnabledResourceIdsForApp(
    userCtx, TEST_AGENT_2, dbAppId
  );
  assert.equal(correctResult.length, 2, "correct appId → 2 resources (RES_A + RES_C, RES_B blocked by allowlist)");

  // Attack: pass forged appId=APP_DEFAULT (passthrough) to resolveEnabledResourceIdsForApp
  // RES_B is activated + entitled but blocked by APP_RESTRICTED's allowlist.
  // With forged passthrough appId, RES_B would come back (broadened!)
  const forgedResult = agentCapabilityService.resolveEnabledResourceIdsForApp(
    userCtx, TEST_AGENT_2, APP_DEFAULT
  );
  assert.equal(forgedResult.length, 3, "forged passthrough appId broadens to 3 — PROVES callers must use DB appId");
  assert.ok(forgedResult.includes(RES_B), "forged appId lets RES_B through — this is the attack vector");

  // This test PROVES that resolveEnabledResourceIdsForApp trusts the appId parameter.
  // The public resolveEnabledResourceIds (no appId param) resolves from DB internally,
  // making it impossible to forge. Callers who use resolveEnabledResourceIdsForApp
  // MUST resolve appId from applicationService.getAppIdForAgent(agentId), never from user input.

  // Verify the safe public API is not forgeable
  const safeResult = agentCapabilityService.resolveEnabledResourceIds(userCtx, TEST_AGENT_2);
  assert.equal(safeResult.length, 2, "public API (no appId param) → 2 resources — not forgeable");

  console.log("✓ Test 4: Forged appId broadens via ForApp — public API is safe (not forgeable)");
}

// ─── Test 5: App key sign/verify ─────────────────────────────
{
  const { key, prefix } = applicationService.generateAppKey(APP_RESTRICTED);
  assert.ok(key.startsWith("sap_"), "key should have sap_ prefix");
  assert.ok(prefix.length >= 12, "prefix should be at least 12 chars");

  // Valid key
  const verifiedAppId = applicationService.verifyAppKey(key);
  assert.equal(verifiedAppId, APP_RESTRICTED, "valid key should return appId");

  // Invalid key (wrong format)
  assert.equal(applicationService.verifyAppKey("invalid-key"), null, "invalid format → null");

  // Invalid key (wrong content, right prefix format)
  assert.equal(applicationService.verifyAppKey("sap_0000000000000000000000000deadbeef"), null, "wrong key → null");

  // Disabled app key
  applicationService.updateApplication(APP_RESTRICTED, { status: "disabled" });
  assert.equal(applicationService.verifyAppKey(key), null, "disabled app key → null");
  // Re-enable for subsequent tests
  applicationService.updateApplication(APP_RESTRICTED, { status: "active" });

  console.log("✓ Test 5: App key sign/verify (valid, invalid, disabled)");
}

// ─── Test 6: configVersion changes when app allowlist changes ─
{
  const agent4 = "test-agent-004";
  setupAgent(agent4, "user-1", APP_RESTRICTED);
  setAgentCapabilities(agent4, [RES_A, RES_B]);
  setEntitlements(RES_A, "user-1", "allow");
  setEntitlements(RES_B, "user-1", "allow");

  // configVersion with current allowlist (RES_A enabled, RES_B disabled)
  const v1 = computeConfigVersion(userCtx, agent4);

  // Change allowlist: enable RES_B too
  applicationCapabilitiesService.setAppCapabilities(APP_RESTRICTED, {
    resources: [
      { resourceId: RES_A, enabled: true },
      { resourceId: RES_B, enabled: true },
      { resourceId: RES_C, enabled: true },
    ],
  });

  const v2 = computeConfigVersion(userCtx, agent4);
  assert.notEqual(v1, v2, "configVersion must change when app allowlist changes");

  // Revert
  applicationCapabilitiesService.setAppCapabilities(APP_RESTRICTED, {
    resources: [
      { resourceId: RES_A, enabled: true },
      { resourceId: RES_B, enabled: false },
      { resourceId: RES_C, enabled: true },
    ],
  });
  const v3 = computeConfigVersion(userCtx, agent4);
  assert.equal(v1, v3, "configVersion should be deterministic — same state → same hash");

  console.log("✓ Test 6: configVersion changes on allowlist edit + deterministic");
}

// ─── Test 7: configVersion distinguishes null vs [] ───────────
{
  const agent5 = "test-agent-005";
  const agent6 = "test-agent-006";
  setupAgent(agent5, "user-1", APP_DEFAULT); // no rows → null (passthrough)
  setupAgent(agent6, "user-1", APP_DENY_ALL); // rows all disabled → [] (deny all)

  setAgentCapabilities(agent5, [RES_A]);
  setAgentCapabilities(agent6, [RES_A]);
  setEntitlements(RES_A, "user-1", "allow");

  const vPassthrough = computeConfigVersion(userCtx, agent5);
  const vDenyAll = computeConfigVersion(userCtx, agent6);

  assert.notEqual(
    vPassthrough, vDenyAll,
    "configVersion must distinguish passthrough (null) vs deny-all ([])"
  );

  console.log("✓ Test 7: configVersion distinguishes null (passthrough) vs [] (deny all)");
}

// ─── Test 8: getAppIdForAgent fallback ────────────────────────
{
  // Non-existent agent → fallback to 'default-app'
  const appId = applicationService.getAppIdForAgent("nonexistent-agent-999");
  assert.equal(appId, "default-app", "non-existent agent should fallback to default-app");

  console.log("✓ Test 8: getAppIdForAgent fallback to default-app");
}

// ─── Cleanup ─────────────────────────────────────────────────
rmSync(TMP_DB, { force: true });
rmSync(TMP_CAPS, { force: true });
rmSync(TMP_ENT, { force: true });

console.log("\n✅ All A0 adversarial tests passed (8/8)");
