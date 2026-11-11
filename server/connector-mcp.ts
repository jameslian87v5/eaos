/**
 * connector-mcp.ts — Octop absorption M1b
 * (codex evt_20261020073311-m1b-instruction.md §2/§4/§5).
 *
 * Host-only MCP Streamable HTTP endpoint bound to ONE connector instance:
 *   POST /api/mcp/connectors/:instanceId   (JSON-RPC; plain application/json
 *   responses, no session state — every request is independently verified)
 *
 * Per-call revalidation (§5) — EVERY request re-establishes:
 *   1. capability-token signature + audience + expiry + active jti (registry);
 *   2. token binding: claims.connectorInstanceId === route instanceId;
 *   3. connector instance state: enabled + credentialsPresent + token
 *      configVersion === current instance config_version (rotation kills stale
 *      tokens immediately);
 *   4. catalog kind valid + requested tool ∈ catalog allowedTools ∩ token
 *      allowedTools;
 *   5. the CURRENT authorization intersection (app allowlist ∩ activation ∩
 *      entitlement ∩ registration) via resolveEnabledResourceIdsForApp with the
 *      orgId/userId/role bound in the token (server-trusted at mint time).
 *   Any mismatch = deny (HTTP 401 / JSON-RPC error, metadata-only audit).
 *
 * `rest_request` tool contract (§4): the agent may choose ONLY
 * {method GET|POST, path, query, body}. Absolute/protocol-relative paths,
 * backslash origin tricks, non-GET/POST, oversized bodies, upstream redirects
 * (redirect:"manual" — never followed, never cross-origin re-auth) are all
 * rejected. URL is assembled host-side from the stored base URL; the stored
 * credential is injected host-side as `Authorization: Bearer <apiToken>` and
 * NEVER appears in any response, log, or audit.
 */

import express from "express";
import type { Request, Response } from "express";
import {
  ConnectorTokenError,
  verifyConnectorToken,
  type ConnectorTokenClaims,
} from "./connector-capability-token.js";
import {
  getCatalogEntry,
  getInstance,
  decryptCredentialsForHost,
  getOAuthTokensForHost,
  type ConnectorInstanceView,
} from "./connector-store.js";
import { feishuApiBase, getValidAccessToken } from "./connector-feishu-oauth.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { writeGovernanceAudit } from "./org-governance.js";
import { getUserById } from "./auth.js";
import { applicationService } from "./application-service.js";

// ─── Tunables (bounded, safe defaults) ────────────────────────

const REST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CONNECTOR_REST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(120_000, raw) : 10_000;
})();
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

// ─── Per-call revalidation ────────────────────────────────────

function denyAudit(claims: ConnectorTokenClaims | null, instanceId: string, reason: string): void {
  writeGovernanceAudit({
    actorUserId: claims?.userId,
    actorRole: claims?.role,
    orgId: claims?.orgId ?? "default-org",
    action: "connector.mcp.deny",
    objectType: "connector_instance",
    objectId: instanceId,
    result: "denied",
    reasonSummary: reason, // metadata only — never token, credential, or payload
  });
}

