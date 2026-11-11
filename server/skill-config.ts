/**
 * skill-config.ts — reads data/skills.json and resolves local plugin skills.
 *
 * Security invariants:
 *   - All skill paths must resolve within the project's skills/ or plugins/ directory.
 *   - realpath() is used to detect symlink escapes and ../traversal.
 *   - Only type "plugin" is supported in MVP (type "mcp" is rejected with a warning).
 *   - No API accepts arbitrary host paths from the frontend.
 */

import path from "path";
import fs from "fs";

const PROJECT_ROOT = process.cwd();
// SKILLS_ROOT: production overrides this to a persistent disk
// (/var/lib/chit-agentos/skills) so release switches never lose installed
// skills. Default keeps the repo's bundled skills/ dir (used for first-time
// init and local dev). See production-release-runbook.md §2.
const SKILLS_ROOT = process.env.SKILLS_ROOT
  ? path.resolve(process.env.SKILLS_ROOT)
  : path.resolve(PROJECT_ROOT, "skills");
// M3a: skill-zip-import installs quarantined imports under SKILLS_ROOT and
// appends registry rows to SKILLS_CONFIG, so both are exported.
export { SKILLS_ROOT };
// PLUGINS_ROOT: where Skill Hub / native plugin packages are installed.
// Production overrides this to a persistent disk
// (/var/lib/chit-agentos/plugins) so installed Hub skills + hook-plugins
// survive release switches / clean clones. Default = repo plugins/ for dev.
const PLUGINS_ROOT = process.env.PLUGINS_ROOT
  ? path.resolve(process.env.PLUGINS_ROOT)
  : path.resolve(PROJECT_ROOT, "plugins");
export const SKILLS_CONFIG = path.resolve(PROJECT_ROOT, "data", "skills.json");

// Ensure skills/ + plugins/ roots exist (P4: fresh clone / empty dir)
fs.mkdirSync(SKILLS_ROOT, { recursive: true });
fs.mkdirSync(PLUGINS_ROOT, { recursive: true });

// Valid skill name: alphanumeric + . _ - only, no path separators (P3)
const VALID_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

// ─── Types ───────────────────────────────────────────────────

// Supply-chain provenance for a skill entry (M3a). Legacy rows that predate
// these fields are inferred as sourceKind "local" at load time (in memory;
// the on-disk legacy row is never rewritten just because it was read).
export type SkillSourceKind = "local" | "zip" | "hub" | "market";
export type SkillCopyPolicy = "snapshot" | "track";

export interface SkillConfigEntry {
  name: string;
  type: "plugin" | "mcp";
  enabled: boolean;
  path: string;
  /** Where this skill came from. Absent on legacy rows → inferred "local". */
  sourceKind?: SkillSourceKind;
  /** Origin URL for "hub"/"market"/"zip" imports (informational only). */
  sourceUrl?: string;
  /** Immutable upstream ref (commit sha / package version pin). */
  immutableRef?: string;
  /** Deterministic content-tree fingerprint at import time. */
  sha256?: string;
  /** ISO timestamp of when the package was imported. */
  importedAt?: string;
  /** "snapshot" = local copy never follows upstream; "track" = follows. */
  copyPolicy?: SkillCopyPolicy;
  /**
   * M3b fix round: import-time script flag from the scanner (server-authoritative
   * review warning — never client-local state). Absent on legacy rows → no marker.
   */
  hasScripts?: boolean;
  /**
   * M7b: provenance for user-submitted skills — the submitter's userId. Absent
   * on admin/legacy imports. Metadata only: it never gates resolution
   * (entitlement does); it exists for audit/review views.
   */
  submittedBy?: string;
  /** M7b: links the registry row to its submission ledger record. */
  submissionId?: string;
}

export interface ResolvedSkill extends SkillConfigEntry {
  absolutePath: string;
  version: string;
  description: string;
  pluginName: string;
  declaredSkillNames: string[];
  valid: boolean;
  error?: string;
}

// ─── Internal helpers ────────────────────────────────────────

function loadConfig(): SkillConfigEntry[] {
  if (!fs.existsSync(SKILLS_CONFIG)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILLS_CONFIG, "utf8")) as SkillConfigEntry[];
    if (!Array.isArray(parsed)) return [];
    // M3a: legacy rows without sourceKind are inferred "local". In-memory
    // normalization only — reading never rewrites the file on disk.
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && entry.sourceKind === undefined) {
        entry.sourceKind = "local";
      }
    }
    return parsed;
  } catch (err) {
    console.warn("[SkillConfig] Failed to parse data/skills.json:", err);
    return [];
  }
}

