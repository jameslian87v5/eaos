/**
 * skillhub-bridge.prod.test.ts — 生产装配测试 (真实 entitlementService + 真实
 * writeGovernanceAudit + 临时 DB/entitlements/cache)。
 *
 * R5b-2: 真实 Hub 契约 + 真实 bounded-safe extract+repackage 闭环验证:
 *  - A. env absent → runSyncOnce 空载 no-op (无 mutation、无审计行)
 *  - B. env present → 真实 entitlement allow + governance_audit_log 行;
 *    审计表无 payload/body/token 列。
 *  - C/D/E. GLOBAL/TEAM 镜像 + deny-wins (保留 admin 手动 tightening)
 *  - F. marker-based 源幂等 (同 sha skip+repair; 本地同名替换 fail-closed)
 *  - G. 恶意 path-traversal ZIP → 真实 extractZip 拒绝 → fail-closed (不导入/不镜像)
 *  - H. 缺 top-level SKILL.md → 真实 repackageToNativePlugin 拒绝 → fail-closed
 *  - I. 良性真实 ZIP (Hub 包形: SKILL.md + package.json) → 真实 extract+repackage
 *    → import + 镜像; synthesized plugin.json 用受信 slug/version (非 untrusted package.json)
 *
 * Run: npx tsx server/skillhub-bridge.prod.test.ts
 */
export {};

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

let passed = 0, failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) passed++; else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

// ── minimal ZIP builder (central-directory + STORE/DEFLATE) for malicious/benign
//    matrix — mirrors server/skillhub-zip-extract.test.ts. crc32 must be >>> 0
//    (zlib returns signed int32); (mode<<16)>>>0 avoids signed overflow. ──
function crc32(buf: Buffer): number { return zlib.crc32(buf) >>> 0; }
interface ZipEntry { name: string; data: Buffer; mode?: number; method?: number; }
function buildZip(entries: ZipEntry[]): Buffer {
  const central: Buffer[] = [];
  const localChunks: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const method = e.method ?? 0;
    const raw = e.data;
    let comp: Buffer;
    if (method === 0) comp = raw;
    else if (method === 8) comp = zlib.deflateRawSync(raw);
    else throw new Error(`unsupported method ${method}`);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extraLen
    localChunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(((e.mode ?? 0o644) << 16) >>> 0, 38); // external attrs (mode << 16)
    cd.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(localChunks);
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

const DB_PATH = "/tmp/skillhub-prod-test.db";
const ENT_FILE = "/tmp/skillhub-prod-ent.json";
const AC_FILE = "/tmp/skillhub-prod-ac.json";
const CACHE = path.join(os.tmpdir(), "skillhub-prod-cache");
const IMPORT_ROOT = path.join(os.tmpdir(), "skillhub-prod-import-root");

// ── hermetic reset ──
fs.rmSync(DB_PATH, { force: true });
fs.rmSync(`${DB_PATH}-wal`, { force: true });
fs.rmSync(`${DB_PATH}-shm`, { force: true });
fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(AC_FILE, "{}\n");
fs.rmSync(CACHE, { recursive: true, force: true });
fs.rmSync(IMPORT_ROOT, { recursive: true, force: true });
fs.mkdirSync(IMPORT_ROOT, { recursive: true });

process.env.DB_PATH = DB_PATH;
process.env.ENTITLEMENTS_FILE = ENT_FILE;
process.env.AGENT_CAPABILITIES_FILE = AC_FILE;
process.env.PLUGIN_IMPORT_ROOT = IMPORT_ROOT;

const db = (await import("./database.js")).default;
const { runSyncOnce } = await import("./skillhub-bridge.prod.js");
const { validateImportPath } = await import("./capability-installer.js");

// B/C/D/E/F 注入 fakeExtract: 它们关注 entitlement/marker 语义, 不是解包。
// 这些测试用 fakeExtract 造一个空 package 目录, 让 fakeImport 能拿到一个目录路径,
// 绕过真实 extract+repackage (已在 G/H/I 单独验证)。
const fakeExtract = async (_src: string, dest: string, _meta: { slug: string; version: string }): Promise<void> => {
  fs.mkdirSync(dest, { recursive: true });
};

// R5b-2 content-fingerprint helper: compute the Hub's content-tree fingerprint
// (upstream SkillQueryService algorithm, VERIFIED live) for a set of files, so
// tests G/H/I can set getVersionDetail.sha256 to the REAL fingerprint and
// exercise the prod extractFn's integrity verification end-to-end.
const { computeContentFingerprint } = await import("./skillhub-zip-extract.js");
function fpOf(files: Array<{ name: string; content: Buffer | string }>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
  for (const f of files) {
    const p = path.join(d, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof f.content === "string" ? Buffer.from(f.content) : f.content);
  }
  const fp = computeContentFingerprint(d);
  fs.rmSync(d, { recursive: true, force: true });
  return fp;
}

// R5b-2: fakeClient 模拟真实 Hub 契约的 client 接口 (envelope 已 unwrap;
// downloadSkill 返回 {slug}-{version}.zip + 本地 sha; getVersionDetail 的
// fingerprint→sha256, manifest/metadata=null — 真实 resolve 不返回这些)。
const fakeClient = {
  async listNamespaces() {
    return [{ slug: "org-x", displayName: "Org X", type: "TEAM" as const, status: "ACTIVE" }];
  },
  async listPublishedSkills() {
    return [{ slug: "foo", displayName: "Foo", namespaceSlug: "org-x", latestVersion: "1.0.0" }];
  },
  async getVersionDetail() {
    return { version: "1.0.0", sha256: "abc123", parsedMetadataJson: null, manifestJson: null };
  },
  async downloadSkill(_ns: string, slug: string, v: string, destDir: string) {
    fs.mkdirSync(destDir, { recursive: true });
    const p = path.join(destDir, `${slug}-${v}.zip`);
    fs.writeFileSync(p, "fake-zip");
    return { localPath: p, sha256: "abc123" };
  },
};
const fakeImport = async (req: { path: string; name: string; hubSourceId: string; commitHash: string; hubVersion?: string }) =>
  ({ resourceId: req.name, installedPath: `/tmp/skills/${req.name}`, version: "1.0.0" });

// ── A. env absent → 空载 no-op (不建 client、不下载、不镜像、不审计) ──────
{
  delete process.env.SKILLHUB_URL;
  delete process.env.SKILLHUB_TOKEN;
  const entBefore = fs.readFileSync(ENT_FILE, "utf8");
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: fakeClient as any, importFn: fakeImport as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE, activeOrgIds: ["org-id-x"],
  });
  assert(r.imported.length === 0 && r.skipped.length === 0 && r.errors.length === 0, "A. env absent → empty no-op");
  assert(fs.readFileSync(ENT_FILE, "utf8") === entBefore, "A. env absent → entitlements 不变");
  assert(!fs.existsSync(CACHE), "A. env absent → 不建 cache 目录");
  const rows = db.prepare("SELECT COUNT(*) AS c FROM governance_audit_log WHERE action LIKE 'skillhub.%'").get() as { c: number };
  assert(rows.c === 0, `A. env absent → 无 skillhub 审计行, got ${rows.c}`);
  console.log("✓ A. env absent → 安全禁用 no-op (无 mutation / 无审计)");
}

