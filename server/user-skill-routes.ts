/**
 * user-skill-routes.ts — Octop absorption M7b: user-side submission routes
 * (/api/my-skills).
 *
 * Product contract (plan docs/superpowers/plans/2026-10-23-m7b-user-skills.md):
 *   - ONE PIPELINE: submission ALWAYS enters the M3 importSkillZip validator
 *     (bounded extraction → scanner → repackage → quarantine install → real
 *     resolveOne validation). No second validator, no per-user directory.
 *   - 提交≠可用: imported as enabled:false in skills/quarantine/<slug>; becoming
 *     usable requires the admin review chain (admin-user-skill-routes).
 *   - Request-shape failures (bad slug / duplicate / oversize) → 4xx with NO
 *     ledger record; package-content failures → 400 + a `quarantined` record
 *     (the import itself rolled back, so the slug stays re-submittable).
 *   - Reads are submitter-scoped: a user only ever sees their own submissions.
 *   - Audit: categorical, metadata-only (never ZIP bytes / file contents).
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { ctxFromReq } from "./request-context.js";
import { assertOrgActive, OrgNotActiveError, writeGovernanceAudit } from "./org-governance.js";
import { importSkillZip, removeImportedSkill, SkillZipImportError } from "./skill-zip-import.js";
import {
  userSkillSubmissionService,
  SubmissionStoreError,
  SUBMISSION_CAPS,
  type SubmissionManifestSummary,
} from "./user-skill-submissions.js";

// Request-shape failures: no ledger record (the package never materialized).
const REQUEST_SHAPE_CODES = new Set([
  "invalid_slug",
  "invalid_version",
  "empty_zip",
  "zip_too_large",
  "duplicate",
  "registry_invalid",
]);

export function createMySkillsRoutes(): express.Router {
  const router = express.Router();

  const audit = (args: {
    ctx: ReturnType<typeof ctxFromReq>;
    action: string;
    result: "success" | "failure" | "denied";
    reasonSummary?: string;
    objectId?: string;
  }) => {
    writeGovernanceAudit({
      actorUserId: args.ctx.userId,
      actorRole: args.ctx.role,
      orgId: args.ctx.orgId,
      action: args.action,
      objectType: "user_skill_submission",
      objectId: args.objectId ?? null,
      result: args.result,
      reasonSummary: args.reasonSummary ?? null,
    });
  };

  // Raw ZIP upload — the ONLY body the router accepts (JSON routes use the
  // server-level express.json). Same 80MB request bound as importSkillZip.
  router.post(
    "/submit",
    express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "80mb" }),
    (req, res) => {
      const ctx = ctxFromReq(req);
      try {
        assertOrgActive(ctx.orgId);
      } catch (err) {
        if (err instanceof OrgNotActiveError) {
          audit({ ctx, action: "user_skill_submit", result: "denied", reasonSummary: "org_not_active" });
          res.status(403).json({ code: "org_not_active", message: "org is not active" });
          return;
        }
        throw err;
      }

      const slug = String(req.query.slug ?? "").trim();
      const version = String(req.query.version ?? "").trim() || undefined;
      const zipBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const submissionId = `m7b-${randomUUID()}`;

      // Fix round P1-1: fail-closed ledger preflight BEFORE the import — a
      // malformed ledger must never leave an orphan package behind, and the
      // failing request must never overwrite the ledger bytes.
      try {
        userSkillSubmissionService.assertHealthy();
      } catch (err) {
        if (err instanceof SubmissionStoreError) {
          audit({ ctx, action: "user_skill_submit", result: "failure", reasonSummary: err.code, objectId: slug });
          res.status(500).json({ code: "submission_store_invalid", message: "submission ledger is malformed — refusing import so nothing is orphaned; contact an admin" });
          return;
        }
        throw err;
      }

      // Fix round P1-3 + round 2: fixed caps counting OPEN records
      // (pending_review + quarantined — a quarantined record still cost the
      // pipeline, so pending-only counting was farmable via invalid ZIPs).
      // Checked before the import so a capped request leaves zero residue.
      if (userSkillSubmissionService.countOpenForSubmitter(ctx.userId) >= SUBMISSION_CAPS.perSubmitter) {
        audit({ ctx, action: "user_skill_submit", result: "denied", reasonSummary: "submission_cap_submitter", objectId: slug });
        res.status(429).json({
          code: "submission_cap_submitter",
          message: `待处理提交已达上限（每人 ${SUBMISSION_CAPS.perSubmitter} 条，含待审核与已隔离）——请等待审核完成或使用合规包重试`,
        });
        return;
      }
      if (userSkillSubmissionService.countOpenForOrg(ctx.orgId) >= SUBMISSION_CAPS.perOrg) {
        audit({ ctx, action: "user_skill_submit", result: "denied", reasonSummary: "submission_cap_org", objectId: slug });
        res.status(429).json({
          code: "submission_cap_org",
          message: `组织待处理提交已达上限（${SUBMISSION_CAPS.perOrg} 条，含待审核与已隔离）——请稍后再试`,
        });
        return;
      }

      try {
        const manifest = importSkillZip({
          slug,
          ...(version ? { version } : {}),
          zipBuffer,
          submittedBy: ctx.userId,
          submissionId,
        });
        const summary: SubmissionManifestSummary = {
          sha256: manifest.sha256,
          fileCount: manifest.fileCount,
          hasScripts: manifest.hasScripts,
          license: manifest.license,
          description: manifest.description,
          version: manifest.version,
          files: manifest.files,
        };
        // Fix round P1-1: if the ledger write fails AFTER the import, remove
        // the freshly installed package (registry row + quarantine dir) so no
        // orphan survives — the row is matched by this submissionId only.
        let submission: ReturnType<typeof userSkillSubmissionService.createSubmission>;
        try {
          submission = userSkillSubmissionService.createSubmission({
            ctx,
            slug: manifest.name,
            id: submissionId,
            manifest: summary,
          });
        } catch (err) {
          if (err instanceof SubmissionStoreError) {
            try { removeImportedSkill(manifest.name, submissionId); } catch {}
            audit({ ctx, action: "user_skill_submit", result: "failure", reasonSummary: err.code, objectId: submissionId });
            res.status(500).json({ code: "submission_store_invalid", message: "submission ledger write failed — the imported package was rolled back; contact an admin" });
            return;
          }
          throw err;
        }
        audit({ ctx, action: "user_skill_submit", result: "success", objectId: submission.id });
        res.status(201).json({ submission });
      } catch (err) {
        if (err instanceof SkillZipImportError) {
          if (REQUEST_SHAPE_CODES.has(err.code)) {
            audit({ ctx, action: "user_skill_submit", result: "failure", reasonSummary: err.code, objectId: slug });
            res.status(err.code === "duplicate" ? 409 : 400).json({ code: err.code, message: err.message });
            return;
          }
          // Package-content failure: the import rolled back (zero registry row
          // / directory), so the slug stays free — record it for the submitter's
          // own status view and the admin queue.
          const submission = userSkillSubmissionService.recordQuarantined({
            ctx,
            slug: slug || "(unknown)",
            errorCode: err.code,
          });
          audit({ ctx, action: "user_skill_quarantined", result: "failure", reasonSummary: err.code, objectId: submission.id });
          res.status(400).json({ code: err.code, message: err.message, submission });
          return;
        }
        if (err instanceof SubmissionStoreError) {
          res.status(500).json({ code: "submission_store_error", message: err.message });
          return;
        }
        throw err;
      }
    }
  );

  // Submitter-scoped read: only the caller's own submissions, ever.
  router.get("/", (req, res) => {
    const ctx = ctxFromReq(req);
    res.json({ submissions: userSkillSubmissionService.listForSubmitter(ctx.userId) });
  });

  return router;
}
