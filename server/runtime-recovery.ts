/**
 * runtime-recovery.ts — S2 server-owned governed runtime recovery.
 *
 * Session must NEVER call ContainerManager.ensureRuntime (or rebuild a local
 * runtime) directly: recovery from a dead runtime would then bypass the
 * control plane. This module builds the recovery function that server.ts
 * injects into Session; every invocation RE-RUNS the same governance chain as
 * a brand-new runtime creation in getOrCreateSession:
 *
 *   1. org active check (existing admin-exempt semantics);
 *   2. concurrentRuntimes quota with excludeChatId (the chat's own slot is
 *      not double-counted — a rebuild does not acquire a second slot);
 *   3. rebuild flood control (per-user / per-org rolling window);
 *   4. FRESH capabilityProvider.resolve() (control-plane drift, deny-default);
 *   5. FRESH computeConfigVersion();
 *   6. current ALLOWED_TOOLS override (allowedTools only, never tools);
 *   7. complete options into ensureRuntime / the local runtime factory.
 *
 * Dependencies are injected so the whole chain is unit-testable without
 * booting the server or Docker.
 */

import type { AgentRuntime, AgentRuntimeOptions } from "./agent-runtime.js";
import { createLocalRuntime } from "./agent-runtime.js";
import type { CapabilityBundle, CapabilityResolveContext } from "./capability-provider.js";
import type { RebuildRateLimiter } from "./rebuild-rate-limiter.js";
import type { Role } from "./request-context.js";

export type SessionRecoveryFn = (opts: AgentRuntimeOptions) => Promise<AgentRuntime>;

/** Normalized governance failure — Session records the category, not payloads. */
export class GovernedRecoveryError extends Error {
  readonly category:
    | "org_not_active"
    | "quota_exceeded"
    | "rebuild_rate_limited"
    | "resolve_failed";
  constructor(category: GovernedRecoveryError["category"], message: string) {
    super(message);
    this.name = "GovernedRecoveryError";
    this.category = category;
  }
}

export interface RecoveryPrincipal {
  userId: string;
  chatId: string;
  role: Role;
  orgId: string;
}

export interface GovernedRecoveryDeps {
  assertOrgActive: (orgId: string) => void;
  assertQuota: (
    orgId: string,
    dimension: "concurrentRuntimes",
    opts: { excludeChatId?: string; audit?: { actorUserId: string; actorRole: Role } }
  ) => void;
  resolve: (context: CapabilityResolveContext) => CapabilityBundle;
  computeConfigVersion: (ctx: { userId: string; role: Role; orgId: string }, chatId: string) => string;
  ensureRuntime: (
    userId: string,
    chatId: string,
    options?: AgentRuntimeOptions
  ) => Promise<AgentRuntime>;
  createLocalRuntime?: (options?: AgentRuntimeOptions) => AgentRuntime;
  rateLimiter: RebuildRateLimiter;
  allowedToolsOverride: string[] | null;
}

/** Map a raw governance throw to a metadata-only category. */
function categorize(err: unknown): GovernedRecoveryError {
  const e = err as { name?: string; code?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.name === "OrgNotActiveError" || e?.code === "org_not_active") {
    return new GovernedRecoveryError("org_not_active", msg);
  }
  if (e?.name === "QuotaExceededError" || e?.code === "quota_exceeded") {
    return new GovernedRecoveryError("quota_exceeded", msg);
  }
  if (e?.name === "RebuildRateLimitError" || e?.code === "rebuild_rate_limited") {
    return new GovernedRecoveryError("rebuild_rate_limited", msg);
  }
  return new GovernedRecoveryError("resolve_failed", msg);
}

/**
 * Build the governed recovery function for DOCKER mode. `runtimeMode` selects
 * the data-plane executor (docker ensureRuntime vs local factory); the
 * governance chain is identical.
 */
export function createGovernedRecovery(
  principal: RecoveryPrincipal,
  deps: GovernedRecoveryDeps,
  runtimeMode: "docker" | "local"
): SessionRecoveryFn {
  return async (opts: AgentRuntimeOptions): Promise<AgentRuntime> => {
    const { userId, chatId, role, orgId } = principal;
    try {
      // Governance — same order and exemptions as getOrCreateSession's
      // new-session path. admin is exempt from org-status and quota gates.
      if (role !== "admin") {
        deps.assertOrgActive(orgId);
        deps.assertQuota(orgId, "concurrentRuntimes", {
          excludeChatId: chatId,
          audit: { actorUserId: userId, actorRole: role },
        });
      }
      // Flood control applies to ALL principals (including admin — an admin
      // loop is still a container stampede).
      deps.rateLimiter.check(userId, orgId);

      // Fresh control-plane resolve — a stale bundle would silently drop
      // capability changes made since the dead runtime was built.
      const bundle = deps.resolve({
        userId,
        chatId,
        role: role as "admin" | "user",
        runtimeType: runtimeMode === "docker" ? "docker" : "local",
        orgId,
      });
      const configVersion = deps.computeConfigVersion({ userId, role, orgId }, chatId);
      const options: AgentRuntimeOptions = {
        ...opts,
        tools: bundle.sdkOptions.tools,
        // ALLOWED_TOOLS overrides ONLY allowedTools — never tools (keeps Skill
        // exposed and the approval split intact; same contract as startup).
        allowedTools: deps.allowedToolsOverride ?? bundle.sdkOptions.allowedTools,
        capabilityBundle: bundle,
        configVersion,
      };

      if (runtimeMode === "docker") {
        return await deps.ensureRuntime(userId, chatId, options);
      }
      const factory = deps.createLocalRuntime ?? createLocalRuntime;
      return factory(options);
    } catch (err) {
      if (err instanceof GovernedRecoveryError) throw err;
      throw categorize(err);
    }
  };
}
