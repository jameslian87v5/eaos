/**
 * application-access.ts — Agent OS M2 application access grants.
 *
 * Gates which platform principals (an `org` or a platform `user`) may enter an
 * Application via the AppKey + platform-JWT path. Deny by default: a platform
 * user with a valid AppKey is still refused unless the Application has an
 * active `org` grant matching the user's org_id, or an active `user` grant
 * matching the user_id.
 *
 * Scope (M2, frozen):
 *   - Only `org` and `user` grant types.
 *   - No roles, groups, inheritance, policy expressions, or business
 *     permission fields. A grant is a binary allow for Application ENTRY only.
 *   - App-principal (app-scoped Runtime Token) access is authorized by the
 *     signed token (resolvePrincipal) and does NOT create a row here.
 *   - Legacy platform workbench routes (/api/chats, /ws) are unchanged.
 *
 * The effective capability set inside an Application is a separate, narrower
 * intersection (app allowlist ∩ entitlement ∩ agent activation ∩ resource
 * enabled); see capability-provider.ts. A grant only answers "may this platform
 * principal enter this Application at all".
 *
 * See docs/开发计划/agent-os-overall-plan.md §6.
 */

import { v4 as uuidv4 } from "uuid";
import db from "./database.js";

export type AccessGrantPrincipalType = "org" | "user";

export interface ApplicationAccessGrant {
  id: string;
  appId: string;
  principalType: AccessGrantPrincipalType;
  principalId: string; // org_id for 'org', platform user_id for 'user'
  status: "active" | "revoked";
  grantedBy: string;
  grantedAt: string;
  updatedAt: string;
}

export interface AccessGrantInputItem {
  principalType: AccessGrantPrincipalType;
  principalId: string;
}

export interface ReplaceAccessGrantsInput {
  grants: AccessGrantInputItem[];
}

// ─── Prepared statements ─────────────────────────────────────

const stmts = {
  listByApp: db.prepare(
    `SELECT id, app_id AS appId, principal_type AS principalType,
            principal_id AS principalId, status, granted_by AS grantedBy,
            granted_at AS grantedAt, updated_at AS updatedAt
     FROM application_access_grants WHERE app_id = ?
     ORDER BY principal_type ASC, granted_at ASC`
  ),
  activeOrgForApp: db.prepare(
    `SELECT 1 FROM application_access_grants
     WHERE app_id = ? AND principal_type = 'org' AND principal_id = ?
       AND status = 'active' LIMIT 1`
  ),
  activeUserForApp: db.prepare(
    `SELECT 1 FROM application_access_grants
     WHERE app_id = ? AND principal_type = 'user' AND principal_id = ?
       AND status = 'active' LIMIT 1`
  ),
  hasAnyForApp: db.prepare(
    `SELECT 1 FROM application_access_grants WHERE app_id = ? LIMIT 1`
  ),
  upsert: db.prepare(
    `INSERT INTO application_access_grants
       (id, app_id, principal_type, principal_id, status, granted_by, granted_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(app_id, principal_type, principal_id) DO UPDATE SET
       status = 'active', granted_by = excluded.granted_by,
       granted_at = excluded.granted_at, updated_at = excluded.updated_at`
  ),
  deleteByApp: db.prepare(
    `DELETE FROM application_access_grants WHERE app_id = ?`
  ),
};

// ─── Service ─────────────────────────────────────────────────

class ApplicationAccessServiceImpl {
  /** List all grants for an Application (admin/audit view). */
  listGrants(appId: string): ApplicationAccessGrant[] {
    return stmts.listByApp.all(appId) as ApplicationAccessGrant[];
  }

  /**
   * Deny-default entry check for a platform principal. True iff an active
   * `org` grant matches the user's org_id, or an active `user` grant matches
   * the user_id. No grants for the app → false (deny).
   *
   * Admin bypass is the caller's responsibility (admin recovers across org);
   * this method only answers the grant question for the given principal.
   */
  hasAccess(appId: string, userId: string, userOrgId: string): boolean {
    if (stmts.activeUserForApp.get(appId, userId)) return true;
    if (stmts.activeOrgForApp.get(appId, userOrgId)) return true;
    return false;
  }

  /** True iff the Application has at least one grant of any status. */
  hasAnyGrant(appId: string): boolean {
    return !!stmts.hasAnyForApp.get(appId);
  }

  /**
   * Replace the full grant set for an Application in one transaction.
   * Caller is responsible for governance validation (app existence, org_admin
   * boundary, cross-org user rejection, user existence) — this method is a
   * thin DB writer. Returns the post-replace active grant list.
   */
  replaceGrants(
    appId: string,
    input: ReplaceAccessGrantsInput,
    grantedBy: string
  ): ApplicationAccessGrant[] {
    const now = new Date().toISOString();
    const replace = db.transaction(() => {
      stmts.deleteByApp.run(appId);
      const seen = new Set<string>();
      for (const g of input.grants) {
        const key = `${g.principalType}:${g.principalId}`;
        if (seen.has(key)) continue; // idempotent dedupe within payload
        seen.add(key);
        stmts.upsert.run(
          uuidv4(),
          appId,
          g.principalType,
          g.principalId,
          grantedBy,
          now,
          now
        );
      }
    });
    replace();
    return this.listGrants(appId);
  }
}

export const applicationAccessGrantsService = new ApplicationAccessServiceImpl();
