import assert from "node:assert/strict";
import { capabilityProvider } from "./capability-provider.js";

// Phase B: resolve() data-plane translation differs by runtimeType, but
// GOVERNANCE (tools/skills) is identical (§5 铁律: governance runs before the
// runtime-specific translation and never relaxes). These asserts pin that.
// No agentId → deny-default (0 skills on feat), so no DB needed.

const localBundle = capabilityProvider.resolve({ runtimeType: "local" });
const dockerBundle = capabilityProvider.resolve({ runtimeType: "docker" });

// 1. local: NO mounts (no container to bind into)
assert.equal(localBundle.mounts.length, 0, "local must have zero mounts");

// 2. local plugins use HOST paths; docker uses /opt/agent/plugins/ container paths
if (localBundle.sdkOptions.plugins && localBundle.sdkOptions.plugins.length > 0) {
  for (const p of localBundle.sdkOptions.plugins) {
    assert.ok(
      !p.path.startsWith("/opt/agent/"),
      `local plugin path must be a HOST path, got container path ${p.path}`,
    );
  }
}

// 3. local does NOT take the Docker-oriented systemPrompt/append (would mislead a
//    host-local agent with "cwd=/workspace in a Docker container"). ai-client falls
//    back to its own generic SYSTEM_PROMPT.
assert.equal(localBundle.sdkOptions.systemPrompt, undefined, "local must not set Docker systemPrompt");
assert.equal(localBundle.sdkOptions.appendSystemPrompt, undefined, "local must not set Docker appendSystemPrompt");

// 4. docker DOES get the Docker workspace-oriented prompt
assert.ok(
  typeof dockerBundle.sdkOptions.systemPrompt === "string" && dockerBundle.sdkOptions.systemPrompt.length > 0,
  "docker must have a systemPrompt",
);
assert.ok(dockerBundle.mounts.length >= 0, "docker mounts shape ok"); // may be 0 if no skills configured

// 5. §5 铁律: governance is runtime-agnostic — tools/skills identical for both
assert.deepEqual(localBundle.sdkOptions.tools, dockerBundle.sdkOptions.tools, "tools must be identical (runtime-agnostic governance)");
assert.deepEqual(localBundle.sdkOptions.allowedTools, dockerBundle.sdkOptions.allowedTools, "allowedTools must be identical");
assert.deepEqual(localBundle.sdkOptions.skills, dockerBundle.sdkOptions.skills, "skills must be identical");

// 6. Phase B: mcpServers empty for BOTH (local never injects; docker Phase 3 not yet)
assert.equal(Object.keys(localBundle.sdkOptions.mcpServers ?? {}).length, 0, "local mcpServers empty");
assert.equal(Object.keys(dockerBundle.sdkOptions.mcpServers ?? {}).length, 0, "docker mcpServers empty");

// 7. default bundle (no runtimeType) behaves like docker (unchanged default)
const defaultBundle = capabilityProvider.resolve({});
assert.ok(typeof defaultBundle.sdkOptions.systemPrompt === "string", "default (no runtimeType) keeps systemPrompt");

// 8. W1 regression: SDK WebSearch/WebFetch removed from the default profile;
//    the two platform built-in `mcp__platform-web-tools__*` names are present
//    with the allow/approval split preserved (bailian_search auto-allowed,
//    web_fetch requires approval). Prevents silent re-add of the SDK pair.
const profile = capabilityProvider.getDefaultProfile();
assert.ok(!profile.tools.includes("WebSearch"), "WebSearch removed from default profile tools");
assert.ok(!profile.tools.includes("WebFetch"), "WebFetch removed from default profile tools");
assert.ok(profile.tools.includes("mcp__platform-web-tools__bailian_search"), "bailian_search exposed");
assert.ok(profile.tools.includes("mcp__platform-web-tools__web_fetch"), "web_fetch exposed");
assert.ok(profile.allowedTools.includes("mcp__platform-web-tools__bailian_search"), "bailian_search auto-allowed");
assert.ok(!profile.allowedTools.includes("mcp__platform-web-tools__web_fetch"), "web_fetch NOT auto-allowed");
assert.ok(profile.approvalRequiredTools.includes("mcp__platform-web-tools__web_fetch"), "web_fetch requires approval");
// Invariant: approvalRequired = tools − allowedTools − disallowedTools
const expectedApproval = profile.tools.filter(
  (t) => !profile.allowedTools.includes(t) && !profile.disallowedTools.includes(t),
);
assert.deepEqual(
  [...profile.approvalRequiredTools].sort(),
  [...expectedApproval].sort(),
  "approvalRequired = tools − allowed − disallowed invariant holds",
);

console.log("capability-provider local-branch tests passed");