// ── B. env present → 真实 entitlement allow + governance_audit_log 行 ──────
{
  process.env.SKILLHUB_URL = "http://localhost:8080";
  process.env.SKILLHUB_TOKEN = "sk_test";
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: fakeClient as any, importFn: fakeImport as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE, activeOrgIds: ["org-id-x"],
  });
  assert(r.imported.length === 1 && r.imported[0] === "foo", `B. 导入 foo, got ${JSON.stringify(r)}`);

  // entitlements.json 有 allow: foo → org-id-x
  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  const entry = ent.entries.find((e: any) =>
    e.resourceId === "foo" && e.scopeType === "org" && e.scopeId === "org-id-x" && e.effect === "allow");
  assert(!!entry, "B. entitlement allow foo→org-id-x 写入");

  // governance_audit_log: skillhub.import + skillhub.mirror (metadata-only)
  const impRow = db.prepare(
    "SELECT * FROM governance_audit_log WHERE action = 'skillhub.import' AND object_id = 'foo' AND result = 'success'"
  ).get();
  assert(!!impRow, "B. skillhub.import 审计行");
  const mirrorRow = db.prepare(
    "SELECT * FROM governance_audit_log WHERE action = 'skillhub.mirror' AND object_id = 'foo'"
  ).get();
  assert(!!mirrorRow, "B. skillhub.mirror 审计行");

  // 审计表 metadata-only: 无 payload/body/token 列
  const cols = db.prepare("PRAGMA table_info(governance_audit_log)").all() as Array<{ name: string }>;
  const bad = cols.filter((c) => /payload|body|token/i.test(c.name));
  assert(bad.length === 0, `B. 审计表无 payload/body/token 列, got [${bad.map((b) => b.name).join(",")}]`);

  // download 目录存在 (归档已落地)。
  assert(fs.existsSync(path.join(CACHE, "iflytek", "org-x", "foo", "1.0.0", "download")), "B. download 目录存在");
  console.log("✓ B. env present → 真实 entitlement + 审计");
}

