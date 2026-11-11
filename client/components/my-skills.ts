/**
 * my-skills.ts — Octop absorption M7b: pure helpers for the user-side "我的技能"
 * submission page and the admin review queue. UX ONLY: the server contract is
 * the authority — /api/my-skills/submit always enters the M3 importSkillZip
 * validator and stays enabled:false pending review; approve is admin-only and
 * grants ONLY the submitter a user-scope entitlement. These helpers never
 * widen what the server will accept.
 */

/** One row from GET /api/my-skills or GET /api/admin/user-skills. */
export interface MySkillSubmission {
  id: string;
  slug: string;
  submitterUserId: string;
  orgId: string;
  status: "pending_review" | "quarantined" | "rejected" | "approved";
  errorCode?: string;
  reasonCode?: string;
  manifest?: {
    sha256: string;
    fileCount: number;
    hasScripts: boolean;
    license: string | null;
    description: string;
    version: string;
    files: string[];
  };
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export const MY_SKILL_LIMITS = {
  slugMax: 64,
  versionMax: 64,
  zipMaxBytes: 80 * 1024 * 1024,
};

// Same trusted-input contracts as skill-zip-import (server re-validates).
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Inline validation mirroring the server bounds (inline errors only). */
export function validateSubmitForm(args: {
  slug: string;
  version: string;
  fileName: string | null;
  fileSize: number | null;
}): string | null {
  const slug = args.slug.trim();
  if (slug.length === 0) return "请填写技能名（slug）";
  if (!SLUG_RE.test(slug) || slug.length > MY_SKILL_LIMITS.slugMax) {
    return "技能名不合法：仅字母/数字/连字符，≤64 字符";
  }
  const version = args.version.trim();
  if (version !== "") {
    if (!VERSION_RE.test(version) || version.length > MY_SKILL_LIMITS.versionMax) {
      return "版本号不合法：字母/数字/点/下划线/加号/连字符";
    }
  }
  if (!args.fileName) return "请选择一个 ZIP 技能包";
  if (!/\.zip$/i.test(args.fileName)) return "仅支持 .zip 文件";
  if (args.fileSize !== null && args.fileSize > MY_SKILL_LIMITS.zipMaxBytes) {
    return "ZIP 超过 80MB 上限";
  }
  return null;
}

/** Build the submit URL — slug/version ride the query (body is the raw ZIP). */
export function buildSubmitUrl(base: string, slug: string, version: string): string {
  const q = new URLSearchParams({ slug: slug.trim() });
  const v = version.trim();
  if (v !== "") q.set("version", v);
  return `${base}/submit?${q.toString()}`;
}

/** Bounded, categorical error mapping (no raw server text beyond codes). */
export function submitErrorMessage(status: number, body: { code?: string; message?: string }): string {
  switch (body.code) {
    case "invalid_slug": return "技能名不合法：仅字母/数字/连字符，≤64 字符";
    case "invalid_version": return "版本号不合法";
    case "empty_zip": return "未收到 ZIP 内容";
    case "zip_too_large": return "ZIP 超过 80MB 上限";
    case "duplicate": return `该技能名已被占用（${status}）——换一个名字，或等待现有提交的审核结果`;
    case "registry_invalid": return "技能注册表损坏，提交已被拒绝且未改动任何数据，请联系管理员";
    case "extract_failed": return "ZIP 被拒收：损坏 / 路径穿越 / 绝对路径 / symlink / 超出边界";
    case "no_skill": return "包内没有 SKILL.md —— 不是技能包";
    case "multiple_skills": return "包内含多个技能——一次只能提交一个";
    case "scan_failed": return "包扫描失败（文件数超限）";
    case "repackage_failed": return "重打包失败（包形态不合规）";
    case "invalid_plugin": return "安装后校验失败，已回滚";
    case "org_not_active": return "组织当前不可用，无法提交";
    case "pending_cap_submitter":
    case "submission_cap_submitter": return "待处理提交已达上限（每人 5 条，含待审核与已隔离）——请等待审核完成或使用合规包重试";
    case "pending_cap_org":
    case "submission_cap_org": return "组织待处理提交已达上限（20 条，含待审核与已隔离）——请稍后再试";
    case "submission_store_invalid": return "提交台账异常，本次提交未产生任何残留，请联系管理员";
    default: return `提交失败（HTTP ${status}）`;
  }
}

export const STATUS_META: Record<MySkillSubmission["status"], { label: string; chip: string }> = {
  pending_review: { label: "待审核", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  quarantined: { label: "已隔离", chip: "bg-orange-50 text-orange-700 border-orange-200" },
  rejected: { label: "已拒绝", chip: "bg-red-50 text-red-700 border-red-200" },
  approved: { label: "已通过", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
};

export function statusMeta(status: MySkillSubmission["status"]): { label: string; chip: string } {
  return STATUS_META[status] ?? { label: status, chip: "bg-gray-100 text-gray-600 border-gray-200" };
}

/** Review authority is admin-only (org_admin gets a read-only queue). */
export function canReview(role: string | undefined | null): boolean {
  return role === "admin";
}

/** Reviewable = pending_review with a surviving package (quarantined/terminal are not). */
export function isReviewable(sub: MySkillSubmission): boolean {
  return sub.status === "pending_review";
}

/** Fixed categorical reject reasons (server re-validates the token shape). */
export const REJECT_REASONS: Array<{ code: string; label: string }> = [
  { code: "unsafe_scripts", label: "包含不安全脚本" },
  { code: "invalid_package", label: "包内容不合规" },
  { code: "policy_violation", label: "违反平台策略" },
  { code: "inappropriate_content", label: "内容不当" },
  { code: "duplicate_resource", label: "与现有技能重复" },
];

/** Human label for a stored errorCode/reasonCode; unknown → the raw token. */
export function codeLabel(code: string | undefined): string {
  if (!code) return "—";
  const map: Record<string, string> = {
    ...Object.fromEntries(REJECT_REASONS.map((r) => [r.code, r.label])),
    extract_failed: "ZIP 被拒收（损坏/穿越/超限）",
    no_skill: "缺少 SKILL.md",
    multiple_skills: "包含多个技能",
    scan_failed: "扫描失败",
    repackage_failed: "重打包失败",
    invalid_plugin: "安装校验失败",
  };
  return map[code] ?? code;
}
