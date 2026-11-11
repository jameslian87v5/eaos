import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { A2UIBlockCard } from "./A2UIBlockCard";
import { CardErrorBoundary } from "./CardErrorBoundary";
import { ChatModelSelector } from "./ChatModelSelector";
import { ChatContextChip } from "./ChatContextChip";
import type { A2UIBlock } from "../a2ui-parser";

interface Message {
  id: string;
  role: "user" | "assistant" | "tool_use" | "system" | "approval" | "a2ui";
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  toolOutput?: string;
  toolError?: boolean;
  systemKind?: "command_result" | "compact" | "notice" | "error";
  isError?: boolean;
  approvalId?: string;
  approvalResolved?: boolean;
  approvalOutcome?: "approved" | "always" | "denied";
  blockId?: string;
  block?: A2UIBlock;
  a2uiResolved?: boolean;
  a2uiResolutionLabel?: string;
  // S3b (Appendix A.3): streaming preview block fields (in-memory only).
  streamId?: string;
  streamIndex?: number;
  streamKind?: "text" | "thinking";
  streamDone?: boolean;
  streamInterrupted?: boolean;
  estimatedTokens?: number;
}

interface RuntimeStatus {
  status: string;
  restoreMode: string | null;
  lastError: string | null;
  cleanupReason: string | null;
  isAgentBusy: boolean;
  restartCount: number;
  claudeSessionId: string | null;
  workspaceBytes: number | null;
  claudeHomeBytes: number | null;
}

interface WorkspaceFile {
  id: string;
  filename: string;
  kind: "input" | "output";
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

// MP4b: per-agent capability activation view (mirrors AgentCapabilityView server-side).
// chatId == agentId compatibility bridge. enabled = owner toggled it on; entitled =
// may configure (entitlement gate); available = resource exists + valid.
interface AgentCapabilityView {
  resourceId: string;
  type: "skill" | "mcp";
  name: string;
  version?: string;
  enabled: boolean;
  entitled: boolean;
  available: boolean;
  status: "active" | "disabled" | "deprecated" | "invalid";
  unavailableReason?: string;
}

// P0-2: distinct WS connection states so disconnect/reconnect-failure is shown
// honestly instead of always reading "连接中".
export type WsStatus = "connected" | "connecting" | "reconnecting" | "failed";

interface ChatWindowProps {
  chatId: string | null;
  messages: Message[];
  isConnected: boolean;
  wsStatus: WsStatus;
  isLoading: boolean;
  // S3b (A.5): preview-level inactivity annotation ("等待 Agent 响应…").
  streamStalled?: boolean;
  onSendMessage: (content: string) => void;
  onStop?: () => void;
  runtimeStatus?: RuntimeStatus | null;
  isAdmin?: boolean;
  isStopping?: boolean;
  slashCommands?: string[];
  onApprove?: (approvalId: string) => void;
  onAlwaysAllow?: (approvalId: string) => void;
  onDeny?: (approvalId: string, reason?: string) => void;
  onA2UISubmit?: (payload: {
    blockId: string;
    actionId: string;
    actionLabel: string;
    values: Record<string, string | number | boolean | string[]>;
  }) => void;
  fileRefreshKey?: number;
  onPreviewFile?: (fileId: string, filename: string) => void;
  // M6a: expert-builder starter (server-persisted on the Agent). Shown only in
  // the EMPTY conversation; quick prompts FILL the composer, never auto-send.
  starter?: {
    welcomeMessage?: string | null;
    quickPrompts?: Array<{ title: string; prompt: string }> | null;
  } | null;
}

// Known Claude Code slash commands with descriptions (static fallback)
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  compact:  "压缩对话历史，节省上下文",
  clear:    "清空当前上下文，重新开始",
  context:  "查看当前上下文用量",
  usage:    "查看本次会话用量",
  help:     "查看可用命令列表",
  resume:   "恢复之前的会话",
  init:     "初始化项目（生成 CLAUDE.md）",
  review:   "代码审查",
  pr:       "生成 PR 描述",
  bug:      "报告 Bug",
  memory:   "查看/管理长期记忆",
  doctor:   "检查环境健康状态",
  login:    "登录 Anthropic 账号",
  logout:   "退出登录",
  model:    "切换模型",
  vim:      "切换 Vim 模式",
  terminal: "打开终端",
  config:   "查看配置",
};

// Static known commands ensure the menu always works even before first SDK init
const STATIC_KNOWN_COMMANDS = Object.keys(COMMAND_DESCRIPTIONS);

