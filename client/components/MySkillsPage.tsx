/**
 * MySkillsPage.tsx — Octop absorption M7b: the user workbench "我的技能"
 * submission page (route /my-skills).
 *
 * Lists ONLY the caller's own submissions (GET /api/my-skills is
 * submitter-scoped server-side). Submission always enters the M3 validation
 * pipeline (POST /api/my-skills/submit, raw ZIP): 提交≠可用 — a successful
 * import stays 待审核 until an admin approves it (approve grants ONLY the
 * submitter a user-scope entitlement). This page shows status + categorical
 * failure codes; it never renders package file contents.
 *
 * UX conventions follow M6a/M7a: Tailwind tokens, skeleton loading, error
 * banner, no fixed multi-column assumptions.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Upload, Package, AlertCircle, RefreshCw } from "lucide-react";
import {
  validateSubmitForm,
  buildSubmitUrl,
  submitErrorMessage,
  statusMeta,
  codeLabel,
  type MySkillSubmission,
} from "./my-skills";

const API_BASE = "/api/my-skills";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface MySkillsPageProps {
  onBack: () => void;
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
  } catch {
    return "—";
  }
}

export function MySkillsPage({ onBack }: MySkillsPageProps) {
  const [submissions, setSubmissions] = useState<MySkillSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Submit form state.
  const [slug, setSlug] = useState("");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const onSubmit = async () => {
    if (submitting) return;
    const invalid = validateSubmitForm({
      slug,
      version,
      fileName: file?.name ?? null,
      fileSize: file?.size ?? null,
    });
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setFormError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await fetch(buildSubmitUrl(API_BASE, slug, version), {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/zip" },
        body: file!,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 400) {
        setFormError(submitErrorMessage(res.status, body));
        return;
      }
      // 400 = the M3 pipeline rejected the package (quarantined record kept).
      // Either way the submission is recorded — refresh the list.
      setSlug("");
      setVersion("");
      setFile(null);
      setNotice(
        res.ok
          ? "提交成功，等待管理员审核。审核通过前该技能不可用（仅你本人可见）。"
          : submitErrorMessage(res.status, body)
      );
      await load();
    } catch {
      setFormError("网络错误，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700"
            aria-label="返回工作台"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h1 className="font-semibold text-ink-primary flex items-center gap-2">
              <Package className="w-4 h-4 text-brand" /> 我的技能
            </h1>
            <p className="text-xs text-ink-secondary mt-0.5">
              提交本地技能包（ZIP，含 SKILL.md）；审核通过前不可用，其他用户不可见。审核通过后仅你本人可启用。
            </p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 disabled:opacity-50"
          aria-label="刷新"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 max-w-3xl mx-auto w-full">
        {loadError && (
          <div className="mb-4 px-4 py-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700 flex items-center gap-2" data-testid="my-skills-error">
            <AlertCircle className="w-4 h-4 shrink-0" /> {loadError}
          </div>
        )}

        {/* Submit form */}
        <div className="p-4 rounded-lg border border-gray-200 bg-white" data-testid="my-skills-submit-form">
          <p className="text-sm font-medium text-ink-primary mb-3">提交新技能包</p>
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-ink-secondary mb-1">技能名（slug）</label>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="my-demo-skill"
                  data-testid="my-skills-slug"
                  className="w-full px-3 h-9 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
                  disabled={submitting}
                />
              </div>
              <div className="w-40">
                <label className="block text-xs text-ink-secondary mb-1">版本（可选）</label>
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.0.0"
                  data-testid="my-skills-version"
                  className="w-full px-3 h-9 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
                  disabled={submitting}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">技能包（.zip，含 SKILL.md，≤80MB）</label>
              <input
                type="file"
                accept=".zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                data-testid="my-skills-file"
                className="w-full text-sm text-gray-600 file:mr-3 file:px-3 file:h-9 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
                disabled={submitting}
              />
            </div>
            {formError && (
              <p className="text-xs text-red-600" data-testid="my-skills-form-error">{formError}</p>
            )}
            {notice && (
              <p className="text-xs text-emerald-700" data-testid="my-skills-notice">{notice}</p>
            )}
            <button
              onClick={() => void onSubmit()}
              disabled={submitting}
              className="px-4 h-9 text-sm bg-brand hover:bg-brand-hover text-white rounded-md flex items-center gap-1.5 disabled:opacity-50"
              data-testid="my-skills-submit"
            >
              <Upload className="w-4 h-4" /> {submitting ? "提交中…" : "提交审核"}
            </button>
          </div>
        </div>

        {/* Submission list */}
        <div className="mt-6">
          <p className="text-sm font-medium text-ink-primary mb-3">我的提交记录</p>
          {loading ? (
            <div className="space-y-3" data-testid="my-skills-skeleton">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-20 rounded-lg border border-gray-200 bg-white animate-pulse" />
              ))}
            </div>
          ) : submissions.length === 0 ? (
            <div className="py-10 text-center" data-testid="my-skills-empty">
              <Package className="w-8 h-8 text-gray-300 mx-auto" />
              <p className="mt-3 text-sm text-ink-secondary">还没有提交记录，使用上方表单提交第一个技能包。</p>
            </div>
          ) : (
            <div className="space-y-3" data-testid="my-skills-list">
              {submissions.map((s) => {
                const meta = statusMeta(s.status);
                return (
                  <div
                    key={s.id}
                    data-testid={`my-skill-card-${s.slug}`}
                    className="p-4 rounded-lg border border-gray-200 bg-white"
                  >
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm text-ink-primary truncate">{s.slug}</p>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${meta.chip}`} data-testid="my-skill-status">
                        {meta.label}
                      </span>
                      <span className="ml-auto text-[11px] text-gray-400 shrink-0">{formatTime(s.createdAt)}</span>
                    </div>
                    {(s.errorCode || s.reasonCode) && (
                      <p className="mt-1.5 text-xs text-orange-600">
                        原因：{codeLabel(s.errorCode ?? s.reasonCode)}
                      </p>
                    )}
                    {s.status === "approved" && (
                      <p className="mt-1.5 text-xs text-emerald-600">已授权给你本人，可在创建专家时启用。</p>
                    )}
                    {s.status === "pending_review" && (
                      <p className="mt-1.5 text-xs text-ink-secondary">等待管理员审核。</p>
                    )}
                    {s.manifest && (
                      <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-400">
                        <span>文件 {s.manifest.fileCount}</span>
                        <span>v{s.manifest.version}</span>
                        {s.manifest.hasScripts && <span className="text-orange-500">含 scripts</span>}
                        <span title={s.manifest.sha256} className="font-mono">
                          {s.manifest.sha256.slice(0, 12)}…
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
