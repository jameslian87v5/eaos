import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Server,
  Puzzle,
  Package,
  Bot,
  DollarSign,
  Clock,
  Repeat,
  Coins,
} from "lucide-react";
import { authHeaders } from "../../components/AdminPanel";
import { summarizeTokenBudgets } from "../token-budget-summary";

const API_BASE = "/api";

// R1: role from server-issued user blob. org_admin omits admin-only runtime +
// usage requests (GET /api/admin/containers, GET /api/admin/usage) and the
// /admin/sessions link (Sessions is admin-only). Keeps own-org Skills /
// Applications / Agents stats.
function currentRole(): string {
  try { return (JSON.parse(localStorage.getItem("user") || "{}")).role ?? "user"; }
  catch { return "user"; }
}

interface UsageSummary {
  totalCost: number;
  totalDuration: number;
  totalTurns: number;
  items: Array<{ label: string; cost: number; duration: number; turns: number }>;
}

export function OverviewPage() {
  const role = currentRole();
  const isAdmin = role === "admin";
  const canViewTokenBudget = isAdmin || role === "org_admin";
  const [runtimes, setRuntimes] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [apps, setApps] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [tokenBudget, setTokenBudget] = useState<ReturnType<typeof summarizeTokenBudgets> | null>(null);

  const fetchAll = useCallback(async () => {
    const headers = authHeaders();
    try {
      // R1: /api/admin/containers is admin-only; org_admin must not call it.
      const fetches: Promise<any>[] = [
        fetch(`${API_BASE}/admin/skills`, { headers }).then(r => r.json()).catch(() => ({ skills: [] })),
        fetch(`${API_BASE}/admin/applications`, { headers }).then(r => r.json()).catch(() => []),
        fetch(`${API_BASE}/admin/agents`, { headers }).then(r => r.json()).catch(() => ({ agents: [] })),
      ];
      if (isAdmin) {
        fetches.unshift(
          fetch(`${API_BASE}/admin/containers`, { headers }).then(r => r.json()).catch(() => ({ runtimes: [] }))
        );
      }
      const result = await Promise.all(fetches);
      let idx = 0;
      if (isAdmin) {
        setRuntimes(result[idx].runtimes ?? []);
        idx++;
      }
      setSkills(result[idx].skills ?? []); idx++;
      setApps(Array.isArray(result[idx]) ? result[idx] : []); idx++;
      setAgents(result[idx].agents ?? []);
    } catch {}
  }, [isAdmin]);

  // R1: /api/admin/usage is admin-only; org_admin must not call it.
  const fetchUsage = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`${API_BASE}/admin/usage?groupBy=day`, { headers: authHeaders() });
      if (res.ok) setUsage(await res.json());
    } catch {}
  }, [isAdmin]);

  const fetchTokenBudget = useCallback(async () => {
    if (!canViewTokenBudget) return;
    try {
      const headers = authHeaders();
      const orgsRes = await fetch(`${API_BASE}/admin/orgs`, { headers });
      if (!orgsRes.ok) return;
      const { orgs = [] } = await orgsRes.json();
      const quotas = await Promise.all(
        orgs.map(async (org: { id: string }) => {
          const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(org.id)}/quota`, { headers });
          if (!res.ok) return null;
          return (await res.json()).quota;
        })
      );
      setTokenBudget(summarizeTokenBudgets(quotas.filter(Boolean)));
    } catch {}
  }, [canViewTokenBudget]);

  useEffect(() => { fetchAll(); fetchUsage(); fetchTokenBudget(); }, [fetchAll, fetchUsage, fetchTokenBudget]);

  // R1: drop the "活跃 Runtime" → /admin/sessions card for org_admin (Sessions
  // is admin-only). Keep own-org Skills / Applications / Agents.
  const stats = isAdmin
    ? [
        { label: "活跃 Runtime", value: runtimes.length, icon: Server, to: "/admin/sessions", color: "text-blue-600" },
        { label: "Skills 启用", value: skills.filter(s => s.enabled).length, icon: Puzzle, to: "/admin/skills", color: "text-green-600" },
        { label: "应用总数", value: apps.length, icon: Package, to: "/admin/applications", color: "text-purple-600" },
        { label: "Agent 总数", value: agents.length, icon: Bot, to: "/admin/agents", color: "text-indigo-600" },
      ]
    : [
        { label: "Skills 启用", value: skills.filter(s => s.enabled).length, icon: Puzzle, to: "/admin/skills", color: "text-green-600" },
        { label: "应用总数", value: apps.length, icon: Package, to: "/admin/applications", color: "text-purple-600" },
        { label: "Agent 总数", value: agents.length, icon: Bot, to: "/admin/agents", color: "text-indigo-600" },
      ];

  const usageCards = [
    { label: "总消耗 (USD)", value: usage && usage.totalCost != null ? `$${usage.totalCost.toFixed(4)}` : "—", icon: DollarSign },
    { label: "总时长", value: usage && usage.totalDuration != null ? `${(usage.totalDuration / 1000).toFixed(1)}s` : "—", icon: Clock },
    { label: "总轮次", value: usage?.totalTurns ?? "—", icon: Repeat },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-gray-800">Dashboard</h1>

      {/* Quick stats */}
      <div className={`grid ${isAdmin ? "grid-cols-4" : "grid-cols-3"} gap-4`}>
        {stats.map((s) => (
          <Link
            key={s.label}
            to={s.to}
            className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
          >
            <div className="flex items-center gap-2 mb-1">
              <s.icon className={`w-4 h-4 ${s.color}`} />
              <span className="text-xs text-gray-500">{s.label}</span>
            </div>
            <div className="text-2xl font-bold text-gray-800">{s.value}</div>
          </Link>
        ))}
      </div>

      {/* R1: usage section is admin-only (GET /api/admin/usage is admin-only). */}
      {isAdmin && (
        <>
          <div className="grid grid-cols-3 gap-4">
            {usageCards.map((u) => (
              <div key={u.label} className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-1">
                  <u.icon className="w-4 h-4 text-amber-600" />
                  <span className="text-xs text-gray-500">{u.label}</span>
                </div>
                <div className="text-xl font-semibold text-gray-800">{u.value}</div>
              </div>
            ))}
          </div>

          {usage && usage.items.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-gray-700 mb-2">近期消耗明细</h2>
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500 text-left">
                    <tr>
                      <th className="px-3 py-2 font-medium">日期</th>
                      <th className="px-3 py-2 font-medium text-right">Cost (USD)</th>
                      <th className="px-3 py-2 font-medium text-right">Duration</th>
                      <th className="px-3 py-2 font-medium text-right">Turns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.items.slice(-10).map((item) => (
                      <tr key={item.label} className="border-t border-gray-100">
                        <td className="px-3 py-2 text-gray-700">{item.label}</td>
                        <td className="px-3 py-2 text-right text-gray-600">{item.cost == null ? "—" : `$${item.cost.toFixed(4)}`}</td>
                        <td className="px-3 py-2 text-right text-gray-600">{item.duration == null ? "—" : `${(item.duration / 1000).toFixed(1)}s`}</td>
                        <td className="px-3 py-2 text-right text-gray-600">{item.turns}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!usage && (
            <div className="text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded p-4">
              消耗数据加载中或暂无数据（需 Agent 产生 result 事件后才有）
            </div>
          )}
        </>
      )}

      {canViewTokenBudget && tokenBudget && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Coins className="w-4 h-4 text-amber-600" />
            <h2 className="text-sm font-medium text-gray-700">Token 预算消耗</h2>
            <span className="text-xs text-gray-400">{tokenBudget.organizations} 个组织</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            {[
              ["本月预算", tokenBudget.budget],
              ["本月已消耗", tokenBudget.consumed],
              ["剩余预算", tokenBudget.remaining],
            ].map(([label, value]) => (
              <div key={label} className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="text-xs text-gray-500 mb-1">{label}</div>
                <div className="text-xl font-semibold text-gray-800">{Number(value).toLocaleString()}</div>
                <div className="text-xs text-gray-400 mt-1">Token</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-gray-500 mt-2">
            临近预算 {tokenBudget.near} 个组织 · 超预算 {tokenBudget.over} 个组织
          </div>
        </section>
      )}
    </div>
  );
}
