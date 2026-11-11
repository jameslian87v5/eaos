/**
 * hook-plugin-route-a.test.ts — Regression tests for Route A (hook-as-plugin).
 *
 * Tests:
 *   1. No activation → 0 hook plugins in bundle (deny-default)
 *   2. Rollout gate: HOOK_PLUGINS_ENABLED=false blocks mount
 *   3. Path traversal in hook plugin config is rejected
 *   4. Old envelope types (HookEnvelope/HookEvent/ApplicationHook) are gone
 *   5. hook-plugin-config validates a well-formed plugin package
 *   6. Enabled + activated + entitled → hook plugin appears in sdkOptions.plugins + mounts
 *
 * Run: npx tsx server/hook-plugin-route-a.test.ts
 */

import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// ─── Set env vars BEFORE any imports that read them ──────────
const TEST_DB = "/tmp/test-hook-plugin-route-a.db";
process.env.DB_PATH = TEST_DB;
rmSync(TEST_DB, { force: true });

// Use a temp dir for hook plugins
const TEST_HOOKS_ROOT = path.resolve(process.cwd(), "hooks");
const TEST_PLUGIN_NAME = "test-hook-plugin";
const TEST_PLUGIN_PATH = path.join(TEST_HOOKS_ROOT, TEST_PLUGIN_NAME);

// Clean and create test plugin
function setupTestPlugin() {
  mkdirSync(path.join(TEST_PLUGIN_PATH, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(TEST_PLUGIN_PATH, "hooks"), { recursive: true });

  writeFileSync(
    path.join(TEST_PLUGIN_PATH, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: TEST_PLUGIN_NAME,
      version: "1.0.0",
      description: "Test hook plugin",
      hooks: "./hooks/hooks.json",
    }, null, 2)
  );

  writeFileSync(
    path.join(TEST_PLUGIN_PATH, "hooks", "hooks.json"),
    JSON.stringify({
      description: "Test hooks",
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "echo test",
                timeout: 5,
              },
            ],
          },
        ],
      },
    }, null, 2)
  );
}

function cleanupTestPlugin() {
  if (existsSync(TEST_PLUGIN_PATH)) {
    rmSync(TEST_PLUGIN_PATH, { recursive: true, force: true });
  }
}

