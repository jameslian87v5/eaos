/**
 * skillhub-bridge.ts — 同步桥: iflytek PUBLISHED skill → 本平台共享池 + entitlement 镜像。
 * 设计依据: docs/02-architecture/skill-hub-iflytek-integration-design.md §4 §7
 *
 * 不含 iflytek 源码, 只调 client + 注入的 importFn (生产 = importNativePlugin)
 * + 注入的 grantEntitlement (生产 = entitlementService 写 allow) + 注入的
 * lookupExisting (生产 = 查缓存 sidecar + 装好的 skill)。可注入便于测试。
 *
 * 铁律 (codex round-1 review):
 *  - 命名空间 fail-closed: lookup 失败 / 未知 slug / 非 ACTIVE(frozen/inactive)
 *    → 整个 namespace 不导入、不镜像, metadata-only categorical 审计, 绝不
 *    默认 TEAM。
 *  - 幂等用显式 lookup 契约, 不靠 exception 字符串匹配: lookupExisting(ns,slug,
 *    version,sha) 返回 {resourceId, sha} 时, sha 相同 → 跳过安装但「仍补齐」
 *    entitlement 镜像(repair); sha 不同 → drift, 拒绝导入 + 审计。null → 全新导入。
 *  - 单 Skill 失败隔离: per-skill try/catch, 一个失败不阻断后续。
 *  - 治理审计 metadata-only: auditFn 只收 action/objectId/result/reason
 *    (categorical), NEVER token/body/payload/err.message。
 *  - 不改 MCP / Runtime 铁律; 只读复用 importNativePlugin + 现有 resolve/路径校验。
 */
import path from "node:path";
import fs from "node:fs";
import type { SkillhubClient } from "./skillhub-client.js";

export interface SyncEvent {
  type: "import" | "skip" | "error" | "mirror";
  slug: string;
  version?: string;
  resourceId?: string;
  namespaceSlug: string;
  orgId: string;
  reason?: string;
}

export interface SyncResult {
  imported: string[];
  skipped: string[];
  errors: Array<{ slug: string; reason: string }>;
}

export interface EntitlementGrantCtx {
  userId: string;
  role: "admin";
  orgId: string;
}

/** 一次提交该 resource 的完整 intended entry 集 (PUT/merge 由实现决定)。
 *  桥接一次性把所有目标 org 的 org-scope allow 收集成一个数组传入 — 避免
 *  逐 org 调用被 PUT 语义互相覆盖 (codex R5a round-2: GLOBAL 镜像只留最后一个 org)。
 *  实现契约 (round-3): 必须 deny-wins — 同 (scopeType,scopeId) 的既有 deny 不得
 *  被 incoming allow 覆盖 (§7.2: admin 手动 tightening 覆盖 mirror, deny 优先)。 */
export type GrantFn = (
  ctx: EntitlementGrantCtx,
  resourceId: string,
  entries: Array<{ scopeType: "org"; scopeId: string; effect: "allow" }>,
) => Promise<void>;

/** metadata-only 审计事件 — 无 token/body/payload。reason 固定类别串。 */
export interface AuditEvent {
  action: "skillhub.import" | "skillhub.import_failed" | "skillhub.mirror" | "skillhub.mirror_failed" | "skillhub.sha_drift" | "skillhub.namespace_failed";
  namespaceSlug: string;
  orgId: string;
  objectId: string;
  result: "success" | "failure";
  reason: string;
}

export type AuditFn = (e: AuditEvent) => void;

/** 显式幂等契约: 已存在资源(同 source+version)的 sha + resourceId。 */
export interface ExistingResource {
  resourceId: string;
  sha: string | null;
}

export type LookupExistingFn = (
  namespaceSlug: string,
  slug: string,
  version: string,
  sha: string | null,
) => Promise<ExistingResource | null>;

export interface SyncBridgeOptions {
  client: SkillhubClient;
  importFn: (req: { path: string; name: string; hubSourceId: string; commitHash: string; namespaceSlug: string; hubVersion: string }) => Promise<{ resourceId: string }>;
  cacheRoot: string;
  onSync?: (event: SyncEvent) => void;
  grantEntitlement?: GrantFn;
  grantCtx?: EntitlementGrantCtx;
  activeOrgIds?: string[];
  auditFn?: AuditFn;
  /** 显式幂等查询; 未注入则视为「无已存在」(全新导入, 重复名由 importFn 报错)。 */
  lookupExisting?: LookupExistingFn;
  /** 安全解包下载的 artifact: 把 client.downloadSkill 返回的归档文件解包到
   *  destDir (插件包目录, 传给 importFn)。R5b-2: 生产实现 = extractZip +
   *  repackageToNativePlugin (Hub 包形非 native-plugin, 需适配)。meta 携带
   *  受信 slug/version 供合成 .claude-plugin/plugin.json + expectedFingerprint
   *  (resolve 的 data.fingerprint) 供内容指纹校验。未注入 → 把归档路径
   *  直传 importFn (假定已是目录, 仅测试用)。失败必须清理 destDir。 */
  extractFn?: (artifactPath: string, destDir: string, meta: { slug: string; version: string; expectedFingerprint?: string | null }) => Promise<void>;
}