// ── C. GLOBAL 镜像: ≥2 active org 都持久化 + 保留 unrelated 条目 ─────────
//   codex R5a round-2 bug: 逐 org PUT 互相覆盖 → 只剩最后一个 org。merge 实现
//   必须让两个 org 的 allow 都存活, 且不擦除既有 user-scope / 其他 org 条目。
{
  const globalClient = {
    ...fakeClient,
    async listNamespaces() {
      return [{ slug: "@global", displayName: "Global", type: "GLOBAL" as const, status: "ACTIVE" }];
    },
  };
  // seed 一个 unrelated user-scope allow (admin 手动授权, 非 hub 管理)。
  // 直接 append 到 ENT_FILE JSON — 不能用 setEntitlements (它是 PUT, 会擦掉
  // test B 写的 org-id-x allow, 那正是后面要断言"被 merge 保留"的既有条目)。
  const seedStore = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  seedStore.entries.push({
    resourceId: "foo", scopeType: "user", scopeId: "u9",
    effect: "allow", grantedBy: "admin-seed", grantedAt: new Date().toISOString(),
  });
  fs.writeFileSync(ENT_FILE, JSON.stringify(seedStore, null, 2) + "\n");
  const entBeforeSeed = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  const userBefore = entBeforeSeed.entries.find((e: any) =>
    e.resourceId === "foo" && e.scopeType === "user" && e.scopeId === "u9");
  assert(!!userBefore, "C. seed user-scope allow 存在");

  const CACHE2 = path.join(os.tmpdir(), "skillhub-prod-cache-global");
  fs.rmSync(CACHE2, { recursive: true, force: true });
  const r = await runSyncOnce("@global", "", {
    client: globalClient as any, importFn: fakeImport as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE2, activeOrgIds: ["org-a", "org-b"],
  });
  assert(r.imported.length === 1 && r.imported[0] === "foo", `C. GLOBAL 导入 foo, got ${JSON.stringify(r)}`);

  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  const fooEntries = ent.entries.filter((e: any) => e.resourceId === "foo");
  const orgA = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-a" && e.effect === "allow");
  const orgB = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-b" && e.effect === "allow");
  assert(!!orgA, "C. org-a allow 持久化 (非被最后一个 org 覆盖)");
  assert(!!orgB, "C. org-b allow 持久化");
  // unrelated 条目保留: user-scope + 既有 org-id-x (test B 写入)
  const userAfter = fooEntries.find((e: any) => e.scopeType === "user" && e.scopeId === "u9");
  assert(!!userAfter && userAfter.effect === "allow", "C. user-scope u9 allow 保留 (未被 PUT 擦除)");
  const orgX = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-id-x");
  assert(!!orgX, "C. 既有 org-id-x allow 保留 (merge 未擦除其他 org)");
  console.log("✓ C. GLOBAL 镜像: 两 org 都持久化 + 保留 user/其他-org 条目");
}

// ── D. GLOBAL sync 不擦除 admin 手动 org-deny (deny-wins, §7.2) ──────────
//   round-3 bug: merge 曾把同 key 既有条目替换为 allow → admin 对 org-a 的
//   org-scope deny 被下次 GLOBAL 擦掉。修复后 deny 必须存活且仍 effective。
{
  const globalClient = {
    ...fakeClient,
    async listNamespaces() {
      return [{ slug: "@global", displayName: "Global", type: "GLOBAL" as const, status: "ACTIVE" }];
    },
  };
  // 直接 append org-a deny (避免 setEntitlements 的 PUT 擦掉其他既有条目)
  const store = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  store.entries.push({
    resourceId: "foo", scopeType: "org", scopeId: "org-a",
    effect: "deny", grantedBy: "admin-tighten", grantedAt: new Date().toISOString(),
  });
  fs.writeFileSync(ENT_FILE, JSON.stringify(store, null, 2) + "\n");

  const { entitlementService } = await import("./entitlement.js");
  const adminCtx = { userId: "admin-1", role: "admin" as const, orgId: "default-org" };
  const orgAUser = { userId: "ua", role: "user" as const, orgId: "org-a" };
  const orgBUser = { userId: "ub", role: "user" as const, orgId: "org-b" };
  assert(entitlementService.canConfigure(orgAUser, "foo") === false, "D. sync 前 org-a deny 生效");
  void adminCtx;

  const CACHE3 = path.join(os.tmpdir(), "skillhub-prod-cache-deny-global");
  fs.rmSync(CACHE3, { recursive: true, force: true });
  const r = await runSyncOnce("@global", "", {
    client: globalClient as any, importFn: fakeImport as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE3, activeOrgIds: ["org-a", "org-b"],
  });
  assert(r.imported.length === 1, "D. GLOBAL 导入 foo");

  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  const fooEntries = ent.entries.filter((e: any) => e.resourceId === "foo");
  const denyA = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-a" && e.effect === "deny");
  const allowA = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-a" && e.effect === "allow");
  const allowB = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-b" && e.effect === "allow");
  assert(!!denyA, "D. org-a deny 保留 (deny-wins, 未被 allow 覆盖)");
  assert(!allowA, "D. org-a 未追加 allow (deny 阻止)");
  assert(!!allowB, "D. org-b allow 仍添加 (非 deny 的目标正常镜像)");
  // deny 仍 effective: org-a user 不能 configure foo
  assert(entitlementService.canConfigure(orgAUser, "foo") === false, "D. sync 后 org-a deny 仍生效");
  assert(entitlementService.canConfigure(orgBUser, "foo") === true, "D. sync 后 org-b allow 生效");
  console.log("✓ D. GLOBAL sync 不擦除 admin org-deny (deny-wins)");
}

