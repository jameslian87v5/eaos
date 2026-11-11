import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { AdminPageHeader, ErrorState, InfoNote, RefreshButton } from "../components/ui";
import { authHeaders } from "../../components/AdminPanel";

// M3 (model-and-token-management-plan.md §7/§9-M3): org_admin Token 用量仪表盘。
// 只读聚合现有 result 事件（input/output/cache 两个方向），无价格/账单字段。
// 服务端从 JWT orgId 隔离：org_admin 只能查本 org（org 下拉来自 /api/admin/orgs
// 的 scope 结果）；admin 可跨 org。普通 user 在路由层就被 403，进不了本页。

const API_BASE = "/api";

interface UsageDims {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  total: number;
  turns: number;
}

interface UsageGroup extends UsageDims {
  key: string;
  label: string;
}

interface UsageResult {
  items: UsageGroup[];
  totals: UsageDims;
  groups: number;
  limit: number;
  offset: number;
  groupBy: "day" | "user" | "agent" | "chat";
}

interface BudgetView {
  limit: number;
  thresholdPct: number;
  used: number;
  remaining: number;
  status: "normal" | "near" | "over";
  monthStart: string;
  usage: UsageDims;
}

interface OrgSummary { id: string; name: string }

const fmt = (n: number) => n.toLocaleString("en-US");
const PAGE_SIZE = 20;

const GROUP_LABELS: Record<UsageResult["groupBy"], string> = {
  day: "按日",
  user: "按用户",
  agent: "按 Agent",
  chat: "按对话",
};

const STATUS_STYLE: Record<BudgetView["status"], { cls: string; label: string }> = {
  normal: { cls: "bg-green-50 text-green-700 border-green-200", label: "正常" },
  near: { cls: "bg-amber-50 text-amber-700 border-amber-200", label: "临近预算" },
  over: { cls: "bg-red-50 text-red-700 border-red-200", label: "已超预算" },
};

