/**
 * compact-policy.ts — M4 Auto Compact policy (docs/开发计划/model-and-token-management-plan.md
 * §4.2/§4.3, phase 1).
 *
 * Layering (control plane):
 *   platform default : data/runtime-settings.json → contextCompaction
 *                      {enabled, thresholdTokens, keepRecentTurns} (admin-editable)
 *   org overlay      : org_compact_policy row (absent row = platform default)
 *
 * 铁律 (event M4-2: 组织值受平台上限约束):
 *   - Org thresholdTokens ∈ [min, min(PLATFORM_MAX, platform.thresholdTokens)].
 *     The platform's configured value doubles as the org CEILING, so lowering
 *     the platform setting immediately re-clamps every stored org value on
 *     read — a stale org row above the cap is never effective.
 *   - Same band rule for keepRecentTurns (org may only be MORE aggressive).
 *   - enabled is NARROW-ONLY: an org row may turn OFF platform-on compaction,
 *     but can never turn ON what the platform disabled (守卫在外，org 只能收窄).
 *
 * Execution (data plane): session.ts evaluates the effective policy at every
 * TURN BOUNDARY (result event) and sends the existing /compact command through
 * the same runtime stream — no unverified native SDK autocompact params (event
 * M4-4). keepRecentTurns is policy/display metadata in phase 1; it is NOT
 * forwarded to the SDK.
 */

import db from "./database.js";
import { getRuntimeSettings } from "./runtime-settings.js";

// Hard bands for BOTH layers. runtime-settings.normalize clamps the platform
// values into the same band, so these constants are the single source.
export const PLATFORM_MIN_THRESHOLD_TOKENS = 1_000;
export const PLATFORM_MAX_THRESHOLD_TOKENS = 1_000_000;
export const PLATFORM_MIN_KEEP_RECENT_TURNS = 1;
export const PLATFORM_MAX_KEEP_RECENT_TURNS = 100;

export interface CompactionPolicy {
  enabled: boolean;
  thresholdTokens: number;
  keepRecentTurns: number;
}

/** Where the effective numbers came from ("org" = org_compact_policy row). */
export interface EffectiveCompaction extends CompactionPolicy {
  source: "platform" | "org";
}

