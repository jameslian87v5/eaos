/**
 * skillhub-repackage.test.ts — focused tests for repackageToNativePlugin.
 *
 * R5b-2: the Hub skill package is NOT in native-plugin shape (top-level
 * SKILL.md + npm package.json). repackageToNativePlugin synthesizes the
 * native-plugin descriptor from TRUSTED slug/version and moves extracted
 * files under skills/<slug>/, WITHOUT weakening importNativePlugin /
 * skill-config validation (which run unchanged on the synthesized package).
 *
 * Trust boundary tests:
 *  - synthesized plugin.json uses TRUSTED slug/version (NOT the untrusted
 *    extracted npm package.json name/version).
 *  - missing top-level SKILL.md → reject (not a skill).
 *  - invalid slug/version → reject.
 *  - all extracted files preserved UNDER skills/<slug>/.
 *  - failure → pkgDir removed (no half-package).
 *
 * Run: npx tsx server/skillhub-repackage.test.ts
 */
export {};

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let passed = 0, failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) passed++; else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

const { repackageToNativePlugin, RepackageError } = await import("./skillhub-repackage.js");

function mkExtract(entries: Array<{ name: string; content: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-ext-"));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, e.content);
  }
  return dir;
}

// 1. 良性 Hub 包 → 合成 native-plugin (受信 slug/version)
{
  const ext = mkExtract([
    { name: "SKILL.md", content: "# agentguard\n" },
    { name: "package.json", content: JSON.stringify({ name: "attacker-evil", version: "9.9.9" }) },
    { name: "lib/handler.js", content: "module.exports={};\n" },
  ]);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-pkg-"));
  repackageToNativePlugin(ext, pkg, { slug: "agentguard", version: "1.1" });

  // synthesized plugin.json 用受信 slug/version (非 untrusted package.json)
  const pj = JSON.parse(fs.readFileSync(path.join(pkg, ".claude-plugin", "plugin.json"), "utf8"));
  assert(pj.name === "agentguard" && pj.version === "1.1", `1. plugin.json 受信 slug=agentguard/version=1.1, got ${JSON.stringify(pj)}`);
  assert(pj.name !== "attacker-evil" && pj.version !== "9.9.9", "1. 不用 untrusted package.json 的 name/version");

  // SKILL.md 落在 skills/agentguard/SKILL.md
  const skillMd = path.join(pkg, "skills", "agentguard", "SKILL.md");
  assert(fs.existsSync(skillMd), "1. skills/agentguard/SKILL.md 存在");
  assert(fs.readFileSync(skillMd, "utf8") === "# agentguard\n", "1. SKILL.md 内容保留");

  // 所有提取文件在 skills/agentguard/ 下 (package.json + lib/handler.js)
  const names = fs.readdirSync(path.join(pkg, "skills", "agentguard")).sort();
  assert(names.includes("package.json") && names.includes("lib") && names.includes("SKILL.md"), `1. 全部提取文件移到 skills/agentguard/, got [${names.join(",")}]`);
  assert(fs.readFileSync(path.join(pkg, "skills", "agentguard", "lib", "handler.js"), "utf8") === "module.exports={};\n", "1. lib/handler.js 内容保留");

  // pkgDir 根目录只有 .claude-plugin + skills (无遗留提取文件)
  const rootNames = fs.readdirSync(pkg).sort();
  assert(rootNames.join(",") === ".claude-plugin,skills", `1. pkgDir 根 = {.claude-plugin,skills}, got [${rootNames.join(",")}]`);
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
  console.log("✓ 1. 良性 Hub 包 → 合成 native-plugin (受信 slug/version, 全部文件迁移)");
}

// 2. 缺 top-level SKILL.md → RepackageError + pkgDir 清理
{
  const ext = mkExtract([
    { name: "README.md", content: "# readme\n" },
    { name: "package.json", content: "{}\n" },
  ]);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-pkg-"));
  let threw = false;
  try { repackageToNativePlugin(ext, pkg, { slug: "x", version: "1.0" }); }
  catch (e: any) { threw = e instanceof RepackageError; }
  assert(threw, "2. 缺 SKILL.md → RepackageError");
  assert(!fs.existsSync(pkg) || fs.readdirSync(pkg).length === 0, "2. pkgDir 已清理 (无半包)");
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
  console.log("✓ 2. 缺 top-level SKILL.md → RepackageError + pkgDir 清理");
}

