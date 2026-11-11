import { useState, useEffect, useCallback } from "react";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, RefreshButton, EmptyState, ErrorState, InfoNote } from "../components/ui";

const API_BASE = "/api";

interface GovernanceAuditRow {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  orgId: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  fromOrgId: string | null;
  toOrgId: string | null;
  result: string;
  reasonSummary: string | null;
  requestId: string | null;
  traceId: string | null;
  createdAt: string;
}

/**
 * M5 governance-audit page. Reads the `governance_audit_log` sink (lifecycle +
 * quota.exceeded + audit.purge events) — DISTINCT from the existing /admin/audit
 * page which surfaces `agent_events`. org_admin is force-scoped to own org by the
 * server; admin sees enterprise-wide and may export / purge.
 *
 * Metadata-only by schema: no body/payload column is rendered (and none exists).
 */
export function GovernanceAuditPage() {
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const isAdmin = currentUser.role === "admin";

  const [rows, setRows] = useState<GovernanceAuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  const LIMIT = 100;
  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
      if (action) params.set("action", action);
      if (result) params.set("result", result);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetch(`${API_BASE}/admin/governance-audit?${params}`, { headers: authHeaders() });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setRows([]);
        return;
      }
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setHasMore(data.hasMore ?? false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [action, result, from, to, offset]);

  useEffect(() => { void fetchRows(); }, [fetchRows]);

  async function exportAs(fmt: "csv" | "json") {
    const params = new URLSearchParams({ format: fmt });
    if (action) params.set("action", action);
    if (result) params.set("result", result);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const res = await fetch(`${API_BASE}/admin/governance-audit/export?${params}`, { headers: authHeaders() });
    if (!res.ok) { setError(`导出失败: HTTP ${res.status}`); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.headers.get("Content-Disposition")?.split("filename=")[1] ?? `governance-audit.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function purge() {
    if (!confirm("确认清理 180 天前的治理审计记录？")) return;
    const res = await fetch(`${API_BASE}/admin/governance-audit/purge`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ days: 180 }),
    });
    if (!res.ok) { setError(`清理失败: HTTP ${res.status}`); return; }
    void fetchRows();
  }

  return (
    <div>
      <AdminPageHeader
        title="治理审计"
        description="部门生命周期、资源审核分发与配额决策的元数据审计（默认保留 180 天）"
        actions={
          <>
            <RefreshButton onClick={fetchRows} loading={loading} />
            {isAdmin && (
              <>
                <button onClick={() => exportAs("csv")} className="text-xs px-2.5 py-1 border border-line-subtle bg-white text-ink-secondary rounded hover:bg-gray-50">导出 CSV</button>
                <button onClick={() => exportAs("json")} className="text-xs px-2.5 py-1 border border-line-subtle bg-white text-ink-secondary rounded hover:bg-gray-50">导出 JSON</button>
                <button onClick={purge} className="text-xs px-2.5 py-1 border border-red-200 bg-white text-red-600 rounded hover:bg-red-50">清理 180 天前</button>
              </>
            )}
          </>
        }
      />
      {!isAdmin && (
        <InfoNote title="本部门视图">你只看到本部门的治理审计记录；企业管理员可见全企业并导出/清理。</InfoNote>
      )}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <input value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} placeholder="action (如 quota.exceeded)" className="px-2 py-1 border border-line-subtle rounded w-48" />
        <select value={result} onChange={(e) => { setResult(e.target.value); setOffset(0); }} className="px-2 py-1 border border-line-subtle rounded">
          <option value="">全部结果</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
          <option value="denied">denied</option>
        </select>
        <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} className="px-2 py-1 border border-line-subtle rounded" />
        <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} className="px-2 py-1 border border-line-subtle rounded" />
        <button onClick={() => { setOffset(0); void fetchRows(); }} className="px-2.5 py-1 border border-line-subtle bg-white rounded hover:bg-gray-50">筛选</button>
      </div>

      {error && <ErrorState title={error} />}
      {loading ? (
        <div className="py-16 text-center text-sm text-ink-muted">加载中…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="尚无审计记录" hint="触发部门开通/状态变更/资源审核分发/配额超限后，元数据审计会出现在这里" />
      ) : (
        <div className="bg-white border border-line-subtle rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">部门</th>
                <th className="px-3 py-2 font-medium">动作</th>
                <th className="px-3 py-2 font-medium">结果</th>
                <th className="px-3 py-2 font-medium">对象</th>
                <th className="px-3 py-2 font-medium">操作者</th>
                <th className="px-3 py-2 font-medium">原因摘要</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 text-ink-muted whitespace-nowrap">{r.createdAt}</td>
                  <td className="px-3 py-2 font-mono">{r.orgId}</td>
                  <td className="px-3 py-2 font-mono">{r.action}</td>
                  <td className="px-3 py-2">
                    <span className={r.result === "denied" ? "text-red-600" : r.result === "failure" ? "text-amber-600" : "text-emerald-600"}>{r.result}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-ink-muted">{r.objectType ?? "—"}{r.objectId ? ` / ${r.objectId}` : ""}</td>
                  <td className="px-3 py-2 text-ink-muted">{r.actorRole ?? "—"}{r.actorUserId ? ` / ${r.actorUserId.slice(0, 8)}` : ""}</td>
                  <td className="px-3 py-2 text-ink-secondary max-w-xs truncate" title={r.reasonSummary ?? ""}>{r.reasonSummary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-ink-muted">
        <span>共 {total} 条{hasMore ? "（更多未加载）" : ""}</span>
        <div className="flex gap-2">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))} className="px-2 py-1 border border-line-subtle rounded disabled:opacity-40">上一页</button>
          <button disabled={!hasMore} onClick={() => setOffset(offset + LIMIT)} className="px-2 py-1 border border-line-subtle rounded disabled:opacity-40">下一页</button>
        </div>
      </div>
    </div>
  );
}
