/**
 * PluginsPage.tsx — /admin/plugins (global resource pool).
 *
 * M6 residual UI closure (evt_20261023054637), Octop plugin-manager
 * interaction reference: card grid (default) + table view, error-first
 * status hierarchy, per-row enable toggle (valid non-user-submitted skills
 * only — user-submitted packages stay owned by the /admin/user-skills
 * approve flow), import moved into a dialog with scan-warning surfacing,
 * skeleton/empty/error states, and a responsive grid. UI-only: backend
 * contracts (installed/import/uninstall + skill enable/disable) unchanged.
 */
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { LayoutGrid, List, Plus, Trash2 } from "lucide-react";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, EmptyState, ErrorState, InfoNote, RefreshButton, StatusBadge } from "../components/ui";
import {
  pluginStatusMeta,
  pluginTypeMeta,
  isUserSubmitted,
  canToggleEnabled,
  toggleDisabledReason,
  toggleEndpoint,
  filterPlugins,
  pluginCounts,
  importWarnings,
  buildLedgerMap,
  submissionStatusFor,
  submissionStatusMeta,
  countPendingReview,
  type InstalledPlugin,
  type PluginTypeFilter,
  type PluginImportResponse,
  type SubmissionLedgerMap,
} from "../plugins-ui";

const API_BASE = "/api";

