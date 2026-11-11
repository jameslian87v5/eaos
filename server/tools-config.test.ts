/**
 * Focused tests for built-in tools config management (v3).
 * Run: tsx server/tools-config.test.ts
 */
import { TOOL_CATALOG, SUPPORTED_TOOL_NAMES } from "./tool-catalog.js";
import { capabilityProvider } from "./capability-provider.js";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertThrows(fn: () => void, substr: string, msg: string) {
  try {
    fn();
    failed++; console.error(`  ✗ ${msg} (expected throw)`);
  } catch (e: any) {
    if (e.message.includes(substr)) { passed++; console.log(`  ✓ ${msg}`); }
    else { failed++; console.error(`  ✗ ${msg} (got: ${e.message})`); }
  }
}

console.log("\n=== Tool Catalog Tests ===");

// 1. Supported tools are a subset of catalog
assert(
  [...SUPPORTED_TOOL_NAMES].every((t) => TOOL_CATALOG.some((c) => c.name === t)),
  "SUPPORTED_TOOL_NAMES is subset of TOOL_CATALOG"
);

// 2. WebFetch is supported, defaultEnabled, but requiresApproval
const webFetch = TOOL_CATALOG.find((t) => t.name === "WebFetch")!;
assert(webFetch?.supported === true, "WebFetch is supported");
assert(webFetch?.defaultEnabled === true, "WebFetch is defaultEnabled");
assert(webFetch?.requiresApproval === true, "WebFetch requires approval");

// 3. WebSearch is supported, defaultEnabled, no approval
const webSearch = TOOL_CATALOG.find((t) => t.name === "WebSearch")!;
assert(webSearch?.requiresApproval === false, "WebSearch does not require approval");

// 4. Unsupported tools are not in SUPPORTED_TOOL_NAMES
assert(!SUPPORTED_TOOL_NAMES.has("NotebookEdit"), "NotebookEdit not in supported set");
assert(!SUPPORTED_TOOL_NAMES.has("TodoWrite"), "TodoWrite not in supported set");

console.log("\n=== Validation Tests (agent-profile-store) ===");

// Import validation function indirectly via store
import { agentProfileStore } from "./agent-profile-store.js";

// 5. Unsupported tool rejected
assertThrows(
  () => agentProfileStore.create({
    name: "test-bad-tool",
    description: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    toolsConfig: { tools: ["Read", "FakeTool"], allowedTools: [], disallowedTools: [] },
  }),
  "Unsupported tool",
  "Unsupported tool in toolsConfig rejected"
);

// 6. allowedTools not in tools rejected
assertThrows(
  () => agentProfileStore.create({
    name: "test-allowed-not-in-tools",
    description: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    toolsConfig: { tools: ["Read"], allowedTools: ["Bash"], disallowedTools: [] },
  }),
  "not in tools",
  "allowedTools not in tools rejected"
);

// 7. allowedTools ∩ disallowedTools overlap rejected
assertThrows(
  () => agentProfileStore.create({
    name: "test-overlap",
    description: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    toolsConfig: { tools: ["Read", "Bash"], allowedTools: ["Bash"], disallowedTools: ["Bash"] },
  }),
  "overlap",
  "allowedTools ∩ disallowedTools overlap rejected"
);

// 8. disallowedTools not in tools rejected
assertThrows(
  () => agentProfileStore.create({
    name: "test-disallow-not-in-tools",
    description: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    toolsConfig: { tools: ["Read"], allowedTools: [], disallowedTools: ["Bash"] },
  }),
  "not in tools",
  "disallowedTools not in tools rejected"
);

// Clean up any test profiles
try {
  const profiles = agentProfileStore.list();
  for (const p of profiles) {
    if (p.name.startsWith("test-")) {
      agentProfileStore.deleteProfile(p.id);
    }
  }
} catch {}

console.log("\n=== DEFAULT_PROFILE Tests ===");

// 9/10. Platform web tools: the SDK's own WebSearch/WebFetch were removed in
// favor of the in-process platform-web-tools MCP pair (one search/fetch pair
// for the model). Search is auto-allowed; web_fetch requires approval.
const defaultProfile = capabilityProvider.getDefaultProfile();
assert(
  defaultProfile.tools.includes("mcp__platform-web-tools__bailian_search"),
  "DEFAULT_PROFILE.tools includes the platform search tool"
);
assert(
  defaultProfile.allowedTools.includes("mcp__platform-web-tools__bailian_search"),
  "DEFAULT_PROFILE.allowedTools includes the platform search tool"
);
assert(
  !defaultProfile.tools.includes("WebSearch") && !defaultProfile.tools.includes("WebFetch"),
  "DEFAULT_PROFILE.tools no longer lists the SDK WebSearch/WebFetch"
);

// 11. web_fetch (egress + content risk) is approval-gated.
assert(
  defaultProfile.tools.includes("mcp__platform-web-tools__web_fetch"),
  "DEFAULT_PROFILE.tools includes the platform web_fetch tool"
);
assert(
  !defaultProfile.allowedTools.includes("mcp__platform-web-tools__web_fetch"),
  "DEFAULT_PROFILE.allowedTools does NOT include web_fetch (requires approval)"
);
assert(
  defaultProfile.approvalRequiredTools.includes("mcp__platform-web-tools__web_fetch"),
  "DEFAULT_PROFILE.approvalRequiredTools includes web_fetch"
);

// 12. Skill is NOT in DEFAULT_PROFILE.tools (dynamically injected)
assert(
  !defaultProfile.tools.includes("Skill"),
  "Skill not in DEFAULT_PROFILE.tools (dynamically injected)"
);

console.log("\n=== Application Service Tests ===");

import { applicationService } from "./application-service.js";

// 13. Unsupported tool in toolAllowlist rejected
assertThrows(
  () => applicationService.createApplication({
    name: "test-app-bad-tool",
    description: null,
    profileId: null,
    entryUrl: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    toolAllowlist: ["Read", "FakeTool"],
  }),
  "Unsupported",
  "Unsupported tool in toolAllowlist rejected"
);

// Clean up
try {
  const apps = applicationService.listApplications();
  for (const a of apps) {
    if (a.name.startsWith("test-app-")) {
      applicationService.updateApplication(a.id, { status: "disabled" });
    }
  }
} catch {}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
