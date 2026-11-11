/**
 * admin-skill-import-routes.ts — Octop absorption M3a route layer:
 * admin-only LOCAL skill ZIP import into quarantine.
 *
 * Extracted from server.ts following createAdminConnectorRoutes() (mount +
 * test-harness pattern). ADMIN-ONLY — org_admin/user get 403 with a denied
 * governance audit (metadata-only). Contract notes:
 *   - The ZIP body is bounded (80mb) and fully untrusted; importSkillZip
 *     enforces the extraction bounds (≤2000 files / ≤64MB / per-file / ratio,
 *     no symlink/absolute/traversal) and installs `enabled:false` — import
 *     success ≠ usable. Enable still flows through the existing global
 *     enable + entitlement/app-allowlist/activation guards (deny-default).
 *   - The response manifest is secret-free: file list, script flag, license,
 *     content hash, validation errors.
 *   - Audits are metadata-only: categorical code + counts, never file
 *     payload, never ZIP bytes.
 *
 * Endpoint (mounted at /api/admin/skills with authMiddleware):
 *   POST /import-zip?slug=<slug>&version=<version>  (application/zip body)
 */
import express from "express";
import type { Request, Response } from "express";
import { ctxFromReq, isAdminReq } from "./request-context.js";
import { writeGovernanceAudit } from "./org-governance.js";
import { importSkillZip, SkillZipImportError } from "./skill-zip-import.js";

export function createAdminSkillImportRoutes(): express.Router {
  const router = express.Router();

  router.post(
    "/import-zip",
    express.raw({ type: "application/zip", limit: "80mb" }),
    (req: Request, res: Response) => {
      const ctx = ctxFromReq(req);
      if (!isAdminReq(req)) {
        writeGovernanceAudit({
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          orgId: ctx.orgId,
          action: "skill.import",
          objectType: "skill",
          objectId: null,
          result: "denied",
          reasonSummary: "admin only (local zip import)",
        });
        return res.status(403).json({ error: "Admin only (local ZIP import)" });
      }
      const { slug, version } = req.query;
      if (typeof slug !== "string" || (version !== undefined && typeof version !== "string")) {
        return res.status(400).json({ error: "Query params slug (required) and version (optional) must be single-valued strings" });
      }
      const zipBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const manifest = importSkillZip({
          slug,
          version: typeof version === "string" ? version : undefined,
          zipBuffer,
        });
        writeGovernanceAudit({
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          orgId: ctx.orgId,
          action: "skill.import",
          objectType: "skill",
          objectId: manifest.name,
          result: "success",
          reasonSummary: `quarantined import: ${manifest.fileCount} files, scripts=${manifest.hasScripts}, enabled=false`,
        });
        return res.json({ manifest });
      } catch (err) {
        const code = err instanceof SkillZipImportError ? err.code : "import_failed";
        writeGovernanceAudit({
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          orgId: ctx.orgId,
          action: "skill.import",
          objectType: "skill",
          objectId: slug,
          result: "failure",
          reasonSummary: `rejected (${code})`,
        });
        const status = code === "duplicate" ? 409 : 400;
        return res.status(status).json({ error: (err as Error).message, code });
      }
    }
  );

  return router;
}