// ── E. TEAM sync 不擦除同 org 的 admin deny (deny-wins) ─────────────────
{
  // 直接 append org-id-x deny (TEAM 同 org)
  const store = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  store.entries.push({
    resourceId: "foo", scopeType: "org", scopeId: "org-id-x",
    effect: "deny", grantedBy: "admin-tighten", grantedAt: new Date().toISOString(),
  });
  fs.writeFileSync(ENT_FILE, JSON.stringify(store, null, 2) + "\n");

  const { entitlementService } = await import("./entitlement.js");
  const orgXUser = { userId: "ux", role: "user" as const, orgId: "org-id-x" };
  assert(entitlementService.canConfigure(orgXUser, "foo") === false, "E. sync 前 org-id-x deny 生效");

  const CACHE4 = path.join(os.tmpdir(), "skillhub-prod-cache-deny-team");
  fs.rmSync(CACHE4, { recursive: true, force: true });
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: fakeClient as any, importFn: fakeImport as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE4, activeOrgIds: ["org-id-x"],
  });
  assert(r.imported.length === 1, "E. TEAM 导入 foo");

  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  const fooEntries = ent.entries.filter((e: any) => e.resourceId === "foo");
  const denyX = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-id-x" && e.effect === "deny");
  const allowX = fooEntries.find((e: any) => e.scopeType === "org" && e.scopeId === "org-id-x" && e.effect === "allow");
  assert(!!denyX, "E. org-id-x deny 保留 (同 org deny-wins)");
  assert(!allowX, "E. org-id-x 未追加 allow (deny 阻止)");
  assert(entitlementService.canConfigure(orgXUser, "foo") === false, "E. sync 后 org-id-x deny 仍生效");
  console.log("✓ E. TEAM sync 不擦除同 org admin deny (deny-wins)");
}

// ── F. marker-based source idempotency (codex R5a round-4) ───────────────
//   F1: 同源同 sha marker 存在 → skip 安装 + 仍镜像 (repair)。
//   F2: 本地同名替换 (无 marker) → lookupExisting null → 全新导入 → 名字
//   冲突 fail-closed, 不 skip、不镜像到本地资源。
//   隔离: 重置 ENT_FILE (D/E 给 foo 留了 org-id-x deny, 会 deny-wins 阻断 F1 allow)。
{
  fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
  const PROOT = path.join(os.tmpdir(), "skillhub-prod-plugins-root");
  fs.rmSync(PROOT, { recursive: true, force: true });
  fs.mkdirSync(PROOT, { recursive: true });

  // 模拟真实 importNativePlugin: 名字冲突抛错 + 写 .hub-source.json marker
  let importCalls = 0;
  const markerImportFn = async (req: any) => {
    const dir = path.join(PROOT, req.name);
    if (fs.existsSync(dir)) {
      throw new Error(`Plugin "${req.name}" already installed at ${dir}. Uninstall first.`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".hub-source.json"),
      JSON.stringify({ hubSourceId: req.hubSourceId, namespaceSlug: req.namespaceSlug ?? null, version: req.hubVersion ?? "1.0.0", sha: req.commitHash }) + "\n",
    );
    importCalls++;
    return { resourceId: req.name, installedPath: dir, version: "1.0.0" };
  };
  const CACHE_F = path.join(os.tmpdir(), "skillhub-prod-cache-f");
  fs.rmSync(CACHE_F, { recursive: true, force: true });

  // F1: sync1 → import + marker + mirror
  const r1 = await runSyncOnce("org-x", "org-id-x", {
    client: fakeClient as any, importFn: markerImportFn as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE_F, activeOrgIds: ["org-id-x"], pluginsRoot: PROOT,
  });
  assert(r1.imported.length === 1 && r1.imported[0] === "foo", "F1. sync1 导入 foo");
  assert(importCalls === 1, `F1. sync1 importFn 调 1 次, got ${importCalls}`);
  const fooEnt1 = JSON.parse(fs.readFileSync(ENT_FILE, "utf8")).entries
    .find((e: any) => e.resourceId === "foo" && e.scopeType === "org" && e.scopeId === "org-id-x" && e.effect === "allow");
  assert(!!fooEnt1, "F1. sync1 镜像 foo→org-id-x");

  // F1: sync2 同 sha → lookupExisting 读 marker 匹配 → skip + repair (不调 importFn)
  const r2 = await runSyncOnce("org-x", "org-id-x", {
    client: fakeClient as any, importFn: markerImportFn as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE_F, activeOrgIds: ["org-id-x"], pluginsRoot: PROOT,
  });
  assert(r2.imported.length === 0 && r2.skipped.length === 1, `F1. sync2 skip (marker 匹配), got imported=${r2.imported.length} skipped=${r2.skipped.length}`);
  assert(importCalls === 1, `F1. sync2 不再调 importFn (marker skip), got ${importCalls}`);
  console.log("✓ F1. marker 同源同 sha → skip + repair");

  // F2: 本地同名替换 → 删 marker (留 dir 模拟本地重装, 无 marker)
  const fooDir = path.join(PROOT, "foo");
  fs.rmSync(path.join(fooDir, ".hub-source.json"), { force: true });
  // dir 仍在 (本地 foo), marker 已删 → lookupExisting null → 全新导入 → 冲突 fail-closed
  const r3 = await runSyncOnce("org-x", "org-id-x", {
    client: fakeClient as any, importFn: markerImportFn as any, extractFn: fakeExtract as any,
    cacheRoot: CACHE_F, activeOrgIds: ["org-id-x"], pluginsRoot: PROOT,
  });
  assert(r3.imported.length === 0, "F2. 本地同名替换 → 不导入 (不 skip 名字匹配)");
  assert(r3.skipped.length === 0, "F2. 不 skip (marker 缺失 → null, 不靠 name-only)");
  assert(r3.errors.length === 1 && r3.errors[0].slug === "foo", `F2. 冲突 fail-closed error, got ${JSON.stringify(r3.errors)}`);
  // 无新增 entitlement 镜像到本地 foo: foo 仍只有 sync1 的 allow (未重 grant, 因为 import_failed 前置)
  const fooEntries = JSON.parse(fs.readFileSync(ENT_FILE, "utf8")).entries
    .filter((e: any) => e.resourceId === "foo" && e.scopeType === "org" && e.scopeId === "org-id-x");
  assert(fooEntries.length === 1 && fooEntries[0].effect === "allow", "F2. foo entitlement 仍是 sync1 那条 (无新 mirror 到本地资源)");
  console.log("✓ F2. 本地同名替换 → marker 缺失 → null → 冲突 fail-closed, 无 skip/无 mirror");
}

