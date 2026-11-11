/**
 * service.ts — Skill Importer orchestrator.
 *
 * Two phases:
 *   1. scanGit/scanZipUrl/scanUpload → DiscoveredSkill[] (UI previews).
 *   2. publishBatch(namespace, skills) → per-item validate→publish outcomes.
 *
 * Per-item isolation: a candidate failure (zip, validate, publish) is recorded
 * and DOES NOT abort the batch (directive test: "逐项失败隔离"). Temp dirs
 * are mkdtemp + always cleaned by the caller via the returned cleanup fn.
 *
 * Secrets: the publish token never appears in outcome strings; outcomes carry
 * only categorical reasons + Hub envelope code (no response body).
 */
import {
  extractUploadedZip,
  fetchGitSource,
  fetchZipUrlSource,
  rmrf,
} from "./sources.js";
import { scanForSkills, type DiscoveredSkill, type ScanResult } from "./scanner.js";
import { zipDir } from "./zip-writer.js";
import { validateSkill, publishSkill, type HubPublishConfig, type HubPublishOutcome } from "./hub-publish.js";

export interface ScanHandle {
  result: ScanResult;
  sourceLabel: string;
  cleanup: () => void;
}

/** Display basename from a URL (".../repo.git" → "repo") — root-candidate name fallback. */
function nameFromUrl(url: string): string {
  const base = url.replace(/[\/]+$/, "").split("/").pop() ?? "";
  return base.replace(/\.git$/, "").slice(0, 100) || "root";
}

export async function scanGit(url: string, ref: string | undefined): Promise<ScanHandle> {
  const r = await fetchGitSource(url, ref);
  const result = scanForSkills(r.dir, nameFromUrl(url));
  return { result, sourceLabel: r.sourceLabel, cleanup: () => rmrf(r.dir) };
}

export async function scanZipUrl(url: string): Promise<ScanHandle> {
  const r = await fetchZipUrlSource(url);
  const result = scanForSkills(r.dir, nameFromUrl(url).replace(/\.zip$/, ""));
  return { result, sourceLabel: r.sourceLabel, cleanup: () => rmrf(r.dir) };
}

export function scanUpload(buf: Buffer, label: string): ScanHandle {
  const r = extractUploadedZip(buf, label);
  const result = scanForSkills(r.dir, label);
  return { result, sourceLabel: r.sourceLabel, cleanup: () => rmrf(r.dir) };
}

// ── Scan session: batch aggregation with stable candidate ids ────────────────
// A session merges one or more ScanHandles (git/zip-url single source, or a
// batch of uploaded ZIPs appended one by one) into ONE candidate list. Each
// candidate gets a stable unique id (`cand-N`) — selection is by id, NEVER by
// basename (two uploaded ZIPs can both contain a root SKILL.md with the same
// frontmatter name; basename/relPath alone cannot distinguish them).

export interface SessionSkill extends DiscoveredSkill {
  /** Stable unique-within-session candidate id (the selection key). */
  id: string;
  /** Which source produced this candidate (upload filename / URL) — UI display. */
  source: string;
}

export interface ScanSession {
  skills: SessionSkillState[];
  sourceLabels: string[];
  ignoredCount: number;
  cleanups: (() => void)[];
  /** Monotonic id counter — appends continue the sequence, ids never reused. */
  seq: number;
}

export function startScanSession(handle: ScanHandle): ScanSession {
  return appendScanSession(
    { skills: [], sourceLabels: [], ignoredCount: 0, cleanups: [], seq: 0 },
    handle,
  );
}

export function appendScanSession(s: ScanSession, handle: ScanHandle): ScanSession {
  s.sourceLabels.push(handle.sourceLabel);
  s.ignoredCount += handle.result.ignoredCount;
  for (const skill of handle.result.skills) {
    s.seq++;
    s.skills.push({ ...skill, id: `cand-${s.seq}`, source: handle.sourceLabel, pubState: "pending" });
  }
  s.cleanups.push(handle.cleanup);
  return s;
}

export function cleanupScanSession(s: ScanSession): void {
  for (const c of s.cleanups) {
    try { c(); } catch {}
  }
  s.cleanups = [];
}