// 3. 无效 slug → RepackageError (受信输入校验)
{
  const ext = mkExtract([{ name: "SKILL.md", content: "# x\n" }]);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-pkg-"));
  let threw = false;
  try { repackageToNativePlugin(ext, pkg, { slug: "../evil", version: "1.0" }); }
  catch (e: any) { threw = e instanceof RepackageError; }
  assert(threw, "3. 无效 slug (../evil) → RepackageError");
  // 路径分隔符 / 大写 / 空格等也拒绝
  let threw2 = false;
  try { repackageToNativePlugin(ext, pkg, { slug: "Bad Slug", version: "1.0" }); }
  catch { threw2 = true; }
  assert(threw2, "3. 含空格的 slug → RepackageError");
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
  console.log("✓ 3. 无效 slug → RepackageError (受信输入校验)");
}

// 4. 无效 version → RepackageError
{
  const ext = mkExtract([{ name: "SKILL.md", content: "# x\n" }]);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-pkg-"));
  let threw = false;
  try { repackageToNativePlugin(ext, pkg, { slug: "x", version: "../../etc" }); }
  catch (e: any) { threw = e instanceof RepackageError; }
  assert(threw, "4. 含路径分隔的 version → RepackageError");
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
  console.log("✓ 4. 无效 version → RepackageError");
}

// 5. extractDir 缺失 → RepackageError
{
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-pkg-"));
  let threw = false;
  try { repackageToNativePlugin("/nonexistent/extract-dir", pkg, { slug: "x", version: "1.0" }); }
  catch (e: any) { threw = e instanceof RepackageError; }
  assert(threw, "5. extractDir 缺失 → RepackageError");
  fs.rmSync(pkg, { recursive: true, force: true });
  console.log("✓ 5. extractDir 缺失 → RepackageError");
}

// 6. 重复 repackage (pkgDir 已有旧内容) → 清旧重建, 无残留
{
  const ext = mkExtract([{ name: "SKILL.md", content: "# v2\n" }]);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-pkg-"));
  // seed 旧文件 (模拟上次失败/旧版本残留)
  fs.mkdirSync(path.join(pkg, "stale-dir"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "stale.txt"), "old");
  repackageToNativePlugin(ext, pkg, { slug: "x", version: "2.0" });
  const rootNames = fs.readdirSync(pkg).sort();
  assert(rootNames.join(",") === ".claude-plugin,skills", `6. 旧残留被清, got [${rootNames.join(",")}]`);
  assert(!fs.existsSync(path.join(pkg, "stale.txt")) && !fs.existsSync(path.join(pkg, "stale-dir")), "6. stale 文件已清");
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
  console.log("✓ 6. 重复 repackage → 清旧残留重建");
}

// 7. 受信 slug 在合成时强制小写规范化? 否 — slug 原样用于 dir。
//    验证 slug 含大写字母 (合法, SLUG_RE 允许 A-Z) → dir 名与 slug 一致
{
  const ext = mkExtract([{ name: "SKILL.md", content: "# X\n" }]);
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "repkg-pkg-"));
  repackageToNativePlugin(ext, pkg, { slug: "MySkill", version: "1.0" });
  assert(fs.existsSync(path.join(pkg, "skills", "MySkill", "SKILL.md")), "7. 大写 slug → dir=MySkill (与受信 slug 一致)");
  const pj = JSON.parse(fs.readFileSync(path.join(pkg, ".claude-plugin", "plugin.json"), "utf8"));
  assert(pj.name === "MySkill", "7. plugin.json name=MySkill (受信原样)");
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(pkg, { recursive: true, force: true });
  console.log("✓ 7. 受信 slug 原样用于 dir + plugin.json (不规范化)");
}

console.log(`\nskillhub-repackage.test: ${passed} passed, ${failed} failed.`);
if (failed) { console.error(failures.join("\n")); process.exit(1); }
process.exit(0);
