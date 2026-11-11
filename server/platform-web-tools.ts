/**
 * platform-web-tools.ts — Agent OS W1: platform built-in web tools.
 *
 * One SDK in-process MCP server `platform-web-tools` exposing two Runtime
 * base tools (NOT ordinary MCP — they bypass data/mcp.json → entitlement →
 * activation → mount → stdio):
 *
 *   mcp__platform-web-tools__bailian_search  # default allow
 *   mcp__platform-web-tools__web_fetch       # default approval
 *
 * Scope (demo / self-hosted baseline, NOT a production SSRF gateway):
 *   - bailian_search: one direct DashScope fetch, correct request shape,
 *     one 45s timeout, answer + sources.
 *   - web_fetch: native fetch, manual redirects (≤5), 15s timeout through
 *     body consumption, 2 MiB / 100k caps, HTML→text.
 *   - SSRF: reject non-http(s), userinfo, localhost/.localhost, and EXPLICIT
 *     loopback/private/link-local/metadata IPv4 + ALL explicit IPv6 literals.
 *     DNS hostnames go to native fetch (no pinning / no DNS rebinding guard
 *     — accepted for this baseline).
 *
 * The Bailian key lives only in process ENV (DASHSCOPE_API_KEY), never in
 * sdkOptions/logs/tests/committed files. Factory is called once per query()
 * lifecycle in both Local (ai-client.ts) and Docker (agent-entry.ts).
 *
 * See docs/02-architecture/platform-built-in-web-tools.md (W1).
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { convert as htmlToText } from "html-to-text";

export const PLATFORM_WEB_TOOLS_SERVER_NAME = "platform-web-tools";

const BAILIAN_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
const BAILIAN_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_REDIRECTS = 5;
const FETCH_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const FETCH_MAX_CHARS = 100_000;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export interface PlatformWebToolsConfig {
  dashscopeApiKey?: string | null;
  bailianEndpoint?: string;
  /** Inject fetch for tests (both tools). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override timeout for tests. */
  timeoutMs?: number;
}

// ─── tiny error helper (a few sanitized categories only) ───────

function fail(category: string, detail: string): Error {
  const e = new Error(`[${category}] ${detail}`);
  (e as any).category = category;
  return e;
}

function sanitize(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/(bearer|tvly-|sk-|dashscope)[^\s]*/gi, "$1***").slice(0, 160);
}

function isAbortLike(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name ?? "";
  const msg = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || name === "TimeoutError" || /aborted|timeout/i.test(msg);
}

function okResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false };
}
function errResult(category: string, err: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: category, detail: sanitize(err) }) }], isError: true };
}

// ─── BailianSearch ─────────────────────────────────────────────

export interface BailianSource {
  title: string;
  url: string;
  siteName?: string;
}

export async function bailianSearch(
  input: { query: string },
  deps: { apiKey: string; endpoint?: string; fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<{ query: string; answer: string; sources: BailianSource[] }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = deps.endpoint ?? BAILIAN_ENDPOINT;
  const timeoutMs = deps.timeoutMs ?? BAILIAN_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify({
        model: "qwen-plus",
        input: { messages: [{ role: "user", content: input.query }] },
        parameters: {
          enable_search: true,
          // Latency fix (2026-09-04, measured): uncapped search-forced
          // qwen-plus writes a full markdown essay server-side (~40s wall,
          // timeout was 15s -> every search failed). Capping generation
          // returns in ~5s with search_info.search_results fully intact.
          // The answer is only raw material for the agent's own synthesis,
          // so a short digest + sources is all we need from this endpoint.
          max_tokens: 200,
          result_format: "message",
          search_options: { forced_search: true, enable_source: true },
        },
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted || isAbortLike(err)) throw fail("timeout", "search timed out");
    throw fail("upstream", sanitize(err));
  }

  // Keep the deadline alive through body parsing; abort() aborts the body.
  let body: any;
  try {
    body = await res.json();
  } catch {
    clearTimeout(timer);
    if (controller.signal.aborted) throw fail("timeout", "search timed out");
    throw fail("upstream", "non-json response");
  }
  clearTimeout(timer);

  if (res.status === 401) throw fail("upstream", "upstream rejected credentials");
  if (res.status === 429) throw fail("upstream", "rate limited");
  if (!res.ok) throw fail("upstream", `upstream ${res.status}`);

  const choices = body?.output?.choices;
  const answer = (Array.isArray(choices) && choices[0]?.message?.content) || body?.output?.text || "";
  const raw = body?.output?.search_info?.search_results;
  const sources: BailianSource[] = Array.isArray(raw)
    ? raw.slice(0, 10).map((s: any) => ({
        title: typeof s.title === "string" ? s.title : "",
        url: typeof s.url === "string" ? s.url : typeof s.link === "string" ? s.link : "",
        ...(s.site_name ? { siteName: String(s.site_name) } : {}),
      })).filter((s: BailianSource) => s.url)
    : [];
  return { query: input.query, answer: String(answer ?? ""), sources };
}

// ─── LocalFetch (native fetch, explicit-IP SSRF pre-check) ────

export interface LocalFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

/** Reject non-http(s), userinfo, localhost, and explicit private IPv4 / any
 *  IPv6 literal. DNS hostnames pass through to native fetch. */
function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw fail("invalid", "invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw fail("invalid", "only http(s) allowed");
  if (u.username || u.password) throw fail("invalid", "userinfo not allowed");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) throw fail("blocked", "localhost not allowed");
  if (h.startsWith("[")) throw fail("blocked", "ipv6 literals not allowed"); // all explicit IPv6
  const v4 = IPV4_RE.exec(h);
  if (v4 && isBlockedV4(+v4[1], +v4[2], +v4[3], +v4[4])) {
    throw fail("blocked", "loopback/private/link-local/metadata address");
  }
  return u;
}

