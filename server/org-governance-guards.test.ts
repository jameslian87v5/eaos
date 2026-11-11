// M1 (org governance) — regression test for the two status-guard gaps found in
// the b214c7e对抗 review (evt_20260811065354):
//
//   Gap 1 (AppKey 签发): POST /api/admin/applications/:id/key must check the
//     TARGET app's org status, with NO admin exemption (admin may not mint keys
//     for a suspended department — admin reactivates first). Cross-org stays 404.
//   Gap 2 (resource creation): legacy POST /api/chats (+ /api/agents via the same
//     createResourceRoutes) and app-scoped POST /api/apps/:appId/agents must refuse
//     new resources for a suspended org (the allowed M1 residual is an open WS
//     session only). orgId comes from the server-trusted JWT claim, not the body.
//
// Coverage choice:
//   - Gap 1 is proven at ROUTE LEVEL (real HTTP against createAdminAppRoutes on
//     a throwaway Express app with a field-injecting stub — no Express harness
//     exists project-wide, but this router does no internal auth so it mounts
//     cleanly). This catches any future removal of the guard line.
//   - Gap 2's router (createResourceRoutes) lives inside server.ts (not exported
//     — importing server.ts boots the whole process). Per the project convention
//     (phase7-org-admin.test.ts: "HTTP-level wiring is code-reviewed — the
//     project has no Express test harness"), the guard predicate + its server-
//     trusted orgId source are pinned deterministically here, and the route
//     wiring is verified by code review.
//
// Run: DB_PATH=/tmp/m1-guards-test.db npx tsx server/org-governance-guards.test.ts
import assert from "node:assert/strict";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import db from "./database.js";
import { applicationService } from "./application-service.js";
import { createAdminAppRoutes } from "./admin-app-routes.js";
import {
  provisionOrg,
  transitionOrgStatus,
  assertOrgActive,
  isOrgActive,
  OrgNotActiveError,
} from "./org-governance.js";
import { getUserById, insertUserRow } from "./auth.js";
import { v4 as uuidv4 } from "uuid";

const TEST_PASS = "Passw0rd";

function resetState() {
  db.exec(`DELETE FROM governance_audit_log`);
  db.exec(`DELETE FROM application_capabilities`);
  db.exec(`DELETE FROM users WHERE org_id LIKE 'm1g-%'`);
  db.exec(`DELETE FROM applications WHERE org_id LIKE 'm1g-%'`);
  db.exec(`DELETE FROM org_quotas WHERE org_id LIKE 'm1g-%'`);
  db.exec(`DELETE FROM organizations WHERE id LIKE 'm1g-%'`);
}

/** Mount createAdminAppRoutes with a stub that injects identity fields (the
 * router does no internal auth — auth is the host's job). Returns a base URL on
 * an ephemeral port. Caller must `close()` when done. */
function startAdminApp(stubRole: string, stubOrgId: string, stubUserId = "admin-x"): {
  base: string;
  close: () => void;
} {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Mirror what authMiddleware + ctxFromReq read. These are the server-trusted
    // fields (in production: derived from the JWT, never the request body).
    (req as any).userId = stubUserId;
    (req as any).userRole = stubRole;
    (req as any).orgId = stubOrgId;
    next();
  });
  app.use("/", createAdminAppRoutes());
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function postKey(base: string, appId: string): Promise<globalThis.Response> {
  return fetch(`${base}/applications/${encodeURIComponent(appId)}/key`, {
    method: "POST",
  });
}

