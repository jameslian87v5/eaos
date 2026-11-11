// M4 (evt_20260811100855) — Docker data-plane injection smoke.
//
// Proves the CapabilityBundle that docker-runtime.ts consumes (sdkOptions.plugins
// + mounts, built at capability-provider.ts:237-265) honors the registration-
// status gate. docker-runtime serializes sdkOptions → AGENT_SDK_OPTIONS env +
// turns mounts → container Binds (docker-runtime.ts:147-172); agent-entry.ts
// then validates plugin paths against /opt/agent/plugins/ (agent-entry.ts:70-77).
// So: a published+entitled+activated skill reaches the container; a draft/
// rejected/disabled one does NOT — proven at the bundle level (the exact object
// Docker consumes), which is the faithful smoke without a full container boot
// (which would need the built image + an API key).
//
// Run: npx tsx server/m4-docker-bundle.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { rmSync } from "node:fs";

const ENT_FILE = `/tmp/m4-docker-ent-${process.pid}.json`;
const ACT_FILE = `/tmp/m4-docker-act-${process.pid}.json`;
const REG_FILE = `/tmp/m4-docker-reg-${process.pid}.json`;
const DB_PATH = `/tmp/m4-docker-bundle-${process.pid}.db`;
process.env.ENTITLEMENTS_FILE = ENT_FILE;
process.env.AGENT_CAPABILITIES_FILE = ACT_FILE;
process.env.RESOURCE_REGISTRATIONS_FILE = REG_FILE;
process.env.DB_PATH = DB_PATH;
process.env.JWT_SECRET = "m4-docker-bundle-secret-strong-9f1a";
process.env.ALLOW_DEV_JWT_SECRET = "1";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });
fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(ACT_FILE, JSON.stringify({}) + "\n");
fs.writeFileSync(REG_FILE, JSON.stringify({ registrations: [] }) + "\n");

await import("./database.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { resourceRegistrationService } = await import("./resource-registration.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
import type { RequestContext } from "./request-context.js";

const RID = "hello-skill"; // exists + valid in data/skills.json
const AGENT = "agent-m4-docker";
const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };

// Enable hello-skill on the agent (admin-bypasses entitlement).
agentCapabilityService.updateAgentCapabilities(admin, AGENT, {
  resources: [{ resourceId: RID, enabled: true }],
});

function dockerBundle() {
  return capabilityProvider.resolve({
    userId: admin.userId,
    chatId: AGENT,
    role: "admin",
    runtimeType: "docker",
  });
}
function pluginPaths(b: ReturnType<typeof dockerBundle>) {
  return (b.sdkOptions.plugins ?? []).map((p: any) => p.path as string);
}
function mountPaths(b: ReturnType<typeof dockerBundle>) {
  return b.mounts.map((m: any) => m.containerPath as string);
}

// ─── 1. No registration → skill mounted (fallthrough) ────────────────────
{
  const b = dockerBundle();
  assert.ok(pluginPaths(b).includes(`/opt/agent/plugins/${RID}`), "no-reg → plugin path present");
  assert.ok(mountPaths(b).includes(`/opt/agent/plugins/${RID}`), "no-reg → mount present");
  console.log("✓ 1. no registration → skill reaches Docker bundle (mount + plugin)");
}

// ─── 2. Draft → skill NOT mounted (never resolvable) ────────────────────
let regId: string;
{
  const reg = resourceRegistrationService.submitDraft(admin, { resourceType: "skill", resourceName: RID });
  regId = reg.id;
  const b = dockerBundle();
  assert.ok(!pluginPaths(b).includes(`/opt/agent/plugins/${RID}`), "draft → plugin absent");
  assert.ok(!mountPaths(b).includes(`/opt/agent/plugins/${RID}`), "draft → mount absent");
  console.log("✓ 2. draft → skill does NOT reach Docker bundle (never resolvable)");
}

// ─── 3. Publish → skill mounted again ────────────────────────────────────
{
  resourceRegistrationService.publish(admin, regId);
  const b = dockerBundle();
  assert.ok(pluginPaths(b).includes(`/opt/agent/plugins/${RID}`), "published → plugin present");
  assert.ok(mountPaths(b).includes(`/opt/agent/plugins/${RID}`), "published → mount present");
  console.log("✓ 3. published → skill reaches Docker bundle");
}

// ─── 4. Disable → skill NOT mounted (global kill switch, next resolve) ──
{
  resourceRegistrationService.disable(admin, regId);
  const b = dockerBundle();
  assert.ok(!pluginPaths(b).includes(`/opt/agent/plugins/${RID}`), "disabled → plugin absent");
  assert.ok(!mountPaths(b).includes(`/opt/agent/plugins/${RID}`), "disabled → mount absent");
  console.log("✓ 4. disabled → skill does NOT reach Docker bundle (global kill switch; next resolve)");
}

// ─── 5. Path-prefix guard invariant: every plugin path is /opt/agent/plugins/ ─
{
  const b = dockerBundle();
  for (const p of pluginPaths(b)) {
    assert.ok(p.startsWith("/opt/agent/plugins/"), `plugin path prefix guard: ${p}`);
  }
  console.log("✓ 5. Docker bundle plugin paths honor /opt/agent/plugins/ prefix (agent-entry.ts guard)");
}

console.log("\n=== M4 Docker-bundle smoke: ALL PASSED ✓ ===");
process.exit(0);
