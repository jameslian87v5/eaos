/**
 * admin-app-routes.ts — Phase 6 (A1) admin application management API.
 *
 * Admin-only routes for managing applications, app keys, and capability
 * allowlists. Audit events are triggered at the route layer (has actor context).
 *
 * Codex A1 review: route-layer audit is acceptable for A1.
 *
 * See docs/02-architecture/platform-application-layer-architecture.md
 */

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { applicationService } from "./application-service.js";
import { applicationCapabilitiesService } from "./application-capabilities.js";
import { applicationAccessGrantsService, type AccessGrantPrincipalType } from "./application-access.js";
import { registeredApiService } from "./registered-api-service.js";
import { installApiAsMcp, uninstallApiMcp, importNativePlugin, uninstallNativePlugin, listInstalledPlugins, type NativePluginImportRequest } from "./capability-installer.js";
import { ctxFromReq, isAdminReq } from "./request-context.js";
import { assertOrgActive, OrgNotActiveError, writeGovernanceAudit } from "./org-governance.js";
import { getUserById } from "./auth.js";

// ─── Router ──────────────────────────────────────────────────

// Phase 7.2: applications CRUD is org-scopable (admin cross-org, org_admin
// own-org). admin may set orgId on create; org_admin's orgId is forced. Reads/
// mutations on a specific app hide cross-org apps as 404 for org_admin.
function appAccessible(req: Request, app: { orgId?: string } | undefined | null): boolean {
  if (!app) return false;
  return isAdminReq(req) || app.orgId === (req as any).orgId;
}

