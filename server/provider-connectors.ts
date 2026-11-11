/**
 * provider-connectors.ts — M5 (docs/开发计划/model-and-token-management-plan.md §6.2, §9-M5).
 *
 * Server-side whitelist of provider connectors. An admin PREVIEWS a provider's
 * model list, checks a subset, and imports it into the Model Catalog.
 *
 * 安全铁律 (event M5-4 / M5-6 / plan §6.2):
 *   - NO arbitrary URL. The connector id is whitelisted; each connector has a
 *     HARDCODED base URL. The request never carries a URL — only a provider id
 *     validated against this whitelist. (plan: "暂不支持从前端输入任意 URL")
 *   - Credentials live ONLY in process.env / a server Secret Store — never in
 *     the request, never persisted to the DB, never returned to the browser,
 *     never written into an audit payload. The `configured` flag is the only
 *     credential-derived signal that leaves the server, and it is boolean.
 *   - Outbound calls are bounded by AbortController (PROVIDER_TIMEOUT_MS).
 *
 * Import scope (event M5-3): import ONLY touches model_catalog. It never
 * authorizes an org (org_model_entitlements), sets a default
 * (org_model_policy), or switches a Chat (chats/agents model_override).
 */

// Hardcoded connector whitelist. Adding a provider = adding an entry here with
// a hardcoded base URL. There is no "generic URL" connector by design.
interface Connector {
  id: string;
  name: string;
  /** Env var name holding the API key. Absent → not_configured. */
  apiKeyEnv: string;
  /** Hardcoded base URL (no trailing slash). */
  baseUrl: string;
  /** Build the Authorization/header set from the key. Never logs the key. */
  headers: (apiKey: string) => Record<string, string>;
  /** Normalize the provider's /models response → {id, displayName?, contextWindow?}. */
  parseList: (body: unknown) => ProviderModel[];
  /** Path appended to baseUrl for the models list. */
  modelsPath: string;
}

export interface ProviderModel {
  /** The provider's canonical model id (→ model_catalog.model_id). */
  id: string;
  displayName?: string;
  contextWindowTokens?: number | null;
}

export type ProviderListStatus =
  | "ok"
  | "not_configured"
  | "timeout"
  | "auth_failed"
  | "unavailable"
  | "error";

export interface ProviderListResult {
  status: ProviderListStatus;
  models: ProviderModel[];
  /** Safe human message — NEVER contains the API key or raw response body. */
  message?: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  /** True when the connector's env key is present (boolean — no key material). */
  configured: boolean;
}

/** Minimal fetch shape the connector needs. Global `fetch` satisfies this
 *  structurally (Response has ok/status/json); tests inject a stub of the same
 *  shape without faking the full Response interface. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; method?: string }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const CONNECTORS: Connector[] = [
  {
    id: "zhipu",
    name: "智谱 (Zhipu)",
    apiKeyEnv: "ZHIPU_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelsPath: "/models",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    parseList: (body) => {
      const arr = extractModelsArray(body);
      return arr.map((m) => normalizeProviderModel(m)).filter((m) => m.id);
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    modelsPath: "/v1/models",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    parseList: (body) => {
      const arr = extractModelsArray(body);
      return arr.map((m) => normalizeProviderModel(m)).filter((m) => m.id);
    },
  },
];

function extractModelsArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const r = body as Record<string, unknown>;
    if (Array.isArray(r.data)) return r.data as unknown[];
    if (Array.isArray(r.models)) return r.models as unknown[];
  }
  return [];
}

function normalizeProviderModel(m: unknown): ProviderModel {
  if (!m || typeof m !== "object") return { id: "" };
  const r = m as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : typeof r.name === "string" ? r.name.trim() : "";
  const displayName =
    typeof r.display_name === "string" ? r.display_name :
    typeof r.displayName === "string" ? r.displayName :
    undefined;
  const ctxRaw = r.context_window ?? r.contextWindowTokens ?? r.max_context_window ?? r.context_window_tokens;
  const contextWindowTokens =
    typeof ctxRaw === "number" && Number.isFinite(ctxRaw) && ctxRaw > 0 ? Math.trunc(ctxRaw) : null;
  return { id, displayName, contextWindowTokens: contextWindowTokens ?? undefined };
}

const PROVIDER_TIMEOUT_MS = 15_000;
const SAFE_STATUS = (s: number): ProviderListStatus =>
  s === 401 || s === 403 ? "auth_failed" : s === 408 || s === 504 ? "timeout" : s >= 500 ? "unavailable" : "error";

export function listProviders(): ProviderSummary[] {
  return CONNECTORS.map((c) => ({
    id: c.id,
    name: c.name,
    configured: Boolean(process.env[c.apiKeyEnv]),
  }));
}

export function getProvider(id: string): Connector | null {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

/** Fetch a provider's model list. `fetchImpl` is injectable for tests; the
 *  route layer calls with the default global fetch. Never throws — returns a
 *  typed result so the route can map status → HTTP without try/catch leaks. */
export async function listProviderModels(
  providerId: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<ProviderListResult> {
  const c = getProvider(providerId);
  if (!c) return { status: "error", models: [], message: `Unknown provider "${providerId}"` };
  const apiKey = process.env[c.apiKeyEnv];
  if (!apiKey) return { status: "not_configured", models: [], message: `Provider "${c.id}" 服务端凭证未配置` };

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return { status: "error", models: [], message: "No fetch implementation available" };
  const timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${c.baseUrl}${c.modelsPath}`, {
      method: "GET",
      headers: c.headers(apiKey),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { status: SAFE_STATUS(res.status), models: [], message: `Provider 返回 HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null);
    const models = c.parseList(body);
    if (models.length === 0) {
      return { status: "ok", models: [], message: "Provider 返回空模型列表" };
    }
    return { status: "ok", models };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/abort|timeout/i.test(msg) || controller.signal.aborted) {
      return { status: "timeout", models: [], message: `Provider 请求超时（${timeoutMs}ms）` };
    }
    return { status: "unavailable", models: [], message: `Provider 不可达：${msg.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}
