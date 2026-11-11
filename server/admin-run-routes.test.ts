/**
 * admin-run-routes.test.ts — Agent OS M3 (plan §7): HTTP tests for
 * GET /api/admin/runs/:runId + subject-leak regression.
 *
 * Covers the focused HTTP matrix (M3 r1 brief #3):
 *   - same-org admin → 200 + redacted body
 *   - user / org_admin / cross-org admin / nonexistent run → 404 (existence hidden)
 *   - response contains NO raw subject, credentials, message body, or Tool payload
 *
 * And the subject-redaction regression (M3 r1 brief #1): a run created under
 * an app principal must NOT leak the raw `subject` value — only the opaque
 * principalId + principalType.
 *
 * Pattern: build an express app, stub identity middleware (mirrors
 * application-access.test.ts startAdminApp), mount the REAL
 * createAdminRunRoutes() router, fetch on port 0.
 *
 * Run: DB_PATH=/tmp/test-m3-run-routes.db JWT_SECRET=test npx tsx server/admin-run-routes.test.ts
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import jwt from "jsonwebtoken";
import express from "express";
import type { Request, Response, NextFunction } from "express";

// ─── Env before imports ──────────────────────────────────────
const TMP_DB = "/tmp/test-m3-run-routes.db";
process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = "m3-run-routes-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
rmSync(TMP_DB, { force: true });

const JWT_SECRET = process.env.JWT_SECRET;

const db = (await import("./database.js")).default;
const { agentRunService } = await import("./agent-run-service.js");
const { createAdminRunRoutes } = await import("./admin-run-routes.js");
const { getOrCreateAppPrincipal } = await import("./app-principal.js");
const { applicationService } = await import("./application-service.js");
const { chatStore } = await import("./chat-store.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
const { verifyToken, verifyUserTokenCurrent } = await import("./auth.js");

// ─── Helpers ─────────────────────────────────────────────────

function startApp(stubRole: string, stubOrgId: string, stubUserId = "actor-admin"): { base: string; close: () => void } {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).userId = stubUserId;
    (req as any).userRole = stubRole;
    (req as any).orgId = stubOrgId;
    next();
  });
  app.use("/api/admin", createAdminRunRoutes());
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function insertPlatformUser(userId: string, orgId: string, role: string): void {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status, token_version, must_change_password, created_at)
     VALUES (?, ?, 'x', ?, ?, 'active', 1, 0, datetime('now'))`
  ).run(userId, `u_${userId}`, role, orgId);
}

/** Create a finalized run owned by `principalId` in `orgId`, return its runId. */
function makeRun(principalId: string, orgId: string, chatId: string, agentSessionId: string, role: "admin" | "user" = "user"): string {
  const runId = agentRunService.startRun({ agentSessionId, userId: principalId, chatId, role, orgId });
  agentRunService.finalizeRun(runId, { success: true, costUsd: 0.0123, durationMs: 4567, usage: { inputTokens: 10, outputTokens: 5 } });
  return runId;
}

// ─── Setup ───────────────────────────────────────────────────

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = "m3-run-org-b";
const APP_A = "m3-run-app-a";

// App + app principal with a KNOWN subject string we will hunt for in leaks.
applicationService.createApplication({ id: APP_A, orgId: ORG_A, name: APP_A });
const LEAK_SUBJECT = "leakme-subject-xyz-SECRET";
const appPrincipal = getOrCreateAppPrincipal(APP_A, LEAK_SUBJECT, ORG_A);

// Platform admin (same org) — the requester for the happy path.
const ADMIN_A = "m3-admin-a";
insertPlatformUser(ADMIN_A, ORG_A, "admin");

// A chat + agent_session for the run. chatStore.createChat also inserts the
// agents sibling row (same-id bridge) so computeConfigVersion resolves.
const chat = chatStore.createChat(appPrincipal.principalId, "M3 run chat", ORG_A);
db.prepare(
  `INSERT INTO agent_sessions (id, user_id, chat_id, runtime_type, status, restore_mode, created_at, updated_at)
   VALUES (?, ?, ?, 'local', 'running', 'fresh', datetime('now'), datetime('now'))`
).run("m3-sess-1", appPrincipal.principalId, chat.id);
const AGENT_SESSION_ID = "m3-sess-1";

// Run owned by the APP principal (opaque principalId = appPrincipal.principalId).
const APP_RUN = makeRun(appPrincipal.principalId, ORG_A, chat.id, AGENT_SESSION_ID);

