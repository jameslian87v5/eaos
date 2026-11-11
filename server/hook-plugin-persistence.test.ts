// Hook-plugin persistence — REAL behavior test (round-5).
// Imports the actual resolveOne() from hook-plugin-config.ts and proves
// that `plugins/<name>` resolves under PLUGINS_ROOT, OFF the code checkout,
// with the realpath traversal guard still rejecting escapes. Mirrors
// skills-root.test.ts. Run: npx tsx server/hook-plugin-persistence.test.ts
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-plugin-root-"));
const pluginsRoot = path.join(tmp, "plugins");
const PLUGIN_NAME = "prod-hook-a";

// Seed a well-formed hook plugin under the persistent plugins root.
const dir = path.join(pluginsRoot, PLUGIN_NAME);
fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
fs.writeFileSync(
  path.join(dir, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", description: "seeded", hooks: "./hooks/hooks.json" }),
);
fs.writeFileSync(
  path.join(dir, "hooks", "hooks.json"),
  JSON.stringify({ description: "seeded", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }] } }),
);

// Sanity: plugin name is NOT present in the code checkout.
ok(
  "hook plugin name absent from checkout",
  !fs.existsSync(path.join(process.cwd(), "plugins", PLUGIN_NAME)),
);

// Set env BEFORE import so module-load const picks up the tmp root.
process.env.PLUGINS_ROOT = pluginsRoot;
ok("PLUGINS_ROOT is off-checkout", !pluginsRoot.startsWith(process.cwd()));

const { resolveOne } = await import("./hook-plugin-config.js");
const pluginsRootReal = fs.realpathSync(pluginsRoot);

// 1. plugins/<name> resolves under PLUGINS_ROOT, valid.
const r1 = resolveOne({ name: PLUGIN_NAME, type: "hook-plugin", enabled: true, path: `plugins/${PLUGIN_NAME}` });
ok("hook plugin resolves valid", r1.valid, r1.error || "");
ok("absolutePath under PLUGINS_ROOT", r1.absolutePath.startsWith(pluginsRootReal + path.sep), r1.absolutePath);
ok("absolutePath NOT under checkout", !r1.absolutePath.startsWith(process.cwd()));
ok("declaredEvents includes PreToolUse", r1.declaredEvents.includes("PreToolUse"));

// 2. traversal rejected.
const r2 = resolveOne({ name: "evil", type: "hook-plugin", enabled: true, path: "plugins/../../etc" });
ok("traversal rejected", !r2.valid);

// 3. missing plugin rejected.
const r3 = resolveOne({ name: "nope", type: "hook-plugin", enabled: true, path: "plugins/nope" });
ok("missing hook plugin rejected", !r3.valid);

// 4. bare host path rejected (no hooks/ or plugins/ prefix → PROJECT_ROOT,
//    then containment check fails).
const r4 = resolveOne({ name: PLUGIN_NAME, type: "hook-plugin", enabled: true, path: "../etc/passwd" });
ok("bare host path rejected", !r4.valid);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, 0 failed`);