function reauthorize(
  rawToken: string,
  instanceId: string,
  toolName: string | null
): { claims: ConnectorTokenClaims; instance: ConnectorInstanceView } | { error: string } {
  let claims: ConnectorTokenClaims;
  try {
    claims = verifyConnectorToken(rawToken);
  } catch (err: any) {
    return { error: err?.message ?? "invalid token" };
  }
  if (claims.connectorInstanceId !== instanceId) {
    return { error: "token not bound to this connector instance" };
  }
  const instance = getInstance(instanceId); // throws 404-shaped if missing
  if (instance.status !== "enabled" || !instance.credentialsPresent) {
    return { error: "connector instance not enabled or credentials missing" };
  }
  // M2b: oauth2 kinds need an authorization record that is not
  // none/pending/failed. "expired" passes the gate — the call path refreshes;
  // a refresh failure becomes a tool error (never a silent pass).
  if (instance.authorization && instance.authorization.status !== "authorized" && instance.authorization.status !== "expired") {
    return { error: `oauth authorization ${instance.authorization.status} — call denied` };
  }
  if (claims.configVersion !== instance.configVersion) {
    return { error: "stale token configVersion (connector reconfigured)" };
  }
  const entry = getCatalogEntry(instance.catalogKind);
  if (!entry) return { error: "connector catalog kind unknown" };
  if (toolName !== null) {
    if (!claims.allowedTools.includes(toolName)) {
      return { error: `tool not allowed by token: ${toolName}` };
    }
    if (!entry.allowedTools.includes(toolName)) {
      return { error: `tool not allowed by catalog: ${toolName}` };
    }
  }
  // DB-authoritative principal (M1b fix #2): frozen token claims are NOT
  // trusted for authority. The CURRENT user state and the agent's CURRENT app
  // binding are reloaded from the DB on every call; any drift (role change,
  // org move, app move, user disabled/deleted) is an immediate deny.
  const user = getUserById(claims.userId);
  if (!user || user.status !== "active") {
    return { error: "token user missing or disabled" };
  }
  if (user.role !== claims.role) {
    return { error: "user role changed since token mint" };
  }
  if (user.orgId !== claims.orgId) {
    return { error: "user org changed since token mint" };
  }
  const currentAppId = applicationService.getAppIdForAgent(claims.agentId);
  if (currentAppId !== claims.appId) {
    return { error: "agent app binding changed since token mint" };
  }
  // Current authorization intersection (deny-by-intersection, re-derived NOW
  // from the DB-authoritative role/org/appId).
  const gated = agentCapabilityService.resolveEnabledResourceIdsForApp(
    { userId: user.id, role: user.role, orgId: user.orgId },
    claims.agentId,
    currentAppId
  );
  if (!gated.includes(`connector:${instanceId}`)) {
    return { error: "connector no longer authorized for this agent" };
  }
  return { claims, instance };
}

// ─── rest_request execution (host-side guards) ────────────────

const VALID_METHODS = new Set(["GET", "POST"]);

function buildUpstreamUrl(instance: ConnectorInstanceView, args: Record<string, unknown>): URL {
  const { method, path, query } = args as {
    method?: unknown;
    path?: unknown;
    query?: unknown;
  };
  if (typeof method !== "string" || !VALID_METHODS.has(method.toUpperCase())) {
    throw new Error("method 必须是 GET 或 POST");
  }
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path 必须是非空字符串");
  }
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\x00-\x1f]/.test(path)
  ) {
    throw new Error("path 必须是以单个 / 开头的相对路径（禁止绝对/协议相对/反斜杠路径）");
  }
  if (query !== undefined) {
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      throw new Error("query 必须是对象");
    }
    for (const v of Object.values(query)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new Error("query 值必须是原始类型");
      }
    }
  }
  const base = new URL(instance.baseUrl);
  // M1b fix #4: preserve the configured base path PREFIX — the agent-relative
  // path joins AFTER it ("/api/v1" + "/hello" → "/api/v1/hello"), with
  // duplicate slashes collapsed from the concatenation seams only.
  const basePath = base.pathname.replace(/\/+$/, "");
  const relPath = path.replace(/^\/+/, "");
  const joined = `${basePath}/${relPath}`.replace(/([^:])\/{2,}/g, "$1/");
  const url = new URL(joined, base);
  // Origin pin: even a path that somehow parses absolute must land on the
  // stored base origin. Belt-and-braces behind the path guards above.
  if (url.origin !== base.origin) {
    throw new Error("path escapes the connector base origin");
  }
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

// M1b fix #1: an upstream that echoes its Authorization header would return
// the raw credential / the current capability token verbatim in tool output.
// Every outbound text is scrubbed of BOTH secrets before it leaves the host.
function sanitizeSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

