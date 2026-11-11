/**
 * Platform Widget SDK v0.1 — React socket hook.
 *
 * Faithful React port of the v0 vanilla iframe (public/embed/widget.html):
 * connects the app-scoped WS with a widgetToken, drives a reducer-backed
 * message stream, and bridges the host page over postMessage. Adds only what
 * the React UI needs to reuse the main app's A2UI / approval components:
 * tool_use/tool_result status rows and a2ui_block cards.
 *
 * Invariants:
 *  - Browser holds ONLY the short-lived widgetToken; AppKey never reaches here.
 *  - The server resolves the token into the same {appId, userId, role}
 *    principal as the app-scoped path; we never open a third auth branch.
 *  - Auth failure (WS close 4001/4003) is fatal: no reconnect, surface error.
 *  - All SDK→iframe postMessages must carry pageSessionId == ours, and the
 *    parent origin is pinned (from the #po= hint) for the lifetime of the page.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  splitA2UISegments,
  type A2UIBlock,
} from "../a2ui-parser";

const PROTOCOL = "agent-widget";
const VERSION = 1;
const MAX_RECONNECT = 5;

// --- stream item model ----------------------------------------------------

export interface ToolItem {
  id: string;
  kind: "tool";
  toolId: string;
  toolName: string;
  input: string;
  status: "running" | "ok" | "error";
  output?: string;
}
export interface AssistantItem {
  id: string;
  kind: "assistant";
  text: string;
  done: boolean;
}
export interface A2UIItem {
  id: string;
  kind: "a2ui";
  blockId: string;
  block: A2UIBlock;
  resolved: boolean;
  historical: boolean;
}
export interface SimpleItem {
  id: string;
  kind: "user" | "system";
  tone: "user" | "sys" | "err";
  text: string;
}
export type WidgetItem = ToolItem | AssistantItem | A2UIItem | SimpleItem;

export interface WidgetApproval {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  chatId: string;
}

export type WidgetStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "auth-error"
  | "disconnected";

export interface WidgetState {
  status: WidgetStatus;
  items: WidgetItem[];
  approvals: WidgetApproval[];
  busy: boolean;
  fatalError: string | null;
}

// Single-instance widget per page; a module counter is sufficient and keeps
// the reducer free of id-generation side effects.
let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

const initialState: WidgetState = {
  status: "connecting",
  items: [],
  approvals: [],
  busy: false,
  fatalError: null,
};

type Action =
  | { type: "status"; status: WidgetStatus }
  | { type: "set_busy"; busy: boolean }
  | { type: "add_user"; text: string }
  | { type: "append_assistant"; text: string }
  | { type: "finish_assistant" }
  | { type: "add_tool"; toolId: string; toolName: string; input: unknown }
  | { type: "finish_tool"; toolId: string; ok: boolean; output: string }
  | { type: "add_a2ui"; blockId: string; block: A2UIBlock }
  | { type: "resolve_a2ui"; blockId: string }
  | { type: "add_system"; text: string; tone: "sys" | "err" }
  | { type: "add_approval"; approval: WidgetApproval }
  | { type: "resolve_approval"; id: string }
  | { type: "fatal"; message: string }
  | { type: "set_history"; messages: Array<{ role?: string; content?: string }> };

export function reducer(state: WidgetState, action: Action): WidgetState {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status };
    case "set_busy":
      return { ...state, busy: action.busy };
    case "add_user":
      return {
        ...state,
        items: [
          ...state.items,
          { id: nextId("u"), kind: "user", tone: "user", text: action.text },
        ],
      };
    case "append_assistant": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && !last.done) {
        items[items.length - 1] = { ...last, text: last.text + action.text };
      } else {
        items.push({ id: nextId("a"), kind: "assistant", text: action.text, done: false });
      }
      return { ...state, items };
    }
    case "finish_assistant": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && !last.done) {
        items[items.length - 1] = { ...last, done: true };
      }
      return { ...state, items };
    }
    case "add_tool":
      return {
        ...state,
        items: [
          ...state.items,
          {
            id: nextId("t"),
            kind: "tool",
            toolId: action.toolId,
            toolName: action.toolName,
            input: compactInput(action.input),
            status: "running",
          },
        ],
      };
    case "finish_tool": {
      const items = state.items.map((it) =>
        it.kind === "tool" && it.toolId === action.toolId
          ? { ...it, status: (action.ok ? "ok" : "error") as "ok" | "error", output: action.output }
          : it
      );
      return { ...state, items };
    }
    case "add_a2ui":
      // A2UI v2 (S4 review): idempotent by blockId — a refreshed client
      // receives history (rendered as `historical` cards) THEN the host's
      // deferred live-replay of the SAME blockId; without this, a pending
      // card shows twice. An existing entry is updated in place.
      if (state.items.some((it) => it.kind === "a2ui" && it.blockId === action.blockId)) {
        return {
          ...state,
          items: state.items.map((it) =>
            it.kind === "a2ui" && it.blockId === action.blockId
              ? { ...it, block: action.block, resolved: false, historical: false }
              : it
          ),
        };
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            id: nextId("g"),
            kind: "a2ui",
            blockId: action.blockId,
            block: action.block,
            resolved: false,
            historical: false,
          },
        ],
      };
    case "resolve_a2ui":
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "a2ui" && it.blockId === action.blockId ? { ...it, resolved: true } : it
        ),
      };
    case "add_system":
      return {
        ...state,
        items: [
          ...state.items,
          { id: nextId("s"), kind: "system", tone: action.tone, text: action.text },
        ],
      };
    case "add_approval":
      return { ...state, approvals: [...state.approvals, action.approval] };
    case "resolve_approval":
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };
    case "fatal":
      return { ...state, status: "auth-error", fatalError: action.message, busy: false };
    case "set_history": {
      const items: WidgetItem[] = [];
      for (const msg of action.messages) {
        if (msg.role === "user") {
          items.push({ id: nextId("u"), kind: "user", tone: "user", text: msg.content || "" });
        } else if (msg.role === "assistant") {
          // A2UI v2 (S4): read the live blockId the host appended as
          // `<!--a2ui-id:<id>-->` so the deferred live-replay re-arms this
          // historical entry instead of duplicating. STRIP the marker before
          // splitting so it never becomes a trailing assistant text item.
          const raw = msg.content || "";
          const idMatch = /<!--a2ui-id:([^>]+)-->/.exec(raw);
          const liveBlockId = idMatch ? idMatch[1] : null;
          const cleanContent = idMatch
            ? raw.slice(0, idMatch.index) + raw.slice(idMatch.index + idMatch[0].length)
            : raw;
          for (const seg of splitA2UISegments(cleanContent)) {
            if (seg.kind === "text") {
              if (!seg.text.trim()) continue;
              items.push({ id: nextId("a"), kind: "assistant", text: seg.text, done: true });
            } else {
              items.push({
                id: nextId("g"),
                kind: "a2ui",
                blockId: liveBlockId ?? nextId("blk"),
                block: seg.block,
                resolved: true,
                historical: true,
              });
            }
          }
        }
      }
      return { ...state, items };
    }
    default:
      return state;
  }
}

function compactInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input);
  try {
    return truncate(JSON.stringify(input));
  } catch {
    return String(input);
  }
}
function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// --- hook -----------------------------------------------------------------

export interface WidgetSocketParams {
  appId: string;
  agentId: string;
  pageSessionId: string;
  token: string;
  parentOrigin: string | null;
}

export interface WidgetSocket {
  state: WidgetState;
  send: (text: string) => void;
  stop: () => void;
  respondApproval: (id: string, approved: boolean) => void;
  submitA2UI: (payload: {
    blockId: string;
    actionId: string;
    actionLabel: string;
    values: Record<string, string | number | boolean | string[]>;
  }) => void;
}

export function useWidgetSocket(params: WidgetSocketParams): WidgetSocket {
  const { appId, agentId, pageSessionId, token, parentOrigin } = params;
  const [state, dispatch] = useReducer(reducer, initialState);

  const wsRef = useRef<WebSocket | null>(null);
  const pageContextRef = useRef<Record<string, unknown> | null>(null);
  const destroyedRef = useRef(false);
  const reconnectRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendWs = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const postToParent = useCallback(
    (type: string, payload: Record<string, unknown> = {}) => {
      try {
        window.parent.postMessage(
          { protocol: PROTOCOL, version: VERSION, pageSessionId, type, ...payload },
          parentOrigin || "*"
        );
      } catch {
        /* parent may be unreachable in standalone use */
      }
    },
    [pageSessionId, parentOrigin]
  );

  // WS connect + lifecycle. Params are primitives fixed for the page lifetime,
  // so this connects once and reconnects internally on transient close.
  useEffect(() => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const url =
      `${scheme}://${window.location.host}/api/apps/${encodeURIComponent(appId)}/ws` +
      `?widgetToken=${encodeURIComponent(token)}`;

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current = 0;
        dispatch({ type: "status", status: "connected" });
        sendWs({ type: "subscribe", chatId: agentId });
        postToParent("agent:ready", { agentId });
      };

      ws.onmessage = (ev) => {
        let m: Record<string, any>;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (m.type) {
          case "connected":
          case "user_message": // we already added it locally on send
            break;
          case "history":
            dispatch({ type: "set_history", messages: m.messages || [] });
            break;
          case "assistant_message":
            dispatch({ type: "set_busy", busy: true });
            dispatch({ type: "append_assistant", text: m.content || "" });
            break;
          case "tool_use":
            dispatch({
              type: "add_tool",
              toolId: m.toolId,
              toolName: m.toolName,
              input: m.toolInput,
            });
            break;
          case "tool_result":
            dispatch({
              type: "finish_tool",
              toolId: m.toolId,
              ok: !m.isError,
              output: truncate(typeof m.output === "string" ? m.output : "", 240),
            });
            break;
          case "a2ui_block":
            dispatch({ type: "add_a2ui", blockId: m.blockId, block: m.block });
            break;
          // A2UI v2 (S4): mark an expired card resolved so the UI stops
          // inviting a submit the host already rejected (tool- prefix +
          // not pending). Old widgets ignore this (default).
          case "a2ui_expired":
            dispatch({ type: "resolve_a2ui", blockId: m.blockId });
            break;
          case "approval_request":
            dispatch({
              type: "add_approval",
              approval: {
                id: m.id,
                toolName: m.toolName,
                toolInput: m.toolInput || {},
                chatId: m.chatId || agentId,
              },
            });
            break;
          case "result":
            dispatch({ type: "finish_assistant" });
            dispatch({ type: "set_busy", busy: false });
            break;
          case "stopped":
            dispatch({ type: "set_busy", busy: false });
            break;
          case "system_notice":
            dispatch({ type: "add_system", text: m.message || m.content || "", tone: "sys" });
            break;
          case "error":
            dispatch({ type: "add_system", text: m.error || "error", tone: "err" });
            dispatch({ type: "set_busy", busy: false });
            break;
        }
      };

      ws.onclose = (event) => {
        if (destroyedRef.current) return;
        // Auth / forbidden: fatal, do not reconnect (v0 contract).
        if (event && (event.code === 4001 || event.code === 4003)) {
          const msg = event.reason || "Widget authentication failed.";
          dispatch({ type: "fatal", message: msg });
          postToParent("agent:error", { code: "auth", message: msg });
          return;
        }
        dispatch({ type: "status", status: "reconnecting" });
        dispatch({ type: "set_busy", busy: false });
        if (reconnectRef.current < MAX_RECONNECT) {
          const delay = Math.min(1000 * (reconnectRef.current + 1), 5000);
          reconnectRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else {
          dispatch({ type: "status", status: "disconnected" });
          postToParent("agent:error", { code: "connection", message: "WS closed" });
        }
      };

      ws.onerror = () => {
        /* close handler covers terminal transitions */
      };
    };

    connect();

    return () => {
      destroyedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
    // Primitives fixed for page lifetime; reconnect is handled inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, token, agentId, pageSessionId, parentOrigin]);

  // SDK → iframe postMessage bridge (host page drives context + sends).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (parentOrigin && event.origin !== parentOrigin) return;
      const m = event.data as Record<string, any> | null;
      if (!m || m.protocol !== PROTOCOL) return;
      if (!m.pageSessionId || m.pageSessionId !== pageSessionId) return;
      switch (m.type) {
        case "agent:boot":
          if (m.context)
            pageContextRef.current = { ...(pageContextRef.current || {}), ...m.context };
          break;
        case "agent:setContext":
          pageContextRef.current = (m.context as Record<string, unknown>) || null;
          break;
        case "agent:send":
          if (typeof m.content === "string") doSend(m.content);
          break;
        case "agent:destroy":
          destroyedRef.current = true;
          if (wsRef.current) {
            try {
              wsRef.current.close();
            } catch {
              /* ignore */
            }
          }
          dispatch({ type: "status", status: "disconnected" });
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentOrigin, pageSessionId]);

  const doSend = useCallback(
    (text: string) => {
      const trimmed = (text || "").trim();
      if (!trimmed) return;
      // W4: send the typed text clean + the current page-context snapshot as a
      // separate field. The server wraps context into the runtime input only;
      // platform history/broadcast show the typed text (no [page context] prefix).
      const ctx = pageContextRef.current;
      dispatch({ type: "add_user", text: trimmed });
      sendWs({
        type: "chat",
        chatId: agentId,
        content: trimmed,
        ...(ctx ? { pageContext: ctx, pageSessionId } : {}),
      });
      dispatch({ type: "set_busy", busy: true });
    },
    [agentId, sendWs, pageSessionId]
  );

  const stop = useCallback(() => {
    sendWs({ type: "stop", chatId: agentId });
  }, [agentId, sendWs]);

  const respondApproval = useCallback(
    (id: string, approved: boolean) => {
      sendWs({ type: "approval_response", chatId: agentId, id, approved });
      dispatch({ type: "resolve_approval", id });
    },
    [agentId, sendWs]
  );

  const submitA2UI = useCallback(
    (payload: {
      blockId: string;
      actionId: string;
      actionLabel: string;
      values: Record<string, string | number | boolean | string[]>;
    }) => {
      sendWs({ type: "a2ui_submit", chatId: agentId, ...payload });
      dispatch({ type: "resolve_a2ui", blockId: payload.blockId });
    },
    [agentId, sendWs]
  );

  return { state, send: doSend, stop, respondApproval, submitA2UI };
}
