import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  RuntimeSettingsForm,
  StoragePanel,
  authHeaders,
  type RuntimeSettings,
} from "../../components/AdminPanel";

const API_BASE = "/api";

export function RuntimeSettingsPage() {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/runtime/settings`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings ?? null);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async (patch: Partial<RuntimeSettings>): Promise<RuntimeSettings | null> => {
    const res = await fetch(`${API_BASE}/admin/runtime/settings`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      toast.error("保存失败");
      return null;
    }
    const data = await res.json();
    setSettings(data.settings ?? null);
    toast.success("Runtime settings 已保存");
    return data.settings ?? null;
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 text-xs text-gray-500">
          可配置 Runtime 参数（file-backed: <code className="bg-gray-100 px-1 rounded">data/runtime-settings.json</code>）
        </div>
        <RuntimeSettingsForm settings={settings} onSave={handleSave} />
      </div>
      <div>
        <div className="mb-3 text-xs text-gray-500">Storage Policy（软限制，当前未强制）</div>
        <StoragePanel settings={settings} />
      </div>
    </div>
  );
}
