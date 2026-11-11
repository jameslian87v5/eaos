/**
 * connector-feishu-oauth.ts — Octop absorption M2b
 * (codex evt_20261021015806-m2b-instruction.md).
 *
 * Feishu docs OAuth connector: host-side authorize/token exchange + refresh.
 * Iron rules (instruction §Contract-first state model):
 *   - OAuth state is one-time, random 256-bit, bound to instance + actor
 *     org/user + PKCE verifier + redirect URI + short expiry. Replay and the
 *     consume-race fail CLOSED: the state is deleted BEFORE the code exchange
 *     starts, so a second callback with the same state can never start a
 *     second exchange.
 *   - The callback trusts ONLY the state record — never browser-provided
 *     identity or token claims.
 *   - Client secret / access token / refresh token stay AES-GCM host-side
 *     (connector-store oauth_ciphertext); API responses expose status/expiry
 *     only; tokens are never logged or audited.
 *   - Refresh is serialized per instance and the refresh token is used ONCE.
 *   - Endpoints are fixed (HTTPS Feishu allowlist); CONNECTOR_FEISHU_BASE_URL
 *     overrides all three with one base for local test fakes only — mirroring
 *     the CONNECTOR_MCP_BASE_URL test seam, an operator env, not request input.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import {
  getCatalogEntry,
  getInstance,
  getOAuthTokensForHost,
  markOAuthFailed,
  setOAuthPending,
  writeOAuthTokens,
} from "./connector-store.js";
import { decryptCredentialsForHost } from "./connector-store.js";
import type { RequestContext } from "./request-context.js";

// ─── Fixed endpoints (env override = test seam) ────────────────

const FEISHU_ALLOWED_HOSTS = new Set(["open.feishu.cn", "accounts.feishu.cn"]);

function endpoints(): { authorize: URL; token: URL; api: URL } {
  const override = process.env.CONNECTOR_FEISHU_BASE_URL;
  if (override) {
    const base = new URL(override);
    return {
      authorize: new URL("/authen/v1/authorize", base),
      token: new URL("/authen/v2/oauth/token", base),
      api: new URL("/open-apis", base),
    };
  }
  return {
    authorize: new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize"),
    token: new URL("https://open.feishu.cn/open-apis/authen/v2/oauth/token"),
    api: new URL("https://open.feishu.cn/open-apis"),
  };
}

/** Assert production endpoints stay on the fixed HTTPS allowlist (defense in
 * depth — the catalog pins these; this guards accidental endpoint drift). */
function assertEndpointPolicy(): void {
  const { authorize, token, api } = endpoints();
  for (const u of [authorize, token, api]) {
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
      throw new Error(`feishu endpoint must be HTTPS: ${u.hostname}`);
    }
    if (u.protocol === "https:" && !FEISHU_ALLOWED_HOSTS.has(u.hostname)) {
      throw new Error(`feishu endpoint host not allowlisted: ${u.hostname}`);
    }
  }
}

export const CALLBACK_PATH = "/api/connectors/oauth/feishu/callback";

/**
 * M2b fix round #1: the OAuth redirect URI authority is OPERATOR-CONFIGURED
 * (`CONNECTOR_OAUTH_PUBLIC_BASE_URL`), never derived from Host /
 * X-Forwarded-* / request input — a proxied or poisoned header must not be
 * able to move the redirect authority. Normalized to ORIGIN-ONLY HTTPS
 * (loopback HTTP is the local test seam, mirroring the endpoint policy).
 */