async function executeRestRequest(
  instance: ConnectorInstanceView,
  args: Record<string, unknown>,
  rawToken: string
): Promise<{ ok: boolean; text: string }> {
  const url = buildUpstreamUrl(instance, args); // throws on bad shape → tool error
  const method = String(args.method).toUpperCase();
  const credentials = decryptCredentialsForHost(instance.id);
  if (!credentials?.apiToken) {
    // Reauthorize already guaranteed credentialsPresent; treat as deny.
    return { ok: false, text: "connector credential unavailable" };
  }
  const secrets = [credentials.apiToken, rawToken];
  let body: string | undefined;
  if (method === "POST") {
    const raw = args.body;
    if (raw === undefined || raw === null) {
      throw new Error("POST 必须提供 body 对象");
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("body 必须是对象");
    }
    body = JSON.stringify(raw);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      throw new Error(`body 超过 ${MAX_BODY_BYTES} 字节上限`);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual", // never follow — Authorization must not leave the origin
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      // Bounded: status only — no Location echo (could carry payloads).
      return { ok: false, text: `上游重定向被拒绝（status ${res.status}；不跟随重定向）` };
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      return { ok: false, text: `上游响应超过 ${MAX_RESPONSE_BYTES} 字节上限（status ${res.status}）` };
    }
    // Bounded read (M1b fix #5): stream up to the cap exactly once — the
    // over-cap chunk is pushed as its bounded remainder, never twice.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > MAX_RESPONSE_BYTES) {
          const remaining = MAX_RESPONSE_BYTES - received;
          if (remaining > 0) chunks.push(value.subarray(0, remaining));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        received += value.byteLength;
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (res.ok) {
      return {
        ok: true,
        text: sanitizeSecrets(
          JSON.stringify({
            status: res.status,
            contentType: res.headers.get("content-type") ?? "",
            truncated,
            body: text,
          }),
          secrets
        ),
      };
    }
    // Bounded error surface: status + truncated body, sanitized as JSON string.
    return {
      ok: false,
      text: sanitizeSecrets(
        JSON.stringify({
          status: res.status,
          contentType: res.headers.get("content-type") ?? "",
          truncated,
          body: text.slice(0, 2048),
        }),
        secrets
      ),
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, text: `上游请求超时（${REST_TIMEOUT_MS}ms）` };
    }
    return {
      ok: false,
      text: sanitizeSecrets(`上游请求失败: ${String(err?.message ?? err).slice(0, 200)}`, secrets),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── MCP tool descriptors (catalog allowedTools only) ─────────

const REST_REQUEST_TOOL = {
  name: "rest_request",
  description:
    "调用已配置的内部 REST 服务。只能指定 method(GET/POST)、path（以单个 / 开头的相对路径）、query（原始值对象）、body（POST 的 JSON 对象）。URL 与凭证由宿主固定，不能指定绝对地址、协议、headers 或 Authorization。",
  inputSchema: {
    type: "object" as const,
    properties: {
      method: { type: "string", enum: ["GET", "POST"] },
      path: { type: "string" },
      query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      body: { type: "object" },
    },
    required: ["method", "path"],
  },
};

// M2b: Feishu docs tools — the agent chooses ONLY the query / doc_id. The
// user access token, endpoints, headers, and scopes are host-side fixed.
const SEARCH_DOCS_TOOL = {
  name: "search_docs",
  description:
    "按关键词搜索飞书文档。只传 query；搜索端点与用户授权由宿主固定（OAuth 用户 token 仅 host 侧使用）。",
  inputSchema: {
    type: "object" as const,
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const GET_DOC_TOOL = {
  name: "get_doc",
  description: "按 doc_id 读取飞书文档的纯文本内容（宿主侧限流、截断与脱敏）。",
  inputSchema: {
    type: "object" as const,
    properties: { doc_id: { type: "string" } },
    required: ["doc_id"],
  },
};

function toolDescriptor(name: string) {
  switch (name) {
    case "rest_request": return REST_REQUEST_TOOL;
    case "search_docs": return SEARCH_DOCS_TOOL;
    case "get_doc": return GET_DOC_TOOL;
    default: return { name, description: name, inputSchema: { type: "object" as const } };
  }
}

// ─── M2b: Feishu docs execution (host-side, user access token) ─

function validateDocId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new Error("doc_id 必须是 1–64 位字母/数字/-/_（禁止路径片段）");
  }
  return raw;
}

async function executeFeishuApi(
  instance: ConnectorInstanceView,
  method: "GET" | "POST",
  path: string,
  bodyObj: Record<string, unknown> | undefined,
  rawToken: string
): Promise<{ ok: boolean; text: string }> {
  // Throws when authorization is missing/expired/failed — becomes a TOOL error.
  const accessToken = await getValidAccessToken(instance.id);
  const base = feishuApiBase();
  // Join AFTER the base path prefix ("/open-apis" + "/suite/..." — a leading-
  // slash path would otherwise REPLACE the base pathname in URL resolution).
  const joined = `${base.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const url = new URL(joined, base);
  if (url.origin !== base.origin) {
    throw new Error("feishu path escapes the fixed API origin");
  }
  const body = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
  const tokens = getOAuthTokensForHost(instance.id);
  const creds = decryptCredentialsForHost(instance.id);
  const secrets = [accessToken, tokens?.refreshToken, creds?.clientSecret, rawToken];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual", // never follow — the user token must not leave the origin
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, text: `飞书重定向被拒绝（status ${res.status}；不跟随重定向）` };
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      return { ok: false, text: `飞书响应超过 ${MAX_RESPONSE_BYTES} 字节上限（status ${res.status}）` };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > MAX_RESPONSE_BYTES) {
          const remaining = MAX_RESPONSE_BYTES - received;
          if (remaining > 0) chunks.push(value.subarray(0, remaining));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        received += value.byteLength;
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return {
      ok: res.ok,
      text: sanitizeSecrets(
        JSON.stringify({
          status: res.status,
          contentType: res.headers.get("content-type") ?? "",
          truncated,
          body: res.ok ? text : text.slice(0, 2048),
        }),
        secrets
      ),
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, text: `飞书请求超时（${REST_TIMEOUT_MS}ms）` };
    }
    return {
      ok: false,
      text: sanitizeSecrets(`飞书请求失败: ${String(err?.message ?? err).slice(0, 200)}`, secrets),
    };
  } finally {
    clearTimeout(timer);
  }
}

function executeFeishuTool(
  instance: ConnectorInstanceView,
  name: string,
  args: Record<string, unknown>,
  rawToken: string
): Promise<{ ok: boolean; text: string }> {
  if (name === "search_docs") {
    const query = args.query;
    if (typeof query !== "string" || !query.trim() || query.length > 256) {
      return Promise.resolve({ ok: false, text: "query 必须是 1–256 字符的字符串" });
    }
    return executeFeishuApi(
      instance, "POST", "/suite/docs-api/search/object",
      { search_query: query.trim(), page_size: 20 }, rawToken
    );
  }
  // get_doc
  const docId = validateDocId(args.doc_id);
  return executeFeishuApi(instance, "GET", `/docx/v1/documents/${encodeURIComponent(docId)}/raw_content`, undefined, rawToken);
}

// ─── JSON-RPC dispatch ────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function handleRpc(
  instanceId: string,
  message: JsonRpcRequest,
  authed: { claims: ConnectorTokenClaims; instance: ConnectorInstanceView } | null
): unknown {
  const { method, id } = message;
  if (method === "initialize") {
    if (!authed) return rpcError(id, -32001, "unauthorized");
    return rpcResult(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: `connector-${instanceId}`, version: "1.0.0-m1b" },
    });
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
    return NOTIFICATION; // caller answers 202 with no body
  }
  if (method === "ping") {
    if (!authed) return rpcError(id, -32001, "unauthorized");
    return rpcResult(id, {});
  }
  if (method === "tools/list") {
    if (!authed) return rpcError(id, -32001, "unauthorized");
    const entry = getCatalogEntry(authed.instance.catalogKind);
    const tools = entry ? entry.allowedTools.map(toolDescriptor) : [];
    return rpcResult(id, { tools });
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

const NOTIFICATION = Symbol("notification");

async function handleRpcAsync(
  req: Request,
  res: Response,
  instanceId: string,
  message: JsonRpcRequest
): Promise<void> {
  if (process.env.CONNECTOR_MCP_DEBUG) {
    console.log(`[connector-mcp:debug] ${req.method} /${instanceId} rpc=${String(message.method)} hasToken=${bearerToken(req) !== null}`);
  }
  const token = bearerToken(req);
  if (!token) {
    denyAudit(null, instanceId, "missing bearer token");
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const toolName =
    message.method === "tools/call" && typeof message.params?.name === "string"
      ? String(message.params.name)
      : null;
  let authed: { claims: ConnectorTokenClaims; instance: ConnectorInstanceView } | null = null;
  let authError: string | null = null;
  try {
    const outcome = reauthorize(token, instanceId, toolName);
    if ("error" in outcome) {
      authError = outcome.error;
    } else {
      authed = outcome;
    }
  } catch (err: any) {
    authError = err?.message ?? "instance not found";
  }
  if (authError) {
    denyAudit(null, instanceId, authError);
    res.status(401).json({ error: authError });
    return;
  }
  // tools/call: arg/execution failures are TOOL errors (isError), not HTTP errors.
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    const entry = getCatalogEntry(authed!.instance.catalogKind);
    if (
      !entry ||
      !entry.allowedTools.includes(name) ||
      !authed!.claims.allowedTools.includes(name)
    ) {
      res.json(rpcResult(message.id, {
        content: [{ type: "text", text: `tool not allowed: ${name}` }],
        isError: true,
      }));
      return;
    }
    let outcome: { ok: boolean; text: string };
    try {
      outcome =
        entry.authKind === "oauth2"
          ? await executeFeishuTool(authed!.instance, name, args, token)
          : await executeRestRequest(authed!.instance, args, token);
    } catch (err: any) {
      outcome = { ok: false, text: String(err?.message ?? err) };
    }
    res.json(rpcResult(message.id, { content: [{ type: "text", text: outcome.text }], isError: !outcome.ok }));
    return;
  }
  const response = handleRpc(instanceId, message, authed);
  if (response === NOTIFICATION) {
    // .end() is required — a status without a body send leaves the response
    // hanging and the MCP client never completes its initialized handshake.
    res.status(202).end();
    return;
  }
  res.json(response);
}

// ─── Router ───────────────────────────────────────────────────

export function createInternalConnectorMcpRoutes(): express.Router {
  const router = express.Router();

  // Streamable HTTP: POST carries JSON-RPC. GET (SSE stream) is not offered —
  // this host endpoint is stateless request/response by design. Batches are
  // rejected (protocol defensiveness; the SDK sends single messages).
  router.post("/:instanceId", express.json({ limit: "1mb" }), async (req, res) => {
    const instanceId = req.params.instanceId;
    try {
      const body = req.body;
      if (Array.isArray(body)) {
        res.status(400).json(rpcError(null, -32600, "batch requests not supported"));
        return;
      }
      await handleRpcAsync(req, res, instanceId, body as JsonRpcRequest);
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(400).json(rpcError(null, -32700, `parse error: ${String(err?.message ?? err).slice(0, 200)}`));
      }
    }
  });

  router.get("/:instanceId", (req, res) => {
    if (process.env.CONNECTOR_MCP_DEBUG) {
      console.log(`[connector-mcp:debug] GET /${req.params.instanceId} (SSE attempt → 405)`);
    }
    res.status(405).json({ error: "SSE stream not supported; POST JSON-RPC only" });
  });

  return router;
}