// ── G. 恶意 path-traversal ZIP → 真实 extractZip 拒绝 → fail-closed ──────
//   R5b-2: 生产默认 extractFn = 真实 extractZip + repackageToNativePlugin。
//   恶意归档 (../ 逃逸) 被 bounded-safe extractor 拒绝 → bridge per-skill
//   catch → import_failed 审计, 不导入、不镜像、无 entitlement。
//   注意: 不注入 extractFn override → 用 prod 默认真实解包器。
{
  // 隔离 ENT_FILE (避免前面 foo 条目干扰 mirror 断言)
  fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
  const malClient = {
    ...fakeClient,
    async downloadSkill(_ns: string, slug: string, v: string, destDir: string) {
      fs.mkdirSync(destDir, { recursive: true });
      // 恶意: 含 ../ 逃逸条目 → extractZip safeJoin 拒绝 + rmSync(destDir)。
      const zip = buildZip([
        { name: "SKILL.md", data: Buffer.from("# evil\n") },
        { name: "../evil.txt", data: Buffer.from("escape\n") },
      ]);
      const p = path.join(destDir, `${slug}-${v}.zip`);
      fs.writeFileSync(p, zip);
      // sha 与 getVersionDetail 的 "abc123" 对齐 → 通过 download-integrity check,
      // 真正的拒绝发生在 extractZip (path traversal), 而非 sha mismatch。
      return { localPath: p, sha256: "abc123" };
    },
  };
  let importCalled = false;
  const probeImport = async (_req: any) => { importCalled = true; return { resourceId: "foo" }; };

  const CACHE_G = path.join(os.tmpdir(), "skillhub-prod-cache-g");
  fs.rmSync(CACHE_G, { recursive: true, force: true });
  process.env.SKILLHUB_URL = "http://localhost:8080";
  process.env.SKILLHUB_TOKEN = "sk_test";
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: malClient as any, importFn: probeImport as any,
    cacheRoot: CACHE_G, activeOrgIds: ["org-id-x"],
    // 不注入 extractFn → 用 prod 默认 (真实 extractZip + repackage)
  });
  assert(r.imported.length === 0, `G. 恶意 ZIP → 不导入, got imported=${r.imported.length}`);
  assert(r.skipped.length === 0, "G. 不 skip");
  assert(r.errors.length === 1 && r.errors[0].slug === "foo", `G. fail-closed error, got ${JSON.stringify(r.errors)}`);
  assert(!importCalled, "G. extractZip 拒绝前置 → importFn 未被调");
  // 无 entitlement 镜像 (import_failed 前置, 不 grant)
  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  assert((ent.entries ?? []).length === 0, "G. 无 mirror (恶意 → 无 entitlement)");
  // 审计: skillhub.import_failed for foo (metadata-only)
  const failRow = db.prepare(
    "SELECT 1 FROM governance_audit_log WHERE action = 'skillhub.import_failed' AND object_id = 'foo' AND result = 'failure' LIMIT 1"
  ).get();
  assert(!!failRow, "G. skillhub.import_failed 审计行");
  // pkgDir 被清理 (无半包)
  const pkgDir = path.join(CACHE_G, "iflytek", "org-x", "foo", "1.0.0", "package");
  assert(!fs.existsSync(pkgDir) || fs.readdirSync(pkgDir).length === 0, "G. pkgDir 已清理 (无半包)");
  console.log("✓ G. 恶意 path-traversal ZIP → extractZip 拒绝 → fail-closed (不导入/不镜像/无 entitlement)");
}