// ─── Gap 1: AppKey 签发 — route level ──────────────────────────────────
// AppKey signing is the path the prior audit-FK bug masked: the route used to
// log via eventStore.appendEvent(appId, …) into agent_events whose chat_id
// FK→chats(id); appId is never a chat, so the audit INSERT threw AFTER the key
// was persisted and the catch masked the 201 as 404. The fix switches ONLY this
// route's audit to the metadata-only governance_audit_log sink (no FK to chats).
// Below: active target → 201 + one-time key returned + persisted; suspended →
// 403 org_not_active + no key; cross-org → 404.
{
  resetState();
  const suspendedOrg = `m1g-susp-${Date.now()}`;
  const activeOrg = `m1g-active-${Date.now()}`;
  await provisionOrg({ id: suspendedOrg, name: "Susp Dept", firstAdminUsername: `s_${suspendedOrg}`, firstAdminPassword: TEST_PASS, actorUserId: "x", actorRole: "admin" });
  await provisionOrg({ id: activeOrg, name: "Active Dept", firstAdminUsername: `a_${activeOrg}`, firstAdminPassword: TEST_PASS, actorUserId: "x", actorRole: "admin" });

  const suspApp = applicationService.createApplication({
    name: "Suspended Dept App", description: null, profileId: null, entryUrl: null,
    systemPrompt: null, appendSystemPrompt: null, toolAllowlist: null, orgId: suspendedOrg,
  });
  const activeApp = applicationService.createApplication({
    name: "Active Dept App", description: null, profileId: null, entryUrl: null,
    systemPrompt: null, appendSystemPrompt: null, toolAllowlist: null, orgId: activeOrg,
  });
  const keyPrefixOf = (id: string) =>
    (applicationService.getApplication(id) as { apiKeyPrefix?: string | null } | undefined)?.apiKeyPrefix ?? null;
  assert.equal(keyPrefixOf(suspApp.id), null, "no key before any mint");
  assert.equal(keyPrefixOf(activeApp.id), null, "no key before any mint");

  // suspend the first dept
  transitionOrgStatus({ orgId: suspendedOrg, action: "suspend", actorUserId: "x", actorRole: "admin" });
  assert.equal(isOrgActive(suspendedOrg), false);
  assert.equal(isOrgActive(activeOrg), true);

  // (a) ADMIN operating a suspended-org app → 403 org_not_active (no admin
  //     bypass; the TARGET dept's status governs). Key NOT generated.
  {
    const { base, close } = startAdminApp("admin", "default-org");
    const res = await postKey(base, suspApp.id);
    assert.equal(res.status, 403, "admin minting key for suspended-org app → 403");
    const body = await res.json().catch(() => ({}));
    assert.equal(body.code, "org_not_active", "403 carries org_not_active code");
    close();
  }
  assert.equal(keyPrefixOf(suspApp.id), null, "suspended-org app: NO key generated (guard blocked before key-gen)");

  // (b) same admin on an ACTIVE-org app → 201 + one-time key returned + persisted.
  {
    const { base, close } = startAdminApp("admin", "default-org");
    const res = await postKey(base, activeApp.id);
    assert.equal(res.status, 201, "active-org app: 201 (audit no longer masks success)");
    const body = (await res.json().catch(() => ({}))) as { key?: string; prefix?: string };
    assert.ok(body.key, "active-org app: one-time key returned to client");
    assert.ok(body.prefix, "active-org app: prefix returned");
    assert.equal(keyPrefixOf(activeApp.id), body.prefix, "persisted prefix matches returned prefix");
    close();
  }

  // (c) cross-org org_admin (different org) hitting either app → 404 (existence
  //     hidden; appAccessible runs before the status guard, so no leak via 403).
  {
    const { base, close } = startAdminApp("org_admin", "m1g-other-" + Date.now());
    const resSusp = await postKey(base, suspApp.id);
    const resActive = await postKey(base, activeApp.id);
    assert.equal(resSusp.status, 404, "cross-org org_admin → 404 (no existence leak)");
    assert.equal(resActive.status, 404, "cross-org org_admin → 404");
    close();
  }

  // (d) reactivate the suspended dept → 201 + one-time key returned + persisted.
  transitionOrgStatus({ orgId: suspendedOrg, action: "activate", actorUserId: "x", actorRole: "admin" });
  {
    const { base, close } = startAdminApp("admin", "default-org");
    const res = await postKey(base, suspApp.id);
    assert.equal(res.status, 201, "reactivated suspApp: 201 (guard no longer fires)");
    const body = (await res.json().catch(() => ({}))) as { key?: string; prefix?: string };
    assert.ok(body.key, "reactivated suspApp: one-time key returned");
    assert.equal(keyPrefixOf(suspApp.id), body.prefix, "reactivated: persisted prefix matches returned");
    close();
  }

  console.log("[M1-gap1] AppKey route-level: suspended target → 403 org_not_active + no key (no admin bypass); active → 201 + key returned/persisted; cross-org → 404; reactivate → 201 + key returned/persisted");
}

