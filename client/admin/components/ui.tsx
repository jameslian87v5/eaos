import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

// ─── AdminPageHeader ─────────────────────────────────────────
// 统一的后台页头：标题 + 说明 + 右侧操作。所有列表/配置页都套它，避免每个页面
// 自己拼 mb-3 + count + refresh 的 toolbar，并补齐过去缺失的页面标题。
export function AdminPageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-ink-primary leading-tight">{title}</h1>
        {description && (
          <div className="text-sm text-ink-secondary mt-1 leading-relaxed">{description}</div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// ─── StatusBadge ─────────────────────────────────────────────
// 统一的状态/标签 pill。替换散落在各页面/表格里的 bg-X-100 text-X-700 内联写法。
const BADGE_TONES: Record<string, string> = {
  gray: "bg-gray-100 text-gray-600",
  green: "bg-green-100 text-green-700",
  amber: "bg-amber-100 text-amber-700",
  red: "bg-red-100 text-red-700",
  blue: "bg-blue-100 text-blue-700",
  purple: "bg-purple-100 text-purple-700",
  indigo: "bg-indigo-100 text-indigo-700",
};

export function StatusBadge({
  tone = "gray",
  children,
  title,
}: {
  tone?: keyof typeof BADGE_TONES | string;
  children: ReactNode;
  title?: string;
}) {
  const cls = BADGE_TONES[tone] ?? BADGE_TONES.gray;
  return (
    <span
      title={title}
      className={`inline-flex items-center text-xs px-1.5 py-0.5 rounded font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

// ─── RefreshButton ───────────────────────────────────────────
// 统一的「刷新」按钮，替换各页面里逐字重复的 🔄 刷新 border 按钮。
export function RefreshButton({
  onClick,
  loading = false,
  label = "刷新",
}: {
  onClick: () => void;
  loading?: boolean;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 border border-line-subtle rounded bg-white text-ink-secondary hover:bg-gray-50 disabled:opacity-50 transition-colors"
    >
      <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
      {label}
    </button>
  );
}

// ─── EmptyState ──────────────────────────────────────────────
export function EmptyState({ icon, title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-3xl mb-2 opacity-30">{icon ?? "📋"}</div>
      <div className="text-sm text-ink-secondary">{title}</div>
      {hint && <div className="text-xs text-ink-muted mt-1">{hint}</div>}
    </div>
  );
}

// ─── ErrorState ──────────────────────────────────────────────
// S1: reusable load-failure state. Distinguishes "failed to load" from "empty"
// (EmptyState). Optional onRetry renders a 重试 button.
export function ErrorState({
  title = "加载失败",
  hint,
  onRetry,
}: {
  title?: string;
  hint?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-3xl mb-2 opacity-40">⚠️</div>
      <div className="text-sm text-danger-fg">{title}</div>
      {hint && <div className="text-xs text-ink-muted mt-1">{hint}</div>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 text-xs px-3 py-1 border border-line-subtle rounded text-ink-secondary hover:text-brand hover:border-brand transition-colors"
        >
          重试
        </button>
      )}
    </div>
  );
}

// ─── InfoNote ────────────────────────────────────────────────
// S3: lightweight onboarding/explainer banner. Not a full callout system —
// just consistent token-based styling for helper copy on admin pages.
export function InfoNote({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="mb-4 p-3 rounded-md border border-line-subtle bg-surface-page text-xs text-ink-secondary leading-relaxed">
      {title && <div className="font-medium text-ink-primary mb-1">{title}</div>}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

// ─── SearchInput ─────────────────────────────────────────────
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "搜索…"}
      className="text-xs border border-line-subtle rounded px-2.5 py-1 w-48 bg-white focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/30"
    />
  );
}
