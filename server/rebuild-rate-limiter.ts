/**
 * rebuild-rate-limiter.ts — S2 flood control for runtime rebuilds.
 *
 * A dead runtime triggering "next user message → governed recovery" creates a
 * rebuild-on-demand surface: a malicious or buggy client could kill/force
 * rebuilds in a loop and stampede the host with container starts. This is a
 * SMALL in-memory rolling-window limiter (not a durable quota — that is the
 * org quota service's job):
 *   - per user: max 3 rebuilds / 60 s
 *   - per org:  max 20 rebuilds / 60 s
 *
 * State is server-owned only — never client-supplied. Clock is injectable so
 * the limits are cheap to test without real time.
 */

export const REBUILD_WINDOW_MS = 60_000;
export const REBUILD_MAX_PER_USER = 3;
export const REBUILD_MAX_PER_ORG = 20;

export type RebuildLimitScope = "user" | "org";

export class RebuildRateLimitError extends Error {
  readonly code = "rebuild_rate_limited";
  readonly scope: RebuildLimitScope;
  constructor(scope: RebuildLimitScope, limit: number, windowMs: number) {
    super(
      scope === "user"
        ? `Agent 重建过于频繁（每用户 ${limit} 次/${Math.round(windowMs / 1000)} 秒），请稍后再试`
        : `Agent 重建已达组织上限（每组织 ${limit} 次/${Math.round(windowMs / 1000)} 秒），请稍后再试`
    );
    this.name = "RebuildRateLimitError";
    this.scope = scope;
  }
}

/** Pure rolling-window check for one bucket. Exposed for tests. */
export function withinWindow(
  timestamps: number[],
  now: number,
  windowMs: number,
  limit: number
): { allowed: boolean; kept: number[]; nextCount: number } {
  const kept = timestamps.filter((t) => now - t < windowMs);
  const nextCount = kept.length + 1;
  return { allowed: nextCount <= limit, kept, nextCount };
}

export class RebuildRateLimiter {
  private byUser = new Map<string, number[]>();
  private byOrg = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxPerUser: number;
  private readonly maxPerOrg: number;
  private now: () => number;

  constructor(opts?: {
    windowMs?: number;
    maxPerUser?: number;
    maxPerOrg?: number;
    now?: () => number;
  }) {
    this.windowMs = opts?.windowMs ?? REBUILD_WINDOW_MS;
    this.maxPerUser = opts?.maxPerUser ?? REBUILD_MAX_PER_USER;
    this.maxPerOrg = opts?.maxPerOrg ?? REBUILD_MAX_PER_ORG;
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Record a rebuild attempt for (userId, orgId). Throws RebuildRateLimitError
   * when either the per-user or the per-org rolling window is full — the throw
   * IS the denial (do not call twice for one rebuild).
   */
  check(userId: string, orgId: string): void {
    const t = this.now();
    const user = withinWindow(this.byUser.get(userId) ?? [], t, this.windowMs, this.maxPerUser);
    if (!user.allowed) throw new RebuildRateLimitError("user", this.maxPerUser, this.windowMs);
    const org = withinWindow(this.byOrg.get(orgId) ?? [], t, this.windowMs, this.maxPerOrg);
    if (!org.allowed) throw new RebuildRateLimitError("org", this.maxPerOrg, this.windowMs);
    // Both passed — commit the attempt into both buckets.
    this.byUser.set(userId, [...user.kept, t]);
    this.byOrg.set(orgId, [...org.kept, t]);
  }
}

/** Process-wide limiter used by the governed recovery wrapper (server-owned). */
export const rebuildRateLimiter = new RebuildRateLimiter();