// ─── Gap 2: resource creation guard (predicate + trusted orgId source) ──
{
  resetState();
  const suspendedOrg = `m1g-res-susp-${Date.now()}`;
  const activeOrg = `m1g-res-active-${Date.now()}`;
  await provisionOrg({ id: suspendedOrg, name: "RSusp", firstAdminUsername: `rs_${suspendedOrg}`, firstAdminPassword: TEST_PASS, actorUserId: "x", actorRole: "admin" });
  await provisionOrg({ id: activeOrg, name: "RActive", firstAdminUsername: `ra_${activeOrg}`, firstAdminPassword: TEST_PASS, actorUserId: "x", actorRole: "admin" });
  transitionOrgStatus({ orgId: suspendedOrg, action: "suspend", actorUserId: "x", actorRole: "admin" });

  // Pin the GUARD PREDICATE both resource-creation routes call before delegating
  // to store.createChat / agentService.createAgentForApp:
  //   if (role !== "admin") assertOrgActive(orgId);
  // A non-admin operator of the suspended org is rejected; the store is never
  // reached. (Route wiring code-reviewed per phase7-org-admin.test.ts convention.)
  assert.throws(
    () => assertOrgActive(suspendedOrg),
    (e) => e instanceof OrgNotActiveError,
    "suspended org → resource-creation guard throws (chat/agent creation refused)"
  );
  assert.doesNotThrow(
    () => assertOrgActive(activeOrg),
    "active org → guard passes (creation proceeds)"
  );

  // Pin the orgId SOURCE: the route reads (req as any).orgId, which authMiddleware
  // sets from the JWT claim baked at login from users.org_id (never the body).
  // A suspended-org user's orgId IS the suspended org — so the guard rejects them
  // regardless of any client-sent value (there is no orgId read from the body).
  const suspendedUserId = uuidv4();
  insertUserRow({
    id: suspendedUserId,
    username: `suspended_user_${Date.now()}`,
    passwordHash: "$2b$10$dummyhashdummyhashdummyhashdummyhashdummyhashdummy",
    displayName: "Suspended Org User",
    role: "org_admin",
    mustChangePassword: 0,
    orgId: suspendedOrg,
    createdAt: new Date().toISOString(),
  });
  const u = getUserById(suspendedUserId);
  assert.ok(u, "suspended-org user exists");
  assert.equal(u!.orgId, suspendedOrg, "user's trusted orgId is the suspended org");
  assert.throws(
    () => assertOrgActive(u!.orgId),
    (e) => e instanceof OrgNotActiveError,
    "guard on the user's trusted orgId rejects — old JWT or not, no new resources"
  );

  // The legacy chat create path passes (req as any).orgId straight to
  // store.createChat — confirm the store is org-agnostic (it does NOT consult
  // status itself; the route is the gate). This pins that the guard is the
  // ONLY status check on this path: removing it reopens the gap.
  const chatStore = (await import("./chat-store.js")).chatStore;
  const newChat = chatStore.createChat(suspendedUserId, "should-not-happen-via-route", suspendedOrg);
  assert.ok(newChat, "store itself is org-agnostic — the ROUTE guard is the gate");
  assert.equal((newChat as { orgId: string }).orgId, suspendedOrg);

  console.log("[M1-gap2] resource-creation guard predicate + trusted orgId source pinned (route wiring code-reviewed per convention)");
}

console.log("\norg-governance-guards (M1 gaps) tests passed");
