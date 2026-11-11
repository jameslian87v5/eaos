import { useCallback, useEffect, useState } from "react";

// M4 (model-and-token-management-plan.md §4.2): Chat 顶部的上下文状态条。
// 只读展示：上下文估算（最近一次 result 的输入侧 tokens）vs Auto Compact
// 阈值、累计 input/output/cache、最近一次 compact。数据来自
// GET /api/chats/:id/context（服务端按 owner/org 校验），无任何写操作 —
// 本组件永远不触发压缩，只显示状态。

const API_BASE = "/api";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ContextView {
  chatId: string;
  context: {
    estimateTokens: number | null;
    autoCompact: {
      enabled: boolean;
      thresholdTokens: number;
      keepRecentTurns: number;
      source: "org" | "platform";
    };
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    total: number;
    turns: number;
  };
  lastCompact: {
    at: string;
    preTokens: number | null;
    postTokens: number | null;
    trigger: string | null;
  } | null;
}

const fmtK = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function ChatContextChip({ chatId, refreshKey }: { chatId: string; refreshKey?: number }) {
  const [view, setView] = useState<ContextView | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/context`, { headers: authHeaders() });
      if (!res.ok) return; // 无权限/未找到 — 静默不渲染
      setView((await res.json()) as ContextView);
    } catch {
      /* 离线 — 静默 */
    }
  }, [chatId]);

  useEffect(() => {
    setView(null);
    load();
  }, [load]);

  // 每完成一轮对话（messages 数变化）刷新估算值。
  useEffect(() => {
    if (refreshKey != null && refreshKey > 0) load();
  }, [refreshKey, load]);

  if (!view) return null;

  const { estimateTokens, autoCompact } = view.context;
  const pct =
    estimateTokens != null && autoCompact.thresholdTokens > 0
      ? Math.min(100, Math.round((estimateTokens / autoCompact.thresholdTokens) * 100))
      : 0;
  const tone = !autoCompact.enabled
    ? "bg-gray-100 text-gray-500"
    : pct >= 100
      ? "bg-red-50 text-red-600 border border-red-200"
      : pct >= 80
        ? "bg-amber-50 text-amber-700 border border-amber-200"
        : "bg-gray-100 text-gray-600";

  const compactInfo = view.lastCompact
    ? `最近 compact：${view.lastCompact.at.replace("T", " ").slice(0, 16)}（触发：${view.lastCompact.trigger ?? "manual"}${
        view.lastCompact.preTokens != null
          ? `，${view.lastCompact.preTokens.toLocaleString()} → ${view.lastCompact.postTokens != null ? view.lastCompact.postTokens.toLocaleString() : "?"} tokens`
          : ""
      }）`
    : "尚未 compact 过";

  const u = view.usage;
  const tooltip = [
    `累计（${u.turns} turns）：输入 ${u.inputTokens.toLocaleString()} · 输出 ${u.outputTokens.toLocaleString()} · 缓存写 ${u.cacheCreationTokens.toLocaleString()} · 缓存读 ${u.cacheReadTokens.toLocaleString()}`,
    compactInfo,
    autoCompact.enabled
      ? `Auto Compact 开启（${autoCompact.source === "org" ? "组织" : "平台"}策略：阈值 ${autoCompact.thresholdTokens.toLocaleString()} tokens，保留最近 ${autoCompact.keepRecentTurns} 轮）`
      : "Auto Compact 关闭",
    "估算口径：最近一次回复的输入侧 tokens（输入 + 缓存读写），非精确上下文窗口。",
  ].join("\n");

  return (
    <div className="flex items-center gap-1.5" title={tooltip}>
      <span className="text-xs text-gray-500">上下文</span>
      <span className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${tone}`}>
        {estimateTokens != null ? `${fmtK(estimateTokens)}/${fmtK(autoCompact.thresholdTokens)}` : "—"}
        {autoCompact.enabled ? ` · ${pct}%` : " · 自动压缩关"}
      </span>
    </div>
  );
}
