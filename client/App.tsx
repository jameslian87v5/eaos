import { useState, useEffect, useCallback, useRef } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { ChatList } from "./components/ChatList";
import { AgentBuilderDrawer } from "./components/AgentBuilderDrawer";
import { ExpertDirectoryPage } from "./components/ExpertDirectoryPage";
import { MySkillsPage } from "./components/MySkillsPage";
import { ChatWindow, type WsStatus } from "./components/ChatWindow";
import { LoginPage } from "./components/LoginPage";
import { ChangePasswordPage } from "./components/ChangePasswordPage";
import { AdminLayout } from "./admin/AdminLayout";
import { PreviewPanel, type PreviewTarget } from "./components/PreviewPanel";
import { SkillsCatalogPanel } from "./components/SkillsCatalogPanel";
import { BookOpen } from "lucide-react";
import { splitA2UISegments, hasA2UIBlock, type A2UIBlock } from "./a2ui-parser";
import { buildWebSocketUrl } from "./runtime-url";

// Secure-context-safe UUID: crypto.randomUUID is undefined on insecure origins
// (plain http to a LAN IP like http://172.28.11.242:8080), which crashed the
// live WS event handlers the moment a reply started streaming (white screen;
// refresh worked because history messages keep their server-side ids).
// getRandomValues IS available on insecure origins, so use it for the fallback.
const uuid = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 16;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });


const PREVIEWABLE_EXTS = ["html", "htm", "pdf"];
function isPreviewable(filename: string): boolean {
  return PREVIEWABLE_EXTS.includes((filename.split(".").pop() || "").toLowerCase());
}

interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  // M6a: expert-builder starter (present only on builder-created Agents).
  templateId?: string | null;
  welcomeMessage?: string | null;
  quickPrompts?: Array<{ title: string; prompt: string }> | null;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "tool_use" | "system" | "approval" | "a2ui";
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  toolOutput?: string;
  toolError?: boolean;
  finalized?: boolean;
  systemKind?: "command_result" | "compact" | "notice" | "error";
  isError?: boolean;
  // Approval-specific fields
  approvalId?: string;
  approvalResolved?: boolean;
  approvalOutcome?: "approved" | "always" | "denied";
  // A2UI-specific fields
  blockId?: string;
  block?: A2UIBlock;
  a2uiResolved?: boolean;
  a2uiResolutionLabel?: string;
  // S3b (Appendix A.3): streaming preview block fields — keyed by
  // (streamId, streamIndex, streamKind). In-memory ONLY: history messages
  // never carry them (host persists whole frames exclusively).
  streamId?: string;
  streamIndex?: number;
  streamKind?: "text" | "thinking";
  streamDone?: boolean;
  streamInterrupted?: boolean;
  estimatedTokens?: number;
}

/**
 * Expand persisted assistant messages that contain <a2ui-json> tags into
 * alternating text + a2ui messages for history replay. Without this, the
 * user would see raw JSON on page reload.
 */
function expandA2UIInHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !hasA2UIBlock(msg.content)) {
      out.push(msg);
      continue;
    }
    // A2UI v2 (S4): the host appends `<!--a2ui-id:<blockId>-->` to the
    // synthetic message so the LIVE blockId survives history replay. The
    // legacy prose parser's validate() strips unknown keys, so the id can
    // only ride in this comment. STRIP the marker before splitting so it
    // never becomes a trailing assistant text segment / empty bubble.
    // Falls back to the inert `hist-` id when absent (old messages).
    const idMatch = /<!--a2ui-id:([^>]+)-->/.exec(msg.content);
    const liveBlockId = idMatch ? idMatch[1] : null;
    const cleanContent = idMatch
      ? msg.content.slice(0, idMatch.index) + msg.content.slice(idMatch.index + idMatch[0].length)
      : msg.content;
    const segments = splitA2UISegments(cleanContent);
    let a2uiSeen = 0;
    for (const seg of segments) {
      if (seg.kind === "text") {
        // Skip any leftover whitespace-only segment after marker removal.
        if (!seg.text.trim()) continue;
        out.push({
          id: `${msg.id}-txt-${out.length}`,
          role: "assistant",
          content: seg.text,
          timestamp: msg.timestamp,
          finalized: true,
        });
      } else {
        a2uiSeen += 1;
        out.push({
          id: `${msg.id}-a2ui-${out.length}`,
          role: "a2ui",
          content: "",
          timestamp: msg.timestamp,
          // Match the host's live blockId when present (the deferred
          // live-replay will re-arm THIS card instead of duplicating).
          blockId: liveBlockId ?? `hist-${msg.id}-${a2uiSeen}`,
          block: seg.block,
          a2uiResolved: true,
          a2uiResolutionLabel: "历史记录",
        });
      }
    }
  }
  return out;
}