// Run owned by a platform user in ORG_B (cross-org) — needs its own chat +
// agent_session rows so the agent_runs FKs resolve.
insertPlatformUser("m3-user-b", ORG_B, "user");
const chatB = chatStore.createChat("m3-user-b", "M3 run chat B", ORG_B);
db.prepare(
  `INSERT INTO agent_sessions (id, user_id, chat_id, runtime_type, status, restore_mode, created_at, updated_at)
   VALUES (?, ?, ?, 'local', 'running', 'fresh', datetime('now'), datetime('now'))`
).run("m3-sess-b", "m3-user-b", chatB.id);
const CROSS_ORG_RUN = makeRun("m3-user-b", ORG_B, chatB.id, "m3-sess-b");

// ─── Tests ───────────────────────────────────────────────────

// 1. same-org admin → 200; redacted body; NO subject/credentials/payload.
{
  const app = startApp("admin", ORG_A, ADMIN_A);
  try {
    const res = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`);
    assert.equal(res.status, 200, "same-org admin → 200");
    const body = await res.json();
    assert.equal(body.run.id, APP_RUN, "run id matches");
    assert.equal(body.run.status, "success", "finalized status present");
    assert.equal(body.run.principalType, "app_principal", "principalType=app_principal for app principal");
    // Opaque principal ID exposed; raw subject NEVER.
    assert.equal(body.run.principalId, appPrincipal.principalId, "opaque principalId exposed");
    const bodyJson = JSON.stringify(body);
    assert.ok(!bodyJson.includes(LEAK_SUBJECT), "raw subject MUST NOT appear in response");
    assert.ok(!bodyJson.includes("subject"), "no 'subject' key in response");
    assert.ok(!bodyJson.includes("appKey"), "no appKey in response");
    assert.ok(!bodyJson.includes("token"), "no token in response (case-insensitive check skipped; key absence)");
    assert.ok(!bodyJson.includes("toolInput"), "no toolInput in response");
    assert.ok(!bodyJson.includes("toolOutput"), "no toolOutput in response");
    // Cost/duration totals present (non-sensitive).
    assert.equal(body.run.costUsd, 0.0123, "cost total present");
    assert.equal(body.run.durationMs, 4567, "duration total present");
    console.log("✓ H1. same-org admin → 200; opaque principalId; no subject/credentials/toolInput/toolOutput");
  } finally {
    app.close();
  }
}

// 2. user → 404 (existence hidden).
{
  const app = startApp("user", ORG_A, "plain-user");
  try {
    const res = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`);
    assert.equal(res.status, 404, "user → 404");
    console.log("✓ H2. user → 404 (existence hidden)");
  } finally {
    app.close();
  }
}

// 3. org_admin → 404 (M3 defers org_admin access; hidden, not 403).
{
  const app = startApp("org_admin", ORG_A, "oa-user");
  try {
    const res = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`);
    assert.equal(res.status, 404, "org_admin → 404 (deferred in M3)");
    console.log("✓ H3. org_admin → 404 (deferred; existence hidden)");
  } finally {
    app.close();
  }
}

// 4. cross-org admin → 404 (existence hidden, not disclosed as 403).
{
  const app = startApp("admin", ORG_B, "admin-b");
  try {
    const res = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`);
    assert.equal(res.status, 404, "cross-org admin → 404");
    console.log("✓ H4. cross-org admin → 404 (cross-org hidden)");
  } finally {
    app.close();
  }
}

// 5. nonexistent runId → 404 (same-org admin).
{
  const app = startApp("admin", ORG_A, ADMIN_A);
  try {
    const res = await fetch(`${app.base}/api/admin/runs/no-such-run`);
    assert.equal(res.status, 404, "nonexistent run → 404");
    console.log("✓ H5. nonexistent runId → 404");
  } finally {
    app.close();
  }
}

