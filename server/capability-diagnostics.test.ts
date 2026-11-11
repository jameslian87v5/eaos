// Run: npm run test:capability-diagnostics
// Hermetic: DB_PATH + ENTITLEMENTS_FILE + AGENT_CAPABILITIES_FILE → temp files.
// Reads the real data/skills.json (hello-skill + minimal-plugin enabled).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { eventStore } from "./event-store.js";
import db from "./database.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { entitlementService } from "./entitlement.js";
import { capabilityProvider } from "./capability-provider.js";
import { computeConfigVersion } from "./capability-version.js";
import { buildResolvedSnapshot, getDiagnostics } from "./capability-diagnostics.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// Reset temp stores → hermetic + repeatable.
fs.writeFileSync(process.env.ENTITLEMENTS_FILE!, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE!, JSON.stringify({}) + "\n");
// Phase 3: enable smoke-mcp in the registry so MCP diagnostics paths are exercisable.
fs.writeFileSync(
  process.env.MCP_CONFIG_FILE!,
  JSON.stringify([{ name: "smoke-mcp", type: "local", enabled: true, path: "mcp/smoke-mcp" }]) + "\n"
);

const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };
const user: RequestContext = { userId: "u1", role: "user", orgId: DEFAULT_ORG_ID };
const AGENT = "agent-diag-1";

