/**
 * app-principal.ts — P0.1 (Agent OS §4) application user execution-identity
 * decoupling: minimal internal principal registry + resolver.
 *
 * WHY THIS EXISTS
 * The data plane (session, container-manager, file-workspace-service,
 * event-store, agent-service) keys everything on an opaque `userId` string
 * (Map<userId:chatId>, WHERE user_id=?). Only the admin/auth boundary in
 * server.ts calls getUserById / needs a platform role+org. So instead of
 * widening every ownership column with a kind/subject pair, we let the value
 * domain of those columns widen from "platform users.id" to
 * "platform users.id | app_principals.id". The data plane is untouched; only
 * this module + the admin/auth boundary (P0.2/P0.3) need to know the
 * distinction.
 *
 * SCOPE (P0.1 only)
 *   - app_principals table (declared in database.ts)
 *   - getOrCreateAppPrincipal / resolvePrincipal / setStatus
 *   - principalKey for audit logging (never parsed back)
 * NOT in P0.1: Token minting, WS wiring, admin getUserById refactor,
 *   delegation, trusted-mapping inheritance, jti denylist.
 *
 * 铁律 (invariants — enforced here):
 *   - subject is OPAQUE; never interpreted as role/org/permission.
 *   - org_id comes ONLY from the verified app key (applications.org_id), never
 *     from the subject or request body. getOrCreate asserts principal.org_id ==
 *     app.org_id and rejects on mismatch.
 *   - UNIQUE(app_id, subject) ⇒ (app, subject) → one stable principalId; same
 *     subject across two apps → two distinct principalIds.
 *
 * See docs/开发计划/agent-os-overall-plan.md §4 and the round-2 review
 * (evt_20260821103540).
 */

import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import { applicationService } from "./application-service.js";
import { DEFAULT_ORG_ID, type Role } from "./request-context.js";

// ─── Types ───────────────────────────────────────────────────

export interface PlatformPrincipal {
  kind: "platform";
  principalId: string; // == users.id (opaque data-plane key)
  userId: string; // == users.id (same value; present for boundary code that
  //               // still names it "userId")
  role: Role;
  orgId: string;
  status: "active" | "disabled";
}

export interface AppPrincipal {
  kind: "app";
  principalId: string; // == app_principals.id (opaque data-plane key)
  appId: string;
  subject: string; // opaque; audit/lookup only
  orgId: string; // trusted tenant key; sourced from app key, not subject
  status: "active" | "disabled";
}

export type Principal = PlatformPrincipal | AppPrincipal;

// ─── Guards ──────────────────────────────────────────────────

const SUBJECT_MAX_LEN = 256;

/**
 * Validate an opaque subject handle. It must be a non-empty, bounded, non-NUL
 * string. The platform never interprets its content — this check only prevents
 * degenerate values (empty / oversize / control chars) from entering the
 * UNIQUE index and breaking lookups.
 */
function validateSubject(subject: string): void {
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error("app principal subject must be a non-empty string");
  }
  if (subject.length > SUBJECT_MAX_LEN) {
    throw new Error(
      `app principal subject too long (${subject.length} > ${SUBJECT_MAX_LEN})`
    );
  }
  if (subject.includes("\0")) {
    throw new Error("app principal subject must not contain NUL");
  }
}

// ─── Prepared statements ─────────────────────────────────────

