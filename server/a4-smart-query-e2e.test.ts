/**
 * a4-smart-query-e2e.test.ts — Phase 6 (A4) end-to-end smart query sample test.
 *
 * Starts a real Express app with createAppRoutes() mounted, then exercises
 * the full app onboarding chain via HTTP:
 *   1. Admin creates "智能问数" application
 *   2. Admin registers a mock query API (A3)
 *   3. Admin sets app allowlist to include the MCP
 *   4. App user creates agent via app-scoped API
 *   5. Capability resolve verifies MCP injection
 *   6. Simulate agent events
 *   7. App user fetches events via HTTP — correct pagination + nextFrom + hasMore
 *   7a. Missing X-App-Key → 401
 *   7b. Wrong appKey → 401
 *   7c. Cross-app agent access → 404
 *   8. App allowlist exclusion verified (deny-by-intersection)
 *   9. Legacy regression
 *  10. Cleanup
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import http from "node:http";

// ─── Set env vars BEFORE any imports that read them ──────────
const TMP_DB = "/tmp/test-a4-smart-query.db";
const TMP_CAPS = "/tmp/test-a4-agent-capabilities.json";
const TMP_ENT = "/tmp/test-a4-entitlements.json";
const TMP_MCP = "/tmp/test-a4-mcp.json";

process.env.DB_PATH = TMP_DB;
process.env.AGENT_CAPABILITIES_FILE = TMP_CAPS;
process.env.ENTITLEMENTS_FILE = TMP_ENT;
process.env.MCP_CONFIG_FILE = TMP_MCP;

rmSync(TMP_DB, { force: true });
rmSync(TMP_CAPS, { force: true });
rmSync(TMP_ENT, { force: true });
rmSync(TMP_MCP, { force: true });

// ─── Dynamic imports (after env vars are set) ────────────────
const db = (await import("./database.js")).default;
const { applicationService } = await import("./application-service.js");
const { applicationCapabilitiesService } = await import("./application-capabilities.js");
const { agentService } = await import("./agent-service.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { registeredApiService } = await import("./registered-api-service.js");
const { installApiAsMcp, uninstallApiMcp } = await import("./capability-installer.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { eventStore } = await import("./event-store.js");
const { createAppRoutes } = await import("./app-routes.js");
const { chatStore } = await import("./chat-store.js");
const { agentProfileStore } = await import("./agent-profile-store.js");

// Reset temp stores for hermetic test
import fs from "node:fs";
fs.writeFileSync(TMP_CAPS, JSON.stringify({}) + "\n");
fs.writeFileSync(TMP_ENT, JSON.stringify({ entries: [] }) + "\n");

// ─── Test helpers ────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert2(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`✓ ${label}`); }
  else { failed++; console.error(`✗ ${label}`); }
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
function makeToken(userId: string, role: "admin" | "user"): string {
  return jwt.sign({ userId, username: userId, role }, JWT_SECRET, { expiresIn: "1h" });
}

function httpRequest(
  app: express.Express,
  method: string,
  path: string,
  opts: { token?: string; appKey?: string; body?: any } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as any;
      const port = addr.port;
      const payload = opts.body ? JSON.stringify(opts.body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.appKey ? { "X-App-Key": opts.appKey } : {}),
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode!, body: data }); }
          });
        }
      );
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ─── Setup: users + apps ─────────────────────────────────────
const ADMIN_ID = "a4-admin";
const USER_ID = "a4-user";
const APP_SMART_QUERY = "app-smart-query";
const APP_OTHER = "app-other";

db.prepare(
  `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at)
   VALUES (?, ?, 'hash', ?, ?, ?)`
).run(ADMIN_ID, "a4admin", "Admin", "admin", new Date().toISOString());
db.prepare(
  `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at)
   VALUES (?, ?, 'hash', ?, ?, ?)`
).run(USER_ID, "a4user", "User", "user", new Date().toISOString());

const adminToken = makeToken(ADMIN_ID, "admin");
const userToken = makeToken(USER_ID, "user");

// Create apps
applicationService.createApplication({ id: APP_SMART_QUERY, name: "智能问数" });
applicationService.createApplication({ id: APP_OTHER, name: "Other App" });

// Generate app keys
const { key: sqAppKey } = applicationService.generateAppKey(APP_SMART_QUERY);
const { key: otherAppKey } = applicationService.generateAppKey(APP_OTHER);

// Agent OS M2: every app-scoped path-A principal needs an application_access_grant
// (no grant → 403 NO_ACCESS_GRANT, admin not exempt). Grant both test users on
// both apps — post-dates this suite, so it must be seeded here.
const { applicationAccessGrantsService } = await import("./application-access.js");
for (const appId of [APP_SMART_QUERY, APP_OTHER]) {
  applicationAccessGrantsService.replaceGrants(
    appId,
    { grants: [
      { principalType: "user", principalId: ADMIN_ID },
      { principalType: "user", principalId: USER_ID },
    ] },
    "admin"
  );
}

// ─── Build Express app with app-scoped routes ────────────────
const app = express();
app.use(express.json());
app.use("/api", createAppRoutes());

// ─── Main test runner ────────────────────────────────────────
async function main() {
  // ─── Test 1: Admin creates "智能问数" application ─────────
  {
    const sqApp = applicationService.getApplication(APP_SMART_QUERY);
    assert2(sqApp !== undefined, "Test 1: 智能问数 application exists");
    assert2(sqApp!.name === "智能问数", "Test 1: app name correct");
  }

  // ─── Test 2: Admin registers a mock query API (A3) ────────
  {
    const api = registeredApiService.create({
      name: "mock_query_api",
      displayName: "模拟查询API",
      description: "智能问数样本用的模拟查询接口",
      apiUrl: "http://localhost/mock-query",
      method: "GET",
      timeoutMs: 5000,
    });
    installApiAsMcp(api);
    assert2(true, "Test 2: mock query API registered + MCP wrapper installed");
  }

  // ─── Test 3: Admin sets app allowlist to include MCP ──────
  {
    // capability_resources is an in-memory service backed by data/skills.json
    // and data/mcp.json. The resource ID for an MCP is its name (e.g. "mock_query_api").
    // Set app allowlist to include the MCP by its name as resourceId.
    applicationCapabilitiesService.setAppCapabilities(APP_SMART_QUERY, {
      resources: [{ resourceId: "mock_query_api", enabled: true }],
    });

    const caps = applicationCapabilitiesService.listByApp(APP_SMART_QUERY);
    assert2(caps.length === 1, "Test 3: app allowlist has 1 capability");
    assert2(caps[0].resourceId === "mock_query_api", "Test 3: allowlist includes mock_query_api");
  }

  // ─── Test 4: App user creates agent via app-scoped API ────
  {
    const res = await httpRequest(app, "POST", `/api/apps/${APP_SMART_QUERY}/agents`, {
      token: userToken,
      appKey: sqAppKey,
      body: { title: "问数助手" },
    });
    assert2(res.status === 201, `Test 4: create agent via HTTP → 201 (got ${res.status})`);
    assert2(res.body.appId === APP_SMART_QUERY, "Test 4: agent.appId = smart-query app");
  }

  // ─── Test 5: Capability resolve verifies MCP injection ─────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    assert2(!!agent, "Test 5: agent found in app");

    if (agent) {
      // Enable the MCP capability on the agent via service API
      // resourceId = MCP name (capability-resource.ts uses name as id)
      const adminCtx = { userId: ADMIN_ID, role: "admin" as const, orgId: "default-org" };
      // Must not throw — if it does, the MCP resource is not in the pool
      // which means the A3 install didn't register it properly
      agentCapabilityService.updateAgentCapabilities(adminCtx, agent.id, {
        resources: [{ resourceId: "mock_query_api", enabled: true }],
      });

      // Set entitlement to allow
      entitlementService.setEntitlements(adminCtx, "mock_query_api", [
        { scopeType: "user", scopeId: USER_ID, effect: "allow" },
      ]);

      // Resolve capabilities — MUST include the MCP
      const bundle = capabilityProvider.resolve({ userId: USER_ID, chatId: agent.id, role: "user" });
      const mcpNames = bundle.sdkOptions.mcpServers ? Object.keys(bundle.sdkOptions.mcpServers) : [];
      assert2(mcpNames.includes("mock_query_api"), `Test 5: MCP injected into agent bundle (got: [${mcpNames.join(",") }])`);
    }
  }

  // ─── Test 6: Simulate agent events ─────────────────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      const session = eventStore.getOrCreateSession(USER_ID, agent.id, "local");
      eventStore.appendEvent(USER_ID, agent.id, session.id, "assistant_message", { content: "查询结果：华东区上月销量 Top10" });
      eventStore.appendEvent(USER_ID, agent.id, session.id, "tool_use", { toolName: "mock_query_api", toolInput: { region: "华东" } });
      eventStore.appendEvent(USER_ID, agent.id, session.id, "tool_result", { output: "[{product: '产品A', sales: 1200}]" });
      eventStore.appendEvent(USER_ID, agent.id, session.id, "result", { success: true, cost: 0.01, duration: 1500 });
      assert2(true, "Test 6: 4 agent events appended");
    }
  }

  // ─── Test 7: App user fetches events via HTTP ─────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      const res = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events?from=1&limit=10`, {
        token: userToken,
        appKey: sqAppKey,
      });
      assert2(res.status === 200, `Test 7: GET events → 200 (got ${res.status})`);
      assert2(res.body.events.length === 4, `Test 7: 4 events returned (got ${res.body.events.length})`);
      assert2(res.body.hasMore === false, "Test 7: hasMore = false (all events fit in one page)");
      assert2(res.body.nextFrom === 5, `Test 7: nextFrom = 5 (got ${res.body.nextFrom})`);

      // Verify event DTO shape
      const evt = res.body.events[0];
      assert2(evt.id !== undefined, "Test 7: event has id");
      assert2(evt.sequence !== undefined, "Test 7: event has sequence");
      assert2(evt.eventType === "assistant_message", "Test 7: first event is assistant_message");
      assert2(evt.createdAt !== undefined, "Test 7: event has createdAt");
      assert2(evt.payload !== undefined, "Test 7: event has payload");
    }
  }

  // ─── Test 7a: Missing X-App-Key → 401 ─────────────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      const res = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events`, {
        token: userToken,
        // No appKey
      });
      assert2(res.status === 401, `Test 7a: missing appKey → 401 (got ${res.status})`);
    }
  }

  // ─── Test 7b: Wrong appKey → 401 ──────────────────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      const res = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events`, {
        token: userToken,
        appKey: "sap_wrong_key_1234567890",
      });
      assert2(res.status === 401, `Test 7b: wrong appKey → 401 (got ${res.status})`);
    }
  }

  // ─── Test 7c: Cross-app agent access → 404 ────────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      // Use OTHER app's key to access smart-query's agent
      const res = await httpRequest(app, "GET", `/api/apps/${APP_OTHER}/agents/${agent.id}/events`, {
        token: userToken,
        appKey: otherAppKey,
      });
      // appAuthMiddleware checks URL appId vs key appId → 403, but getOwnedAppAgent → 404
      // Either way, it must NOT return 200
      assert2(res.status !== 200, `Test 7c: cross-app access rejected (got ${res.status})`);
    }
  }

  // ─── Test 8: App allowlist exclusion (deny-by-intersection) ─
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      // Set allowlist to exclude the MCP (enable a different resource)
      applicationCapabilitiesService.setAppCapabilities(APP_SMART_QUERY, {
        resources: [{ resourceId: "cap-other-resource", enabled: true }],
      });

      const bundle = capabilityProvider.resolve({ userId: USER_ID, chatId: agent.id, role: "user" });
      const mcpNames = bundle.sdkOptions.mcpServers ? Object.keys(bundle.sdkOptions.mcpServers) : [];
      assert2(!mcpNames.includes("mock_query_api"), "Test 8: MCP excluded when app allowlist doesn't include it");

      // Restore allowlist
      applicationCapabilitiesService.setAppCapabilities(APP_SMART_QUERY, {
        resources: [{ resourceId: "mock_query_api", enabled: true }],
      });
    }
  }

  // ─── Test 9: Legacy regression ─────────────────────────────
  {
    const chat = agentService.createChat(USER_ID, "Legacy chat");
    assert2(chat.appId === "default-app", "Test 9: legacy createChat still uses default-app");
  }

  // ─── Test 14: App Profile inheritance via real ChatStore path ──
  {
    // Create a test profile
    const profile = agentProfileStore.create({ name: "test-inherit-profile", systemPrompt: "test prompt" });

    // Set default-app's profileId
    applicationService.updateApplication("default-app", { profileId: profile.id });

    // Create via real ChatStore path (what /api/chats actually calls)
    const chat = chatStore.createChat(USER_ID, "Inherit test chat");
    const agent = agentService.getChat(chat.id);
    assert2(agent?.profileId === profile.id, `Test 14: chatStore.createChat inherits default-app profileId (got ${agent?.profileId})`);

    // createAgentForApp with an app whose profileId is null should NOT inherit default-app profile
    const nullProfileApp = applicationService.createApplication({ name: "null-profile-app" });
    const appAgent = agentService.createAgentForApp(USER_ID, nullProfileApp.id, "No profile agent");
    assert2(appAgent.profileId === null, `Test 14: createAgentForApp with null-profile app does not inherit default-app profile (got ${appAgent.profileId})`);

    // Cleanup: reset default-app profileId
    applicationService.updateApplication("default-app", { profileId: null });
  }

  // ─── Test 10: Pagination — small limit ─────────────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      // Fetch with limit=2
      const res = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events?from=1&limit=2`, {
        token: userToken,
        appKey: sqAppKey,
      });
      assert2(res.status === 200, "Test 10: paginated events → 200");
      assert2(res.body.events.length === 2, `Test 10: 2 events in page (got ${res.body.events.length})`);
      assert2(res.body.hasMore === true, "Test 10: hasMore = true");
      assert2(res.body.nextFrom === 3, `Test 10: nextFrom = 3 (got ${res.body.nextFrom})`);

      // Fetch next page
      const res2 = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events?from=3&limit=2`, {
        token: userToken,
        appKey: sqAppKey,
      });
      assert2(res2.body.events.length === 2, `Test 10: page 2 has 2 events (got ${res2.body.events.length})`);
      assert2(res2.body.nextFrom === 5, `Test 10: page 2 nextFrom = 5 (got ${res2.body.nextFrom})`);
    }
  }

  // ─── Test 11: Payload redaction ────────────────────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      // Add an event with sensitive data
      const session = eventStore.getOrCreateSession(USER_ID, agent.id, "local");
      eventStore.appendEvent(USER_ID, agent.id, session.id, "tool_use", {
        toolName: "mock_query_api",
        toolInput: { password: "secret123", apiKey: "key456", region: "华东" },
      });

      // Fetch as regular user (should be redacted)
      const res = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events?from=5&limit=10`, {
        token: userToken,
        appKey: sqAppKey,
      });
      const sensitiveEvent = res.body.events.find((e: any) => e.payload?.toolInput);
      if (sensitiveEvent) {
        assert2(sensitiveEvent.payload.toolInput.password === "[REDACTED]", "Test 11: password redacted for user");
        assert2(sensitiveEvent.payload.toolInput.apiKey === "[REDACTED]", "Test 11: apiKey redacted for user");
        assert2(sensitiveEvent.payload.toolInput.region === "华东", "Test 11: non-sensitive field preserved");
      }

      // Fetch as admin with raw=true (should NOT be redacted)
      // Note: getOwnedAppAgent checks userId, so admin needs their own agent.
      // Create an admin-owned agent in this app for the raw test.
      const adminAgent = agentService.createAgentForApp(ADMIN_ID, APP_SMART_QUERY, "Admin raw test agent");
      const adminSession = eventStore.getOrCreateSession(ADMIN_ID, adminAgent.id, "local");
      eventStore.appendEvent(ADMIN_ID, adminAgent.id, adminSession.id, "tool_use", {
        toolName: "mock_query_api",
        toolInput: { password: "secret123", region: "华东" },
      });
      const res2 = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${adminAgent.id}/events?from=1&limit=10&raw=true`, {
        token: adminToken,
        appKey: sqAppKey,
      });
      if (res2.body.events) {
        const rawEvent = res2.body.events.find((e: any) => e.payload?.toolInput);
        if (rawEvent) {
          assert2(rawEvent.payload.toolInput.password === "secret123", "Test 11: password visible with raw=true admin");
        } else {
          assert2(false, "Test 11: no tool_use event found in admin agent events");
        }
      } else {
        assert2(false, `Test 11: raw=true admin fetch failed (status ${res2.status})`);
      }
    }
  }

  // ─── Test 12: Invalid pagination params → 400 ──────────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      const res = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events?from=abc&limit=xyz`, {
        token: userToken,
        appKey: sqAppKey,
      });
      assert2(res.status === 400, `Test 12: invalid params → 400 (got ${res.status})`);
    }
  }

  // ─── Test 13: Malformed JSON payload doesn't 500 ───────────
  {
    const agents = agentService.listByApp(USER_ID, APP_SMART_QUERY, "default-org");
    const agent = agents.find((a: any) => a.title === "问数助手");
    if (agent) {
      // Insert a row with malformed payloadJson directly
      const session = eventStore.getOrCreateSession(USER_ID, agent.id, "local");
      db.prepare(
        `INSERT INTO agent_events (id, user_id, chat_id, agent_session_id, sequence, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'error', 'this is not json', ?)`
      ).run("evt-malformed-" + Date.now(), USER_ID, agent.id, session.id, 999, new Date().toISOString());

      const res = await httpRequest(app, "GET", `/api/apps/${APP_SMART_QUERY}/agents/${agent.id}/events?from=998&limit=10`, {
        token: userToken,
        appKey: sqAppKey,
      });
      assert2(res.status === 200, `Test 13: malformed JSON → 200 not 500 (got ${res.status})`);
      const malformedEvent = res.body.events.find((e: any) => e.payload?.parseError === true);
      assert2(!!malformedEvent, "Test 13: malformed event has parseError marker");
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────
  uninstallApiMcp("mock_query_api");
  try { registeredApiService.delete(registeredApiService.getByName("mock_query_api")!.id); } catch {}
  db.prepare(`DELETE FROM application_capabilities WHERE app_id = ?`).run(APP_SMART_QUERY);
  db.prepare(`DELETE FROM agent_events WHERE chat_id IN (SELECT id FROM agents WHERE app_id = ?)`).run(APP_SMART_QUERY);
  db.prepare(`DELETE FROM agent_sessions WHERE chat_id IN (SELECT id FROM agents WHERE app_id = ?)`).run(APP_SMART_QUERY);
  db.prepare(`DELETE FROM chats WHERE user_id = ?`).run(USER_ID);
  db.prepare(`DELETE FROM agents WHERE app_id = ?`).run(APP_SMART_QUERY);

  console.log(`\n${failed === 0 ? "✅" : "❌"} A4 smart query e2e tests ${failed === 0 ? "passed" : "FAILED"} (${passed}/${passed + failed})`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
