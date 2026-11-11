import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  PromptSettingsForm,
  authHeaders,
  type PromptSettings,
} from "../../components/AdminPanel";
import { AdminPageHeader } from "../components/ui";

const API_BASE = "/api";

export function PromptSettingsPage() {
  const [settings, setSettings] = useState<PromptSettings | null>(null);

  const fetchPromptSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/prompt-settings`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings ?? null);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchPromptSettings(); }, [fetchPromptSettings]);

  const handleSave = async (patch: Partial<PromptSettings>): Promise<PromptSettings | null> => {
    const res = await fetch(`${API_BASE}/admin/prompt-settings`, {
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
    toast.success("Prompt settings 已保存");
    return data.settings ?? null;
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="平台 Prompt"
        description={
          <span className="inline">
            维护平台默认系统提示词和追加上下文。变更只影响新启动的 Runtime。
            <span className="ml-2 text-xs text-gray-400">
              存储：<code className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">data/prompt-settings.json</code>
            </span>
          </span>
        }
      />
      <PromptSettingsForm settings={settings} onSave={handleSave} />
    </div>
  );
}
