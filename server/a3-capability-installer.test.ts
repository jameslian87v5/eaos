/**
 * A3 Capability Installer Tests — Phase 6 (A3)
 *
 * Covers Codex A3 review acceptance criteria:
 *   #1: Full capability chain — install → resource pool → resolve() injects MCP
 *   #2: Idempotent mcp.json updates (write-temp-and-rename)
 *   #4: JSON embedding (no string-interpolated JS from admin input)
 *   #5: Real wrapper protocol test — spawn run.sh, JSON-RPC, verify responses
 *
 * Also covers:
 *   - Wrapper file generation (server.cjs, run.sh, mcp.json)
 *   - Path containment (no traversal)
 *   - URL validation
 *   - CRUD lifecycle
 *   - Uninstall removes package + mcp.json entry
 */

import { rmSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

// ─── Set env vars BEFORE any imports that read them ──────────
const TEST_DB = "/tmp/test-a3-capability-installer.db";
const TEST_MCP_CONFIG = "/tmp/test-a3-mcp.json";
process.env.DB_PATH = TEST_DB;
process.env.MCP_CONFIG_FILE = TEST_MCP_CONFIG;

rmSync(TEST_DB, { force: true });
rmSync(TEST_MCP_CONFIG, { force: true });

// ─── Dynamic imports (after env vars are set) ────────────────
const { registeredApiService } = await import("./registered-api-service.js");
const { installApiAsMcp, uninstallApiMcp } = await import("./capability-installer.js");
const { getAllMcpServers, getEnabledMcpServers } = await import("./mcp-config.js");
const { capabilityResourceService } = await import("./capability-resource.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { applicationService } = await import("./application-service.js");
const { applicationCapabilitiesService } = await import("./application-capabilities.js");
const { agentService } = await import("./agent-service.js");
import type { RequestContext } from "./request-context.js";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else {
    failed++;
    console.error(`✗ ${msg}`);
  }
}

// Helper: send JSON-RPC to a spawned run.sh and collect responses
function rpcCall(runShPath: string, messages: object[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [runShPath], { cwd: path.dirname(runShPath) });
    const responses: string[] = [];
    let stderr = "";

    child.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc) responses.push(line);
        } catch { /* ignore non-JSON */ }
      }
    });

    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("close", () => {
      if (stderr) console.log(`  [wrapper stderr] ${stderr.trim()}`);
      resolve(responses);
    });

    child.on("error", reject);

    // Send all messages
    for (const msg of messages) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    }
    child.stdin.end();
  });
}

