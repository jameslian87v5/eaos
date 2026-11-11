import { Router, type NextFunction, type Request, type RequestHandler, type Response as ExpressResponse } from "express";

const DEFAULT_TIMEOUT_MS = 5_000;
const SEARCH_LIMIT = 200;

interface HubFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<HubFetchResponse>;

export interface HubCatalogItem {
  name: string;
  description: string | null;
  namespace: string | null;
  updatedAt: string | null;
  version: string | null;
}

export interface HubCatalogResponse {
  hubOnline: boolean;
  items: HubCatalogItem[];
}

export interface HubCatalogConfig {
  baseUrl?: string | null;
  token?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function clean(value: unknown, max = 500, secrets: string[] = []): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let result = value.trim().slice(0, max);
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

function mapItem(raw: any, secrets: string[]): HubCatalogItem | null {
  const name = clean(raw?.displayName ?? raw?.display_name ?? raw?.name ?? raw?.slug, 120, secrets);
  if (!name) return null;
  return {
    name,
    description: clean(raw?.summary ?? raw?.description, 1_000, secrets),
    namespace: clean(raw?.namespace ?? raw?.namespaceSlug ?? raw?.namespace_slug, 120, secrets),
    updatedAt: clean(raw?.updatedAt ?? raw?.updated_at, 80, secrets),
    version: clean(raw?.latestVersion ?? raw?.latest_version ?? raw?.version, 80, secrets),
  };
}

export async function fetchSkillsHubCatalog(config: HubCatalogConfig = {}): Promise<HubCatalogResponse> {
  const baseUrl = config.baseUrl ?? process.env.SKILLHUB_URL;
  const token = config.token ?? process.env.SKILLHUB_TOKEN;
  if (!baseUrl || !token) return { hubOnline: false, items: [] };

  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/cli/v1/skills/search?limit=${SEARCH_LIMIT}`;
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const body: any = await response.json();
    if (!response.ok || body?.code !== 0) return { hubOnline: false, items: [] };
    const rawItems = Array.isArray(body?.data?.items)
      ? body.data.items
      : Array.isArray(body?.data)
        ? body.data
        : [];
    return {
      hubOnline: true,
      items: rawItems
        .slice(0, SEARCH_LIMIT)
        .map((item: unknown) => mapItem(item, [token, baseUrl, baseUrl.replace(/\/$/, "")]))
        .filter(Boolean) as HubCatalogItem[],
    };
  } catch {
    return { hubOnline: false, items: [] };
  } finally {
    clearTimeout(timer);
  }
}

export function createSkillsHubCatalogRouter(
  authMiddleware: (req: Request, res: ExpressResponse, next: NextFunction) => unknown,
  config: HubCatalogConfig = {},
): Router {
  const router = Router();
  router.get("/hub-catalog", authMiddleware as RequestHandler, async (_req, res) => {
    res.json(await fetchSkillsHubCatalog(config));
  });
  return router;
}
