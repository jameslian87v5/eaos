/**
 * skill-zip-import.ts — M3a: admin-only, safe LOCAL ZIP skill import.
 *
 * One entry, one pipeline: this module reuses the existing bounded-safe ZIP
 * extractor (skillhub-zip-extract), skill scanner (skill-importer/scanner),
 * and Hub→native repackage adapter (skillhub-repackage) — no second package
 * shell. The package is installed to a quarantine path under the governed
 * skills/ root and registered `enabled:false`; becoming usable still requires
 * the existing explicit admin enable + entitlement/activation/resolve guards.
 *
 * Trust model (deny-wins):
 *  - slug/version come from the admin request (TRUSTED, like the Hub bridge's
 *    resolved metadata) — the ZIP's own self-declared names never choose the
 *    install path. Both are validated as safe path segments before use.
 *  - the ZIP body is fully untrusted: bounded extraction (≤2000 entries,
 *    ≤64MB total, ≤16MB per file, 100:1 ratio; no symlink/absolute/`..`),
 *    exactly one discovered skill, then a synthesized native-plugin shell.
 *  - the installed tree is validated by the REAL resolveOne() before the
 *    registry row is written; any failure rolls back the directory so no
 *    partial install or registry row survives.
 *  - the returned manifest is secret-free: file list, script flag, license,
 *    content hash. Import success ≠ usable.
 */
import fs from "node:fs";
import path from "node:path";
import { extractZip, computeContentFingerprint } from "./skillhub-zip-extract.js";
import { scanForSkills } from "./skill-importer/scanner.js";
import { repackageToNativePlugin } from "./skillhub-repackage.js";
import { resolveOne, SKILLS_ROOT, SKILLS_CONFIG, type SkillConfigEntry } from "./skill-config.js";

const QUARANTINE_ROOT = path.join(SKILLS_ROOT, "quarantine");

// Same slug/version contracts as skillhub-repackage (trusted-input gate).
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const MAX_SLUG_LEN = 64;

// M3a bounds per instruction: ≤2000 files, ≤64MB total, per-file bound,
// zip-bomb ratio. Compressed payload is bounded by the route's body limit.
const IMPORT_BOUNDS = {
  maxEntries: 2000,
  maxTotalUncompressed: 64 * 1024 * 1024,
  maxFileUncompressed: 16 * 1024 * 1024,
  maxRatio: 100,
};

export interface SkillZipImportRequest {
  /** Admin-supplied trusted slug — also the registry name + install dir. */
  slug: string;
  /** Admin-supplied trusted version (default "1.0.0"). */
  version?: string;
  /** Raw ZIP bytes (bounded by the route's body limit). */
  zipBuffer: Buffer;
  /**
   * M7b: caller provenance stamped into the registry row (user submissions).
   * Absent on the admin import route — metadata only, never gates resolution.
   */
  submittedBy?: string;
  /** M7b: submission ledger id linking the row to its review record. */
  submissionId?: string;
}

/** Secret-free review manifest. Import success ≠ usable (enabled:false). */
export interface SkillZipImportManifest {
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  sourceKind: "zip";
  copyPolicy: "snapshot";
  sha256: string;
  importedAt: string;
  fileCount: number;
  files: string[];
  hasScripts: boolean;
  license: string | null;
  description: string;
  warnings: string[];
  validationErrors: string[];
}

export class SkillZipImportError extends Error {
  /** Categorical code — safe for audit reasonSummary (no paths/payload). */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillZipImportError";
    this.code = code;
  }
}

function registryPathFor(slug: string): string {
  return `skills/quarantine/${slug}`;
}

/**
 * Fail-closed registry load (M3a fix round): a PRESENT-but-invalid registry
 * (malformed JSON / non-array / non-object entries) throws instead of being
 * treated as empty — otherwise a successful import would atomically replace
 * data/skills.json with a one-row registry and destroy the unreadable prior
 * config. Only a genuinely absent file means "empty registry". This runs
 * during the duplicate pre-check, i.e. before any ZIP extraction/install.
 */
