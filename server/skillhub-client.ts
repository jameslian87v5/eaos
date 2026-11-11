/**
 * skillhub-bridge.prod.ts's client — R5b-2 real-contract HTTP client for
 * iflytek/skillhub. Replaces the R5a fake assumptions (cursor pagination,
 * /api/v1/skills?namespace=, version-detail endpoint) with the REAL contract
 * verified against the live Hub (docs/06-deployment/skillhub-r5b2-contract-forensics.md):
 *
 *  - Envelope: { code, msg, data, timestamp, requestId }; code===0 success,
 *    else SkillhubApiError(httpCode, apiCode, msg). Unwrap .data.
 *  - listNamespaces: GET /api/v1/namespaces?page=&size= (VERIFIED live:
 *    data = {items, total, page, size} — custom pagination, NOT Spring
 *    PageResponse; client reads data.items and stops when page exhausts).
 *    Bearer token required (portal NamespaceController is authenticated).
 *  - listPublishedSkills(ns): GET /api/cli/v1/skills/search?limit= (CLI M2M;
 *    data.items[] each carries .namespace → filter client-side; `q` matches
 *    slug/name, NOT namespace).
 *  - getVersionDetail: GET /api/cli/v1/skills/{ns}/{slug}/resolve?version=
 *    → data.fingerprint is the content hash (no separate version-detail call).
 *  - downloadSkill: GET /api/cli/v1/skills/{ns}/{slug}/versions/{v}/download
 *    → application/zip; filename from Content-Disposition; compute local sha256
 *    for integrity verification (deny-wins if != fingerprint).
 *
 * No token/payload persisted; token used only for the Authorization header.
 * fetch is injectable (DI) for tests.
 */
export interface NamespaceInfo {
  slug: string;
  displayName: string;
  type: "GLOBAL" | "TEAM";
  status: string;
}
export interface SkillSummary {
  slug: string;
  displayName: string;
  namespaceSlug: string;
  latestVersion: string | null;
}
export interface VersionDetail {
  version: string;
  sha256: string | null;
  parsedMetadataJson: unknown;
  manifestJson: unknown;
}
export interface DownloadResult {
  localPath: string;
  sha256: string | null;
}

export class SkillhubApiError extends Error {
  readonly httpCode: number;
  readonly apiCode: number;
  constructor(httpCode: number, apiCode: number, msg: string) {
    super(msg);
    this.name = "SkillhubApiError";
    this.httpCode = httpCode;
    this.apiCode = apiCode;
  }
}

export interface SkillhubClient {
  listNamespaces(): Promise<NamespaceInfo[]>;
  listPublishedSkills(namespaceSlug: string): Promise<SkillSummary[]>;
  getVersionDetail(ns: string, slug: string, version: string): Promise<VersionDetail>;
  downloadSkill(ns: string, slug: string, version: string, destDir: string): Promise<DownloadResult>;
}

export interface CreateClientOptions {
  baseUrl: string;
  token: string;
  /** 可注入的 fetch(测试用 fake); 不传则用全局 fetch。 */
  fetchImpl?: AnyFetch;
  maxDownloadBytes?: number;
}

type AnyFetch = (url: string, init?: any) => Promise<any>;