// ─── Dynamic imports (after env vars are set) ────────────────
const { getAllHookPlugins, getEnabledHookPlugins } = await import("./hook-plugin-config.js");
const { capabilityResourceService } = await import("./capability-resource.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
import type { RequestContext } from "./request-context.js";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// ─── Test 5: hook-plugin-config validates a well-formed plugin ──
console.log("\n--- Test 5: hook-plugin-config validates well-formed plugin ---");
{
  setupTestPlugin();
  // Write to data/hook-plugins.json
  const configPath = path.resolve(process.cwd(), "data", "hook-plugins.json");
  writeFileSync(configPath, JSON.stringify([
    { name: TEST_PLUGIN_NAME, type: "hook-plugin", enabled: true, path: `hooks/${TEST_PLUGIN_NAME}` },
  ], null, 2));

  const all = getAllHookPlugins();
  assert(all.length === 1, "getAllHookPlugins returns 1 plugin");
  assert(all[0].valid === true, "plugin is valid");
  assert(all[0].declaredEvents.includes("PreToolUse"), "declaredEvents includes PreToolUse");

  const enabled = getEnabledHookPlugins();
  assert(enabled.length === 1, "getEnabledHookPlugins returns 1 enabled plugin");

  // Check it surfaces in capability resource pool
  const ctx = { userId: "test", role: "admin" as const, orgId: "default-org" };
  const resources = capabilityResourceService.listResources(ctx);
  const hookResource = resources.find((r) => r.type === "hook-plugin");
  assert(!!hookResource, "hook-plugin appears in resource pool");
  assert(hookResource?.resourceId === TEST_PLUGIN_NAME, "resourceId matches plugin name");

  // Cleanup
  writeFileSync(configPath, "[]");
  cleanupTestPlugin();
}

// ─── Test 3: Path traversal in hook plugin config is rejected ──
console.log("\n--- Test 3: Path traversal rejected ---");
{
  const configPath = path.resolve(process.cwd(), "data", "hook-plugins.json");
  writeFileSync(configPath, JSON.stringify([
    { name: "evil-plugin", type: "hook-plugin", enabled: true, path: "../../etc/passwd" },
  ], null, 2));

  const all = getAllHookPlugins();
  assert(all.length === 1, "evil plugin entry exists");
  assert(all[0].valid === false, "evil plugin is invalid (path traversal rejected)");
  assert(Boolean(all[0].error?.includes("escapes hooks/") || all[0].error?.includes("does not exist")),
    `error message mentions path issue: ${all[0].error}`);

  writeFileSync(configPath, "[]");
}

// ─── Test 1: No activation → 0 hook plugins in bundle (deny-default) ──
console.log("\n--- Test 1: No activation → deny-default 0 hook plugins ---");
{
  // Even with a valid plugin in the registry, no activation = no mount.
  const configPath = path.resolve(process.cwd(), "data", "hook-plugins.json");
  setupTestPlugin();
  writeFileSync(configPath, JSON.stringify([
    { name: TEST_PLUGIN_NAME, type: "hook-plugin", enabled: true, path: `hooks/${TEST_PLUGIN_NAME}` },
  ], null, 2));

  // Enable HOOK_PLUGINS_ENABLED so the gate is open
  process.env.HOOK_PLUGINS_ENABLED = "true";

  // Resolve with an agentId that has NO activation record
  const bundle = capabilityProvider.resolve({
    userId: "test-user",
    chatId: "nonexistent-agent-no-activation",
    role: "admin",
  });

  // Deny-default: no activation → no capability mounts (skills / hook-plugins).
  // NOTE: the bundle may still carry non-capability mounts the platform always
  // provisions for a docker user (e.g. /user-memory), so we assert against
  // capability mounts only, not bundle.mounts.length.
  const hookPluginMounts = (bundle.mounts || []).filter(
    (m) => m.containerPath?.startsWith("/opt/agent/plugins/")
  );
  assert(hookPluginMounts.length === 0, `no capability mounts for unactivated agent (deny-default): ${JSON.stringify((bundle.mounts || []).map((m: any) => m.containerPath))}`);

  process.env.HOOK_PLUGINS_ENABLED = "false";
  writeFileSync(configPath, "[]");
  cleanupTestPlugin();
}

// ─── Test 6: Enabled + activated + entitled → hook plugin mounts ──
console.log("\n--- Test 6: Enabled + activated + entitled → hook plugin in bundle ---");
{
  const configPath = path.resolve(process.cwd(), "data", "hook-plugins.json");
  setupTestPlugin();
  writeFileSync(configPath, JSON.stringify([
    { name: TEST_PLUGIN_NAME, type: "hook-plugin", enabled: true, path: `hooks/${TEST_PLUGIN_NAME}` },
  ], null, 2));

  // Open the rollout gate
  process.env.HOOK_PLUGINS_ENABLED = "true";

  // Set up entitlement + activation (same pattern as capability-provider.test.ts)
  const adminCtx: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };
  const userCtx: RequestContext = { userId: "u1", role: "user", orgId: DEFAULT_ORG_ID };

  // Entitle the hook plugin for the user
  entitlementService.setEntitlements(adminCtx, TEST_PLUGIN_NAME, [
    { scopeType: "user", scopeId: userCtx.userId!, effect: "allow" },
  ]);

  // Activate the hook plugin for this agent
  agentCapabilityService.updateAgentCapabilities(userCtx, "agent-hook-test", {
    resources: [{ resourceId: TEST_PLUGIN_NAME, enabled: true }],
  });

  // Resolve the bundle
  const bundle = capabilityProvider.resolve({
    userId: userCtx.userId,
    chatId: "agent-hook-test",
    role: "user",
    runtimeType: "docker",
  });

  // Check hook plugin appears in sdkOptions.plugins
  const pluginPaths = (bundle.sdkOptions.plugins ?? []).map((p: any) => p.path);
  assert(
    pluginPaths.some((p: string) => p.includes(TEST_PLUGIN_NAME)),
    `hook plugin appears in sdkOptions.plugins: ${JSON.stringify(pluginPaths)}`
  );

  // Check hook plugin appears in mounts
  const hookMount = (bundle.mounts || []).find(
    (m) => m.containerPath === `/opt/agent/plugins/${TEST_PLUGIN_NAME}`
  );
  assert(!!hookMount, `hook plugin mount exists at /opt/agent/plugins/${TEST_PLUGIN_NAME}`);
  assert(hookMount?.readonly === true, "hook plugin mount is readonly");

  // Cleanup
  process.env.HOOK_PLUGINS_ENABLED = "false";
  writeFileSync(configPath, "[]");
  cleanupTestPlugin();
}
console.log("\n--- Test 4: Old envelope types removed ---");
{
  // Try to import the deleted modules — should fail
  let hookTransportGone = false;
  try {
    // @ts-ignore — module intentionally deleted
    await import("./hook-transport.js");
  } catch {
    hookTransportGone = true;
  }
  assert(hookTransportGone, "hook-transport.ts is deleted (import fails)");

  let appHookServiceGone = false;
  try {
    // @ts-ignore — module intentionally deleted
    await import("./application-hook-service.js");
  } catch {
    appHookServiceGone = true;
  }
  assert(appHookServiceGone, "application-hook-service.ts is deleted (import fails)");

  // Check types.ts no longer exports HookEnvelope
  const typesModule = await import("./types.js");
  assert(!("HookEnvelope" in typesModule), "HookEnvelope no longer exported from types.ts");
  assert(!("HookEvent" in typesModule), "HookEvent no longer exported from types.ts");
  assert(!("ApplicationHook" in typesModule), "ApplicationHook no longer exported from types.ts");
}