const API_BASE = "/api";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Example prompts for empty state ─────────────────────────
const EXAMPLE_PROMPTS = [
  "总结我上传的文档，并列出关键风险",
  "检查当前项目结构，说明主要模块职责",
  "帮我生成一份面向业务的方案初稿",
];

// ─── Runtime Status Banner ───────────────────────────────────
function RuntimeStatusBanner({ status, isAdmin }: { status: RuntimeStatus; isAdmin?: boolean }) {
  const statusColors: Record<string, string> = {
    running: "text-green-700 bg-green-50 border-green-200",
    stopped: "text-gray-600 bg-gray-50 border-gray-200",
    crashed: "text-red-700 bg-red-50 border-red-200",
    starting: "text-blue-700 bg-blue-50 border-blue-200",
    paused: "text-yellow-700 bg-yellow-50 border-yellow-200",
    none: "text-gray-500 bg-gray-50 border-gray-200",
  };
  const color = statusColors[status.status] ?? "text-gray-600 bg-gray-50 border-gray-200";
  const dot: Record<string, string> = {
    running: "bg-green-500", stopped: "bg-gray-400", crashed: "bg-red-500",
    starting: "bg-blue-400 animate-pulse", paused: "bg-yellow-400",
  };

  const restoreModeLabel: Record<string, string> = {
    fresh: "新会话",
    claude_resume: "已恢复",
    from_messages: "从历史恢复",
  };

  return (
    <div className={`px-3 py-1.5 border-b text-xs flex items-center gap-2 flex-wrap ${color}`}>
      <span className={`inline-block w-2 h-2 rounded-full ${dot[status.status] ?? "bg-gray-400"}`} />
      <span className="font-medium capitalize">{status.status}</span>
      {status.restoreMode && (
        <span className="text-gray-500">· {restoreModeLabel[status.restoreMode] || status.restoreMode}</span>
      )}
      {status.restartCount > 0 && (
        <span className="text-gray-500">· 重启: {status.restartCount}</span>
      )}
      {status.isAgentBusy && (
        <span className="text-blue-600 font-medium">· 处理中…</span>
      )}
      {status.lastError && (
        <span className="text-red-600 truncate max-w-xs" title={status.lastError}>
          · ⚠ {status.lastError.slice(0, 80)}
        </span>
      )}
      {isAdmin && status.claudeSessionId && (
        <span className="text-gray-400 font-mono hidden lg:inline" title={status.claudeSessionId}>
          · sid: {status.claudeSessionId.slice(0, 8)}…
        </span>
      )}
    </div>
  );
}

