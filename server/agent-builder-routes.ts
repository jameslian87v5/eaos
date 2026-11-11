/**
 * agent-builder-routes.ts — Octop absorption M6a route layer for the governed
 * expert-creation contract (extracted following createAdminSkillImportRoutes).
 *
 * Any AUTHENTICATED user may read options and create agents (that is the
 * terminal-user journey); the capability upper bound inside the service is
 * the authority (entitlement ∩ default-app allowlist ∩ governance), so
 * nothing here trusts the client. Audits are metadata-only: template id,
 * capability count and name LENGTH — never prompt/welcome text.
 *
 * Fix-round: denial codes preserve the platform contract — 403
 * org_not_active and 429 quota_exceeded (same as the legacy create routes);
 * clientRequestId passes through for server-side idempotency.
 *
 * Endpoints (mounted at /api/agent-builder with authMiddleware):
 *   GET  /options → { templates, capabilities }
 *   POST /        → { agent }   body: CreateExpertAgentInput
 */
import express from "express";
import type { Request, Response } from "express";
import { ctxFromReq } from "./request-context.js";
import { writeGovernanceAudit } from "./org-governance.js";
import {
  getBuilderOptions,
  createExpertAgent,
  AgentBuilderError,
  type CreateExpertAgentInput,
} from "./agent-builder.js";

// Fix-round: code → HTTP status (platform contract parity).
const DENIAL_STATUS: Record<string, number> = {
  capability_not_allowed: 403,
  org_not_active: 403,
  quota_exceeded: 429,
};

export function createAgentBuilderRoutes(): express.Router {
  const router = express.Router();

  router.get("/options", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    try {
      res.json(getBuilderOptions(ctx));
    } catch (err) {
      console.error("[agent-builder] options error:", err);
      res.status(500).json({ error: "Failed to load builder options" });
    }
  });

  router.post("/", express.json({ limit: "256kb" }), (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const body = (req.body ?? {}) as Partial<CreateExpertAgentInput>;
    if (typeof body.templateId !== "string" || body.templateId.trim() === "") {
      return res.status(400).json({ error: "Body must include a string templateId", code: "unknown_template" });
    }
    try {
      const agent = createExpertAgent(ctx, {
        templateId: body.templateId,
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
        welcomeMessage: typeof body.welcomeMessage === "string" ? body.welcomeMessage : undefined,
        quickPrompts: Array.isArray(body.quickPrompts) ? body.quickPrompts : undefined,
        capabilityIds: Array.isArray(body.capabilityIds) ? body.capabilityIds : undefined,
        clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : undefined,
      });
      writeGovernanceAudit({
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        orgId: ctx.orgId,
        action: "agent.create",
        objectType: "agent",
        objectId: agent.id,
        result: "success",
        // Metadata-only: template + counts + name length (never prompt text).
        reasonSummary: `expert create: template=${body.templateId}, caps=${(body.capabilityIds ?? []).length}, nameLen=${agent.title.length}`,
      });
      return res.status(201).json({ agent });
    } catch (err) {
      const code = err instanceof AgentBuilderError ? err.code : "create_failed";
      const denied = code in DENIAL_STATUS;
      writeGovernanceAudit({
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        orgId: ctx.orgId,
        action: "agent.create",
        objectType: "agent",
        objectId: null,
        result: denied ? "denied" : "failure",
        reasonSummary: `rejected (${code})`,
      });
      if (err instanceof AgentBuilderError) {
        const status = DENIAL_STATUS[code] ?? 400;
        const payload: Record<string, unknown> = { error: err.message, code };
        if (code === "quota_exceeded") payload.dimension = "agents";
        return res.status(status).json(payload);
      }
      console.error("[agent-builder] create error:", err);
      return res.status(500).json({ error: "Failed to create agent", code });
    }
  });

  return router;
}
