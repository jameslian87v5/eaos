/**
 * org-service.ts — Phase 7.2 organization (tenant) CRUD.
 *
 * The `organizations` table was created in 7.1 (seeded with 'default-org').
 * 7.2 adds the control-plane surface to manage tenants: admin can list/create/
 * rename orgs; org_admin may list only their own (read-only). org id is the
 * tenant key carried everywhere as RequestContext.orgId, so it must be a stable,
 * conservative slug (validated). No delete in 7.2 (referential safety: users /
 * chats / agents reference org_id) — deferred.
 */
import db from "./database.js";

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
  // M1: lifecycle status {provisioning,active,suspended,archived}. Surfaced so
  // the admin API/UI can render it; transitions are gated by org-governance.ts.
  status: string;
}

// Conservative tenant-id slug: lowercase alphanumerics + dashes, 1–64 chars.
// The id becomes RequestContext.orgId for every row in that tenant, so reject
// anything that could break downstream filters / SQL / URLs.
const ORG_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidOrgId(id: string): boolean {
  return ORG_ID_RE.test(id);
}

const stmts = {
  list: db.prepare(
    `SELECT id, name, status, created_at AS createdAt FROM organizations ORDER BY created_at ASC`
  ),
  get: db.prepare(
    `SELECT id, name, status, created_at AS createdAt FROM organizations WHERE id = ?`
  ),
  insert: db.prepare(`INSERT INTO organizations (id, name, status) VALUES (?, ?, 'active')`),
  updateName: db.prepare(`UPDATE organizations SET name = ? WHERE id = ?`),
  // M3: enterprise overview — each org with its user count and active
  // org_admin count. LEFT JOIN so provisioning/archived orgs with no users
  // still appear (count 0). Used by the admin org-overview list.
  listSummary: db.prepare(
    `SELECT o.id, o.name, o.status, o.created_at AS createdAt,
       COUNT(u.id) AS userCount,
       COUNT(CASE WHEN u.role = 'org_admin' AND u.status = 'active' THEN 1 END) AS activeOrgAdminCount
     FROM organizations o
     LEFT JOIN users u ON u.org_id = o.id
     GROUP BY o.id, o.name, o.status, o.created_at
     ORDER BY o.created_at ASC`
  ),
};

// M3: organization row + per-org counts for the enterprise overview.
export interface OrgSummary extends Organization {
  userCount: number;
  activeOrgAdminCount: number;
}

class OrgService {
  list(): Organization[] {
    return stmts.list.all() as Organization[];
  }

  // M3: org list with per-org user + active-org_admin counts (enterprise
  // overview). Single grouped query — no N+1.
  listSummary(): OrgSummary[] {
    return stmts.listSummary.all() as OrgSummary[];
  }

  // M3: single org's summary (used for org_admin's own-dept overview, which
  // sees exactly one row).
  listSummaryForOrg(orgId: string): OrgSummary | undefined {
    return (this.listSummary() as OrgSummary[]).find((o) => o.id === orgId);
  }

  get(id: string): Organization | undefined {
    return stmts.get.get(id) as Organization | undefined;
  }

  create(id: string, name: string): Organization {
    const trimmedId = id?.trim();
    const trimmedName = name?.trim();
    if (!trimmedId || !isValidOrgId(trimmedId)) {
      throw new Error("Invalid org id (lowercase alphanumerics + dashes, max 64)");
    }
    if (!trimmedName) throw new Error("Org name required");
    if (this.get(trimmedId)) throw new Error(`Org "${trimmedId}" already exists`);
    stmts.insert.run(trimmedId, trimmedName);
    return this.get(trimmedId)!;
  }

  updateName(id: string, name: string): Organization | undefined {
    const trimmedName = name?.trim();
    if (!trimmedName) throw new Error("Org name required");
    if (!this.get(id)) return undefined;
    stmts.updateName.run(trimmedName, id);
    return this.get(id);
  }
}

export const orgService = new OrgService();
