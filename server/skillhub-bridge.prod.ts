/**
 * skillhub-bridge.prod.ts — 生产装配 + 手动触发(CLI)。
 *
 * 接线: createSkillhubClient + importNativePlugin + entitlementService +
 *   orgService.list(active) + writeGovernanceAudit + 缓存 sidecar 幂等查询。
 *
 * 安全禁用: SKILLHUB_URL 或 SKILLHUB_TOKEN 未配 → runSyncOnce 返回空 no-op,
 *   不建 client、不下载、不镜像、不审计(无事实可记)。
 *
 * 不含: Hub UI / 部署 / 成员映射 / Runtime E2E / MCP 设计 (均 R5b+)。
 *
 * CLI: npx tsx server/skillhub-bridge.prod.ts   (读 SKILLHUB_SYNC_TARGETS=
 *   "ns=orgId,ns2=orgId2" 逐个同步); 也可被未来的 admin 路由 import runSyncOnce。
 */
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { createSkillhubClient } from "./skillhub-client.js";
import {
  createSyncBridge,
  type AuditEvent,
  type EntitlementGrantCtx,
  type ExistingResource,
  type SyncResult,
} from "./skillhub-bridge.js";
import { importNativePlugin, listInstalledPlugins, PLUGINS_ROOT } from "./capability-installer.js";
import { extractZip, computeContentFingerprint } from "./skillhub-zip-extract.js";
import { repackageToNativePlugin } from "./skillhub-repackage.js";
import { entitlementService } from "./entitlement.js";
import { orgService } from "./org-service.js";
import { writeGovernanceAudit } from "./org-governance.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";
import { resolveTeamSyncTargets } from "./skillhub-sync-targets.js";

const CACHE_ROOT = path.resolve(process.cwd(), "data", "skill-hub-cache");
const SYSTEM_CTX: RequestContext = { userId: "system", role: "admin", orgId: DEFAULT_ORG_ID };
const GRANT_CTX: EntitlementGrantCtx = { userId: "system", role: "admin", orgId: "" };

/** 幂等查源 (codex R5a round-4): 读安装资源内的 .hub-source.json marker,
 *  验证 source=iflytek + ns/version 匹配; 不匹配或缺失 → null (本地装/已卸载/
 *  源不同) → 全新导入 → 名字冲突则 importNativePlugin 抛错 fail-closed, 不镜像。
 *  绝不靠 name-only 匹配授权 (marker 随资源走, uninstall rmSync 自然清, 本地
 *  重装不写 marker)。 */
function lookupExisting(
  pluginsRoot: string,
): (ns: string, slug: string, version: string, _sha: string | null) => Promise<ExistingResource | null> {
  return async (ns: string, slug: string, version: string) => {
    const markerPath = path.join(pluginsRoot, slug, ".hub-source.json");
    if (!fs.existsSync(markerPath)) return null; // 非 Hub 源 (本地装/已卸载) → fail-closed
    let marker: { hubSourceId?: string; namespaceSlug?: string | null; version?: string; sha?: string | null };
    try {
      marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    } catch {
      return null; // marker 损坏 → fail-closed
    }
    if (marker.hubSourceId !== "iflytek") return null; // 非 iflytek 源
    if (marker.namespaceSlug !== ns) return null; // 不同 namespace 的同名 → 不同资源
    if (marker.version !== version) return null; // 版本不匹配 → 重新导入/drift 由桥接判
    return { resourceId: slug, sha: marker.sha ?? null };
  };
}

// listInstalledPlugins 仍保留供未来 isSkillInstalled 探针 (当前 lookupExisting
// 不再依赖 name-only installed 探针 — marker 即源身份)。
void listInstalledPlugins;