function isBlockedV4(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isAllowedContentType(ct: string): boolean {
  return ct.startsWith("text/") || ct.includes("json") || ct.includes("html") || ct.includes("xml");
}

async function readCappedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  maxChars: number
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  let received = 0;
  let truncated = false;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(concat(chunks));
  return { text: text.slice(0, maxChars), truncated: truncated || text.length > maxChars };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export async function fetchPublicUrl(
  input: { url: string },
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<LocalFetchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const requestedUrl = input.url;
  let current = input.url;

  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    assertPublicUrl(current); // re-check every redirect target
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current, { signal: controller.signal, redirect: "manual" });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try { res.body?.cancel(); } catch { /* noop */ }
        clearTimeout(timer);
        if (!loc) throw fail("upstream", "redirect without location");
        current = new URL(loc, current).toString();
        continue;
      }

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!isAllowedContentType(contentType)) {
        clearTimeout(timer);
        throw fail("unsupported", `content-type: ${contentType || "unknown"}`);
      }

      // Deadline stays alive through body read; abort() errors the stream.
      const { text, truncated } = await readCappedText(res.body, FETCH_MAX_BYTES, FETCH_MAX_CHARS);
      clearTimeout(timer);
      const out = contentType.includes("html")
        ? htmlToText(text, { wordwrap: false }).slice(0, FETCH_MAX_CHARS)
        : text;
      return {
        requestedUrl,
        finalUrl: current,
        status: res.status,
        contentType: contentType || "unknown",
        text: out,
        truncated: truncated || out.length >= FETCH_MAX_CHARS,
      };
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted || isAbortLike(err)) throw fail("timeout", "fetch timed out");
      throw err;
    }
  }
  throw fail("upstream", "too many redirects");
}

// ─── Factory: the in-process MCP server ────────────────────────

export function isBailianConfigured(config: PlatformWebToolsConfig = {}): boolean {
  return ((config.dashscopeApiKey ?? process.env.DASHSCOPE_API_KEY ?? "").trim()).length > 0;
}

export function createPlatformWebToolsServer(config: PlatformWebToolsConfig = {}) {
  const apiKey = (config.dashscopeApiKey ?? process.env.DASHSCOPE_API_KEY ?? "").trim();
  const tools: Array<SdkMcpToolDefinition<any>> = [
    tool(
      "web_fetch",
      "Fetch a public HTTP(S) page as plain text. Rejects loopback/private/metadata IPs and IPv6 literals; redirects re-checked. HTML→text. Approval required.",
      { url: z.string().min(1) },
      async (args) => {
        try {
          return okResult(await fetchPublicUrl({ url: args.url }, { fetchImpl: config.fetchImpl, timeoutMs: config.timeoutMs }));
        } catch (err: any) {
          return errResult(err?.category ?? "upstream", err);
        }
      }
    ),
  ];
  if (apiKey) {
    tools.push(
      tool(
        "bailian_search",
        "Search the public web via Bailian (DashScope qwen-plus with forced search). Returns an answer + source URLs.",
        { query: z.string().min(1) },
        async (args) => {
          try {
            return okResult(await bailianSearch(
              { query: args.query },
              { apiKey, endpoint: config.bailianEndpoint, fetchImpl: config.fetchImpl, timeoutMs: config.timeoutMs }
            ));
          } catch (err: any) {
            return errResult(err?.category ?? "upstream", err);
          }
        }
      )
    );
  }
  return createSdkMcpServer({ name: PLATFORM_WEB_TOOLS_SERVER_NAME, version: "1.0.0", tools });
}
