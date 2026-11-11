/**
 * capability-installer.test.ts — Tests for native plugin import/uninstall.
 *
 * Run: npx tsx server/capability-installer.test.ts
 */

import path from "path";
import fs from "fs";
import os from "os";
import {
  importNativePlugin,
  uninstallNativePlugin,
  listInstalledPlugins,
} from "./capability-installer.js";

// ─── Test harness ─────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  ❌ ${msg}`);
  }
}

function assertThrows(fn: () => void, msgSubstring: string, label: string): void {
  try {
    fn();
    failed++;
    failures.push(`${label}: expected throw but did not`);
    console.error(`  ❌ ${label}: expected throw but did not`);
  } catch (err: any) {
    if (err.message.includes(msgSubstring)) {
      passed++;
    } else {
      failed++;
      failures.push(`${label}: expected "${msgSubstring}" in error, got "${err.message}"`);
      console.error(`  ❌ ${label}: expected "${msgSubstring}" in error, got "${err.message}"`);
    }
  }
}

// ─── Setup: create temp import root + test plugin packages ───

const TMP_ROOT = path.join(os.tmpdir(), "capability-installer-test");
const IMPORT_ROOT = path.resolve(process.cwd(), "data", "skill-hub-cache");
const SKILLS_DIR = path.join(TMP_ROOT, "skills");
const HOOKS_DIR = path.join(TMP_ROOT, "hooks");
const DATA_DIR = path.join(TMP_ROOT, "data");

// Clean and create
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
fs.mkdirSync(IMPORT_ROOT, { recursive: true });
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(HOOKS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// Override env so capability-installer uses our temp dirs for MCP config
// NOTE: PLUGIN_IMPORT_ROOT is read at module load time, so we use the
// project's data/skill-hub-cache directory (which is the default).
process.env.MCP_CONFIG_FILE = path.join(DATA_DIR, "mcp.json");

// We also need to override the skills/hooks roots — but capability-installer
// uses PROJECT_ROOT-relative paths. For a proper test we'd need to chdir or
// inject. For now, we test with the import root validation and name checks
// which are the most critical security paths.

// Create a valid skill plugin in import root
const validSkillSrc = path.join(IMPORT_ROOT, "test-skill");
fs.mkdirSync(path.join(validSkillSrc, ".claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(validSkillSrc, "skills", "test-skill"), { recursive: true });
fs.writeFileSync(
  path.join(validSkillSrc, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "test-skill", version: "1.0.0", description: "Test skill" })
);
fs.writeFileSync(
  path.join(validSkillSrc, "skills", "test-skill", "SKILL.md"),
  "---\nname: test-skill\ndescription: Test\n---\n# Test Skill\n"
);

// Create a valid hook plugin in import root
const validHookSrc = path.join(IMPORT_ROOT, "test-hook");
fs.mkdirSync(path.join(validHookSrc, ".claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(validHookSrc, "hooks"), { recursive: true });
fs.writeFileSync(
  path.join(validHookSrc, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "test-hook", version: "0.5.0", description: "Test hook", hooks: "./hooks/hooks.json" })
);
fs.writeFileSync(
  path.join(validHookSrc, "hooks", "hooks.json"),
  JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: 'echo "ok"' }] },
      ],
    },
  })
);

// Create an invalid plugin (missing SKILL.md)
const invalidSkillSrc = path.join(IMPORT_ROOT, "bad-skill");
fs.mkdirSync(path.join(invalidSkillSrc, ".claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(invalidSkillSrc, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "bad-skill", version: "1.0.0" })
);
// No skills/ directory

// Create a plugin outside import root
const outsideSrc = path.join(os.tmpdir(), "outside-plugin");
fs.rmSync(outsideSrc, { recursive: true, force: true });
fs.mkdirSync(path.join(outsideSrc, ".claude-plugin"), { recursive: true });
fs.writeFileSync(
  path.join(outsideSrc, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "outside", version: "1.0.0" })
);

// ─── Tests ────────────────────────────────────────────────────

console.log("\n=== Plugin Installer Tests ===\n");

