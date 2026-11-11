/**
 * ExpertDirectoryPage.tsx — Octop absorption M7a: the user workbench "我的专家"
 * directory (route /experts).
 *
 * Lists ONLY the caller's own agents (GET /api/agents is owner-filtered
 * server-side — the client list is never the authority). Cards show the live
 * title, source template (read-only provenance), capability count and last
 * activity. Actions: enter the agent's conversation, edit (ExpertEditDrawer),
 * delete (confirm + DELETE /api/agents/:id). Creation reuses the M6a
 * AgentBuilderDrawer.
 *
 * UX conventions follow M6a/M6b: Tailwind tokens, skeleton loading, error
 * banner, narrow-screen friendly (no fixed multi-column assumptions).
 */
import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Pencil, Trash2, MessageSquare, Sparkles, AlertCircle } from "lucide-react";
import { AgentBuilderDrawer } from "./AgentBuilderDrawer";
import { ExpertEditDrawer } from "./ExpertEditDrawer";
import { templateDisplayName, type ExpertRow, type CapabilityOption } from "./expert-directory";

const API_BASE = "/api";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ExpertDirectoryPageProps {
  agents: ExpertRow[];
  loading: boolean;
  loadError: string | null;
  onEnterChat: (agentId: string) => void;
  onRefresh: () => void;
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
      : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  } catch {
    return "—";
  }
}

export function ExpertDirectoryPage({
  agents,
  loading,
  loadError,
  onEnterChat,
  onRefresh,
  onBack,
}: ExpertDirectoryPageProps) {
  const [editingAgent, setEditingAgent] = useState<ExpertRow | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  // Capability counts per agent (read-only GET; the badge is display-only).
  const [capCounts, setCapCounts] = useState<Record<string, number>>({});
  const [options, setOptions] = useState<CapabilityOption[]>([]);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/agent-builder/options`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setOptions(Array.isArray(data.capabilities) ? data.capabilities : []);
          setTemplates(Array.isArray(data.templates) ? data.templates : []);
        }
      } catch {
        /* options are only needed for the drawer; drawer refetches anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load capability counts (own agents only; read-only views).
  useEffect(() => {
    if (loading || agents.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        agents.map(async (a) => {
          try {
            const res = await fetch(`${API_BASE}/agents/${a.id}/capabilities`, { headers: authHeaders() });
            if (!res.ok) return [a.id, 0] as const;
            const data = await res.json();
            const enabled = Array.isArray(data.capabilities)
              ? (data.capabilities as Array<{ enabled: boolean }>).filter((c) => c.enabled).length
              : 0;
            return [a.id, enabled] as const;
          } catch {
            return [a.id, 0] as const;
          }
        })
      );
      if (!cancelled) setCapCounts(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [agents, loading]);

  const confirmDelete = async (agent: ExpertRow) => {
    if (deleting) return;
    // Client-side confirm (the server 404/ownership check is the real gate).
    if (!window.confirm(`确定删除「${agent.title}」？对应的会话与能力配置将一并删除，不可恢复。`)) return;
    setDeleteError(null);
    setDeleting(agent.id);
    try {
      const res = await fetch(`${API_BASE}/agents/${agent.id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) {
        setDeleteError(`删除失败（${res.status}）`);
        return;
      }
      onRefresh();
    } catch {
      setDeleteError("网络错误，请重试");
    } finally {
      setDeleting(null);
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
              <Sparkles className="w-4 h-4 text-brand" /> 我的专家
            </h1>
            <p className="text-xs text-ink-secondary mt-0.5">
              你创建的专家都在这里；编辑保存后仅对新会话生效。
            </p>
          </div>
        </div>
        <button
          onClick={() => setBuilderOpen(true)}
          className="px-4 h-9 text-sm bg-brand hover:bg-brand-hover text-white rounded-md flex items-center gap-1.5 shrink-0"
        >
          <Plus className="w-4 h-4" /> 新建专家
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        {loadError && (
          <div className="mb-4 px-4 py-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" /> {loadError}
          </div>
        )}
        {deleteError && (
          <div className="mb-4 px-4 py-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" /> {deleteError}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="experts-skeleton">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 rounded-lg border border-gray-200 bg-white animate-pulse" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <div className="py-16 text-center" data-testid="experts-empty">
            <Sparkles className="w-8 h-8 text-gray-300 mx-auto" />
            <p className="mt-3 text-sm text-ink-secondary">还没有专家，点击右上角「新建专家」创建第一个。</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="experts-grid">
            {agents.map((a) => (
              <div
                key={a.id}
                data-testid={`expert-card-${a.id}`}
                className="p-4 rounded-lg border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition-all flex flex-col"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-sm text-ink-primary truncate" title={a.title}>
                    {a.title}
                  </p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">
                    {templateDisplayName(a.templateId, templates)}
                  </span>
                </div>
                {a.description && (
                  <p className="mt-1.5 text-xs text-ink-secondary line-clamp-2">{a.description}</p>
                )}
                <div className="mt-3 flex items-center gap-3 text-[11px] text-gray-400">
                  <span title="已启用能力数">能力 {capCounts[a.id] ?? "…"}</span>
                  {(a.quickPrompts?.length ?? 0) > 0 && <span>快捷任务 {a.quickPrompts!.length}</span>}
                  <span className="ml-auto">{formatTime(a.updatedAt)}</span>
                </div>
                <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-1.5">
                  <button
                    onClick={() => onEnterChat(a.id)}
                    className="flex-1 px-2 h-8 text-xs border border-gray-200 rounded-md text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-1"
                  >
                    <MessageSquare className="w-3.5 h-3.5" /> 进入会话
                  </button>
                  <button
                    onClick={() => setEditingAgent(a)}
                    className="px-2.5 h-8 text-xs border border-gray-200 rounded-md text-gray-700 hover:bg-gray-50 flex items-center gap-1"
                    aria-label={`编辑 ${a.title}`}
                  >
                    <Pencil className="w-3.5 h-3.5" /> 编辑
                  </button>
                  <button
                    onClick={() => confirmDelete(a)}
                    disabled={deleting === a.id}
                    className="px-2.5 h-8 text-xs border border-red-200 rounded-md text-red-600 hover:bg-red-50 disabled:opacity-50 flex items-center gap-1"
                    aria-label={`删除 ${a.title}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {deleting === a.id ? "删除中" : "删除"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ExpertEditDrawer
        open={!!editingAgent}
        agent={editingAgent}
        capabilityOptions={options}
        onClose={() => setEditingAgent(null)}
        onSaved={() => {
          setEditingAgent(null);
          onRefresh();
        }}
      />
      <AgentBuilderDrawer
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onCreated={() => {
          setBuilderOpen(false);
          onRefresh();
        }}
      />
    </div>
  );
}
