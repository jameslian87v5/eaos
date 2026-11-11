/**
 * UserSkillsReviewPage.tsx — Octop absorption M7b: the admin review queue for
 * user-submitted skill packages (route /admin/user-skills).
 *
 * Authority (iron law): approve/reject are ADMIN-ONLY — org_admin sees a
 * read-only own-org queue (visibility ≠ authority; the buttons are hidden and
 * the server 403s regardless). Approve enables the quarantined skill and
 * grants ONLY the submitter a user-scope entitlement; reject keeps the
 * package disabled with zero entitlement. Review metadata is manifest-only
 * (file count, hash, scripts flag, license) — never file contents.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, X, AlertCircle } from "lucide-react";
import { AdminPageHeader, InfoNote, RefreshButton, StatusBadge } from "../components/ui";
import { statusMeta, canReview, isReviewable, codeLabel, REJECT_REASONS, type MySkillSubmission } from "../../components/my-skills";

const API_BASE = "/api/admin/user-skills";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function currentRole(): string {
  try {
    return (JSON.parse(localStorage.getItem("user") || "{}")).role ?? "user";
  } catch {
    return "user";
  }
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

export function UserSkillsReviewPage() {
  const [submissions, setSubmissions] = useState<MySkillSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<MySkillSubmission | null>(null);
  const [rejectReason, setRejectReason] = useState(REJECT_REASONS[0].code);
  const isAdmin = canReview(currentRole());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(API_BASE, { headers: authHeaders() });
      if (!res.ok) {
        setLoadError(`加载失败（HTTP ${res.status}）`);
        return;
      }
      const data = await res.json();
      setSubmissions(Array.isArray(data.submissions) ? data.submissions : []);
    } catch {
      setLoadError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (sub: MySkillSubmission) => {
    if (acting) return;
    if (
      !window.confirm(
        `通过「${sub.slug}」？技能将启用，且仅提交者本人获得使用授权（其他用户/组织不可见）。`
      )
    ) {
      return;
    }
    setActing(sub.id);
    try {
      const res = await fetch(`${API_BASE}/${sub.id}/approve`, { method: "POST", headers: authHeaders() });
      if (!res.ok) {
        toast.error(`通过失败（HTTP ${res.status}）`);
        return;
      }
      toast.success(`已通过「${sub.slug}」`);
      await load();
    } catch {
      toast.error("网络错误，请重试");
    } finally {
      setActing(null);
    }
  };

  const confirmReject = async () => {
    if (!rejecting || acting) return;
    setActing(rejecting.id);
    try {
      const res = await fetch(`${API_BASE}/${rejecting.id}/reject`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ reasonCode: rejectReason }),
      });
      if (!res.ok) {
        toast.error(`拒绝失败（HTTP ${res.status}）`);
        return;
      }
      toast.success(`已拒绝「${rejecting.slug}」`);
      setRejecting(null);
      await load();
    } catch {
      toast.error("网络错误，请重试");
    } finally {
      setActing(null);
    }
  };

  const pendingCount = submissions.filter((s) => s.status === "pending_review").length;

  return (
    <div className="max-w-4xl">
      <AdminPageHeader
        title="用户技能审核"
        description="普通用户提交的本地技能包（已通过导入校验，默认停用）。通过后技能启用且仅提交者本人获得授权；拒绝后保持停用。"
        actions={<RefreshButton onClick={() => void load()} loading={loading} />}
      />

      {!isAdmin && (
        <InfoNote>
          你是 org_admin：本页为只读视图（仅本组织提交记录）。审核权限仅限平台 admin。
        </InfoNote>
      )}

      {loadError && (
        <div className="mb-4 px-4 py-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700 flex items-center gap-2" data-testid="user-skills-error">
          <AlertCircle className="w-4 h-4 shrink-0" /> {loadError}
        </div>
      )}

      <p className="text-sm text-ink-secondary mb-3">
        共 {submissions.length} 条记录，{pendingCount} 条待审核。
      </p>

      {loading ? (
        <div className="space-y-3" data-testid="user-skills-skeleton">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg border border-gray-200 bg-white animate-pulse" />
          ))}
        </div>
      ) : submissions.length === 0 ? (
        <div className="py-10 text-center" data-testid="user-skills-empty">
          <p className="text-sm text-ink-secondary">暂无用户技能提交记录。</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="user-skills-list">
          {submissions.map((s) => {
            const meta = statusMeta(s.status);
            const reviewable = isAdmin && isReviewable(s);
            return (
              <div
                key={s.id}
                data-testid={`user-skill-review-${s.slug}`}
                className="p-4 rounded-lg border border-gray-200 bg-white"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm text-ink-primary">{s.slug}</p>
                  <StatusBadge tone={
                    s.status === "approved" ? "green" : s.status === "rejected" ? "red" :
                    s.status === "quarantined" ? "amber" : "blue"
                  }>{meta.label}</StatusBadge>
                  <span className="text-[11px] text-gray-400">
                    提交者 {s.submitterUserId} · {formatTime(s.createdAt)}
                  </span>
                  {reviewable && (
                    <span className="ml-auto flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => void approve(s)}
                        disabled={acting === s.id}
                        className="px-3 h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-md flex items-center gap-1 disabled:opacity-50"
                        data-testid={`approve-${s.slug}`}
                      >
                        <Check className="w-3.5 h-3.5" /> {acting === s.id ? "处理中" : "通过"}
                      </button>
                      <button
                        onClick={() => {
                          setRejecting(s);
                          setRejectReason(REJECT_REASONS[0].code);
                        }}
                        disabled={acting === s.id}
                        className="px-3 h-8 text-xs border border-red-200 rounded-md text-red-600 hover:bg-red-50 flex items-center gap-1 disabled:opacity-50"
                        data-testid={`reject-${s.slug}`}
                      >
                        <X className="w-3.5 h-3.5" /> 拒绝
                      </button>
                    </span>
                  )}
                </div>
                {(s.errorCode || s.reasonCode) && (
                  <p className="mt-1.5 text-xs text-orange-600">
                    原因：{codeLabel(s.errorCode ?? s.reasonCode)}
                  </p>
                )}
                {s.manifest && (
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[11px] text-gray-400">
                    <span>文件数 {s.manifest.fileCount}</span>
                    <span>版本 v{s.manifest.version}</span>
                    <span>许可 {s.manifest.license ?? "无"}</span>
                    <span className="font-mono" title={s.manifest.sha256}>
                      sha256 {s.manifest.sha256.slice(0, 16)}…
                    </span>
                    {s.manifest.hasScripts && (
                      <span className="text-orange-500 col-span-2 sm:col-span-4">
                        ⚠ 包含 scripts/，请在通过前人工复核脚本内容。
                      </span>
                    )}
                  </div>
                )}
                {s.status === "approved" && s.reviewedAt && (
                  <p className="mt-1.5 text-[11px] text-emerald-600">
                    已由 {s.reviewedBy} 于 {formatTime(s.reviewedAt)} 通过，仅授权提交者本人。
                  </p>
                )}
                {s.status === "rejected" && s.reviewedAt && (
                  <p className="mt-1.5 text-[11px] text-red-500">
                    已由 {s.reviewedBy} 于 {formatTime(s.reviewedAt)} 拒绝。
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Reject confirm dialog (categorical reason only — no free text). */}
      {rejecting && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" data-testid="reject-dialog">
          <div className="w-full max-w-sm mx-4 p-5 rounded-lg bg-white shadow-lg">
            <p className="text-sm font-medium text-ink-primary">拒绝「{rejecting.slug}」</p>
            <p className="mt-1 text-xs text-ink-secondary">技能将保持停用、不授权任何人，且该名称不可重新提交。</p>
            <div className="mt-3">
              <label className="block text-xs text-ink-secondary mb-1">拒绝原因</label>
              <select
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                data-testid="reject-reason"
                className="w-full px-3 h-9 text-sm border border-gray-200 rounded-md"
              >
                {REJECT_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setRejecting(null)}
                className="px-3 h-9 text-xs border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => void confirmReject()}
                disabled={acting === rejecting.id}
                className="px-3 h-9 text-xs bg-red-600 hover:bg-red-700 text-white rounded-md disabled:opacity-50"
                data-testid="reject-confirm"
              >
                {acting === rejecting.id ? "处理中" : "确认拒绝"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
