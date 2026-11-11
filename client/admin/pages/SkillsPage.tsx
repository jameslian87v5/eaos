import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  SkillTable,
  authHeaders,
  type SkillView,
  type RuntimeView,
} from "../../components/AdminPanel";
import { AdminPageHeader, InfoNote, RefreshButton } from "../components/ui";

const API_BASE = "/api";
const MAX_SHOWN_FILES = 100;

// R1: role from server-issued user blob (set at login). org_admin sees the
// shared pool read-only + entitlement guidance; only admin gets the global
// toggle (isAdminReq server-side; UI just hides it).
function currentRole(): string {
  try { return (JSON.parse(localStorage.getItem("user") || "{}")).role ?? "user"; }
  catch { return "user"; }
}

interface ImportManifest {
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  sourceKind: string;
  copyPolicy: string;
  sha256: string;
  importedAt: string;
  fileCount: number;
  files: string[];
  hasScripts: boolean;
  license: string | null;
  description: string;
  warnings: string[];
  validationErrors: string[];
}

// Bounded, categorical error mapping (no raw error text beyond the code map).
function importErrorMessage(status: number, body: { error?: string; code?: string }): string {
  switch (body.code) {
    case "duplicate": return "同名 skill 已注册或 quarantine 目录已占用（409）——换一个 slug 或先卸载现有条目";
    case "registry_invalid": return "data/skills.json 损坏（registry_invalid）——导入已被拒绝且未改动注册文件，请先人工修复后再导入";
    case "invalid_slug": return "slug 不合法：仅小写字母/数字/连字符，≤64 字符";
    case "invalid_version": return "version 不合法：字母/数字/点/下划线/加号/连字符";
    case "empty_zip": return "未收到 ZIP 内容";
    case "zip_too_large": return "ZIP 超过 80MB 请求上限";
    case "extract_failed": return "ZIP 被拒收：损坏 / 路径穿越 / 绝对路径 / symlink / 超出文件数或大小边界";
    case "no_skill": return "包内没有 SKILL.md —— 不是技能包";
    case "multiple_skills": return "包内含多个技能——一次只允许导入一个";
    case "scan_failed": return "包扫描失败（文件数超限）";
    case "repackage_failed": return "重打包失败（包形态不合规）";
    case "invalid_plugin": return "安装后 native plugin 校验失败，已回滚";
    case "import_failed": return body.error?.slice(0, 200) || "导入失败";
    default: return `导入失败（HTTP ${status}${body.error ? `：${body.error.slice(0, 200)}` : ""}）`;
  }
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeView[]>([]);
  const isAdmin = currentRole() === "admin";

  // Import panel state (admin only).
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [slug, setSlug] = useState("");
  const [version, setVersion] = useState("");
  const [importing, setImporting] = useState(false);
  const [manifest, setManifest] = useState<ImportManifest | null>(null);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/skills`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills ?? []);
      }
    } catch {}
  }, []);

  // R1: /api/admin/containers is admin-only; org_admin must not call it (403 +
  // noise). Only fetch when admin.
  const fetchRuntimes = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`${API_BASE}/admin/containers`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRuntimes(data.runtimes ?? []);
      }
    } catch {}
  }, [isAdmin]);

  useEffect(() => { fetchSkills(); fetchRuntimes(); }, [fetchSkills, fetchRuntimes]);

  const handleImport = async () => {
    if (!zipFile) { toast.error("请选择 ZIP 文件"); return; }
    if (!slug.trim()) { toast.error("请填写 slug"); return; }
    setImporting(true);
    try {
      const q = new URLSearchParams({ slug: slug.trim() });
      if (version.trim()) q.set("version", version.trim());
      const res = await fetch(`${API_BASE}/admin/skills/import-zip?${q}`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/zip" },
        body: zipFile,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(importErrorMessage(res.status, body));
        return;
      }
      const m = body.manifest as ImportManifest;
      setManifest(m);
      toast.success(`已导入并隔离：${m.name}（enabled=false，需审查后启用）`);
      await fetchSkills();
    } catch {
      toast.error("导入请求失败（网络错误）");
    } finally {
      setImporting(false);
    }
  };

  const handleToggle = async (name: string, enabled: boolean): Promise<void> => {
    if (enabled) {
      // Confirmation must repeat the script warning AND "enabled ≠ authorized".
      // hasScripts is SERVER-provided (registry row) — never client state.
      const hasScripts = skills.find((s) => s.name === name)?.hasScripts === true;
      const scriptLine = hasScripts
        ? "⚠️ 该包包含 scripts/ 脚本——请确认已逐个审查其内容。\n"
        : "";
      if (!confirm(`${scriptLine}确认全局启用 ${name}？\n启用 ≠ 授权：agent 仍需经过 entitlement / app allowlist / activation 守卫才会拿到该 skill。`)) {
        return;
      }
    }
    const action = enabled ? "enable" : "disable";
    const res = await fetch(`${API_BASE}/admin/skills/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      toast.error(`Skill ${name} 操作失败 (HTTP ${res.status})`);
    } else {
      toast.success(`Skill ${name} ${enabled ? "已启用" : "已禁用"}`);
    }
    await fetchSkills();
  };

  return (
    <div>
      <AdminPageHeader
        title="Skill"
        description={`共 ${skills.length} 个 skill，${skills.filter((s) => s.enabled).length} 个已启用`}
        actions={<RefreshButton onClick={fetchSkills} />}
      />
      {isAdmin ? (
        <InfoNote title="Skill = 资源池里的全局开关">
          <div>此处启用/禁用 = 全局可用性（<code>data/skills.json</code>）；要按 org/user 控制访问，去 <strong>能力资源</strong> 页编辑 entitlement。</div>
          <div className="text-ink-muted">改动只对<strong>新</strong> runtime 生效；运行中的 runtime 需 Stop 后重新触发以加载新配置。</div>
        </InfoNote>
      ) : (
        <InfoNote title="本部门可用的 Skill（只读）">
          <div>这里列出平台已分发给本部门的 Skill。全局启停由企业管理员操作；如需为本部门启用/撤销某个 Skill，到 <strong>能力资源</strong> 页编辑 entitlement。</div>
        </InfoNote>
      )}

      {isAdmin && (
        <section className="mb-6" data-testid="skill-import-panel">
          <h3 className="text-sm font-semibold text-ink-primary mb-2">导入 ZIP（本地技能包）</h3>
          <div className="rounded-md border border-line-subtle bg-surface-card p-4 flex flex-wrap gap-3 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-muted">ZIP 文件（≤2000 文件 / ≤64MB）</span>
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                data-testid="skill-import-file"
                className="border border-line-subtle rounded px-2 py-1.5 text-sm bg-surface-page"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-muted">slug（安装名，必填）</span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="my-skill"
                data-testid="skill-import-slug"
                className="border border-line-subtle rounded px-2 py-1.5 text-sm w-48 bg-surface-page font-mono"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-ink-muted">version（可选，默认 1.0.0）</span>
              <input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
                data-testid="skill-import-version"
                className="border border-line-subtle rounded px-2 py-1.5 text-sm w-36 bg-surface-page font-mono"
              />
            </label>
            <button
              onClick={handleImport}
              disabled={importing}
              data-testid="skill-import-submit"
              className="rounded bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {importing ? "导入中…" : "导入并隔离"}
            </button>
          </div>

          {manifest && (
            <div className="mt-4 rounded-md border border-line-subtle bg-surface-card p-4" data-testid="skill-import-manifest">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-ink-primary">导入审查清单 · {manifest.name}</span>
                <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-gray-100 text-gray-500" data-testid="manifest-source-kind">{manifest.sourceKind}</span>
                <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-yellow-50 text-yellow-700 border border-yellow-200" data-testid="manifest-quarantine">
                  已隔离（enabled=false，装了 ≠ 可用）
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-muted mb-2">
                <div>版本：<span className="font-mono text-ink-primary">{manifest.version}</span></div>
                <div>文件：<span className="font-mono text-ink-primary" data-testid="manifest-file-count">{manifest.fileCount} 个</span></div>
                <div>许可证：<span className="font-mono text-ink-primary">{manifest.license ?? "—"}</span></div>
                <div>导入时间：<span className="font-mono text-ink-primary">{manifest.importedAt}</span></div>
                <div className="col-span-2 font-mono break-all" title={manifest.sha256}>hash：{manifest.sha256}</div>
                <div className="col-span-2" title={manifest.path}>路径：<span className="font-mono">{manifest.path}</span></div>
                <div className="col-span-2">描述：{manifest.description}</div>
              </div>
              {manifest.hasScripts && (
                <div className="mb-2 text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2" data-testid="manifest-script-warning">
                  ⚠️ 包含 scripts/ 脚本（{manifest.warnings.join("；")}）——启用前必须逐个审查。
                </div>
              )}
              <details>
                <summary className="text-xs text-ink-muted cursor-pointer">
                  文件清单（{Math.min(manifest.files.length, MAX_SHOWN_FILES)} / {manifest.fileCount} total）
                </summary>
                <ul className="mt-1 max-h-48 overflow-y-auto text-[11px] font-mono text-ink-muted" data-testid="manifest-file-list">
                  {manifest.files.slice(0, MAX_SHOWN_FILES).map((f) => <li key={f}>{f}</li>)}
                </ul>
                {manifest.files.length > MAX_SHOWN_FILES && (
                  <div className="text-[11px] text-ink-muted mt-1">… 共 {manifest.fileCount} 个文件，仅显示前 {MAX_SHOWN_FILES} 个。</div>
                )}
              </details>
            </div>
          )}
        </section>
      )}

      <SkillTable skills={skills} runtimes={runtimes} onToggle={isAdmin ? handleToggle : undefined} />
    </div>
  );
}