export function PluginsPage() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [filter, setFilter] = useState<PluginTypeFilter>("all");
  const [view, setView] = useState<"card" | "table">("card");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  // M7b submission ledger status by submissionId (fail-soft: empty on fetch
  // failure → provenance rows render neutral "用户提交", not pending).
  const [ledger, setLedger] = useState<SubmissionLedgerMap>(new Map());

  // Import dialog state
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importName, setImportName] = useState("");
  const [importCategory, setImportCategory] = useState<"auto" | "skill" | "hook-plugin">("auto");
  const [importEnabled, setImportEnabled] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string[]>([]);

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = filter !== "all" ? `?type=${filter}` : "";
      const [res, ledgerRes] = await Promise.all([
        fetch(`${API_BASE}/admin/plugins/installed${params}`, { headers: authHeaders() }),
        fetch(`${API_BASE}/admin/user-skills`, { headers: authHeaders() }).catch(() => null),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlugins(Array.isArray(data) ? data : []);
      if (ledgerRes && ledgerRes.ok) {
        const ledgerData = await ledgerRes.json().catch(() => null);
        setLedger(buildLedgerMap(Array.isArray(ledgerData?.submissions) ? ledgerData.submissions : []));
      } else {
        setLedger(new Map());
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchPlugins(); }, [fetchPlugins]);

  const handleImport = async () => {
    if (!importPath.trim() || !importName.trim()) return;
    setImporting(true);
    try {
      const body: Record<string, unknown> = {
        path: importPath.trim(),
        name: importName.trim(),
        enabled: importEnabled,
      };
      if (importCategory !== "auto") {
        body.registryCategory = importCategory;
      }
      const res = await fetch(`${API_BASE}/admin/plugins/import`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const result: PluginImportResponse = await res.json();
      toast.success(`Plugin "${result.resourceId}" v${result.version} 安装成功`);
      setImportNotice(importWarnings(result));
      setImportOpen(false);
      setImportPath("");
      setImportName("");
      await fetchPlugins();
    } catch (e: any) {
      toast.error(e.message || "安装失败");
    } finally {
      setImporting(false);
    }
  };

  const handleToggle = async (p: InstalledPlugin, enable: boolean) => {
    if (acting) return;
    setActing(p.name);
    try {
      const res = await fetch(toggleEndpoint(p, enable), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast.success(`「${p.name}」已${enable ? "启用" : "停用"}`);
      await fetchPlugins();
    } catch (e: any) {
      toast.error(e.message || "操作失败");
    } finally {
      setActing(null);
    }
  };

  const handleUninstall = async (p: InstalledPlugin) => {
    if (acting) return;
    if (!window.confirm(`卸载「${p.name}」？将从 skills/hook-plugins 注册表移除并删除安装目录。`)) return;
    setActing(p.name);
    try {
      const res = await fetch(`${API_BASE}/admin/plugins/uninstall`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: p.name, force: false }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast.success(`Plugin "${p.name}" 已卸载`);
      await fetchPlugins();
    } catch (e: any) {
      toast.error(e.message || "卸载失败");
    } finally {
      setActing(null);
    }
  };

  const filtered = filterPlugins(plugins, filter);
  const counts = pluginCounts(plugins);
  const pendingReview = countPendingReview(plugins, ledger);

  const renderToggle = (p: InstalledPlugin) => {
    const eligible = canToggleEnabled(p);
    const reason = toggleDisabledReason(p);
    return (
      <button
        type="button"
        role="switch"
        aria-checked={p.enabled}
        disabled={!eligible || acting === p.name}
        title={reason ?? (p.enabled ? "停用（仅对新 runtime 生效）" : "启用（全局平台开关）")}
        onClick={() => void handleToggle(p, !p.enabled)}
        data-testid={`toggle-${p.name}`}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          p.enabled ? "bg-emerald-500" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            p.enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    );
  };

  const renderUserSubmitted = (p: InstalledPlugin) => {
    if (!isUserSubmitted(p)) return null;
    const meta = submissionStatusMeta(submissionStatusFor(p, ledger));
    return (
      <StatusBadge tone={meta.tone} title="用户提交的技能包：启用与授权必须走「用户技能审核」的通过流程">
        {meta.label}
      </StatusBadge>
    );
  };

  const cardBody = (p: InstalledPlugin) => (
    <p
      className={`mt-1.5 text-xs leading-relaxed ${p.valid ? "text-ink-muted" : "text-red-600"}`}
      title={p.valid ? undefined : p.error}
    >
      {p.valid ? (p.description || "暂无描述") : `校验失败：${p.error ?? "未知错误"}`}
    </p>
  );

  return (
    <div>
      <AdminPageHeader
        title="Plugin 管理"
        description={`全局资源池：共 ${counts.total} 个（skill ${counts.skill} · hook-plugin ${counts.hookPlugin}）${counts.invalid > 0 ? `，${counts.invalid} 个校验未通过` : ""}${pendingReview > 0 ? `，${pendingReview} 个用户提交待审` : ""}`}
        actions={
          <>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as PluginTypeFilter)}
              className="text-xs border border-line-subtle rounded px-2 py-1 bg-white"
              aria-label="类型筛选"
            >
              <option value="all">全部</option>
              <option value="skill">Skill</option>
              <option value="hook-plugin">Hook Plugin</option>
            </select>
            <button
              onClick={() => setImportOpen(true)}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-brand hover:bg-brand-hover text-white rounded"
              data-testid="open-import"
            >
              <Plus className="w-3 h-3" /> 导入 Plugin
            </button>
            <div className="flex border border-line-subtle rounded overflow-hidden">
              <button
                onClick={() => setView("card")}
                title="卡片视图"
                className={`px-2 py-1 ${view === "card" ? "bg-gray-100 text-ink-primary" : "bg-white text-ink-muted hover:bg-gray-50"}`}
                data-testid="view-cards"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setView("table")}
                title="表格视图"
                className={`px-2 py-1 ${view === "table" ? "bg-gray-100 text-ink-primary" : "bg-white text-ink-muted hover:bg-gray-50"}`}
                data-testid="view-table"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
            <RefreshButton onClick={fetchPlugins} loading={loading} />
          </>
        }
      />

      <InfoNote title="这里是「全局资源池」">
        <div>安装 = 写入 <code>data/skills.json</code> / <code>hook-plugins.json</code>，<strong>全局可用</strong>。</div>
        <div>要限定某个 org / user 能否使用，去 <strong>能力资源</strong> 页编辑 entitlement。</div>
      </InfoNote>

      {importNotice.length > 0 && (
        <div
          className="mb-4 px-4 py-3 rounded-md border border-amber-200 bg-amber-50 text-sm text-amber-700"
          data-testid="import-warnings"
        >
          <div className="font-medium">安装完成，但扫描给出警告：</div>
          <ul className="mt-1 list-disc list-inside text-xs">
            {importNotice.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <button
            onClick={() => setImportNotice([])}
            className="mt-2 text-xs underline hover:text-amber-900"
          >
            知道了
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="plugins-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-lg border border-gray-200 bg-white animate-pulse" />
          ))}
        </div>
      ) : loadError ? (
        <div data-testid="plugins-error">
          <ErrorState title="Plugin 列表加载失败" hint="请检查后端服务后重试" onRetry={fetchPlugins} />
        </div>
      ) : filtered.length === 0 ? (
        <div data-testid="plugins-empty">
          <EmptyState
            icon="🧩"
            title={filter === "all" ? "暂无已安装的 plugin" : `暂无 ${filter === "skill" ? "Skill" : "Hook Plugin"}`}
            hint="点击右上角「导入 Plugin」从 import root 内的目录安装；安装后到「能力资源」页授权 org/user"
          />
        </div>
      ) : view === "card" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="plugins-list">
          {filtered.map((p) => {
            const status = pluginStatusMeta(p);
            const type = pluginTypeMeta(p);
            return (
              <article
                key={`${p.type}-${p.name}`}
                data-testid={`plugin-card-${p.name}`}
                className={`p-4 rounded-lg border bg-white flex flex-col ${
                  !p.valid ? "border-red-200" : "border-gray-200"
                } ${!p.enabled ? "opacity-75" : ""}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge tone={type.tone}>{type.label}</StatusBadge>
                  <span data-testid={`plugin-status-${p.name}`}>
                    <StatusBadge tone={status.tone} title={p.valid ? undefined : p.error}>
                      {status.label}
                    </StatusBadge>
                  </span>
                  {renderUserSubmitted(p)}
                  <span className="ml-auto font-mono text-[11px] text-gray-400">v{p.version}</span>
                </div>
                <p className="mt-1.5 font-medium text-sm text-ink-primary font-mono break-all" title={p.path}>
                  {p.name}
                </p>
                {cardBody(p)}
                <div className="mt-3 pt-3 border-t border-line-subtle flex items-center gap-2">
                  {renderToggle(p)}
                  <span className="text-[11px] text-gray-400">
                    {toggleDisabledReason(p) ?? (p.enabled ? "已启用" : "已停用")}
                  </span>
                  <button
                    onClick={() => void handleUninstall(p)}
                    disabled={acting === p.name}
                    className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 border border-red-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
                    data-testid={`uninstall-${p.name}`}
                  >
                    <Trash2 className="w-3 h-3" /> 卸载
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto" data-testid="plugins-table">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-3 py-2 font-medium border-b">名称</th>
                <th className="px-3 py-2 font-medium border-b">类型</th>
                <th className="px-3 py-2 font-medium border-b">版本</th>
                <th className="px-3 py-2 font-medium border-b">状态</th>
                <th className="px-3 py-2 font-medium border-b">描述 / 校验</th>
                <th className="px-3 py-2 font-medium border-b">启停</th>
                <th className="px-3 py-2 font-medium border-b">路径</th>
                <th className="px-3 py-2 font-medium border-b">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const status = pluginStatusMeta(p);
                const type = pluginTypeMeta(p);
                return (
                  <tr key={`${p.type}-${p.name}`} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono font-medium text-gray-700">{p.name}</td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={type.tone}>{type.label}</StatusBadge>
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-500">{p.version}</td>
                    <td className="px-3 py-2">
                      <span data-testid={`plugin-status-${p.name}`}>
                        <StatusBadge tone={status.tone} title={p.valid ? undefined : p.error}>
                          {status.label}
                        </StatusBadge>
                      </span>
                      {renderUserSubmitted(p)}
                    </td>
                    <td className={`px-3 py-2 max-w-[240px] truncate ${p.valid ? "text-gray-500" : "text-red-600"}`} title={p.valid ? p.description : p.error}>
                      {p.valid ? (p.description || "—") : `校验失败：${p.error ?? "未知"}`}
                    </td>
                    <td className="px-3 py-2">{renderToggle(p)}</td>
                    <td className="px-3 py-2 font-mono text-gray-400 max-w-[200px] truncate" title={p.path}>{p.path}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => void handleUninstall(p)}
                        disabled={acting === p.name}
                        className="text-xs px-2 py-0.5 border rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
                        data-testid={`uninstall-${p.name}`}
                      >
                        卸载
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Import dialog (single primary entry; keeps the list surface clean) */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" role="dialog" aria-label="导入 Plugin" data-testid="import-dialog">
          <div className="w-full max-w-md mx-4 p-5 rounded-lg bg-white shadow-lg">
            <p className="text-sm font-medium text-ink-primary">导入 Plugin</p>
            <p className="mt-1 text-xs text-ink-muted">
              源目录必须位于 import root（<code>data/skill-hub-cache</code>）内；名称全局唯一。安装后按类型写入注册表。
            </p>
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-xs text-ink-secondary mb-1">本地路径（import root 内）</label>
                <input
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                  placeholder="data/skill-hub-cache/..."
                  data-testid="import-path"
                  className="w-full px-3 h-9 text-sm border border-gray-200 rounded-md font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-ink-secondary mb-1">名称</label>
                <input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="my-plugin"
                  data-testid="import-name"
                  className="w-full px-3 h-9 text-sm border border-gray-200 rounded-md font-mono"
                />
              </div>
              <div className="flex items-end gap-4">
                <div>
                  <label className="block text-xs text-ink-secondary mb-1">类型</label>
                  <select
                    value={importCategory}
                    onChange={(e) => setImportCategory(e.target.value as "auto" | "skill" | "hook-plugin")}
                    data-testid="import-category"
                    className="px-3 h-9 text-sm border border-gray-200 rounded-md"
                  >
                    <option value="auto">自动检测</option>
                    <option value="skill">skill</option>
                    <option value="hook-plugin">hook-plugin</option>
                  </select>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-ink-secondary pb-2">
                  <input
                    type="checkbox"
                    checked={importEnabled}
                    onChange={(e) => setImportEnabled(e.target.checked)}
                    data-testid="import-enabled"
                  />
                  安装后启用
                </label>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setImportOpen(false)}
                className="px-3 h-9 text-xs border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => void handleImport()}
                disabled={!importPath.trim() || !importName.trim() || importing}
                className="px-3 h-9 text-xs bg-brand hover:bg-brand-hover text-white rounded-md disabled:opacity-50"
                data-testid="import-confirm"
              >
                {importing ? "安装中…" : "安装"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
