/**
 * skillhub-sync-targets.ts — R5a TEAM sync target resolution (mapping-first).
 *
 * 铁律 (ACTIVE plan §R5c): R5a TEAM sync resolves targets from the persistent
 * org_namespace_mappings table FIRST. The SKILLHUB_SYNC_TARGETS env remains
 * ONLY as an explicit, audited emergency/no-mapping fallback — it can NEVER
 * silently override the mapping table. If an env target would point an org at
 * a different namespace than its mapping, the mapping wins and the env
 * override attempt is audited (not applied).
 *
 * Frozen mappings are excluded from TEAM sync targets (sync pauses while the
 * org is suspended). GLOBAL sync (all active orgs) is unaffected — it uses the
 * orgService active list, not this resolver.
 *
 * This module is additive: it CALLS runSyncOnce (already LOW impact) per
 * resolved target but does not modify runSyncOnce/main bodies. The env-based
 * `main` entrypoint in skillhub-bridge.prod.ts remains as the documented
 * emergency path.
 */
import { orgNamespaceMappingService } from "./org-namespace-mapping.js";

export interface SyncTarget {
  namespaceSlug: string;
  orgId: string;
}

export interface EnvTarget {
  namespaceSlug: string;
  orgId: string;
}

export type SyncTargetAuditFn = (action: string) => void;

export interface ResolveOpts {
  /** Parsed SKILLHUB_SYNC_TARGETS env targets (emergency fallback). */
  envTargets?: EnvTarget[];
  /** Audit sink (metadata-only action string). */
  audit?: SyncTargetAuditFn;
}

/**
 * Resolve TEAM sync targets. Mapping-first; env is audited emergency fallback
 * only; env override attempts are ignored + audited (not silent).
 */
export function resolveTeamSyncTargets(opts: ResolveOpts = {}): SyncTarget[] {
  const audit = opts.audit ?? (() => {});
  const envTargets = opts.envTargets ?? [];
  const activeMappings = orgNamespaceMappingService.listActive();
  const mappingByOrg = new Map(activeMappings.map((m) => [m.orgId, m.namespaceSlug] as const));
  const mappingByNs = new Map(activeMappings.map((m) => [m.namespaceSlug, m.orgId] as const));
  const targets: SyncTarget[] = [];
  const seenOrg = new Set<string>();

  // 1. Mapping-first: each active (non-frozen) mapping is a target.
  for (const [orgId, ns] of mappingByOrg) {
    targets.push({ namespaceSlug: ns, orgId });
    seenOrg.add(orgId);
  }

  // 2. Emergency fallback: env targets for orgs/namespaces with NO mapping.
  for (const env of envTargets) {
    // Namespace already mapped (to some org)? → mapping wins; an env claim that
    // points the namespace at a DIFFERENT org is an override attempt → ignored
    // + audited (not silent).
    if (mappingByNs.has(env.namespaceSlug)) {
      if (mappingByNs.get(env.namespaceSlug) !== env.orgId) {
        audit("skillhub.sync_target_env_override_ignored");
      }
      continue;
    }
    // Org already mapped (to a different namespace)? → mapping wins; env
    // override attempt ignored + audited.
    if (mappingByOrg.has(env.orgId)) {
      if (mappingByOrg.get(env.orgId) !== env.namespaceSlug) {
        audit("skillhub.sync_target_env_override_ignored");
      }
      continue;
    }
    // No mapping for this org or namespace → env is the audited emergency fallback.
    if (!seenOrg.has(env.orgId)) {
      targets.push({ namespaceSlug: env.namespaceSlug, orgId: env.orgId });
      seenOrg.add(env.orgId);
      audit("skillhub.sync_target_env_fallback");
    }
  }

  return targets;
}
