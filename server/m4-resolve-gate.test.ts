// M4 (evt_20260811100855) — resolve-gate proof (deny-by-intersection 4th leg).
//
// Proves the registration-status gate is wired into the single resolve
// chokepoint (agent-capabilities.resolveEnabledResourceIdsForApp): a resource
// with a registration in draft/rejected/disabled status is EXCLUDED from the
// resolved CapabilityBundle for ANY ctx (global kill switch); no registration
// row → legacy fallthrough. Stale-runtime convergence: resolve re-reads each
// call, so a disable takes effect on the NEXT resolve (no hot mutation).
// App-allowlist + agent-activation legs compose with the new gate.
//
// Direct-service (project convention — mirrors capability-provider.test.ts):
// temp ENTITLEMENTS_FILE + AGENT_CAPABILITIES_FILE + RESOURCE_REGISTRATIONS_FILE.
//
// Run: npx tsx server/m4-resolve-gate.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { rmSync } from "node:fs";

const ENT_FILE = `/tmp/m4-resolve-ent-${process.pid}.json`;
const ACT_FILE = `/tmp/m4-resolve-act-${process.pid}.json`;
const REG_FILE = `/tmp/m4-resolve-reg-${process.pid}.json`;
const DB_PATH = `/tmp/m4-resolve-gate-${process.pid}.db`;
process.env.ENTITLEMENTS_FILE = ENT_FILE;
process.env.AGENT_CAPABILITIES_FILE = ACT_FILE;
process.env.RESOURCE_REGISTRATIONS_FILE = REG_FILE;
process.env.DB_PATH = DB_PATH;
process.env.JWT_SECRET = "m4-resolve-gate-secret-strong-9f1a";
process.env.ALLOW_DEV_JWT_SECRET = "1";

rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });
fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(ACT_FILE, JSON.stringify({}) + "\n");
fs.writeFileSync(REG_FILE, JSON.stringify({ registrations: [] }) + "\n");

