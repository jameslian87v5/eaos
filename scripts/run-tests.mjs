#!/usr/bin/env node
/**
 * run-tests.mjs — M8b (plan §9) 最小聚合 test runner。
 *
 * 一条命令全量回归:`npm run test:all`
 *   - 测试清单 = glob 派生(server/ + client/ 下所有 *.test.ts,排序去重)
 *     + 显式排除表(需真实凭证/外部服务/浏览器的用例)——**不硬编码文件数**,
 *     同一排除表 → 同一测试集(确定性);
 *   - 每文件 env 从 package.json 的 `test:*` scripts 派生(单一事实源:
 *     npm 脚本里怎么跑,这里就怎么跑);无映射的文件按裸 env 运行;
 *   - 并发数固定常量(CONCURRENCY),逐文件超时兜底防挂死;
 *   - 排除表外零静默跳过:被排除项必须列在 EXCLUDE 并给出理由;
 *   - 不建 CI、不加新依赖(node:fs 递归遍历即 glob)。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 固定常量(计划口径:并发数固定常量,不做自适应) ─────────────────────
// 1 = 串行。原因:多个测试直接读写真实 data/*.json(mcp/skills 注册表)或
// 绑定固定端口,并行时互相争用 → 结果依赖完成顺序,破坏"可复现"验收。
// 并发数常量化在这里,想调只改这一行。
const CONCURRENCY = 1;
const PER_TEST_TIMEOUT_MS = 180_000;

// ── 显式排除表(理由必填;glob 命中但在此表 → 跳过并打印) ───────────────
// 注意:server/a3-real-api-test.ts 用 `-test.ts` 后缀(单元套件约定之外),
// glob 天然不命中;仍列入此表以显式登记,杜绝"静默没跑"的歧义。
const EXCLUDE = new Map([
  ["server/a3-real-api-test.ts", "外部网络(云 hub DNS/网关,容忍 403)— 非单元用例,按需手跑"],
]);

// experiments/*.test.mjs(宿主能力探针)与 scripts/*smoke*.mjs(实机验收)
// 不在本 runner 范围:它们依赖本机环境/真实凭证/浏览器,由各自的验收
// 流程(m8a-docker-check / m1d-smoke / m8g-browser-check)负责。

// ── 测试清单:递归遍历即 glob(排序 → 确定性) ───────────────────────────
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".test.ts")) out.push(p);
  }
}
const raw = [];
for (const d of ["server", "client"]) walk(path.join(ROOT, d), raw);
const allTests = [...new Set(raw)]
  .map((p) => path.relative(ROOT, p).split(path.sep).join("/"))
  .sort();

// ── env 派生:解析 package.json `test:*` scripts(单一事实源) ────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const envByFile = new Map();
for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
  if (!name.startsWith("test:") || typeof script !== "string") continue;
  const tokens = script.trim().split(/\s+/);
  const env = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = tokens[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) break;
    env[m[1]] = m[2];
  }
  // 跳过 bin 段(tsx / node / npx),取第一个 .test.ts 路径参数
  const file = tokens.slice(i).find((t) => t.endsWith(".test.ts"));
  if (file) envByFile.set(file, env);
}

const excluded = [];
const tests = [];
for (const t of allTests) {
  if (EXCLUDE.has(t)) excluded.push(t);
  else tests.push(t);
}

// tsx bin:worktree 无 node_modules,向上找(与测试脚本约定一致)
function findTsx() {
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "node_modules/.bin/tsx");
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error("tsx bin not found walking up from repo root");
}
const TSX = findTsx();

// ── 运行:固定并发 worker 池 ─────────────────────────────────────────────
const results = [];
let idx = 0;

function runOne(file) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(envByFile.get(file) ?? {}) };
    // DB isolation: tests without an explicit DB_PATH in their env mapping
    // default to the repo's REAL data/eaos.db — serially accumulated rows
    // leak across tests (order-dependent failures). Every unmapped test gets
    // its own fresh temp DB instead. WAL siblings must be cleaned too.
    if (!env.DB_PATH) {
      env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "m8b-db-")), "test.db");
    }
    const started = Date.now();
    const child = spawn(TSX, [path.join(ROOT, file)], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 组杀:超时时连 tsx 的子进程一起收,防挂死
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
    child.stderr.on("data", (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, PER_TEST_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ file, code, ms: Date.now() - started, out, err });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ file, code: -1, ms: Date.now() - started, out, err: err + String(e) });
    });
  });
}

async function worker() {
  while (idx < tests.length) {
    const file = tests[idx++];
    const r = await runOne(file);
    const failed = r.code !== 0;
    results.push(r);
    console.log(`${failed ? "✗" : "✓"} ${r.file}  (${(r.ms / 1000).toFixed(1)}s${failed ? ", exit=" + r.code : ""})`);
    if (failed) {
      const tail = (r.err + r.out).split("\n").filter(Boolean).slice(-15).join("\n");
      if (tail) console.log(tail.replace(/^/gm, "    "));
    }
  }
}

console.log(`M8b aggregate runner: ${tests.length} test files (concurrency ${CONCURRENCY}, per-test timeout ${PER_TEST_TIMEOUT_MS / 1000}s)`);
if (excluded.length) {
  console.log(`Excluded (${excluded.length}, explicit table):`);
  for (const e of excluded) console.log(`  - ${e} — ${EXCLUDE.get(e)}`);
}
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tests.length) }, worker));

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${excluded.length} excluded — total ${( (Date.now() - t0) / 1000).toFixed(0)}s`);
if (failed.length) {
  console.log("Failures:");
  for (const f of failed) console.log(`  ✗ ${f.file} (exit=${f.code})`);
  process.exit(1);
}