// ── H. 缺 top-level SKILL.md → repackageToNativePlugin 拒绝 → fail-closed ─
//   R5b-2: Hub 包形必须含 top-level SKILL.md; 缺失 = 不是 skill 包 →
//   repackageToNativePlugin 抛 RepackageError → bridge catch → import_failed。
//   (extractZip + content-fingerprint 校验均通过 — 内容是良性的, 只是缺 SKILL.md。)
{
  fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
  const readme = Buffer.from("# readme\n");
  const pkgj = Buffer.from('{"name":"x","version":"9.9.9"}\n');
  const noSkillClient = {
    ...fakeClient,
    async getVersionDetail() {
      // 真实 content fingerprint (README + package.json) — 让 integrity 校验通过,
      // 真正的拒绝发生在 repackageToNativePlugin (missing SKILL.md)。
      return { version: "1.0.0", sha256: fpOf([{ name: "README.md", content: readme }, { name: "package.json", content: pkgj }]), parsedMetadataJson: null, manifestJson: null };
    },
    async downloadSkill(_ns: string, slug: string, v: string, destDir: string) {
      fs.mkdirSync(destDir, { recursive: true });
      // 良性 ZIP (无 traversal) 但缺 top-level SKILL.md → extractZip 通过 +
      // fingerprint 通过, repackageToNativePlugin 拒绝 (missing SKILL.md)。
      const zip = buildZip([
        { name: "README.md", data: readme },
        { name: "package.json", data: pkgj },
      ]);
      const p = path.join(destDir, `${slug}-${v}.zip`);
      fs.writeFileSync(p, zip);
      return { localPath: p, sha256: "abc123" };
    },
  };
  let importCalled = false;
  const probeImport = async (_req: any) => { importCalled = true; return { resourceId: "foo" }; };

  const CACHE_H = path.join(os.tmpdir(), "skillhub-prod-cache-h");
  fs.rmSync(CACHE_H, { recursive: true, force: true });
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: noSkillClient as any, importFn: probeImport as any,
    cacheRoot: CACHE_H, activeOrgIds: ["org-id-x"],
  });
  assert(r.imported.length === 0, `H. 缺 SKILL.md → 不导入, got imported=${r.imported.length}`);
  assert(r.errors.length === 1 && r.errors[0].slug === "foo", "H. fail-closed error");
  assert(!importCalled, "H. repackage 拒绝前置 → importFn 未被调");
  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  assert((ent.entries ?? []).length === 0, "H. 无 mirror (缺 SKILL.md → 无 entitlement)");
  const failRow = db.prepare(
    "SELECT 1 FROM governance_audit_log WHERE action = 'skillhub.import_failed' AND object_id = 'foo' AND result = 'failure' LIMIT 1"
  ).get();
  assert(!!failRow, "H. skillhub.import_failed 审计行");
  console.log("✓ H. 缺 top-level SKILL.md → repackage 拒绝 → fail-closed (不导入/不镜像/无 entitlement)");
}

