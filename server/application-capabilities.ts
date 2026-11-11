/**
 * application-capabilities.ts — Phase 6 (A0) per-app capability allowlist.
 *
 * The UPPER BOUND of an agent's effective capability set. Effective set =
 *   app allowlist ∩ entitlement ∩ activation (deny-by-intersection).
 *
 * Semantics (Codex confirmed):
 *   - null = no application_capabilities rows for this app = passthrough
 *     (no upper bound; legacy default-app behavior).
 *   - string[] = has rows; return only enabled=1 resource_ids as the upper
 *     bound. An empty array (all rows enabled=0) = deny all capabilities.
 *
 * This is the thin query layer consumed by resolveEnabledResourceIds
 * (agent-capabilities.ts) and computeConfigVersion (capability-version.ts).
 *
 * See docs/02-architecture/platform-application-layer-architecture.md
 */

import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import type { ApplicationCapability } from "./types.js";

// ─── Prepared statements ─────────────────────────────────────

const stmts = {
  listByApp: db.prepare(
    `SELECT id, app_id AS appId, resource_id AS resourceId, enabled,
            created_at AS createdAt, updated_at AS updatedAt
     FROM application_capabilities WHERE app_id = ? ORDER BY resource_id ASC`
  ),
  getEnabledResourceIds: db.prepare(
    `SELECT resource_id AS resourceId FROM application_capabilities
     WHERE app_id = ? AND enabled = 1 ORDER BY resource_id ASC`
  ),
  hasAnyRow: db.prepare(
    `SELECT 1 FROM application_capabilities WHERE app_id = ? LIMIT 1`
  ),
  upsert: db.prepare(
    `INSERT INTO application_capabilities (id, app_id, resource_id, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id, resource_id) DO UPDATE SET
       enabled = excluded.enabled, updated_at = excluded.updated_at`
  ),
  deleteByApp: db.prepare(
    `DELETE FROM application_capabilities WHERE app_id = ?`
  ),
  listByResourceId: db.prepare(
    `SELECT app_id AS appId FROM application_capabilities WHERE resource_id = ?`
  ),
};

// ─── Types ───────────────────────────────────────────────────

export interface SetAppCapabilitiesInput {
  resources: Array<{ resourceId: string; enabled: boolean }>;
}

// ─── Service ─────────────────────────────────────────────────

class ApplicationCapabilitiesServiceImpl {
  /**
   * List all capability rows for an app (admin view — shows enabled + disabled).
   */
  listByApp(appId: string): ApplicationCapability[] {
    return stmts.listByApp.all(appId) as ApplicationCapability[];
  }

  /**
   * Resolve the app allowlist (UPPER BOUND) for deny-by-intersection.
   *
   * Returns:
   *   - null  → no rows exist for this app → passthrough (no upper bound)
   *   - string[] → rows exist; enabled resource_ids are the upper bound.
   *     Empty array = all rows disabled = deny all capabilities.
   *
   * This null-vs-array distinction is critical for configVersion stability
   * and legacy compatibility (default-app has no rows → passthrough).
   */
  resolveAppAllowlist(appId: string): string[] | null {
    const hasRow = stmts.hasAnyRow.get(appId);
    if (!hasRow) return null; // passthrough
    const rows = stmts.getEnabledResourceIds.all(appId) as Array<{ resourceId: string }>;
    return rows.map((r) => r.resourceId);
  }

  /**
   * Set (replace) the capability allowlist for an app. PUT semantics.
   * Only admin should call this (enforced at the route layer in A1).
   */
  setAppCapabilities(appId: string, input: SetAppCapabilitiesInput): ApplicationCapability[] {
    const now = new Date().toISOString();
    const replace = db.transaction(() => {
      stmts.deleteByApp.run(appId);
      for (const r of input.resources) {
        stmts.upsert.run(uuidv4(), appId, r.resourceId, r.enabled ? 1 : 0, now, now);
      }
    });
    replace();
    return this.listByApp(appId);
  }

  /**
   * Add or update a single capability entry (idempotent upsert).
   */
  upsertCapability(appId: string, resourceId: string, enabled: boolean): ApplicationCapability[] {
    const now = new Date().toISOString();
    stmts.upsert.run(uuidv4(), appId, resourceId, enabled ? 1 : 0, now, now);
    return this.listByApp(appId);
  }

  /**
   * List app IDs that reference a given resourceId (for uninstall guard).
   */
  listAppsByResourceId(resourceId: string): string[] {
    const rows = stmts.listByResourceId.all(resourceId) as Array<{ appId: string }>;
    return rows.map((r) => r.appId);
  }
}

export const applicationCapabilitiesService = new ApplicationCapabilitiesServiceImpl();