async function main() {
  const MCP_ROOT = path.resolve(process.cwd(), "mcp");
  const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: "default-org" };
  const user: RequestContext = { userId: "u1", role: "user", orgId: "default-org" };

  // ─── Test 1: Wrapper file generation ──────────────────────
  {
    const api = registeredApiService.create({
      name: "test_get_customer",
      displayName: "查询客户",
      description: "查询客户是否存在该产品线",
      apiUrl: "http://localhost:19876/ds/GET_CUSTOMER/1",
      method: "GET",
      timeoutMs: 5000,
    });

    const result = installApiAsMcp(api);
    const pkgDir = result.mcpPackagePath;

    assert(existsSync(path.join(pkgDir, "server.cjs")), "Test 1: server.cjs generated");
    assert(existsSync(path.join(pkgDir, "run.sh")), "Test 1: run.sh generated");
    assert(existsSync(path.join(pkgDir, "mcp.json")), "Test 1: mcp.json generated");

    // run.sh must be executable
    const runSh = readFileSync(path.join(pkgDir, "run.sh"), "utf8");
    assert(runSh.includes("node"), "Test 1: run.sh invokes node");

    // mcp.json must have correct metadata
    const manifest = JSON.parse(readFileSync(path.join(pkgDir, "mcp.json"), "utf8"));
    assert(manifest.name === "test_get_customer", "Test 1: mcp.json name correct");
    assert(manifest.version === "1.0.0", "Test 1: mcp.json version correct");

    // server.cjs must embed config as JSON (not string-interpolated JS)
    const serverCjs = readFileSync(path.join(pkgDir, "server.cjs"), "utf8");
    assert(serverCjs.includes('"toolName": "test_get_customer"'), "Test 1: config embedded as JSON");
    assert(serverCjs.includes("http://localhost:19876/ds/GET_CUSTOMER/1"), "Test 1: apiUrl in config");
    assert(serverCjs.includes('"method": "GET"'), "Test 1: method in config");
    assert(!serverCjs.includes("eval("), "Test 1: no eval() in wrapper (security)");
    assert(!serverCjs.includes("Function("), "Test 1: no Function() in wrapper (security)");
  }

  // ─── Test 2: data/mcp.json updated correctly ──────────────
  {
    const mcpConfig = JSON.parse(readFileSync(TEST_MCP_CONFIG, "utf8"));
    const entry = mcpConfig.find((c: any) => c.name === "test_get_customer");
    assert(entry !== undefined, "Test 2: mcp.json has test_get_customer entry");
    assert(entry.type === "local", "Test 2: entry type is local");
    assert(entry.enabled === true, "Test 2: entry enabled");
    assert(entry.path === "mcp/test_get_customer", "Test 2: entry path correct");
  }

  // ─── Test 3: mcp-config.ts resolves the generated package ──
  {
    const all = getAllMcpServers();
    const found = all.find((m) => m.name === "test_get_customer");
    assert(found !== undefined, "Test 3: mcp-config resolves generated package");
    assert(found!.valid === true, "Test 3: generated package is valid");
    assert(found!.command === "/opt/agent/mcp/test_get_customer/run.sh", "Test 3: command is backend-generated");
    assert(found!.containerPath === "/opt/agent/mcp/test_get_customer", "Test 3: containerPath correct");
  }

  // ─── Test 4: Full capability chain (Codex requirement #1) ─
  {
    // 4a: Appears in resource pool as type "mcp"
    const pool = capabilityResourceService.listResources(admin);
    const resource = pool.find((r) => r.resourceId === "test_get_customer");
    assert(resource !== undefined, "Test 4a: resource pool has test_get_customer");
    assert(resource!.type === "mcp", "Test 4a: resource type is mcp");
    assert(resource!.valid === true, "Test 4a: resource is valid");

    // 4b: Entitle + activate → resolve() injects MCP
    entitlementService.setEntitlements(admin, "test_get_customer", [
      { scopeType: "user", scopeId: user.userId, effect: "allow" },
    ]);
    agentCapabilityService.updateAgentCapabilities(user, "agent-a3-test", {
      resources: [{ resourceId: "test_get_customer", enabled: true }],
    });

    const bundle = capabilityProvider.resolve({
      userId: user.userId,
      chatId: "agent-a3-test",
      role: "user",
      runtimeType: "docker",
    });
    const injected = bundle.sdkOptions.mcpServers as Record<string, { command: string }>;
    assert(injected["test_get_customer"] !== undefined, "Test 4b: resolve() injects test_get_customer MCP");
    assert(
      injected["test_get_customer"].command === "/opt/agent/mcp/test_get_customer/run.sh",
      "Test 4b: injected command is backend-generated"
    );
    assert(bundle.sdkOptions.strictMcpConfig === true, "Test 4b: strictMcpConfig is true");
    const mount = bundle.mounts.find((m) => m.containerPath === "/opt/agent/mcp/test_get_customer");
    assert(mount !== undefined, "Test 4b: MCP package readonly-mounted");
    assert(mount!.readonly === true, "Test 4b: mount is readonly");
  }

  // ─── Test 5: Real wrapper protocol test (Codex requirement #5)
  {
    const runShPath = path.join(MCP_ROOT, "test_get_customer", "run.sh");
    assert(existsSync(runShPath), "Test 5: run.sh exists for protocol test");

    // Send initialize + tools/list
    const responses = await rpcCall(runShPath, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    assert(responses.length >= 2, "Test 5: got 2 JSON-RPC responses");

    // Parse initialize response
    const initResp = JSON.parse(responses[0]);
    assert(initResp.result?.protocolVersion === "2024-11-05", "Test 5: initialize returns protocol version");
    assert(initResp.result?.serverInfo?.name === "test_get_customer", "Test 5: serverInfo name correct");

    // Parse tools/list response
    const listResp = JSON.parse(responses[1]);
    const tools = listResp.result?.tools;
    assert(tools?.length === 1, "Test 5: tools/list returns 1 tool");
    assert(tools?.[0]?.name === "test_get_customer", "Test 5: tool name correct");
    assert(tools?.[0]?.description === "查询客户", "Test 5: tool description from displayName");
    assert(tools?.[0]?.inputSchema?.type === "object", "Test 5: inputSchema is object type");
  }

  // ─── Test 6: POST method wrapper ──────────────────────────
  {
    const api = registeredApiService.create({
      name: "test_post_order",
      displayName: "创建订单",
      apiUrl: "http://localhost:19876/ds/CREATE_ORDER/1",
      method: "POST",
      requestParamsSchema: {
        type: "object",
        properties: {
          customer_id: { type: "string", description: "客户ID" },
          product: { type: "string", description: "产品名称" },
        },
        required: ["customer_id"],
      },
      timeoutMs: 10000,
    });
    installApiAsMcp(api);

    const pkgDir = path.join(MCP_ROOT, "test_post_order");
    const serverCjs = readFileSync(path.join(pkgDir, "server.cjs"), "utf8");
    assert(serverCjs.includes('"method": "POST"'), "Test 6: POST method in config");
    assert(serverCjs.includes("customer_id"), "Test 6: param schema embedded");

    // Protocol test
    const responses = await rpcCall(path.join(pkgDir, "run.sh"), [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    ]);
    const listResp = JSON.parse(responses[0]);
    const tool = listResp.result?.tools?.[0];
    assert(tool?.inputSchema?.properties?.customer_id?.type === "string", "Test 6: POST wrapper exposes param schema");
  }

  // ─── Test 7: Idempotent install (call twice) ──────────────
  {
    const api = registeredApiService.getByName("test_get_customer")!;
    installApiAsMcp(api);
    installApiAsMcp(api);

    // mcp.json should still have exactly one entry
    const config = JSON.parse(readFileSync(TEST_MCP_CONFIG, "utf8"));
    const entries = config.filter((c: any) => c.name === "test_get_customer");
    assert(entries.length === 1, "Test 7: idempotent install — single mcp.json entry");

    // Package still valid
    const servers = getEnabledMcpServers();
    const found = servers.find((s) => s.name === "test_get_customer");
    assert(found !== undefined && found.valid, "Test 7: package still valid after re-install");
  }

  // ─── Test 8: URL validation ───────────────────────────────
  {
    try {
      registeredApiService.create({
        name: "bad_api",
        apiUrl: "file:///etc/passwd",
      });
      assert(false, "Test 8: file:// URL should be rejected");
    } catch (err: any) {
      assert(err.message.includes("http"), "Test 8: file:// URL rejected");
    }

    try {
      registeredApiService.create({
        name: "bad_api2",
        apiUrl: "not-a-url",
      });
      assert(false, "Test 8: invalid URL should be rejected");
    } catch (err: any) {
      assert(err.message.includes("valid"), "Test 8: invalid URL rejected");
    }
  }

  // ─── Test 9: Name validation (path traversal prevention) ──
  {
    try {
      registeredApiService.create({
        name: "../etc/passwd",
        apiUrl: "http://localhost/test",
      });
      assert(false, "Test 9: path traversal name should be rejected");
    } catch (err: any) {
      assert(err.message.includes("Invalid API name"), "Test 9: path traversal name rejected");
    }
  }

  // ─── Test 10: Uninstall removes package + mcp.json entry ──
  {
    const api = registeredApiService.getByName("test_post_order")!;
    uninstallApiMcp(api.name);

    assert(!existsSync(path.join(MCP_ROOT, "test_post_order")), "Test 10: package directory removed");

    const config = JSON.parse(readFileSync(TEST_MCP_CONFIG, "utf8"));
    assert(!config.some((c: any) => c.name === "test_post_order"), "Test 10: mcp.json entry removed");
  }

  // ─── Test 11: Disabled API → mcp.json enabled=false ───────
  {
    const api = registeredApiService.getByName("test_get_customer")!;
    const updated = registeredApiService.update(api.id, { status: "disabled" });
    assert(updated!.status === "disabled", "Test 11: API status updated to disabled");

    installApiAsMcp(updated!);
    const config = JSON.parse(readFileSync(TEST_MCP_CONFIG, "utf8"));
    const entry = config.find((c: any) => c.name === "test_get_customer");
    assert(entry?.enabled === false, "Test 11: disabled API → mcp.json enabled=false");

    const enabled = getEnabledMcpServers().filter((s) => s.name === "test_get_customer");
    assert(enabled.length === 0, "Test 11: disabled API not in getEnabledMcpServers");
  }

  // ─── Test 12: App allowlist inclusion (Codex requirement #2) ─
  {
    // Re-enable the API first
    const api = registeredApiService.getByName("test_get_customer")!;
    const enabled = registeredApiService.update(api.id, { status: "active" });
    installApiAsMcp(enabled!);

    // Create a real app + agent scoped to it
    const app = applicationService.createApplication({
      name: "a3-allowlist-test-app",
      description: "A3 Allowlist Test",
    });
    const agent = agentService.createAgentForApp(user.userId, app.id, "a3-allowlist-agent");

    // Set app capability allowlist to INCLUDE the MCP
    applicationCapabilitiesService.setAppCapabilities(app.id, {
      resources: [{ resourceId: "test_get_customer", enabled: true }],
    });

    // Entitle + activate for this agent
    entitlementService.setEntitlements(admin, "test_get_customer", [
      { scopeType: "user", scopeId: user.userId, effect: "allow" },
    ]);
    agentCapabilityService.updateAgentCapabilities(user, agent.id, {
      resources: [{ resourceId: "test_get_customer", enabled: true }],
    });

    // resolve() should inject the MCP (app allowlist ∩ entitlement ∩ activation)
    const bundle = capabilityProvider.resolve({
      userId: user.userId,
      chatId: agent.id,
      role: "user",
      runtimeType: "docker",
    });
    const injected = bundle.sdkOptions.mcpServers as Record<string, unknown>;
    assert(injected["test_get_customer"] !== undefined, "Test 12: app allowlist includes MCP → resolve injects");

    // ─── Test 13: App allowlist exclusion ───────────────────
    // Set allowlist to a DIFFERENT resource (not empty — empty = passthrough)
    applicationCapabilitiesService.setAppCapabilities(app.id, {
      resources: [{ resourceId: "some-other-resource", enabled: true }],
    });
    const bundle2 = capabilityProvider.resolve({
      userId: user.userId,
      chatId: agent.id,
      role: "user",
      runtimeType: "docker",
    });
    const injected2 = bundle2.sdkOptions.mcpServers as Record<string, unknown>;
    assert(injected2["test_get_customer"] === undefined, "Test 13: app allowlist excludes MCP → resolve drops");

    // Cleanup app + agent
    try { agentService.deleteChat(agent.id); } catch {}
  }

  // ─── Test 14: Schema validation ───────────────────────────
  {
    try {
      registeredApiService.create({
        name: "bad_schema_api",
        apiUrl: "http://localhost/test",
        requestParamsSchema: "not-an-object" as any,
      });
      assert(false, "Test 14: string schema should be rejected");
    } catch (err: any) {
      assert(err.message.includes("requestParamsSchema must be a JSON object"), "Test 14: string schema rejected");
    }

    try {
      registeredApiService.create({
        name: "bad_schema_api2",
        apiUrl: "http://localhost/test",
        requestParamsSchema: { type: "string" } as any,
      });
      assert(false, "Test 14: non-object type schema should be rejected");
    } catch (err: any) {
      assert(err.message.includes("type must be 'object'"), "Test 14: non-object type schema rejected");
    }

    try {
      registeredApiService.create({
        name: "bad_mapping_api",
        apiUrl: "http://localhost/test",
        responseMapping: { code: 123 } as any,
      });
      assert(false, "Test 14: non-string responseMapping value should be rejected");
    } catch (err: any) {
      assert(err.message.includes("must be a string"), "Test 14: non-string responseMapping rejected");
    }
  }

  // ─── Test 15: Update schema validation parity with create ──
  {
    // Create a valid API first
    const api = registeredApiService.create({
      name: "test_update_schema",
      apiUrl: "http://localhost/test",
      method: "GET",
    });
    installApiAsMcp(api);

    // Update with invalid properties (not an object)
    try {
      registeredApiService.update(api.id, {
        requestParamsSchema: { type: "object", properties: "not-an-object" } as any,
      });
      assert(false, "Test 15: update with non-object properties should be rejected");
    } catch (err: any) {
      assert(err.message.includes("properties must be a JSON object"), "Test 15: update rejects non-object properties");
    }

    // Update with non-string responseMapping value
    try {
      registeredApiService.update(api.id, {
        responseMapping: { code: 123 } as any,
      });
      assert(false, "Test 15: update with non-string mapping value should be rejected");
    } catch (err: any) {
      assert(err.message.includes("must be a string"), "Test 15: update rejects non-string mapping value");
    }

    // Update with valid schema should succeed
    const updated = registeredApiService.update(api.id, {
      requestParamsSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    assert(updated !== null, "Test 15: update with valid schema succeeds");

    // Cleanup
    uninstallApiMcp("test_update_schema");
    try { registeredApiService.delete(api.id); } catch {}
  }

  // ─── Test 16: Restore (rollback) preserves previous state ──
  {
    // Create API with original URL
    const api = registeredApiService.create({
      name: "test_rollback",
      apiUrl: "http://localhost/original",
      method: "GET",
    });
    installApiAsMcp(api);
    const original = registeredApiService.getById(api.id)!;
    assert(original.apiUrl === "http://localhost/original", "Test 16: original URL stored");

    // Update to new URL
    const updated = registeredApiService.update(api.id, {
      apiUrl: "http://localhost/updated",
    });
    assert(updated!.apiUrl === "http://localhost/updated", "Test 16: update changed URL");

    // Restore to original
    registeredApiService.restore(original);
    const restored = registeredApiService.getById(api.id)!;
    assert(restored.apiUrl === "http://localhost/original", "Test 16: restore reverted URL to original");
    assert(restored.method === "GET", "Test 16: restore preserved method");

    // Cleanup
    uninstallApiMcp("test_rollback");
    try { registeredApiService.delete(api.id); } catch {}
  }

  // ─── Cleanup ──────────────────────────────────────────────
  uninstallApiMcp("test_get_customer");
  try { registeredApiService.delete(registeredApiService.getByName("test_get_customer")!.id); } catch {}
  try { registeredApiService.delete(registeredApiService.getByName("test_post_order")?.id ?? ""); } catch {}

  // ─── Summary ──────────────────────────────────────────────
  console.log(`\n${failed === 0 ? "✅" : "❌"} All A3 capability installer tests ${failed === 0 ? "passed" : "FAILED"} (${passed}/${passed + failed})`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
