/**
 * resource-registration.ts — M4 资源治理与企业分发闭环 (ACTIVE plan §M4).
 *
 * Models department-origin resource registration as control-plane governance
 * metadata OVER the shared skill/MCP/hook-plugin pool (the catalogs themselves
 * stay org-less — frozen boundary). The registration record is a reviewable
 * governance object: an org_admin submits a DRAFT for its own org only; an
 * enterprise admin reviews and publishes/rejects/disables it, then distributes
 * or revokes access per org THROUGH the existing entitlement layer.
 *
 *   status draft      → never resolvable (admin + submitting org visible only)
 *   status published  → resolvable; owner org auto-entitled on publish
 *                        (enterprise/admin-created resources: explicit dist only)
 *   status rejected   → never resolvable
 *   status disabled   → global kill switch; never resolvable for ANY org
 *
 * Resolve stays deny-by-intersection: the gate is a 4th leg in
 * agent-capabilities.resolveEnabledResourceIdsForApp (resource active state is
 * still enforced by the pool; app allowlist + entitlement + agent activation
 * unchanged). Existing runtimes converge via the current stop/rebuild policy —
 * no hot mutation.
 *
 * File-backed (data/resource-registrations.json, env override) for hermetic
 * unit-test parity with entitlements.json / agent-capabilities.json. Writes go
 * through the metadata-only governance_audit_log (no body/payload/secrets).
 *
 * See docs/开发计划/品牌与上线专项整体计划.md §M4.
 */
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import type { RequestContext, Role } from "./request-context.js";
import { capabilityResourceService, type CapabilityType } from "./capability-resource.js";
import { entitlementService, type EntitlementEntryInput, type EntitlementEntry } from "./entitlement.js";
import { writeGovernanceAudit, assertOrgActive, OrgNotActiveError } from "./org-governance.js";

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
const REGISTRATIONS_FILE =
  process.env.RESOURCE_REGISTRATIONS_FILE || path.resolve(DATA_DIR, "resource-registrations.json");

// ─── Types ───────────────────────────────────────────────────

export type RegistrationStatus = "draft" | "published" | "rejected" | "disabled";

export interface ResourceRegistration {
  id: string;
  resourceType: CapabilityType;
  resourceName: string; // == resourceId (globally unique in the shared pool)
  ownerOrgId: string | null; // null = admin-created enterprise resource (explicit-dist only)
  status: RegistrationStatus;
  submittedByUserId: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  rejectReason: string | null;
  description: string | null;
}

export interface SubmitDraftInput {
  resourceType: CapabilityType;
  resourceName: string;
  description?: string;
}

interface RegistrationStore {
  registrations: ResourceRegistration[];
}

// ─── Errors ──────────────────────────────────────────────────

export class RegistrationNotFoundError extends Error {
  constructor(id: string) {
    super(`Resource registration not found: "${id}"`);
    this.name = "RegistrationNotFoundError";
  }
}

export class RegistrationConflictError extends Error {
  constructor(resourceName: string) {
    super(`Resource "${resourceName}" is already registered`);
    this.name = "RegistrationConflictError";
  }
}

export class InvalidResourceError extends Error {
  constructor(resourceName: string, reason: string) {
    super(`Invalid capability resource "${resourceName}": ${reason}`);
    this.name = "InvalidResourceError";
  }
}

export class RegistrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationStateError";
  }
}

// M4 review fix #1: the registrations store is corrupted (unparseable / bad
// shape). Admin APIs throw this so a human can investigate + restore from a
// backup; resolve (isResolvable) fails CLOSED (deny-all) in the same state.
export class StoreCorruptedError extends Error {
  constructor() {
    super("Resource registrations store is corrupted — resolve is fail-closed (deny-all); admin API unavailable until restored");
    this.name = "StoreCorruptedError";
  }
}

// ─── Internal helpers ────────────────────────────────────────

// M4 review fix #1 (P0): a corrupted registrations file MUST NOT fail-open.
// If readFromDisk hits a parse error, the store is untrustworthy — we cannot
// know which resources are registered/published/disabled. The conservative,
// governance-fail-closed behavior: treat the store as corrupted (deny-all in
// resolve, error in admin APIs) rather than silently falling back to empty
// (which would let disabled/draft/rejected resources re-enter runtime via the
// no-row fallthrough). "File does not exist" is a legitimate empty store, NOT
// corruption. `corrupted` is set only on a real parse/shape failure.
let corrupted = false;

function readFromDisk(): RegistrationStore {
  corrupted = false;
  if (!fs.existsSync(REGISTRATIONS_FILE)) return { registrations: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRATIONS_FILE, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.registrations)) {
      return { registrations: raw.registrations as ResourceRegistration[] };
    }
    // Shape mismatch (e.g. truncated write) → corruption, not empty.
    corrupted = true;
    console.error("[ResourceRegistration] Store shape invalid (expected {registrations:[]}) — treating as CORRUPTED (fail-closed).");
    return { registrations: [] };
  } catch (err) {
    corrupted = true;
    console.error("[ResourceRegistration] Failed to parse store — treating as CORRUPTED (fail-closed):", err);
    return { registrations: [] };
  }
}