/**
 * Select candidates by stable id. Returns null if ANY id is unknown or
 * duplicated (deny — the caller 400s rather than publishing a wrong subset).
 */
export function selectByIds(s: ScanSession, ids: string[]): SessionSkillState[] | null {
  const seen = new Set<string>();
  const found: SessionSkillState[] = [];
  for (const id of ids) {
    if (seen.has(id)) return null;
    const hit = s.skills.find((x) => x.id === id);
    if (!hit) return null;
    seen.add(id);
    found.push(hit);
  }
  return found;
}

export interface PublishItem {
  id: string;
  name: string;
  relPath: string;
  ok: boolean;
  phase: HubPublishOutcome["phase"] | "package";
  reason: string | null;
  code: number | null;
  /** Hub PublishResponse.status (e.g. "PENDING_REVIEW" / "PUBLISHED"); null on failure. */
  status: string | null;
}

export interface PublishResult {
  items: PublishItem[];
  total: number;
  succeeded: number;
  failed: number;
}

// ── Two-phase confirm flow ───────────────────────────────────────────────────
// Candidates are stateful: pending → validated → (published | failed).
// validateBatch runs Phase A (dry-run, captures warnings/errors, NO publish);
// publishConfirmedBatch runs Phase B (portal confirmWarnings=true) ONLY for
// validated-and-unpublished candidates — already-published ones are skipped
// (no duplicate publish). Both mutate the session's skills in place (cached
// validation/publish) so the UI stays consistent across calls; the session
// survives until TTL sweep or a fresh scan (preserve-until-decision).

export interface ValidateItem {
  id: string;
  name: string;
  relPath: string;
  valid: boolean | null;
  ok: boolean; // envelope ok AND valid AND no errors
  errors: string[];
  warnings: string[];
  resolvedSlug: string | null;
  resolvedVersion: string | null;
  reason: string | null;
  code: number | null;
}

export interface ValidateResult {
  items: ValidateItem[];
  total: number;
  valid: number; // candidates cleared to publish
  invalid: number; // candidates with blocking errors
  errored: number; // candidates whose validate call itself failed
}

/** Cached per-candidate validation (Phase A result). */
export interface CachedValidation {
  /** Namespace this validation was dry-run against (publish must match exactly). */
  namespace: string;
  valid: boolean | null;
  ok: boolean;
  errors: string[];
  warnings: string[];
  resolvedSlug: string | null;
  resolvedVersion: string | null;
  reason: string | null;
  code: number | null;
  at: number;
}

/** Augment a session candidate with publish state + cached results. */
export interface SessionSkillState extends SessionSkill {
  /** "pending" | "validated" | "published" | "failed" */
  pubState: string;
  validation?: CachedValidation;
  publishItem?: PublishItem; // cached Phase B result (ok or not)
}

/** Phase A — validate (dry-run) a batch; cache results on the session; NEVER publish. */
export async function validateBatch(
  cfg: HubPublishConfig,
  namespace: string,
  skills: SessionSkillState[],
): Promise<ValidateResult> {
  const items: ValidateItem[] = [];
  let valid = 0;
  let invalid = 0;
  let errored = 0;
  for (const skill of skills) {
    let zip: Buffer;
    try {
      zip = packageSkill(skill);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errored++;
      const cached: CachedValidation = { namespace, valid: null, ok: false, errors: [reason], warnings: [], resolvedSlug: null, resolvedVersion: null, reason, code: null, at: Date.now() };
      skill.validation = cached;
      skill.pubState = "failed";
      items.push({ id: skill.id, name: skill.name, relPath: skill.relPath, valid: null, ok: false, errors: [reason], warnings: [], resolvedSlug: null, resolvedVersion: null, reason, code: null });
      continue;
    }
    let out: import("./hub-publish.js").ValidateOutcome;
    try {
      out = await validateSkill(cfg, namespace, { name: skill.name, zip });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errored++;
      const cached: CachedValidation = { namespace, valid: null, ok: false, errors: [reason], warnings: [], resolvedSlug: null, resolvedVersion: null, reason, code: null, at: Date.now() };
      skill.validation = cached;
      skill.pubState = "failed";
      items.push({ id: skill.id, name: skill.name, relPath: skill.relPath, valid: null, ok: false, errors: [reason], warnings: [], resolvedSlug: null, resolvedVersion: null, reason, code: null });
      continue;
    }
    const cached: CachedValidation = {
      namespace,
      valid: out.valid, ok: out.ok, errors: out.errors, warnings: out.warnings,
      resolvedSlug: out.resolvedSlug, resolvedVersion: out.resolvedVersion, reason: out.reason, code: out.code, at: Date.now(),
    };
    skill.validation = cached;
    skill.pubState = out.ok ? "validated" : "failed";
    if (out.ok) valid++;
    else if (out.valid === false || (out.errors && out.errors.length)) invalid++;
    else errored++;
    items.push({
      id: skill.id, name: skill.name, relPath: skill.relPath,
      valid: out.valid, ok: out.ok, errors: out.errors, warnings: out.warnings,
      resolvedSlug: out.resolvedSlug, resolvedVersion: out.resolvedVersion,
      reason: out.reason, code: out.code,
    });
  }
  return { items, total: skills.length, valid, invalid, errored };
}

