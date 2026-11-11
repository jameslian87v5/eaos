/**
 * model-egress-proxy.ts — Host-side credential proxy for Guest model calls (M3-S3B).
 *
 * INVARIANT: long-term model credentials NEVER enter the Guest. The Guest
 * worker submits a controlled model-call INTENT (`model_request` platform
 * event — no credential, no provider/host/model selection); the Host:
 *   ① validates the request (issuer-issued requestId, committed provider +
 *      path, payload structure + size, clamped timeout);
 *   ② stamps the GOVERNED model + target (the Guest cannot choose them);
 *   ③ resolves + SSRF-guards the target ONCE, then PINS the connection to
 *      the validated public address (Host header + TLS identity stay on the
 *      real hostname) — DNS rebinding between check and connect cannot
 *      redirect the request; loopback/RFC1918/link-local/metadata/CGNAT and
 *      IPv4-mapped-IPv6 forms are refused (R1);
 *   ④ executes the provider call with the credential read from the HOST
 *      process environment AT CALL TIME (never logged, never returned);
 *   ⑤ returns a REDACTED result (status + scrubbed body / sanitized error).
 *
 * Fail-closed everywhere: unknown target, missing credential, private
 * address, oversize request/response, timeout, malformed payload ⇒ a
 * structured denial — NEVER a fallback that hands the key to the Guest.
 *
 * Pure DI: env reader, DNS resolver, fetch and clock are injected; tests
 * never touch the network or the real environment.
 */

import { isIP } from "node:net";
import { resolve4 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";

/** The ONLY committed engine + endpoint (M3-S3B request: Claude only). */
export const COMMITTED_EGRESS_PROVIDER = "claude" as const;
export const COMMITTED_EGRESS_PATH = "/v1/messages" as const;

/** Request/response caps (bytes) — oversize fails closed, never truncated
 *  silently (a truncated provider body would fake engine output). */
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Per-call timeout clamp (ms). */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Normalize an address for refusal checks (M3-S3B R1): IPv4-mapped IPv6
 * (`::ffff:127.0.0.1` dotted, `::ffff:7f00:1` hex) is an IPv4 address in
 * disguise — unwrap it BEFORE the loopback/RFC1918/link-local/metadata tests
 * or it slips past every v4 rule.
 */
function normalizeAddress(ip: string): string {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
    }
  }
  return ip;
}

/** Non-routable / infrastructure address spaces — always refused. */
function isRefusedAddress(rawIp: string): boolean {
  const ip = normalizeAddress(rawIp);
  // Reject IPv4 loopback/RFC1918/link-local/metadata + IPv6 loopback/ULA/link-local.
  const v4 =
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^0\./.test(ip) ||
    ip === "100.64.0.1"; // common CGNAT/metadata gateway alias
  const v6 =
    ip === "::1" ||
    ip === "::" ||
    /^f[cd][0-9a-f]{2}:/i.test(ip) ||
    /^fe[89ab][0-9a-f]:/i.test(ip);
  return v4 || v6;
}

export interface ModelEgressConfigDeps {
  /** Environment getter (default: process.env at CALL time). */
  env?: () => Record<string, string | undefined>;
}

export interface ModelEgressTargetConfig {
  provider: typeof COMMITTED_EGRESS_PROVIDER;
  baseUrl: string;
  /** Credential KIND only — the value never leaves `execute`. */
  credentialKind: "authorization-bearer" | "x-api-key";
}

/**
 * Resolve the committed egress target from the Host environment. Returns
 * null when unconfigured (base URL or credential absent) — callers treat
 * that as "credential proxy not ready" (fail closed, diagnosable reason).
 * The credential VALUE is never part of the return value.
 */