function grantEntitlement(
  ctx: EntitlementGrantCtx,
  resourceId: string,
  entries: Array<{ scopeType: "org"; scopeId: string; effect: "allow" }>,
): Promise<void> {
  // Merge, not blind PUT, with deny-wins precedence (codex R5a round-3):
  //  - setEntitlements is full-PUT per resourceId; 逐 org 调用会互相覆盖 (round-2 bug)。
  //  - hub mirror 只能「补/刷新」org-scope allow, 不能擦除 admin 手动 tightening
  //    (org-scope deny)。§7.2: admin manual tightening overrides mirror; deny-wins。
  //  规则:
  //   - incoming keys (hub 想设 allow 的 org):
  //     * 既有 deny → 保留 deny (deny-wins), 不追加 allow。
  //     * 既有 allow 或无既有 → 设为 allow。
  //   - 非 incoming keys (含 user-scope / 其他 org / deny) → 原样保留。
  const reqCtx: RequestContext = { userId: ctx.userId, role: ctx.role, orgId: ctx.orgId || DEFAULT_ORG_ID };
  const existing = entitlementService.listEntries(resourceId);
  const incomingKeys = new Set(entries.map((e) => `${e.scopeType}:${e.scopeId}`));
  const deniedKeys = new Set(
    existing
      .filter((e) => e.effect === "deny" && incomingKeys.has(`${e.scopeType}:${e.scopeId}`))
      .map((e) => `${e.scopeType}:${e.scopeId}`),
  );
  const preserved = existing
    .filter((e) => {
      const k = `${e.scopeType}:${e.scopeId}`;
      if (!incomingKeys.has(k)) return true; // 非 incoming → 原样保留
      return e.effect === "deny"; // incoming key: 只保留 deny (deny-wins); allow 会被 incoming 覆盖
    })
    .map((e) => ({ scopeType: e.scopeType, scopeId: e.scopeId, effect: e.effect }));
  const appended = entries.filter((e) => !deniedKeys.has(`${e.scopeType}:${e.scopeId}`));
  const merged = [...preserved, ...appended];
  entitlementService.setEntitlements(reqCtx, resourceId, merged);
  return Promise.resolve();
}

function auditFn(e: AuditEvent): void {
  // metadata-only: actor/org/action/object/result/reason; 无 token/body/payload。
  writeGovernanceAudit({
    actorUserId: "system",
    actorRole: "system",
    orgId: e.orgId || DEFAULT_ORG_ID,
    action: e.action,
    objectType: "skill",
    objectId: e.objectId,
    result: e.result,
    reasonSummary: e.reason,
  });
}

export interface RunSyncOverrides {
  client?: ReturnType<typeof createSkillhubClient>;
  importFn?: typeof importNativePlugin;
  activeOrgIds?: string[];
  cacheRoot?: string;
  /** 覆盖 plugins/ 根目录 (测试用 temp dir 控制 .hub-source.json marker)。 */
  pluginsRoot?: string;
  /** 覆盖解包器 (测试用 fake; 生产默认 fail-closed, 见下)。 */
  extractFn?: (artifactPath: string, destDir: string, meta: { slug: string; version: string; expectedFingerprint?: string | null }) => Promise<void>;
}

/**
 * 同步一个 namespace → org(TEAM) 或 all active orgs(GLOBAL)。
 * SKILLHUB_URL / SKILLHUB_TOKEN 未配 → 返回空 no-op, 不 mutate。
 */
