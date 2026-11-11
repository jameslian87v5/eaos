/**
 * app-routes.ts — Phase 6 (A1) app-scoped REST routes.
 *
 * Routes mounted under /api/apps/:appId/ — dual-identity auth (appAuthMiddleware).
 * Internally reuses agentService + chatStore, but with DB-backed app filtering
 * (listByApp, getOwnedAppAgent) and atomic app_id assignment (createAgentForApp).
 *
 * Codex A1 review:
 *   - appId consistency checked in middleware (key vs URL)
 *   - handler re-checks agents.app_id (resource belongs to that app)
 *   - WS ?appKey= is MVP debt — redact in logs
 *
 * See docs/02-architecture/platform-application-layer-architecture.md
 */

import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { agentService } from "./agent-service.js";
import { chatStore } from "./chat-store.js";
import { applicationService } from "./application-service.js";
import { appAuthMiddleware, appCtxFromReq, type AppRequestContext } from "./app-auth.js";
import { signWidgetToken } from "./auth.js";
import { assertOrgActive, OrgNotActiveError } from "./org-governance.js";
import { assertQuota, QuotaExceededError } from "./quota-service.js";
import { eventStore, type AgentEvent } from "./event-store.js";

// ─── Event payload redaction ─────────────────────────────────
const SENSITIVE_KEYS = /^(password|secret|token|apikey|api_key|authorization|credential|private_key)$/i;

function redactObj(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactObj);
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactObj(value);
    }
  }
  return result;
}

function toEventDTO(event: AgentEvent, raw: boolean) {
  let payload: any;
  try {
    const json = JSON.parse(event.payloadJson);
    payload = raw ? json : redactObj(json);
  } catch {
    payload = { parseError: true, raw: event.payloadJson };
  }
  return {
    id: event.id,
    sequence: event.sequence,
    eventType: event.eventType,
    createdAt: event.createdAt,
    payload,
  };
}

// ─── Router ──────────────────────────────────────────────────

/**
 * Set the shared delete cleanup handler. Called once from server.ts during
 * initialization to avoid circular dependency (server.ts owns sessions/containerManager).
 */
let _deleteAgentCleanup: ((userId: string, chatId: string) => Promise<void>) | null = null;
export function setDeleteAgentCleanup(fn: (userId: string, chatId: string) => Promise<void>): void {
  _deleteAgentCleanup = fn;
}