export function resolveModelEgressTarget(
  deps: ModelEgressConfigDeps = {},
): ModelEgressTargetConfig | null {
  const env = deps.env ?? (() => process.env);
  const e = env();
  const baseUrl = (e.MODEL_EGRESS_BASE_URL ?? e.ANTHROPIC_BASE_URL ?? "").trim();
  const authToken = (e.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  const apiKey = (e.ANTHROPIC_API_KEY ?? "").trim();
  if (!baseUrl || (!authToken && !apiKey)) return null;
  return {
    provider: COMMITTED_EGRESS_PROVIDER,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    credentialKind: authToken ? "authorization-bearer" : "x-api-key",
  };
}

export interface ModelEgressCallRequest {
  requestId: string;
  provider: string;
  path: string;
  /** JSON string of the Guest's provider request body (no model field). */
  payload: string;
  timeoutMs?: number;
}

export interface ModelEgressCallResult {
  ok: boolean;
  /** HTTP status (0 = no response / transport-level failure). */
  status: number;
  /** Redacted provider response body (ok only). */
  body?: string;
  /** Sanitized error (never contains the credential or raw headers). */
  error?: string;
}

/**
 * The HTTP request the proxy issues (M3-S3B R1 anti-rebinding shape):
 * `url` targets the ALREADY-VALIDATED public address (the connection peer),
 * while `hostHeader` carries the ORIGINAL authority — the HTTP Host header
 * AND the TLS SNI/certificate identity stay on the real hostname. Validation
 * and connection therefore use the SAME address: a second DNS answer
 * (rebinding) cannot redirect the request.
 */
export interface EgressHttpRequest {
  /** https://<validated-address>[:port]/path — the connection target. */
  url: string;
  /** Original authority (hostname[:port]) — Host header + TLS identity. */
  hostHeader: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface ModelEgressProxyDeps {
  env?: () => Record<string, string | undefined>;
  /** Explicit target (default: resolveModelEgressTarget from env at construction). */
  target?: ModelEgressTargetConfig;
  /** Address resolver for the SSRF guard (default dns/promises resolve4). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** HTTP executor (default: node:https request pinned to the validated address). */
  fetch?: (req: EgressHttpRequest) => Promise<{ status: number; text: () => Promise<string> }>;
  now?: () => number;
}

export class ModelEgressProxy {
  private readonly target: ModelEgressTargetConfig;
  private readonly resolveHost: NonNullable<ModelEgressProxyDeps["resolveHost"]>;
  private readonly fetchImpl: NonNullable<ModelEgressProxyDeps["fetch"]>;
  private readonly envOf: () => Record<string, string | undefined>;

  constructor(deps: ModelEgressProxyDeps = {}) {
    const target = deps.target ?? resolveModelEgressTarget({ env: deps.env });
    if (!target) {
      // Constructor-level fail closed: the factory only builds a proxy when
      // configured; a direct construction without env is a programming error.
      throw new Error("model egress proxy: target not configured (base URL or credential absent)");
    }
    this.target = target;
    this.envOf = deps.env ?? (() => process.env);
    this.resolveHost = deps.resolveHost ?? ((h) => resolve4(h));
    this.fetchImpl = deps.fetch ?? defaultEgressHttp;
  }

  /**
   * Execute a Guest model-call intent. `governedModel` is stamped by the
   * Host (from the resolved execution policy) — the payload's own model, if
   * any, is OVERWRITTEN, and stream is forced off (the S3B loop is
   * request/response).
   */
  async execute(req: ModelEgressCallRequest, governedModel: string): Promise<ModelEgressCallResult> {
    try {
      return await this.executeInner(req, governedModel);
    } catch (e: unknown) {
      return { ok: false, status: 0, error: this.sanitize(String((e as Error)?.message ?? e)) };
    }
  }

  private async executeInner(req: ModelEgressCallRequest, governedModel: string): Promise<ModelEgressCallResult> {
    // ① Target: committed provider + path ONLY (deny unknown).
    if (req.provider !== COMMITTED_EGRESS_PROVIDER) {
      return { ok: false, status: 0, error: `egress refused: provider '${req.provider}' is not the committed engine` };
    }
    if (req.path !== COMMITTED_EGRESS_PATH) {
      return { ok: false, status: 0, error: `egress refused: path '${req.path}' is not the committed endpoint` };
    }
    // ② Payload: bounded JSON object with a non-empty messages array; the
    //    Guest cannot smuggle model/stream/target selection (overwritten).
    if (Buffer.byteLength(req.payload ?? "", "utf8") > MAX_REQUEST_BYTES) {
      return { ok: false, status: 0, error: `egress refused: payload exceeds ${MAX_REQUEST_BYTES} bytes` };
    }
    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(req.payload) as Record<string, unknown>;
    } catch {
      return { ok: false, status: 0, error: "egress refused: payload is not valid JSON" };
    }
    if (typeof parsedBody !== "object" || parsedBody === null || !Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
      return { ok: false, status: 0, error: "egress refused: payload must carry a non-empty messages array" };
    }
    parsedBody.model = governedModel;
    parsedBody.stream = false;
    delete parsedBody.metadata; // no Guest-chosen metadata echo

    // ③ Target URL + SSRF guard: https only; resolve ONCE, validate EVERY
    //    address (normalized — IPv4-mapped IPv6 unwrapped), then PIN the
    //    connection to the first validated address. The original authority
    //    survives as Host header + TLS identity, so rebinding between the
    //    check and the connect cannot redirect the request (R1 fix).
    let url: URL;
    try {
      url = new URL(this.target.baseUrl + req.path);
    } catch {
      return { ok: false, status: 0, error: "egress refused: configured base URL is not a valid URL" };
    }
    if (url.protocol !== "https:") {
      return { ok: false, status: 0, error: `egress refused: scheme '${url.protocol.replace(':','')}' is not https` };
    }
    const literal = isIP(url.hostname);
    const addresses = literal ? [url.hostname] : await this.guardedResolve(url.hostname);
    for (const addr of addresses) {
      if (isRefusedAddress(addr)) {
        // Never echo the exact address class mapping — just refuse.
        return { ok: false, status: 0, error: "egress refused: target resolves to a non-public address" };
      }
    }
    const pinned = normalizeAddress(addresses[0]);
    const isV6 = isIP(pinned) === 6;
    const pinnedUrl = `https://${isV6 ? `[${pinned}]` : pinned}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}`;

    // ④ Credential — read from the Host env AT CALL TIME; only the header
    //    kind is pre-selected. The value never appears in any output.
    const env = this.envOf();
    const credential = (env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "").trim();
    if (!credential) {
      return { ok: false, status: 0, error: "egress refused: host credential absent (fail closed)" };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(this.target.credentialKind === "authorization-bearer"
        ? { authorization: `Bearer ${credential}` }
        : { "x-api-key": credential }),
    };

    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, req.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const ac = new AbortController();
    let timedOut = false; // only OUR timer turns a rejection into "timeout"
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    try {
      const res = await this.fetchImpl({
        url: pinnedUrl,
        hostHeader: url.host,
        method: "POST",
        headers,
        body: JSON.stringify(parsedBody),
        signal: ac.signal,
      });
      const raw = await res.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
        return { ok: false, status: res.status, error: `egress refused: response exceeds ${MAX_RESPONSE_BYTES} bytes` };
      }
      if (res.status < 200 || res.status >= 300) {
        if (res.status === 401 || res.status === 403) {
          const credentialName = this.target.credentialKind === "authorization-bearer"
            ? "ANTHROPIC_AUTH_TOKEN"
            : "ANTHROPIC_API_KEY";
          return {
            ok: false,
            status: res.status,
            error: `auth failed (${res.status}) using ${this.target.credentialKind} (${credentialName})`,
          };
        }
        return { ok: false, status: res.status, error: this.sanitize(this.excerpt(raw)) };
      }
      return { ok: true, status: res.status, body: this.sanitize(raw) };
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      return { ok: false, status: 0, error: timedOut ? `egress timeout after ${timeoutMs}ms` : this.sanitize(msg) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async guardedResolve(host: string): Promise<string[]> {
    try {
      const addrs = await this.resolveHost(host);
      if (addrs.length === 0) throw new Error("no addresses");
      return addrs;
    } catch {
      throw new Error(`egress refused: host '${host}' does not resolve`);
    }
  }

  /** Scrub the credential value + obvious key shapes from any outbound text. */
  private sanitize(text: string): string {
    const credential = (this.envOf().ANTHROPIC_AUTH_TOKEN ?? this.envOf().ANTHROPIC_API_KEY ?? "").trim();
    let out = text;
    if (credential) out = out.split(credential).join("***");
    return out
      .replace(/(authorization|x-api-key|api-key)\s*[:=]\s*\S+/gi, "$1: ***")
      .replace(/\b(sk-[A-Za-z0-9_\-]{8,})\b/g, "***");
  }

  private excerpt(text: string, max = 400): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
}

/**
 * Default HTTP executor (M3-S3B R1): node:https request CONNECTED to the
 * pre-validated address (`req.url`) while Host header and TLS SNI/cert
 * identity stay on the original authority (`req.hostHeader`) — no second DNS
 * lookup happens between validation and connection. Properties:
 *   - NO redirect following (fetch's automatic follow would re-resolve the
 *     Location host — a re-opened rebinding door; 3xx lands in the sanitized
 *     non-2xx error path instead, fail closed).
 *   - Response body is streamed with a hard byte cap — an oversized body
 *     destroys the socket instead of buffering unbounded memory.
 */
function defaultEgressHttp(req: EgressHttpRequest): Promise<{ status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url);
    const hostHeaderName = req.hostHeader.split(":")[0]; // TLS identity: hostname only
    const r = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: req.method,
        headers: { ...req.headers, host: req.hostHeader },
        servername: hostHeaderName,
        signal: req.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy();
            resolve({
              status: res.statusCode ?? 0,
              text: () => Promise.reject(new Error(`egress refused: response exceeds ${MAX_RESPONSE_BYTES} bytes (stream aborted)`)),
            });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => reject(e));
      },
    );
    r.on("error", (e) => reject(e));
    r.write(req.body);
    r.end();
  });
}
