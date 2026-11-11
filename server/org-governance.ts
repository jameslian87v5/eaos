/**
 * org-governance.ts — M1 单企业多部门治理闭环 (ACTIVE plan).
 *
 * Owns the four M1 primitives the rest of the server consumes:
 *   1. org status read + the assertOrgActive guard (the cross-cutting gate).
 *   2. last-effective-org_admin protection (countActiveOrgAdmins + assertNotLastOrgAdmin).
 *   3. governance audit writes (metadata only — never body/payload/secrets).
 *   4. the atomic provision transaction + legal status transitions.
 *
 * M1 boundary (per ACTIVE plan §M1): quotas + audit are WRITE-ONLY here (no
 * enforcement, no query/export — those are M5). Status gating is the primitive;
 * active JWT invalidation / token versioning / dept migration are M2. A user
 * whose org is suspended mid-session retains access only within an already-open
 * WS session; reconnect is rejected by the WS-connect guard.
 *
 * No import of auth.ts at module top except the low-level insertUserRow (one-way
 * dep: auth.ts does not import this module) to avoid a cycle. bcrypt hashing is
 * done OUTSIDE the synchronous provision transaction.
 */
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import { isValidOrgId, type Organization } from "./org-service.js";
import { insertUserRow, validatePasswordStrength } from "./auth.js";
import type { Role } from "./request-context.js";

// ─── Status model ──────────────────────────────────────────────────────
export type OrgStatus = "provisioning" | "active" | "suspended" | "archived";

export const ORG_STATUSES: ReadonlySet<OrgStatus> = new Set([
  "provisioning",
  "active",
  "suspended",
  "archived",
]);

/**
 * Legal admin-driven transitions. `provisioning → active` is taken implicitly
 * by the provision transaction on success (not exposed as an admin action). M1
 * exposes only `active ↔ suspended`; `archived` is reserved (no entry point).
 * Every other jump is rejected. Indexed by current status.
 */
const LEGAL_TRANSITIONS: Record<OrgStatus, Partial<Record<OrgAction, OrgStatus>>> = {
  provisioning: {}, // only the provision txn flips provisioning → active
  active: { suspend: "suspended" },
  suspended: { activate: "active" },
  archived: {}, // terminal-for-daily-use; M1 has no un-archive path
};

export type OrgAction = "suspend" | "activate";

// ─── Errors ────────────────────────────────────────────────────────────
/** Thrown when an org is not `active` and the caller is at a status gate. */
export class OrgNotActiveError extends Error {
  constructor(public orgId: string, public status: OrgStatus | null) {
    super(
      status
        ? `Organization "${orgId}" is ${status} (not active)`
        : `Organization "${orgId}" does not exist`
    );
    this.name = "OrgNotActiveError";
  }
}

/** Thrown when an action would remove the last effective org_admin of an org. */
export class LastOrgAdminError extends Error {
  constructor(public orgId: string) {
    super(`Cannot remove the last effective org_admin of organization "${orgId}"`);
    this.name = "LastOrgAdminError";
  }
}