// 6. Tool payload never leaks: stamp a tool_use with sensitive input on the
// run, then assert the HTTP response summary excludes it.
{
  // Record a tool_use event with a credential-bearing input on the app run.
  const eventStore = (await import("./event-store.js")).eventStore;
  eventStore.appendEvent(
    appPrincipal.principalId,
    chat.id,
    AGENT_SESSION_ID,
    "tool_use",
    { toolName: "Write", toolId: "tu-leak", toolInput: { path: "/tmp/secret", content: "CREDENTIALS=sk-leaked-987" } },
    APP_RUN
  );
  const app = startApp("admin", ORG_A, ADMIN_A);
  try {
    const res = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`);
    const body = await res.json();
    const bodyJson = JSON.stringify(body);
    assert.ok(!bodyJson.includes("CREDENTIALS"), "no credential payload in HTTP response");
    assert.ok(!bodyJson.includes("/tmp/secret"), "no tool input path in HTTP response");
    assert.ok(!bodyJson.includes("sk-leaked-987"), "no secret value in HTTP response");
    // tool_use summary carries toolName only.
    const tu = body.events.find((e: any) => e.eventType === "tool_use");
    assert.ok(tu && tu.toolName === "Write", "tool_use summary carries toolName");
    assert.equal(tu.toolInput, undefined, "tool_use summary has NO toolInput field");
    console.log("✓ H6. tool_use toolInput/credentials never leak via HTTP response summary");
  } finally {
    app.close();
  }
}

// ─── H7. PRODUCTION middleware composition (auth → router) ────────────
// Asserts the real server.ts mount: `app.use("/api/admin", authMiddleware,
// createAdminRunRoutes())`. authMiddleware verifies the JWT + injects
// identity; the ROUTER's own isAdminReq gate returns 404 (existence hidden)
// for user/org_admin — NOT the 403 the shared privileged gate would return.
function platformJwt(userId: string, orgId: string, role: string): string {
  return jwt.sign({ userId, username: userId, role, orgId, tokenVersion: 1 }, JWT_SECRET!, { expiresIn: "1h" });
}

/** Replicates server.ts authMiddleware: verifyToken + verifyUserTokenCurrent,
 * inject req.userId/userRole/orgId, then next(). 401 on missing/invalid. */
function productionAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token provided" });
  try {
    const payload = verifyToken(authHeader.slice(7));
    const tokenCheck = verifyUserTokenCurrent(payload);
    if (!tokenCheck.ok) return res.status(401).json({ error: tokenCheck.reason, code: tokenCheck.code });
    (req as any).userId = payload.userId;
    (req as any).userRole = payload.role;
    (req as any).orgId = payload.orgId ?? DEFAULT_ORG_ID;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function startProductionApp(): { base: string; close: () => void } {
  const app = express();
  app.use(express.json());
  // Exact production composition: authMiddleware (no privileged gate) → router.
  app.use("/api/admin", productionAuth, createAdminRunRoutes());
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

{
  // Users for the production-composition assertions below (must exist in the
  // DB so verifyUserTokenCurrent accepts their JWTs).
  insertPlatformUser(ADMIN_A + "-u", ORG_A, "user");
  insertPlatformUser(ADMIN_A + "-oa", ORG_A, "org_admin");
  insertPlatformUser("admin-b", ORG_B, "admin");

  const app = startProductionApp();
  try {
    // ordinary user → 404 (NOT 403): existence hidden by the router's gate.
    const userRes = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`, {
      headers: { authorization: `Bearer ${platformJwt(ADMIN_A + "-u", ORG_A, "user")}` },
    });
    assert.equal(userRes.status, 404, "production: ordinary user → 404 (existence hidden, NOT 403)");

    // org_admin → 404 (deferred in M3; hidden, NOT 403).
    // (org_admin is a privileged role that WOULD pass the shared gate, but the
    // router's admin-only guard still 404s it — proving the route isn't behind
    // the privileged gate here.)
    const oaRes = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`, {
      headers: { authorization: `Bearer ${platformJwt(ADMIN_A + "-oa", ORG_A, "org_admin")}` },
    });
    assert.equal(oaRes.status, 404, "production: org_admin → 404 (deferred; hidden)");

    // same-org admin → 200.
    const adminRes = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`, {
      headers: { authorization: `Bearer ${platformJwt(ADMIN_A, ORG_A, "admin")}` },
    });
    assert.equal(adminRes.status, 200, "production: same-org admin → 200");

    // cross-org admin → 404.
    const crossRes = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`, {
      headers: { authorization: `Bearer ${platformJwt("admin-b", ORG_B, "admin")}` },
    });
    assert.equal(crossRes.status, 404, "production: cross-org admin → 404");

    // nonexistent → 404.
    const noneRes = await fetch(`${app.base}/api/admin/runs/no-such-run`, {
      headers: { authorization: `Bearer ${platformJwt(ADMIN_A, ORG_A, "admin")}` },
    });
    assert.equal(noneRes.status, 404, "production: nonexistent → 404");

    // no token → 401 (auth gate still enforces authentication).
    const noTokenRes = await fetch(`${app.base}/api/admin/runs/${APP_RUN}`);
    assert.equal(noTokenRes.status, 401, "production: no token → 401 (auth gate intact)");

    console.log("✓ H7. production composition (auth→router): user/org_admin/cross-org/nonexistent → 404 (NOT 403); admin → 200; no token → 401");
  } finally {
    app.close();
  }
}

console.log("\nAll M3 admin-run-routes HTTP tests passed.");