export interface SyncBridge {
  syncNamespace(namespaceSlug: string, orgId: string): Promise<SyncResult>;
}

function sidecarPath(cacheRoot: string, ns: string, slug: string, version: string): string {
  return path.join(cacheRoot, "iflytek", ns, slug, version, "bundle.sha256");
}
void sidecarPath; // sidecar 已被 .hub-source.json marker 取代 (codex R5a round-4/5);
                 // 保留函数供未来审计/迁移, 当前不写不读。

export function createSyncBridge(opts: SyncBridgeOptions): SyncBridge {
  const { client, importFn, cacheRoot, onSync, grantEntitlement, grantCtx, activeOrgIds, auditFn, lookupExisting, extractFn } = opts;

  return {
    async syncNamespace(namespaceSlug: string, orgId: string): Promise<SyncResult> {
      const imported: string[] = [];
      const skipped: string[] = [];
      const errors: Array<{ slug: string; reason: string }> = [];

      // ── fail-closed: 命名空间 lookup / 未知 / 非 ACTIVE → 整个 namespace 不动 ──
      let nsType: "GLOBAL" | "TEAM";
      try {
        const namespaces = await client.listNamespaces();
        const nsInfo = namespaces.find((n) => n.slug === namespaceSlug);
        if (!nsInfo) {
          errors.push({ slug: namespaceSlug, reason: "namespace unknown" });
          auditFn?.({ action: "skillhub.namespace_failed", namespaceSlug, orgId, objectId: namespaceSlug, result: "failure", reason: "namespace unknown" });
          return { imported, skipped, errors };
        }
        if (String(nsInfo.status).toUpperCase() !== "ACTIVE") {
          errors.push({ slug: namespaceSlug, reason: "namespace inactive" });
          auditFn?.({ action: "skillhub.namespace_failed", namespaceSlug, orgId, objectId: namespaceSlug, result: "failure", reason: "namespace inactive" });
          return { imported, skipped, errors };
        }
        nsType = nsInfo.type;
      } catch (err: any) {
        errors.push({ slug: namespaceSlug, reason: "namespace lookup failed" });
        auditFn?.({ action: "skillhub.namespace_failed", namespaceSlug, orgId, objectId: namespaceSlug, result: "failure", reason: "namespace lookup failed" });
        return { imported, skipped, errors };
      }

      const skills = await client.listPublishedSkills(namespaceSlug);
      for (const skill of skills) {
        if (!skill.latestVersion) {
          skipped.push(skill.slug);
          onSync?.({ type: "skip", slug: skill.slug, namespaceSlug, orgId, reason: "no published version" });
          continue;
        }
        try {
          const detail = await client.getVersionDetail(namespaceSlug, skill.slug, skill.latestVersion);
          const sha = detail.sha256 ?? skill.latestVersion;

          // ── 显式幂等: lookupExisting 契约 ──────────────────────────────────
          const existing = lookupExisting ? await lookupExisting(namespaceSlug, skill.slug, skill.latestVersion, detail.sha256 ?? null) : null;
          let resourceId: string;
          if (existing) {
            if (existing.sha != null && detail.sha256 != null && existing.sha !== detail.sha256) {
              // 同 version 不同 sha → drift, 拒绝导入 + 审计, 不镜像。
              errors.push({ slug: skill.slug, reason: "sha drift" });
              onSync?.({ type: "error", slug: skill.slug, namespaceSlug, orgId, reason: "sha drift" });
              auditFn?.({ action: "skillhub.sha_drift", namespaceSlug, orgId, objectId: skill.slug, result: "failure", reason: "sha drift" });
              continue;
            }
            // 同 source+version+sha → 跳过安装, 但「仍补齐」entitlement 镜像。
            resourceId = existing.resourceId;
            skipped.push(skill.slug);
            onSync?.({ type: "skip", slug: skill.slug, namespaceSlug, orgId, reason: "already imported" });
            auditFn?.({ action: "skillhub.import", namespaceSlug, orgId, objectId: resourceId, result: "success", reason: "already imported" });
          } else {
            // 全新导入: 下载归档 → 安全解包 (extractFn) → importFn(解包目录)
            // real importNativePlugin.validateImportPath 要求源是目录, 不能传
            // 归档文件 (codex R5a round-5)。download 与 extract 用不同子目录:
            // download/ 存归档, package/ 是解包后的插件包目录 (传给 importFn)。
            // extractFn 缺省 = 透传 dl.localPath (仅测试用, 假定已是目录)。
            const baseDir = path.join(cacheRoot, "iflytek", namespaceSlug, skill.slug, skill.latestVersion);
            const dlDir = path.join(baseDir, "download");
            const pkgDir = path.join(baseDir, "package");
            const dl = await client.downloadSkill(namespaceSlug, skill.slug, skill.latestVersion, dlDir);
            // R5b-2 integrity model (VERIFIED live): the resolved `fingerprint`
            // (detail.sha256) is the Hub's CONTENT hash (sha256:…), NOT the
            // ZIP-archive hash — it is NOT comparable to the local ZIP sha256.
            // Archive integrity is enforced by extractZip (central-directory +
            // inflateRaw, size-mismatch/corruption reject + destDir cleanup).
            // The fingerprint is the provenance marker (passed to importFn as
            // commitHash → .hub-source.json sha) for cross-sync drift detection
            // (fingerprint-to-fingerprint via lookupExisting), NOT a download
            // hash. So no local-ZIP-vs-fingerprint comparison here.
            void dl;
            const importPath = extractFn ? pkgDir : dl.localPath;
            if (extractFn) {
              fs.rmSync(pkgDir, { recursive: true, force: true });
              fs.mkdirSync(pkgDir, { recursive: true });
              await extractFn(dl.localPath, pkgDir, { slug: skill.slug, version: skill.latestVersion, expectedFingerprint: detail.sha256 });
            }
            const result = await importFn({
              path: importPath,
              name: skill.slug,
              hubSourceId: "iflytek",
              commitHash: sha,
              namespaceSlug: namespaceSlug,
              hubVersion: skill.latestVersion,
            });
            resourceId = result.resourceId;
            imported.push(resourceId);
            onSync?.({ type: "import", slug: skill.slug, version: skill.latestVersion, resourceId, namespaceSlug, orgId });
            auditFn?.({ action: "skillhub.import", namespaceSlug, orgId, objectId: resourceId, result: "success", reason: "imported" });
            // 幂等 provenance = importFn 写入资源的 .hub-source.json marker (round-4/5),
            // 不再用 sidecar (已废弃)。
          }

          // entitlement 镜像(全新导入 + 已存在缺镜像 都要补): TEAM→org, GLOBAL→all active
          if (grantEntitlement && grantCtx) {
            try {
              const targets = nsType === "GLOBAL" ? (activeOrgIds ?? []) : [orgId];
              // 一次性提交完整 org-scope allow 集 — grantFn 实现负责 PUT/merge
              // 时不丢 unrelated 条目 (user-scope / 其他 org / deny)。
              const entries = targets.map((oid) => ({ scopeType: "org" as const, scopeId: oid, effect: "allow" as const }));
              await grantEntitlement(grantCtx, resourceId, entries);
              onSync?.({ type: "mirror", slug: skill.slug, resourceId, namespaceSlug, orgId });
              auditFn?.({ action: "skillhub.mirror", namespaceSlug, orgId, objectId: resourceId, result: "success", reason: `${targets.length} orgs` });
            } catch (err: any) {
              errors.push({ slug: skill.slug, reason: "entitlement mirror failed" });
              onSync?.({ type: "error", slug: skill.slug, namespaceSlug, orgId, reason: "mirror failed" });
              auditFn?.({ action: "skillhub.mirror_failed", namespaceSlug, orgId, objectId: resourceId, result: "failure", reason: "entitlement mirror failed" });
            }
          }
        } catch (err: any) {
          errors.push({ slug: skill.slug, reason: err?.message ?? String(err) });
          onSync?.({ type: "error", slug: skill.slug, namespaceSlug, orgId, reason: "import failed" });
          auditFn?.({ action: "skillhub.import_failed", namespaceSlug, orgId, objectId: skill.slug, result: "failure", reason: "import failed" });
        }
      }
      return { imported, skipped, errors };
    },
  };
}
