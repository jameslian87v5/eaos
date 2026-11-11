import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authHeaders } from "../../components/AdminPanel";
import { EmptyState, StatusBadge } from "./ui";

interface AuditRow {
  id: string;
  orgId: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  result: string;
  reasonSummary: string | null;
  createdAt: string;
}

/**
 * M6b 安全中心「审计日志」页签 — 复用现有 /api/admin/governance-audit
 * 契约（服务端按 ctx 强制 own-org），最近 100 条治理审计；完整检索/导出
 * 在治理审计页。不复制 enable/import 动作，只是入口。
 */
export function SecurityAuditPanel() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/governance-audit?limit=100&offset=0`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows ?? []);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-sm text-ink-secondary">最近 100 条治理审计（本 org 范围）</span>
        <button
          onClick={() => void fetchRows()}
          disabled={loading}
          className="text-xs text-brand hover:underline disabled:opacity-50"
        >
          刷新
        </button>
        <div className="ml-auto text-sm flex gap-3">
          <Link to="/admin/governance-audit" className="text-brand hover:underline">治理审计检索 / 导出 →</Link>
          <Link to="/admin/audit" className="text-brand hover:underline">Runtime 事件审计 →</Link>
        </div>
      </div>

      {loading ? (
        <div className="h-40 bg-gray-50 rounded animate-pulse" />
      ) : error ? (
        <EmptyState title="审计加载失败" hint={error} />
      ) : rows.length === 0 ? (
        <EmptyState title="暂无治理审计记录" />
      ) : (
        <div className="border border-line-subtle rounded-md divide-y divide-line-subtle max-h-96 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="px-4 py-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-ink-muted font-mono shrink-0">
                {r.createdAt.replace("T", " ").slice(0, 19)}
              </span>
              <span className="font-mono text-xs text-ink-primary">{r.action}</span>
              <StatusBadge tone={r.result === "success" ? "green" : r.result === "denied" ? "red" : "amber"}>
                {r.result}
              </StatusBadge>
              <span className="text-xs text-ink-muted truncate">{r.reasonSummary ?? ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
