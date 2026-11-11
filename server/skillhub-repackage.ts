/**
 * skillhub-repackage.ts — Hub skill package → platform native-plugin layout.
 *
 * R5b-2: the real iflytek/skillhub skill package is NOT in native-plugin
 * shape (top-level SKILL.md + an npm package.json), so importNativePlugin
 * (which validates .claude-plugin/plugin.json + skills/<slug>/SKILL.md) would
 * reject every real Hub skill. This adapter repackages the extracted Hub
 * package into native-plugin layout WITHOUT weakening importNativePlugin or
 * skill-config validation — the native validator runs unchanged on the
 * synthesized package.
 *
 * Trust model (deny-wins):
 *  - The .claude-plugin/plugin.json descriptor is synthesized from TRUSTED
 *    slug + version (passed by the bridge from the resolved Hub metadata),
 *    NOT copied from the untrusted extracted package.json (which is an npm
 *    manifest, not a plugin descriptor — using it would be a trust violation).
 *  - slug/version are validated as safe path segments before use.
 *  - Missing top-level SKILL.md → reject (not a skill), no import.
 *  - All extracted files are preserved UNDER skills/<slug>/ (the skill's own
 *    assets travel with it). Extracted filenames were already bounded by
 *    extractZip (no abs paths / traversal / symlinks), so moves stay safe.
 *  - On any failure, pkgDir is removed (no partial package — importNativePlugin
 *    would otherwise see a half-built tree).
 *
 * Provenance marker (.hub-source.json) is NOT written here — it is written by
 * importNativePlugin inside the installed plugins/<slug>/ (unchanged).
 */
import fs from "node:fs";
import path from "node:path";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export interface RepackageOpts {
  slug: string;
  version: string;
}

export class RepackageError extends Error {
  constructor(msg: string) { super(msg); this.name = "RepackageError"; }
}

/**
 * Repackage the extracted Hub package at `extractDir` into native-plugin
 * layout at `pkgDir`. Throws (RepackageError) on any trust/shape violation;
 * pkgDir is removed on failure.
 */
export function repackageToNativePlugin(extractDir: string, pkgDir: string, opts: RepackageOpts): void {
  const { slug, version } = opts;
  if (!SLUG_RE.test(slug)) throw new RepackageError(`invalid slug: ${JSON.stringify(slug)}`);
  if (!VERSION_RE.test(version)) throw new RepackageError(`invalid version: ${JSON.stringify(version)}`);
  if (!fs.existsSync(extractDir)) throw new RepackageError(`extractDir missing: ${extractDir}`);

  // Require a top-level SKILL.md — this is what makes the package a "skill".
  const skillMd = path.join(extractDir, "SKILL.md");
  const st = fs.statSync(skillMd, { throwIfNoEntry: false });
  if (!st || !st.isFile()) {
    throw new RepackageError("missing top-level SKILL.md — not a Hub skill package");
  }

  // Fresh pkgDir (remove any prior partial).
  fs.rmSync(pkgDir, { recursive: true, force: true });
  const pluginDir = path.join(pkgDir, ".claude-plugin");
  const skillDir = path.join(pkgDir, "skills", slug);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });

  try {
    // 1. Synthesize the native-plugin descriptor from TRUSTED slug/version.
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: slug, version, description: `Skill Hub ${slug}` }) + "\n",
    );

    // 2. Move EVERY extracted entry under skills/<slug>/ (preserve all skill
    //    assets; including SKILL.md → skills/<slug>/SKILL.md). The extracted
    //    tree was already bounded by extractZip, so entries are safe names.
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      const src = path.join(extractDir, entry.name);
      const dst = path.join(skillDir, entry.name);
      // Defense-in-depth: the entry name must still resolve inside skillDir.
      const resolvedDst = path.resolve(dst);
      const base = path.resolve(skillDir) + path.sep;
        if (resolvedDst !== path.resolve(skillDir) && !resolvedDst.startsWith(base)) {
        throw new RepackageError(`extracted entry escapes skillDir: ${entry.name}`);
      }
      fs.renameSync(src, dst);
    }
  } catch (err) {
    // Failure cleanup: no partial package survives.
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}
