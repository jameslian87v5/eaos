/**
 * admin-user-skill-routes.ts — Octop absorption M7b: the admin review queue
 * (/api/admin/user-skills).
 *
 * Authority model (iron law):
 *   - admin only reviews: approve/reject are admin-only. org_admin gets a
 *     read-only own-org queue (visibility, NOT authority) — any write attempt
 *     from a non-admin → 403 + denied governance audit.
 *   - approve = 提交者独享: enable the quarantined skill + create EXACTLY one
 *     user-scope allow entitlement for the submitter. No org-scope spill, no
 *     auto broadening — broaden later via the normal admin entitlement tools.
 *   - reject = ledger-only: registry row stays enabled:false, ZERO entitlement.
 *   - zero partial write: enable → entitlement → ledger, with compensating
 *     rollback if a later step fails.
 *   - audit: categorical, metadata-only.
 */
import express from "express";
import { ctxFromReq, isPrivilegedRole, type Role } from "./request-context.js";
import { writeGovernanceAudit } from "./org-governance.js";
import { getAllSkills, setSkillEnabled } from "./skill-config.js";
import { entitlementService } from "./entitlement.js";
import { userSkillSubmissionService, SubmissionStoreError } from "./user-skill-submissions.js";

const REASON_CODE_RE = /^[a-z0-9_-]{1,64}$/;