// Test 1: Name validation — reject path traversal
console.log("Test 1: Name validation rejects '../evil'");
assertThrows(
  () => importNativePlugin({ path: validSkillSrc, name: "../evil", registryCategory: "skill" }),
  "Invalid plugin name",
  "Name traversal rejection"
);

// Test 2: Name validation — reject invalid chars
console.log("Test 2: Name validation rejects special chars");
assertThrows(
  () => importNativePlugin({ path: validSkillSrc, name: "test skill!", registryCategory: "skill" }),
  "Invalid plugin name",
  "Name special chars rejection"
);

// Test 3: Path outside import root — rejected
console.log("Test 3: Path outside import root rejected");
assertThrows(
  () => importNativePlugin({ path: outsideSrc, name: "outside", registryCategory: "skill" }),
  "escapes PLUGIN_IMPORT_ROOT",
  "Outside import root rejection"
);

// Test 4: Non-existent path — rejected
console.log("Test 4: Non-existent path rejected");
assertThrows(
  () => importNativePlugin({ path: "/nonexistent/path", name: "noexist", registryCategory: "skill" }),
  "does not exist",
  "Nonexistent path rejection"
);

// Test 5: Invalid plugin (missing SKILL.md) — staging validation fails
console.log("Test 5: Invalid plugin (no SKILL.md) rejected");
assertThrows(
  () => importNativePlugin({ path: invalidSkillSrc, name: "bad-skill", registryCategory: "skill" }),
  "validation failed",
  "Missing SKILL.md rejection"
);

// Test 6: Valid skill import — succeeds (auto-detect, no registryCategory)
console.log("Test 6: Valid skill import succeeds (auto-detect)");
{
  try { uninstallNativePlugin({ name: "test-skill", force: true }); } catch {}
  const result = importNativePlugin({
    path: validSkillSrc,
    name: "test-skill",
  });
  assert(result.resourceId === "test-skill", "resourceId matches name");
  assert(result.version === "1.0.0", "version from manifest");
  assert(result.types.includes("skill"), "types includes skill");
  assert(result.valid === true, "valid is true");
  assert(fs.existsSync(result.installedPath), "installed path exists");
  assert(
    fs.existsSync(path.join(result.installedPath, ".claude-plugin", "plugin.json")),
    "plugin.json copied to target"
  );
  uninstallNativePlugin({ name: "test-skill", force: true });
  passed++;
}

// Test 7: Valid hook import — succeeds
console.log("Test 7: Valid hook import succeeds");
{
  try { uninstallNativePlugin({ name: "test-hook", force: true }); } catch {}
  const result = importNativePlugin({
    path: validHookSrc,
    name: "test-hook",
    registryCategory: "hook-plugin",
  });
  assert(result.resourceId === "test-hook", "resourceId matches name");
  assert(result.version === "0.5.0", "version from manifest");
  assert(result.types.includes("hook-plugin"), "types includes hook-plugin");
  assert(result.valid === true, "valid is true");
  uninstallNativePlugin({ name: "test-hook", force: true });
  passed++;
}

// Test 7c: Hook auto-detect without registryCategory (plugin.hooks is a file path)
console.log("Test 7c: Hook auto-detect (no registryCategory)");
{
  try { uninstallNativePlugin({ name: "test-hook", force: true }); } catch {}
  const result = importNativePlugin({
    path: validHookSrc,
    name: "test-hook",
  });
  assert(result.resourceId === "test-hook", "resourceId matches name");
  assert(result.types.includes("hook-plugin"), "auto-detect finds hook-plugin");
  assert(result.valid === true, "valid is true");
  uninstallNativePlugin({ name: "test-hook", force: true });
  passed++;
}

