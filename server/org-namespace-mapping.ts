/**
 * org-namespace-mapping.ts — R5c persistent org → TEAM-namespace mapping.
 *
 * 铁律 (ACTIVE plan §R5c): each active org ↔ exactly one TEAM namespace; the
 * mapping is PERSISTENT (stored in org_namespace_mappings), not derived from
 * the org id/name at sync time. R5a TEAM sync resolves targets from this table
 * first; the SKILLHUB_SYNC_TARGETS env remains only as an explicit, audited
 * emergency/no-mapping fallback (never a silent override).
 *
 * Control-plane service: called by admin/system + the R5a sync bridge. Cross-org
 * read denial is enforced at the route layer (org_admin may only read their own
 * org's mapping via a ctx-scoped query); this service's `getForOrg` is the
 * single read primitive other services compose on.
 *
 * Status mirrors the org lifecycle: 'active' for sync; 'frozen' when the org is
 * suspended (TEAM sync + member sync pause while frozen). Re-activating the org
 * unfreezes the mapping.
 */
import db from "./database.js";

export interface OrgNamespaceMapping {
  orgId: string;
  namespaceSlug: string;
  status: "active" | "frozen";
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const NAMESPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidNamespaceSlug(slug: string): boolean {
  return NAMESPACE_SLUG_RE.test(slug);
}

const stmts = {
  getForOrg: db.prepare(
    `SELECT org_id AS orgId, namespace_slug AS namespaceSlug, status, last_sync_at AS lastSyncAt,
            created_at AS createdAt, updated_at AS updatedAt
     FROM org_namespace_mappings WHERE org_id = ?`
  ),
  getByNamespace: db.prepare(
    `SELECT org_id AS orgId, namespace_slug AS namespaceSlug, status, last_sync_at AS lastSyncAt,
            created_at AS createdAt, updated_at AS updatedAt
     FROM org_namespace_mappings WHERE namespace_slug = ?`
  ),
  listActive: db.prepare(
    `SELECT org_id AS orgId, namespace_slug AS namespaceSlug, status, last_sync_at AS lastSyncAt,
            created_at AS createdAt, updated_at AS updatedAt
     FROM org_namespace_mappings WHERE status = 'active' ORDER BY created_at ASC`
  ),
  listAll: db.prepare(
    `SELECT org_id AS orgId, namespace_slug AS namespaceSlug, status, last_sync_at AS lastSyncAt,
            created_at AS createdAt, updated_at AS updatedAt
     FROM org_namespace_mappings ORDER BY created_at ASC`
  ),
  insert: db.prepare(
    `INSERT INTO org_namespace_mappings (org_id, namespace_slug, status) VALUES (?, ?, 'active')`
  ),
  updateNamespace: db.prepare(
    `UPDATE org_namespace_mappings SET namespace_slug = ?, updated_at = datetime('now') WHERE org_id = ?`
  ),
  setStatus: db.prepare(
    `UPDATE org_namespace_mappings SET status = ?, updated_at = datetime('now') WHERE org_id = ?`
  ),
  touchLastSync: db.prepare(
    `UPDATE org_namespace_mappings SET last_sync_at = datetime('now'), updated_at = datetime('now') WHERE org_id = ?`
  ),
};

class OrgNamespaceMappingService {
  /** Read the mapping for an org. undefined if no mapping row exists. */
  getForOrg(orgId: string): OrgNamespaceMapping | undefined {
    return stmts.getForOrg.get(orgId) as OrgNamespaceMapping | undefined;
  }

  /** Read the org that owns a namespace (for cross-org deny checks). */
  getForNamespace(namespaceSlug: string): OrgNamespaceMapping | undefined {
    return stmts.getByNamespace.get(namespaceSlug) as OrgNamespaceMapping | undefined;
  }

  /** All active mappings — R5a TEAM sync target resolution source. */
  listActive(): OrgNamespaceMapping[] {
    return stmts.listActive.all() as OrgNamespaceMapping[];
  }

  /** All mappings (active AND frozen) — used by backfill to PRESERVE frozen/
   * custom mappings rather than overwrite/reactivate them (round-3 #2). */
  listAll(): OrgNamespaceMapping[] {
    return stmts.listAll.all() as OrgNamespaceMapping[];
  }

  /** True if any mapping row (any status) exists for the org. */
  hasMapping(orgId: string): boolean {
    return !!this.getForOrg(orgId);
  }

  /**
   * Create or update a mapping (idempotent). The namespace slug is validated and
   * must not collide with another org's namespace (1:1 铁律). Throws on invalid
   * slug or namespace collision.
   */
  upsert(orgId: string, namespaceSlug: string): OrgNamespaceMapping {
    const slug = namespaceSlug?.trim();
    if (!slug || !isValidNamespaceSlug(slug)) {
      throw new Error("Invalid namespace slug (lowercase alphanumerics + dashes, max 64)");
    }
    const existing = this.getForOrg(orgId);
    if (existing) {
      // 1:1: a different org must not already own the new slug.
      const owner = this.getForNamespace(slug);
      if (owner && owner.orgId !== orgId) {
        throw new Error(`namespace "${slug}" already mapped to org "${owner.orgId}"`);
      }
      stmts.updateNamespace.run(slug, orgId);
      return this.getForOrg(orgId)!;
    }
    // New row — reject namespace collision with a different org.
    const owner = this.getForNamespace(slug);
    if (owner && owner.orgId !== orgId) {
      throw new Error(`namespace "${slug}" already mapped to org "${owner.orgId}"`);
    }
    stmts.insert.run(orgId, slug);
    return this.getForOrg(orgId)!;
  }

  /** Freeze/unfreeze a mapping on org suspend/activate. Idempotent. */
  setFrozen(orgId: string, frozen: boolean): void {
    if (!this.getForOrg(orgId)) return; // no mapping → no-op (not every org has one)
    stmts.setStatus.run(frozen ? "frozen" : "active", orgId);
  }

  /** Mark a sync completed for bookkeeping (called by R5a after a TEAM sync). */
  touchLastSync(orgId: string): void {
    stmts.touchLastSync.run(orgId);
  }
}

export const orgNamespaceMappingService = new OrgNamespaceMappingService();
