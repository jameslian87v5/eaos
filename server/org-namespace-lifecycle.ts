/**
 * org-namespace-lifecycle.ts — R5c idempotent lifecycle hooks.
 *
 * Wired at the server.ts call sites AROUND (not inside) the existing
 * org-governance/auth primitives — provisionOrg, transitionOrgStatus,
 * register/migrateUserOrg/setUserStatus — so the org-isolation 铁律 and the
 * existing provision transaction are untouched. Each hook is idempotent:
 *
 *  - onOrgCreated: derive a TEAM namespace slug from the org id (conservative,
 *    validated) + upsert the persistent mapping. The mapping is the source of
 *    truth for R5a TEAM sync; it is NOT derived at sync time (铁律).
 *  - onOrgFrozen / onOrgActivated: freeze/unfreeze the mapping (TEAM + member
 *    sync pause while the org is suspended). Idempotent.
 *  - onUserCreate / onUserRoleChange / onUserOrgMove / onUserSuspend: enqueue
 *    a member-sync task carrying the user's CURRENT token_version as the
 *    desired-state generation + the captured desired role/status/source-ns.
 *
 * Round-2 (codex review #3/#4): hooks now carry enough desired state for the
 * adapter to converge role/status/move (desired_role / desired_status /
 * source_namespace_slug), and missed mappings / hook failures are no longer
 * silent — they write a metadata-only governance audit so a transient failure
 * cannot lose lifecycle synchronization permanently (durable reconcile/backfill
 * lives in skillhub-member-runner.ts).
 *
 * These hooks only mutate org_namespace_mappings + hub_member_sync_tasks
 * (control-plane side tables). They NEVER touch users/organizations main
 * rows — nonrollback is preserved.
 */
import db from "./database.js";
import { orgNamespaceMappingService } from "./org-namespace-mapping.js";
import { memberSyncService, type MemberSyncEvent } from "./skillhub-member-sync.js";
import { writeGovernanceAudit } from "./org-governance.js";

/** Derive a conservative TEAM namespace slug from an org id. */
function deriveNamespaceSlug(orgId: string): string {
  return orgId;
}

export function onOrgCreated(orgId: string): void {
  orgNamespaceMappingService.upsert(orgId, deriveNamespaceSlug(orgId));
}

export function onOrgFrozen(orgId: string): void {
  orgNamespaceMappingService.setFrozen(orgId, true);
}

export function onOrgActivated(orgId: string): void {
  orgNamespaceMappingService.setFrozen(orgId, false);
}

export interface UserLifecycleInput {
  orgId: string;
  userId: string;
  tokenVersion: number;
}

export interface UserMoveInput {
  fromOrgId: string;
  toOrgId: string;
  userId: string;
}

export interface UserSuspendInput extends UserLifecycleInput {
  suspended: boolean;
}

export function onUserCreate(input: UserLifecycleInput): void {
  const mapping = orgNamespaceMappingService.getForOrg(input.orgId);
  if (!mapping) { auditMappingMissing(input.orgId, input.userId, "user_create"); return; }
  memberSyncService.enqueue({
    orgId: input.orgId, namespaceSlug: mapping.namespaceSlug,
    userId: input.userId, event: "user_create", targetVersion: input.tokenVersion,
  });
}

export function onUserRoleChange(input: UserLifecycleInput): void {
  const mapping = orgNamespaceMappingService.getForOrg(input.orgId);
  if (!mapping) { auditMappingMissing(input.orgId, input.userId, "role_change"); return; }
  memberSyncService.enqueue({
    orgId: input.orgId, namespaceSlug: mapping.namespaceSlug,
    userId: input.userId, event: "role_change", targetVersion: input.tokenVersion,
  });
}

/**
 * Org move: enqueue under the DESTINATION namespace with the SOURCE namespace
 * carried as sourceNamespaceSlug (so the adapter can remove stale membership
 * at the source) + the user's post-migration role as desiredRole. Reads the
 * post-migration token_version + role internally (single source of truth).
 */