// Map a config `path` ("skills/<name>" or "plugins/<name>") to the right
// runtime root. In production SKILLS_ROOT/PLUGINS_ROOT point at persistent
// disks (/var/lib/chit-agentos/{skills,plugins}); the repo's bundled dirs
// are only used for first-time seeding. This keeps resolution OFF the code
// checkout so a release switch never invalidates installed skills. The
// realpath containment check below still prevents traversal escapes.
function rootForPath(skillPath: string): string {
  // Normalize: strip leading ./ and any parent-dir attempts up front.
  const normalized = skillPath.replace(/^\.\//, "");
  if (normalized.startsWith("skills/") || normalized === "skills") return SKILLS_ROOT;
  if (normalized.startsWith("plugins/") || normalized === "plugins") return PLUGINS_ROOT;
  // Unknown prefix: fall through to PROJECT_ROOT (legacy) but the
  // containment check will reject anything outside the allowed roots.
  return PROJECT_ROOT;
}

function resolveAndValidatePath(skillPath: string): string {
  const root = rootForPath(skillPath);
  // Resolve the path AGAINST the mapped root, not PROJECT_ROOT, so
  // "skills/hello-skill" lands under SKILLS_ROOT in production.
  const tail = skillPath.replace(/^(skills|plugins)\//, "");
  const candidate = path.resolve(root, tail);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Path does not exist: ${skillPath} (resolved under ${root})`);
  }
  const realCandidate = fs.realpathSync(candidate);
  const allowedRoots = [SKILLS_ROOT, PLUGINS_ROOT];
  const withinAllowed = allowedRoots.some((r) => {
    if (!fs.existsSync(r)) return false;
    const realRoot = fs.realpathSync(r);
    return realCandidate.startsWith(realRoot + path.sep) || realCandidate === realRoot;
  });
  if (!withinAllowed) {
    throw new Error(`Path escapes skills/ or plugins/ directory: ${skillPath}`);
  }
  return realCandidate;
}

export function resolveOne(cfg: SkillConfigEntry): ResolvedSkill {
  // Type gate
  if (cfg.type !== "plugin") {
    return { ...cfg, absolutePath: "", version: "", description: "", pluginName: "", declaredSkillNames: [], valid: false, error: `type "${cfg.type}" not supported (only "plugin" in MVP)` };
  }

  // Name validation — prevents path traversal in container path construction (P3)
  if (!VALID_SKILL_NAME.test(cfg.name)) {
    return { ...cfg, absolutePath: "", version: "", description: "", pluginName: "", declaredSkillNames: [], valid: false, error: `invalid skill name "${cfg.name}": must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` };
  }

  let absolutePath: string;
  try {
    absolutePath = resolveAndValidatePath(cfg.path);
  } catch (err) {
    return { ...cfg, absolutePath: "", version: "", description: "", pluginName: "", declaredSkillNames: [], valid: false, error: (err as Error).message };
  }

  // Claude Code native plugin manifest location.
  const pluginJsonPath = path.join(absolutePath, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(pluginJsonPath)) {
    return { ...cfg, absolutePath, version: "", description: "", pluginName: "", declaredSkillNames: [], valid: false, error: ".claude-plugin/plugin.json not found" };
  }

  let plugin: any;
  try {
    plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  } catch {
    return { ...cfg, absolutePath, version: "", description: "", pluginName: "", declaredSkillNames: [], valid: false, error: "plugin.json parse error" };
  }

  const pluginName = typeof plugin.name === "string" ? plugin.name : "";
  if (pluginName !== cfg.name) {
    return { ...cfg, absolutePath, version: "", description: "", pluginName, declaredSkillNames: [], valid: false, error: `plugin.name "${pluginName}" !== config name "${cfg.name}"` };
  }
  if (!plugin.version) {
    return { ...cfg, absolutePath, version: "", description: "", pluginName, declaredSkillNames: [], valid: false, error: "plugin.version is required" };
  }

  const skillsDir = typeof plugin.skills === "string" ? plugin.skills : "skills";
  const pluginSkillsRoot = path.resolve(absolutePath, skillsDir);
  if (!pluginSkillsRoot.startsWith(absolutePath + path.sep)) {
    return { ...cfg, absolutePath, version: "", description: "", pluginName, declaredSkillNames: [], valid: false, error: "plugin.skills must stay inside the plugin directory" };
  }

  if (!fs.existsSync(pluginSkillsRoot) || !fs.statSync(pluginSkillsRoot).isDirectory()) {
    return { ...cfg, absolutePath, version: "", description: "", pluginName, declaredSkillNames: [], valid: false, error: `${skillsDir}/ directory not found` };
  }

  const declaredSkillNames = fs.readdirSync(pluginSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillName) => fs.existsSync(path.join(pluginSkillsRoot, skillName, "SKILL.md")));

  if (declaredSkillNames.length === 0) {
    return { ...cfg, absolutePath, version: "", description: "", pluginName, declaredSkillNames: [], valid: false, error: `${skillsDir}/*/SKILL.md not found` };
  }

  return {
    ...cfg,
    absolutePath,
    version: plugin.version,
    description: plugin.description || "",
    pluginName,
    declaredSkillNames,
    valid: true,
  };
}

// ─── Public API ──────────────────────────────────────────────

/** Returns all skills (enabled + disabled) for Admin UI display. */
export function getAllSkills(): ResolvedSkill[] {
  return loadConfig().map(resolveOne);
}

/** Returns only valid, enabled plugin skills for CapabilityProvider injection. */
export function getEnabledPlugins(): ResolvedSkill[] {
  return loadConfig()
    .filter((cfg) => cfg.enabled)
    .map(resolveOne)
    .filter((s) => s.valid);
}

/**
 * Toggle a skill's enabled flag in data/skills.json.
 * Writes back the full config. Returns the resolved skill, or null if not found.
 * Only affects newly created runtimes (no hot reload).
 */
export function setSkillEnabled(name: string, enabled: boolean): ResolvedSkill | null {
  if (!VALID_SKILL_NAME.test(name)) return null;
  const config = loadConfig();
  const entry = config.find((c) => c.name === name);
  if (!entry) return null;
  entry.enabled = enabled;
  fs.mkdirSync(path.dirname(SKILLS_CONFIG), { recursive: true });
  fs.writeFileSync(SKILLS_CONFIG, JSON.stringify(config, null, 2) + "\n");
  console.log(`[SkillConfig] Skill "${name}" ${enabled ? "enabled" : "disabled"} (effective on new runtimes)`);
  return resolveOne(entry);
}
