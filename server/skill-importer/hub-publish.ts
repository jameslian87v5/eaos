/**
 * hub-publish.ts — Skill Importer's Hub publish adapter (two-phase confirm flow).
 *
 * Real contract (live OpenAPI @ /v3/api-docs, verified 2026-08-17):
 *
 *   Phase A — validate (dry-run, NO publish):
 *     POST /api/cli/v1/skills/{namespace}/publish/validate
 *       multipart/form-data: `file` (binary, req) + `visibility` (string, opt)
 *       → data: CliDryRunResponse { valid:boolean, errors:string[], warnings:string[],
 *         resolvedSlug, resolvedVersion }
 *     success iff HTTP ok AND code===0. `data.valid` is the dry-run verdict;
 *     `data.warnings` are non-blocking but MUST be shown to the operator before
 *     publishing (directive: "show actual validation warnings before confirm").
 *
 *   Phase B — publish (portal endpoint, confirmWarnings=true; CLI publish
 *     hardcodes confirmWarnings=false → HTTP 400 "warnings require confirmation"):
 *     POST /api/v1/skills/{namespace}/publish?visibility=<v>&confirmWarnings=true
 *       multipart/form-data: `file` (binary, req)
 *       → data: PublishResponse { skillId, namespace, slug, version, status,
 *         fileCount, totalSize }
 *     success iff HTTP ok AND code===0. `status` is the post-publish skill
 *     status (e.g. PENDING_REVIEW) — the Importer never grants auto-approve.
 *
 * Envelope: {code, msg, data, timestamp, requestId}; unwrap .data; deny-wins.
 *
 * Credential: a SEPARATE publish token (env `SKILLHUB_PUBLISH_TOKEN`) — NOT
 * the platform sync bridge's `skill:read` token. The Importer NEVER sends the
 * token to the browser; errors are categorical strings with no token substring.
 *
 * The two phases are SEPARATE calls so the operator can review warnings between
 * them. publishSkill MUST NOT run unless the operator explicitly confirmed
 * (the /api/import/publish route enforces "validated first" server-side).
 */
import crypto from "node:crypto";

export interface HubPublishConfig {
  baseUrl: string; // e.g. http://localhost:8080 (no trailing slash)
  publishToken: string; // server-side only; never serialized to the client
  /** Optional fetch injection seam (tests pass a stub). */
  fetchImpl?: typeof fetch;
  /** Visibility string (e.g. "public" / "private"); omitted if undefined. */
  visibility?: string;
}

export type PublishPhase = "validate" | "publish";

export interface ValidateOutcome {
  phase: "validate";
  ok: boolean; // HTTP ok && code===0 && data.valid && no errors
  valid: boolean | null; // data.valid (null if envelope/parse failed)
  errors: string[]; // data.errors (non-blocking-in-envelope, blocking here)
  warnings: string[]; // data.warnings (shown to operator before confirm)
  resolvedSlug: string | null;
  resolvedVersion: string | null;
  reason: string | null; // categorical; no token
  code: number | null;
}

export interface PublishOutcome {
  phase: "publish";
  ok: boolean;
  status: string | null; // data.status (e.g. "PENDING_REVIEW")
  skillId: number | null;
  namespace: string | null;
  slug: string | null;
  version: string | null;
  reason: string | null;
  code: number | null;
}

export type HubPublishOutcome = ValidateOutcome | PublishOutcome;

export class HubPublishError extends Error {
  constructor(public phase: PublishPhase, message: string, public code: number | null = null) {
    super(message);
    this.name = "HubPublishError";
  }
}

function sanitize(msg: string, token: string): string {
  // Never leak the token into an error/UI/log string.
  if (token && msg.includes(token)) return "hub error (token redacted)";
  return msg.split("\n")[0].slice(0, 300);
}

/** Build a multipart/form-data body with a `file` part (+ optional visibility field). */
function buildMultipart(zip: Buffer, fileName: string, visibility?: string): { body: FormData } {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), fileName);
  if (visibility) form.append("visibility", visibility);
  return { body: form };
}

/** POST a multipart `file` to a CLI endpoint; unwrap envelope + return raw data. */
async function postCli(
  cfg: HubPublishConfig,
  endpoint: "publish/validate",
  namespace: string,
  zip: Buffer,
  fileName: string,
): Promise<{ ok: boolean; code: number | null; msg: string; data: any }> {
  const url = `${cfg.baseUrl}/api/cli/v1/skills/${encodeURIComponent(namespace)}/${endpoint}`;
  const { body } = buildMultipart(zip, fileName, cfg.visibility);
  const f = cfg.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { Authorization: `Bearer ${cfg.publishToken}` }, body });
  } catch (e) {
    return { ok: false, code: null, msg: sanitize(`network error: ${e instanceof Error ? e.message : String(e)}`, cfg.publishToken), data: null };
  }
  return unwrap(res, cfg);
}

