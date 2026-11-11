/**
 * admin-run-routes.ts — Agent OS M3 (plan §7): admin-only runId lookup router.
 *
 * Extracted from server.ts so the route is HTTP-testable via the same pattern
 * used by createAdminAppRoutes() (mount + fetch on port 0). The route is
 * admin-only and org-scoped: non-admin (user/org_admin) and cross-org
 * requests return 404 — existence is hidden, not disclosed as 403. The
 * response is the redacted run snapshot + bounded event summary from
 * agentRunService.getRun (no raw payloads / Tool input-output / subject).
 */
import express from "express";
import type { Request, Response } from "express";
import { agentRunService } from "./agent-run-service.js";
import { DEFAULT_ORG_ID, isAdminReq } from "./request-context.js";

export function createAdminRunRoutes(): express.Router {
  const router = express.Router();

  router.get("/runs/:runId", (req: Request, res: Response) => {
    // M3: admin-only. user + org_admin + cross-org all return 404 (existence
    // hidden). This gate runs BEFORE any DB lookup, so a non-admin cannot probe
    // whether a runId exists.
    if (!isAdminReq(req)) return res.status(404).json({ error: "Not found" });
    const runId = req.params.runId;
    const eventLimit = Math.min(200, Math.max(1, parseInt(req.query.eventLimit as string) || 50));
    const eventOffset = Math.max(0, parseInt(req.query.eventOffset as string) || 0);
    const detail = agentRunService.getRun(
      runId,
      { role: (req as any).userRole, orgId: (req as any).orgId ?? DEFAULT_ORG_ID },
      { eventLimit, eventOffset }
    );
    if (!detail) return res.status(404).json({ error: "Not found" });
    res.json(detail);
  });

  return router;
}