/** Phase B — publish (portal confirmWarnings=true) confirmed candidates.
 *  Skips already-published candidates (no duplicate publish). Requires prior
 *  validation: un-validated candidates are returned as a 409-style failure
 *  ("not validated — run validate first"). */
export async function publishConfirmedBatch(
  cfg: HubPublishConfig,
  namespace: string,
  skills: SessionSkillState[],
): Promise<PublishResult> {
  const items: PublishItem[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const skill of skills) {
    // No duplicate publish: already published → return cached, skip the call.
    if (skill.pubState === "published" && skill.publishItem) {
      items.push(skill.publishItem);
      if (skill.publishItem.ok) succeeded++; else failed++;
      continue;
    }
    // Require prior validation (the explicit confirmation precondition).
    if (skill.pubState !== "validated" || !skill.validation) {
      failed++;
      const it: PublishItem = { id: skill.id, name: skill.name, relPath: skill.relPath, ok: false, phase: "publish", reason: "not validated — run validate first", code: null, status: null };
      skill.publishItem = it;
      items.push(it);
      continue;
    }
    // Namespace-bound validation: publish MUST use the exact namespace that was
    // dry-run validated. A mismatch (operator switched the dropdown) is denied
    // WITHOUT a publish call — the operator must re-validate against <namespace>.
    if (skill.validation.namespace !== namespace) {
      failed++;
      const it: PublishItem = { id: skill.id, name: skill.name, relPath: skill.relPath, ok: false, phase: "publish", reason: `namespace mismatch — validated against '${skill.validation.namespace}', re-validate against '${namespace}'`, code: null, status: null };
      skill.pubState = "failed";
      skill.publishItem = it;
      items.push(it);
      continue;
    }
    let zip: Buffer;
    try {
      zip = packageSkill(skill);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failed++;
      const it: PublishItem = { id: skill.id, name: skill.name, relPath: skill.relPath, ok: false, phase: "package", reason, code: null, status: null };
      skill.publishItem = it;
      items.push(it);
      continue;
    }
    let out: import("./hub-publish.js").PublishOutcome;
    try {
      out = await publishSkill(cfg, namespace, { name: skill.name, zip });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failed++;
      const it: PublishItem = { id: skill.id, name: skill.name, relPath: skill.relPath, ok: false, phase: "publish", reason, code: null, status: null };
      skill.publishItem = it;
      items.push(it);
      continue;
    }
    const it: PublishItem = {
      id: skill.id, name: skill.name, relPath: skill.relPath,
      ok: out.ok, phase: "publish", reason: out.reason, code: out.code,
      status: out.ok ? out.status : null, // preserve Hub PublishResponse.status (e.g. PENDING_REVIEW)
    };
    skill.publishItem = it;
    skill.pubState = out.ok ? "published" : "failed";
    if (out.ok) succeeded++; else failed++;
    items.push(it);
  }
  return { items, total: skills.length, succeeded, failed };
}

/** Package one skill dir into a zip buffer (bounded). Throws on bound breach. */
export function packageSkill(skill: DiscoveredSkill): Buffer {
  return zipDir(skill.dir).buffer;
}