function loadSkillRegistry(): SkillConfigEntry[] {
  if (!fs.existsSync(SKILLS_CONFIG)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(SKILLS_CONFIG, "utf8"));
  } catch {
    throw new SkillZipImportError("registry_invalid", "data/skills.json is malformed — refusing import so the registry is not overwritten");
  }
  if (!Array.isArray(parsed)) {
    throw new SkillZipImportError("registry_invalid", "data/skills.json is not a JSON array — refusing import so the registry is not overwritten");
  }
  if (parsed.some((e) => !e || typeof e !== "object" || Array.isArray(e))) {
    throw new SkillZipImportError("registry_invalid", "data/skills.json contains a non-object entry — refusing import so the registry is not overwritten");
  }
  return parsed as SkillConfigEntry[];
}

function appendSkillConfigAtomic(entry: SkillConfigEntry): void {
  const config = loadSkillRegistry();
  if (config.some((c) => c && c.name === entry.name)) {
    throw new SkillZipImportError("duplicate", `skill "${entry.name}" already registered`);
  }
  config.push(entry);
  const tmpPath = SKILLS_CONFIG + ".tmp";
  fs.mkdirSync(path.dirname(SKILLS_CONFIG), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmpPath, SKILLS_CONFIG);
}

/**
 * M7b fix round P1-1: compensate a FRESH import when a post-import step (the
 * submission ledger write) fails — atomically removes the registry row this
 * submissionId installed plus the quarantine directory, so no orphan survives.
 * Defense: a row whose submissionId does not match is never touched.
 */
export function removeImportedSkill(slug: string, submissionId: string): boolean {
  const config = loadSkillRegistry();
  const entry = config.find((c) => c && c.name === slug);
  if (!entry) return false;
  if (entry.submissionId !== submissionId) return false;
  const next = config.filter((c) => c !== entry);
  const tmpPath = SKILLS_CONFIG + ".tmp";
  fs.mkdirSync(path.dirname(SKILLS_CONFIG), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmpPath, SKILLS_CONFIG);
  try { fs.rmSync(path.join(QUARANTINE_ROOT, slug), { recursive: true, force: true }); } catch {}
  return true;
}

/**
 * Import one local skill ZIP into quarantine. Throws SkillZipImportError on
 * any violation; on failure neither a partial directory nor a registry row
 * survives. Returns the review manifest on success.
 */
