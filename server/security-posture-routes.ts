/**
 * security-posture-routes.ts — Octop absorption M6b route layer.
 *
 * Mounted at /api/admin/security-posture (authMiddleware + privileged-role
 * gate, same pattern as the other admin routes):
 *   GET   /                                  → SecurityPosture (admin|org_admin)
 *   PATCH /profiles/:profileId/tools         → the ONE narrow write; the body
 *        must be EXACTLY { toolsConfig: { tools, allowedTools, disallowedTools } }
 *        — any extra field (orgId/name/prompt/...) is rejected, never silently
 *        used. orgId always comes from ctx (JWT), never from the body.
 *
 * Error contract: stable categorical codes, HTTP statuses mapped once here;
 * denials write metadata-only governance audits. No exception stacks or
 * config internals are echoed back.
 */
import express from "express";
import type { Request, Response } from "express";
import { ctxFromReq, isPrivilegedReq } from "./request-context.js";
import { writeGovernanceAudit } from "./org-governance.js";
import {
  buildSecurityPosture,
  updateProfileTools,
  SecurityPostureError,
  type ToolsConfig,
} from "./security-posture.js";

const DENIAL_STATUS: Record<string, number> = {
  forbidden: 403,
  platform_default_readonly: 403,
  cross_org: 404,
  not_found: 404,
  invalid_tools_config: 400,
  unexpected_fields: 400,
  invalid_request: 400,
};

function denyAudit(req: Request, reason: string): void {
  const ctx = ctxFromReq(req);
  writeGovernanceAudit({
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId: ctx.orgId,
    action: "security.posture.read",
    objectType: null,
    objectId: null,
    result: "denied",
    reasonSummary: reason,
  });
}

export function createSecurityPostureRoutes(): express.Router {
  const router = express.Router();

  router.get("/", (req: Request, res: Response) => {
    if (!isPrivilegedReq(req)) {
      denyAudit(req, "privileged only");
      return res.status(403).json({ error: "Admin or org_admin only", code: "forbidden" });
    }
    try {
      const posture = buildSecurityPosture(ctxFromReq(req));
      return res.json(posture);
    } catch (err) {
      if (err instanceof SecurityPostureError) {
        return res.status(DENIAL_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code });
      }
      console.error("[security-posture] read error:", err);
      return res.status(500).json({ error: "Failed to load security posture", code: "internal" });
    }
  });

  router.patch(
    "/profiles/:profileId/tools",
    express.json({ limit: "64kb" }),
    (req: Request, res: Response) => {
      const ctx = ctxFromReq(req);
      if (!isPrivilegedReq(req)) {
        denyAudit(req, "privileged only");
        return res.status(403).json({ error: "Admin or org_admin only", code: "forbidden" });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return res.status(400).json({ error: "Body must be a JSON object", code: "invalid_request" });
      }
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== "toolsConfig") {
        return res.status(400).json({
          error: "Body must contain exactly one field: toolsConfig (no orgId/name/prompt/...)",
          code: keys.includes("toolsConfig") ? "unexpected_fields" : "invalid_request",
        });
      }
      const cfg = body.toolsConfig;
      // Inner key set must be EXACTLY the three declared fields — a smuggled
      // extra key would otherwise be persisted by the store verbatim.
      const innerKeys =
        typeof cfg === "object" && cfg !== null && !Array.isArray(cfg)
          ? Object.keys(cfg as Record<string, unknown>)
          : [];
      const expectedInnerKeys = ["tools", "allowedTools", "disallowedTools"];
      const hasInnerExtras =
        innerKeys.length !== 3 || expectedInnerKeys.some((k) => !innerKeys.includes(k));
      if (
        typeof cfg !== "object" || cfg === null || Array.isArray(cfg) ||
        !Array.isArray((cfg as any).tools) || !Array.isArray((cfg as any).allowedTools) ||
        !Array.isArray((cfg as any).disallowedTools) ||
        [...(cfg as any).tools, ...(cfg as any).allowedTools, ...(cfg as any).disallowedTools].some((t) => typeof t !== "string")
      ) {
        return res.status(400).json({
          error: "toolsConfig must be { tools: string[], allowedTools: string[], disallowedTools: string[] }",
          code: "invalid_request",
        });
      }
      if (hasInnerExtras) {
        return res.status(400).json({
          error: "toolsConfig must contain exactly tools, allowedTools, disallowedTools — no extra fields",
          code: "unexpected_fields",
        });
      }

      try {
        const view = updateProfileTools(ctx, req.params.profileId, cfg as ToolsConfig);
        return res.json(view);
      } catch (err) {
        if (err instanceof SecurityPostureError) {
          return res.status(DENIAL_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code });
        }
        console.error("[security-posture] update error:", err);
        return res.status(500).json({ error: "Failed to update profile tools", code: "internal" });
      }
    }
  );

  return router;
}
