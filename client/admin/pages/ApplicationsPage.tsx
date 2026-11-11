import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  ApplicationsManager,
  authHeaders,
  type ApplicationView,
  type AppCapabilityView,
  type CapabilityResourceView,
  type ProfileView,
} from "../../components/AdminPanel";
import { ErrorState } from "../components/ui";

const API_BASE = "/api";

export function ApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationView[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityResourceView[]>([]);
  const [appCaps, setAppCaps] = useState<AppCapabilityView[]>([]);
  const [editingApp, setEditingApp] = useState<string | null>(null);
  const [newAppKey, setNewAppKey] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetchApplications = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(`${API_BASE}/admin/applications`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setApplications(Array.isArray(data) ? data : []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
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

  const fetchCapabilities = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/capabilities`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setCapabilities(data.resources ?? []);
      }
    } catch {}
  }, []);

  const fetchAppCaps = useCallback(async (appId: string) => {
    try {
      const res = await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(appId)}/capabilities`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAppCaps(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchApplications(); fetchCapabilities(); fetchProfiles(); }, [fetchApplications, fetchCapabilities, fetchProfiles]);

  const handleCreateApp = async (name: string, description?: string): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    toast.success("应用已创建");
    await fetchApplications();
  };

  const handleUpdateApp = async (id: string, patch: Partial<ApplicationView>): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    toast.success("应用已更新");
    await fetchApplications();
  };

  const handleDeleteApp = async (id: string): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    toast.success("应用已删除");
    await fetchApplications();
  };

  const handleGenAppKey = async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}/key`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      setNewAppKey(data.key ?? null);
      toast.success("App Key 已生成（请立即复制）");
      await fetchApplications();
    }
  };

  const handleSaveAppCaps = async (appId: string, resources: Array<{ resourceId: string; enabled: boolean }>): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(appId)}/capabilities`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ resources }),
    });
    toast.success("能力 allowlist 已保存");
    await fetchAppCaps(appId);
  };

  if (loading) {
    return <div className="text-sm text-ink-muted py-4 text-center">加载中…</div>;
  }
  if (loadError) {
    return <ErrorState title="应用列表加载失败" hint="请检查后端服务后重试" onRetry={fetchApplications} />;
  }

  return (
    <ApplicationsManager
      applications={applications}
      capabilities={capabilities}
      appCaps={appCaps}
      editingApp={editingApp}
      newAppKey={newAppKey}
      profiles={profiles}
      onRefresh={fetchApplications}
      onCreate={handleCreateApp}
      onUpdate={handleUpdateApp}
      onDelete={handleDeleteApp}
      onGenKey={handleGenAppKey}
      onEditCaps={(appId) => { setEditingApp(appId); setNewAppKey(null); fetchAppCaps(appId); }}
      onSaveCaps={handleSaveAppCaps}
      onCloseCaps={() => setEditingApp(null)}
      onDismissKey={() => setNewAppKey(null)}
    />
  );
}