const stmts = {
  insert: db.prepare(
    `INSERT OR IGNORE INTO app_principals (id, app_id, subject, org_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`
  ),
  getById: db.prepare(
    `SELECT id, app_id AS appId, subject, org_id AS orgId, status
     FROM app_principals WHERE id = ?`
  ),
  getByAppSubject: db.prepare(
    `SELECT id, app_id AS appId, subject, org_id AS orgId, status
     FROM app_principals WHERE app_id = ? AND subject = ?`
  ),
  setStatus: db.prepare(
    `UPDATE app_principals SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  // Platform-user lookup for resolvePrincipal. Mirrors auth.findById shape but
  // kept local so this module does not depend on auth's prepared-statement cache.
  findUserByPrincipal: db.prepare(
    `SELECT id, role, org_id AS orgId, status FROM users WHERE id = ?`
  ),
};

// ─── Service ─────────────────────────────────────────────────

/**
 * Look up or create the internal app principal for (appId, subject).
 *
 * `trustedAppOrgId` MUST be the org resolved from the verified app key
 * (applicationService.verifyAppKeyWithOrg → applications.org_id). This is the
 * SOLE trusted source for the principal's org_id; the subject is never trusted
 * to carry org. We assert the caller's value matches applications.org_id as a
 * belt-and-suspenders guard against a caller that passes a stale/forged org.
 *
 * Idempotent: the UNIQUE(app_id, subject) index means a repeated call for the
 * same pair returns the same principalId. `INSERT OR IGNORE` + `SELECT` is
 * atomic under SQLite's serial writer; the SELECT always finds the row.
 */
export function getOrCreateAppPrincipal(
  appId: string,
  subject: string,
  trustedAppOrgId: string
): AppPrincipal {
  validateSubject(subject);
  if (!appId) throw new Error("appId is required");

  // Cross-check the trusted org against the authoritative app record. The app
  // key resolution already did this (keyApp.orgId), so a mismatch here means
  // the caller is buggy or attempting to forge org via a stale app record.
  const app = applicationService.getApplication(appId);
  if (!app) {
    throw new Error(`application not found: ${appId}`);
  }
  if (app.orgId !== trustedAppOrgId) {
    // Never disclose which side is wrong — just reject.
    throw new Error("app principal org_id does not match the verified application org");
  }

  // Fast path: existing principal for (app, subject).
  const existing = stmts.getByAppSubject.get(appId, subject) as
    | { id: string; appId: string; subject: string; orgId: string; status: string }
    | undefined;
  if (existing) {
    return normalizeAppRow(existing);
  }

  const id = uuidv4();
  stmts.insert.run(id, appId, subject, trustedAppOrgId);
  const row = stmts.getById.get(id) as {
    id: string; appId: string; subject: string; orgId: string; status: string;
  };
  return normalizeAppRow(row);
}

/**
 * Resolve an opaque principalId (the value stored in user_id/owner_user_id /
 * Map keys) into a typed Principal. app_principals is checked first; if no app
 * principal matches, fall back to the platform users table. Returns null for
 * an unknown id (deleted / never existed) — callers MUST treat null as "no
 * principal" and deny, never as a platform user.
 *
 * This is the single point that knows the platform/app distinction. Every
 * data-plane consumer stays unchanged; only the auth/admin boundary calls this.
 */
export function resolvePrincipal(principalId: string): Principal | null {
  if (!principalId) return null;

  const appRow = stmts.getById.get(principalId) as
    | { id: string; appId: string; subject: string; orgId: string; status: string }
    | undefined;
  if (appRow) {
    return normalizeAppRow(appRow);
  }

  const userRow = stmts.findUserByPrincipal.get(principalId) as
    | { id: string; role: Role; orgId: string; status: string }
    | undefined;
  if (userRow) {
    return {
      kind: "platform",
      principalId: userRow.id,
      userId: userRow.id,
      role: userRow.role,
      orgId: userRow.orgId ?? DEFAULT_ORG_ID,
      status: (userRow.status as "active" | "disabled") ?? "active",
    };
  }

  return null;
}

/**
 * Set an app principal's status (active|disabled). Used by the auth boundary
 * (P0.2) to deny a revoked app principal on every WS connect, mirroring
 * verifyUserTokenCurrent. Returns the affected row count (0 = no such principal).
 */
export function setAppPrincipalStatus(
  principalId: string,
  status: "active" | "disabled"
): number {
  return stmts.setStatus.run(status, principalId).changes;
}

/**
 * Format a principal as a stable audit key: `platform:<userId>` or
 * `app:<appId>:<subject>`. This string is for LOGGING/AUDIT ONLY — it is never
 * parsed back into identity. The authoritative identity is always obtained via
 * resolvePrincipal(principalId). The `:` delimiter is safe precisely because
 * nothing parses it.
 */
export function principalKey(p: Principal): string {
  return p.kind === "platform"
    ? `platform:${p.userId}`
    : `app:${p.appId}:${p.subject}`;
}

// ─── Internal ───────────────────────────────────────────────

function normalizeAppRow(row: {
  id: string; appId: string; subject: string; orgId: string; status: string;
}): AppPrincipal {
  return {
    kind: "app",
    principalId: row.id,
    appId: row.appId,
    subject: row.subject,
    orgId: row.orgId,
    status: (row.status as "active" | "disabled"),
  };
}