const SEARCH_LIMIT = 1000; // CLI search has no offset/page; one large page covers
// the built-in scale (17 skills). If a namespace ever exceeds this, the sync
// logs a "namespace too large" error (fail-closed) rather than silently truncating.
const NS_PAGE_SIZE = 100;
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export function createSkillhubClient(opts: CreateClientOptions): SkillhubClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const fetchImpl: AnyFetch = (opts.fetchImpl as AnyFetch) ?? (fetch as AnyFetch);
  const headers = { Authorization: `Bearer ${opts.token}`, Accept: "application/json" };
  const maxDownloadBytes = opts.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes <= 0) {
    throw new TypeError("maxDownloadBytes must be a positive safe integer");
  }

  // GET + envelope unwrap. Throws SkillhubApiError on HTTP !ok or code!==0.
  async function getJson(path: string): Promise<any> {
    const url = `${baseUrl}${path}`;
    const res = await fetchImpl(url, { method: "GET", headers });
    let body: any;
    try { body = await res.json(); }
    catch {
      let text = "";
      try { text = await res.text(); } catch {}
      try { body = JSON.parse(text); }
      catch {
        throw new SkillhubApiError(res.status ?? 0, 0, `invalid JSON response (HTTP ${res.status ?? 0})`);
      }
    }
    if (!res.ok || body.code !== 0) {
      throw new SkillhubApiError(res.status ?? 0, body.code ?? res.status ?? 0, body.msg ?? `HTTP ${res.status}`);
    }
    return body.data;
  }

  return {
    // Real Portal /api/v1/namespaces response (VERIFIED live): envelope-wrapped,
    // data = {items, total, page, size} — a custom pagination, NOT Spring
    // PageResponse (no .content / .totalPages). Resilient: also accept
    // PageResponse.content[] + .totalPages in case a deployment differs.
    async listNamespaces(): Promise<NamespaceInfo[]> {
      const all: NamespaceInfo[] = [];
      for (let page = 0; page < 100; page++) {
        const data = await getJson(`/api/v1/namespaces?page=${page}&size=${NS_PAGE_SIZE}`);
        const content: any[] = Array.isArray(data?.items) ? data.items
          : Array.isArray(data?.content) ? data.content
          : (Array.isArray(data) ? data : []);
        for (const n of content) {
          all.push({
            slug: n.slug,
            displayName: n.displayName ?? n.display_name ?? n.name ?? n.slug,
            type: (String(n.type ?? "TEAM").toUpperCase() === "GLOBAL" ? "GLOBAL" : "TEAM"),
            status: n.status ?? "ACTIVE",
          });
        }
        const totalPages: number = Number(data?.totalPages
          ?? (data?.total != null && data?.size ? Math.ceil(Number(data.total) / Number(data.size)) : 1));
        if (page + 1 >= totalPages || content.length === 0) break;
      }
      return all;
    },

    // CLI M2M search: data.items[] each {namespace, slug, latestVersion, summary}.
    // No namespace filter server-side → filter client-side. `q` matches slug/name
    // only (verified: q=global → 0 results). No offset → one page (SEARCH_LIMIT).
    async listPublishedSkills(namespaceSlug: string): Promise<SkillSummary[]> {
      const data = await getJson(`/api/cli/v1/skills/search?limit=${SEARCH_LIMIT}`);
      const items: any[] = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      const total = Number(data?.total ?? items.length);
      if (total > SEARCH_LIMIT) {
        throw new SkillhubApiError(200, 0, `namespace ${namespaceSlug} has ${total} skills > limit ${SEARCH_LIMIT}; increase SEARCH_LIMIT`);
      }
      return items
        .filter((s) => s.namespace === namespaceSlug)
        .map((s) => ({
          slug: s.slug,
          displayName: s.displayName ?? s.display_name ?? s.slug,
          namespaceSlug,
          latestVersion: s.latestVersion ?? s.latest_version ?? null,
        }));
    },

    // CLI resolve: data {namespace, slug, version, versionId, fingerprint, downloadUrl}.
    // fingerprint is the content hash. resolve does NOT return manifest/metadata → null.
    async getVersionDetail(ns: string, slug: string, version: string): Promise<VersionDetail> {
      const data = await getJson(
        `/api/cli/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/resolve?version=${encodeURIComponent(version)}`,
      );
      return {
        version: data.version ?? version,
        sha256: data.fingerprint ?? data.sha256 ?? data.sha_256 ?? null,
        parsedMetadataJson: null,
        manifestJson: null,
      };
    },

    // CLI download: application/zip; filename from Content-Disposition
    // ({slug}-{version}.zip). Atomic tmp+rename; compute local sha256 for
    // integrity verification (deny-wins vs fingerprint in the bridge).
    async downloadSkill(ns: string, slug: string, version: string, destDir: string): Promise<DownloadResult> {
      const { createHash } = await import("node:crypto");
      const { mkdirSync, writeFileSync, renameSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const url = `${baseUrl}/api/cli/v1/skills/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`;
      const res = await fetchImpl(url, { method: "GET", headers });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).msg ?? msg; } catch {}
        throw new SkillhubApiError(res.status, res.status, msg);
      }
      // Verify Content-Type is a real ZIP archive (deny-wins: a 200 with the
      // wrong content-type is a contract drift / MitM signal, not a skill).
      const ct = String(res.headers?.get?.("content-type") ?? res.headers?.["content-type"] ?? "");
      if (!/application\/zip/i.test(ct) && !/application\/octet-stream/i.test(ct)) {
        throw new SkillhubApiError(res.status, 0, `unexpected content-type: ${ct}`);
      }
      const contentLength = String(res.headers?.get?.("content-length") ?? res.headers?.["content-length"] ?? "");
      if (/^\d+$/.test(contentLength) && Number(contentLength) > maxDownloadBytes) {
        throw new SkillhubApiError(res.status, 0, `package exceeds ${maxDownloadBytes} byte limit`);
      }
      mkdirSync(destDir, { recursive: true });
      // Filename from Content-Disposition; fall back to {slug}-{version}.zip.
      const cd = res.headers?.get?.("content-disposition") ?? res.headers?.["content-disposition"];
      let fname = `${slug}-${version}.zip`;
      if (cd) {
        const m = cd.match(/filename\*?=("?)([^";]+)"?/i);
        if (m?.[2]) fname = m[2].trim();
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.zip$/i.test(fname) || fname.includes("..")) {
        fname = `${slug}-${version}.zip`;
      }
      const final = join(destDir, fname);
      const tmp = join(destDir, `${fname}.tmp`);
      try {
        let buf: Buffer;
        if (res.body?.getReader) {
          const reader = res.body.getReader();
          const chunks: Buffer[] = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.length;
            if (total > maxDownloadBytes) {
              try { await reader.cancel(); } catch {}
              throw new SkillhubApiError(res.status, 0, `package exceeds ${maxDownloadBytes} byte limit`);
            }
            chunks.push(chunk);
          }
          buf = Buffer.concat(chunks, total);
        } else {
          buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxDownloadBytes) {
            throw new SkillhubApiError(res.status, 0, `package exceeds ${maxDownloadBytes} byte limit`);
          }
        }
        writeFileSync(tmp, buf);
        renameSync(tmp, final);
        const sha = createHash("sha256").update(buf).digest("hex");
        return { localPath: final, sha256: sha };
      } catch (err) {
        try { rmSync(tmp, { force: true }); } catch {}
        try { rmSync(final, { force: true }); } catch {}
        throw err;
      }
    },
  };
}
