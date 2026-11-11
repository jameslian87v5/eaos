/**
 * RuntimePolicy — centralised runtime lifecycle policy.
 *
 * All idle-stop, TTL, volume-limit and protection decisions
 * read from this module.  ContainerManager must NOT contain
 * hard-coded constants for these concerns.
 *
 * Per LOCAL_DEV_PLAN.md §6.1 and enterprise-mvp-technical-architecture.md §3.5.
 */

export interface RuntimePolicy {
  /** Idle time before auto-stopping a container (ms). */
  idleStopMs: number;
  /** Max age of a workspace volume before eligible for GC (ms). */
  workspaceTtlMs: number;
  /** Max age of a claude-home volume before eligible for GC (ms). */
  claudeHomeTtlMs: number;
  /** Workspace volume size soft-limit (bytes). Not enforced this phase. */
  maxWorkspaceBytes: number;
  /** Claude-home volume size soft-limit (bytes). Not enforced this phase. */
  maxClaudeHomeBytes: number;
  /** Never auto-stop while agent is executing. */
  protectWhenBusy: boolean;
  /** Never auto-stop while a tool-approval is pending. */
  protectWhenPendingApproval: boolean;
  /** Never auto-stop while WebSocket subscribers are connected. */
  protectWhenSubscribers: boolean;
  /** Deleting a chat also removes its workspace + claude-home volumes. */
  deleteChatRemovesVolumes: boolean;
}

const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_GB = 1024 * 1024 * 1024;
const ONE_HUNDRED_MB = 100 * 1024 * 1024;

/** Default policy — safe for local-dev and single-node production. */
export const defaultPolicy: RuntimePolicy = {
  idleStopMs: 30 * ONE_MINUTE,
  workspaceTtlMs: 7 * ONE_DAY,
  claudeHomeTtlMs: 30 * ONE_DAY,
  maxWorkspaceBytes: ONE_GB,
  maxClaudeHomeBytes: ONE_HUNDRED_MB,
  protectWhenBusy: true,
  protectWhenPendingApproval: true,
  protectWhenSubscribers: true,
  deleteChatRemovesVolumes: true,
};

/**
 * Resolve the effective RuntimePolicy.
 *
 * Future: merge per-org / per-user overrides here.
 * This phase returns the hard-coded default.
 */
export function resolvePolicy(): RuntimePolicy {
  return { ...defaultPolicy };
}