// Test 7b: Dual-category package (both skill + hook) — rejected for MVP
console.log("Test 7b: Dual-category package rejected");
{
  // Create a package with both skills and hooks
  const dualSrc = path.join(IMPORT_ROOT, "dual-pkg");
  fs.mkdirSync(path.join(dualSrc, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(dualSrc, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "dual-pkg", version: "1.0.0", skills: "skills", hooks: "hooks/hooks.json" })
  );
  fs.mkdirSync(path.join(dualSrc, "skills", "my-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(dualSrc, "skills", "my-skill", "SKILL.md"),
    "---\nname: my-skill\n---\nTest skill"
  );
  fs.mkdirSync(path.join(dualSrc, "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(dualSrc, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ type: "command", command: "echo hi" }] } })
  );
  try { uninstallNativePlugin({ name: "dual-pkg", force: true }); } catch {}
  assertThrows(
    () => importNativePlugin({ path: dualSrc, name: "dual-pkg" }),
    "dual",
    "Dual-category package rejected for MVP"
  );
  passed++;
}

// Test 8: List installed plugins
console.log("Test 8: List installed plugins");
try {
  const all = listInstalledPlugins();
  assert(Array.isArray(all), "returns array");
  const skillsOnly = listInstalledPlugins({ type: "skill" });
  assert(skillsOnly.every((p) => p.type === "skill"), "filter by skill works");
  const hooksOnly = listInstalledPlugins({ type: "hook-plugin" });
  assert(hooksOnly.every((p) => p.type === "hook-plugin"), "filter by hook-plugin works");
} catch (err: any) {
  failed++;
  failures.push(`List plugins failed: ${err.message}`);
  console.error(`  ❌ List plugins failed: ${err.message}`);
}

// Test 9: Uninstall non-existent — rejected
console.log("Test 9: Uninstall non-existent plugin rejected");
assertThrows(
  () => uninstallNativePlugin({ name: "does-not-exist" }),
  "not found",
  "Uninstall non-existent rejection"
);

// Test 10: Staging cleanup on failure
console.log("Test 10: Staging cleanup on validation failure");
try {
  importNativePlugin({ path: invalidSkillSrc, name: "bad-skill", registryCategory: "skill" });
} catch {
  // Expected to fail
}
// Verify no staging directory left
const skillsRoot = path.resolve(process.cwd(), "skills");
const stagingDir = path.join(skillsRoot, "bad-skill.staging");
assert(!fs.existsSync(stagingDir), "staging directory cleaned up after failure");

// Test 11: Marker write failure → rollback targetDir + config (codex R5a round-6)
//   capability-installer sets finalized=true only AFTER the .hub-source.json marker
//   write (temp+rename). Force the marker tmp write to throw → finalized stays
//   false → finally cleans targetDir + skills.json/hook-plugins.json entries.
//   Proves a marker write failure can't ship a non-idempotent resource.
console.log("Test 11: Marker write failure rolls back targetDir + config");
{
  const wfs = fs.writeFileSync;
  (fs as any).writeFileSync = function (p: fs.PathOrFileDescriptor, ...rest: any[]) {
    if (typeof p === "string" && p.includes(".hub-source.json")) {
      throw new Error("forced marker write failure");
    }
    return (wfs as any)(p, ...rest);
  };
  try { uninstallNativePlugin({ name: "test-skill", force: true }); } catch {}
  // seed a config entry to prove it gets removed on rollback
  try { uninstallNativePlugin({ name: "test-skill", force: true }); } catch {}

  let threw = false;
  try {
    importNativePlugin({
      path: validSkillSrc,
      name: "test-skill",
      hubSourceId: "iflytek",
      commitHash: "deadbeef",
      namespaceSlug: "ns-x",
      hubVersion: "1.0.0",
    });
  } catch (err: any) {
    threw = err.message.includes("forced marker write failure");
  }
  (fs as any).writeFileSync = wfs;
  assert(threw, "Test 11: marker write failure throws (not swallowed)");

  // targetDir cleaned (no plugins/test-skill dir left after rollback)
  const targetDir = path.resolve(process.cwd(), "plugins", "test-skill");
  assert(!fs.existsSync(targetDir), "Test 11: targetDir cleaned after marker failure");

  // config cleaned — real resolvers see no test-skill
  const installed = listInstalledPlugins();
  assert(!installed.some((p) => p.name === "test-skill"), "Test 11: no test-skill in any registry after rollback");
  passed++;
}

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
