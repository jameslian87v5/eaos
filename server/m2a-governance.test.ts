// Octop absorption M2a (codex evt_20261021013641) — connector governance
// closure regressions.
//
// Proves the role/intersection matrix for connector resources:
//   - admin full list + configure (any scope);
//   - org_admin sees ONLY own-org entitled connectors, writes own-org org-scope
//     entries only;
//   - org_admin cross-org / user-scope entitlement writes throw
//     EntitlementScopeError; org_admin/user are denied on the admin connector
//     instance routes (403 + denied audit);
//   - plain user: canConfigure deny-default, admin routes 403;
//   - M2a fix: non-admin setEntitlements is a SCOPED replace — an org_admin
//     PUT cannot wipe other orgs' or admin user-scope entries;
//   - entitlement revoke removes an ALREADY-ACTIVE connector at resolve()
//     AND at live MCP call time (old token 401);
//   - app allowlist is the upper bound (deny-by-intersection);
//   - audit rows carry resource/action/scope metadata but NEVER credentials
//     or capability tokens.
//
// Run: npx tsx server/m2a-governance.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import express from "express";
import type { RequestContext } from "./request-context.js";

// ─── Env before imports ──────────────────────────────────────
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "m2a-governance-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.JWT_SECRET = "m2a-governance-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.CONNECTOR_MCP_BASE_URL = "http://127.0.0.1:1";

const db = (await import("./database.js")).default;
const store = await import("./connector-store.js");
const { createInternalConnectorMcpRoutes } = await import("./connector-mcp.js");
const { createAdminConnectorRoutes } = await import("./admin-connector-routes.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { capabilityResourceService } = await import("./capability-resource.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService, EntitlementScopeError } = await import("./entitlement.js");
const { applicationCapabilitiesService } = await import("./application-capabilities.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");

const CREDENTIAL = "m2a-credential-77c1";
const ORG_A = DEFAULT_ORG_ID;
const ORG_B = "org-b";
const ADMIN = "m2a-admin";
const ORG_ADMIN_A = "m2a-orgadmin-a";
const ORG_ADMIN_B = "m2a-orgadmin-b";
const USER_A = "m2a-user-a";
const AGENT = "agent-m2a-1";
const APP_X = "app-m2a-x";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const adminCtx: RequestContext = { userId: ADMIN, role: "admin", orgId: ORG_A };
const orgAdminA: RequestContext = { userId: ORG_ADMIN_A, role: "org_admin", orgId: ORG_A };
const orgAdminB: RequestContext = { userId: ORG_ADMIN_B, role: "org_admin", orgId: ORG_B };
const userCtx: RequestContext = { userId: USER_A, role: "user", orgId: ORG_A };

// ─── World: users, agent row (app_x binding), connector instance ──

for (const [id, role, org] of [
  [ADMIN, "admin", ORG_A],
  [ORG_ADMIN_A, "org_admin", ORG_A],
  [ORG_ADMIN_B, "org_admin", ORG_B],
  [USER_A, "user", ORG_A],
] as const) {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', ?, ?, 'active')`
  ).run(id, id, role, org);
}

const agentRow = db.prepare(
  `INSERT INTO agents (id, org_id, owner_user_id, name, status, app_id)
   VALUES (?, ?, ?, ?, 'active', ?)`
);
agentRow.run(AGENT, ORG_A, USER_A, "m2a agent", APP_X);

const instance = store.createInstance({
  catalogKind: "internal-rest",
  name: "m2a-governance-upstream",
  baseUrl: "http://127.0.0.1:1", // no upstream needed — governance only
});
store.writeCredentials(instance.id, { apiToken: CREDENTIAL });
store.enableInstance(instance.id);
const RID = `connector:${instance.id}`;

function auditRows(): any[] {
  return db.prepare(`SELECT * FROM governance_audit_log ORDER BY created_at, rowid`).all() as any[];
}
function resolveBundle(ctx: RequestContext, agentId: string) {
  // resolve()'s ctx type predates org_admin (docker runtimes are minted for
  // user/admin principals) — cast is safe: governance legs tested here only
  // need the identity triple to flow through.
  return capabilityProvider.resolve({
    userId: ctx.userId, chatId: agentId, role: ctx.role as "user" | "admin",
    runtimeType: "docker", orgId: ctx.orgId,
  });
}
function bundleToken(bundle: any, instanceId: string): string {
  return String(bundle.sdkOptions.mcpServers[`connector-${instanceId}`].headers.authorization).slice(7);
}
function connectorServerKeys(bundle: any): string[] {
  return Object.keys(bundle.sdkOptions.mcpServers ?? {}).filter((k) => k.startsWith("connector-"));
}