// ── I. 良性真实 ZIP (Hub 包形) → 真实 extract+repackage → import + 镜像 ──
//   R5b-2 正向控制: Hub skill = top-level SKILL.md + npm package.json (非
//   native-plugin 形)。真实 extractFn 解包 → repackage 合成 .claude-plugin/
//   plugin.json (受信 slug/version) + 移动所有文件到 skills/<slug>/ →
//   importFn 收到 native-plugin 目录。验证:
//    1. 导入成功 + entitlement allow 写入 + 审计行
//    2. synthesized plugin.json 用受信 slug=foo/version=1.0.0, 非 untrusted
//       package.json 的 name=x/version=9.9.9 (trust boundary)
//    3. SKILL.md 落在 skills/foo/SKILL.md
{
  fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
  let capturedPkgDir: string | null = null;
  const captureImport = async (req: any) => {
    capturedPkgDir = req.path;
    return { resourceId: req.name, installedPath: `/tmp/skills/${req.name}`, version: "1.0.0" };
  };
  const benignClient = {
    ...fakeClient,
    async getVersionDetail() {
      // 真实 content fingerprint (SKILL.md + package.json + lib) — 让 prod
      // extractFn 的 content-fingerprint 校验通过, 证明 integrity 闭环。
      return { version: "1.0.0", sha256: fpOf([
        { name: "SKILL.md", content: "# agentguard skill\n" },
        { name: "package.json", content: '{"name":"attacker-evil","version":"9.9.9"}\n' },
        { name: "lib", content: "module\n" },
      ]), parsedMetadataJson: null, manifestJson: null };
    },
    async downloadSkill(_ns: string, slug: string, v: string, destDir: string) {
      fs.mkdirSync(destDir, { recursive: true });
      // 真实 Hub 包形: top-level SKILL.md + npm package.json (untrusted, 误导名)
      const zip = buildZip([
        { name: "SKILL.md", data: Buffer.from("# agentguard skill\n") },
        { name: "package.json", data: Buffer.from('{"name":"attacker-evil","version":"9.9.9"}\n') },
        { name: "lib", data: Buffer.from("module\n"), method: 8 },
      ]);
      const p = path.join(destDir, `${slug}-${v}.zip`);
      fs.writeFileSync(p, zip);
      return { localPath: p, sha256: "abc123" };
    },
  };

  const CACHE_I = path.join(os.tmpdir(), "skillhub-prod-cache-i");
  fs.rmSync(CACHE_I, { recursive: true, force: true });
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: benignClient as any, importFn: captureImport as any,
    cacheRoot: CACHE_I, activeOrgIds: ["org-id-x"],
    // 不注入 extractFn → 用 prod 默认 (真实 extractZip + repackage)
  });
  assert(r.imported.length === 1 && r.imported[0] === "foo", `I. 良性 ZIP → 导入 foo, got ${JSON.stringify(r)}`);
  assert(!!capturedPkgDir, "I. importFn 被调 (收到 pkgDir)");
  // I.1 plugin.json 用受信 slug/version (非 untrusted package.json)
  const pluginJson = JSON.parse(fs.readFileSync(path.join(capturedPkgDir!, ".claude-plugin", "plugin.json"), "utf8"));
  assert(pluginJson.name === "foo" && pluginJson.version === "1.0.0", `I. plugin.json 受信 slug=foo/version=1.0.0, got ${JSON.stringify(pluginJson)}`);
  assert(pluginJson.name !== "attacker-evil" && pluginJson.version !== "9.9.9", "I. 不用 untrusted package.json 的 name/version");
  // I.2 SKILL.md 落在 skills/foo/SKILL.md
  const skillMd = path.join(capturedPkgDir!, "skills", "foo", "SKILL.md");
  assert(fs.existsSync(skillMd), "I. skills/foo/SKILL.md 存在");
  assert(fs.readFileSync(skillMd, "utf8").includes("agentguard"), "I. SKILL.md 内容正确");
  // I.3 所有提取文件在 skills/foo/ 下 (package.json + lib 也一起)
  const skillDir = path.join(capturedPkgDir!, "skills", "foo");
  const names = fs.readdirSync(skillDir).sort();
  assert(names.includes("package.json") && names.includes("lib") && names.includes("SKILL.md"), `I. 全部提取文件移到 skills/foo/, got [${names.join(",")}]`);
  // I.4 entitlement allow + 审计
  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  const allow = ent.entries.find((e: any) => e.resourceId === "foo" && e.scopeType === "org" && e.scopeId === "org-id-x" && e.effect === "allow");
  assert(!!allow, "I. entitlement allow foo→org-id-x 写入");
  const impRow = db.prepare("SELECT 1 FROM governance_audit_log WHERE action = 'skillhub.import' AND object_id = 'foo' AND result = 'success' LIMIT 1").get();
  assert(!!impRow, "I. skillhub.import 审计行");
  const mirrorRow = db.prepare("SELECT 1 FROM governance_audit_log WHERE action = 'skillhub.mirror' AND object_id = 'foo' LIMIT 1").get();
  assert(!!mirrorRow, "I. skillhub.mirror 审计行");
  console.log("✓ I. 良性真实 ZIP → extract+repackage → import + 镜像 (plugin.json 受信合成)");
}

// ── J. validateImportPath 仍是守卫 (未被 adapter 削弱) ───────────────────
//   R5b-2 铁律: adapter 不放宽 importNativePlugin/skill-config 校验。验证
//   validateImportPath 对归档文件 (非目录) 仍拒绝, 对目录仍放行。
{
  const arch = path.join(os.tmpdir(), "skillhub-prod-archive.zip");
  fs.writeFileSync(arch, Buffer.from("PK\x03\x04not-a-real-zip"));
  let threwArchive = false;
  try { validateImportPath(arch); } catch { threwArchive = true; }
  assert(threwArchive, "J. validateImportPath 拒绝归档文件 (非目录)");
  // dir 必须在 PLUGIN_IMPORT_ROOT 内才放行 (validateImportPath 守卫 import root 边界)。
  const dir = path.join(IMPORT_ROOT, "skillhub-prod-dir");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let threwDir = false;
  try { validateImportPath(dir); } catch { threwDir = true; }
  assert(!threwDir, "J. validateImportPath 放行 import root 内的目录");
  // 守卫未削弱: 路径逃出 import root 仍拒绝
  let threwEscape = false;
  try { validateImportPath("/etc"); } catch { threwEscape = true; }
  assert(threwEscape, "J. validateImportPath 拒绝逃出 import root 的路径");
  console.log("✓ J. validateImportPath 守卫未削弱 (归档拒绝/目录放行/逃出拒绝)");
}

