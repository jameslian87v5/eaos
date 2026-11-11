// Production skill persistence — REAL behavior test (round 4).
// Imports the actual resolveOne() from skill-config.ts and proves that
// `skills/<name>` resolves under SKILLS_ROOT and `plugins/<name>` under
// PLUGINS_ROOT, OFF the code checkout, with the realpath traversal guard
// still rejecting escapes. Run: npx tsx server/skills-root.test.ts
//
// skill-config.ts captures SKILLS_ROOT/PLUGINS_ROOT at module load, so we
// set the env BEFORE the dynamic import (fresh process → module not cached).
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// --- Build a persistent tree in tmp that does NOT exist in the checkout ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-root-"));
const skillsRoot = path.join(tmp, "skills");
const pluginsRoot = path.join(tmp, "plugins");

// Unique names that are NOT present in the real checkout, so any successful
// resolution MUST come from the tmp persistent roots, not the checkout.
const SKILL_NAME = "prod-skill-a";
const PLUGIN_NAME = "prod-plugin-a";

function seedPlugin(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", description: "seeded" }),
  );
  fs.mkdirSync(path.join(dir, "skills", "inner"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "inner", "SKILL.md"), `# ${name}`);
}

seedPlugin(skillsRoot, SKILL_NAME);
seedPlugin(pluginsRoot, PLUGIN_NAME);

// Sanity: neither name exists in the code checkout (proves off-checkout).
ok(
  "skill name absent from checkout plugins/skills",
  !fs.existsSync(path.join(process.cwd(), "skills", SKILL_NAME)) &&
    !fs.existsSync(path.join(process.cwd(), "plugins", PLUGIN_NAME)),
);

// Set env BEFORE import so module-load consts pick up the tmp roots.
process.env.SKILLS_ROOT = skillsRoot;
process.env.PLUGINS_ROOT = pluginsRoot;
// Sanity: the persistent roots are outside the checkout.
ok("SKILLS_ROOT is off-checkout", !skillsRoot.startsWith(process.cwd()));
ok("PLUGINS_ROOT is off-checkout", !pluginsRoot.startsWith(process.cwd()));

const { resolveOne } = await import("./skill-config.js");

// macOS temp dirs live under /var → /private/var symlink, so compare
// against the realpath of the persistent roots (resolveOne returns the
// realpath of the candidate).
const skillsRootReal = fs.realpathSync(skillsRoot);
const pluginsRootReal = fs.realpathSync(pluginsRoot);

// 1. skills/<name> resolves under SKILLS_ROOT, valid.
const r1 = resolveOne({ name: SKILL_NAME, type: "plugin", enabled: true, path: `skills/${SKILL_NAME}` });
ok("skill resolves valid", r1.valid, r1.error || "");
ok("skill absolutePath under SKILLS_ROOT", r1.absolutePath.startsWith(skillsRootReal + path.sep), r1.absolutePath);
ok("skill absolutePath NOT under checkout", !r1.absolutePath.startsWith(process.cwd()));

// 2. plugins/<name> resolves under PLUGINS_ROOT, valid — this is the
// "install plugin → switch checkout → still resolvable" guarantee: the
// plugin lives only in the persistent root, never in the checkout, yet
// resolveOne finds it.
const r2 = resolveOne({ name: PLUGIN_NAME, type: "plugin", enabled: true, path: `plugins/${PLUGIN_NAME}` });
ok("plugin resolves valid", r2.valid, r2.error || "");
ok("plugin absolutePath under PLUGINS_ROOT", r2.absolutePath.startsWith(pluginsRootReal + path.sep), r2.absolutePath);
ok("plugin absolutePath NOT under checkout", !r2.absolutePath.startsWith(process.cwd()));

// 3. Traversal escape is rejected (realpath containment guard intact).
const r3 = resolveOne({ name: "evil", type: "plugin", enabled: true, path: "skills/../../etc" });
ok("traversal rejected", !r3.valid);

// 4. Missing skill under persistent root is rejected.
const r4 = resolveOne({ name: "nope", type: "plugin", enabled: true, path: "skills/nope" });
ok("missing skill rejected", !r4.valid);

// 5. Unknown prefix (no skills/ or plugins/) falls through and is rejected
//    by the containment check (cannot resolve under an allowed root).
const r5 = resolveOne({ name: SKILL_NAME, type: "plugin", enabled: true, path: "../etc/passwd" });
ok("bare host path rejected", !r5.valid);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, 0 failed`);
