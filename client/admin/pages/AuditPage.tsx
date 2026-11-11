import { useState, useEffect, useCallback, useMemo } from "react";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, EmptyState, RefreshButton, SearchInput } from "../components/ui";

const API_BASE = "/api";

interface AuditEvent {
  id: string;
  sequence: number;
  eventType: string;
  chatId: string;
  createdAt: string;
  payload: any;
}

// Agent OS M3 (plan §7): minimal admin runId lookup detail. Mirrors the
// redacted GET /api/admin/runs/:runId response — opaque principalId only
// (never the raw subject), no Tool payloads / message bodies.
interface RunDetail {
  run: {
    id: string;
    agentSessionId: string;
    principalType: string;
    principalId: string;
    orgId: string;
    appId: string;
    agentId: string;
    configVersion: string | null;
    capabilityIds: string | null;
    model: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
    costUsd: number | null;
    durationMs: number | null;
    usageJson: string | null;
  };
  eventCounts: Array<{ eventType: string; count: number }>;
  events: Array<Record<string, unknown>>;
  eventPage: { limit: number; offset: number; totalShown: number };
}

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState("");
  const [filterApp, setFilterApp] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");

  // ─── M3 runId lookup state ───────────────────────────────────────
  const [runInput, setRunInput] = useState("");
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState("");

  const lookupRun = useCallback(async () => {
    const id = runInput.trim();
    if (!id) return;
    setRunLoading(true);
    setRunError("");
    setRunDetail(null);
    try {
      const res = await fetch(`${API_BASE}/admin/runs/${encodeURIComponent(id)}`, { headers: authHeaders() });
      if (!res.ok) {
        // 404 covers non-existent + non-admin + cross-org (existence hidden).
        setRunError(res.status === 404 ? "未找到运行（不存在或无权访问）" : `查询失败 (${res.status})`);
        return;
      }
      setRunDetail(await res.json());
    } catch {
      setRunError("网络错误");
    } finally {
      setRunLoading(false);
    }
  }, [runInput]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (filterType) params.set("eventType", filterType);
      if (filterApp) params.set("appId", filterApp);
      const res = await fetch(`${API_BASE}/admin/audit?${params}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events ?? []);
        setHasMore(data.hasMore ?? false);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [filterType, filterApp]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const eventTypes = [
    "application_created", "application_updated", "application_deleted",
    "hook_registered", "hook_updated", "hook_deleted",
    "agent_profile_updated", "capability_activation_changed",
    "entitlement_changed", "sdk_init", "resolved_snapshot",
  ];

  const filteredEvents = useMemo(() => {
    if (!search.trim()) return events;
    const q = search.toLowerCase();
    return events.filter(e =>
      e.eventType.toLowerCase().includes(q) ||
      (e.chatId ?? "").toLowerCase().includes(q) ||
      JSON.stringify(e.payload ?? {}).toLowerCase().includes(q)
    );
  }, [events, search]);

  return (
    <div>
      <AdminPageHeader
        title="审计日志"
        actions={
          <div className="flex items-center gap-3">
            <select value={filterType} onChange={e => setFilterType(e.target.value)}
              className="text-xs border border-line-subtle rounded px-2 py-1 bg-white">
              <option value="">全部事件类型</option>
              {eventTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              value={filterApp}
              onChange={e => setFilterApp(e.target.value)}
              placeholder="App ID 筛选…"
              className="text-xs border border-line-subtle rounded px-2 py-1 w-32"
            />
            <SearchInput value={search} onChange={setSearch} placeholder="搜索事件…" />
            <RefreshButton onClick={fetchEvents} label="查询" loading={loading} />
          </div>
        }
      />

      {/* Agent OS M3 (plan §7): minimal runId lookup — one input, one action, */}
      {/* redacted summary. No list/dashboard/filters. */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-medium text-gray-700">运行查询 (runId)</h3>
          <span className="text-[11px] text-gray-400">按 runId 查看一次执行的身份/能力/审批/结果/成本</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={runInput}
            onChange={e => setRunInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") lookupRun(); }}
            placeholder="粘贴 runId…"
            className="text-xs border border-line-subtle rounded px-2 py-1 flex-1 font-mono"
          />
          <button
            onClick={lookupRun}
            disabled={runLoading || !runInput.trim()}
            className="text-xs bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50"
          >
            {runLoading ? "查询中…" : "查询"}
          </button>
        </div>
        {runError && <div className="text-xs text-red-600 mt-2">{runError}</div>}
        {runDetail && (
          <div className="mt-3 text-xs space-y-2">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-gray-600">
              <div>状态: <span className="font-mono text-gray-900">{runDetail.run.status}</span></div>
              <div>主体类型: <span className="font-mono text-gray-900">{runDetail.run.principalType}</span></div>
              <div>主体 ID: <span className="font-mono text-gray-900">{runDetail.run.principalId.slice(0, 12)}…</span></div>
              <div>App: <span className="font-mono text-gray-900">{runDetail.run.appId}</span></div>
              <div>Agent: <span className="font-mono text-gray-900">{runDetail.run.agentId.slice(0, 12)}…</span></div>
              <div>模型: <span className="font-mono text-gray-900">{runDetail.run.model ?? "—"}</span></div>
              <div>开始: <span className="text-gray-900">{new Date(runDetail.run.startedAt).toLocaleString()}</span></div>
              <div>结束: <span className="text-gray-900">{runDetail.run.endedAt ? new Date(runDetail.run.endedAt).toLocaleString() : "—"}</span></div>
              <div>耗时: <span className="text-gray-900">{runDetail.run.durationMs ?? "—"} ms</span></div>
              <div>成本: <span className="text-gray-900">{runDetail.run.costUsd != null ? `$${runDetail.run.costUsd.toFixed(4)}` : "—"}</span></div>
              <div className="col-span-2 md:col-span-3">configVersion: <span className="font-mono text-gray-900">{runDetail.run.configVersion ?? "—"}</span></div>
              <div className="col-span-2 md:col-span-3">有效能力 IDs: <span className="font-mono text-gray-900">{runDetail.run.capabilityIds ?? "(none)"}</span></div>
              {runDetail.run.usageJson && (
                <div className="col-span-2 md:col-span-3">Token 用量: <span className="font-mono text-gray-900">{runDetail.run.usageJson}</span></div>
              )}
            </div>
            {runDetail.eventCounts.length > 0 && (
              <div className="pt-1">
                <span className="text-gray-500">事件计数: </span>
                {runDetail.eventCounts.map((c, i) => (
                  <span key={i} className="font-mono text-gray-700 mr-2">{c.eventType}={c.count}</span>
                ))}
                <span className="text-gray-400 ml-2">(展示 {runDetail.eventPage.totalShown} 条)</span>
              </div>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-ink-muted py-4 text-center">加载中…</div>
      ) : events.length === 0 ? (
        <EmptyState icon="📜" title="暂无审计日志" hint="治理事件（应用变更、能力变更等）会记录在这里" />
      ) : filteredEvents.length === 0 ? (
        <EmptyState icon="🔍" title="无匹配结果" hint="尝试调整搜索条件或筛选器" />
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">事件类型</th>
                <th className="px-3 py-2 font-medium">Agent ID</th>
                <th className="px-3 py-2 font-medium">摘要</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((e) => (
                <tr key={e.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded">
                      {e.eventType}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-400">{e.chatId?.slice(0, 8) ?? "—"}…</td>
                  <td className="px-3 py-2 text-gray-500 max-w-md truncate">
                    {e.payload ? JSON.stringify(e.payload).slice(0, 80) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="text-xs text-gray-400 mt-2">还有更多记录（请缩小时间范围或事件类型）</div>
      )}
    </div>
  );
}