export function createAdminUserSkillRoutes(): express.Router {
  const router = express.Router();

  const audit = (args: {
    actorId: string;
    actorRole: Role;
    orgId: string;
    action: string;
    result: "success" | "failure" | "denied";
    reasonSummary?: string;
    objectId?: string;
  }) => {
    writeGovernanceAudit({
      actorUserId: args.actorId,
      actorRole: args.actorRole,
      orgId: args.orgId,
      action: args.action,
      objectType: "user_skill_submission",
      objectId: args.objectId ?? null,
      result: args.result,
      reasonSummary: args.reasonSummary ?? null,
    });
  };

  /** Guard helper: returns the ctx, or null after responding 403 + denied audit. */
  const requirePrivileged = (req: express.Request, res: express.Response, action: string) => {
    const ctx = ctxFromReq(req);
    if (!isPrivilegedRole(ctx.role)) {
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action, result: "denied", reasonSummary: "not_privileged" });
      res.status(403).json({ code: "forbidden", message: "admin or org_admin role required" });
      return null;
    }
    return ctx;
  };

  // Review queue: admin sees all; org_admin sees own-org (read-only).
  router.get("/", (req, res) => {
    const ctx = requirePrivileged(req, res, "user_skill_queue_read");
    if (!ctx) return;
    const submissions =
      ctx.role === "admin" ? userSkillSubmissionService.listAll() : userSkillSubmissionService.listForOrg(ctx.orgId);
    res.json({ submissions });
  });

  // Admin-only: guard shared by approve/reject.
  const requireAdmin = (req: express.Request, res: express.Response, action: string) => {
    const ctx = ctxFromReq(req);
    if (ctx.role !== "admin") {
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action, result: "denied", reasonSummary: "admin_only" });
      res.status(403).json({ code: "forbidden", message: "review is admin-only" });
      return null;
    }
    return ctx;
  };

  /** Resolve a submission for review: null after responding the mapped error. */
  const resolveForReview = (req: express.Request, res: express.Response) => {
    const id = String(req.params.id ?? "");
    const rec = userSkillSubmissionService.getById(id);
    if (!rec) {
      res.status(404).json({ code: "not_found", message: `submission ${id} not found` });
      return null;
    }
    if (rec.status === "quarantined") {
      // No package survived the M3 pipeline — nothing to enable or reject.
      res.status(400).json({ code: "quarantined", message: "package was rejected by the import pipeline; re-submit instead" });
      return null;
    }
    if (rec.status !== "pending_review") {
      res.status(409).json({ code: "terminal_state", message: `submission is "${rec.status}" — only pending_review can be reviewed` });
      return null;
    }
    return rec;
  };

  router.post("/:id/approve", (req, res) => {
    const ctx = requireAdmin(req, res, "user_skill_approve");
    if (!ctx) return;
    const rec = resolveForReview(req, res);
    if (!rec) return;

    const row = getAllSkills().find((s) => s.name === rec.slug);
    if (!row) {
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_approve", result: "failure", reasonSummary: "registry_row_missing", objectId: rec.id });
      res.status(400).json({ code: "registry_row_missing", message: "registry row not found for this submission" });
      return;
    }

    // Fix round P1-2: fail-closed entitlement preflight BEFORE enabling. The
    // entitlement read path silently falls back to empty on malformed bytes —
    // without this check the approve would enable the skill, then "succeed"
    // by RESETTING the store (destroying the unreadable prior config).
    try {
      entitlementService.assertHealthy();
    } catch {
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_approve", result: "failure", reasonSummary: "entitlement_preflight_failed", objectId: rec.id });
      res.status(500).json({
        code: "entitlement_store_invalid",
        message: "entitlements store is malformed — refusing to approve so the store is not reset; contact an admin",
      });
      return;
    }

    // Zero partial write: enable → entitlement → ledger, compensating rollback.
    const enabled = setSkillEnabled(rec.slug, true);
    if (!enabled) {
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_approve", result: "failure", reasonSummary: "enable_failed", objectId: rec.id });
      res.status(400).json({ code: "enable_failed", message: "failed to enable the skill" });
      return;
    }
    try {
      // EXACTLY one user-scope allow for the submitter (PUT replace semantics
      // guarantee no org-scope / other-user spill).
      entitlementService.setEntitlements(ctx, rec.slug, [
        { scopeType: "user", scopeId: rec.submitterUserId, effect: "allow" },
      ]);
    } catch (err) {
      try { setSkillEnabled(rec.slug, false); } catch {}
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_approve", result: "failure", reasonSummary: "entitlement_failed", objectId: rec.id });
      res.status(500).json({ code: "entitlement_failed", message: (err as Error).message });
      return;
    }
    try {
      const submission = userSkillSubmissionService.markReviewed({ id: rec.id, status: "approved", reviewer: ctx });
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_approve", result: "success", objectId: rec.id });
      res.json({ submission });
    } catch (err) {
      // Ledger transition failed (concurrent review) — roll back both writes.
      try { setSkillEnabled(rec.slug, false); } catch {}
      try { entitlementService.setEntitlements(ctx, rec.slug, []); } catch {}
      const code = err instanceof SubmissionStoreError ? err.code : "ledger_write_failed";
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_approve", result: "failure", reasonSummary: code, objectId: rec.id });
      res.status(409).json({ code, message: (err as Error).message });
    }
  });

  router.post("/:id/reject", (req, res) => {
    const ctx = requireAdmin(req, res, "user_skill_reject");
    if (!ctx) return;
    const rec = resolveForReview(req, res);
    if (!rec) return;

    const reasonCode = String((req.body as { reasonCode?: unknown } | undefined)?.reasonCode ?? "").trim();
    if (!REASON_CODE_RE.test(reasonCode)) {
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_reject", result: "failure", reasonSummary: "invalid_reason_code", objectId: rec.id });
      res.status(400).json({ code: "invalid_reason_code", message: "reasonCode must be a categorical token ^[a-z0-9_-]{1,64}$" });
      return;
    }

    // Ledger-only: registry stays enabled:false, ZERO entitlement writes.
    try {
      const submission = userSkillSubmissionService.markReviewed({ id: rec.id, status: "rejected", reviewer: ctx, reasonCode });
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_reject", result: "success", reasonSummary: reasonCode, objectId: rec.id });
      res.json({ submission });
    } catch (err) {
      const code = err instanceof SubmissionStoreError ? err.code : "ledger_write_failed";
      audit({ actorId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "user_skill_reject", result: "failure", reasonSummary: code, objectId: rec.id });
      res.status(409).json({ code, message: (err as Error).message });
    }
  });

  return router;
}
