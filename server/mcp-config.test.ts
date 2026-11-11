// Run: npm run test:mcp-config
// Hermetic: MCP_CONFIG_FILE + ENTITLEMENTS_FILE + AGENT_CAPABILITIES_FILE → temp files.
// Reads the real mcp/smoke-mcp package on disk (MCP_ROOT is the project mcp/ dir).
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getAllMcpServers,
  getEnabledMcpServers,
  setMcpServerEnabled,
} from "./mcp-config.js";
import { capabilityProvider } from "./capability-provider.js";
import { capabilityResourceService } from "./capability-resource.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { entitlementService } from "./entitlement.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

const CFG = process.env.MCP_CONFIG_FILE!;

// Reset temp stores → hermetic + repeatable across runs.
if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");

const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };
const user: RequestContext = { userId: "u1", role: "user", orgId: DEFAULT_ORG_ID };

function writeCfg(entries: unknown[]) {
  fs.writeFileSync(CFG, JSON.stringify(entries, null, 2) + "\n");
}

// 1. Absent config → no servers.
assert.deepEqual(getAllMcpServers(), [], "absent config → 0 mcp servers");

// 2. Valid smoke-mcp package resolves. command is backend-generated (never from config).
writeCfg([{ name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp" }]);
const resolved = getAllMcpServers();
assert.equal(resolved.length, 1, "one server loaded");
const smoke = resolved[0];
assert.equal(smoke.valid, true, "smoke-mcp resolves valid (run.sh present + executable)");
assert.equal(smoke.command, "/opt/agent/mcp/smoke-mcp/run.sh", "command is backend-generated at the fixed container path");
assert.deepEqual(smoke.args, [], "args empty in MVP");
assert.equal(smoke.containerPath, "/opt/agent/mcp/smoke-mcp", "containerPath is the mount target");
assert.equal(smoke.version, "1.0.0", "version read from mcp.json manifest");

// 3. getEnabledMcpServers filters by enabled.
writeCfg([
  { name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp" },
  { name: "smoke-mcp-off", type: "local", enabled: false, path: "mcp/smoke-mcp" },
]);
assert.equal(getEnabledMcpServers().length, 1, "getEnabledMcpServers filters by enabled");
assert.equal(getEnabledMcpServers()[0].name, "smoke-mcp", "enabled filter keeps smoke-mcp");

// 4. Type gate: only "local" supported; remote/http rejected (MVP).
writeCfg([{ name: "remote-x", type: "remote", enabled: true, path: "mcp/smoke-mcp" }]);
const typed = getAllMcpServers()[0];
assert.equal(typed.valid, false, "type 'remote' rejected in MVP");
assert.match(typed.error ?? "", /only "local"/, "type gate explains MVP restriction");

// 5. Name validation: bad name → invalid (no path separators allowed).
writeCfg([{ name: "../etc", type: "local", enabled: true, path: "mcp/smoke-mcp" }]);
const badName = getAllMcpServers()[0];
assert.equal(badName.valid, false, "name with path separators rejected");
assert.match(badName.error ?? "", /invalid mcp name/, "name validation error");

// 6. Path containment: path escaping mcp/ → invalid.
writeCfg([{ name: "escape", type: "local", enabled: true, path: "server/skill-config.ts" }]);
const escaped = getAllMcpServers()[0];
assert.equal(escaped.valid, false, "path escaping mcp/ rejected");
assert.match(escaped.error ?? "", /escapes mcp|does not exist/, "containment error");

// 7. run.sh missing → invalid. Uses a temp dir under mcp/ (cleaned up in finally).
try {
  fs.mkdirSync("mcp/_no_rundir", { recursive: true });
  writeCfg([{ name: "no-run", type: "local", enabled: true, path: "mcp/_no_rundir" }]);
  const noRun = getAllMcpServers()[0];
  assert.equal(noRun.valid, false, "missing run.sh → invalid");
  assert.match(noRun.error ?? "", /run\.sh/, "run.sh requirement error");
} finally {
  fs.rmSync("mcp/_no_rundir", { recursive: true, force: true });
}

// 8. setMcpServerEnabled persists + reloads; unknown name → null.
writeCfg([{ name: "smoke-mcp", type: "local", enabled: false, path: "mcp/smoke-mcp" }]);
assert.equal(getEnabledMcpServers().length, 0, "starts disabled");
const toggled = setMcpServerEnabled("smoke-mcp", true);
assert.equal(toggled?.enabled, true, "setMcpServerEnabled returns enabled");
assert.equal(getEnabledMcpServers().length, 1, "persisted enable reflected on reload");
assert.equal(setMcpServerEnabled("does-not-exist", true), null, "toggle unknown → null");

// --- resolve() integration (the end-to-end injection contract) ---

// Reset config + activation stores for the integration block.
writeCfg([{ name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp" }]);
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");

// 9. Deny-default: unconfigured agent → 0 mcpServers, but strictMcpConfig ALWAYS true.
const baseline = capabilityProvider.resolve({ chatId: "agent-none" });
assert.equal(
  Object.keys(baseline.sdkOptions.mcpServers ?? {}).length,
  0,
  "unconfigured agent → 0 mcp injected"
);
assert.equal(baseline.sdkOptions.strictMcpConfig, true, "strictMcpConfig unconditional even with no MCP");

// 10. Activated + entitled smoke-mcp → injected with backend command + mount + strict gate.
entitlementService.setEntitlements(admin, "smoke-mcp", [
  { scopeType: "user", scopeId: user.userId, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(user, "agent-mcp-1", {
  resources: [{ resourceId: "smoke-mcp", enabled: true }],
});
const bundle = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-mcp-1",
  role: "user",
  runtimeType: "docker",
});
const injected = bundle.sdkOptions.mcpServers as Record<string, { command: string; args: string[] }>;
assert.deepEqual(Object.keys(injected), ["smoke-mcp"], "activated+entitled smoke-mcp injected");
assert.equal(injected["smoke-mcp"].command, "/opt/agent/mcp/smoke-mcp/run.sh", "injected command is backend-generated");
assert.equal(bundle.sdkOptions.strictMcpConfig, true, "strictMcpConfig true with MCP injected");
const mcpMount = bundle.mounts.find((m) => m.containerPath === "/opt/agent/mcp/smoke-mcp");
assert.ok(mcpMount, "MCP package readonly-mounted at /opt/agent/mcp/smoke-mcp");
assert.equal(mcpMount!.readonly, true, "MCP mount is readonly (entitlement-by-isolation)");

// 11. Entitlement revocation backstop: deny smoke-mcp → excluded from next bundle.
entitlementService.setEntitlements(admin, "smoke-mcp", [
  { scopeType: "user", scopeId: user.userId, effect: "deny" },
]);
const revoked = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-mcp-1",
  role: "user",
});
assert.equal(
  Object.keys(revoked.sdkOptions.mcpServers ?? {}).length,
  0,
  "revoked MCP excluded (entitlement backstop)"
);

// --- resourceId collision (skill/mcp same name) — Codex MP3 review should-fix #3 ---
// "hello-skill" exists as a skill in data/skills.json. Registering an MCP of the
// same name exercises the global-unique-name invariant.

// Reset for the collision block.
writeCfg([{ name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp" }]);
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");

// 12. Pool marks skill/mcp name collision invalid → fresh activation blocked.
writeCfg([{ name: "hello-skill", type: "local", enabled: true, path: "mcp/smoke-mcp" }]);
const pool = capabilityResourceService.listResources(admin);
const collided = pool.filter((r) => r.resourceId === "hello-skill");
assert.equal(collided.length, 2, "skill + mcp share the name hello-skill");
assert.ok(
  collided.every((r) => !r.valid && r.status === "invalid"),
  "both pool entries marked invalid on collision"
);
assert.throws(
  () =>
    agentCapabilityService.updateAgentCapabilities(user, "agent-collide-fresh", {
      resources: [{ resourceId: "hello-skill", enabled: true }],
    }),
  /not found/i,
  "fresh activation of a colliding (invalid) resource is blocked"
);

// 13. resolve() defensive drop with a PRE-EXISTING activation (skill wins).
//     Activate hello-skill BEFORE the collision, then introduce an MCP of the same
//     name → resolve() must drop the MCP, never emit a duplicate id.
writeCfg([{ name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp" }]); // no collision yet
entitlementService.setEntitlements(admin, "hello-skill", [
  { scopeType: "user", scopeId: user.userId, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(user, "agent-collide", {
  resources: [{ resourceId: "hello-skill", enabled: true }],
});
// Now introduce the collision (an MCP also named hello-skill, enabled).
writeCfg([
  { name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp" },
  { name: "hello-skill", type: "local", enabled: true, path: "mcp/smoke-mcp" },
]);
const collideBundle = capabilityProvider.resolve({
  userId: user.userId,
  chatId: "agent-collide",
  role: "user",
  runtimeType: "docker",
});
assert.ok(
  (collideBundle.sdkOptions.plugins ?? []).some((p) => p.path.endsWith("/hello-skill")),
  "skill hello-skill still injected"
);
// hello-skill MCP IS gated in (activated) but MUST be dropped due to the name
// collision with the skill — resolve() never emits a duplicate resourceId.
assert.ok(
  !Object.keys(collideBundle.sdkOptions.mcpServers ?? {}).includes("hello-skill"),
  "colliding hello-skill MCP dropped from bundle (skill wins)"
);

// Cleanup.
if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
console.log("mcp-config tests passed");