/** POST a multipart `file` to the PORTAL publish endpoint with confirmWarnings=true. */
async function postPortalPublish(
  cfg: HubPublishConfig,
  namespace: string,
  zip: Buffer,
  fileName: string,
): Promise<{ ok: boolean; code: number | null; msg: string; data: any }> {
  // visibility + confirmWarnings are QUERY params on the portal endpoint
  // (OpenAPI: params namespace(path), visibility(query), confirmWarnings(query)).
  const q = new URLSearchParams({ confirmWarnings: "true" });
  if (cfg.visibility) q.set("visibility", cfg.visibility);
  const url = `${cfg.baseUrl}/api/v1/skills/${encodeURIComponent(namespace)}/publish?${q.toString()}`;
  const { body } = buildMultipart(zip, fileName); // visibility is in the query, not the form
  const f = cfg.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { Authorization: `Bearer ${cfg.publishToken}` }, body });
  } catch (e) {
    return { ok: false, code: null, msg: sanitize(`network error: ${e instanceof Error ? e.message : String(e)}`, cfg.publishToken), data: null };
  }
  return unwrap(res, cfg);
}

async function unwrap(res: Response, cfg: HubPublishConfig): Promise<{ ok: boolean; code: number | null; msg: string; data: any }> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return { ok: false, code: res.status, msg: sanitize(`unexpected content-type: ${ct}`, cfg.publishToken), data: null };
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: res.status, msg: sanitize(`invalid JSON (HTTP ${res.status})`, cfg.publishToken), data: null };
  }
  const code = typeof body?.code === "number" ? body.code : null;
  const msg = typeof body?.msg === "string" ? sanitize(body.msg, cfg.publishToken) : `HTTP ${res.status}`;
  const ok = res.ok && code === 0; // deny-wins
  return { ok, code, msg, data: body?.data ?? null };
}

export interface PublishCandidate {
  name: string;
  zip: Buffer;
}

/** Phase A — dry-run validate. NEVER publishes. Surfaces warnings for review. */
export async function validateSkill(cfg: HubPublishConfig, namespace: string, candidate: PublishCandidate): Promise<ValidateOutcome> {
  const fileName = `${candidate.name || "skill"}.zip`;
  const r = await postCli(cfg, "publish/validate", namespace, candidate.zip, fileName);
  if (!r.ok) {
    return { phase: "validate", ok: false, valid: null, errors: [], warnings: [], resolvedSlug: null, resolvedVersion: null, reason: r.msg ?? "validate failed", code: r.code };
  }
  const d = r.data ?? {};
  const valid = typeof d.valid === "boolean" ? d.valid : null;
  const errors = Array.isArray(d.errors) ? d.errors.map(String).slice(0, 50) : [];
  const warnings = Array.isArray(d.warnings) ? d.warnings.map(String).slice(0, 50) : [];
  const resolvedSlug = typeof d.resolvedSlug === "string" ? d.resolvedSlug : null;
  const resolvedVersion = typeof d.resolvedVersion === "string" ? d.resolvedVersion : null;
  // Real Hub dry-run semantics (live-verified 2026-08-17): the Hub sets
  // data.valid=false whenever warnings exist, because the CLI publish path
  // hardcodes confirmWarnings=false and would reject them. A warning-only
  // result (envelope ok, valid:false, errors:[], warnings non-empty) is
  // CONFIRMABLE via the portal publish endpoint (confirmWarnings=true) — so
  // the Importer treats it as ok (validated/confirmable) AFTER surfacing the
  // warnings to the operator. Hard-block (not confirmable) only when:
  //   - envelope failed (handled above), OR
  //   - there are blocking errors (errors non-empty), OR
  //   - no real verdict (valid === null, malformed response), OR
  //   - valid:false with NO warnings (Hub said invalid with no explanation).
  const confirmable = errors.length === 0 && valid !== null && (valid === true || warnings.length > 0);
  const reason = confirmable ? null
    : (errors.length ? errors[0]
      : (valid === null ? "validate reported no verdict"
        : "validate reported invalid (no warnings)"));
  return { phase: "validate", ok: confirmable, valid, errors, warnings, resolvedSlug, resolvedVersion, reason, code: r.code };
}

/** Phase B — portal publish with confirmWarnings=true. ONLY after operator confirm. */
export async function publishSkill(cfg: HubPublishConfig, namespace: string, candidate: PublishCandidate): Promise<PublishOutcome> {
  const fileName = `${candidate.name || "skill"}.zip`;
  const r = await postPortalPublish(cfg, namespace, candidate.zip, fileName);
  if (!r.ok) {
    return { phase: "publish", ok: false, status: null, skillId: null, namespace: null, slug: null, version: null, reason: r.msg ?? "publish failed", code: r.code };
  }
  const d = r.data ?? {};
  return {
    phase: "publish",
    ok: true,
    status: typeof d.status === "string" ? d.status : null,
    skillId: typeof d.skillId === "number" ? d.skillId : null,
    namespace: typeof d.namespace === "string" ? d.namespace : null,
    slug: typeof d.slug === "string" ? d.slug : null,
    version: typeof d.version === "string" ? d.version : null,
    reason: null,
    code: r.code,
  };
}

/** Back-compat: validate-then-publish in one call (CLI endpoint, confirmWarnings=false).
 *  RETAINED for tests that exercise the legacy auto-publish path; the live UI no
 *  longer uses it (it would 400 on real warnings). Prefer validateSkill + publishSkill. */
export async function validateAndPublish(cfg: HubPublishConfig, namespace: string, candidate: PublishCandidate): Promise<HubPublishOutcome> {
  const v = await validateSkill(cfg, namespace, candidate);
  if (!v.ok) return v;
  return publishSkill(cfg, namespace, candidate);
}

/** Random nonce for idempotency/tests — never a security primitive. */
export function randomId(): string {
  return crypto.randomBytes(8).toString("hex");
}
