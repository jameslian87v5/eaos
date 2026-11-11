// Phase 7.1 — org-isolation proof test.
//
// Proves the two invariants the slice is built on:
//   1. orgId flows from the trusted source (users.org_id) → baked into the JWT
//      at login → read back by ctxFromReq (the control-plane context). It is
//      never taken from request params/body.
//   2. The data-plane ownership gate (verifyChatOwnership) enforces the tenant
//      invariant: a cross-org caller is denied even if the userId lines up, and
//      createChat persists org_id on BOTH chats and its agents sibling.
//
// Run: DB_PATH=/tmp/phase71-test.db npx tsx server/phase7-org-isolation.test.ts
import assert from "node:assert";
import db from "./database.js";
import { chatStore } from "./chat-store.js";
import { login, verifyToken, register } from "./auth.js";
import { ctxFromReq, DEFAULT_ORG_ID } from "./request-context.js";
import { agentService } from "./agent-service.js";
import { applicationService } from "./application-service.js";
import { verifyWSAppAuth } from "./app-auth.js";
import { applicationAccessGrantsService } from "./application-access.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

// 1. createChat writes chats.org_id + the agents sibling org_id, returns orgId.
const chat = chatStore.createChat("u-tenant", "Tenant chat", ORG_A);
assert.equal(chat.orgId, ORG_A, "createChat returns the chat's orgId");
const chatRow = db.prepare("SELECT org_id AS orgId FROM chats WHERE id = ?").get(chat.id) as { orgId: string };
assert.equal(chatRow.orgId, ORG_A, "chats.org_id persisted");
const agentRow = db.prepare("SELECT org_id AS orgId FROM agents WHERE id = ?").get(chat.id) as { orgId: string };
assert.equal(agentRow.orgId, ORG_A, "agents.org_id persisted (matches chat)");

// 2. verifyChatOwnership enforces org (cross-org deny is the tenant invariant).
assert.equal(chatStore.verifyChatOwnership(chat.id, "u-tenant", ORG_A), true, "owner + same org allowed");
assert.equal(chatStore.verifyChatOwnership(chat.id, "u-tenant", ORG_B), false, "cross-org denied even for the owner id");
assert.equal(chatStore.verifyChatOwnership(chat.id, "intruder", ORG_A), false, "wrong owner denied within the org");
assert.equal(chatStore.verifyChatOwnership(chat.id, "u-tenant"), true, "omitted orgId (backcompat callers) still allowed");

// 3. orgId flows login → JWT claim → verifyToken (trusted source = users.org_id).
const username = `tenant-${Date.now()}`;
await register(username, "Secret123"); // default org
db.prepare("UPDATE users SET org_id = ? WHERE username = ?").run(ORG_A, username);
const { token } = await login(username, "Secret123");
const payload = verifyToken(token);
assert.equal(payload.orgId, ORG_A, "JWT carries the user's orgId from users.org_id");

// 4. ctxFromReq reads the orgId the middleware set on the request (req.orgId),
//    and falls back to DEFAULT_ORG_ID for legacy tokens minted before orgId.
const ctx = ctxFromReq({ userId: "u-tenant", userRole: "user", orgId: ORG_A } as any);
assert.equal(ctx.orgId, ORG_A, "ctxFromReq carries the request orgId");
const legacyCtx = ctxFromReq({ userId: "u-tenant", userRole: "user" } as any);
assert.equal(legacyCtx.orgId, DEFAULT_ORG_ID, "ctxFromReq falls back to DEFAULT_ORG_ID when orgId absent");

// 5. App-scoped paths carry orgId (Phase 7.1 app-scope fix): createAgentForApp
//    writes the caller's org; listByApp + getOwnedAppAgent are DB-backed
//    org-filtered — a cross-org app caller cannot list/get the agent.
const APP = "test-app-7";
const uApp = "u-app";
const created = agentService.createAgentForApp(uApp, APP, "App agent", ORG_A);
assert.equal(created.orgId, ORG_A, "createAgentForApp writes the caller's org onto the agent");
const appAgentRow = db.prepare("SELECT org_id AS orgId, app_id AS appId FROM agents WHERE id = ?").get(created.id) as { orgId: string; appId: string };
assert.equal(appAgentRow.orgId, ORG_A, "agents.org_id persisted for app-scoped create");
assert.equal(appAgentRow.appId, APP, "agents.app_id persisted");

// listByApp is org-scoped: same user+app, different org -> empty.
assert.equal(agentService.listByApp(uApp, APP, ORG_A).length, 1, "listByApp returns the agent in its org");
assert.equal(agentService.listByApp(uApp, APP, ORG_B).length, 0, "listByApp excludes the agent for a different org");

// getOwnedAppAgent is org-scoped: cross-org caller gets undefined (404 at the route).
assert.ok(agentService.getOwnedAppAgent(created.id, uApp, APP, ORG_A), "getOwnedAppAgent finds the agent in its org");
assert.equal(agentService.getOwnedAppAgent(created.id, uApp, APP, ORG_B), undefined, "getOwnedAppAgent denies cross-org even for the owner");

// 6. App principal must be org-aligned with the user principal (Phase 7.1):
//    an orgA app key paired with an orgB user JWT is a cross-tenant attempt and
//    must be rejected at the auth layer (the gate in front of every app-scoped
//    create/access). Proved end-to-end via verifyWSAppAuth (pure URL -> ctx).
const APP_ORG = "app-test-7";
applicationService.createApplication({ id: APP_ORG, orgId: ORG_A, name: "OrgA app" });
const { key: orgAKey } = applicationService.generateAppKey(APP_ORG);
const keyRes = applicationService.verifyAppKeyWithOrg(orgAKey)!;
assert.equal(keyRes.appId, APP_ORG, "verifyAppKeyWithOrg resolves the appId");
assert.equal(keyRes.orgId, ORG_A, "verifyAppKeyWithOrg returns the app's org");

const mkOrgUser = async (org: string) => {
  const u = `${org}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await register(u, "Secret123");
  db.prepare("UPDATE users SET org_id = ? WHERE username = ?").run(org, u);
  return (await login(u, "Secret123")).token;
};
const orgBToken = await mkOrgUser(ORG_B);
const orgAToken = await mkOrgUser(ORG_A);

const wsOrgB = new URL(`wss://host/api/apps/${APP_ORG}/ws?token=${orgBToken}&appKey=${orgAKey}`);
const wsOrgA = new URL(`wss://host/api/apps/${APP_ORG}/ws?token=${orgAToken}&appKey=${orgAKey}`);
assert.equal(verifyWSAppAuth(wsOrgB), null, "orgA app key + orgB user JWT -> rejected (cross-org)");
// Agent OS M2: even a same-org platform user is denied WITHOUT an access
// grant (deny-default for every app-scoped platform-JWT principal).
assert.equal(verifyWSAppAuth(wsOrgA), null, "same-org user JWT -> rejected without an access grant");
// Seed an org grant for ORG_A → the same-org user is now admitted.
applicationAccessGrantsService.replaceGrants(APP_ORG, { grants: [{ principalType: "org", principalId: ORG_A }] }, "tester");
const sameOrg = verifyWSAppAuth(wsOrgA);
assert.ok(sameOrg, "orgA app key + orgA user JWT -> accepted (same org)");
assert.equal(sameOrg!.ctx.orgId, ORG_A, "accepted ctx carries the aligned org");

console.log("phase7-org-isolation tests passed");