export function importSkillZip(req: SkillZipImportRequest): SkillZipImportManifest {
  const { zipBuffer } = req;
  const slug = (req.slug ?? "").trim();
  const version = (req.version ?? "").trim() || "1.0.0";

  if (!SLUG_RE.test(slug) || slug.length > MAX_SLUG_LEN) {
    throw new SkillZipImportError("invalid_slug", `invalid slug: must match /^[a-z0-9][a-z0-9-]*$/i and be ≤${MAX_SLUG_LEN} chars`);
  }
  if (!VERSION_RE.test(version)) {
    throw new SkillZipImportError("invalid_version", `invalid version: must match /^[A-Za-z0-9][A-Za-z0-9._+-]*$/`);
  }
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    throw new SkillZipImportError("empty_zip", "no ZIP payload received");
  }
  // Defense-in-depth: never write a huge body to temp disk even if the route
  // limit is raised later.
  if (zipBuffer.length > 80 * 1024 * 1024) {
    throw new SkillZipImportError("zip_too_large", "ZIP payload exceeds 80MB request bound");
  }

  // Duplicate rejection — registry row and/or install dir already present.
  if (loadSkillRegistry().some((c) => c && c.name === slug)) {
    throw new SkillZipImportError("duplicate", `skill "${slug}" already registered`);
  }
  fs.mkdirSync(QUARANTINE_ROOT, { recursive: true });
  const finalDir = path.join(QUARANTINE_ROOT, slug);
  if (fs.existsSync(finalDir)) {
    throw new SkillZipImportError("duplicate", `quarantine path already occupied: skills/quarantine/${slug}`);
  }

  // Staging lives under quarantine so the final install is a same-filesystem
  // atomic rename. Everything under staging is discarded on any outcome.
  const stagingDir = fs.mkdtempSync(path.join(QUARANTINE_ROOT, "staging-"));
  try {
    const incomingZip = path.join(stagingDir, "incoming.zip");
    const extractDir = path.join(stagingDir, "extract");
    const pkgDir = path.join(stagingDir, "pkg");
    fs.writeFileSync(incomingZip, zipBuffer);

    // 1. Bounded-safe extraction (deny-wins on traversal/abs/symlink/method/
    //    CRC/entry-count/size/ratio; removes extract dir on failure).
    try {
      extractZip(incomingZip, extractDir, IMPORT_BOUNDS);
    } catch (err) {
      throw new SkillZipImportError("extract_failed", `ZIP rejected: ${(err as Error).message}`);
    }

    // 2. Deterministic content-tree fingerprint of the extracted package,
    //    BEFORE repackage mutates the tree.
    const fingerprint = computeContentFingerprint(extractDir);

    // 3. Exactly one skill candidate. 0 → not a skill package; >1 → refuse
    //    to guess which skill the admin meant.
    let scan: ReturnType<typeof scanForSkills>;
    try {
      scan = scanForSkills(extractDir, slug);
    } catch (err) {
      throw new SkillZipImportError("scan_failed", `package scan failed: ${(err as Error).message}`);
    }
    if (scan.skills.length === 0) {
      throw new SkillZipImportError("no_skill", "no SKILL.md found in package — not a skill package");
    }
    if (scan.skills.length > 1) {
      throw new SkillZipImportError("multiple_skills", `package contains ${scan.skills.length} skills — import exactly one per ZIP`);
    }
    const discovered = scan.skills[0];

    // 4. Repackage into native-plugin layout. The .claude-plugin/plugin.json
    //    descriptor is synthesized from the TRUSTED slug/version; the skill's
    //    own assets move under skills/<slug>/.
    try {
      repackageToNativePlugin(discovered.dir, pkgDir, { slug, version });
    } catch (err) {
      throw new SkillZipImportError("repackage_failed", `repackage failed: ${(err as Error).message}`);
    }

    // 5. Atomic install into the governed skills/ root.
    if (fs.existsSync(finalDir)) {
      throw new SkillZipImportError("duplicate", `quarantine path already occupied: skills/quarantine/${slug}`);
    }
    fs.renameSync(pkgDir, finalDir);

    // 6. Validate the INSTALLED tree with the real validator (identical
    //    invariants to the enable path). Invalid → roll back the directory.
    const entry: SkillConfigEntry = {
      name: slug,
      type: "plugin",
      enabled: false,
      path: registryPathFor(slug),
      sourceKind: "zip",
      sha256: fingerprint,
      importedAt: new Date().toISOString(),
      copyPolicy: "snapshot",
      // M3b fix round: server-authoritative script flag (scanner) persisted in
      // the registry row — the review warning must survive any client state.
      hasScripts: discovered.hasScripts,
      // M7b: submitter provenance (user submissions; admin imports omit).
      ...(req.submittedBy !== undefined ? { submittedBy: req.submittedBy } : {}),
      ...(req.submissionId !== undefined ? { submissionId: req.submissionId } : {}),
    };
    const resolved = resolveOne(entry);
    if (!resolved.valid) {
      try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch {}
      throw new SkillZipImportError("invalid_plugin", `native plugin validation failed: ${resolved.error}`);
    }

    // 7. Registry row (atomic append; enabled:false — import ≠ usable).
    try {
      appendSkillConfigAtomic(entry);
    } catch (err) {
      try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch {}
      throw err;
    }

    const warnings: string[] = [];
    if (discovered.hasScripts) {
      warnings.push("package contains scripts/ — review before enabling");
    }

    return {
      name: slug,
      version,
      path: registryPathFor(slug),
      enabled: false,
      sourceKind: "zip",
      copyPolicy: "snapshot",
      sha256: fingerprint,
      importedAt: entry.importedAt!,
      fileCount: discovered.files.length,
      files: discovered.files,
      hasScripts: discovered.hasScripts,
      license: discovered.license,
      description: discovered.description,
      warnings,
      validationErrors: [],
    };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}