const db = (await import("./database.js")).default;
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { resourceRegistrationService } = await import("./resource-registration.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
import type { RequestContext } from "./request-context.js";

// The shared pool has hello-skill + minimal-plugin (data/skills.json).
const RID = "hello-skill";
const AGENT = "agent-m4-gate";
const APP = "default-app"; // no application_capabilities rows → passthrough allowlist

const admin: RequestContext = { userId: "admin-1", role: "admin", orgId: DEFAULT_ORG_ID };

// Helper: enable RID on the agent (admin-bypasses entitlement).
function enableOnAgent() {
  agentCapabilityService.updateAgentCapabilities(admin, AGENT, {
    resources: [{ resourceId: RID, enabled: true }],
  });
}
function resolvedIds(): string[] {
  return agentCapabilityService.resolveEnabledResourceIdsForApp(admin, AGENT, APP);
}

// ─── 1. No registration → fallthrough (legacy behavior preserved) ────────
enableOnAgent();
{
  const ids = resolvedIds();
  assert.ok(ids.includes(RID), "no registration → fallthrough → resolved");
  console.log("✓ 1. no registration → fallthrough (legacy preserved)");
}

// ─── 2. Published → resolved ──────────────────────────────────────────────
{
  const reg = resourceRegistrationService.submitDraft(admin, { resourceType: "skill", resourceName: RID });
  resourceRegistrationService.publish(admin, reg.id);
  const ids = resolvedIds();
  assert.ok(ids.includes(RID), "published → resolved");
  console.log("✓ 2. published → resolved");
}

// ─── 3. Disable → excluded on NEXT resolve (stale-runtime convergence) ──
{
  const reg = resourceRegistrationService.getRegistration(RID)!;
  resourceRegistrationService.disable(admin, reg.id);
  // resolve re-reads each call — no hot mutation, but the NEXT resolve excludes
  const ids = resolvedIds();
  assert.ok(!ids.includes(RID), "disabled → excluded on next resolve (global kill switch)");
  console.log("✓ 3. disabled → excluded on next resolve (stale-runtime convergence; re-read each call)");
}

// ─── 4. Re-publish → restored (entitlements preserved across disable) ────
{
  const reg = resourceRegistrationService.getRegistration(RID)!;
  resourceRegistrationService.publish(admin, reg.id);
  const ids = resolvedIds();
  assert.ok(ids.includes(RID), "re-published → resolved again");
  // owner org = null (admin submitted → enterprise). No auto-entitle. But admin
  // bypasses entitlement, so it still resolves for admin ctx. Confirm with a
  // user ctx that has NO entitlement → not resolved (deny-default).
  const userCtx: RequestContext = { userId: "u1", role: "user", orgId: DEFAULT_ORG_ID };
  const userIds = agentCapabilityService.resolveEnabledResourceIdsForApp(userCtx, AGENT, APP);
  assert.ok(!userIds.includes(RID), "enterprise resource + no entitlement → not resolved for plain user");
  console.log("✓ 4. re-published → resolved for admin; plain user without entitlement denied");
}

// ─── 5. Draft (re-submit a fresh resource) → excluded ────────────────────
{
  const RID2 = "minimal-plugin";
  agentCapabilityService.updateAgentCapabilities(admin, AGENT, {
    resources: [{ resourceId: RID2, enabled: true }],
  });
  assert.ok(resolvedIds().includes(RID2), "minimal-plugin no-reg → resolved (fallthrough)");
  const reg = resourceRegistrationService.submitDraft(admin, { resourceType: "skill", resourceName: RID2 });
  assert.equal(reg.status, "draft");
  assert.ok(!resolvedIds().includes(RID2), "draft → excluded");
  console.log("✓ 5. draft → excluded (never resolvable)");
}

// ─── 6. Rejected → excluded ───────────────────────────────────────────────
{
  const RID2 = "minimal-plugin";
  const reg = resourceRegistrationService.getRegistration(RID2)!;
  resourceRegistrationService.reject(admin, reg.id, "not approved");
  assert.ok(!resolvedIds().includes(RID2), "rejected → excluded");
  console.log("✓ 6. rejected → excluded");
}

// ─── 7. App-allowlist intersection (4 legs compose) ───────────────────────
{
  // RID2 is rejected; re-publish it for a clean base.
  const reg2 = resourceRegistrationService.getRegistration("minimal-plugin")!;
  resourceRegistrationService.publish(admin, reg2.id);
  assert.ok(resolvedIds().includes("minimal-plugin"), "minimal-plugin published → resolved (baseline)");

  // Insert an app allowlist for a NEW app that does NOT include minimal-plugin.
  const APP2 = "m4-test-app";
  db.prepare(`INSERT OR IGNORE INTO applications (id, org_id, name, status) VALUES (?, ?, ?, 'active')`).run(APP2, DEFAULT_ORG_ID, "M4 Test");
  db.prepare(`DELETE FROM application_capabilities WHERE app_id = ?`).run(APP2);
  db.prepare(`INSERT INTO application_capabilities (id, app_id, resource_id, enabled) VALUES (?, ?, ?, 1)`).run("ac1", APP2, "hello-skill");
  // APP2 allowlist = {hello-skill} only → minimal-plugin excluded by app gate
  const ids2 = agentCapabilityService.resolveEnabledResourceIdsForApp(admin, AGENT, APP2);
  assert.ok(ids2.includes("hello-skill"), "hello-skill in app allowlist → resolved");
  assert.ok(!ids2.includes("minimal-plugin"), "minimal-plugin NOT in app allowlist → excluded (app gate)");
  console.log("✓ 7. app-allowlist intersection: published+entitled but not in app allowlist → excluded");

  // APP2 allowlist includes minimal-plugin → resolved (all 4 legs pass)
  db.prepare(`INSERT INTO application_capabilities (id, app_id, resource_id, enabled) VALUES (?, ?, ?, 1)`).run("ac2", APP2, "minimal-plugin");
  const ids3 = agentCapabilityService.resolveEnabledResourceIdsForApp(admin, AGENT, APP2);
  assert.ok(ids3.includes("minimal-plugin"), "minimal-plugin in app allowlist → resolved (4 legs pass)");
  console.log("✓ 8. all 4 legs pass (active ∩ entitled ∩ published ∩ app-allowlisted) → resolved");
}

// ─── 9. Agent-activation gate (enabled leg) ───────────────────────────────
{
  // Disable RID on the agent → not in enabled set → not resolved even though
  // published + entitled (admin) + in app allowlist (passthrough default-app).
  agentCapabilityService.updateAgentCapabilities(admin, AGENT, {
    resources: [{ resourceId: RID, enabled: false }],
  });
  assert.ok(!resolvedIds().includes(RID), "disabled-on-agent → excluded (activation leg)");
  console.log("✓ 9. agent-activation leg: disabled on agent → excluded");
}

console.log("\n=== M4 resolve-gate tests: ALL PASSED ✓ ===");
process.exit(0);