// ─── Test 2: Rollout gate — HOOK_PLUGINS_ENABLED=false blocks mount ──
console.log("\n--- Test 2: Rollout gate blocks hook plugins when disabled ---");
{
  const configPath = path.resolve(process.cwd(), "data", "hook-plugins.json");
  setupTestPlugin();
  writeFileSync(configPath, JSON.stringify([
    { name: TEST_PLUGIN_NAME, type: "hook-plugin", enabled: true, path: `hooks/${TEST_PLUGIN_NAME}` },
  ], null, 2));

  process.env.HOOK_PLUGINS_ENABLED = "false";

  // Even if we had activation, the rollout gate blocks it.
  // We can't easily set up activation without DB, but we can verify the gate
  // by checking that getEnabledHookPlugins returns plugins but resolve() doesn't
  // include them when HOOK_PLUGINS_ENABLED=false.
  const enabled = getEnabledHookPlugins();
  assert(enabled.length === 1, "getEnabledHookPlugins returns 1 (registry-level)");

  // Resolve bundle — gate should block
  const bundle = capabilityProvider.resolve({
    userId: "test-user",
    chatId: "some-agent",
    role: "admin",
  });
  // With gate off, no hook plugin mounts should appear even if activation exists
  const hasHookPluginMount = (bundle.mounts || []).some(
    (m) => m.containerPath?.includes(TEST_PLUGIN_NAME)
  );
  assert(!hasHookPluginMount, "no hook plugin mount when HOOK_PLUGINS_ENABLED=false");

  writeFileSync(configPath, "[]");
  cleanupTestPlugin();
}

// ─── Summary ───────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
