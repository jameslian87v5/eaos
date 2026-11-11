/**
 * a1-app-routes.test.ts — Phase 6 (A1) adversarial unit tests.
 *
 * Tests the app-scoped agent lifecycle and dual-identity auth semantics:
 *   1. createAgentForApp sets app_id atomically (not default-app)
 *   2. listByApp filters by owner AND app (DB-backed)
 *   3. getOwnedAppAgent rejects cross-app and cross-user access
 *   4. App key sign/verify + disabled app rejection
 *   5. appAllowlisted field in listAgentCapabilities (passthrough vs restricted)
 *   6. generateAppKey throws for non-existent app
 *   7. setAppCapabilities atomicity (transaction)
 *   8. Legacy regression: createChat still uses default-app
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { RequestContext } from "./request-context.js";

// ─── Set env vars BEFORE any imports that read them ──────────
const TMP_DB = "/tmp/test-a1-app-routes.db";
const TMP_CAPS = "/tmp/test-a1-agent-capabilities.json";
const TMP_ENT = "/tmp/test-a1-entitlements.json";

process.env.DB_PATH = TMP_DB;
process.env.AGENT_CAPABILITIES_FILE = TMP_CAPS;
process.env.ENTITLEMENTS_FILE = TMP_ENT;

rmSync(TMP_DB, { force: true });
rmSync(TMP_CAPS, { force: true });
rmSync(TMP_ENT, { force: true });

// ─── Dynamic imports (after env vars are set) ────────────────
const db = (await import("./database.js")).default;
const { applicationService } = await import("./application-service.js");
const { applicationCapabilitiesService } = await import("./application-capabilities.js");
const { agentService } = await import("./agent-service.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");

// ─── Test helpers ────────────────────────────────────────────

const adminCtx: RequestContext = { userId: "admin-1", role: "admin", orgId: "default-org" };
const userCtx: RequestContext = { userId: "user-1", role: "user", orgId: "default-org" };
const user2Ctx: RequestContext = { userId: "user-2", role: "user", orgId: "default-org" };

const APP_A = "app-a-test";
const APP_B = "app-b-test";

// ─── Setup: create test apps ─────────────────────────────────
{
  // Ensure users exist (for FK if any)
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at)
     VALUES (?, ?, 'hash', ?, ?, ?)`
  ).run("admin-1", "admin1", "Admin", "admin", new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at)
     VALUES (?, ?, 'hash', ?, ?, ?)`
  ).run("user-1", "user1", "User1", "user", new Date().toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at)
     VALUES (?, ?, 'hash', ?, ?, ?)`
  ).run("user-2", "user2", "User2", "user", new Date().toISOString());

  applicationService.createApplication({ id: APP_A, name: "App A" });
  applicationService.createApplication({ id: APP_B, name: "App B" });

  console.log("Setup: test apps created");
}

// ─── Test 1: createAgentForApp sets app_id atomically ────────
{
  const agent = agentService.createAgentForApp("user-1", APP_A, "Agent in App A");
  assert.equal(agent.appId, APP_A, "createAgentForApp must set appId to APP_A, not default-app");
  assert.notEqual(agent.appId, "default-app", "must NOT be default-app for app-scoped creation");

  // Verify in DB directly
  const row = db.prepare(`SELECT app_id FROM agents WHERE id = ?`).get(agent.id) as { app_id: string };
  assert.equal(row.app_id, APP_A, "DB must have app_id = APP_A");

  console.log("✓ Test 1: createAgentForApp sets app_id atomically (not default-app)");
}

// ─── Test 2: listByApp filters by owner AND app ──────────────
{
  // Create agents in different apps
  const agentA1 = agentService.createAgentForApp("user-1", APP_A, "A1");
  const agentA2 = agentService.createAgentForApp("user-1", APP_A, "A2");
  const agentB1 = agentService.createAgentForApp("user-1", APP_B, "B1");

  // List user-1's agents in APP_A
  const appAAgents = agentService.listByApp("user-1", APP_A, "default-org");
  assert.ok(appAAgents.length >= 3, "should have at least 3 agents in APP_A (1 from test 1 + 2 here)");
  assert.ok(appAAgents.every(a => a.appId === APP_A), "all listed agents must be in APP_A");

  // List user-1's agents in APP_B
  const appBAgents = agentService.listByApp("user-1", APP_B, "default-org");
  assert.equal(appBAgents.length, 1, "should have 1 agent in APP_B");
  assert.equal(appBAgents[0].id, agentB1.id, "should be B1");

  // user-2 should see no agents in APP_A
  const user2Agents = agentService.listByApp("user-2", APP_A, "default-org");
  assert.equal(user2Agents.length, 0, "user-2 should have no agents in APP_A");

  console.log("✓ Test 2: listByApp filters by owner AND app (DB-backed)");
}

// ─── Test 3: getOwnedAppAgent rejects cross-app/cross-user ───
{
  const agent = agentService.createAgentForApp("user-1", APP_A, "Cross-test");

  // Correct: owner + app
  const ok = agentService.getOwnedAppAgent(agent.id, "user-1", APP_A, "default-org");
  assert.ok(ok, "owner + correct app → found");
  assert.equal(ok!.appId, APP_A, "appId must be APP_A");

  // Cross-app: agent in APP_A, query with APP_B
  const crossApp = agentService.getOwnedAppAgent(agent.id, "user-1", APP_B, "default-org");
  assert.equal(crossApp, undefined, "cross-app access → rejected");

  // Cross-user: agent owned by user-1, query as user-2
  const crossUser = agentService.getOwnedAppAgent(agent.id, "user-2", APP_A, "default-org");
  assert.equal(crossUser, undefined, "cross-user access → rejected");

  // Both wrong
  const bothWrong = agentService.getOwnedAppAgent(agent.id, "user-2", APP_B, "default-org");
  assert.equal(bothWrong, undefined, "cross-user + cross-app → rejected");

  console.log("✓ Test 3: getOwnedAppAgent rejects cross-app and cross-user access");
}

// ─── Test 4: App key sign/verify + disabled app ──────────────
{
  const { key, prefix } = applicationService.generateAppKey(APP_A);
  assert.ok(key.startsWith("sap_"), "key must have sap_ prefix");

  // Valid key
  const verified = applicationService.verifyAppKey(key);
  assert.equal(verified, APP_A, "valid key → returns APP_A");

  // Invalid key
  const invalid = applicationService.verifyAppKey("sap_invalid_key_1234567890");
  assert.equal(invalid, null, "invalid key → null");

  // Wrong format
  const wrongFmt = applicationService.verifyAppKey("not-a-sap-key");
  assert.equal(wrongFmt, null, "wrong format → null");

  // Disabled app
  applicationService.updateApplication(APP_B, { status: "disabled" });
  const { key: keyB } = applicationService.generateAppKey(APP_B);
  // Re-enable to generate key, then disable again
  applicationService.updateApplication(APP_B, { status: "active" });
  const { key: keyB2 } = applicationService.generateAppKey(APP_B);
  applicationService.updateApplication(APP_B, { status: "disabled" });
  const disabledResult = applicationService.verifyAppKey(keyB2);
  assert.equal(disabledResult, null, "disabled app key → null");

  console.log("✓ Test 4: App key sign/verify + disabled app rejection");
}

// ─── Test 5: generateAppKey throws for non-existent app ───────
{
  assert.throws(
    () => applicationService.generateAppKey("non-existent-app"),
    /not found/i,
    "generateAppKey must throw for non-existent app"
  );

  console.log("✓ Test 5: generateAppKey throws for non-existent app (Codex fix 1)");
}

// ─── Test 6: appAllowlisted in listAgentCapabilities ──────────
{
  const agent = agentService.createAgentForApp("user-1", APP_A, "Allowlist test");

  // APP_A has no capability rows → passthrough → all appAllowlisted = true
  const views1 = agentCapabilityService.listAgentCapabilities(adminCtx, agent.id);
  assert.ok(views1.length > 0, "should have capability views");
  assert.ok(views1.every(v => v.appAllowlisted === true), "passthrough → all appAllowlisted = true");

  // Set APP_A allowlist to deny-all: one disabled row creates a row (so
  // resolveAppAllowlist returns [] not null), but no enabled resources.
  applicationCapabilitiesService.setAppCapabilities(APP_A, {
    resources: [{ resourceId: "res-nonexistent", enabled: false }],
  });
  const views2 = agentCapabilityService.listAgentCapabilities(adminCtx, agent.id);
  // With deny-all (row exists but no enabled resources), appAllowlisted = false
  assert.ok(views2.every(v => v.appAllowlisted === false), "deny-all → all appAllowlisted = false");

  // Clean up: remove all capability rows for APP_A → back to passthrough
  db.prepare(`DELETE FROM application_capabilities WHERE app_id = ?`).run(APP_A);

  console.log("✓ Test 6: appAllowlisted field reflects app allowlist state");
}

// ─── Test 7: Legacy regression — createChat uses default-app ─
{
  const chat = agentService.createChat("user-1", "Legacy chat");
  assert.equal(chat.appId, "default-app", "legacy createChat must still use default-app");

  // listByApp with default-app should include legacy agents
  const defaultAgents = agentService.listByApp("user-1", "default-app", "default-org");
  assert.ok(defaultAgents.some(a => a.id === chat.id), "legacy agent should appear in default-app list");

  console.log("✓ Test 7: Legacy createChat still uses default-app (no regression)");
}

// ─── Test 8: setAppCapabilities atomicity ─────────────────────
{
  // Set some capabilities, verify they're all present
  applicationCapabilitiesService.setAppCapabilities(APP_A, {
    resources: [
      { resourceId: "res-x", enabled: true },
      { resourceId: "res-y", enabled: true },
      { resourceId: "res-z", enabled: false },
    ],
  });
  const caps = applicationCapabilitiesService.listByApp(APP_A);
  assert.equal(caps.length, 3, "should have 3 capability rows");

  // Replace with different set
  applicationCapabilitiesService.setAppCapabilities(APP_A, {
    resources: [
      { resourceId: "res-x", enabled: true },
    ],
  });
  const caps2 = applicationCapabilitiesService.listByApp(APP_A);
  assert.equal(caps2.length, 1, "replace should leave only 1 row");
  assert.equal(caps2[0].resourceId, "res-x", "should be res-x");

  // Clean up
  db.prepare(`DELETE FROM application_capabilities WHERE app_id = ?`).run(APP_A);

  console.log("✓ Test 8: setAppCapabilities atomicity (delete-then-insert in transaction)");
}

console.log("\n✅ All A1 adversarial tests passed (8/8)");
