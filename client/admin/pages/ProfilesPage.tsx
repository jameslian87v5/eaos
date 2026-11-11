import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  ProfileManager,
  authHeaders,
  type ProfileView,
  type ProfileInput,
} from "../../components/AdminPanel";
import { AdminPageHeader, RefreshButton } from "../components/ui";

const API_BASE = "/api";

export function ProfilesPage() {
  const [profiles, setProfiles] = useState<ProfileView[]>([]);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/agent-profiles`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles ?? []);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const profileInputToBody = (v: ProfileInput) => ({
    name: v.name,
    description: v.description.trim() || null,
    systemPrompt: v.systemPrompt.trim() || null,
    appendSystemPrompt: v.appendSystemPrompt.trim() || null,
    toolsConfig: v.toolsConfig ?? null,
  });

  const handleCreateProfile = async (v: ProfileInput): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/agent-profiles`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(profileInputToBody(v)),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    toast.success("Profile 已创建");
    await fetchProfiles();
  };

  const handleUpdateProfile = async (id: string, v: ProfileInput): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/agent-profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(profileInputToBody(v)),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    toast.success("Profile 已更新");
    await fetchProfiles();
  };

  const handleDeleteProfile = async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/agent-profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast.success("Profile 已删除");
    await fetchProfiles();
  };

  return (
    <div>
      <AdminPageHeader
        title="Profile"
        description={`共 ${profiles.length} 个 profile（可复用角色模板；优先级 per-Agent 覆盖 > profile > 平台默认）`}
        actions={<RefreshButton onClick={fetchProfiles} />}
      />
      <ProfileManager
        profiles={profiles}
        onCreate={handleCreateProfile}
        onUpdate={handleUpdateProfile}
        onDelete={handleDeleteProfile}
      />
    </div>
  );
}
