/**
 * skillhub-member-adapter.ts — R5c production HubMemberClient adapter.
 *
 * 铁律 (evt_20260812203427 / codex review #2/#3): use ONLY R5b-recorded routes.
 * The R5b-verified-live client (skillhub-client.ts) exposes exactly four routes:
 *   - GET /api/v1/namespaces            (listNamespaces — Bearer-authenticated)
 *   - GET /api/cli/v1/skills/search     (listPublishedSkills)
 *   - GET /api/cli/v1/skills/{ns}/{slug}/resolve
 *   - GET /api/cli/v1/skills/{ns}/{slug}/versions/{v}/download
 * NONE of these is a member-management route.
 *
 * R5c round-6 LIVE-VERIFIED forensics (docs/06-deployment/skillhub-r5b2-contract-
 * forensics.md §8; transient probe, NOT committed, evidence sanitized): the Hub's
 * member/freeze routes live under AdminNamespaceController at
 * /api/v1/admin/namespaces/* — @PreAuthorize("hasRole('SUPER_ADMIN')") AND
 * ABSENT from RouteSecurityPolicyRegistry.API_TOKEN_POLICIES. Live probe with a
 * scoped (skill:read+token:manage) API token returned HTTP 403
 * "API token cannot access endpoint" (= authorizeApiToken `unsupported(path)`
 * branch, fired by ApiTokenScopeFilter BEFORE the role check) for EVERY member/
 * freeze route:
 *   - GET  /api/v1/admin/namespaces                        → 403
 *   - POST /api/v1/admin/namespaces/{slug}/freeze          → 403
 *   - GET  /api/v1/admin/namespaces/{slug}/members        → 403
 *   - PUT  /api/v1/admin/namespaces/{slug}/members/{uid}/role → 403
 * Control (GET /api/v1/namespaces) → 200 (token valid, route allowed). Anon →
 * 401. Token revoked (DELETE) → 204; post-revoke → 401.
 *
 * CONCLUSION: the Hub exposes NO M2M/API-token-authorized path to namespace
 * member/freeze routes — they are SUPER_ADMIN browser-session-only by Hub
 * design. Per the directive's escape hatch ("If a specific live permission/auth
 * contract is genuinely impossible, provide exact HTTP/status/source evidence
 * and keep that sub-gate DEFER"), the adapter:
 *   1. Runs the R5b-recorded listNamespaces precondition (verify the namespace
 *      exists + is ACTIVE — fail-closed, same as the skill-sync bridge).
 *   2. For the member op itself, throws HubMemberRouteM2mExcludedError → the
 *      runner records `exhausted` with last_error="hub_member_route_m2m_excluded"
 *      (metadata-only, categorical). This is an explicit PERMANENT boundary —
 *      NOT fake PASS, NOT a fake convergence. The desired state (role/status/
 *      sourceNamespace) is carried so IF a future Hub version adds an
 *      M2M-authorized member path (or the platform adopts a SUPER_ADMIN session
 *      flow), the task converges.
 *
 * No token/payload persisted; token used only for the Authorization header
 * (same pattern as the skill-sync client). The adapter is constructed only
 * when SKILLHUB_URL + SKILLHUB_TOKEN are configured; otherwise the runner is
 * a no-op (safety disable, same as runSyncOnce).
 */
import { createSkillhubClient, type SkillhubClient } from "./skillhub-client.js";
import {
  HubMemberRouteM2mExcludedError,
  type HubMemberClient,
  type MemberDesiredState,
  type MemberSyncEvent,
} from "./skillhub-member-sync.js";

export interface MemberAdapterOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: (url: string, init?: any) => Promise<any>;
  /** Injectable client (tests). Production = createSkillhubClient. */
  client?: SkillhubClient;
}

/**
 * Build the production HubMemberClient. Uses the R5b client's listNamespaces
 * (recorded route) as the precondition; the member op is a live-verified
 * M2M-excluded permanent boundary. Returns null if Hub is not configured
 * (safety disable).
 */
export function createHubMemberAdapter(opts: MemberAdapterOptions): HubMemberClient | null {
  if (!opts.baseUrl || !opts.token) return null; // safety disable
  const client = opts.client ?? createSkillhubClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    fetchImpl: opts.fetchImpl as any,
  });
  return {
    async syncMember(
      namespaceSlug: string,
      _userId: string,
      _event: MemberSyncEvent,
      _desired: MemberDesiredState,
    ): Promise<void> {
      // R5b-recorded precondition: verify the namespace exists + is ACTIVE.
      // (Same fail-closed contract as the skill-sync bridge.) This is the ONLY
      // recorded route the adapter can exercise; it does not converge member
      // state — the Hub member route is live-verified M2M-excluded (403
      // unsupported by ApiTokenScopeFilter; SUPER_ADMIN-session-only).
      const namespaces = await client.listNamespaces();
      const ns = namespaces.find((n) => n.slug === namespaceSlug);
      if (!ns) {
        // Namespace unknown/inactive → fail-closed; the runner retries then
        // exhausts with the generic hub_member_sync_failed reason (a transient
        // lookup failure is retryable, distinct from the permanent M2M exclusion).
        throw new Error("namespace lookup failed");
      }
      if (String(ns.status).toUpperCase() !== "ACTIVE") {
        throw new Error("namespace inactive");
      }
      // Member-management route is live-verified M2M-excluded → explicit
      // PERMANENT boundary. The desired state was carried to this point so a
      // future M2M-authorized route can converge; we do NOT pretend success.
      throw new HubMemberRouteM2mExcludedError();
    },
  };
}