export function createAppRoutes(): express.Router {
  const router = express.Router();

  // All app-scoped routes require dual-identity auth
  router.use("/apps/:appId", appAuthMiddleware);

  // ─── List agents in app ──────────────────────────────────
  router.get("/apps/:appId/agents", (req: Request, res: Response) => {
    const ctx = appCtxFromReq(req);
    const agents = agentService.listByApp(ctx.userId, ctx.appId, ctx.orgId);
    res.json(agents);
  });

  // ─── Create agent in app ─────────────────────────────────
  router.post("/apps/:appId/agents", (req: Request, res: Response) => {
    const ctx = appCtxFromReq(req);
    // M1 status gate (touchpoint: 资源创建 — app-scoped agent). ctx.orgId is the
    // appAuth-resolved org (server-trusted; equals the user JWT org by the dual-
    // identity check), not a client-sent value. admin exempt.
    if (ctx.role !== "admin") {
      try {
        assertOrgActive(ctx.orgId);
      } catch (e) {
        if (e instanceof OrgNotActiveError) {
          res.status(403).json({ error: e.message, code: "org_not_active" });
          return;
        }
        throw e;
      }
      // M5 quota gate (touchpoint: create Agent — app-scoped). Same
      // maxAgents ceiling as the shared /api/chats + /api/agents routes; without
      // this an app could create unlimited agents (codex fix #1). admin exempt.
      try {
        assertQuota(ctx.orgId, "agents", {
          audit: { actorUserId: ctx.userId, actorRole: ctx.role },
        });
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          res.status(429).json({ error: e.message, code: "quota_exceeded", dimension: e.dimension });
          return;
        }
        throw e;
      }
    }
    const agent = agentService.createAgentForApp(ctx.userId, ctx.appId, req.body?.title, ctx.orgId);
    res.status(201).json(agent);
  });

  // ─── Get single agent in app ─────────────────────────────
  router.get("/apps/:appId/agents/:agentId", (req: Request, res: Response) => {
    const ctx = appCtxFromReq(req);
    // DB-backed ownership + app scope check (Codex A1 finding 3)
    const agent = agentService.getOwnedAppAgent(req.params.agentId, ctx.userId, ctx.appId, ctx.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found or not in this app" });
      return;
    }
    res.json(agent);
  });

  // ─── Delete agent in app ─────────────────────────────────
  router.delete("/apps/:appId/agents/:agentId", async (req: Request, res: Response) => {
    const ctx = appCtxFromReq(req);
    // Verify ownership + app scope before deleting
    const agent = agentService.getOwnedAppAgent(req.params.agentId, ctx.userId, ctx.appId, ctx.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found or not in this app" });
      return;
    }
    // Codex A1 review finding 3: must match legacy cleanup semantics
    // (close session, stop Docker runtime, remove volumes, delete DB records).
    if (_deleteAgentCleanup) {
      await _deleteAgentCleanup(ctx.userId, req.params.agentId);
    } else {
      agentService.deleteChat(req.params.agentId);
    }
    res.json({ success: true });
  });

  // ─── Get messages for agent in app ───────────────────────
  router.get("/apps/:appId/agents/:agentId/messages", (req: Request, res: Response) => {
    const ctx = appCtxFromReq(req);
    const agent = agentService.getOwnedAppAgent(req.params.agentId, ctx.userId, ctx.appId, ctx.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found or not in this app" });
      return;
    }
    const messages = agentService.getMessages(req.params.agentId);
    res.json(messages);
  });

  // ─── Get events for agent in app (A4) ────────────────────
  router.get("/apps/:appId/agents/:agentId/events", (req: Request, res: Response) => {
    const ctx = appCtxFromReq(req);
    const agent = agentService.getOwnedAppAgent(req.params.agentId, ctx.userId, ctx.appId, ctx.orgId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found or not in this app" });
      return;
    }

    // Parse and validate pagination params
    const rawFrom = Number(req.query.from);
    const rawLimit = Number(req.query.limit);
    if (req.query.from !== undefined && (Number.isNaN(rawFrom) || rawFrom < 1)) {
      res.status(400).json({ error: "Invalid 'from' parameter (must be a positive integer)" });
      return;
    }
    if (req.query.limit !== undefined && (Number.isNaN(rawLimit) || rawLimit < 1)) {
      res.status(400).json({ error: "Invalid 'limit' parameter (must be a positive integer)" });
      return;
    }
    const fromSeq = Math.max(1, Math.floor(rawFrom || 1));
    let limit = Math.min(500, Math.floor(rawLimit || 100));

    // Fetch limit+1 to compute hasMore
    const events = eventStore.getEventsByChatPaginated(ctx.userId, req.params.agentId, fromSeq, limit + 1);
    const hasMore = events.length > limit;
    const pageEvents = hasMore ? events.slice(0, limit) : events;
    const nextFrom = pageEvents.length > 0
      ? pageEvents[pageEvents.length - 1].sequence + 1
      : fromSeq;

    // raw=true only for admin
    const raw = req.query.raw === "true" && ctx.role === "admin";

    res.json({
      events: pageEvents.map((e) => toEventDTO(e, raw)),
      nextFrom,
      hasMore,
    });
  });

  // ─── Widget token mint (platform Widget SDK v0) ─────────
  // Browser-embeddable short-lived token. Minted by the application's BFF,
  // which holds the AppKey + a user/service JWT (this route is under
  // appAuthMiddleware, so both principals are already validated). The
  // browser receives ONLY the widgetToken — never the AppKey. On WS connect
  // the token resolves into the same {appId, userId, role} principal the
  // app-scoped path uses (no third downstream auth branch).
  //
  // Agent binding is mint-time: if the caller passes an existing agentId it
  // must already belong to this user+app; otherwise a fresh agent is created
  // under the app. The agentId is embedded in the token so the iframe knows
  // which agent to subscribe to (server re-verifies ownership on subscribe).
  router.post("/apps/:appId/widget-tokens", (req: Request, res: Response) => {
    const ctx = appCtxFromReq(req);
    // M1 status gate (touchpoint: Widget token 签发). Do not mint a widget
    // token for an app whose org is not active. admin is exempt.
    if (ctx.role !== "admin") {
      try {
        assertOrgActive(ctx.orgId);
      } catch (e) {
        if (e instanceof OrgNotActiveError) {
          res.status(403).json({ error: e.message, code: "org_not_active" });
          return;
        }
        throw e;
      }
    }
    const body = req.body || {};
    const requestedAgentId =
      typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;

    let agentId: string;
    if (requestedAgentId) {
      const owned = agentService.getOwnedAppAgent(requestedAgentId, ctx.userId, ctx.appId, ctx.orgId);
      if (!owned) {
        res.status(403).json({ error: "Agent not found or not in this app" });
        return;
      }
      agentId = owned.id;
    } else {
      // M5 quota gate (touchpoint: widget-token implicit Agent creation). A
      // widget token with no requestedAgentId mints a NEW agent — it must honor
      // the org's maxAgents ceiling (codex fix #1, same as /apps/:appId/agents).
      // admin exempt. Runs after the status gate above.
      if (ctx.role !== "admin") {
        try {
          assertQuota(ctx.orgId, "agents", {
            audit: { actorUserId: ctx.userId, actorRole: ctx.role },
          });
        } catch (e) {
          if (e instanceof QuotaExceededError) {
            res.status(429).json({ error: e.message, code: "quota_exceeded", dimension: e.dimension });
            return;
          }
          throw e;
        }
      }
      const agent = agentService.createAgentForApp(
        ctx.userId,
        ctx.appId,
        typeof body.title === "string" ? body.title : undefined,
        ctx.orgId
      );
      agentId = agent.id;
    }

    const pageSessionId =
      typeof body.pageSessionId === "string" && body.pageSessionId
        ? body.pageSessionId
        : `ps_${randomUUID()}`;
    const origin = typeof body.origin === "string" ? body.origin : undefined;

    const token = signWidgetToken({
      appId: ctx.appId,
      userId: ctx.userId,
      // Widget tokens are browser-held and scoped to one agent's WS path; the
      // role here only affects runtime capability resolution, where org_admin
      // has no super-user powers (same as user). admin stays admin.
      role: ctx.role === "admin" ? "admin" : "user",
      agentId,
      pageSessionId,
      origin,
    });

    res.status(201).json({ token, expiresIn: 1800, pageSessionId, agentId });
  });

  return router;
}

// ─── WS app-scoped helper ────────────────────────────────────

/**
 * Verify that an agent belongs to the authenticated app before allowing
 * WS subscribe/chat. Called from the WS handler in server.ts.
 *
 * @returns true if agent exists and belongs to this user + app
 */
export function verifyAppAgentAccess(
  agentId: string,
  userId: string,
  appId: string,
  orgId: string
): boolean {
  const agent = agentService.getOwnedAppAgent(agentId, userId, appId, orgId);
  return !!agent;
}