// 1. computeConfigVersion: deterministic; flips on activation + entitlement revocation.
const v0 = computeConfigVersion(user, AGENT); // no activation
entitlementService.setEntitlements(admin, "hello-skill", [
  { scopeType: "user", scopeId: user.userId, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(user, AGENT, {
  resources: [{ resourceId: "hello-skill", enabled: true }],
});
const v1 = computeConfigVersion(user, AGENT);
assert.notEqual(v1, v0, "activation changes configVersion");
assert.equal(computeConfigVersion(user, AGENT), v1, "configVersion is deterministic");

// revoke entitlement → version changes
entitlementService.setEntitlements(admin, "hello-skill", [
  { scopeType: "user", scopeId: user.userId, effect: "deny" },
]);
const v2 = computeConfigVersion(user, AGENT);
assert.notEqual(v2, v1, "entitlement revocation changes configVersion");
// re-grant → deterministic round-trip back to v1
entitlementService.setEntitlements(admin, "hello-skill", [
  { scopeType: "user", scopeId: user.userId, effect: "allow" },
]);
assert.equal(computeConfigVersion(user, AGENT), v1, "re-grant restores configVersion");

// 2. buildResolvedSnapshot: redaction (no env values, no absolute host paths).
const fakeBundle = {
  sdkOptions: {
    tools: ["Read", "Skill"],
    allowedTools: ["Read"],
    disallowedTools: [],
    skills: ["hello-skill"],
    plugins: [{ type: "local", path: "/opt/agent/plugins/hello-skill" }],
    mcpServers: {},
  },
  mounts: [
    {
      hostPath: "/Users/x/SECRET_HOST_PATH/skills/hello-skill",
      containerPath: "/opt/agent/plugins/hello-skill",
      readonly: true,
    },
  ],
  env: { API_KEY: "supersecret-value", OTHER_KEY: "v" },
} as unknown as Parameters<typeof buildResolvedSnapshot>[0];
const snap = buildResolvedSnapshot(fakeBundle, "cv-test-1");
assert.deepEqual(snap.envKeys, ["API_KEY", "OTHER_KEY"], "envKeys = key names only");
assert.ok(
  !JSON.stringify(snap).includes("supersecret-value"),
  "no env VALUE leaks into snapshot"
);
assert.ok(
  !JSON.stringify(snap).includes("/Users/x/SECRET_HOST_PATH"),
  "no absolute host path leaks into snapshot"
);
assert.equal(
  snap.mounts[0].hostPathHash,
  createHash("sha256").update("/Users/x/SECRET_HOST_PATH/skills/hello-skill").digest("hex").slice(0, 16),
  "hostPath hashed for identity"
);
assert.equal(snap.mounts[0].resourceId, "hello-skill", "resourceId derived from container path");
assert.equal(snap.configVersion, "cv-test-1");

// 3. getDiagnostics: 4-column view + two-domain diff + stale (via temp DB).
// Seed the chats parent row (agent_sessions/agent_events FK → chats.id).
db.prepare("INSERT OR IGNORE INTO chats (id, user_id, title) VALUES (?, ?, ?)").run(
  AGENT,
  user.userId,
  "diag-test"
);
const session = eventStore.getOrCreateSession(user.userId, AGENT, "docker");
const cv = computeConfigVersion(user, AGENT);
const resolvedBundle = capabilityProvider.resolve({
  userId: user.userId,
  chatId: AGENT,
  role: "user",
  runtimeType: "docker",
});
eventStore.appendEvent(
  user.userId,
  AGENT,
  session.id,
  "resolved_snapshot",
  buildResolvedSnapshot(resolvedBundle, cv)
);
eventStore.appendEvent(user.userId, AGENT, session.id, "sdk_init", {
  skills: ["hello-skill:hello-skill"],
  plugins: [{ name: "hello-skill", path: "/opt/agent/plugins/hello-skill" }],
  tools: ["Read", "Skill"],
  slashCommands: [],
});

let diag = getDiagnostics(user, AGENT);
assert.deepEqual(
  diag.configured.map((c) => c.resourceId),
  ["hello-skill"],
  "configured = live activation∩entitled"
);
assert.equal(diag.resolved?.configVersion, cv, "resolved snapshot preserved");
assert.equal(diag.discovered?.skills[0], "hello-skill:hello-skill", "sdk_init parsed");
assert.deepEqual(
  diag.diff.resolvedVsDiscovered.injectedButUnseen,
  [],
  "no injection gap when SDK discovered the resolved skill"
);
assert.equal(diag.stale.isStale, false, "not stale: resolved == current");

// Broken discovery (SDK reported nothing) → injection gap surfaced.
eventStore.appendEvent(user.userId, AGENT, session.id, "sdk_init", {
  skills: [],
  plugins: [],
  tools: [],
  slashCommands: [],
});
diag = getDiagnostics(user, AGENT);
assert.deepEqual(
  diag.diff.resolvedVsDiscovered.injectedButUnseen,
  ["hello-skill"],
  "injection gap surfaced when SDK didn't discover the resolved skill"
);

// Drift: deactivate hello-skill → configured no longer matches resolved → stale.
agentCapabilityService.updateAgentCapabilities(user, AGENT, {
  resources: [{ resourceId: "hello-skill", enabled: false }],
});
diag = getDiagnostics(user, AGENT);
assert.equal(diag.stale.isStale, true, "stale after activation drift");
assert.deepEqual(
  diag.diff.configuredVsResolved.revokedSinceResolve,
  ["hello-skill"],
  "revoked-since-resolve flagged"
);

// 4. (Phase 3) MCP resolved-vs-configured: an MCP that is BOTH configured (live)
//    and resolved (in the snapshot) must NOT appear in addedSinceResolve. This is
//    the Codex MP3 review should-fix #1 — resolvedIds must include MCP names, not
//    just plugin basenames, else a resolved MCP falsely reads as drift.
const AGENT_MCP = "agent-diag-mcp";
db.prepare("INSERT OR IGNORE INTO chats (id, user_id, title) VALUES (?, ?, ?)").run(
  AGENT_MCP,
  user.userId,
  "diag-mcp"
);
const sessionMcp = eventStore.getOrCreateSession(user.userId, AGENT_MCP, "docker");
entitlementService.setEntitlements(admin, "smoke-mcp", [
  { scopeType: "user", scopeId: user.userId, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(user, AGENT_MCP, {
  resources: [{ resourceId: "smoke-mcp", enabled: true }],
});
const cvMcp = computeConfigVersion(user, AGENT_MCP);
const mcpBundle = capabilityProvider.resolve({
  userId: user.userId,
  chatId: AGENT_MCP,
  role: "user",
  runtimeType: "docker",
});
// Sanity: the bundle actually injected the MCP (proves the test exercises the path).
assert.deepEqual(
  Object.keys(mcpBundle.sdkOptions.mcpServers ?? {}),
  ["smoke-mcp"],
  "MCP bundle injects smoke-mcp"
);
eventStore.appendEvent(
  user.userId,
  AGENT_MCP,
  sessionMcp.id,
  "resolved_snapshot",
  buildResolvedSnapshot(mcpBundle, cvMcp)
);
const diagMcp = getDiagnostics(user, AGENT_MCP);
assert.deepEqual(
  diagMcp.configured.map((c) => c.resourceId),
  ["smoke-mcp"],
  "configured MCP = smoke-mcp (live)"
);
assert.deepEqual(
  diagMcp.diff.configuredVsResolved.addedSinceResolve,
  [],
  "resolved MCP NOT falsely flagged as addedSinceResolve (Phase 3 drift fix)"
);
assert.equal(diagMcp.stale.isStale, false, "resolved MCP bundle not stale");

console.log("capability-diagnostics tests passed");