export function oauthPublicOrigin(): string {
  const raw = process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL;
  if (!raw) {
    throw new Error(
      "CONNECTOR_OAUTH_PUBLIC_BASE_URL 未配置：OAuth redirect URI 必须由运维配置的公共 HTTPS origin 构造（不信任请求头）"
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CONNECTOR_OAUTH_PUBLIC_BASE_URL 无法解析为 URL: ${raw.slice(0, 60)}`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`CONNECTOR_OAUTH_PUBLIC_BASE_URL 必须是 HTTPS origin（仅 loopback HTTP 为测试豁免）: ${parsed.origin}`);
  }
  // Origin-only: any path/query on the configured value is dropped.
  return parsed.origin;
}

function redirectUri(): string {
  return `${oauthPublicOrigin()}${CALLBACK_PATH}`;
}

/** Host-side Feishu API base for internal-MCP tool calls (fixed endpoint
 * policy; env override = test seam, same as the token/authorize endpoints). */
export function feishuApiBase(): URL {
  return endpoints().api;
}

function stateTtlMs(): number {
  const raw = Number(process.env.CONNECTOR_OAUTH_STATE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(900_000, raw) : 600_000;
}

const EXPIRY_SKEW_MS = 60_000;

// ─── One-time state store (in-memory, consume-before-exchange) ─

interface OAuthStateRecord {
  instanceId: string;
  actorUserId: string;
  actorRole: string;
  orgId: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

const pendingStates = new Map<string, OAuthStateRecord>();

/** Atomically consume a state. Returns null when absent/expired — replay and
 * the consume race both land here (single-threaded delete-first). */
function consumeState(state: string, expectedRedirectUri: string): OAuthStateRecord | null {
  const record = pendingStates.get(state);
  if (!record) return null;
  pendingStates.delete(state);
  if (record.expiresAt <= Date.now()) return null;
  if (record.redirectUri !== expectedRedirectUri) return null;
  return record;
}

// ─── Token exchange / refresh (host-side, secrets never logged) ─

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function postToken(
  body: Record<string, string>,
  secrets: string[]
): Promise<{ ok: true; tokens: TokenResponse } | { ok: false; error: string }> {
  const { token } = endpoints();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(token, {
      method: "POST",
      redirect: "manual", // never follow — client secret must not leave the endpoint
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: `token endpoint redirect rejected (status ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, error: `token endpoint HTTP ${res.status}` };
    }
    const parsed = (await res.json().catch(() => null)) as TokenResponse | null;
    if (!parsed?.access_token || !parsed.refresh_token || !Number.isFinite(parsed.expires_in)) {
      return { ok: false, error: "token endpoint returned incomplete token payload" };
    }
    return { ok: true, tokens: parsed };
  } catch (err: any) {
    if (err?.name === "AbortError") return { ok: false, error: "token endpoint timeout" };
    // Error text is scrubbed of secrets before it can surface anywhere.
    const raw = String(err?.message ?? err).slice(0, 200);
    return { ok: false, error: secrets.reduce((t, s) => (s ? t.split(s).join("[REDACTED]") : t), raw) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Authorization start (admin route target) ──────────────────

export function startAuthorization(
  ctx: RequestContext,
  instanceId: string
): { authorizeUrl: string } {
  const instance = getInstance(instanceId); // throws ConnectorNotFoundError
  const entry = getCatalogEntry(instance.catalogKind);
  if (!entry || entry.authKind !== "oauth2") {
    throw new Error("该实例不是 OAuth 类型 connector");
  }
  if (!instance.credentialsPresent) {
    throw new Error("先写入 App 凭证（clientId/clientSecret）才能发起授权");
  }
  assertEndpointPolicy();
  const credentials = decryptCredentialsForHost(instanceId);
  if (!credentials?.clientId || !credentials.clientSecret) {
    throw new Error("App 凭证不完整（clientId/clientSecret）");
  }
  const uri = redirectUri(); // throws BEFORE any state is created on bad config
  // One pending flow per instance: earlier states for this instance die now.
  for (const [state, record] of pendingStates) {
    if (record.instanceId === instanceId) pendingStates.delete(state);
  }
  const state = randomBytes(32).toString("base64url"); // 256-bit one-time
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  pendingStates.set(state, {
    instanceId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId: ctx.orgId,
    verifier,
    redirectUri: uri,
    expiresAt: Date.now() + stateTtlMs(),
  });
  setOAuthPending(instanceId);
  const { authorize } = endpoints();
  const url = new URL(authorize);
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", uri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: url.toString() };
}

// ─── Callback (unauthenticated; trusts ONLY the consumed state) ─

/**
 * `auditable` = the failure happened AFTER a valid state was consumed
 * (instance/credential/token-exchange leg). A state that was never valid is
 * NOT audited — an unauthenticated attacker replaying random states must not
 * be able to write audit rows (M2b fix round #2).
 */
export type OAuthCallbackOutcome =
  | { ok: true }
  | { ok: false; error: string; auditable: boolean };

export async function handleOAuthCallback(
  req: Request
): Promise<OAuthCallbackOutcome> {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  // Redirect authority is the configured public origin — request headers
  // (Host / X-Forwarded-*) are deliberately never consulted. Bad/missing
  // config fails before the state is consumed (nothing persisted, no audit).
  let uri: string;
  try {
    uri = redirectUri();
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), auditable: false };
  }
  const record = state && code ? consumeState(state, uri) : null;
  if (!record) {
    // No state echo (side channel), no code echo (one-time material), no audit.
    return { ok: false, error: "oauth state 无效或已过期", auditable: false };
  }
  const instance = getInstanceSafe(record.instanceId);
  if (!instance) return { ok: false, error: "connector 实例不存在", auditable: true };
  const credentials = decryptCredentialsForHost(record.instanceId);
  if (!credentials?.clientId || !credentials.clientSecret) {
    markOAuthFailed(record.instanceId);
    return { ok: false, error: "app 凭证缺失，授权失败", auditable: true };
  }
  const outcome = await postToken(
    {
      grant_type: "authorization_code",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      code_verifier: record.verifier,
      redirect_uri: record.redirectUri,
    },
    [credentials.clientSecret, code]
  );
  if (!outcome.ok) {
    markOAuthFailed(record.instanceId);
    return { ok: false, error: outcome.error, auditable: true };
  }
  const expiresAt = new Date(Date.now() + outcome.tokens.expires_in * 1000).toISOString();
  writeOAuthTokens(record.instanceId, {
    accessToken: outcome.tokens.access_token,
    refreshToken: outcome.tokens.refresh_token,
    expiresAt,
  });
  return { ok: true };
}

function getInstanceSafe(id: string) {
  try {
    return getInstance(id);
  } catch {
    return null;
  }
}

// ─── Per-call access token (serialized refresh, single-use) ────

const refreshInFlight = new Map<string, Promise<string>>();

function refreshAccessToken(instanceId: string): Promise<string> {
  const existing = refreshInFlight.get(instanceId);
  if (existing) return existing; // serialized per instance
  const task = (async () => {
    const tokens = getOAuthTokensForHost(instanceId);
    const credentials = decryptCredentialsForHost(instanceId);
    if (!tokens?.refreshToken || !credentials?.clientId || !credentials.clientSecret) {
      markOAuthFailed(instanceId);
      throw new Error("oauth 授权已失效，需要重新授权");
    }
    const outcome = await postToken(
      {
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: tokens.refreshToken,
      },
      [credentials.clientSecret, tokens.refreshToken, tokens.accessToken]
    );
    if (!outcome.ok) {
      markOAuthFailed(instanceId);
      throw new Error(`oauth refresh 失败: ${outcome.error}`);
    }
    // Refresh token is single-use: the new pair replaces the old atomically.
    const expiresAt = new Date(Date.now() + outcome.tokens.expires_in * 1000).toISOString();
    writeOAuthTokens(instanceId, {
      accessToken: outcome.tokens.access_token,
      refreshToken: outcome.tokens.refresh_token,
      expiresAt,
    });
    return outcome.tokens.access_token;
  })().finally(() => refreshInFlight.delete(instanceId));
  refreshInFlight.set(instanceId, task);
  return task;
}

/** Valid (refreshed if needed) user access token for host-side API calls.
 * Throws when authorization is missing/expired/failed — callers deny the call.
 * The returned token must NEVER be logged, echoed, or audited. */
export async function getValidAccessToken(instanceId: string): Promise<string> {
  const tokens = getOAuthTokensForHost(instanceId);
  if (!tokens) throw new Error("oauth 授权缺失");
  const expiresAtMs = new Date(tokens.expiresAt).getTime();
  if (Number.isFinite(expiresAtMs) && expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
    return tokens.accessToken;
  }
  return refreshAccessToken(instanceId);
}