export function createAdminAppRoutes(): express.Router {
  const router = express.Router();

  // Phase 7.2: registered APIs + native plugins write the GLOBAL mcp/ filesystem
  // (not org-scoped), so they stay admin-only even though applications CRUD was
  // opened to org_admin. Scoped middleware — gates the whole /apis and /plugins
  // subtrees, declared before those routes.
  router.use("/apis", (req: Request, res: Response, next: NextFunction) => {
    if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
    next();
  });
  router.use("/plugins", (req: Request, res: Response, next: NextFunction) => {
    if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
    next();
  });

  // ─── List all applications ───────────────────────────────
  router.get("/applications", (req: Request, res: Response) => {
    const apps = isAdminReq(req)
      ? applicationService.listApplications()
      : applicationService.listByOrg((req as any).orgId);
    res.json(apps);
  });

  // ─── Create application ──────────────────────────────────
  router.post("/applications", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const { name, description, profileId, entryUrl, systemPrompt, appendSystemPrompt, toolAllowlist } = req.body ?? {};
    if (!name) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.create", objectType: "application", objectId: null, result: "failure", reasonSummary: "name required" });
      res.status(400).json({ error: "Application name required" });
      return;
    }
    // org_admin creates in their own org; admin may specify orgId (else default-org).
    const orgId = isAdminReq(req)
      ? (typeof req.body?.orgId === "string" && req.body.orgId ? req.body.orgId : undefined)
      : ctx.orgId;
    try {
      const app = applicationService.createApplication({
        name,
        description: description ?? null,
        profileId: profileId ?? null,
        entryUrl: entryUrl ?? null,
        systemPrompt: systemPrompt ?? null,
        appendSystemPrompt: appendSystemPrompt ?? null,
        toolAllowlist: toolAllowlist ?? null,
        orgId,
      });
      // R2: governance_audit_log (metadata-only — no prompt/key/allowlist payload).
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: app.orgId, action: "application.create", objectType: "application", objectId: app.id, result: "success", reasonSummary: "created" });
      res.status(201).json(app);
    } catch (err: any) {
      // R2: categorical only — err.message may echo user-supplied profile/tool/
      // request content, so it must not flow into the metadata-only audit sink.
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.create", objectType: "application", objectId: null, result: "failure", reasonSummary: "application create failed" });
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Update application ──────────────────────────────────
  router.patch("/applications/:id", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    if (!appAccessible(req, applicationService.getApplication(req.params.id))) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.update", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "not found or cross-org" });
      res.status(404).json({ error: "Application not found" });
      return;
    }
    const { name, description, profileId, entryUrl, status, systemPrompt, appendSystemPrompt, toolAllowlist } = req.body ?? {};
    let updated;
    try {
      updated = applicationService.updateApplication(req.params.id, {
        name,
        description,
        profileId,
        entryUrl,
        status,
        systemPrompt,
        appendSystemPrompt,
        toolAllowlist,
      });
    } catch (err: any) {
      // R2: categorical only — err.message may echo user-supplied content.
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.update", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "application update failed" });
      res.status(400).json({ error: err.message });
      return;
    }
    if (!updated) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.update", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "not found" });
      res.status(404).json({ error: "Application not found" });
      return;
    }
    // R2: governance_audit_log (metadata-only — categorical reason only; no
    // prompt/key/allowlist payload, no prompt hash/length).
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: updated.orgId, action: "application.update", objectType: "application", objectId: updated.id, result: "success", reasonSummary: "updated" });
    res.json(updated);
  });

  // ─── Delete application (soft: status=disabled) ──────────
  router.delete("/applications/:id", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    if (!appAccessible(req, applicationService.getApplication(req.params.id))) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.delete", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "not found or cross-org" });
      res.status(404).json({ error: "Application not found" });
      return;
    }
    const updated = applicationService.updateApplication(req.params.id, {
      status: "disabled",
    });
    if (!updated) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.delete", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "not found" });
      res.status(404).json({ error: "Application not found" });
      return;
    }
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: updated.orgId, action: "application.delete", objectType: "application", objectId: updated.id, result: "success", reasonSummary: "disabled" });
    res.json({ success: true });
  });

  // ─── Generate app key ────────────────────────────────────
  router.post("/applications/:id/key", (req: Request, res: Response) => {
    const app = applicationService.getApplication(req.params.id);
    // appAccessible FIRST so cross-org / unknown apps stay hidden as 404 (no
    // existence leak via a 403).
    if (!appAccessible(req, app)) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    // M1 status gate (touchpoint: AppKey 签发). The TARGET app's org must be
    // active. Unlike the operator-side guards, admin is NOT exempt here: a
    // suspended department's resources must not issue new credentials — admin
    // reactivates the dept first, then signs. Cross-org already 404'd above.
    try {
      assertOrgActive(app!.orgId);
    } catch (e) {
      if (e instanceof OrgNotActiveError) {
        res.status(403).json({ error: e.message, code: "org_not_active" });
        return;
      }
      throw e;
    }
    try {
      const result = applicationService.generateAppKey(req.params.id);
      // M1 audit: write to the metadata-only governance_audit_log sink (no FK
      // to chats). The prior eventStore.appendEvent(appId, …) wrote into
      // agent_events whose chat_id FK→chats(id); the appId is never a chat, so
      // the audit INSERT threw AFTER the key was already persisted and the
      // route's catch masked the 201 as 4xx. governance_audit_log records
      // actor/org/action/object/result/reason only — NEVER the key or payload.
      // (All admin-app governance actions now use writeGovernanceAudit — the
      // eventStore import was removed in the R2 follow-up cleanup.)
      const ctx = ctxFromReq(req);
      writeGovernanceAudit({
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        orgId: app!.orgId,
        action: "application.key_rotated",
        objectType: "application",
        objectId: req.params.id,
        reasonSummary: "app key rotated",
      });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // ─── Get app capability allowlist ────────────────────────
  router.get("/applications/:id/capabilities", (req: Request, res: Response) => {
    if (!appAccessible(req, applicationService.getApplication(req.params.id))) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    const caps = applicationCapabilitiesService.listByApp(req.params.id);
    res.json(caps);
  });

  // ─── Replace app capability allowlist ────────────────────
  router.put("/applications/:id/capabilities", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    if (!appAccessible(req, applicationService.getApplication(req.params.id))) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.caps", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "not found or cross-org" });
      res.status(404).json({ error: "Application not found" });
      return;
    }
    const { resources } = req.body ?? {};
    if (!Array.isArray(resources)) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.caps", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "resources array required" });
      res.status(400).json({ error: "resources array required" });
      return;
    }
    let caps;
    try {
      caps = applicationCapabilitiesService.setAppCapabilities(req.params.id, {
        resources: resources.map((r: any) => ({
          resourceId: r.resourceId,
          enabled: !!r.enabled,
        })),
      });
    } catch (err: any) {
      // R2: categorical only — err.message may echo resource/payload content.
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.caps", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "application caps update failed" });
      res.status(400).json({ error: err.message });
      return;
    }
    // R2: governance_audit_log (metadata-only — count only, no resource list payload).
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.caps", objectType: "application", objectId: req.params.id, result: "success", reasonSummary: `${caps.length} capabilities` });
    res.json(caps);
  });

  // ─── Agent OS M2: application access grants ──────────────
  // Gates which platform principals (org / platform user) may enter this
  // Application via AppKey+platform-JWT. Deny by default; only 'org' and
  // 'user' types. App-principal (Runtime Token) access needs no grant.
  // admin manages within governance; org_admin only own-org app + cannot
  // grant cross-org users; ordinary users cannot mutate (the /api/admin
  // mount already gates admin|org_admin — here we narrow further).

  router.get("/applications/:id/access-grants", (req: Request, res: Response) => {
    if (!appAccessible(req, applicationService.getApplication(req.params.id))) {
      res.status(404).json({ error: "Application not found" });
      return;
    }
    const grants = applicationAccessGrantsService.listGrants(req.params.id);
    res.json(grants);
  });

  router.put("/applications/:id/access-grants", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const app = applicationService.getApplication(req.params.id);
    if (!appAccessible(req, app)) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "not found or cross-org" });
      res.status(404).json({ error: "Application not found" });
      return;
    }
    const { grants } = req.body ?? {};
    if (!Array.isArray(grants)) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "grants array required" });
      res.status(400).json({ error: "grants array required" });
      return;
    }
    const validTypes: AccessGrantPrincipalType[] = ["org", "user"];
    const normalized: { principalType: AccessGrantPrincipalType; principalId: string }[] = [];
    for (const g of grants) {
      if (!g || typeof g.principalType !== "string" || !validTypes.includes(g.principalType)) {
        writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "invalid principalType" });
        res.status(400).json({ error: "principalType must be 'org' or 'user'" });
        return;
      }
      const principalId = typeof g.principalId === "string" ? g.principalId.trim() : "";
      if (!principalId) {
        writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "empty principalId" });
        res.status(400).json({ error: "principalId required" });
        return;
      }
      if (g.principalType === "user") {
        // A user grant must reference a real platform user.
        const target = getUserById(principalId);
        if (!target) {
          writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "unknown user grant" });
          res.status(400).json({ error: "Unknown user for grant" });
          return;
        }
        // org_admin cannot grant cross-org users (the user's org must match
        // the Application's org). admin is exempt (cross-org recovery).
        if (!isAdminReq(req) && target.orgId !== app!.orgId) {
          writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "cross-org user grant by org_admin" });
          res.status(403).json({ error: "org_admin cannot grant cross-org users" });
          return;
        }
      } else {
        // org grant: org_admin may only grant the Application's own org
        // (= their own org, since appAccessible already matched). admin may
        // grant any org string (cross-org app access is an admin action).
        if (!isAdminReq(req) && principalId !== app!.orgId) {
          writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "failure", reasonSummary: "cross-org grant by org_admin" });
          res.status(403).json({ error: "org_admin can only grant access to the application's own org" });
          return;
        }
      }
      normalized.push({ principalType: g.principalType, principalId });
    }
    const result = applicationAccessGrantsService.replaceGrants(req.params.id, { grants: normalized }, ctx.userId);
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "application.access", objectType: "application", objectId: req.params.id, result: "success", reasonSummary: `${result.length} grants` });
    res.json(result);
  });

  // ─── Phase 6 (A3): Registered API management ─────────────

  // List all registered APIs
  router.get("/apis", (req: Request, res: Response) => {
    const apis = registeredApiService.listAll();
    res.json(apis);
  });

  // Register a new internal API → generates MCP wrapper
  router.post("/apis", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const { name, displayName, description, apiUrl, method, requestParamsSchema, responseMapping, timeoutMs } = req.body ?? {};
    let api;
    try {
      api = registeredApiService.create({
        name, displayName, description, apiUrl, method, requestParamsSchema, responseMapping, timeoutMs,
      });
    } catch (err: any) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.register", objectType: "registered_api", objectId: name ?? null, result: "failure", reasonSummary: "api register failed" });
      res.status(400).json({ error: err.message });
      return;
    }
    // Generate MCP wrapper package — rollback DB on failure
    try {
      installApiAsMcp(api);
    } catch (installErr: any) {
      registeredApiService.delete(api.id);
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.register", objectType: "registered_api", objectId: api.id, result: "failure", reasonSummary: "MCP wrapper generation failed" });
      res.status(500).json({ error: `MCP wrapper generation failed: ${installErr.message}`, rollback: true });
      return;
    }
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.register", objectType: "registered_api", objectId: api.id, result: "success", reasonSummary: "registered" });
    res.status(201).json(api);
  });

  // Batch register APIs → best-effort, returns success/failed counts + error details
  router.post("/apis/batch", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const { apis } = req.body ?? {};
    if (!Array.isArray(apis)) {
      res.status(400).json({ error: "Request body must contain an 'apis' array" });
      return;
    }
    if (apis.length > 50) {
      res.status(400).json({ error: "Batch limit: 50 APIs per request" });
      return;
    }

    // Pre-validate: check for required fields and duplicate names within the payload
    const seenNames = new Set<string>();
    for (let i = 0; i < apis.length; i++) {
      const item = apis[i];
      if (!item.name || !item.apiUrl || !item.method) {
        res.status(400).json({ error: `Item #${i + 1}: missing required field (name, apiUrl, method)` });
        return;
      }
      if (item.method !== "GET" && item.method !== "POST") {
        res.status(400).json({ error: `Item #${i + 1} (${item.name}): method must be GET or POST` });
        return;
      }
      if (seenNames.has(item.name)) {
        res.status(400).json({ error: `Duplicate name in payload: "${item.name}" (items #${i + 1})` });
        return;
      }
      seenNames.add(item.name);
    }

    const results: { success: number; failed: number; errors: Array<{ index: number; name?: string; error: string }> } = {
      success: 0, failed: 0, errors: [],
    };

    for (let i = 0; i < apis.length; i++) {
      const item = apis[i];
      try {
        const api = registeredApiService.create({
          name: item.name,
          displayName: item.displayName,
          description: item.description,
          apiUrl: item.apiUrl,
          method: item.method,
          requestParamsSchema: item.requestParamsSchema,
          responseMapping: item.responseMapping,
          timeoutMs: item.timeoutMs,
        });
        try {
          installApiAsMcp(api);
        } catch (installErr: any) {
          registeredApiService.delete(api.id);
          results.failed++;
          results.errors.push({ index: i, name: item.name, error: `MCP wrapper generation failed: ${installErr.message}` });
          continue;
        }
        results.success++;
      } catch (err: any) {
        results.failed++;
        results.errors.push({ index: i, name: item.name, error: err.message });
      }
    }

    // R2: one summary audit row per batch (success if any ok, else failure).
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.register_batch", objectType: "registered_api", objectId: null, result: results.success > 0 ? "success" : "failure", reasonSummary: `${results.success}/${apis.length} ok` });
    res.status(results.success === 0 ? 400 : 200).json(results);
  });

  // Update a registered API → regenerates MCP wrapper
  router.patch("/apis/:id", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const { displayName, description, apiUrl, method, requestParamsSchema, responseMapping, timeoutMs, status } = req.body ?? {};

    // Snapshot the old row for rollback
    const oldApi = registeredApiService.getById(req.params.id);
    if (!oldApi) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.update", objectType: "registered_api", objectId: req.params.id, result: "failure", reasonSummary: "api not found" });
      res.status(404).json({ error: "API not found" });
      return;
    }

    let updated;
    try {
      updated = registeredApiService.update(req.params.id, {
        displayName, description, apiUrl, method, requestParamsSchema, responseMapping, timeoutMs, status,
      });
    } catch (err: any) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.update", objectType: "registered_api", objectId: req.params.id, result: "failure", reasonSummary: "api update failed" });
      res.status(400).json({ error: err.message });
      return;
    }
    if (!updated) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.update", objectType: "registered_api", objectId: req.params.id, result: "failure", reasonSummary: "api not found" });
      res.status(404).json({ error: "API not found" });
      return;
    }
    // Regenerate MCP wrapper — rollback DB + reinstall old wrapper on failure
    try {
      installApiAsMcp(updated);
    } catch (installErr: any) {
      // Rollback: restore old DB row, reinstall old wrapper
      try {
        registeredApiService.restore(oldApi);
        installApiAsMcp(oldApi);
      } catch (rollbackErr: any) {
        writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.update", objectType: "registered_api", objectId: req.params.id, result: "failure", reasonSummary: "MCP regen + rollback failed" });
        res.status(500).json({
          error: `MCP wrapper regeneration failed AND rollback failed: ${installErr.message} / ${rollbackErr.message}`,
          rollback: "partial",
        });
        return;
      }
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.update", objectType: "registered_api", objectId: req.params.id, result: "failure", reasonSummary: "MCP regen failed, rolled back" });
      res.status(500).json({
        error: `MCP wrapper regeneration failed, DB rolled back to previous state: ${installErr.message}`,
        rollback: "complete",
      });
      return;
    }
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.update", objectType: "registered_api", objectId: updated.id, result: "success", reasonSummary: "updated" });
    res.json(updated);
  });

  // Delete a registered API → removes MCP wrapper
  router.delete("/apis/:id", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const api = registeredApiService.getById(req.params.id);
    if (!api) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.delete", objectType: "registered_api", objectId: req.params.id, result: "failure", reasonSummary: "api not found" });
      res.status(404).json({ error: "API not found" });
      return;
    }
    // Remove MCP package + mcp.json entry — rollback on failure
    try {
      uninstallApiMcp(api.name);
    } catch (uninstallErr: any) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.delete", objectType: "registered_api", objectId: req.params.id, result: "failure", reasonSummary: "MCP wrapper removal failed" });
      res.status(500).json({ error: `MCP wrapper removal failed: ${uninstallErr.message}` });
      return;
    }
    registeredApiService.delete(req.params.id);
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "api.delete", objectType: "registered_api", objectId: req.params.id, result: "success", reasonSummary: "deleted" });
    res.json({ success: true });
  });

  // ─── Native Plugin Import ────────────────────────────────

  // Import a native plugin (skill or hook-plugin) from a local path
  router.post("/plugins/import", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const { path, name, registryCategory, enabled, commitHash, hubSourceId } = req.body ?? {};
    if (!path || !name) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "plugin.import", objectType: "plugin", objectId: name ?? null, result: "failure", reasonSummary: "path and name required" });
      res.status(400).json({ error: "path and name are required" });
      return;
    }
    if (registryCategory && registryCategory !== "skill" && registryCategory !== "hook-plugin") {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "plugin.import", objectType: "plugin", objectId: name, result: "failure", reasonSummary: "invalid registryCategory" });
      res.status(400).json({ error: "registryCategory must be 'skill' or 'hook-plugin' if provided" });
      return;
    }
    try {
      const result = importNativePlugin({
        path,
        name,
        registryCategory,
        enabled,
        commitHash,
        hubSourceId,
      });
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "plugin.import", objectType: "plugin", objectId: result.resourceId, result: "success", reasonSummary: `imported (${(result.types || []).join(",")})` });
      res.json(result);
    } catch (err: any) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "plugin.import", objectType: "plugin", objectId: name, result: "failure", reasonSummary: "plugin import failed" });
      res.status(400).json({ error: err.message });
    }
  });

  // Uninstall a native plugin
  router.post("/plugins/uninstall", (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const { name, force } = req.body ?? {};
    if (!name) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "plugin.uninstall", objectType: "plugin", objectId: null, result: "failure", reasonSummary: "name required" });
      res.status(400).json({ error: "name is required" });
      return;
    }
    try {
      uninstallNativePlugin({ name, force });
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "plugin.uninstall", objectType: "plugin", objectId: name, result: "success", reasonSummary: "uninstalled" });
      res.json({ success: true });
    } catch (err: any) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "plugin.uninstall", objectType: "plugin", objectId: name, result: "failure", reasonSummary: "plugin uninstall failed" });
      res.status(400).json({ error: err.message });
    }
  });

  // List installed plugins
  router.get("/plugins/installed", (req: Request, res: Response) => {
    const type = req.query.type as string | undefined;
    if (type && type !== "skill" && type !== "hook-plugin") {
      res.status(400).json({ error: "type must be 'skill' or 'hook-plugin' if provided" });
      return;
    }
    const filter = type ? { type: type as "skill" | "hook-plugin" } : undefined;
    const plugins = listInstalledPlugins(filter);
    res.json(plugins);
  });

  return router;
}
