import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, InfoNote } from "../components/ui";

const API_BASE = "/api";

// R5c round-3 (#4): unified Skill Hub management entry. Fetches
// /api/hub/launch (which returns ONLY a verified Hub base URL — no service
// token, no platform orgId, no role). The page stores + renders only that
// URL. The browser authenticates to the Hub via the Hub's OWN session; the
// Hub scopes what the user (admin / org_admin / user) can see.
//
// Non-leakage by construction: the only field read from the response is `url`.
// token / orgId / role are never read, never stored in state, never rendered.
export function HubPage() {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLaunch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/hub/launch`, { headers: authHeaders() });
      if (res.status === 401) {
        setError("登录已过期，请重新登录");
        return;
      }
      if (res.status === 503) {
        setError("Skill Hub 未配置（管理员需设置 SKILLHUB_URL）");
        return;
      }
      if (!res.ok) {
        setError(`无法获取 Skill Hub 入口 (HTTP ${res.status})`);
        return;
      }
      const data = await res.json();
      // ONLY the verified URL is consumed. No token/orgId/role is read.
      if (typeof data?.url === "string" && data.url) {
        setUrl(data.url);
      } else {
        setError("Skill Hub 入口配置异常");
      }
    } catch {
      setError("网络错误，无法连接平台");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLaunch(); }, [fetchLaunch]);

  const openHub = () => {
    if (!url) return;
    // Open in a new tab; the Hub authenticates via its own session.
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div>
      <AdminPageHeader
        title="Skill Hub"
        description="打开 Skill Hub 管理台。浏览器将通过 Hub 自己的会话登录，平台不会向浏览器发送服务令牌、部门 ID 或角色。"
        actions={
          <button
            onClick={fetchLaunch}
            className="text-xs text-ink-muted hover:text-brand transition-colors"
          >
            刷新
          </button>
        }
      />

      {loading && (
        <div className="text-sm text-ink-muted">正在获取 Skill Hub 入口…</div>
      )}

      {!loading && error && (
        <div className="space-y-3">
          <div className="text-sm text-red-600">{error}</div>
          <button
            onClick={fetchLaunch}
            className="px-3 py-1.5 text-sm rounded border border-line-subtle hover:bg-surface-page"
          >
            重试
          </button>
        </div>
      )}

      {!loading && !error && url && (
        <div className="space-y-3">
          <button
            onClick={openHub}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded bg-brand text-white hover:opacity-90 transition-opacity"
          >
            <ExternalLink className="w-4 h-4" />
            打开 Skill Hub
          </button>
          <InfoNote title="访问说明">
            点击后将在新标签页打开 Skill Hub。请使用 Hub 自己的账号登录；平台仅提供入口 URL，不代为登录。
          </InfoNote>
        </div>
      )}

      <div className="mt-6 flex items-start gap-2 text-xs text-ink-muted">
        <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>非泄露设计：本页仅渲染 /api/hub/launch 返回的已验证 Hub URL，不读取、不存储、不展示服务令牌、部门 ID 或角色。</span>
      </div>
    </div>
  );
}
