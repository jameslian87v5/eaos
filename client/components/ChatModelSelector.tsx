import React, { useCallback, useEffect, useState } from "react";

// M2 (model-and-token-management-plan.md §7-前端): Chat 顶部的模型选择器。
// 只显示「当前生效模型 + 来源」并让用户在本 org 可选列表里挑一个 —
// 服务端校验 平台启用 ∩ 组织授权，前端永远无法注入任意模型串。
// 变更不热切换：只对下一个 runtime 生效（Stop/重建），对话历史保留。

const API_BASE = "/api";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ModelSelection {
  override: string | null;
  overrideSource: "chat" | "agent" | null;
  effective: { alias: string; source: "chat" | "agent" | "org" | "platform" };
  available: string[];
  configChanged?: boolean;
}

const SOURCE_LABEL: Record<ModelSelection["effective"]["source"], string> = {
  chat: "本对话",
  agent: "Agent 默认",
  org: "组织默认",
  platform: "平台默认",
};

export function ChatModelSelector({ chatId }: { chatId: string }) {
  const [sel, setSel] = useState<ModelSelection | null>(null);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/model`, { headers: authHeaders() });
      if (!res.ok) return; // 无权限/未找到 — 选择器静默不渲染
      const data = (await res.json()) as ModelSelection;
      setSel(data);
      setHint(null);
      setError(null);
    } catch {
      /* 离线 — 保持静默 */
    }
  }, [chatId]);

  useEffect(() => {
    setSel(null);
    load();
  }, [load]);

  if (!sel) return null;

  const change = async (alias: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        // "" = 清除本对话选择，回落到 Agent/组织/平台默认（服务端收到 null）
        body: JSON.stringify({ modelAlias: alias === "" ? null : alias }),
      });
      const data = (await res.json().catch(() => ({}))) as ModelSelection & { error?: string };
      if (!res.ok) {
        setError(data.error || "更新失败");
        return;
      }
      setSel(data);
      setHint(
        data.configChanged
          ? "已保存 — Stop 当前 runtime 后对下一条消息生效（历史保留）"
          : "已保存"
      );
    } catch {
      setError("更新失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex items-center gap-1.5"
      title="当前生效模型与来源。变更仅对新 runtime 生效，不热切换。"
    >
      <span className="text-xs text-gray-500">模型</span>
      <select
        value={sel.override ?? ""}
        onChange={(e) => change(e.target.value)}
        disabled={saving || sel.available.length === 0}
        className="text-xs px-1.5 py-1 border border-gray-300 rounded bg-white max-w-[9rem] disabled:opacity-50"
      >
        <option value="">跟随默认</option>
        {sel.available.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 whitespace-nowrap">
        {sel.effective.alias} · {SOURCE_LABEL[sel.effective.source]}
      </span>
      {hint && <span className="text-xs text-amber-600">{hint}</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
