import type { Request } from "express";

/**
 * RequestContext — the control-plane call context carried into capability
 * services (entitlement, activation, resolution). It carries identity + org, NEVER
 * runtime execution specs (no tools/plugins/mcpServers/host paths). See
 * docs/02-architecture/configuration-plane-interface-design.md §4/§5.
 */
// Phase 7.2: three-tier role model. admin = cross-org super-user;
// org_admin = own-org administrator (users/agents/profiles/applications within
// one org); user = regular operator. Carried in the JWT claim (trusted source).
export type Role = "admin" | "org_admin" | "user";

/** Privileged roles = admin + org_admin (the two tiers that may enter /api/admin). */
export function isPrivilegedRole(role: string | undefined | null): boolean {
  return role === "admin" || role === "org_admin";
}

/** admin OR org_admin — the gate for org-scopable admin routes. */
export function isPrivilegedReq(req: Request): boolean {
  return isPrivilegedRole((req as any).userRole);
}

/** admin only — the gate for global-only admin routes (runtime/skills/mcp/...). */
export function isAdminReq(req: Request): boolean {
  return (req as any).userRole === "admin";
}

/**
 * Phase 7.2 user-management policy — PURE so it is unit-testable without an
 * Express harness (the project has none). Returns a denial reason, or null when
 * the mutation is allowed. Encodes the org_admin iron laws:
 *   - admin: cross-org super-user (last-admin protection is the caller's job);
 *   - org_admin: own-org only; cannot touch a privileged account; cannot grant
 *     a privileged role.
 * For a CREATE, call with targetCurrentRole "user" and targetOrg = the org the
 * account will be created in (org_admin's own org).
 */
export function checkUserMutation(args: {
  actorRole: Role;
  actorOrg: string;
  targetOrg: string;
  targetCurrentRole: Role;
  desiredRole: Role;
}): string | null {
  const { actorRole, actorOrg, targetOrg, targetCurrentRole, desiredRole } = args;
  if (actorRole === "admin") return null; // super-user (last-admin guard applied separately)
  if (targetOrg !== actorOrg) return "not found"; // cross-org → caller renders 404
  if (isPrivilegedRole(targetCurrentRole)) return "org_admin cannot modify privileged accounts";
  if (isPrivilegedRole(desiredRole)) return "org_admin cannot grant privileged roles";
  return null;
}

export interface RequestContext {
  userId: string;
  role: Role;
  orgId: string;
}

// Phase 7: the single tenant id used as the fallback/seed. orgId now flows for
// real — set from users.org_id at login, baked into the JWT claim, and read back
// here. DEFAULT_ORG_ID is only the fallback for legacy tokens minted before the
// orgId claim existed (all such users are default-org, so it is safe).
export const DEFAULT_ORG_ID = "default-org";

/**
 * Build a RequestContext from an authed Express request. orgId comes from the
 * auth middleware (req.orgId), which reads the JWT claim — never from request
 * params/body (iron law: orgId only from server-trusted sources).
 */
export function ctxFromReq(req: Request): RequestContext {
  const rawRole = (req as any).userRole;
  const role: Role =
    rawRole === "admin" ? "admin" : rawRole === "org_admin" ? "org_admin" : "user";
  return {
    userId: (req as any).userId,
    role,
    orgId: (req as any).orgId ?? DEFAULT_ORG_ID,
  };
}