// ── K. content-fingerprint mismatch → fail-closed (R5b-2 integrity) ──────
//   Codex P1: fingerprint is the CONTENT hash (SkillQueryService.computeFingerprint:
//   sort files by rel POSIX path, <path>:<bareHexSha>\n, sha256:hex), NOT the
//   ZIP-archive hash. A benign ZIP whose extracted content fingerprint differs
//   from the resolve-provided fingerprint → reject (tamper/corruption signal),
//   no import, no entitlement, import_failed audit.
{
  fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
  const skillMd = Buffer.from("# real skill\n");
  const tamperedClient = {
    ...fakeClient,
    async getVersionDetail() {
      // Expected fingerprint of the ORIGINAL content — but downloadSkill
      // delivers a TAMPERED SKILL.md (different bytes) → extracted content
      // fingerprint != this expected → reject.
      return { version: "1.0.0", sha256: fpOf([{ name: "SKILL.md", content: "# ORIGINAL\n" }]), parsedMetadataJson: null, manifestJson: null };
    },
    async downloadSkill(_ns: string, slug: string, v: string, destDir: string) {
      fs.mkdirSync(destDir, { recursive: true });
      // 良性 ZIP (无 traversal, 有 SKILL.md) 但内容被篡改 → extractZip 通过,
      // fingerprint 校验拒绝 (expected="# ORIGINAL", actual="# real skill")。
      const zip = buildZip([{ name: "SKILL.md", data: skillMd }]);
      const p = path.join(destDir, `${slug}-${v}.zip`);
      fs.writeFileSync(p, zip);
      return { localPath: p, sha256: "abc123" };
    },
  };
  let importCalled = false;
  const probeImport = async (_req: any) => { importCalled = true; return { resourceId: "foo" }; };
  const CACHE_K = path.join(os.tmpdir(), "skillhub-prod-cache-k");
  fs.rmSync(CACHE_K, { recursive: true, force: true });
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: tamperedClient as any, importFn: probeImport as any,
    cacheRoot: CACHE_K, activeOrgIds: ["org-id-x"],
    // 不注入 extractFn → prod 默认 (extractZip + content-fingerprint 校验)
  });
  assert(r.imported.length === 0, `K. fingerprint mismatch → 不导入, got imported=${r.imported.length}`);
  assert(r.errors.length === 1 && r.errors[0].slug === "foo", "K. fail-closed error");
  assert(!importCalled, "K. fingerprint 拒绝前置 → importFn 未被调");
  const ent = JSON.parse(fs.readFileSync(ENT_FILE, "utf8"));
  assert((ent.entries ?? []).length === 0, "K. 无 mirror (fingerprint mismatch → 无 entitlement)");
  const failRow = db.prepare(
    "SELECT 1 FROM governance_audit_log WHERE action = 'skillhub.import_failed' AND object_id = 'foo' AND result = 'failure' LIMIT 1"
  ).get();
  assert(!!failRow, "K. skillhub.import_failed 审计行");
  // pkgDir 已清理 (无半包)
  const pkgDir = path.join(CACHE_K, "iflytek", "org-x", "foo", "1.0.0", "package");
  assert(!fs.existsSync(pkgDir) || fs.readdirSync(pkgDir).length === 0, "K. pkgDir 已清理 (无半包)");
  console.log("✓ K. content-fingerprint mismatch → fail-closed (不导入/不镜像/无 entitlement)");
}

// ── L. missing/malformed content fingerprint → deny-default ─────────────
for (const badFingerprint of [null, "", "abc123", "sha256:not-hex"] as const) {
  fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
  const files = [{ name: "SKILL.md", data: Buffer.from("# valid skill\n") }];
  const client = {
    ...fakeClient,
    async getVersionDetail() { return { version: "1.0.0", sha256: badFingerprint, parsedMetadataJson: null, manifestJson: null }; },
    async downloadSkill(_ns: string, slug: string, v: string, destDir: string) {
      fs.mkdirSync(destDir, { recursive: true });
      const p = path.join(destDir, `${slug}-${v}.zip`);
      fs.writeFileSync(p, buildZip(files));
      return { localPath: p, sha256: "archive-sha" };
    },
  };
  let importCalled = false;
  const cacheRoot = path.join(os.tmpdir(), `skillhub-prod-cache-l-${String(badFingerprint)}`);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  const r = await runSyncOnce("org-x", "org-id-x", {
    client: client as any,
    importFn: (async () => { importCalled = true; return { resourceId: "foo" }; }) as any,
    cacheRoot, activeOrgIds: ["org-id-x"],
  });
  assert(r.imported.length === 0 && r.errors.length === 1, `L. bad fingerprint rejected: ${JSON.stringify(badFingerprint)}`);
  assert(!importCalled, `L. import not called: ${JSON.stringify(badFingerprint)}`);
  assert(JSON.parse(fs.readFileSync(ENT_FILE, "utf8")).entries.length === 0, `L. no entitlement: ${JSON.stringify(badFingerprint)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
process.exit(0);
