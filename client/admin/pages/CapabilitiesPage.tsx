import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  CapabilityTable,
  EntitlementEditor,
  authHeaders,
  type CapabilityResourceView,
  type EntitlementEntry,
} from "../../components/AdminPanel";
import { AdminPageHeader, ErrorState, InfoNote, RefreshButton } from "../components/ui";

const API_BASE = "/api";

export function CapabilitiesPage() {
  const [capabilities, setCapabilities] = useState<CapabilityResourceView[]>([]);
  const [entitlements, setEntitlements] = useState<EntitlementEntry[]>([]);
  const [editingResource, setEditingResource] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const fetchCapabilities = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch(`${API_BASE}/admin/capabilities`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCapabilities(data.resources ?? []);
    } catch {
      setLoadError(true);
    }
  }, []);

  const fetchEntitlements = useCallback(async (resourceId: string): Promise<boolean> => {
    setEntitlements([]);
    try {
      const res = await fetch(`${API_BASE}/admin/capabilities/${encodeURIComponent(resourceId)}/entitlements`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setEntitlements(data.entries ?? []);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => { fetchCapabilities(); }, [fetchCapabilities]);

  const handleEditCapability = async (resourceId: string) => {
    if (editingResource === resourceId) { setEditingResource(null); return; }
    const ok = await fetchEntitlements(resourceId);
    if (!ok) return;
    setEditingResource(resourceId);
  };

  const handleSaveEntitlements = async (
    resourceId: string,
    entries: Array<{ scopeType: "org" | "user"; scopeId: string; effect: "allow" | "deny" }>
  ): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/capabilities/${encodeURIComponent(resourceId)}/entitlements`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!res.ok) {
      toast.error(`Entitlement 保存失败 (HTTP ${res.status})`);
      return;
    }
    toast.success("Entitlement 已保存");
    await fetchEntitlements(resourceId);
  };

  return (
    <div>
      <AdminPageHeader
        title="能力资源"
        description={`共 ${capabilities.length} 个能力资源，${capabilities.filter((c) => c.status === "active").length} 个 active（资源池 = skills.json + mcp.json + hook-plugins.json）`}
        actions={<RefreshButton onClick={fetchCapabilities} />}
      />
      <InfoNote title="能力管理：资源池 → 授权 → 激活">
        <div><strong>资源池</strong>：全局安装的 skill / MCP / hook-plugin（在 Plugin / MCP 页或 <code>data/*.json</code> 维护）。</div>
        <div><strong>Entitlement（本页）</strong>：谁能用 —— 按 <code>org</code> / <code>user</code> 授权 allow/deny。</div>
        <div><strong>激活</strong>：单个 Agent 是否启用（在 Agents 页）。最终生效 = 资源池 ∩ entitlement ∩ 激活。</div>
        <div className="mt-1 text-ink-muted">给某个 org 开放能力：点该资源 → 添加 <code>org</code> + orgId + allow。</div>
      </InfoNote>
      {loadError ? (
        <ErrorState title="能力资源加载失败" hint="请检查后端服务后重试" onRetry={fetchCapabilities} />
      ) : (
        <>
          <CapabilityTable resources={capabilities} editingResource={editingResource} onEdit={handleEditCapability} />
          {editingResource && (
            <EntitlementEditor
              key={editingResource}
              resourceId={editingResource}
              entries={entitlements}
              onSave={(entries) => handleSaveEntitlements(editingResource, entries)}
              onCancel={() => setEditingResource(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