export interface CompactionCaps {
  minThresholdTokens: number;
  maxThresholdTokens: number;
  minKeepRecentTurns: number;
  maxKeepRecentTurns: number;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Explicit values must be numeric — a non-numeric request is a 400, not a
 *  silent fallback (fallbacks are for corrupt STORED rows only). */
function requireInt(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number`);
  return Math.trunc(n);
}

/** Platform default policy (runtime-settings.json — already normalized+clamped). */
export function getPlatformCompaction(): CompactionPolicy {
  return getRuntimeSettings().contextCompaction;
}

/** The org-facing ceilings for THIS platform config (hard band ∩ current
 *  setting). Returned to the admin UI so the form can enforce client-side too. */
export function getCompactionCaps(): CompactionCaps {
  const platform = getPlatformCompaction();
  return {
    minThresholdTokens: PLATFORM_MIN_THRESHOLD_TOKENS,
    maxThresholdTokens: Math.min(PLATFORM_MAX_THRESHOLD_TOKENS, platform.thresholdTokens),
    minKeepRecentTurns: PLATFORM_MIN_KEEP_RECENT_TURNS,
    maxKeepRecentTurns: Math.min(PLATFORM_MAX_KEEP_RECENT_TURNS, platform.keepRecentTurns),
  };
}

interface OrgRow {
  enabled: number | null;
  threshold_tokens: number | null;
  keep_recent_turns: number | null;
}

function readOrgRow(orgId: string): OrgRow | null {
  const row = db.prepare(
    `SELECT enabled, threshold_tokens, keep_recent_turns FROM org_compact_policy WHERE org_id = ?`
  ).get(orgId) as OrgRow | undefined;
  return row ?? null;
}

/** Org overlay AFTER clamping to the current platform ceilings (null = no row,
 *  platform default applies). */
export function getOrgCompactPolicy(orgId: string): { policy: CompactionPolicy | null; caps: CompactionCaps } {
  const caps = getCompactionCaps();
  const platform = getPlatformCompaction();
  const row = readOrgRow(orgId);
  if (!row) return { policy: null, caps };
  return {
    policy: {
      // Narrow-only: an org row can only turn OFF, never ON.
      enabled: platform.enabled && (row.enabled == null ? true : Boolean(row.enabled)),
      thresholdTokens: clampInt(row.threshold_tokens, caps.minThresholdTokens, caps.maxThresholdTokens, platform.thresholdTokens),
      keepRecentTurns: clampInt(row.keep_recent_turns, caps.minKeepRecentTurns, caps.maxKeepRecentTurns, platform.keepRecentTurns),
    },
    caps,
  };
}

export interface SetOrgCompactPolicyResult {
  /** Effective policy after the write (re-read — includes the narrow-only
   *  enabled rule, so an org "on" against a platform-off still reads off). */
  policy: EffectiveCompaction;
  /** What was actually persisted (post-clamp values). */
  stored: CompactionPolicy;
  /** Fields whose requested value exceeded the caps and was clamped. */
  clamped: string[];
}

/** Upsert the org overlay. Throws "Organization not found" (404 at the route)
 *  or "<field> must be a finite number" (400 at the route). */
export function setOrgCompactPolicy(
  orgId: string,
  patch: { enabled?: unknown; thresholdTokens?: unknown; keepRecentTurns?: unknown }
): SetOrgCompactPolicyResult {
  if (!db.prepare(`SELECT 1 FROM organizations WHERE id = ?`).get(orgId)) {
    throw new Error("Organization not found");
  }
  const caps = getCompactionCaps();
  const platform = getPlatformCompaction();
  const current = getOrgCompactPolicy(orgId).policy ?? platform;
  const clamped: string[] = [];

  const enabled = patch.enabled == null ? current.enabled : patch.enabled === true;

  let thresholdTokens =
    patch.thresholdTokens == null ? current.thresholdTokens : requireInt(patch.thresholdTokens, "thresholdTokens");
  if (thresholdTokens < caps.minThresholdTokens || thresholdTokens > caps.maxThresholdTokens) clamped.push("thresholdTokens");
  thresholdTokens = clampInt(thresholdTokens, caps.minThresholdTokens, caps.maxThresholdTokens, current.thresholdTokens);

  let keepRecentTurns =
    patch.keepRecentTurns == null ? current.keepRecentTurns : requireInt(patch.keepRecentTurns, "keepRecentTurns");
  if (keepRecentTurns < caps.minKeepRecentTurns || keepRecentTurns > caps.maxKeepRecentTurns) clamped.push("keepRecentTurns");
  keepRecentTurns = clampInt(keepRecentTurns, caps.minKeepRecentTurns, caps.maxKeepRecentTurns, current.keepRecentTurns);

  db.prepare(
    `INSERT INTO org_compact_policy (org_id, enabled, threshold_tokens, keep_recent_turns, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(org_id) DO UPDATE SET
       enabled = excluded.enabled,
       threshold_tokens = excluded.threshold_tokens,
       keep_recent_turns = excluded.keep_recent_turns,
       updated_at = excluded.updated_at`
  ).run(orgId, enabled ? 1 : 0, thresholdTokens, keepRecentTurns);

  return {
    policy: getEffectiveCompaction(orgId),
    stored: { enabled, thresholdTokens, keepRecentTurns },
    clamped,
  };
}

/** Effective policy for a chat's org (absent overlay / null orgId → platform). */
export function getEffectiveCompaction(orgId: string | null | undefined): EffectiveCompaction {
  const platform = getPlatformCompaction();
  if (!orgId) return { ...platform, source: "platform" };
  const org = getOrgCompactPolicy(orgId).policy;
  return org ? { ...org, source: "org" } : { ...platform, source: "platform" };
}

/** Phase-1 context estimate (plan §4.2): the turn's input-side tokens — what
 *  the provider had to READ to answer. Output is excluded (it is the answer,
 *  not context yet); cache read/write ARE included (they are context size). */
export function contextEstimateTokens(usage: {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

export interface AutoCompactDecision {
  trigger: boolean;
  reason: "no_policy" | "disabled" | "in_flight" | "no_usage" | "below_threshold" | "threshold_reached";
  estimateTokens?: number;
  thresholdTokens?: number;
}

/** Pure decision fn (plan §4.3 phase 1). Callers invoke it ONLY at a turn
 *  boundary (result event) — never mid-turn (event M4-5). One in-flight
 *  trigger per boundary is enforced by the caller's flag. */
export function evaluateAutoCompact(
  policy: CompactionPolicy | null | undefined,
  estimateTokens: number | null,
  inFlight: boolean
): AutoCompactDecision {
  if (!policy) return { trigger: false, reason: "no_policy" };
  if (!policy.enabled) return { trigger: false, reason: "disabled" };
  if (inFlight) return { trigger: false, reason: "in_flight" };
  if (estimateTokens == null) return { trigger: false, reason: "no_usage" };
  if (estimateTokens < policy.thresholdTokens) return { trigger: false, reason: "below_threshold" };
  return { trigger: true, reason: "threshold_reached", estimateTokens, thresholdTokens: policy.thresholdTokens };
}