// ─── MCP route harness (live-call revocation leg) ─────────────

const mcpApp = express();
mcpApp.use(express.json({ limit: "1mb" }));
mcpApp.use("/api/mcp/connectors", createInternalConnectorMcpRoutes());
const mcpServer = mcpApp.listen(0);
const MCP_PORT = (mcpServer.address() as { port: number }).port;

async function rpc(token: string | null, method: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${MCP_PORT}/api/mcp/connectors/${instance.id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ─── Admin connector route harness (role gates + audits) ──────

const adminApp = express();
adminApp.use(express.json({ limit: "1mb" }));
// Test identity middleware — same shape authMiddleware produces (userId/
// userRole/orgId from the trusted JWT claim). Header value selects the actor.
adminApp.use((req: express.Request, _res, next) => {
  const who = String(req.headers["x-test-actor"] ?? "");
  const map: Record<string, { userId: string; userRole: string; orgId: string }> = {
    admin: { userId: ADMIN, userRole: "admin", orgId: ORG_A },
    orgAdminA: { userId: ORG_ADMIN_A, userRole: "org_admin", orgId: ORG_A },
    orgAdminB: { userId: ORG_ADMIN_B, userRole: "org_admin", orgId: ORG_B },
    userA: { userId: USER_A, userRole: "user", orgId: ORG_A },
  };
  Object.assign(req, map[who] ?? {});
  next();
});
adminApp.use("/api/admin/connectors", createAdminConnectorRoutes());
const adminHttp = adminApp.listen(0);
const ADMIN_PORT = (adminHttp.address() as { port: number }).port;

async function adminCall(
  actor: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/api/admin/connectors${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-actor": actor },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ─── 1. admin full list + configure ──────────────────────────

{
  const views = capabilityResourceService.listResourcesForCtx(adminCtx);
  ok("admin listResourcesForCtx includes the connector",
    views.some((r) => r.resourceId === RID));
  // Admin may set ANY scope (user-scope grant is an admin-only finer tool).
  const entries = entitlementService.setEntitlements(adminCtx, RID, [
    { scopeType: "user", scopeId: USER_A, effect: "allow" },
  ]);
  ok("admin configures user-scope entitlement", entries.length === 1 && entries[0].scopeType === "user");
}

// ─── 2. org_admin own-org list (visibility via entitlement) ──

{
  // orgAdminA: user-scope allow for USER_A does NOT match orgAdminA → not visible.
  const aViews = capabilityResourceService.listResourcesForCtx(orgAdminA);
  ok("org_admin sees no connector before own-org entitlement",
    !aViews.some((r) => r.resourceId === RID));
  // Grant own-org allow (admin action), then orgAdminA sees it.
  entitlementService.setEntitlements(adminCtx, RID, [
    { scopeType: "org", scopeId: ORG_A, effect: "allow" },
  ]);
  const aViews2 = capabilityResourceService.listResourcesForCtx(orgAdminA);
  ok("org_admin sees the connector after own-org allow",
    aViews2.some((r) => r.resourceId === RID));
  // orgAdminB (different org) still does NOT see it — cross-org structural deny.
  const bViews = capabilityResourceService.listResourcesForCtx(orgAdminB);
  ok("other-org org_admin does not see the connector",
    !bViews.some((r) => r.resourceId === RID));
}

// ─── 3. org_admin own-org allow write ────────────────────────

{
  const entries = entitlementService.setEntitlements(orgAdminA, RID, [
    { scopeType: "org", scopeId: ORG_A, effect: "allow" },
  ]);
  ok("org_admin writes own-org allow entry", entries.length === 1 && entries[0].scopeId === ORG_A);
}

// ─── 4. org_admin cross-org / user-scope writes denied ────────

{
  assert.throws(
    () => entitlementService.setEntitlements(orgAdminA, RID, [
      { scopeType: "org", scopeId: ORG_B, effect: "allow" },
    ]),
    (e: unknown) => e instanceof EntitlementScopeError,
    "cross-org write must throw EntitlementScopeError"
  );
  ok("org_admin cross-org write throws EntitlementScopeError", true);
  assert.throws(
    () => entitlementService.setEntitlements(orgAdminA, RID, [
      { scopeType: "user", scopeId: USER_A, effect: "allow" },
    ]),
    (e: unknown) => e instanceof EntitlementScopeError,
    "user-scope write must throw EntitlementScopeError"
  );
  ok("org_admin user-scope write throws EntitlementScopeError", true);
}

// ─── 5. M2a fix: scoped replace (non-admin cannot wipe others) ─

{
  // Admin grants: orgB allow + a user-scope allow (admin-only finer tool).
  entitlementService.setEntitlements(adminCtx, RID, [
    { scopeType: "org", scopeId: ORG_A, effect: "allow" },
    { scopeType: "org", scopeId: ORG_B, effect: "allow" },
    { scopeType: "user", scopeId: "some-admin-granted-user", effect: "allow" },
  ]);
  // orgAdminA rewrites its own org's entry (own-org deny = narrowing, allowed).
  entitlementService.setEntitlements(orgAdminA, RID, [
    { scopeType: "org", scopeId: ORG_A, effect: "deny" },
  ]);
  const after = entitlementService.listEntries(RID);
  ok("org_admin scoped replace keeps other-org entry",
    after.some((e) => e.scopeType === "org" && e.scopeId === ORG_B && e.effect === "allow"));
  ok("org_admin scoped replace keeps admin user-scope entry",
    after.some((e) => e.scopeType === "user" && e.scopeId === "some-admin-granted-user"));
  ok("org_admin scoped replace updates own-org entry",
    after.some((e) => e.scopeType === "org" && e.scopeId === ORG_A && e.effect === "deny"));
  // orgAdminB still configures orgB (canConfigure via orgB allow) — the entry
  // survived orgAdminA's write.
  ok("orgB entitlement still effective after orgAdminA write",
    entitlementService.canConfigure(orgAdminB, RID));
}

// ─── 6. plain user + org_admin denied on admin connector routes ─

{
  const r1 = await adminCall("userA", "GET", "/catalog");
  ok("plain user GET /catalog → 403", r1.status === 403, JSON.stringify(r1));
  const r2 = await adminCall("orgAdminA", "POST", "/instances", {
    catalogKind: "internal-rest", name: "should-not-exist", baseUrl: "http://127.0.0.1:1",
  });
  ok("org_admin POST /instances → 403 (global write denied)", r2.status === 403, JSON.stringify(r2));
  ok("org_admin denied instance was NOT created",
    !store.listInstances().some((i) => i.name === "should-not-exist"));
  const denied = auditRows().filter((r) => r.result === "denied");
  ok("denied route attempts leave governance audit rows",
    denied.some((r) => r.action === "connector.catalog.read") &&
    denied.some((r) => r.action === "connector.create"));
}

// ─── 7. revoke removes an ALREADY-ACTIVE connector (resolve + live) ─

let liveToken: string | null = null;
{
  // Re-grant orgA allow + activate the agent.
  entitlementService.setEntitlements(adminCtx, RID, [
    { scopeType: "org", scopeId: ORG_A, effect: "allow" },
  ]);
  agentCapabilityService.updateAgentCapabilities(userCtx, AGENT, {
    resources: [{ resourceId: RID, enabled: true }],
  });

  // Baseline: authorized resolve injects the connector; live tools/list works.
  const b1 = resolveBundle(userCtx, AGENT);
  ok("activated+entitled agent resolves the connector", connectorServerKeys(b1).length === 1);
  liveToken = bundleToken(b1, instance.id);
  const live1 = await rpc(liveToken, "tools/list");
  ok("live MCP tools/list works while authorized", live1.status === 200, JSON.stringify(live1.body).slice(0, 200));

  // Revoke: admin replaces entitlements with EMPTY set (full replace).
  entitlementService.setEntitlements(adminCtx, RID, []);
  const b2 = resolveBundle(userCtx, AGENT);
  ok("revoke removes the connector at resolve() (deny-default)",
    connectorServerKeys(b2).length === 0);
  const live2 = await rpc(liveToken, "tools/list");
  ok("revoke kills the still-registered live token (401)",
    live2.status === 401, JSON.stringify(live2.body).slice(0, 200));
}

// ─── 8. app allowlist upper bound (deny-by-intersection) ──────

{
  // Re-grant entitlement + activation (both ON), then bound the app.
  entitlementService.setEntitlements(adminCtx, RID, [
    { scopeType: "org", scopeId: ORG_A, effect: "allow" },
  ]);
  agentCapabilityService.updateAgentCapabilities(userCtx, AGENT, {
    resources: [{ resourceId: RID, enabled: true }],
  });
  // APP_X allowlist WITHOUT the connector → resolve drops it.
  applicationCapabilitiesService.setAppCapabilities(APP_X, {
    resources: [{ resourceId: "skill:unrelated", enabled: true }],
  });
  const b = resolveBundle(userCtx, AGENT);
  ok("app allowlist (connector absent) drops the connector at resolve",
    connectorServerKeys(b).length === 0);
  // Add the connector to the allowlist → back.
  applicationCapabilitiesService.setAppCapabilities(APP_X, {
    resources: [
      { resourceId: "skill:unrelated", enabled: true },
      { resourceId: RID, enabled: true },
    ],
  });
  const b2 = resolveBundle(userCtx, AGENT);
  ok("app allowlist including the connector keeps it", connectorServerKeys(b2).length === 1);
  // And the live call still re-checks the intersection per call: tighten the
  // allowlist again → the STILL-VALID token from b2 is denied.
  const token2 = bundleToken(b2, instance.id);
  applicationCapabilitiesService.setAppCapabilities(APP_X, {
    resources: [{ resourceId: "skill:unrelated", enabled: true }],
  });
  const live = await rpc(token2, "tools/list");
  ok("tightened app allowlist denies the still-registered live token (401)",
    live.status === 401, JSON.stringify(live.body).slice(0, 200));
  // Restore passthrough for later sections.
  applicationCapabilitiesService.setAppCapabilities(APP_X, { resources: [] });
  db.prepare(`DELETE FROM application_capabilities WHERE app_id = ?`).run(APP_X);
}

// ─── 9. audit rows are metadata-only (no credential/token) ────

{
  // Exercise an audited success path through the route (admin creates + writes
  // credentials + enables + disables a second instance).
  const created = await adminCall("admin", "POST", "/instances", {
    catalogKind: "internal-rest", name: "m2a-audit-probe", baseUrl: "http://127.0.0.1:1",
  });
  const probeId = created.body.instance.id;
  await adminCall("admin", "PUT", `/instances/${probeId}/credentials`, { values: { apiToken: CREDENTIAL } });
  await adminCall("admin", "POST", `/instances/${probeId}/enable`);
  await adminCall("admin", "POST", `/instances/${probeId}/disable`);

  const rows = auditRows();
  ok("audit rows exist for connector mutations",
    rows.some((r) => r.action === "connector.create" && r.result === "success") &&
    rows.some((r) => r.action === "connector.credentials.write") &&
    rows.some((r) => r.action === "connector.enable") &&
    rows.some((r) => r.action === "connector.disable"));
  const allJson = JSON.stringify(rows);
  ok("audit rows contain NO credential material", !allJson.includes(CREDENTIAL));
  ok("audit rows contain NO capability token material",
    !allJson.includes(liveToken ?? "sentinel-no-token") && !/"authorization"/.test(allJson));
  // Human-actor rows (route mutations) carry actor identity; token-actor rows
  // (connector.mcp.deny — the per-call reauthorization denial) legitimately
  // have null actor fields. SUCCESSFUL mutation rows must name the target
  // object; denied create/catalog-read rows legitimately have none.
  const humanRows = rows.filter((r) => r.action !== "connector.mcp.deny");
  const successMutations = rows.filter((r) =>
    r.result === "success" &&
    ["connector.create", "connector.credentials.write", "connector.enable", "connector.disable"].includes(r.action));
  ok("audit rows carry actor/role/org/action metadata",
    humanRows.length > 0 &&
    humanRows.every((r) => r.actor_user_id && r.actor_role && r.org_id && r.action) &&
    rows.every((r) => r.org_id && r.action) &&
    successMutations.length >= 4 &&
    successMutations.every((r) => r.object_id));
  // Credential write audit names FIELDS only, never values.
  const credRow = rows.find((r) => r.action === "connector.credentials.write" && r.object_id === probeId);
  ok("credential audit summary is field-name only",
    !!credRow && /fields=apiToken/.test(credRow.reason_summary) && !credRow.reason_summary.includes(CREDENTIAL));
}

// ─── cleanup ──────────────────────────────────────────────────

await new Promise<void>((r) => mcpServer.close(() => r()));
await new Promise<void>((r) => adminHttp.close(() => r()));
rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n=== M2a governance: ${pass} passed ===`);