export function onUserOrgMove(input: UserMoveInput): void {
  const destMapping = orgNamespaceMappingService.getForOrg(input.toOrgId);
  if (!destMapping) { auditMappingMissing(input.toOrgId, input.userId, "org_move"); return; }
  const row = userStateStmt.get(input.userId) as
    | { tokenVersion: number | null; role: string | null }
    | undefined;
  if (!row || row.tokenVersion == null) {
    writeGovernanceAudit({
      actorUserId: "system", actorRole: "system", orgId: input.toOrgId,
      action: "hub_hook_user_missing", objectType: "user", objectId: input.userId,
      result: "failure", reasonSummary: "hook org_move: user state unreadable",
    });
    return;
  }
  const sourceMapping = orgNamespaceMappingService.getForOrg(input.fromOrgId);
  memberSyncService.enqueue({
    orgId: input.toOrgId, namespaceSlug: destMapping.namespaceSlug,
    userId: input.userId, event: "org_move", targetVersion: row.tokenVersion,
    desired: { role: row.role ?? undefined, sourceNamespaceSlug: sourceMapping?.namespaceSlug },
  });
}

export function onUserSuspend(input: UserSuspendInput): void {
  const mapping = orgNamespaceMappingService.getForOrg(input.orgId);
  if (!mapping) { auditMappingMissing(input.orgId, input.userId, input.suspended ? "user_suspend" : "user_restore"); return; }
  memberSyncService.enqueue({
    orgId: input.orgId, namespaceSlug: mapping.namespaceSlug,
    userId: input.userId,
    event: input.suspended ? "user_suspend" : "user_restore",
    targetVersion: input.tokenVersion,
    desired: { status: input.suspended ? "disabled" : "active" },
  });
}

const userStateStmt = db.prepare(
  `SELECT org_id AS orgId, token_version AS tokenVersion, role, status FROM users WHERE id = ?`
);

/**
 * Server-side dispatcher: read the user's CURRENT orgId + token_version +
 * role + status (post-mutation — the mutation already bumped token_version,
 * which is the desired-state generation) and enqueue a member-sync task with
 * the captured desired state. Used by server.ts handlers. No-op if the user
 * has no mapping yet (audited — operator must backfill the mapping first).
 */
export function dispatchUserHook(userId: string, event: MemberSyncEvent): void {
  const row = userStateStmt.get(userId) as
    | { orgId: string | null; tokenVersion: number | null; role: string | null; status: string | null }
    | undefined;
  if (!row || !row.orgId || row.tokenVersion == null) {
    writeGovernanceAudit({
      actorUserId: "system", actorRole: "system", orgId: "unknown",
      action: "hub_hook_user_missing", objectType: "user", objectId: userId,
      result: "failure", reasonSummary: `hook ${event}: user state unreadable`,
    });
    return;
  }
  const mapping = orgNamespaceMappingService.getForOrg(row.orgId);
  if (!mapping) { auditMappingMissing(row.orgId, userId, event); return; }
  const desired = { role: row.role ?? undefined, status: row.status ?? undefined };
  memberSyncService.enqueue({
    orgId: row.orgId, namespaceSlug: mapping.namespaceSlug,
    userId, event, targetVersion: row.tokenVersion, desired,
  });
}

function auditMappingMissing(orgId: string, userId: string, event: MemberSyncEvent): void {
  writeGovernanceAudit({
    actorUserId: "system", actorRole: "system", orgId,
    action: "hub_mapping_missing", objectType: "user", objectId: userId,
    result: "failure", reasonSummary: `hook ${event}: no namespace mapping`,
  });
}

/**
 * Best-effort hook wrapper. The main mutation already succeeded + committed;
 * a hook failure must NOT roll back or fail the HTTP response (nonrollback).
 * Round-2: failures are NOT silent — a metadata-only audit is written so a
 * transient failure (SQLite/mapping/enqueue) is durable and reconcilable.
 */
export function tryHook(fn: () => void, auditContext?: { orgId?: string; action?: string }): void {
  try {
    fn();
  } catch (err: any) {
    writeGovernanceAudit({
      actorUserId: "system", actorRole: "system",
      orgId: auditContext?.orgId ?? "unknown",
      action: auditContext?.action ?? "hub_hook_failed",
      objectType: "hub", objectId: "lifecycle-hook",
      result: "failure", reasonSummary: "hub lifecycle hook failed",
    });
  }
}