// ─── Tool Use Block ──────────────────────────────────────────
function ToolUseBlock({ message }: { message: Message }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const getToolSummary = () => {
    const input = message.toolInput || {};
    switch (message.toolName) {
      case "Read":
        return input.file_path;
      case "Write":
      case "Edit":
        return input.file_path;
      case "Bash":
        return input.command?.slice(0, 80) + (input.command?.length > 80 ? "…" : "");
      case "Grep":
        return `"${input.pattern}" in ${input.path || "."}`;
      case "Glob":
        return input.pattern;
      case "WebSearch":
        return input.query;
      case "WebFetch":
        return input.url;
      default:
        return JSON.stringify(input).slice(0, 60);
    }
  };

  const hasOutput = message.toolOutput !== undefined;
  const isPending = !hasOutput;

  return (
    <div className={`my-1.5 border rounded-md text-sm ${
      message.toolError ? "border-red-300 bg-red-50/50" : "border-gray-200 bg-gray-50/50"
    }`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-gray-100/50 rounded-md"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs font-semibold ${
            message.toolError ? "text-red-600" : hasOutput ? "text-green-600" : "text-blue-600"
          }`}>
            {message.toolError ? "✗" : hasOutput ? "✓" : "⟳"}
          </span>
          <span className="text-xs font-medium text-gray-700">{message.toolName}</span>
          <span className="text-xs text-gray-500 truncate">
            {getToolSummary()}
          </span>
          {isPending && <span className="text-xs text-blue-500 animate-pulse">执行中</span>}
        </div>
        <span className="text-xs text-gray-400 ml-2 shrink-0">{isExpanded ? "▾" : "▸"}</span>
      </button>
      {isExpanded && (
        <div className="px-3 pb-2 border-t border-gray-200 space-y-2 mt-0 pt-2">
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Input</div>
            <pre className="text-xs bg-white p-2 rounded border border-gray-100 overflow-x-auto max-h-32 overflow-y-auto">
              {JSON.stringify(message.toolInput, null, 2)}
            </pre>
          </div>
          {hasOutput && (
            <div>
              <div className={`text-xs mb-0.5 ${message.toolError ? "text-red-600 font-medium" : "text-gray-400"}`}>
                {message.toolError ? "Error" : "Output"}
              </div>
              <pre className={`text-xs p-2 rounded overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono ${
                message.toolError ? "bg-red-50 text-red-800 border border-red-200" : "bg-gray-100 text-gray-800 border border-gray-200"
              }`}>
                {message.toolOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Approval Card (inline tool approval) ───────────────────
function formatToolInput(toolName: string, input: Record<string, any>): React.ReactNode {
  const name = toolName.toLowerCase();
  if ((name === "bash" || name === "computer") && input.command) {
    return (
      <pre className="text-xs font-mono bg-gray-900 text-green-300 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
        {String(input.command)}
      </pre>
    );
  }
  const filePath = input.file_path || input.path || input.filepath;
  if (filePath) {
    return (
      <div className="flex items-center gap-1.5 text-xs font-mono bg-gray-100 rounded px-2 py-1">
        <span className="text-gray-400">📄</span>
        <span className="text-gray-800 break-all">{String(filePath)}</span>
      </div>
    );
  }
  if (input.query) {
    return <span className="text-sm text-gray-700 italic">"{String(input.query)}"</span>;
  }
  const keys = Object.keys(input).slice(0, 3);
  if (keys.length === 0) return null;
  return (
    <pre className="text-xs font-mono bg-gray-100 text-gray-800 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-28 overflow-y-auto">
      {JSON.stringify(
        Object.fromEntries(keys.map((k) => [k, typeof input[k] === "string" && input[k].length > 120 ? input[k].slice(0, 120) + "…" : input[k]])),
        null, 2
      )}
    </pre>
  );
}

function ApprovalCard({
  message,
  onApprove,
  onAlwaysAllow,
  onDeny,
}: {
  message: Message;
  onApprove: (id: string) => void;
  onAlwaysAllow: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const id = message.approvalId!;
  if (message.approvalResolved) {
    const icons = { approved: "✓", always: "⚡", denied: "✕" };
    const labels = { approved: "已允许本次", always: "已设为始终允许", denied: "已拒绝" };
    const colors = { approved: "text-green-700 bg-green-50 border-green-200", always: "text-blue-700 bg-blue-50 border-blue-200", denied: "text-red-600 bg-red-50 border-red-200" };
    const outcome = message.approvalOutcome ?? "approved";
    return (
      <div className="flex justify-center my-1">
        <span className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border font-medium ${colors[outcome]}`}>
          <span>{icons[outcome]}</span>
          <span className="font-mono">{message.toolName}</span>
          <span>{labels[outcome]}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-[90%] rounded-lg border border-amber-300 bg-amber-50 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-100 border-b border-amber-200">
          <span className="text-amber-600">⚠</span>
          <span className="text-sm font-semibold text-amber-800">Agent 请求执行</span>
          <span className="font-mono text-sm font-bold text-gray-800 ml-1">{message.toolName}</span>
        </div>
        <div className="px-3 py-2">
          {message.toolInput && formatToolInput(message.toolName || "", message.toolInput)}
        </div>
        <div className="flex items-center gap-2 px-3 py-2 border-t border-amber-200">
          <button
            onClick={() => onApprove(id)}
            className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
          >
            ✓ 仅允许本次
          </button>
          <button
            onClick={() => onAlwaysAllow(id)}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            ⚡ 始终允许
          </button>
          <button
            onClick={() => onDeny(id)}
            className="px-3 py-1.5 text-xs font-medium bg-white border border-red-300 text-red-600 rounded hover:bg-red-50 transition-colors"
          >
            ✕ 拒绝
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── System Message (command result / notice) ───────────────
function SystemMessage({ message }: { message: Message }) {
  if (message.systemKind === "compact") {
    return (
      <div className="flex justify-center my-1">
        <span className="text-xs text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-3 py-1">
          ⓘ {message.content}
        </span>
      </div>
    );
  }
  // S1 (resilience plan): durable agent runtime errors — always red, live
  // error frames and history-replayed [agent_error] rows land here.
  if (message.systemKind === "error" || (message.role === "system" && message.isError && !message.systemKind)) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[90%] w-full rounded-md border border-red-200 bg-red-50">
          <div className="px-3 py-1 text-xs font-medium border-b text-red-600 border-red-200">
            Agent 错误
          </div>
          <pre className="px-3 py-2 text-xs whitespace-pre-wrap break-words font-mono text-red-800 max-h-80 overflow-y-auto">
            {message.content}
          </pre>
        </div>
      </div>
    );
  }
  // command_result
  return (
    <div className="flex justify-center">
      <div className={`max-w-[90%] w-full rounded-md border text-sm ${
        message.isError ? "border-red-200 bg-red-50" : "border-indigo-200 bg-indigo-50/50"
      }`}>
        <div className={`px-3 py-1 text-xs font-medium border-b ${
          message.isError ? "text-red-600 border-red-200" : "text-indigo-600 border-indigo-200"
        }`}>
          命令结果
        </div>
        <pre className="px-3 py-2 text-xs whitespace-pre-wrap break-words font-mono text-gray-800 max-h-80 overflow-y-auto">
          {message.content}
        </pre>
      </div>
    </div>
  );
}

