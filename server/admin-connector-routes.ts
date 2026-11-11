/**
 * admin-connector-routes.ts — Octop absorption M1a route layer
 * (codex evt_20261020041142 M1a): admin-only connector catalog/instance APIs.
 *
 * Extracted from server.ts following createAdminRunRoutes() (mount + fetch on
 * port 0 makes the routes HTTP-testable). Every handler is ADMIN-ONLY —
 * org_admin/user get 403 with a denied governance audit (metadata-only).
 * Contract notes:
 *   - PUT .../credentials is WRITE-ONLY: never echoes values, never returns
 *     ciphertext; the response carries only the secret-free instance view.
 *   - Enabling an instance only makes it ELIGIBLE — no agent visibility is
 *     granted by any route here (that is M2 resolve() + entitlement).
 *
 * Endpoints (mounted at /api/admin/connectors with authMiddleware):
 *   GET  /catalog
 *   GET  /instances
 *   POST /instances
 *   PUT  /instances/:id/credentials
 *   POST /instances/:id/enable
 *   POST /instances/:id/disable
 */
import express from "express";
import type { Request, Response } from "express";
import { ctxFromReq, isAdminReq } from "./request-context.js";
import { writeGovernanceAudit } from "./org-governance.js";
import {
  ConnectorNotFoundError,
  createInstance,
  disableInstance,
  enableInstance,
  listCatalog,
  listInstances,
  writeCredentials,
} from "./connector-store.js";
import { startAuthorization } from "./connector-feishu-oauth.js";

export function createAdminConnectorRoutes(): express.Router {
  const router = express.Router();

  function denyNonAdmin(req: Request, res: Response, action: string, objectId?: string): boolean {
    if (isAdminReq(req)) return false;
    const ctx = ctxFromReq(req);
    writeGovernanceAudit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action,
      objectId,
      result: "denied",
      reasonSummary: "admin only",
    });
    res.status(403).json({ error: "Admin only" });
    return true;
  }

  function audit(req: Request, action: string, objectId: string, reasonSummary: string): void {
    const ctx = ctxFromReq(req);
    writeGovernanceAudit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action,
      objectId,
      reasonSummary,
    });
  }

  router.get("/catalog", (req, res) => {
    if (denyNonAdmin(req, res, "connector.catalog.read")) return;
    res.json({ connectors: listCatalog() });
  });

  router.get("/instances", (req, res) => {
    if (denyNonAdmin(req, res, "connector.instances.read")) return;
    res.json({ instances: listInstances() });
  });

  router.post("/instances", (req, res) => {
    if (denyNonAdmin(req, res, "connector.create")) return;
    try {
      const instance = createInstance(req.body ?? {});
      audit(
        req,
        "connector.create",
        instance.id,
        `kind=${instance.catalogKind} name=${instance.name} status=${instance.status}`
      );
      res.status(201).json({ instance });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Write-only credential form target. Field NAMES are audited; values never.
  router.put("/instances/:id/credentials", (req, res) => {
    const id = req.params.id;
    if (denyNonAdmin(req, res, "connector.credentials.write", id)) return;
    try {
      const { view, fieldNames } = writeCredentials(id, (req.body ?? {}).values ?? {});
      audit(
        req,
        "connector.credentials.write",
        id,
        `fields=${fieldNames.join(",")} status=${view.status} configVersion=${view.configVersion}`
      );
      res.json({ instance: view });
    } catch (err: any) {
      if (err instanceof ConnectorNotFoundError) return res.status(404).json({ error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/instances/:id/enable", (req, res) => {
    const id = req.params.id;
    if (denyNonAdmin(req, res, "connector.enable", id)) return;
    try {
      const instance = enableInstance(id);
      audit(req, "connector.enable", id, `kind=${instance.catalogKind} status=${instance.status}`);
      res.json({ instance });
    } catch (err: any) {
      if (err instanceof ConnectorNotFoundError) return res.status(404).json({ error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/instances/:id/disable", (req, res) => {
    const id = req.params.id;
    if (denyNonAdmin(req, res, "connector.disable", id)) return;
    try {
      const instance = disableInstance(id);
      audit(req, "connector.disable", id, `kind=${instance.catalogKind} status=${instance.status}`);
      res.json({ instance });
    } catch (err: any) {
      if (err instanceof ConnectorNotFoundError) return res.status(404).json({ error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  // M2b: start the Feishu OAuth authorization flow. Admin-only; the response
  // carries ONLY the authorizeUrl (one-time state, PKCE challenge) — no
  // client secret, no verifier, no token material.
  router.post("/instances/:id/oauth/start", (req, res) => {
    const id = req.params.id;
    if (denyNonAdmin(req, res, "connector.oauth.start", id)) return;
    try {
      const ctx = ctxFromReq(req);
      // Fix round #1: redirect URI authority comes from operator config —
      // the request object is intentionally NOT passed in.
      const { authorizeUrl } = startAuthorization(ctx, id);
      audit(req, "connector.oauth.start", id, "authorization flow started");
      res.json({ authorizeUrl });
    } catch (err: any) {
      if (err instanceof ConnectorNotFoundError) return res.status(404).json({ error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
