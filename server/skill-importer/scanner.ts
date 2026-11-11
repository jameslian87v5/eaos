/**
 * scanner.ts — discover Skill candidates from an extracted directory.
 *
 * A "Skill candidate" = a directory containing a valid `SKILL.md`. The Hub
 * skill-package shape is top-level SKILL.md + assets (forensics §5b). We keep
 * `scripts/`, `references/`, `assets/` (same-dir resources) with the package.
 *
 * Non-Skill content (Claude Code Agent persona, command, hook, MCP server,
 * awesome-list links, plain markdown without SKILL.md) is IGNORED — those
 * directories simply have no SKILL.md, so they never become candidates. We do
 * NOT auto-convert anything (directive §5: 自动转换会改变语义).
 *
 * Nested discovery: a repo may have multiple skills under `skills/<name>/`.
 * We walk recursively; every dir with its OWN SKILL.md is a candidate. If a
 * parent and child both have SKILL.md, the child wins (more specific); the
 * parent's SKILL.md is treated as a candidate only if no child beneath it has
 * one (avoids double-packaging a nested skill).
 *
 * Root SKILL.md (Hub single-skill package shape — verified against real Hub
 * package `global/agentguard@1.1`: ZIP root holds SKILL.md + package.json +
 * scripts/ + root .md files, no wrapper dir): the scan root itself is a
 * candidate iff it directly contains SKILL.md and no deeper dir beneath it has
 * its own (same parent/child rule). Its relPath is "."; its name prefers the
 * SKILL.md frontmatter `name:` (e.g. "agentguard"), else the caller-provided
 * `rootName` (upload filename / repo basename), else "(root)". The temp dir
 * basename must never leak as a skill name.
 */
import fs from "node:fs";
import path from "node:path";

export interface DiscoveredSkill {
  /** Skill name = the SKILL.md's parent directory name (Hub derives slug from package). */
  name: string;
  /** Absolute path to the skill directory (top-level SKILL.md lives here). */
  dir: string;
  /** Relative path from the scan root (for UI display). */
  relPath: string;
  /** First heading or first non-empty line of SKILL.md (preview). */
  description: string;
  /** True if the package contains a `scripts/` subdir (UI safety flag). */
  hasScripts: boolean;
  /** True if a LICENSE file exists in or beside the skill dir. */
  license: string | null;
  /** Files (relative to skill dir) included in the package. */
  files: string[];
}

export interface ScanResult {
  skills: DiscoveredSkill[];
  /** Directories scanned that had no SKILL.md (ignored — UI shows count). */
  ignoredCount: number;
}

const MAX_SKILL_FILES = 500;
const MAX_SKILL_DESC_LEN = 200;

function readDescription(skillMdPath: string): string {
  try {
    const text = fs.readFileSync(skillMdPath, "utf8");
    // Strip YAML frontmatter if present.
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    // First non-empty, non-heading line; else first heading.
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("#")) return t.replace(/^#+\s*/, "").slice(0, MAX_SKILL_DESC_LEN);
      return t.slice(0, MAX_SKILL_DESC_LEN);
    }
    return "(no description)";
  } catch {
    return "(unreadable SKILL.md)";
  }
}

/** Frontmatter `name:` if present (real Hub SKILL.md shape: `name: agentguard`). */
function readFrontmatterName(skillMdPath: string): string | null {
  try {
    const text = fs.readFileSync(skillMdPath, "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    const nm = fm[1].match(/^name:[ \t]*(.+)$/m);
    if (!nm) return null;
    const v = nm[1].trim().replace(/^["']|["']$/g, "").slice(0, 100).trim();
    return v || null;
  } catch {
    return null;
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    if (out.length > MAX_SKILL_FILES) throw new Error(`skill has too many files (> ${MAX_SKILL_FILES})`);
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(cur, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // skip symlinks (path-traversal defense)
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

function findLicense(skillDir: string): string | null {
  for (const c of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"]) {
    const p = path.join(skillDir, c);
    try {
      if (fs.existsSync(p)) return c;
    } catch {}
  }
  return null;
}

/**
 * Recursively scan `root` for Skill candidates. A dir is a candidate iff it
 * contains `SKILL.md` AND no deeper dir beneath it (within root) has its own
 * `SKILL.md` — including the scan root itself (Hub single-skill package
 * shape). This picks the most-specific skill boundary and avoids packing a
 * parent that would duplicate a nested child.
 *
 * `rootName` is the fallback display name for a ROOT candidate without a
 * frontmatter `name:` (e.g. the uploaded ZIP filename or repo basename) —
 * never the temp-dir basename.
 */
export function scanForSkills(root: string, rootName?: string): ScanResult {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("scan root is not a directory");
  }
  const skills: DiscoveredSkill[] = [];
  const ignored: string[] = [];

  // First pass: collect every dir that has its own SKILL.md (root included).
  const candidates: string[] = [];
  const allDirs: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(cur);
    } catch {
      continue;
    }
    const hasSkillMd = names.includes("SKILL.md");
    if (cur !== root) allDirs.push(cur);
    if (hasSkillMd) candidates.push(cur);
    for (const name of names) {
      const full = path.join(cur, name);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) stack.push(full);
      } catch {}
    }
  }

  // De-dupe: drop a candidate if any other candidate is nested beneath it
  // (the nested one is the real skill boundary). Keep deepest candidates.
  // The scan root is a prefix of every path, so a root SKILL.md is dropped
  // whenever any nested skill exists — same parent/child rule.
  const skillDirs = candidates.filter((c) => {
    return !candidates.some((o) => o !== c && o.startsWith(c + path.sep));
  });

  for (const d of skillDirs) {
    const skillMdPath = path.join(d, "SKILL.md");
    // Validate SKILL.md is a real file (not a dir/symlink trick).
    try {
      const st = fs.lstatSync(skillMdPath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const files = listFiles(d);
    if (!files.includes("SKILL.md")) continue;
    const isRoot = d === root;
    // Name: frontmatter `name:` (self-declared) → dir basename (nested) →
    // rootName (root) → "(root)". Temp-dir basename must never leak.
    const name = readFrontmatterName(skillMdPath)
      ?? (isRoot ? (rootName ?? "(root)") : path.basename(d));
    skills.push({
      name,
      dir: d,
      relPath: isRoot ? "." : path.relative(root, d).replace(/\\/g, "/"),
      description: readDescription(skillMdPath),
      hasScripts: files.some((f) => f === "scripts" || f.startsWith("scripts/") || f.startsWith("scripts\\")),
      license: findLicense(d),
      files,
    });
  }

  // Ignored = dirs with no own SKILL.md (Agent/Command/Hook/MCP/plain-md).
  const skillDirSet = new Set(skillDirs.map((d) => d.toLowerCase()));
  for (const d of allDirs) {
    if (!skillDirSet.has(d.toLowerCase())) ignored.push(d);
  }

  return { skills, ignoredCount: ignored.length };
}