interface RuntimeStatus {
  status: string;
  restoreMode: string | null;
  containerId: string | null;
  claudeSessionId: string | null;
  restartCount: number;
  lastError: string | null;
  cleanupReason: string | null;
  isAgentBusy: boolean;
  subscriberCount: number;
  hasPendingApproval: boolean;
  workspaceBytes: number | null;
  claudeHomeBytes: number | null;
}

// Use relative URLs - Vite will proxy to the backend
const API_BASE = "/api";
// P0-2: WS reconnect budget; once exhausted the status flips to "failed".
const WS_MAX_RECONNECT = 10;

function getToken() {
  return localStorage.getItem("token");
}

function getWsUrl() {
  // Task 1 (P0.1): same-origin WS URL — https→wss, http→ws, page host+port
  // reused. Under the HTTPS reverse proxy this keeps the connection same-
  // origin; in dev Vite proxies /ws to the backend. See client/runtime-url.ts.
  return buildWebSocketUrl(window.location, getToken() ?? undefined);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface UserInfo {
  username: string;
  role: string;
}

function getSavedUser(): UserInfo | null {
  const raw = localStorage.getItem("user");
  return raw ? JSON.parse(raw) : null;
}

export default function App() {
  const [token, setToken] = useState<string | null>(getToken());
  const [user, setUser] = useState<UserInfo | null>(getSavedUser());
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [wsReloadKey, setWsReloadKey] = useState(0); // bump to force WS reconnect (e.g. after password change)
  const reconnectsRef = useRef(0); // P0-2: consecutive WS closes since last OPEN (drives "failed" state)
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false); // M7a: experts directory skeleton
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [copilotAgentId, setCopilotAgentId] = useState<string | null>(null); // Minimal copilot: user's ONE fixed copilot agent (app_id='copilot')
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [fileRefreshKey, setFileRefreshKey] = useState(0);
  const [skillsCatalogOpen, setSkillsCatalogOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false); // M6a: expert-builder drawer
  const navigate = useNavigate();
  const location = useLocation();
  const [previewFile, setPreviewFile] = useState<PreviewTarget | null>(null);
  const [autoPreviewTick, setAutoPreviewTick] = useState(0);

  const handleLogin = (newToken: string, userInfo: { username: string; role: string }, mustChange?: boolean) => {
    localStorage.setItem("token", newToken);
    localStorage.setItem("user", JSON.stringify(userInfo));
    setToken(newToken);
    setUser(userInfo);
    setMustChangePassword(!!mustChange);
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setToken(null);
    setUser(null);
    setMustChangePassword(false);
    setChats([]);
    setMessages([]);
    setSelectedChatId(null);
  };

  // P0-1: password change succeeded — clear the must-change state and force a WS
  // reconnect + chat refetch so the now-unlocked session resumes cleanly.
  const handlePasswordChanged = () => {
    setMustChangePassword(false);
    setWsReloadKey((k) => k + 1);
    fetchChats();
  };

  // Handle WebSocket messages — must be before any conditional return

  // ─── S3b (Appendix A.3): streaming preview state ───────────────────
  // Known streamIds — stream_start is the ONLY legal stream entry: a delta
  // for an unknown stream (mid-turn reconnect residual, forged) is dropped.
  const knownStreamsRef = useRef<Set<string>>(new Set());
  // A.5 preview-level inactivity timer (20s): fires "等待 Agent 响应…"
  // (non-destructive annotation). Reset by any delta/stream_start; cleared
  // by run-terminal frames (result/error/stopped) and reconnect.
  const [streamStalled, setStreamStalled] = useState(false);
  const streamIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const STREAM_STALL_MS = 20_000;

  const bumpStreamActivity = useCallback(() => {
    if (streamIdleTimerRef.current) clearTimeout(streamIdleTimerRef.current);
    setStreamStalled(false);
    streamIdleTimerRef.current = setTimeout(() => setStreamStalled(true), STREAM_STALL_MS);
  }, []);

  const clearStreamIdleTimer = useCallback(() => {
    if (streamIdleTimerRef.current) {
      clearTimeout(streamIdleTimerRef.current);
      streamIdleTimerRef.current = null;
    }
    setStreamStalled(false);
  }, []);

  /** A.3: finalize every in-flight streaming block (done + optional
   *  interrupted marker) — used by run-terminal frames and reconnect. */
  const convergeStreamingBlocks = useCallback((interrupted: boolean) => {
    knownStreamsRef.current.clear();
    setMessages((prev) =>
      prev.map((m) =>
        m.streamId && !m.streamDone
          ? { ...m, streamDone: true, streamInterrupted: interrupted }
          : m
      )
    );
  }, []);

  const handleWSMessage = useCallback((message: any) => {
    switch (message.type) {
      case "connected":
        console.log("Connected to server");
        break;

      case "history":
        setMessages(expandA2UIInHistory(message.messages || []));
        // A.3: refresh = no stream state survives; only whole frames.
        clearStreamIdleTimer();
        knownStreamsRef.current.clear();
        break;

      case "user_message":
        // User message already added locally
        break;

      // ─── S3b (Appendix A.2/A.3): streaming frames ───────────────────
      case "stream_start":
        // The only legal stream entry point (reconnect rule A.3).
        knownStreamsRef.current.add(message.streamId);
        bumpStreamActivity();
        break;

      case "stream_delta": {
        // Deltas for streams we never saw start are dropped (mid-turn
        // reconnect residuals / forged frames) — A.3 reconnect rule.
        if (!knownStreamsRef.current.has(message.streamId)) break;
        bumpStreamActivity();
        const kind: "text" | "thinking" = message.kind === "thinking" ? "thinking" : "text";
        setMessages((prev) => {
          const idx = prev.findIndex(
            (m) =>
              m.role === "assistant" &&
              m.streamId === message.streamId &&
              m.streamIndex === message.index &&
              m.streamKind === kind
          );
          if (idx >= 0) {
            if (prev[idx].streamDone) return prev; // late/dup frame after final
            const next = [...prev];
            next[idx] = { ...next[idx], content: next[idx].content + message.delta };
            return next;
          }
          return [
            ...prev,
            {
              id: uuid(),
              role: "assistant" as const,
              content: message.delta,
              timestamp: new Date().toISOString(),
              streamId: message.streamId,
              streamIndex: message.index,
              streamKind: kind,
            },
          ];
        });
        setIsLoading(false);
        break;
      }

      case "thinking_block": {
        // Final thinking frame (block-level finalize — the same stream's
        // text blocks keep streaming, A.3).
        setMessages((prev) => {
          const idx = prev.findIndex(
            (m) =>
              m.role === "assistant" &&
              m.streamId === message.streamId &&
              m.streamIndex === message.index &&
              m.streamKind === "thinking" &&
              !m.streamDone
          );
          const finalFields = {
            content: typeof message.content === "string" ? message.content : "",
            streamDone: true,
            ...(message.estimatedTokens != null ? { estimatedTokens: message.estimatedTokens } : {}),
          };
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...finalFields };
            return next;
          }
          // Client joined mid-turn / whole-frame-only provider: the final
          // frame stands alone (no streamed counterpart to replace).
          return [
            ...prev,
            {
              id: uuid(),
              role: "assistant" as const,
              timestamp: new Date().toISOString(),
              streamId: message.streamId,
              streamIndex: message.index,
              streamKind: "thinking" as const,
              ...finalFields,
            },
          ];
        });
        break;
      }

      case "stream_end":
        // Stream-terminal (message_stop or run sweep): remaining blocks of
        // this stream finalize as interrupted-or-final; its deltas stop.
        knownStreamsRef.current.delete(message.streamId);
        setMessages((prev) =>
          prev.map((m) =>
            m.streamId === message.streamId && !m.streamDone
              ? { ...m, streamDone: true, streamInterrupted: true }
              : m
          )
        );
        break;

      case "assistant_message":
      case "assistant_message_done": {
        setMessages((prev) => {
          // Correlated frame (A.3/A.4): exclusive replacement right — only
          // the segment carrying (streamId, blockIndex) replaces its
          // matching preview block.
          if (message.streamId != null && message.blockIndex != null) {
            const idx = prev.findIndex(
              (m) =>
                m.role === "assistant" &&
                m.streamId === message.streamId &&
                m.streamIndex === message.blockIndex &&
                m.streamKind === "text" &&
                !m.streamDone
            );
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                content: message.content,
                finalized: true,
                streamDone: true,
              };
              return next;
            }
          }
          // Uncorrelated: an independent final entry — NEVER blindly
          // replaces a streaming preview (A.3; also keeps the A2UI retry
          // notice from hijacking the preview).
          return [
            ...prev,
            {
              id: uuid(),
              role: "assistant" as const,
              content: message.content,
              timestamp: new Date().toISOString(),
              finalized: true,
            },
          ];
        });
        setIsLoading(false);
        break;
      }

      case "tool_use":
        // Add tool use to messages array so it persists
        // Alternative: To show tool uses only while pending, store them in a
        // separate `pendingToolUses` state and clear it on "assistant_message" or "result"
        setMessages((prev) => [
          ...prev,
          {
            id: message.toolId,
            role: "tool_use",
            content: "",
            timestamp: new Date().toISOString(),
            toolName: message.toolName,
            toolInput: message.toolInput,
          },
        ]);
        break;

      case "tool_result":
        // Attach result to matching tool_use message
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === message.toolId
              ? { ...msg, toolOutput: message.output, toolError: message.isError }
              : msg
          )
        );
        break;

      case "result":
        // A.3: run-terminal — all streaming blocks converge.
        convergeStreamingBlocks(false);
        clearStreamIdleTimer();
        setIsLoading(false);
        // Refresh chat list to get updated titles
        fetchChats();
        break;

      case "approval_request":
        setMessages((prev) => [
          ...prev,
          {
            id: uuid(),
            role: "approval" as const,
            content: "",
            timestamp: new Date().toISOString(),
            approvalId: message.id,
            toolName: message.toolName,
            toolInput: message.toolInput,
            approvalResolved: false,
          },
        ]);
        break;

      case "a2ui_block":
        // A2UI v2 (S4 review): idempotent by blockId. After a refresh the
        // client receives history (the synthetic <a2ui-json> assistant
        // message → expandA2UIInHistory renders it as a `hist-`-id inert
        // card) and THEN the host's deferred live-replay of the SAME
        // blockId. Without this, a pending card shows twice. An existing
        // entry (live or historical) is updated in place and re-armed.
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.blockId === message.blockId);
          if (idx === -1) {
            return [
              ...prev,
              {
                id: uuid(),
                role: "a2ui" as const,
                content: "",
                timestamp: new Date().toISOString(),
                blockId: message.blockId,
                block: message.block as A2UIBlock,
                a2uiResolved: false,
              },
            ];
          }
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            role: "a2ui" as const,
            block: message.block as A2UIBlock,
            a2uiResolved: false,
            a2uiResolutionLabel: undefined,
          };
          return next;
        });
        break;

      // A2UI v2 (S4): the host expired a live blocking card (timeout). Mark it
      // resolved so the buttons disable — a further submit would be rejected
      // server-side anyway (tool- prefix + not pending), the UI should not
      // invite it. Old clients ignore this frame (switch falls through).
      case "a2ui_expired":
        setMessages((prev) =>
          prev.map((m) =>
            m.blockId === message.blockId
              ? { ...m, a2uiResolved: true, a2uiResolutionLabel: "已超时" }
              : m
          )
        );
        break;

      case "stopped":
        // A.3: run-terminal (user stop) — converge with interrupted marker.
        convergeStreamingBlocks(true);
        clearStreamIdleTimer();
        setIsLoading(false);
        break;

      case "slash_commands":
        setSlashCommands(message.commands || []);
        break;

      case "system_notice":
        if (message.subtype === "compact") {
          const pre = message.preTokens ? `（压缩前约 ${message.preTokens} tokens）` : "";
          setMessages((prev) => [
            ...prev,
            {
              id: uuid(),
              role: "system",
              systemKind: "compact",
              content: `对话历史已压缩${pre}`,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        break;

      case "command_result":
        setMessages((prev) => [
          ...prev,
          {
            id: uuid(),
            role: "system",
            systemKind: "command_result",
            content: message.output || "",
            isError: message.isError || false,
            timestamp: new Date().toISOString(),
          },
        ]);
        setIsLoading(false);
        break;

      case "files_updated":
        setFileRefreshKey((k) => k + 1);
        setAutoPreviewTick((t) => t + 1);
        break;

      case "error":
        // S1 (resilience plan): runtime delivery failures / stream errors
        // render as a red system banner — "no reply" must be visible. The
        // server persists the same error with the [agent_error] prefix, so a
        // refresh restores it via history (identical isError system message).
        setMessages((prev) => [
          ...prev,
          {
            id: uuid(),
            role: "system" as const,
            systemKind: "error" as const,
            content: message.error || "Agent 运行时错误",
            isError: true,
            timestamp: new Date().toISOString(),
          },
        ]);
        // A.3: run-terminal (error) — converge with interrupted marker.
        convergeStreamingBlocks(true);
        clearStreamIdleTimer();
        setIsLoading(false);
        break;
    }
  }, []);

  const { sendJsonMessage, readyState, lastJsonMessage } = useWebSocket(
    // P0-1: don't open a chat WS while a password change is required; the server
    // would close(4003) anyway. wsReloadKey forces a reconnect after change.
    token && !mustChangePassword ? `${getWsUrl()}&k=${wsReloadKey}` : null,
    {
      onOpen: () => {
        reconnectsRef.current = 0;
        // S3b (A.3 reconnect rule): no stream state survives a (re)connect —
        // half-rendered previews finalize as interrupted; deltas for streams
        // never seen start are dropped until the next stream_start.
        convergeStreamingBlocks(true);
        clearStreamIdleTimer();
      },
      onClose: (event) => {
        // P0-1: server closes with 4003 when the user must change password.
        if (event.code === 4003) {
          setMustChangePassword(true);
          return;
        }
        // Auth failures (expired/invalid token, disabled account) — server
        // closes with 4001. Do NOT retry: reconnecting with the same stale
        // token just burns the budget and lands on "failed". Clear the token
        // so the next user action (login redirect) starts clean.
        if (event.code === 4001) {
          localStorage.removeItem("token");
          return;
        }
        // P0-2: count consecutive failures so the UI can show "failed" once
        // reconnect attempts are exhausted.
        reconnectsRef.current += 1;
      },
      // Reconnect only on transient closes (server restart, network drop).
      // 4001 (auth) and 4003 (password change) are permanent — retrying
      // can't fix them and masks the real cause.
      shouldReconnect: (event) => event?.code !== 4003 && event?.code !== 4001,
      reconnectAttempts: WS_MAX_RECONNECT,
      reconnectInterval: 3000,
    }
  );

  const isConnected = readyState === ReadyState.OPEN;
  // P0-2: derive a honest WS status. "reconnecting" covers CLOSING/CLOSED while
  // still under budget; "failed" once the reconnect budget is spent.
  const wsStatus: WsStatus =
    readyState === ReadyState.OPEN
      ? "connected"
      : readyState === ReadyState.CONNECTING
        ? "connecting"
        : reconnectsRef.current >= WS_MAX_RECONNECT
          ? "failed"
          : "reconnecting";

  // Handle incoming WebSocket messages
  useEffect(() => {
    if (lastJsonMessage) {
      handleWSMessage(lastJsonMessage);
    }
  }, [lastJsonMessage, handleWSMessage]);

  // Fetch all chats — M6a: read the Agent projection (/api/agents, an alias
  // backed by AgentService) so builder-created Agents carry their starter
  // (templateId/welcomeMessage/quickPrompts) into the workbench.
  const fetchChats = async () => {
    setChatsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/agents`, { headers: authHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      if (res.status === 403) {
        // P0-1: must-change gate (e.g. session resumed from localStorage on reload)
        const body = await res.json().catch(() => ({}));
        if (body?.code === "MUST_CHANGE_PASSWORD") { setMustChangePassword(true); return; }
      }
      const data = await res.json();
      setChats(data);
    } catch (error) {
      console.error("Failed to fetch chats:", error);
    } finally {
      setChatsLoading(false);
    }
  };

  // Create new chat
  const createChat = async () => {
    try {
      const res = await fetch(`${API_BASE}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      if (res.status === 401) { handleLogout(); return; }
      const chat = await res.json();
      setChats((prev) => [chat, ...prev]);
      selectChat(chat.id);
    } catch (error) {
      console.error("Failed to create chat:", error);
    }
  };

  // Delete chat
  const deleteChat = async (chatId: string) => {
    try {
      await fetch(`${API_BASE}/chats/${chatId}`, { method: "DELETE", headers: authHeaders() });
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (selectedChatId === chatId) {
        setSelectedChatId(null);
        setMessages([]);
      }
    } catch (error) {
      console.error("Failed to delete chat:", error);
    }
  };

  // Select a chat
  const selectChat = (chatId: string) => {
    setSelectedChatId(chatId);
    setMessages([]);
    setIsLoading(false);
    setRuntimeStatus(null);
    // S3b (A.3): new subscription discards ALL stream state (a subscriber
    // joining mid-turn only streams from the next stream_start).
    knownStreamsRef.current.clear();
    clearStreamIdleTimer();

    // Subscribe to chat via WebSocket
    sendJsonMessage({ type: "subscribe", chatId });
  };

  // Minimal copilot: open the user's ONE fixed copilot agent (creates on first
  // use). Reset restarts the SAME agent's conversation, preserving volumes.
  const openCopilot = async () => {
    try {
      const res = await fetch(`${API_BASE}/copilot/agent`, { headers: authHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      const { agent } = await res.json();
      setCopilotAgentId(agent.id);
      await fetchChats();
      selectChat(agent.id);
    } catch (error) {
      console.error("Failed to open copilot:", error);
    }
  };

  // R5c round-3 (#4): unified Skill Hub entry for ALL roles (admin / org_admin
  // / ordinary user). Fetches /api/hub/launch — which returns ONLY a verified
  // Hub base URL (no service token / platform orgId / role) — and opens it in a
  // new tab. The browser authenticates to the Hub via the Hub's own session.
  // Non-leakage: only `url` is read from the response.
  const openSkillHub = async () => {
    try {
      const res = await fetch(`${API_BASE}/hub/launch`, { headers: authHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      if (res.status === 503) { alert("Skill Hub 未配置（请联系管理员设置 SKILLHUB_URL）"); return; }
      if (!res.ok) { alert(`无法获取 Skill Hub 入口 (HTTP ${res.status})`); return; }
      const data = await res.json();
      if (typeof data?.url === "string" && data.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      } else {
        alert("Skill Hub 入口配置异常");
      }
    } catch {
      alert("网络错误，无法连接平台");
    }
  };

  // Minimal copilot: reset the copilot agent — fresh conversation on the SAME
  // agent (workspace + memory volumes preserved). The server returns the same id.
  const resetCopilot = async () => {
    try {
      const res = await fetch(`${API_BASE}/copilot/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      if (res.status === 401) { handleLogout(); return; }
      const { agent } = await res.json();
      setCopilotAgentId(agent.id);
      await fetchChats();
      selectChat(agent.id); // clears messages + re-subscribes WS (same agent id)
    } catch (error) {
      console.error("Failed to reset copilot:", error);
    }
  };

  // Send a message
  const handleSendMessage = (content: string) => {
    if (!selectedChatId || !isConnected) return;

    // Add message optimistically
    setMessages((prev) => [
      ...prev,
      {
        id: uuid(),
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      },
    ]);

    setIsLoading(true);

    // Send via WebSocket
    sendJsonMessage({
      type: "chat",
      content,
      chatId: selectedChatId,
    });
  };

  // Approval handlers
  const resolveApproval = (approvalId: string, outcome: "approved" | "always" | "denied") => {
    setMessages((prev) =>
      prev.map((m) =>
        m.approvalId === approvalId
          ? { ...m, approvalResolved: true, approvalOutcome: outcome }
          : m
      )
    );
  };

  const handleApprove = (approvalId: string) => {
    sendJsonMessage({
      type: "approval_response",
      id: approvalId,
      chatId: selectedChatId,
      approved: true,
    });
    resolveApproval(approvalId, "approved");
  };

  const handleAlwaysAllow = (approvalId: string) => {
    sendJsonMessage({
      type: "approval_response",
      id: approvalId,
      chatId: selectedChatId,
      approved: true,
      alwaysAllow: true,
    });
    resolveApproval(approvalId, "always");
  };

  const handleDeny = (approvalId: string, msg?: string) => {
    sendJsonMessage({
      type: "approval_response",
      id: approvalId,
      chatId: selectedChatId,
      approved: false,
      message: msg || "User denied this operation",
    });
    resolveApproval(approvalId, "denied");
  };

  // A2UI submit handler — marks the block resolved locally and sends structured
  // event to server, which converts it into the next-turn user message.
  const handleA2UISubmit = (payload: {
    blockId: string;
    actionId: string;
    actionLabel: string;
    values: Record<string, string | number | boolean | string[]>;
  }) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.blockId === payload.blockId
          ? { ...m, a2uiResolved: true, a2uiResolutionLabel: payload.actionLabel }
          : m
      )
    );
    sendJsonMessage({
      type: "a2ui_submit",
      chatId: selectedChatId,
      blockId: payload.blockId,
      actionId: payload.actionId,
      actionLabel: payload.actionLabel,
      values: payload.values,
    });
    setIsLoading(true);
  };

  const handleStop = async () => {
    if (!selectedChatId || isStopping) return;
    setIsStopping(true);
    try {
      await fetch(`${API_BASE}/chats/${selectedChatId}/runtime/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      setIsLoading(false);
      // Refresh runtime status
      const res = await fetch(`${API_BASE}/chats/${selectedChatId}/runtime`, { headers: authHeaders() });
      if (res.ok) setRuntimeStatus(await res.json());
    } catch (err) {
      console.error("Stop failed:", err);
    } finally {
      setIsStopping(false);
    }
  };

  // Poll runtime status when a chat is selected
  useEffect(() => {
    if (!token || !selectedChatId) {
      setRuntimeStatus(null);
      return;
    }
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/chats/${selectedChatId}/runtime`, { headers: authHeaders() });
        if (res.ok) setRuntimeStatus(await res.json());
      } catch {}
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [token, selectedChatId]);

  // Initial fetch
  useEffect(() => {
    if (token) fetchChats();
  }, [token]);

  // Auto-open preview for the latest previewable output file when agent produces files
  useEffect(() => {
    if (autoPreviewTick === 0 || !selectedChatId) return;
    fetch(`${API_BASE}/chats/${selectedChatId}/files`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((files: Array<{ id: string; filename: string; kind: string; createdAt: string }>) => {
        const latest = files
          .filter((f) => f.kind === "output" && isPreviewable(f.filename))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest) setPreviewFile({ fileId: latest.id, filename: latest.filename });
      })
      .catch(() => {});
  }, [autoPreviewTick, selectedChatId]);

  // Close preview when switching chats
  useEffect(() => {
    setPreviewFile(null);
  }, [selectedChatId]);

  // Show login page if not authenticated
  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // P0-1: password change required (first-login, 403 MUST_CHANGE_PASSWORD, or WS close 4003)
  if (mustChangePassword) {
    return <ChangePasswordPage onSuccess={handlePasswordChanged} onLogout={handleLogout} />;
  }

  // Admin routes — M3: admit org_admin too (own-dept Orgs + Users view). The
  // AdminSidebar filters links by role and AdminLayout redirects org_admin
  // away from admin-only pages, so org_admin only reaches /admin/users +
  // /admin/orgs. Admin (cross-org) keeps full access.
  if (location.pathname.startsWith("/admin")) {
    if (user?.role !== "admin" && user?.role !== "org_admin") {
      return <Navigate to="/" replace />;
    }
    return <AdminLayout />;
  }

  // M7a: user-side My Experts directory (/experts) — own agents only (the
  // /api/agents list is owner-filtered server-side). Editing reuses the M7a
  // PATCH whitelist + capability routes; creation reuses the M6a drawer.
  if (location.pathname === "/experts") {
    return (
      <ExpertDirectoryPage
        agents={chats}
        loading={chatsLoading}
        loadError={null}
        onEnterChat={(agentId) => {
          navigate("/");
          selectChat(agentId);
        }}
        onRefresh={fetchChats}
        onBack={() => navigate("/")}
      />
    );
  }

  // M7b: user-side My Skills submission page (/my-skills) — submitter-scoped
  // reads (server-side); submission always enters the M3 pipeline and stays
  // pending admin review.
  if (location.pathname === "/my-skills") {
    return <MySkillsPage onBack={() => navigate("/")} />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 shrink-0 flex flex-col min-h-0">
        <div className="p-3 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-brand flex items-center justify-center text-white text-xs font-bold shrink-0">
                {user?.username?.charAt(0).toUpperCase() || "?"}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800 truncate">
                  {user?.username || "User"}
                </div>
                <div className="text-xs text-gray-400">
                  {user?.role || "user"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={openCopilot}
                className="text-xs px-2 py-1 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors"
                title="打开你的专属助手（每用户固定一个 Agent）"
              >
                我的助手
              </button>
              {selectedChatId && selectedChatId === copilotAgentId && (
                <button
                  onClick={resetCopilot}
                  className="text-xs px-2 py-1 rounded border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
                  title="重置对话：全新会话，保留工作区 + 大脑（文件/记忆不丢）"
                >
                  重置
                </button>
              )}
              {(user?.role === "admin" || user?.role === "org_admin") && (
                <button
                  onClick={() => navigate("/admin")}
                  className="text-xs px-2 py-1 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                  title="打开管理台"
                >
                  管理台
                </button>
              )}
              {/* R5c: unified Skill Hub entry for ALL roles (admin / org_admin /
                  ordinary user). Ordinary users don't get /admin, so this
                  button is their entry. Visible to everyone. */}
              <button
                onClick={openSkillHub}
                className="text-xs px-2 py-1 rounded border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 transition-colors"
                title="打开 Skill Hub（新标签页，通过 Hub 自己的会话登录）"
              >
                Skill Hub
              </button>
              <button
                type="button"
                onClick={() => setSkillsCatalogOpen(true)}
                className="flex h-7 w-7 items-center justify-center border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                title="技能目录"
                aria-label="打开技能目录"
              >
                <BookOpen className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                onClick={handleLogout}
                className="text-xs text-gray-400 hover:text-red-600 transition-colors"
                title="退出登录"
              >
                退出
              </button>
            </div>
          </div>
        </div>
        <ChatList
          chats={chats}
          selectedChatId={selectedChatId}
          onSelectChat={selectChat}
          onNewChat={createChat}
          onCreateAgent={() => setBuilderOpen(true)}
          onOpenExperts={() => navigate("/experts")}
          onOpenMySkills={() => navigate("/my-skills")}
          onDeleteChat={deleteChat}
        />
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <ChatWindow
          chatId={selectedChatId}
          messages={messages}
          isConnected={isConnected}
          wsStatus={wsStatus}
          isLoading={isLoading}
          streamStalled={streamStalled}
          onSendMessage={handleSendMessage}
          onStop={handleStop}
          runtimeStatus={runtimeStatus}
          isAdmin={user?.role === "admin"}
          isStopping={isStopping}
          slashCommands={slashCommands}
          onApprove={handleApprove}
          onAlwaysAllow={handleAlwaysAllow}
          onDeny={handleDeny}
          onA2UISubmit={handleA2UISubmit}
          fileRefreshKey={fileRefreshKey}
          onPreviewFile={(fileId, filename) => setPreviewFile({ fileId, filename })}
          starter={(() => {
            const a = chats.find((c) => c.id === selectedChatId);
            if (!a) return null;
            return a.welcomeMessage || (a.quickPrompts?.length ?? 0) > 0
              ? { welcomeMessage: a.welcomeMessage, quickPrompts: a.quickPrompts }
              : null;
          })()}
        />
      </div>

      {/* Preview panel (third column) */}
      {previewFile && selectedChatId && (
        <PreviewPanel
          chatId={selectedChatId}
          target={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
      <SkillsCatalogPanel open={skillsCatalogOpen} onClose={() => setSkillsCatalogOpen(false)} />
      <AgentBuilderDrawer
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onCreated={(agent) => {
          setBuilderOpen(false);
          // Auto-enter the new Agent's empty conversation (starter shows).
          fetchChats().then(() => selectChat(agent.id));
        }}
      />
    </div>
  );
}
