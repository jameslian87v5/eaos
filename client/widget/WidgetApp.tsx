/**
 * Platform Widget SDK v0.1 — React widget UI.
 *
 * Served as the iframe body at GET /embed/apps/:appId/widget?widgetToken=...
 * Reads the widgetToken from the URL (set by the thin SDK), decodes the
 * agentId / pageSessionId claims, and drives useWidgetSocket. Reuses the main
 * app's A2UIBlockCard, ApprovalPanel, a2ui-parser and react-markdown rendering
 * instead of hand-rolling them (the v0 vanilla iframe's debt).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { A2UIBlockCard } from "../components/A2UIBlockCard";
import { CardErrorBoundary } from "../components/CardErrorBoundary";
import { ApprovalPanel } from "../components/ApprovalPanel";
import { useWidgetSocket } from "./useWidgetSocket";

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeClaims(token: string): Record<string, any> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(b64urlDecode(part));
  } catch {
    return null;
  }
}

function readAppIdFromPath(): string | null {
  const m = window.location.pathname.match(/\/embed\/apps\/([^/]+)\/widget/);
  return m ? decodeURIComponent(m[1]) : null;
}

const STATUS_LABEL: Record<string, string> = {
  connecting: "连接中…",
  connected: "已连接",
  reconnecting: "重连中…",
  "auth-error": "认证失败",
  disconnected: "已断开",
};

export default function WidgetApp() {
  const bootError = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("widgetToken");
    if (!token) return "Missing widgetToken.";
    const claims = decodeClaims(token);
    const agentId = claims && claims.agentId;
    if (!agentId) return "Invalid widget token (no agent binding).";
    return null;
  }, []);

  if (bootError) return <FatalCard message={bootError} />;
  return <WidgetBoot />;
}

function WidgetBoot() {
  const { appId, agentId, pageSessionId, token, parentOrigin } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("widgetToken") || "";
    const claims = decodeClaims(token) || {};
    const poHash = window.location.hash.replace(/^#po=/, "");
    return {
      appId: readAppIdFromPath() || "",
      agentId: claims.agentId as string,
      pageSessionId: (claims.pageSessionId as string) || `ps_${Math.random().toString(36).slice(2)}`,
      token,
      parentOrigin: poHash ? decodeURIComponent(poHash) : null,
    };
  }, []);

  const { state, send, stop, respondApproval, submitA2UI } = useWidgetSocket({
    appId,
    agentId,
    pageSessionId,
    token,
    parentOrigin,
  });

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items.length, state.approvals.length, state.busy]);

  if (state.fatalError) return <FatalCard message={state.fatalError} auth />;

  const onSubmit = () => {
    const text = input.trim();
    if (!text || state.busy) return;
    send(text);
    setInput("");
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 text-gray-900 text-sm">
      <header className="flex items-center justify-between px-3 py-2 bg-indigo-600 text-white">
        <span className="font-semibold">Agent</span>
        <span className="text-xs opacity-90">{STATUS_LABEL[state.status] || state.status}</span>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {state.items.length === 0 && !state.busy && (
          <div className="text-center text-gray-400 mt-8">向 Agent 发送一条消息开始对话</div>
        )}
        {state.items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[85%] px-3 py-2 rounded-lg bg-indigo-600 text-white whitespace-pre-wrap break-words">
                  {item.text}
                </div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className="flex justify-start">
                <div className="max-w-[85%] px-3 py-2 rounded-lg bg-white border border-gray-200 prose prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                </div>
              </div>
            );
          }
          if (item.kind === "tool") {
            return <ToolRow key={item.id} item={item} />;
          }
          if (item.kind === "a2ui") {
            return (
              <CardErrorBoundary key={item.id}>
                <div className="flex justify-start">
                  <div className="max-w-[92%] w-full">
                    <A2UIBlockCard
                      blockId={item.blockId}
                      block={item.block}
                      chatId={agentId}
                      resolved={item.resolved}
                      resolutionLabel={item.historical ? "历史记录" : "已处理"}
                      onSubmit={(p) => submitA2UI(p)}
                    />
                  </div>
                </div>
              </CardErrorBoundary>
            );
          }
          // system
          return (
            <div
              key={item.id}
              className={`text-center text-xs ${item.tone === "err" ? "text-red-600" : "text-gray-400"}`}
            >
              {item.text}
            </div>
          );
        })}
        {state.busy && (
          <div className="flex items-center gap-2 text-gray-500">
            <span className="animate-pulse text-indigo-500">●</span>
            <span className="text-xs">Agent 正在处理…</span>
          </div>
        )}
      </div>

      {state.approvals.length > 0 && (
        <ApprovalPanel
          requests={state.approvals}
          onApprove={(id) => respondApproval(id, true)}
          onDeny={(id) => respondApproval(id, false)}
        />
      )}

      <footer className="flex gap-2 p-2 border-t border-gray-200 bg-white">
        <textarea
          className="flex-1 resize-none h-11 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
          placeholder="发送消息…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        {state.busy ? (
          <button
            onClick={stop}
            className="px-3 rounded bg-red-500 text-white text-sm font-semibold"
          >
            停止
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={!input.trim()}
            className="px-4 rounded bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
          >
            发送
          </button>
        )}
      </footer>
    </div>
  );
}

function ToolRow({ item }: { item: { toolName: string; input: string; status: string; output?: string } }) {
  const dot =
    item.status === "ok"
      ? "bg-green-500"
      : item.status === "error"
        ? "bg-red-500"
        : "bg-indigo-500 animate-pulse";
  const mark = item.status === "ok" ? "✓" : item.status === "error" ? "✗" : null;
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] px-2 py-1 rounded bg-gray-100 border border-gray-200 text-xs text-gray-600 flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
        <span className="font-mono font-medium text-gray-700">{item.toolName}</span>
        {item.input && <span className="truncate max-w-[220px]">{item.input}</span>}
        {mark && <span className="font-mono">{mark}</span>}
        {item.output && item.status === "error" && (
          <span className="truncate max-w-[200px] text-red-500">{item.output}</span>
        )}
      </div>
    </div>
  );
}

function FatalCard({ message, auth }: { message: string; auth?: boolean }) {
  return (
    <div className="flex items-center justify-center h-screen p-6 bg-gray-50">
      <div className="max-w-sm text-center">
        <div className="text-red-600 font-semibold mb-1">{auth ? "认证失败" : "无法启动 Widget"}</div>
        <div className="text-gray-600 text-sm">{message}</div>
        <div className="text-gray-400 text-xs mt-2">请刷新页面以重新获取 widget token。</div>
      </div>
    </div>
  );
}