function writeToDisk(store: RegistrationStore): void {
  // M4 review fix #1: atomic write (temp file + rename) so a crash mid-write
  // cannot leave a truncated/corrupted store (which would flip resolve to
  // fail-closed OR, worse under the old code, fail-open). The temp file lives
  // in the same directory so the rename is atomic on POSIX (same filesystem).
  const dir = path.dirname(REGISTRATIONS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${REGISTRATIONS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmp, REGISTRATIONS_FILE);
}

function findById(store: RegistrationStore, id: string): ResourceRegistration | undefined {
  return store.registrations.find((r) => r.id === id);
}

function findByName(store: RegistrationStore, resourceName: string): ResourceRegistration | undefined {
  return store.registrations.find((r) => r.resourceName === resourceName);
}

const VALID_TYPES: ReadonlySet<CapabilityType> = new Set(["skill", "mcp", "hook-plugin", "connector"]);

// M4 review fix #1: admin APIs refuse to operate when the store is corrupted
// (so a human must investigate + restore). resolve (isResolvable) fails
// CLOSED in the same state. Call AFTER readFromDisk (which sets `corrupted`).
function requireNotCorrupted(): void {
  if (corrupted) throw new StoreCorruptedError();
}

// M4 review fix #4: build the entitlement set with the target org scope's
// effects FULLY REPLACED by a single `allow`. This clears any prior `deny`
// for that (scopeType, scopeId) — otherwise deny-overrides-allow
// (entitlement.ts resolveScope) would swallow the new allow and
// canConfigure would stay false. Other orgs' entries are preserved.
function mergeOrgAllow(existing: EntitlementEntry[], orgId: string): EntitlementEntryInput[] {
  const withoutTarget = existing.filter(
    (e) => !(e.scopeType === "org" && e.scopeId === orgId)
  );
  const merged: EntitlementEntryInput[] = withoutTarget.map((e) => ({
    scopeType: e.scopeType,
    scopeId: e.scopeId,
    effect: e.effect,
  }));
  merged.push({ scopeType: "org", scopeId: orgId, effect: "allow" });
  return merged;
}

// ─── Audit helper ────────────────────────────────────────────

function audit(input: {
  actorUserId?: string;
  actorRole: Role;
  orgId: string;
  action: string;
  objectId: string;
  result?: "success" | "failure" | "denied";
  reasonSummary?: string;
  fromOrgId?: string | null;
  toOrgId?: string | null;
}): void {
  writeGovernanceAudit({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    orgId: input.orgId,
    action: input.action,
    objectType: "resource_registration",
    objectId: input.objectId,
    fromOrgId: input.fromOrgId ?? null,
    toOrgId: input.toOrgId ?? null,
    result: input.result ?? "success",
    reasonSummary: input.reasonSummary ?? null,
  });
}

// ─── Public API ──────────────────────────────────────────────

export interface ResourceRegistrationService {
  submitDraft(ctx: RequestContext, input: SubmitDraftInput): ResourceRegistration;
  listForCtx(ctx: RequestContext): ResourceRegistration[];
  getForCtx(ctx: RequestContext, id: string): ResourceRegistration | null;
  publish(ctx: RequestContext, id: string): ResourceRegistration;
  reject(ctx: RequestContext, id: string, reason: string): ResourceRegistration;
  disable(ctx: RequestContext, id: string): ResourceRegistration;
  distribute(ctx: RequestContext, id: string, targetOrgId: string): ResourceRegistration;
  revoke(ctx: RequestContext, id: string, targetOrgId: string): ResourceRegistration;
  /** Resolve gate (M4). No registration OR published → true; draft/rejected/disabled → false. */
  isResolvable(resourceName: string): boolean;
  getRegistration(resourceName: string): ResourceRegistration | undefined;
}

class FileResourceRegistrationService implements ResourceRegistrationService {
  submitDraft(ctx: RequestContext, input: SubmitDraftInput): ResourceRegistration {
    if (ctx.role === "user") {
      audit({
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        orgId: ctx.orgId,
        action: "resource.draft.submit",
        objectId: input.resourceName,
        result: "denied",
        reasonSummary: "non-privileged actor",
      });
      throw new Error("Only privileged users may submit resource registrations");
    }
    if (!VALID_TYPES.has(input.resourceType)) {
      throw new InvalidResourceError(input.resourceName, `unknown type "${input.resourceType}"`);
    }
    const name = (input.resourceName ?? "").trim();
    if (!name) throw new InvalidResourceError(input.resourceName, "empty name");

    // Validate the resource EXISTS + is VALID in the shared pool. The name is
    // checked against the pool (not a path), so path traversal is structurally
    // impossible — there is no host path or MCP command here, only a pool key.
    const poolRes = capabilityResourceService.getResource(ctx, name);
    if (!poolRes || !poolRes.valid) {
      throw new InvalidResourceError(name, poolRes?.error ?? "not in shared pool");
    }
    if (poolRes.type !== input.resourceType) {
      throw new InvalidResourceError(name, `type mismatch (pool=${poolRes.type})`);
    }

    // owner org: admin → null (enterprise resource, explicit-dist only);
    // org_admin → ctx.orgId (trusted, NEVER from request body).
    const ownerOrgId = ctx.role === "admin" ? null : ctx.orgId;

    const store = readFromDisk();
    requireNotCorrupted();
    if (findByName(store, name)) throw new RegistrationConflictError(name);

    const now = new Date().toISOString();
    const reg: ResourceRegistration = {
      id: uuidv4(),
      resourceType: input.resourceType,
      resourceName: name,
      ownerOrgId,
      status: "draft",
      submittedByUserId: ctx.userId,
      submittedAt: now,
      reviewedAt: null,
      reviewedByUserId: null,
      rejectReason: null,
      description: input.description?.trim() || null,
    };
    store.registrations.push(reg);
    writeToDisk(store);
    audit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "resource.draft.submit",
      objectId: reg.id,
      reasonSummary: `name=${name} owner=${ownerOrgId ?? "enterprise"}`,
    });
    return reg;
  }

  listForCtx(ctx: RequestContext): ResourceRegistration[] {
    const store = readFromDisk();
    requireNotCorrupted();
    if (ctx.role === "admin") return store.registrations;
    // org_admin: own-org drafts only (ownerOrgId === ctx.orgId). Enterprise
    // (null-owner) registrations are admin-visible only — they are not "this
    // org's" resources. Cross-org drafts never leak.
    return store.registrations.filter((r) => r.ownerOrgId === ctx.orgId);
  }

  getForCtx(ctx: RequestContext, id: string): ResourceRegistration | null {
    const store = readFromDisk();
    requireNotCorrupted();
    const reg = findById(store, id);
    if (!reg) return null;
    if (ctx.role === "admin") return reg;
    // org_admin: own-org only. Foreign id → null (404 no-leak upstream).
    return reg.ownerOrgId === ctx.orgId ? reg : null;
  }

  publish(ctx: RequestContext, id: string): ResourceRegistration {
    if (ctx.role !== "admin") throw new Error("Only an enterprise admin may publish resources");
    const store = readFromDisk();
    requireNotCorrupted();
    const reg = findById(store, id);
    if (!reg) throw new RegistrationNotFoundError(id);
    if (reg.status === "published") throw new RegistrationStateError("Resource is already published");

    // M4 review fix #2 (P1): write the owner-org entitlement BEFORE flipping
    // status to "published". If the entitlement write throws, the reg stays
    // non-published → resolve still excludes it (draft/disabled). The only
    // reachable half-state is "entitled-but-not-published", which is SAFE
    // because the resolve gate keys on status (not-published → excluded).
    // The inverse ("published-but-not-entitled") can NEVER happen now.
    // M4 review fix #4: mergeOrgAllow replaces the FULL org-scope effect set
    // (clears prior deny) so canConfigure(ownerCtx) === true after publish.
    if (reg.ownerOrgId !== null) {
      const existing = entitlementService.listEntries(reg.resourceName);
      const merged = mergeOrgAllow(existing, reg.ownerOrgId);
      entitlementService.setEntitlements(ctx, reg.resourceName, merged);
    }

    const now = new Date().toISOString();
    reg.status = "published";
    reg.reviewedAt = now;
    reg.reviewedByUserId = ctx.userId;
    reg.rejectReason = null;
    writeToDisk(store);
    audit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "resource.publish",
      objectId: reg.id,
      reasonSummary: `name=${reg.resourceName} owner=${reg.ownerOrgId ?? "enterprise"}`,
      toOrgId: reg.ownerOrgId,
    });
    return reg;
  }

  reject(ctx: RequestContext, id: string, reason: string): ResourceRegistration {
    if (ctx.role !== "admin") throw new Error("Only an enterprise admin may reject resources");
    const store = readFromDisk();
    requireNotCorrupted();
    const reg = findById(store, id);
    if (!reg) throw new RegistrationNotFoundError(id);
    if (reg.status !== "draft") {
      throw new RegistrationStateError(`Cannot reject a resource in status "${reg.status}"`);
    }
    const now = new Date().toISOString();
    reg.status = "rejected";
    reg.reviewedAt = now;
    reg.reviewedByUserId = ctx.userId;
    reg.rejectReason = (reason ?? "").trim().slice(0, 500) || null;
    writeToDisk(store);
    audit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "resource.reject",
      objectId: reg.id,
      reasonSummary: `name=${reg.resourceName}`,
    });
    return reg;
  }

  disable(ctx: RequestContext, id: string): ResourceRegistration {
    if (ctx.role !== "admin") throw new Error("Only an enterprise admin may disable resources");
    const store = readFromDisk();
    requireNotCorrupted();
    const reg = findById(store, id);
    if (!reg) throw new RegistrationNotFoundError(id);
    if (reg.status === "disabled") throw new RegistrationStateError("Resource is already disabled");
    const now = new Date().toISOString();
    reg.status = "disabled";
    reg.reviewedAt = now;
    reg.reviewedByUserId = ctx.userId;
    writeToDisk(store);
    // Resolve gate excludes disabled resources globally — entitlements are left
    // intact so a re-publish restores access without re-distributing.
    audit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "resource.disable",
      objectId: reg.id,
      reasonSummary: `name=${reg.resourceName} (global kill switch)`,
    });
    return reg;
  }

  distribute(ctx: RequestContext, id: string, targetOrgId: string): ResourceRegistration {
    if (ctx.role !== "admin") throw new Error("Only an enterprise admin may distribute resources");
    const target = (targetOrgId ?? "").trim();
    if (!target) throw new Error("Target orgId required");
    // M4 review fix #3 (P1): only allow distribution to an EXISTING + ACTIVE
    // org. assertOrgActive throws OrgNotActiveError for a non-existent or
    // non-active orgId (suspended/provisioning/archived). The caller (route)
    // maps that to 403. This blocks distributing to forged/suspended depts.
    try {
      assertOrgActive(target);
    } catch (e) {
      if (e instanceof OrgNotActiveError) throw e;
      throw e;
    }
    const store = readFromDisk();
    requireNotCorrupted();
    const reg = findById(store, id);
    if (!reg) throw new RegistrationNotFoundError(id);
    if (reg.status !== "published") {
      throw new RegistrationStateError(`Cannot distribute a resource in status "${reg.status}"`);
    }
    // M4 review fix #4: mergeOrgAllow replaces the FULL target-org-scope
    // effect set (clears prior deny) → canConfigure(targetCtx) === true.
    const existing = entitlementService.listEntries(reg.resourceName);
    const merged = mergeOrgAllow(existing, target);
    entitlementService.setEntitlements(ctx, reg.resourceName, merged);
    audit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "resource.distribute",
      objectId: reg.id,
      reasonSummary: `name=${reg.resourceName} → org=${target}`,
      toOrgId: target,
    });
    return reg;
  }

  revoke(ctx: RequestContext, id: string, targetOrgId: string): ResourceRegistration {
    if (ctx.role !== "admin") throw new Error("Only an enterprise admin may revoke resources");
    const target = (targetOrgId ?? "").trim();
    if (!target) throw new Error("Target orgId required");
    const store = readFromDisk();
    requireNotCorrupted();
    const reg = findById(store, id);
    if (!reg) throw new RegistrationNotFoundError(id);
    // Revoke = remove the org-scope allow for the target. Admin bypasses
    // canConfigure, so revoke works on any registration (incl. disabled —
    // though resolve already excludes it, this also clears the entitlement).
    const existing = entitlementService.listEntries(reg.resourceName);
    const filtered = existing.filter(
      (e) => !(e.scopeType === "org" && e.scopeId === target && e.effect === "allow")
    );
    const merged: EntitlementEntryInput[] = filtered.map((e) => ({
      scopeType: e.scopeType,
      scopeId: e.scopeId,
      effect: e.effect,
    }));
    entitlementService.setEntitlements(ctx, reg.resourceName, merged);
    audit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "resource.revoke",
      objectId: reg.id,
      reasonSummary: `name=${reg.resourceName} ✕ org=${target}`,
      fromOrgId: target,
    });
    return reg;
  }

  isResolvable(resourceName: string): boolean {
    const store = readFromDisk();
    // M4 review fix #1 (P0): a CORRUPTED store is fail-closed — deny ALL
    // resources (return false). We cannot trust the no-row fallthrough when
    // the store itself is unparseable (a disabled resource's registration may
    // be in the corrupted file but unreadable). Deny-all blocks every new
    // runtime until a human restores the store. Governance fails closed.
    if (corrupted) return false;
    const reg = findByName(store, resourceName);
    if (!reg) return true; // no registration → legacy fallthrough
    return reg.status === "published";
  }

  getRegistration(resourceName: string): ResourceRegistration | undefined {
    const store = readFromDisk();
    requireNotCorrupted();
    return findByName(store, resourceName);
  }
}

export const resourceRegistrationService: ResourceRegistrationService =
  new FileResourceRegistrationService();
