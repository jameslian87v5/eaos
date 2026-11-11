#!/usr/bin/env node
/**
 * Skill Hub 原型实验：clone 真实仓库 → 解析 catalog → 校验 plugin 包格式
 *
 * 用法: node scripts/skill-hub-explore.mjs
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const CACHE_DIR = "/tmp/skill-hub-explore";

const HUBS = [
  {
    id: "anthropics-skills",
    name: "Anthropic Skills 示例库",
    gitUrl: "https://github.com/anthropics/skills.git",
    ref: "main",
  },
  {
    id: "claude-plugins-official",
    name: "Claude Plugins Official",
    gitUrl: "https://github.com/anthropics/claude-plugins-official.git",
    ref: "main",
  },
  {
    id: "wshobson-agents",
    name: "wshobson/agents marketplace",
    gitUrl: "https://github.com/wshobson/agents.git",
    ref: "main",
  },
];

function cloneHub(hub) {
  const dest = path.join(CACHE_DIR, hub.id);
  if (fs.existsSync(dest)) {
    console.log(`[${hub.id}] already cloned, pulling...`);
    try {
      execSync(`cd ${dest} && git pull --depth 1 --ff-only 2>&1`, { encoding: "utf8" });
    } catch {
      console.log(`[${hub.id}] pull failed, using cached version`);
    }
  } else {
    console.log(`[${hub.id}] cloning ${hub.gitUrl}...`);
    try {
      execSync(
        `git clone --depth 1 --branch ${hub.ref} ${hub.gitUrl} ${dest} 2>&1`,
        { encoding: "utf8", timeout: 60000 }
      );
    } catch (e) {
      console.log(`[${hub.id}] clone FAILED: ${e.message}`);
      return null;
    }
  }
  return dest;
}

function findPluginJsons(rootDir) {
  const results = [];
  function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.name === "plugin.json") {
        const pluginDir = path.dirname(fullPath);
        const relPath = path.relative(rootDir, pluginDir);
        let pluginJson = null;
        try {
          pluginJson = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        } catch {
          pluginJson = null;
        }
        // Check for SKILL.md
        let hasSkillMd = false;
        let skillMdFiles = [];
        try {
          const skillsDir = path.join(pluginDir, "skills");
          if (fs.existsSync(skillsDir)) {
            skillMdFiles = findFilesRecursive(skillsDir, "SKILL.md");
            hasSkillMd = skillMdFiles.length > 0;
          }
        } catch {}
        // Check for hooks
        let hasHooks = false;
        const hooksDir = path.join(pluginDir, "hooks");
        if (fs.existsSync(hooksDir)) {
          hasHooks = fs.existsSync(path.join(hooksDir, "hooks.json"));
        }
        // Check for scripts
        let hasScripts = false;
        try {
          const scriptsDir = path.join(pluginDir, "scripts");
          hasScripts = fs.existsSync(scriptsDir);
        } catch {}

        results.push({
          relPath,
          pluginJson,
          hasSkillMd,
          skillMdCount: skillMdFiles.length,
          hasHooks,
          hasScripts,
          valid: pluginJson !== null && hasSkillMd,
        });
      }
    }
  }
  walk(rootDir);
  return results;
}

function findFilesRecursive(dir, filename) {
  const results = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === filename) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

function tryReadCatalog(rootDir) {
  const catalogPath = path.join(rootDir, "catalog.json");
  if (fs.existsSync(catalogPath)) {
    try {
      return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function generateCatalog(plugins, rootDir) {
  return plugins.map((p) => ({
    name: p.pluginJson?.name || path.basename(p.relPath),
    description: p.pluginJson?.description || "",
    version: p.pluginJson?.version || "0.0.0",
    author: p.pluginJson?.author?.name || "",
    path: p.relPath,
    visibility: "public",
    allowedRoles: [],
    tags: p.pluginJson?.keywords || [],
    hooks: p.hasHooks,
    scripts: p.hasScripts,
    valid: p.valid,
  }));
}

// ─── Main ─────────────────────────────────────────

console.log("=== Skill Hub Explore ===\n");

fs.mkdirSync(CACHE_DIR, { recursive: true });

for (const hub of HUBS) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Hub: ${hub.name} (${hub.id})`);
  console.log(`URL: ${hub.gitUrl}`);
  console.log("=".repeat(60));

  const dest = cloneHub(hub);
  if (!dest) continue;

  // Try reading catalog.json
  const catalog = tryReadCatalog(dest);
  if (catalog) {
    console.log(`\ncatalog.json: FOUND (${catalog.length} items)`);
    for (const item of catalog.slice(0, 5)) {
      console.log(`  - ${item.name}: ${item.description || ""} [${item.visibility || "public"}]`);
    }
    if (catalog.length > 5) console.log(`  ... and ${catalog.length - 5} more`);
  } else {
    console.log(`\ncatalog.json: NOT FOUND (will auto-generate)`);
  }

  // Find all plugin.json files
  const plugins = findPluginJsons(dest);
  console.log(`\nPlugin packages found: ${plugins.length}`);

  const valid = plugins.filter((p) => p.valid);
  const invalid = plugins.filter((p) => !p.valid);
  console.log(`  Valid (plugin.json + SKILL.md): ${valid.length}`);
  console.log(`  Invalid: ${invalid.length}`);

  for (const p of plugins.slice(0, 10)) {
    console.log(`\n  📦 ${p.relPath}`);
    console.log(`     name: ${p.pluginJson?.name || "?"}`);
    console.log(`     version: ${p.pluginJson?.version || "?"}`);
    console.log(`     description: ${(p.pluginJson?.description || "?").slice(0, 80)}`);
    console.log(`     SKILL.md: ${p.hasSkillMd ? `✅ (${p.skillMdCount})` : "❌"}`);
    console.log(`     hooks: ${p.hasHooks ? "⚠️ yes" : "no"}`);
    console.log(`     scripts: ${p.hasScripts ? "⚠️ yes" : "no"}`);
    console.log(`     valid: ${p.valid ? "✅" : "❌"}`);
  }
  if (plugins.length > 10) {
    console.log(`\n  ... and ${plugins.length - 10} more`);
  }

  // Generate catalog if not found
  if (!catalog && plugins.length > 0) {
    const generated = generateCatalog(plugins, dest);
    console.log(`\nAuto-generated catalog (${generated.length} items):`);
    for (const item of generated.slice(0, 5)) {
      console.log(`  - ${item.name} v${item.version}: ${item.description.slice(0, 60)}`);
    }
  }

  // Summary stats
  console.log(`\n--- Stats ---`);
  console.log(`  Total plugins: ${plugins.length}`);
  console.log(`  With hooks: ${plugins.filter((p) => p.hasHooks).length}`);
  console.log(`  With scripts: ${plugins.filter((p) => p.hasScripts).length}`);
  console.log(`  With SKILL.md: ${plugins.filter((p) => p.hasSkillMd).length}`);
}

console.log(`\n${"=".repeat(60)}`);
console.log("Done. Cache at:", CACHE_DIR);
