import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  AgentsManager,
  DiagnosticsPanel,
  authHeaders,
  type AgentWithOverridesView,
  type ProfileView,
  type PromptSettings,
  type AgentAssignmentInput,
} from "../../components/AdminPanel";
import { AdminPageHeader, EmptyState, RefreshButton, SearchInput } from "../components/ui";

const API_BASE = "/api";

// R1: role from server-issued user blob. Diagnostics (GET
// /api/admin/agents/:agentId/diagnostics) is admin-only, so the Diagnostics
// control is hidden for org_admin. Agent assignment stays (own-org, server-guarded).
function currentRole(): string {
  try { return (JSON.parse(localStorage.getItem("user") || "{}")).role ?? "user"; }
  catch { return "user"; }
}

export function AgentsPage() {
  const isAdmin = currentRole() === "admin";
  const [agents, setAgents] = useState<AgentWithOverridesView[]>([]);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [promptSettings, setPromptSettings] = useState<PromptSettings | null>(null);
  const [diagAgentId, setDiagAgentId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/agents`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents ?? []);
      }
    } catch {}
  }, []);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/agent-profiles`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles ?? []);
      }
    } catch {}
  }, []);

  const fetchPromptSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/prompt-settings`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setPromptSettings(data.settings ?? null);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchAgents(); fetchProfiles(); fetchPromptSettings(); }, [fetchAgents, fetchProfiles, fetchPromptSettings]);

  const handleSaveAgentAssignment = async (agentId: string, vals: AgentAssignmentInput): Promise<void> => {
    const res = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(vals),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    toast.success("Agent 配置已保存");
    await fetchAgents();
  };

  const filteredAgents = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return agents.filter(a => a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
  }, [agents, search]);

  return (
    <div>
      <AdminPageHeader
        title="Agents"
        description={`共 ${agents.length} 个 Agent — 分配可复用 profile + 设置 per-Agent prompt（优先级 per-Agent 覆盖 > profile > 平台默认）`}
        actions={
          <div className="flex items-center gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder="搜索名称 / ID…" />
            <RefreshButton onClick={fetchAgents} />
          </div>
        }
      />
      {agents.length === 0 ? (
        <EmptyState icon="🤖" title="暂无 Agent" hint="用户创建对话后会自动生成 Agent" />
      ) : filteredAgents.length === 0 ? (
        <EmptyState icon="🔍" title="无匹配结果" hint="尝试调整搜索条件" />
      ) : (
        <>
          <AgentsManager
            agents={filteredAgents}
            profiles={profiles}
            maxChars={promptSettings?.maxSystemPromptChars}
            onSave={handleSaveAgentAssignment}
          />

          {isAdmin && diagAgentId && (
            <div className="mt-6 border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-700">诊断 — {diagAgentId.slice(0, 8)}…</h3>
                <button
                  onClick={() => setDiagAgentId(null)}
                  className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
                >
                  关闭
                </button>
              </div>
              <DiagnosticsPanel agentId={diagAgentId} />
            </div>
          )}

          {isAdmin && filteredAgents.length > 0 && !diagAgentId && (
            <div className="mt-4">
              <div className="text-xs text-gray-400 mb-2">点击 Agent ID 查看诊断：</div>
              <div className="flex flex-wrap gap-2">
                {filteredAgents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setDiagAgentId(a.id)}
                    className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-blue-50 hover:text-blue-600 transition-colors"
                  >
                    {a.title} ({a.id.slice(0, 8)}…)
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