export async function runSyncOnce(
  namespaceSlug: string,
  orgId: string,
  overrides?: RunSyncOverrides,
): Promise<SyncResult> {
  const baseUrl = process.env.SKILLHUB_URL ?? "";
  const token = process.env.SKILLHUB_TOKEN ?? "";
  if (!baseUrl || !token) {
    // 安全禁用: 无 Hub 配置 → no-op, 不建 client、不下载、不镜像。
    return { imported: [], skipped: [], errors: [] };
  }
  const cacheRoot = overrides?.cacheRoot ?? CACHE_ROOT;
  const pluginsRoot = overrides?.pluginsRoot ?? PLUGINS_ROOT;
  const client = overrides?.client ?? createSkillhubClient({ baseUrl, token });
  // importNativePlugin 是同步的; 桥接期望 Promise → 包一层 async 适配器。
  const importFn = overrides?.importFn
    ? async (req: Parameters<typeof importNativePlugin>[0]) => overrides!.importFn!(req)
    : async (req: Parameters<typeof importNativePlugin>[0]) => importNativePlugin(req);
  const activeOrgIds = overrides?.activeOrgIds ?? orgService.list().filter((o) => o.status === "active").map((o) => o.id);
  const bridge = createSyncBridge({
    client,
    importFn,
    cacheRoot,
    grantEntitlement,
    grantCtx: GRANT_CTX,
    activeOrgIds,
    auditFn,
    lookupExisting: lookupExisting(pluginsRoot),
    // R5b-2: real bounded-safe extract + content-fingerprint verify + repackage.
    // The Hub delivers skills as ZIP (application/zip) with a top-level
    // SKILL.md + npm package.json — NOT native-plugin shape. extractZip
    // (bounded-safe, rejects traversal/abs/symlink/zip-bomb/corruption + cleanup)
    // → computeContentFingerprint (VERIFIED upstream SkillQueryService algorithm:
    // sort files by rel POSIX path, <path>:<bareHexSha>\n, sha256:hex) compared
    // to meta.expectedFingerprint (resolve data.fingerprint) — deny-wins on
    // mismatch (the fingerprint is the CONTENT hash, NOT the ZIP-archive hash, so
    // this is the correct tamper/corruption check). → repackageToNativePlugin
    // (synthesize .claude-plugin/plugin.json from TRUSTED slug/version, move all
    // extracted files under skills/<slug>/, reject missing SKILL.md).
    // importNativePlugin then validates the synthesized package unchanged.
    // meta carries the trusted slug/version + expectedFingerprint. Overrides win.
    // On any failure both extractDir + pkgDir are removed (no half-package).
    extractFn: overrides?.extractFn ?? (async (artifactPath: string, destDir: string, meta: { slug: string; version: string; expectedFingerprint?: string | null }) => {
      const extractDir = path.join(path.dirname(destDir), "extract");
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        extractZip(artifactPath, extractDir);
        // Content-fingerprint integrity (R5b-2 deny-wins): missing or malformed
        // values are contract drift and must reject, never bypass verification.
        // fingerprint is the CONTENT hash (sort files by path, <path>:<sha>\n),
        // NOT the ZIP-archive hash — so this compares extracted content to the
        // Hub-published fingerprint. Mismatch = tamper/corruption → reject.
        if (!/^sha256:[a-f0-9]{64}$/.test(meta.expectedFingerprint ?? "")) {
          throw new Error("missing or malformed content fingerprint");
        }
        const actual = computeContentFingerprint(extractDir);
        if (actual !== meta.expectedFingerprint) {
          throw new Error(`content fingerprint mismatch: expected ${meta.expectedFingerprint} got ${actual}`);
        }
        repackageToNativePlugin(extractDir, destDir, { slug: meta.slug, version: meta.version });
      } finally {
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      }
    }),
  });
  return bridge.syncNamespace(namespaceSlug, orgId);
}

async function main(): Promise<void> {
  // R5a mapping-first (codex review #1): TEAM sync targets resolve from the
  // persistent org_namespace_mappings table FIRST; SKILLHUB_SYNC_TARGETS is
  // parsed only as the audited emergency fallback. Env override attempts are
  // ignored + audited (mapping wins). Frozen mappings are excluded by the
  // resolver (TEAM sync pauses while the org is suspended).
  const envTargets = (process.env.SKILLHUB_SYNC_TARGETS ?? "")
    .split(",")
    .filter(Boolean)
    .map((t) => {
      const [ns, orgId] = t.split("=");
      return { namespaceSlug: ns, orgId };
    });
  const targets = resolveTeamSyncTargets({
    envTargets,
    audit: (action) => auditFn({
      action: action as AuditEvent["action"],
      namespaceSlug: "", orgId: DEFAULT_ORG_ID, objectId: "sync-targets",
      result: "success", reason: action,
    }),
  });
  if (targets.length === 0) {
    console.log("No TEAM sync targets (no active org→namespace mappings and no SKILLHUB_SYNC_TARGETS fallback); nothing to sync.");
    return;
  }
  const baseUrl = process.env.SKILLHUB_URL ?? "";
  const token = process.env.SKILLHUB_TOKEN ?? "";
  if (!baseUrl || !token) {
    console.log("SKILLHUB_URL / SKILLHUB_TOKEN 未配置 → sync disabled (no-op).");
    return;
  }
  for (const { namespaceSlug: ns, orgId } of targets) {
    const r = await runSyncOnce(ns, orgId);
    console.log(`[${ns}→${orgId}] imported=${r.imported.length} skipped=${r.skipped.length} errors=${r.errors.length}`);
    for (const e of r.errors) console.log(`  ! ${e.slug}: ${e.reason}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((e) => { console.error(e); process.exit(1); });
}
