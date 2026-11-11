/**
 * skillhub-bridge.test.ts — fake client/installer/grant/audit 测试, 不依赖运行中的 iflytek。
 * Run: npx tsx server/skillhub-bridge.test.ts
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let passed = 0, failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) passed++; else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

const TMP = path.join(os.tmpdir(), "skillhub-bridge-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "iflytek"), { recursive: true });

// R5b-2: fakeClient 模拟真实 Hub 契约的 client 接口 (envelope 已 unwrap;
// downloadSkill 返回 {slug}-{version}.zip + 本地 sha; getVersionDetail 的
// fingerprint→sha256, manifest/metadata=null — 真实 resolve 不返回这些)。
const fakeClient = {
  async listNamespaces() { return [{ slug: "org-x", displayName: "Org X", type: "TEAM" as const, status: "ACTIVE" }]; },
  async listPublishedSkills() {
    return [{ slug: "foo", displayName: "Foo", namespaceSlug: "org-x", latestVersion: "1.0.0" }];
  },
  async getVersionDetail() { return { version: "1.0.0", sha256: "abc123", parsedMetadataJson: null, manifestJson: null }; },
  async downloadSkill(_ns: string, slug: string, v: string, destDir: string) {
    fs.mkdirSync(destDir, { recursive: true });
    const p = path.join(destDir, `${slug}-${v}.zip`);
    fs.writeFileSync(p, "fake-zip");
    return { localPath: p, sha256: "abc123" };
  },
};

const importCalls: any[] = [];
const fakeImport = async (req: any) => {
  importCalls.push(req);
  return { resourceId: req.name, installedPath: `/tmp/skills/${req.name}`, version: "1.0.0" };
};

const { createSyncBridge } = await import("./skillhub-bridge.js");

// ─── 1. sync PUBLISHED → importFn(hubSourceId=iflytek, commitHash=sha256) ──
{
  const events: any[] = [];
  const bridge = createSyncBridge({
    client: fakeClient as any, importFn: fakeImport as any,
    cacheRoot: TMP, onSync: (e: any) => events.push(e),
  });
  const result = await bridge.syncNamespace("org-x", "org-id-x");
  assert(result.imported.length === 1, "1. 导入 1 个 skill");
  assert(result.imported[0] === "foo", "1. 导入的是 foo");
  assert(importCalls.length === 1, "1. importFn 被调 1 次");
  assert(importCalls[0].name === "foo", "1. importFn name=foo");
  assert(importCalls[0].hubSourceId === "iflytek", "1. hubSourceId=iflytek");
  assert(importCalls[0].commitHash === "abc123", "1. commitHash=sha256");
  assert(importCalls[0].namespaceSlug === "org-x", "1. namespaceSlug=org-x");
  assert(importCalls[0].hubVersion === "1.0.0", "1. hubVersion=1.0.0");
  assert(events.some((e) => e.type === "import" && e.slug === "foo"), "1. onSync import 事件");
  console.log("✓ 1. sync → importFn (hubSourceId/commitHash/ns/hubVersion)");
}

// ─── 2. TEAM namespace → 给对应 org grant allow ───────────────────────────
{
  const grantCalls: any[] = [];
  const bridge = createSyncBridge({
    client: fakeClient as any, importFn: fakeImport as any,
    cacheRoot: path.join(TMP, "t2"), grantEntitlement: async (_ctx, resourceId, entries) => {
      grantCalls.push({ resourceId, entries });
    }, grantCtx: { userId: "system", role: "admin", orgId: "" },
  });
  await bridge.syncNamespace("org-x", "org-id-x");
  assert(grantCalls.length === 1, "2. TEAM grant 1 次");
  assert(grantCalls[0].resourceId === "foo", "2. grant resourceId=foo");
  assert(grantCalls[0].entries.length === 1, "2. entries 1 条 (一次性提交)");
  assert(grantCalls[0].entries[0].scopeId === "org-id-x" && grantCalls[0].entries[0].effect === "allow", "2. foo→org-id-x org allow");
  console.log("✓ 2. TEAM → org scope allow (一次性提交)");
}

// ─── 3. GLOBAL namespace → 给所有 active org grant ───────────────────────
{
  const grantCalls: any[] = [];
  const globalClient = { ...fakeClient, async listNamespaces() { return [{ slug: "@global", displayName: "Global", type: "GLOBAL" as const, status: "ACTIVE" }]; } };
  const bridge = createSyncBridge({
    client: globalClient as any, importFn: fakeImport as any,
    cacheRoot: path.join(TMP, "t3"), grantEntitlement: async (_ctx, resourceId, entries) => {
      grantCalls.push({ resourceId, entries });
    }, grantCtx: { userId: "system", role: "admin", orgId: "" },
    activeOrgIds: ["org-id-x", "org-id-y"],
  });
  await bridge.syncNamespace("@global", "");
  assert(grantCalls.length === 1, `3. GLOBAL grant 1 次(一次性), got ${grantCalls.length}`);
  assert(grantCalls[0].entries.length === 2, `3. entries 2 条, got ${grantCalls[0].entries.length}`);
  const ids = grantCalls[0].entries.map((e: any) => e.scopeId).sort();
  assert(ids.join(",") === "org-id-x,org-id-y", "3. 两个 org 都在 entries");
  console.log("✓ 3. GLOBAL → 所有 active org (一次性提交)");
}

// ─── 4. 单 skill 失败不阻断后续 ───────────────────────────────────────────
{
  const failClient = {
    ...fakeClient,
    async listPublishedSkills() {
      return [
        { slug: "good", displayName: "Good", namespaceSlug: "org-x", latestVersion: "1.0.0" },
        { slug: "bad", displayName: "Bad", namespaceSlug: "org-x", latestVersion: "2.0.0" },
        { slug: "alsogood", displayName: "Also", namespaceSlug: "org-x", latestVersion: "1.0.0" },
      ];
    },
    async getVersionDetail(_ns: string, slug: string) {
      if (slug === "bad") throw new Error("version not found");
      // sha 与继承的 fakeClient.downloadSkill ("abc123") 一致 — 否则 R5b-2
      // download-integrity check (deny-wins on sha mismatch) 会拒绝导入。
      return { version: "1.0.0", sha256: "abc123", parsedMetadataJson: null, manifestJson: null };
    },
  };
  const calls: any[] = [];
  const bridge = createSyncBridge({
    client: failClient as any, importFn: (async (req: any) => { calls.push(req); return { resourceId: req.name }; }) as any, cacheRoot: path.join(TMP, "t4"),
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.imported.length === 2, `4. good+alsogood 导入 2, got ${r.imported.length}`);
  assert(r.errors.length === 1 && r.errors[0].slug === "bad", "4. bad 1 error");
  assert(calls.length === 2, "4. bad 失败不阻断后续");
  console.log("✓ 4. 单 skill 失败隔离");
}

// ─── 5. 幂等: lookupExisting 同 sha → 跳过安装 但「仍补」镜像 (repair) ─────
{
  const grantCalls: any[] = [];
  const importCalls5: any[] = [];
  const bridge = createSyncBridge({
    client: fakeClient as any,
    importFn: (async (req: any) => { importCalls5.push(req); return { resourceId: req.name }; }) as any,
    cacheRoot: path.join(TMP, "t5"),
    grantEntitlement: async (_ctx, resourceId, entries) => { grantCalls.push({ resourceId, entries }); },
    grantCtx: { userId: "system", role: "admin", orgId: "" },
    lookupExisting: async () => ({ resourceId: "foo", sha: "abc123" }), // 同 sha → 已存在
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.imported.length === 0, "5. 已存在同 sha → 不安装");
  assert(r.skipped.length === 1, "5. skip 1");
  assert(importCalls5.length === 0, "5. 不调 importFn");
  assert(grantCalls.length === 1, `5. 仍补镜像 1 次(repair), got ${grantCalls.length}`);
  assert(grantCalls[0].resourceId === "foo", "5. 镜像用 existing resourceId");
  assert(grantCalls[0].entries.length === 1 && grantCalls[0].entries[0].scopeId === "org-id-x", "5. 镜像 entries 1 条 org-id-x");
  console.log("✓ 5. 幂等: 同 sha 跳过安装 + 仍补 entitlement 镜像");
}

// ─── 6. sha drift: 同 version 不同 sha → 拒绝 + 审计, 不镜像 ───────────────
{
  const auditCalls: any[] = [];
  const grantCalls: any[] = [];
  const bridge = createSyncBridge({
    client: fakeClient as any,
    importFn: fakeImport as any,
    cacheRoot: path.join(TMP, "t6"),
    grantEntitlement: async (_c, r, entries) => { grantCalls.push({ r, entries }); },
    grantCtx: { userId: "system", role: "admin", orgId: "" },
    auditFn: (e) => auditCalls.push(e),
    lookupExisting: async () => ({ resourceId: "foo", sha: "OLD-SHA" }), // 不同 sha → drift
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.imported.length === 0, "6. drift → 不导入");
  assert(r.errors.length === 1 && r.errors[0].reason === "sha drift", "6. drift error");
  assert(grantCalls.length === 0, "6. drift → 不镜像");
  const drift = auditCalls.find((a) => a.action === "skillhub.sha_drift");
  assert(!!drift && drift.result === "failure", "6. sha_drift 审计 failure");
  console.log("✓ 6. sha drift → 拒绝 + 审计, 不镜像");
}

// ─── 7. 未知 namespace slug → fail-closed (不导入/不镜像/审计) ───────────
{
  const auditCalls: any[] = [];
  const grantCalls: any[] = [];
  const bridge = createSyncBridge({
    client: fakeClient as any, importFn: fakeImport as any,
    cacheRoot: path.join(TMP, "t7"),
    grantEntitlement: async (_c, r, entries) => { grantCalls.push({ r, entries }); },
    grantCtx: { userId: "system", role: "admin", orgId: "" },
    auditFn: (e) => auditCalls.push(e),
  });
  const r = await bridge.syncNamespace("nonexistent-ns", "org-id-x");
  assert(r.imported.length === 0, "7. 未知 ns → 不导入");
  assert(r.skipped.length === 0, "7. 未知 ns → 不 skip");
  assert(r.errors.length === 1 && r.errors[0].reason === "namespace unknown", "7. 未知 ns error");
  assert(grantCalls.length === 0, "7. 未知 ns → 不镜像");
  const nf = auditCalls.find((a) => a.action === "skillhub.namespace_failed" && a.reason === "namespace unknown");
  assert(!!nf, "7. namespace_failed 审计");
  console.log("✓ 7. 未知 namespace → fail-closed");
}

// ─── 8. inactive/frozen namespace → fail-closed ───────────────────────────
{
  const auditCalls: any[] = [];
  const frozenClient = { ...fakeClient, async listNamespaces() { return [{ slug: "org-x", displayName: "X", type: "TEAM" as const, status: "FROZEN" }]; } };
  const bridge = createSyncBridge({
    client: frozenClient as any, importFn: fakeImport as any, cacheRoot: path.join(TMP, "t8"),
    auditFn: (e) => auditCalls.push(e),
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.imported.length === 0 && r.errors.length === 1, "8. frozen → 不导入 + error");
  assert(r.errors[0].reason === "namespace inactive", "8. inactive reason");
  assert(!!auditCalls.find((a) => a.reason === "namespace inactive"), "8. inactive 审计");
  console.log("✓ 8. inactive namespace → fail-closed");
}

// ─── 9. listNamespaces 抛错 → fail-closed (不默认 TEAM) ───────────────────
{
  const auditCalls: any[] = [];
  const errClient = { ...fakeClient, async listNamespaces() { throw new Error("503 service down"); } };
  const bridge = createSyncBridge({
    client: errClient as any, importFn: fakeImport as any, cacheRoot: path.join(TMP, "t9"),
    auditFn: (e) => auditCalls.push(e),
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.imported.length === 0, "9. lookup 抛 → 不导入");
  assert(r.errors.length === 1 && r.errors[0].reason === "namespace lookup failed", "9. lookup failed reason");
  assert(!!auditCalls.find((a) => a.reason === "namespace lookup failed"), "9. lookup failed 审计");
  console.log("✓ 9. namespace lookup 失败 → fail-closed (不默认 TEAM)");
}

// ─── 10. 审计 metadata-only + 敏感串不泄漏 ────────────────────────────────
const SENT = "SECRET-HUB-TOKEN-999";
{
  const auditCalls: any[] = [];
  const sentClient = { ...fakeClient, async getVersionDetail() { throw new Error(`upload ${SENT} failed`); } };
  const bridge = createSyncBridge({
    client: sentClient as any, importFn: fakeImport as any, cacheRoot: path.join(TMP, "t10"),
    auditFn: (e) => auditCalls.push(e),
  });
  await bridge.syncNamespace("org-x", "org-id-x");
  const impFail = auditCalls.find((a) => a.action === "skillhub.import_failed");
  assert(!!impFail, "10. import_failed 审计");
  assert(impFail.reason === "import failed", "10. reason categorical");
  assert(!JSON.stringify(auditCalls).includes(SENT), "10. 敏感串不进 audit");
  const allowed = new Set(["action", "namespaceSlug", "orgId", "objectId", "result", "reason"]);
  const extra = Object.keys(impFail).filter((k) => !allowed.has(k));
  assert(extra.length === 0, `10. 无 payload/body/token (got ${extra.join(",")})`);
  console.log("✓ 10. 审计 metadata-only + 敏感串不泄漏");
}

// ─── 11. 无 published version → skip, 不调 importFn ───────────────────────
{
  const novClient = { ...fakeClient, async listPublishedSkills() { return [{ slug: "draft", displayName: "Draft", namespaceSlug: "org-x", latestVersion: null }]; } };
  const calls: any[] = [];
  const bridge = createSyncBridge({
    client: novClient as any, importFn: (async (req: any) => { calls.push(req); return { resourceId: req.name }; }) as any, cacheRoot: path.join(TMP, "t11"),
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.skipped.length === 1 && r.imported.length === 0 && calls.length === 0, "11. 无版本 → skip, 不调 importFn");
  console.log("✓ 11. 无 published version → skip");
}

// ─── 12. extractFn 路径: bridge 调 extractFn(archive, pkgDir, {slug,version})
//         并把 pkgDir (非 archive) 传给 importFn ─────────────────────────────
//   R5b-2: 真实 Hub 投递 ZIP 归档, 生产 extractFn 解包+repackage 到 pkgDir,
//   importFn 收到的是解包后的插件包目录, 不是归档文件路径。
{
  const extractCalls: any[] = [];
  const importCalls12: any[] = [];
  const bridge = createSyncBridge({
    client: fakeClient as any,
    importFn: (async (req: any) => { importCalls12.push(req); return { resourceId: req.name }; }) as any,
    cacheRoot: path.join(TMP, "t12"),
    extractFn: async (artifactPath: string, destDir: string, meta: { slug: string; version: string }) => {
      extractCalls.push({ artifactPath, destDir, meta });
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "marker"), "ok");
    },
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.imported.length === 1, `12. 导入 1, got ${r.imported.length}`);
  assert(extractCalls.length === 1, "12. extractFn 调 1 次");
  assert(extractCalls[0].meta.slug === "foo" && extractCalls[0].meta.version === "1.0.0", "12. meta={slug:foo,version:1.0.0}");
  assert(extractCalls[0].artifactPath.endsWith("foo-1.0.0.zip"), "12. archive 是下载的归档");
  assert(importCalls12.length === 1 && importCalls12[0].path === extractCalls[0].destDir, "12. importFn 收到 pkgDir (非归档)");
  console.log("✓ 12. extractFn(archive,pkgDir,{slug,version}) → importFn 收 pkgDir");
}

// ─── 13. every extractor/repackage rejection class has the same bridge-level
// fail-closed semantics. The real archive bytes are covered by the extractor
// matrix; this table proves each rejection cannot reach import or entitlement.
for (const rejection of [
  "path traversal rejected", "absolute path rejected", "symlink rejected",
  "entry count limit", "file size limit", "total size limit",
  "compression ratio limit", "nested traversal rejected", "CRC mismatch",
  "local header mismatch", "missing top-level SKILL.md",
]) {
  const auditCalls: any[] = [];
  const grantCalls: any[] = [];
  const importCalls13: any[] = [];
  const bridge = createSyncBridge({
    client: fakeClient as any,
    importFn: (async (req: any) => { importCalls13.push(req); return { resourceId: req.name }; }) as any,
    cacheRoot: path.join(TMP, "t13", rejection.replace(/[^a-z0-9]+/gi, "-")),
    extractFn: async (_archive, destDir) => {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "partial"), "x");
      fs.rmSync(destDir, { recursive: true, force: true });
      throw new Error(`zip: ${rejection}`);
    },
    grantEntitlement: async (_ctx, resourceId, entries) => { grantCalls.push({ resourceId, entries }); },
    grantCtx: { userId: "system", role: "admin", orgId: "" },
    auditFn: (e) => auditCalls.push(e),
  });
  const r = await bridge.syncNamespace("org-x", "org-id-x");
  assert(r.imported.length === 0, `13. ${rejection}: 不导入`);
  assert(r.errors.length === 1 && r.errors[0].slug === "foo", `13. ${rejection}: foo 1 error`);
  assert(importCalls13.length === 0, `13. ${rejection}: importFn 未调用`);
  assert(grantCalls.length === 0, `13. ${rejection}: entitlement 未调用`);
  const impFail = auditCalls.find((a) => a.action === "skillhub.import_failed" && a.objectId === "foo");
  assert(!!impFail && impFail.result === "failure", `13. ${rejection}: import_failed audit`);
  assert(!JSON.stringify(auditCalls).includes(rejection), `13. ${rejection}: audit metadata-only`);
}
console.log("✓ 13. extraction/repackage rejection matrix → import_failed, no import/entitlement");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
process.exit(0);