// ─── S3b (Appendix A.3): thinking preview block ──────────────
// Collapsed by default, expandable; never persisted (history replay never
// produces these — refresh drops thinking by design, A.6).
function ThinkingBlock({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const streaming = !message.streamDone;
  const tokens = message.estimatedTokens;
  return (
    <div className="my-1.5 border border-gray-200 bg-gray-50/60 rounded-md text-sm">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-gray-100/60 rounded-md"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs ${streaming ? "text-purple-500 animate-pulse" : "text-purple-400"}`}>
            ◇
          </span>
          <span className="text-xs font-medium text-gray-600">
            {streaming ? "思考中…" : "已思考"}
          </span>
          {tokens != null && (
            <span className="text-xs text-gray-400">约 {tokens} tokens</span>
          )}
          {streaming && <span className="text-xs text-purple-400 animate-pulse">生成中</span>}
        </div>
        <span className="text-xs text-gray-400 ml-2 shrink-0">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <pre className="px-3 pb-2 pt-0 mt-0 border-t border-gray-200 text-xs whitespace-pre-wrap break-words text-gray-500 max-h-64 overflow-y-auto">
          {message.content}
        </pre>
      )}
    </div>
  );
}

// ─── Message Bubble ──────────────────────────────────────────
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  if (message.role === "system") {
    return <SystemMessage message={message} />;
  }

  // S3b: thinking preview blocks render in their collapsed container.
  if (message.streamKind === "thinking") {
    return <ThinkingBlock message={message} />;
  }

  // Skip empty assistant bubbles (e.g. a turn that only made tool calls)
  if (!isUser && !message.content?.trim()) {
    return null;
  }

  // Render slash commands as a distinct command pill
  if (isUser && message.content.trim().startsWith("/")) {
    return (
      <div className="flex justify-end">
        <span className="inline-flex items-center gap-1.5 max-w-[80%] rounded-lg px-3 py-1.5 bg-indigo-600 text-white font-mono text-sm">
          <span className="opacity-70">⌘</span>
          {message.content.trim()}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`rounded-lg px-4 py-2 ${
          isUser
            ? "max-w-[80%] bg-blue-600 text-white"
            : "max-w-[90%] bg-gray-100 text-gray-900"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none prose-pre:p-0 prose-pre:bg-transparent prose-table:text-sm">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const inline = !match && !String(children).includes("\n");
                  if (inline) {
                    return (
                      <code className="bg-gray-200 px-1 py-0.5 rounded text-sm" {...props}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <div className="overflow-x-auto my-2">
                      <SyntaxHighlighter
                        style={oneLight}
                        language={match?.[1] || "text"}
                        PreTag="div"
                        className="rounded text-sm !my-0"
                      >
                        {String(children).replace(/\n$/, "")}
                      </SyntaxHighlighter>
                    </div>
                  );
                },
                table({ children }) {
                  return (
                    <div className="overflow-x-auto my-2">
                      <table className="border-collapse border border-gray-300 text-sm">{children}</table>
                    </div>
                  );
                },
                a({ href, children }) {
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
            {/* S3b: live-preview affordances — cursor while streaming, a muted
                note when the preview was interrupted (whole-frame authority
                carries the final content). */}
            {message.streamId && !message.streamDone && (
              <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-blue-500 animate-pulse" />
            )}
            {message.streamInterrupted && (
              <div className="text-xs text-gray-400 mt-1">（流式中断，最终内容以完整消息为准）</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── File Panel ──────────────────────────────────────────────
const PREVIEWABLE_EXTS = ["html", "htm", "pdf"];
function isPreviewable(filename: string): boolean {
  return PREVIEWABLE_EXTS.includes((filename.split(".").pop() || "").toLowerCase());
}

function FilePanel({
  chatId,
  refreshKey = 0,
  onPreviewFile,
}: {
  chatId: string;
  refreshKey?: number;
  onPreviewFile?: (fileId: string, filename: string) => void;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = async () => {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/files`, { headers: authHeaders() });
      if (res.ok) setFiles(await res.json());
    } catch {}
  };

  const handleScanOutput = async () => {
    setScanning(true);
    try {
      await fetch(`${API_BASE}/chats/${chatId}/files/scan-output`, {
        method: "POST",
        headers: authHeaders(),
      });
      await fetchFiles();
    } catch {} finally {
      setScanning(false);
    }
  };

  useEffect(() => { fetchFiles(); }, [chatId, refreshKey]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      // Chunked base64: avoid stack overflow from spread operator on large files
      let binary = "";
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const base64 = btoa(binary);
      const res = await fetch(`${API_BASE}/chats/${chatId}/files/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ filename: file.name, content: base64, mimeType: file.type || "application/octet-stream" }),
      });
      if (res.ok) {
        setToast("文件已添加，Agent 可在 /workspace/input 使用。");
        setTimeout(() => setToast(null), 4000);
        fetchFiles();
      } else {
        const errText = await res.text().catch(() => res.statusText);
        console.error("Upload failed:", res.status, errText);
        setToast(`上传失败: ${res.status}`);
        setTimeout(() => setToast(null), 4000);
      }
    } catch (err) {
      console.error("Upload failed:", err);
      setToast("上传失败，请重试");
      setTimeout(() => setToast(null), 4000);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDownload = async (fileId: string, filename: string) => {
    try {
      const res = await fetch(`${API_BASE}/chats/${chatId}/files/${fileId}/download`, { headers: authHeaders() });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="border-b border-gray-200 bg-gray-50/50">
      {/* Upload row */}
      <div className="px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="text-xs px-2.5 py-1 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1"
        >
          <span>📎</span> {uploading ? "上传中…" : "上传文件"}
        </button>
        <button
          onClick={handleScanOutput}
          disabled={scanning}
          className="text-xs px-2.5 py-1 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1"
          title="扫描 /workspace/output 中的输出文件"
        >
          <span>🔄</span> {scanning ? "扫描中…" : "刷新输出"}
        </button>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
        {toast && <span className="text-xs text-green-600">{toast}</span>}
      </div>
      {/* File list */}
      {files.length > 0 && (
        <div className="px-3 pb-2">
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <div
                key={f.id}
                className="text-xs flex items-center gap-1.5 bg-white border border-gray-200 rounded px-2 py-1"
              >
                <span className={f.kind === "input" ? "text-blue-500" : "text-green-500"}>
                  {f.kind === "input" ? "↑" : "↓"}
                </span>
                <span className="text-gray-700 max-w-[120px] truncate" title={f.filename}>{f.filename}</span>
                <span className="text-gray-400">{formatSize(f.sizeBytes)}</span>
                {onPreviewFile && isPreviewable(f.filename) && (
                  <button
                    onClick={() => onPreviewFile(f.id, f.filename)}
                    className="text-indigo-500 hover:text-indigo-700"
                    title="预览"
                  >👁</button>
                )}
                <button
                  onClick={() => handleDownload(f.id, f.filename)}
                  className="text-blue-500 hover:text-blue-700"
                  title="下载"
                >⬇</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Capability Activation Panel (MP4b) ──────────────────────
// Owner configures WHICH entitled resources this Agent activates. Reads/writes
// /api/agents/:agentId/capabilities (chatId == agentId). Enable requires
// entitled+available; disable always allowed; each toggle is one PUT op.

// The endpoint wraps the array in {capabilities:[...]} (caught via smoke: the
// panel had shipped reading the raw body, which would set caps to an object and
// crash caps.filter at runtime). Unwrap defensively.
function unwrapCaps(data: unknown): AgentCapabilityView[] {
  if (Array.isArray(data)) return data as AgentCapabilityView[];
  if (data && typeof data === "object" && Array.isArray((data as any).capabilities)) {
    return (data as any).capabilities as AgentCapabilityView[];
  }
  return [];
}

function CapabilityPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [caps, setCaps] = useState<AgentCapabilityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchCaps = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/agents/${agentId}/capabilities`, { headers: authHeaders() });
      if (res.ok) setCaps(unwrapCaps(await res.json()));
      else setError(`加载失败 (${res.status})`);
    } catch {
      setError("加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCaps(); }, [agentId]);

  const toggle = async (cap: AgentCapabilityView) => {
    const next = !cap.enabled;
    if (next && (!cap.entitled || !cap.available)) return; // enable gate
    setBusyId(cap.resourceId);
    try {
      const res = await fetch(`${API_BASE}/agents/${agentId}/capabilities`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ resources: [{ resourceId: cap.resourceId, enabled: next }] }),
      });
      if (res.ok) {
        setCaps(unwrapCaps(await res.json()));
      } else {
        const body = await res.text().catch(() => "");
        setError(`保存失败 (${res.status}) ${body.slice(0, 120)}`);
        fetchCaps(); // re-sync on failure
      }
    } finally {
      setBusyId(null);
    }
  };

  const enabledCount = caps.filter((c) => c.enabled).length;

  return (
    <div className="border-b border-gray-200 bg-indigo-50/40">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="text-xs font-medium text-gray-700">
          Agent 能力配置 <span className="text-gray-400">· 已启用 {enabledCount}/{caps.length}</span>
        </div>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">收起 ▴</button>
      </div>
      <div className="px-3 pb-2 max-h-56 overflow-y-auto">
        {loading ? (
          <div className="text-xs text-gray-400 py-2">加载中…</div>
        ) : error ? (
          <div className="text-xs text-red-600 py-2">{error} <button onClick={fetchCaps} className="underline ml-1">重试</button></div>
        ) : caps.length === 0 ? (
          <div className="text-xs text-gray-400 py-2">暂无可配置能力（联系管理员授权 Skill）</div>
        ) : (
          <div className="space-y-1">
            {caps.map((cap) => {
              // Enable requires available && entitled; disable is ALWAYS allowed
              // (even when the resource later becomes unavailable/invalid), so an
              // enabled-but-unavailable capability can still be turned off.
              const canToggle = cap.enabled || (cap.available && cap.entitled);
              const locked = !canToggle;
              const lockReason = locked
                ? (!cap.available
                    ? `不可用${cap.unavailableReason ? `：${cap.unavailableReason}` : ""}`
                    : "未授权")
                : null;
              return (
                <div key={cap.resourceId} className="flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5">
                  <button
                    onClick={() => canToggle && toggle(cap)}
                    disabled={!canToggle || busyId === cap.resourceId}
                    className={`shrink-0 inline-flex items-center w-9 h-5 rounded-full transition-colors ${
                      cap.enabled ? "bg-indigo-600" : locked ? "bg-gray-200" : "bg-gray-300"
                    } ${canToggle ? "cursor-pointer" : "cursor-not-allowed"}`}
                    title={lockReason ?? (cap.enabled ? "点击禁用" : "点击启用")}
                  >
                    <span className={`inline-block w-4 h-4 bg-white rounded-full shadow transform transition-transform ${cap.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-gray-800 truncate">{cap.name}</span>
                      {cap.version && <span className="text-[10px] text-gray-400">{cap.version}</span>}
                    </div>
                    {lockReason && <span className="text-[10px] text-gray-400">{lockReason}</span>}
                  </div>
                  {busyId === cap.resourceId && <span className="text-[10px] text-gray-400 animate-pulse">保存中…</span>}
                </div>
              );
            })}
          </div>
        )}
        <div className="text-[10px] text-gray-400 mt-1.5">
          ⓘ 变更仅对新会话生效（Stop 当前 runtime 后重发消息触发 cold resume）。
        </div>
      </div>
    </div>
  );
}

// ─── Main ChatWindow Component ───────────────────────────────
export function ChatWindow({
  chatId,
  messages,
  isConnected,
  wsStatus,
  isLoading,
  streamStalled = false,
  onSendMessage,
  onStop,
  runtimeStatus,
  isAdmin,
  isStopping,
  slashCommands = [],
  onApprove,
  onAlwaysAllow,
  onDeny,
  onA2UISubmit,
  fileRefreshKey = 0,
  onPreviewFile,
  starter = null,
}: ChatWindowProps) {
  const [input, setInput] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [showCaps, setShowCaps] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Command menu: show when input is a single line starting with "/"
  const showCommandMenu =
    input.startsWith("/") && !input.includes("\n") && !input.includes(" ");
  const commandQuery = input.slice(1).toLowerCase();
  // Merge SDK-provided commands with static known list (deduplicated)
  const allCommands = Array.from(new Set([...slashCommands, ...STATIC_KNOWN_COMMANDS]));
  const filteredCommands = showCommandMenu
    ? allCommands.filter((c) => c.toLowerCase().startsWith(commandQuery))
    : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Reset menu highlight when the filtered list changes
  useEffect(() => {
    setMenuIndex(0);
  }, [input]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + "px";
    }
  }, [input]);

  const handleSend = () => {
    if (!input.trim() || !chatId || isLoading || !isConnected) return;
    onSendMessage(input.trim());
    setInput("");
  };

  const selectCommand = (cmd: string) => {
    // Fill the input with the command; user presses Enter again to run it
    setInput("/" + cmd);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Command menu navigation takes priority
    if (showCommandMenu && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        selectCommand(filteredCommands[menuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!chatId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-page">
        <div className="text-center">
          <p className="text-xl font-semibold text-ink-primary">EAOS 工作台</p>
          <p className="text-sm mt-2 text-ink-secondary">选择或创建一个对话开始</p>
        </div>
      </div>
    );
  }

  const isStopped = runtimeStatus?.status === "stopped";
  const hasFiles = true; // File panel always shown for simplicity

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="font-semibold text-gray-800 shrink-0">Chat</h2>
          {/* M2: 模型选择器 — 当前生效模型 + 来源；变更仅对新 runtime 生效 */}
          <ChatModelSelector chatId={chatId} />
          {/* M4: 上下文状态 — 估算 vs Auto Compact 阈值（只读，随轮次刷新） */}
          <ChatContextChip chatId={chatId} refreshKey={messages.length} />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowCaps((v) => !v)}
            className={`text-xs px-2.5 py-1 border rounded transition-colors ${
              showCaps
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
            }`}
            title="配置此 Agent 启用的能力（Skill）"
          >
            ⚡ 能力
          </button>
          {(() => {
            const map: Record<WsStatus, { dot: string; pill: string; label: string }> = {
              connected: { dot: "bg-green-500", pill: "bg-green-50 text-green-700", label: "已连接" },
              connecting: { dot: "bg-amber-400 animate-pulse", pill: "bg-amber-50 text-amber-700", label: "连接中" },
              reconnecting: { dot: "bg-amber-400 animate-pulse", pill: "bg-amber-50 text-amber-700", label: "重连中" },
              failed: { dot: "bg-red-500", pill: "bg-red-50 text-red-600", label: "重连失败 · 请刷新" },
            };
            const s = map[wsStatus];
            return (
              <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${s.pill}`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${s.dot}`} />
                {s.label}
              </span>
            );
          })()}
          {isLoading && onStop && (
            <button
              onClick={onStop}
              disabled={isStopping}
              className="text-xs px-2.5 py-1 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 transition-colors"
            >
              {isStopping ? "停止中…" : "Stop"}
            </button>
          )}
        </div>
      </div>

      {/* Capability activation panel (MP4b) — owner toggles which entitled
          resources this Agent activates. Toggles apply to NEW runtime only. */}
      {showCaps && (
        <CapabilityPanel agentId={chatId} onClose={() => setShowCaps(false)} />
      )}

      {/* Runtime status banner */}
      {runtimeStatus && runtimeStatus.status !== "none" && (
        <RuntimeStatusBanner status={runtimeStatus} isAdmin={isAdmin} />
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          starter && (starter.welcomeMessage || (starter.quickPrompts?.length ?? 0) > 0) ? (
            // M6a: expert-builder starter — server-persisted on the Agent, so it
            // survives refresh. Quick prompts FILL the composer (click → setInput
            // + focus); they never auto-send.
            <div className="mt-16 flex flex-col items-center">
              {starter.welcomeMessage && (
                <p className="text-ink-primary text-base font-medium mb-1">{starter.welcomeMessage}</p>
              )}
              {(starter.quickPrompts?.length ?? 0) > 0 && (
                <p className="text-ink-secondary text-sm mb-5">从下面的快捷任务开始，或直接输入你的问题</p>
              )}
              <div className="flex flex-col gap-2 max-w-lg w-full">
                {(starter.quickPrompts ?? []).map((q) => (
                  <button
                    key={q.title}
                    onClick={() => { setInput(q.prompt); textareaRef.current?.focus(); }}
                    className="w-full text-left text-sm px-3.5 py-2.5 bg-white border border-line-subtle rounded-md hover:border-brand hover:text-brand transition-colors text-ink-secondary"
                  >
                    {q.title}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-16 flex flex-col items-center">
              <p className="text-ink-primary text-base font-medium mb-1">EAOS 工作台</p>
              <p className="text-ink-secondary text-sm mb-5">从下面的快捷任务开始，或直接输入你的问题</p>
              <div className="flex flex-col gap-2 max-w-lg w-full">
                {EXAMPLE_PROMPTS.map((prompt, i) => (
                  <button
                    key={i}
                    onClick={() => { setInput(prompt); textareaRef.current?.focus(); }}
                    className="w-full text-left text-sm px-3.5 py-2.5 bg-white border border-line-subtle rounded-md hover:border-brand hover:text-brand transition-colors text-ink-secondary"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <>
            {messages.map((msg) =>
              msg.role === "tool_use" ? (
                <ToolUseBlock key={msg.id} message={msg} />
              ) : msg.role === "approval" ? (
                <ApprovalCard
                  key={msg.id}
                  message={msg}
                  onApprove={onApprove ?? (() => {})}
                  onAlwaysAllow={onAlwaysAllow ?? (() => {})}
                  onDeny={onDeny ?? (() => {})}
                />
              ) : msg.role === "a2ui" && msg.block && msg.blockId ? (
                <CardErrorBoundary key={msg.id}>
                  <A2UIBlockCard
                    blockId={msg.blockId}
                    block={msg.block}
                    chatId={chatId || ""}
                    resolved={msg.a2uiResolved}
                    resolutionLabel={msg.a2uiResolutionLabel}
                    onSubmit={(payload) => onA2UISubmit?.(payload)}
                  />
                </CardErrorBoundary>
              ) : (
                <MessageBubble key={msg.id} message={msg} />
              )
            )}
            {isLoading && (
              <div className="flex items-center gap-2 text-gray-500">
                <span className="animate-pulse text-blue-500">●</span>
                <span className="text-sm">Agent 正在处理…</span>
              </div>
            )}
            {/* S3b (A.5): preview-level inactivity — deltas stalled >20s
                while the run is not terminal. Non-destructive annotation;
                any new delta or terminal frame clears it. */}
            {!isLoading && streamStalled && (
              <div className="flex items-center gap-2 text-amber-600">
                <span className="animate-pulse">●</span>
                <span className="text-sm">等待 Agent 响应…</span>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* File panel — kept near input so users don't scroll to top */}
      <FilePanel chatId={chatId} refreshKey={fileRefreshKey} onPreviewFile={onPreviewFile} />

      {/* Input area */}
      <div className="p-3 border-t border-gray-200 bg-white relative shrink-0">
        {/* Slash command autocomplete menu */}
        {showCommandMenu && filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden max-h-60 overflow-y-auto z-10">
            <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-100">
              命令 · ↑↓ 选择 · Tab 补全 · Esc 取消
            </div>
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd}
                onMouseDown={(e) => { e.preventDefault(); selectCommand(cmd); }}
                onMouseEnter={() => setMenuIndex(i)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 ${
                  i === menuIndex ? "bg-indigo-50" : "hover:bg-gray-50"
                }`}
              >
                <span className="font-mono text-sm text-indigo-600">/{cmd}</span>
                <span className="text-xs text-gray-500 truncate">
                  {COMMAND_DESCRIPTIONS[cmd] || ""}
                </span>
              </button>
            ))}
          </div>
        )}
        {isStopped && (
          <div className="text-xs text-gray-500 mb-1.5 px-1">
            Agent 已停止 — 发送消息将继续对话
          </div>
        )}
        <div className="flex gap-2 items-end">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isConnected ? (isStopped ? "继续对话…" : "输入消息… (Enter 发送, Shift+Enter 换行)") : "连接中…"}
              disabled={!isConnected || isLoading}
              rows={1}
              className="w-full px-3 py-2 border border-line-subtle rounded-lg focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand disabled:bg-gray-100 resize-none text-sm leading-relaxed"
            />
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || !isConnected || isLoading}
            className="px-4 py-2 bg-brand hover:bg-brand-hover text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            发送
          </button>
        </div>
        <div className="text-xs text-gray-400 mt-1 px-1">
          Enter 发送 · Shift+Enter 换行
          {slashCommands.length > 0 && " · 输入 / 使用命令"}
          {messages.length > 0 && " · 已上传文件可在对话中引用"}
        </div>
      </div>
    </div>
  );
}