// ─── Prepared statements ───────────────────────────────────────────────
const stmts = {
  getStatus: db.prepare(`SELECT status FROM organizations WHERE id = ?`),
  getForUpdate: db.prepare(
    `SELECT id, name, status, created_at AS createdAt FROM organizations WHERE id = ?`
  ),
  insertOrg: db.prepare(`INSERT INTO organizations (id, name, status) VALUES (?, ?, ?)`),
  setStatus: db.prepare(`UPDATE organizations SET status = ? WHERE id = ?`),
  insertQuota: db.prepare(`INSERT INTO org_quotas (org_id) VALUES (?)`),
  countActiveOrgAdmins: db.prepare(
    `SELECT COUNT(*) as count FROM users WHERE org_id = ? AND role = 'org_admin' AND status = 'active'`
  ),
  countActiveOrgAdminsExcl: db.prepare(
    `SELECT COUNT(*) as count FROM users WHERE org_id = ? AND role = 'org_admin' AND status = 'active' AND id <> ?`
  ),
  insertAudit: db.prepare(
    `INSERT INTO governance_audit_log
      (id, actor_user_id, actor_role, org_id, action, object_type, object_id,
       from_org_id, to_org_id, result, reason_summary, request_id, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
};

// ─── Status read + guard ───────────────────────────────────────────────
/** Read an org's status. Returns null when the org row does not exist. */
export function getOrgStatus(orgId: string): OrgStatus | null {
  const row = stmts.getStatus.get(orgId) as { status: string } | undefined;
  if (!row) return null;
  return ORG_STATUSES.has(row.status as OrgStatus) ? (row.status as OrgStatus) : null;
}

/**
 * The cross-cutting M1 status gate. Throws OrgNotActiveError unless the org
 * exists AND is `active`. Callers at login, WS connect, widget-token mint,
 * runtime create, and file upload wrap this in try/catch and render the
 * appropriate 403 / ws.close(4003).
 */
export function assertOrgActive(orgId: string): void {
  const status = getOrgStatus(orgId);
  if (status !== "active") throw new OrgNotActiveError(orgId, status);
}

/** Like assertOrgActive but returns a boolean (no throw) for cheap pre-checks. */
export function isOrgActive(orgId: string): boolean {
  return getOrgStatus(orgId) === "active";
}

// ─── Last org_admin protection ─────────────────────────────────────────
/** Count EFFECTIVE (enabled, status='active') org_admins in an org. M2: a
 *  disabled org_admin no longer counts — disabling the last enabled org_admin
 *  of a department is refused so it never becomes unmanageable. */
export function countActiveOrgAdmins(orgId: string): number {
  const row = stmts.countActiveOrgAdmins.get(orgId) as { count: number };
  return row.count;
}

/**
 * Guard for any action that would remove (demote or delete) a target user from
 * the org_admin role. Throws LastOrgAdminError if the target is currently an
 * org_admin of `orgId` AND no other org_admin would remain. No-op otherwise.
 * Callers: PATCH /api/admin/users/:id (demote) + DELETE /api/admin/users/:id.
 */
export function assertNotLastOrgAdmin(orgId: string, targetUserId: string, targetCurrentRole: Role): void {
  if (targetCurrentRole !== "org_admin") return; // removing a non-admin can't strip the last admin
  const row = stmts.countActiveOrgAdminsExcl.get(orgId, targetUserId) as { count: number };
  if (row.count < 1) throw new LastOrgAdminError(orgId);
}

// ─── Governance audit (metadata only) ──────────────────────────────────
export interface GovernanceAuditInput {
  actorUserId?: string | null;
  actorRole?: Role | "system" | null;
  orgId: string;
  action: string; // e.g. "org.provision", "org.suspend", "org.last_admin_denied"
  objectType?: string | null;
  objectId?: string | null;
  fromOrgId?: string | null;
  toOrgId?: string | null;
  result?: "success" | "failure" | "denied";
  reasonSummary?: string | null; // short categorical reason — NEVER secrets/body/payload
  requestId?: string | null;
  traceId?: string | null;
}

/**
 * Write a governance audit row. Enforced metadata-only: callers pass only the
 * fields above; the schema has no body/payload column. Cheapest possible path
 * (one prepared insert) so it can sit in the provision transaction.
 */
export function writeGovernanceAudit(input: GovernanceAuditInput): void {
  stmts.insertAudit.run(
    uuidv4(),
    input.actorUserId ?? null,
    input.actorRole ?? null,
    input.orgId,
    input.action,
    input.objectType ?? null,
    input.objectId ?? null,
    input.fromOrgId ?? null,
    input.toOrgId ?? null,
    input.result ?? "success",
    input.reasonSummary ?? null,
    input.requestId ?? null,
    input.traceId ?? null
  );
}

// ─── Provision transaction ─────────────────────────────────────────────
export interface ProvisionInput {
  id: string;
  name: string;
  firstAdminUsername: string;
  firstAdminPassword: string;
  firstAdminDisplayName?: string;
  actorUserId: string;
  actorRole: Role;
  requestId?: string;
}

export interface ProvisionResult {
  org: Organization & { status: OrgStatus };
  adminUserId: string;
}

const SALT_ROUNDS = 10;

/**
 * Atomically provision a department: create org (provisioning) → create first
 * org_admin (must_change_password=1) → create default quota row → write audit →
 * flip org to active. The ENTIRE sequence runs in one better-sqlite3
 * transaction; any throw rolls back ALL of it, so a half-configured but
 * loginable department can never exist (design §3 iron law).
 *
 * bcrypt hashing happens BEFORE the transaction (it is async; better-sqlite3
 * txns are synchronous). Validation also happens before, so the txn only throws
 * on true concurrency/race (e.g. dup id) → which rolls back cleanly.
 */
export async function provisionOrg(input: ProvisionInput): Promise<ProvisionResult> {
  const id = input.id?.trim();
  const name = input.name?.trim();
  const adminUsername = input.firstAdminUsername?.trim();
  const adminPassword = input.firstAdminPassword;

  // Validate inputs BEFORE hashing/txn (cheap, deterministic).
  if (!id || !isValidOrgId(id)) {
    throw new Error("Invalid org id (lowercase alphanumerics + dashes, max 64)");
  }
  if (!name) throw new Error("Org name required");
  if (!adminUsername) throw new Error("First admin username required");
  const strengthErr = validatePasswordStrength(adminPassword);
  if (strengthErr) throw new Error(`First admin password: ${strengthErr}`);

  // Hash OUTSIDE the transaction (async). The hash is the only thing carried in.
  const passwordHash = await bcrypt.hash(adminPassword, SALT_ROUNDS);
  const adminId = uuidv4();
  const now = new Date().toISOString();

  // Synchronous transaction — all-or-nothing.
  const txn = db.transaction(() => {
    // Re-check existence inside the txn to close the race (two concurrent
    // provisions of the same id). INSERT will also fail via PK, but the
    // explicit check yields a clean error message.
    const existing = stmts.getForUpdate.get(id);
    if (existing) throw new Error(`Org "${id}" already exists`);

    stmts.insertOrg.run(id, name, "provisioning");
    insertUserRow({
      id: adminId,
      username: adminUsername,
      passwordHash,
      displayName: input.firstAdminDisplayName?.trim() || adminUsername,
      role: "org_admin",
      mustChangePassword: 1, // first-login password change (design §3.3)
      orgId: id,
      createdAt: now,
    });
    stmts.insertQuota.run(id); // default row; M5 fills numbers + enforces
    writeGovernanceAudit({
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      orgId: id,
      action: "org.provision",
      objectType: "organization",
      objectId: id,
      result: "success",
      reasonSummary: "department provisioned with first org_admin + default quota",
      requestId: input.requestId ?? null,
    });
    // Flip provisioning → active as the final atomic step. On any earlier throw
    // the whole txn (including this org row) rolls back, so no half-state.
    stmts.setStatus.run("active", id);

    const org = stmts.getForUpdate.get(id) as Organization & { status: OrgStatus };
    return { org, adminUserId: adminId };
  });

  return txn();
}

// ─── Status transitions (admin actions) ────────────────────────────────
export interface TransitionInput {
  orgId: string;
  action: OrgAction;
  actorUserId: string;
  actorRole: Role;
  requestId?: string;
}

/**
 * Apply an admin-driven status transition. Validates the transition against the
 * legal graph; rejects illegal jumps (e.g. provisioning → suspended, archived
 * un-archive). Writes an audit row. Throws on illegal transition or unknown org.
 */
export function transitionOrgStatus(input: TransitionInput): Organization & { status: OrgStatus } {
  const txn = db.transaction(() => {
    const org = stmts.getForUpdate.get(input.orgId) as
      | (Organization & { status: OrgStatus })
      | undefined;
    if (!org) throw new Error(`Org "${input.orgId}" not found`);

    const next = LEGAL_TRANSITIONS[org.status]?.[input.action];
    if (!next) {
      throw new Error(
        `Illegal status transition: ${org.status} --${input.action}--> (not allowed)`
      );
    }
    stmts.setStatus.run(next, input.orgId);
    writeGovernanceAudit({
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      orgId: input.orgId,
      action: `org.${input.action}`,
      objectType: "organization",
      objectId: input.orgId,
      result: "success",
      reasonSummary: `status ${org.status} → ${next}`,
      requestId: input.requestId ?? null,
    });
    return stmts.getForUpdate.get(input.orgId) as Organization & { status: OrgStatus };
  });
  return txn();
}
