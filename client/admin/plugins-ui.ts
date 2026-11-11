/**
 * plugins-ui.ts — pure helpers for the /admin/plugins page (M6 residual UI
 * closure, evt_20261023054637). Status hierarchy follows Octop's plugin
 * manager semantics: an invalid/error plugin outranks the enabled flag, so
 * an invalid-but-enabled row still renders as broken and cannot be toggled
 * blindly. UI-only: no backend contract knowledge beyond the existing
 * /api/admin/skills/:name/enable|disable toggle (admin-only, audited).
 */

export interface InstalledPlugin {
  name: string;
  type: "skill" | "hook-plugin";
  version: string;
  description: string;
  enabled: boolean;
  valid: boolean;
  path: string;
  error?: string;
  /** M7b provenance — present exactly on user-submitted rows (skills only). */
  submittedBy?: string;
  submissionId?: string;
}

export type PluginTypeFilter = "all" | "skill" | "hook-plugin";

export interface PluginStatusMeta {
  label: string;
  tone: "red" | "gray" | "green";
}

/** Error-first status resolution (Octop order: error → disabled → ok). */
export function pluginStatusMeta(p: InstalledPlugin): PluginStatusMeta {
  if (!p.valid) return { label: "无效", tone: "red" };
  if (!p.enabled) return { label: "已停用", tone: "gray" };
  return { label: "已启用", tone: "green" };
}

export function pluginTypeMeta(p: InstalledPlugin): { label: string; tone: "blue" | "purple" } {
  return p.type === "skill"
    ? { label: "skill", tone: "blue" }
    : { label: "hook-plugin", tone: "purple" };
}

/**
 * Provenance-based (fix round evt_20261023061443): a row is user-submitted
 * iff the registry carries M7b submitter metadata. Path is NOT consulted —
 * admin-imported M3 ZIP packages also live under skills/quarantine and must
 * stay toggle-eligible when valid. User-submitted rows must only be enabled
 * through the /admin/user-skills approve flow (enable + submitter
 * entitlement) — never through the global platform toggle on this page.
 */
export function isUserSubmitted(p: InstalledPlugin): boolean {
  return typeof p.submittedBy === "string" && p.submittedBy.length > 0;
}

/**
 * Only valid, non-user-submitted skill rows can use the global
 * enable/disable toggle. Hook-plugins have no toggle route; invalid rows
 * must be fixed/re-imported first.
 */
export function canToggleEnabled(p: InstalledPlugin): boolean {
  return p.type === "skill" && p.valid && !isUserSubmitted(p);
}

export function toggleDisabledReason(p: InstalledPlugin): string | null {
  if (isUserSubmitted(p)) return "用户提交的技能请在「用户技能审核」页处理（通过 = 启用 + 授权提交者）";
  if (p.type === "hook-plugin") return "hook-plugin 暂无在线启停接口，重新导入时可选择启用状态";
  if (!p.valid) return "校验未通过，修复后重新导入";
  return null;
}

export function toggleEndpoint(p: InstalledPlugin, enable: boolean): string {
  return `/api/admin/skills/${encodeURIComponent(p.name)}/${enable ? "enable" : "disable"}`;
}

export function filterPlugins(list: InstalledPlugin[], filter: PluginTypeFilter): InstalledPlugin[] {
  return filter === "all" ? list : list.filter((p) => p.type === filter);
}

// ─── M7b submission status (fix 2, evt_20261023063035) ─────────
// The registry row only carries provenance (submittedBy/submissionId); the
// authoritative lifecycle status lives in the /api/admin/user-skills ledger.
// "unknown" = ledger miss (fail-soft: fetch failed or record purged) — still
// provenance-owned, just not counted as pending.

export type SubmissionStatus = "pending_review" | "quarantined" | "rejected" | "approved" | "unknown";

export type SubmissionLedgerMap = Map<string, SubmissionStatus>;

export interface LedgerSubmissionRecord {
  id?: string;
  status?: string;
}

export function buildLedgerMap(records: LedgerSubmissionRecord[]): SubmissionLedgerMap {
  const map: SubmissionLedgerMap = new Map();
  for (const r of records) {
    if (typeof r?.id !== "string" || typeof r?.status !== "string") continue;
    map.set(r.id, r.status as SubmissionStatus);
  }
  return map;
}

export function submissionStatusFor(p: InstalledPlugin, ledger: SubmissionLedgerMap): SubmissionStatus {
  if (!isUserSubmitted(p)) return "unknown";
  return ledger.get(p.submissionId ?? "") ?? "unknown";
}

export function submissionStatusMeta(status: SubmissionStatus): { label: string; tone: "amber" | "red" | "green" | "gray" } {
  switch (status) {
    case "pending_review": return { label: "用户提交待审", tone: "amber" };
    case "quarantined": return { label: "用户提交已隔离", tone: "amber" };
    case "rejected": return { label: "用户提交已拒绝", tone: "red" };
    case "approved": return { label: "用户提交已通过", tone: "green" };
    default: return { label: "用户提交", tone: "gray" };
  }
}

/** pendingReview counts ONLY pending_review — approved/rejected rows are resolved. */
export function countPendingReview(list: InstalledPlugin[], ledger: SubmissionLedgerMap): number {
  return list.filter((p) => submissionStatusFor(p, ledger) === "pending_review").length;
}

export interface PluginCounts {
  total: number;
  skill: number;
  hookPlugin: number;
  enabled: number;
  invalid: number;
}

export function pluginCounts(list: InstalledPlugin[]): PluginCounts {
  return {
    total: list.length,
    skill: list.filter((p) => p.type === "skill").length,
    hookPlugin: list.filter((p) => p.type === "hook-plugin").length,
    enabled: list.filter((p) => p.enabled).length,
    invalid: list.filter((p) => !p.valid).length,
  };
}

export interface PluginImportResponse {
  resourceId?: string;
  version?: string;
  warnings?: string[];
}

/** Import result scan warnings — surfaced in the UI so admins see them. */
export function importWarnings(result: PluginImportResponse | null | undefined): string[] {
  return Array.isArray(result?.warnings) ? result.warnings.filter((w) => typeof w === "string") : [];
}
