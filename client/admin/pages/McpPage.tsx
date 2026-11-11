import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  McpTable,
  authHeaders,
  type McpView,
} from "../../components/AdminPanel";
import { AdminPageHeader, EmptyState, ErrorState, InfoNote, RefreshButton } from "../components/ui";

const API_BASE = "/api";

// R1: org_admin sees MCP read-only (global toggle is admin-only); admin gets
// the toggle. Server guard (isAdminReq) is the source of truth — UI only hides.
function currentRole(): string {
  try { return (JSON.parse(localStorage.getItem("user") || "{}")).role ?? "user"; }
  catch { return "user"; }
}

export function McpPage() {
  const [mcpServers, setMcpServers] = useState<McpView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const isAdmin = currentRole() === "admin";

  const fetchMcpServers = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(`${API_BASE}/admin/mcp`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMcpServers(data.mcpServers ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMcpServers(); }, [fetchMcpServers]);

  const handleToggle = async (name: string, enabled: boolean): Promise<void> => {
    const action = enabled ? "enable" : "disable";
    const res = await fetch(`${API_BASE}/admin/mcp/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      toast.error(`MCP ${name} 操作失败 (HTTP ${res.status})`);
    } else {
      toast.success(`MCP ${name} ${enabled ? "已启用" : "已禁用"}`);
    }
    await fetchMcpServers();
  };

  return (
    <div>
      <AdminPageHeader
        title="MCP"
        description={`共 ${mcpServers.length} 个 MCP，${mcpServers.filter((m) => m.enabled).length} 个已启用（注册表 = data/mcp.json）`}
        actions={<RefreshButton onClick={fetchMcpServers} loading={loading} />}
      />
      {!isAdmin && (
        <InfoNote title="本部门可用的 MCP（只读）">
          <div>这里列出平台已分发给本部门的 MCP server。全局启停由企业管理员操作；如需为本部门启用/撤销，到 <strong>能力资源</strong> 页编辑 entitlement。</div>
        </InfoNote>
      )}
      {loading ? (
        <div className="text-sm text-ink-muted py-4 text-center">加载中…</div>
      ) : loadError ? (
        <ErrorState title="MCP 列表加载失败" hint="请检查后端服务后重试" onRetry={fetchMcpServers} />
      ) : mcpServers.length === 0 ? (
        <EmptyState icon="🔌" title="暂无 MCP server" hint="在 data/mcp.json 注册后出现；之后到「能力资源」页授权 org/user 使用" />
      ) : (
        <McpTable mcpServers={mcpServers} onToggle={isAdmin ? handleToggle : undefined} />
      )}
    </div>
  );
}
