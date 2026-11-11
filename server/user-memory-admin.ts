/**
 * user-memory-admin.ts — PURE authorization policy for enterprise admin access
 * to a user's memory document. Mirrors the request-context.checkUserMutation
 * pattern (pure → unit-testable without an Express harness).
 *
 * Memory body view / clear / quota are ENTERPRISE-ADMIN ONLY:
 * - admin: cross-org super-user (may read/clear any user's memory, set quota).
 * - org_admin: NO memory body/clear access. Own-org → "forbidden"; cross-org is
 *   still hidden as "not found" so existence is not leaked across orgs.
 * - user: no access ("forbidden").
 *
 * The HTTP routes additionally gate on isAdminReq (defense-in-depth); this
 * policy documents intent and stays correct if a route gate is ever relaxed.
 */
import type { Role } from "./request-context.js";

export function authorizeMemoryAccess(args: {
  actorRole: Role;
  actorOrg: string;
  targetOrg: string;
}): string | null {
  const { actorRole, actorOrg, targetOrg } = args;
  if (actorRole === "admin") return null;
  if (actorRole === "org_admin") {
    // Memory body / clear are enterprise-admin only. Own-org org_admin is
    // denied; cross-org stays "not found" (no existence leak).
    return targetOrg === actorOrg ? "forbidden" : "not found";
  }
  return "forbidden";
}