export function TokenUsagePage() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [orgId, setOrgId] = useState<string>("");
  const [groupBy, setGroupBy] = useState<UsageResult["groupBy"]>("day");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ usage: UsageResult; budget: BudgetView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // org list (admin = all; org_admin = own row only — server-scoped, the
  // client never parses an org filter itself)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/orgs`, { headers: authHeaders() });
        const body = (await res.json()) as { orgs?: OrgSummary[]; error?: string };
        if (!res.ok) throw new Error(body.error || "加载组织失败");
        if (!alive) return;
        setOrgs(body.orgs ?? []);
        if (body.orgs?.length) setOrgId((cur) => cur || body.orgs![0].id);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ groupBy, limit: String(PAGE_SIZE), offset: String(offset) });
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const res = await fetch(`${API_BASE}/admin/orgs/${orgId}/token-usage?${qs}`, { headers: authHeaders() });
      const body = (await res.json()) as { usage?: UsageResult; budget?: BudgetView; error?: string };
      if (!res.ok || !body.usage || !body.budget) throw new Error(body.error || "加载用量失败");
      setData({ usage: body.usage, budget: body.budget });
    } catch (e) {
      setError((e as Error).message);
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orgId, groupBy, from, to, offset]);

  useEffect(() => { load(); }, [load]);
  // Reset pagination whenever the filter dimension changes (not on page turns).
  useEffect(() => { setOffset(0); }, [orgId, groupBy, from, to]);

  const budget = data?.budget;
  const usage = data?.usage;
  const hasPrev = (usage?.offset ?? 0) > 0;
  const hasNext = usage ? usage.offset + usage.items.length < usage.groups : false;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Token 用量"
        description="组织级 Token 消耗（输入 / 输出 / 缓存读写）。无价格与账单——预算为月度 Token 上限。"
        actions={<RefreshButton onClick={load} loading={loading || !orgId} />}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 bg-white border border-line-subtle rounded-lg p-4">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          组织
          <select
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            className="border border-line-subtle rounded px-2 py-1.5 text-sm min-w-[10rem] bg-white"
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}（{o.id}）</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          开始日期
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="border border-line-subtle rounded px-2 py-1.5 text-sm bg-white" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          结束日期
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="border border-line-subtle rounded px-2 py-1.5 text-sm bg-white" />
        </label>
        <div className="flex gap-1 rounded-lg border border-line-subtle overflow-hidden">
          {(Object.keys(GROUP_LABELS) as UsageResult["groupBy"][]).map((g) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={`px-3 py-1.5 text-sm transition-colors ${
                groupBy === g ? "bg-brand text-white" : "bg-white text-ink-secondary hover:bg-gray-50"
              }`}
            >
              {GROUP_LABELS[g]}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorState title={error} onRetry={load} />}

      {/* Budget card — current UTC month, independent of the page date range */}
      {budget && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white border border-line-subtle rounded-lg p-4">
            <div className="text-xs text-ink-secondary">月度预算</div>
            <div className="text-xl font-semibold mt-1">{fmt(budget.limit)}</div>
            <div className="text-xs text-gray-400 mt-1">自 {budget.monthStart.slice(0, 10)}（UTC）</div>
          </div>
          <div className="bg-white border border-line-subtle rounded-lg p-4">
            <div className="text-xs text-ink-secondary">本月已用</div>
            <div className="text-xl font-semibold mt-1">{fmt(budget.used)}</div>
            <div className="text-xs text-gray-400 mt-1">{budget.thresholdPct}% 起预警</div>
          </div>
          <div className="bg-white border border-line-subtle rounded-lg p-4">
            <div className="text-xs text-ink-secondary">剩余</div>
            <div className="text-xl font-semibold mt-1">{fmt(budget.remaining)}</div>
            <div className="text-xs text-gray-400 mt-1">
              {budget.limit > 0 ? Math.min(100, Math.round((budget.used / budget.limit) * 100)) : 100}% 已用
            </div>
          </div>
          <div className={`border rounded-lg p-4 ${STATUS_STYLE[budget.status].cls}`}>
            <div className="text-xs opacity-80">预算状态</div>
            <div className="text-xl font-semibold mt-1">{STATUS_STYLE[budget.status].label}</div>
            <div className="text-xs opacity-70 mt-1">
              输入 {fmt(budget.usage.inputTokens)} · 输出 {fmt(budget.usage.outputTokens)} · 缓存写 {fmt(budget.usage.cacheCreationTokens)} · 缓存读 {fmt(budget.usage.cacheReadTokens)}
            </div>
          </div>
        </div>
      )}

      {/* Aggregation table */}
      {usage && (
        <div className="bg-white border border-line-subtle rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-xs text-ink-secondary">
                <th className="px-4 py-2.5 font-medium">{GROUP_LABELS[usage.groupBy]}</th>
                <th className="px-4 py-2.5 font-medium text-right">输入</th>
                <th className="px-4 py-2.5 font-medium text-right">输出</th>
                <th className="px-4 py-2.5 font-medium text-right">缓存写</th>
                <th className="px-4 py-2.5 font-medium text-right">缓存读</th>
                <th className="px-4 py-2.5 font-medium text-right">总量</th>
                <th className="px-4 py-2.5 font-medium text-right">turns</th>
              </tr>
            </thead>
            <tbody>
              {usage.items.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-ink-secondary text-sm">该条件下暂无 Token 用量</td></tr>
              )}
              {usage.items.map((it) => (
                <tr key={it.key} className="border-t border-gray-100">
                  <td className="px-4 py-2.5 font-medium text-ink-primary">{it.label}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(it.inputTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(it.outputTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(it.cacheCreationTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(it.cacheReadTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmt(it.total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{fmt(it.turns)}</td>
                </tr>
              ))}
              {usage.items.length > 0 && (
                <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                  <td className="px-4 py-2.5">合计（筛选范围，共 {fmt(usage.groups)} 组）</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(usage.totals.inputTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(usage.totals.outputTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(usage.totals.cacheCreationTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(usage.totals.cacheReadTokens)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(usage.totals.total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt(usage.totals.turns)}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-100 text-xs text-ink-secondary">
            <span>
              第 {usage.offset + 1}–{usage.offset + usage.items.length} 组 / 共 {fmt(usage.groups)} 组
            </span>
            <span className="flex gap-2">
              <button
                onClick={() => setOffset(Math.max(0, usage.offset - PAGE_SIZE))}
                disabled={!hasPrev}
                className="px-2.5 py-1 border border-line-subtle rounded bg-white disabled:opacity-40 hover:bg-gray-50"
              >
                上一页
              </button>
              <button
                onClick={() => setOffset(usage.offset + PAGE_SIZE)}
                disabled={!hasNext}
                className="px-2.5 py-1 border border-line-subtle rounded bg-white disabled:opacity-40 hover:bg-gray-50"
              >
                下一页
              </button>
            </span>
          </div>
        </div>
      )}

      <InfoNote title="口径说明">
        数据来自 Agent 运行的 result 事件（按 chats.org_id 归属组织）。预算为月度 Token 上限，只告警不硬停；
        表格按筛选的日期范围聚合，与月度预算卡窗口相互独立。本页不展示价格或账单。
      </InfoNote>
    </div>
  );
}
