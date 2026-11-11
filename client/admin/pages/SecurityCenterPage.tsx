import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, FileLock, EyeOff, TerminalSquare, PackageSearch, ScrollText, Lock, Save, TriangleAlert } from "lucide-react";
import { AdminPageHeader, StatusBadge, EmptyState, ErrorState, RefreshButton } from "../components/ui";
import { SecurityAuditPanel } from "../components/SecurityAuditPanel";
import {
  POSTURE_TABS,
  TAB_LABELS,
  loadSecurityPosture,
  saveProfileTools,
  deriveToolDraft,
  setToolState,
  tightenBashToApproval,
  buildToolsConfigPayload,
  draftIsDirty,
  type PostureTab,
  type ProfileToolView,
  type SecurityPosture,
  type PostureSectionStatus,
  type ToolDraft,
  type ToolState,
} from "../security-center";

const TAB_ICONS: Record<PostureTab, React.ComponentType<{ className?: string }>> = {
  toolApproval: ShieldCheck,
  fileAccess: FileLock,
  sensitiveInfo: EyeOff,
  commandProtection: TerminalSquare,
  skillScan: PackageSearch,
  audit: ScrollText,
};

const STATUS_BADGE: Record<PostureSectionStatus, { tone: string; label: string }> = {
  enforced: { tone: "green", label: "已强制" },
  configurable: { tone: "blue", label: "可配置" },
  partial: { tone: "amber", label: "部分覆盖" },
  not_implemented: { tone: "gray", label: "未实现" },
};

const STATE_LABELS: Record<ToolState, string> = {
  allowed: "自动允许",
  approval: "需审批",
  disallowed: "禁用",
};

/**
 * M6b 安全防护中心 — 六页签治理入口（非新策略领域层）。
 *
 * 权威源在服务端：profile toolsConfig / workspace·path·MCP 守卫 /
 * 脱敏覆盖 / M3 scanner·quarantine / 治理审计。唯一写操作 = 可编辑 DB
 * profile 的工具三态（保存后仅对新 runtime 生效）。平台默认与硬守卫只读。
 */
export function SecurityCenterPage() {
  const [posture, setPosture] = useState<SecurityPosture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PostureTab>("toolApproval");

  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<ToolDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const savedProfileRef = useRef<string>("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await loadSecurityPosture();
      setPosture(data);
    } catch (e) {
      setError((e as Error).message);
      setPosture(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 工具审批：profile 选择 = platformDefault（只读）+ 可编辑 DB profiles。
  const toolCandidates = useMemo(() => {
    if (!posture) return [] as ProfileToolView[];
    return [posture.toolApproval.platformDefault, ...posture.toolApproval.profiles];
  }, [posture]);

  useEffect(() => {
    if (toolCandidates.length === 0) return;
    const current = toolCandidates.find((p) => p.profileId === selectedId);
    if (!current) {
      setSelectedId(toolCandidates[0].profileId);
      setDraft(deriveToolDraft(toolCandidates[0]));
      setSaveError(null);
    }
  }, [toolCandidates, selectedId]);

  const selected = useMemo(
    () => toolCandidates.find((p) => p.profileId === selectedId) ?? null,
    [toolCandidates, selectedId]
  );

  const dirty = selected ? (draft !== null && draftIsDirty(selected, draft)) : false;

  function selectProfile(profile: ProfileToolView) {
    if (saving) return; // 保存中禁止切换 profile（防并发覆盖）
    setSelectedId(profile.profileId);
    setDraft(deriveToolDraft(profile));
    setSaveError(null);
  }

  function changeState(tool: string, state: ToolState) {
    if (!selected || !selected.editable || !draft || saving) return;
    setDraft(setToolState(draft, tool, state));
    setSaveError(null);
  }

  async function save() {
    if (!selected || !draft || !selected.editable || saving) return;
    const payload = buildToolsConfigPayload(selected, draft);
    if (!payload) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveProfileTools(selected.profileId, payload);
      savedProfileRef.current = selected.profileId;
      setSavedNote(`已保存「${selected.name}」的工具策略 — 仅对新创建的 runtime 生效`);
      await refresh();
    } catch (e) {
      setSaveError((e as Error).message);
      // draft 保留，不回退为默认值
    } finally {
      setSaving(false);
    }
  }

  /** 命令防护页的一键收紧：Bash allowed → approval，直接保存。 */
  async function tightenBash(profile: ProfileToolView) {
    if (saving || !profile.editable) return;
    const current = toolCandidates.find((p) => p.profileId === profile.profileId);
    if (!current) return;
    const next = tightenBashToApproval(deriveToolDraft(current));
    const payload = buildToolsConfigPayload(current, next);
    if (!payload) return;
    setSelectedId(profile.profileId);
    setDraft(next);
    setSaving(true);
    setSaveError(null);
    try {
      await saveProfileTools(profile.profileId, payload);
      savedProfileRef.current = profile.profileId;
      setSavedNote(`已将「${profile.name}」的 Bash 收紧为需审批 — 仅对新 runtime 生效`);
      await refresh();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // 刷新后恢复选中 profile 的 draft（若已被删除则回落到第一项）。
  useEffect(() => {
    if (!posture || saving) return;
    const current = toolCandidates.find((p) => p.profileId === selectedId);
    if (current && savedProfileRef.current !== selectedId) return; // draft 正在编辑，不覆盖
    const target = current ?? toolCandidates[0];
    if (target) {
      setSelectedId(target.profileId);
      setDraft(deriveToolDraft(target));
    }
  }, [posture]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <div className="h-7 w-56 bg-gray-100 rounded animate-pulse mb-2" />
        <div className="h-4 w-96 bg-gray-50 rounded animate-pulse mb-6" />
        <div className="h-9 w-full bg-gray-50 rounded animate-pulse mb-4" />
        <div className="h-64 w-full bg-gray-50 rounded animate-pulse" />
      </div>
    );
  }

  if (error || !posture) {
    return (
      <div className="max-w-5xl mx-auto">
        <AdminPageHeader title="安全防护" description="统一安全态势与治理入口" />
        <ErrorState title="安全态势加载失败" hint={error ?? "未知错误"} onRetry={() => { void refresh(); }} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <AdminPageHeader
        title="安全防护"
        description="当前生效边界、工具策略与治理入口 — 平台默认与硬守卫只读；保存仅对新 runtime 生效"
        actions={<RefreshButton onClick={() => void refresh()} />}
      />

      {savedNote && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{savedNote}</span>
        </div>
      )}

      {/* 六页签：固定顺序，窄屏横向滚动 */}
      <div className="mb-5 -mx-1 px-1 overflow-x-auto">
        <div className="flex gap-1 min-w-max border-b border-line-subtle">
          {POSTURE_TABS.map((tab) => {
            const Icon = TAB_ICONS[tab];
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-1.5 px-3 h-9 text-sm whitespace-nowrap transition-colors border-b-2 ${
                  active
                    ? "border-brand text-brand font-medium"
                    : "border-transparent text-ink-secondary hover:text-ink-primary"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {TAB_LABELS[tab]}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === "toolApproval" && (
        <section>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <label className="text-sm text-ink-secondary shrink-0">Profile</label>
            <select
              value={selectedId}
              disabled={saving}
              onChange={(e) => {
                const p = toolCandidates.find((x) => x.profileId === e.target.value);
                if (p) selectProfile(p);
              }}
              className="border border-line-subtle rounded-md px-2 py-1.5 text-sm bg-white min-w-52"
            >
              {toolCandidates.map((p) => (
                <option key={p.profileId} value={p.profileId}>
                  {p.name}
                  {p.editable ? "" : "（平台默认 · 只读）"}
                </option>
              ))}
            </select>
            {selected && !selected.editable && (
              <StatusBadge tone="gray" title="平台默认 profile 不可编辑">
                <Lock className="w-3 h-3 mr-1" />只读
              </StatusBadge>
            )}
            {selected?.inheritsPlatformDefault && selected.editable && (
              <StatusBadge tone="indigo" title="未设置 toolsConfig，当前继承平台默认">继承默认</StatusBadge>
            )}
            <div className="ml-auto flex items-center gap-2">
              {dirty && <span className="text-xs text-amber-600">有未保存修改</span>}
              <button
                onClick={() => void save()}
                disabled={!dirty || saving || !selected?.editable}
                className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-sm font-medium bg-brand text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Save className="w-4 h-4" />
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>

          {saveError && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
              <span>保存失败：{saveError}（草稿已保留，可修正后重试）</span>
            </div>
          )}

          <div className="text-xs text-ink-muted mb-3">
            语义：禁用 = disallowedTools · 自动允许 = allowedTools · 需审批 = tools − allowedTools − disallowedTools
          </div>

          {selected && draft ? (
            <div className="border border-line-subtle rounded-md divide-y divide-line-subtle">
              {draft.order.map((tool) => {
                const state = draft.states[tool];
                const locked = !selected.editable || saving;
                return (
                  <div key={tool} className="flex items-center justify-between gap-4 px-4 py-2.5">
                    <div className="font-mono text-sm text-ink-primary min-w-0 truncate">{tool}</div>
                    <div className="flex shrink-0 rounded-md border border-line-subtle overflow-hidden">
                      {(["allowed", "approval", "disallowed"] as const).map((s) => (
                        <button
                          key={s}
                          disabled={locked}
                          onClick={() => changeState(tool, s)}
                          className={`px-2.5 h-7 text-xs transition-colors ${
                            state === s
                              ? s === "allowed"
                                ? "bg-green-100 text-green-700 font-medium"
                                : s === "approval"
                                  ? "bg-amber-100 text-amber-700 font-medium"
                                  : "bg-red-100 text-red-700 font-medium"
                              : "bg-white text-ink-muted hover:bg-gray-50"
                          } disabled:cursor-not-allowed disabled:opacity-60`}
                        >
                          {STATE_LABELS[s]}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="暂无可管理的 profile" hint="数据库 profile 会出现在这里" />
          )}
        </section>
      )}

      {activeTab === "fileAccess" && (
        <section className="border border-line-subtle rounded-md divide-y divide-line-subtle">
          {posture.fileAccess.areas.map((a) => (
            <div key={a.area} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm font-medium text-ink-primary">{a.area}</span>
                <StatusBadge tone={STATUS_BADGE.enforced.tone}>{STATUS_BADGE.enforced.label}</StatusBadge>
              </div>
              <div className="text-xs text-ink-secondary mb-1">
                边界：<span className="font-mono">{a.boundaries.join(" · ")}</span>
              </div>
              <div className="text-xs text-ink-muted">守卫：{a.guards.join(" · ")}</div>
            </div>
          ))}
          <div className="px-4 py-2 text-xs text-ink-muted">硬守卫（deny-default / 路径围栏 / MCP 前缀）不可由本页面放宽。</div>
        </section>
      )}

      {activeTab === "sensitiveInfo" && (
        <section className="border border-line-subtle rounded-md divide-y divide-line-subtle">
          <div className="px-4 py-2.5 flex items-center gap-2">
            <span className="text-sm font-medium text-ink-primary">整体状态</span>
            <StatusBadge tone={STATUS_BADGE[posture.sensitiveInfo.status].tone}>{STATUS_BADGE[posture.sensitiveInfo.status].label}</StatusBadge>
          </div>
          {posture.sensitiveInfo.coverage.map((c) => (
            <div key={c.area} className="px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm text-ink-primary">{c.area}</span>
                <StatusBadge tone={STATUS_BADGE[c.status].tone}>{STATUS_BADGE[c.status].label}</StatusBadge>
              </div>
              <div className="text-xs text-ink-muted">{c.detail}</div>
            </div>
          ))}
        </section>
      )}

      {activeTab === "commandProtection" && (
        <section>
          <div className="border border-line-subtle rounded-md divide-y divide-line-subtle mb-4">
            <div className="px-4 py-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-ink-primary mb-0.5">local runtime · Bash</div>
                <div className="text-xs text-ink-muted">任意命令无法做路径校验 — 本地运行时硬拒绝，无放宽入口</div>
              </div>
              <StatusBadge tone={STATUS_BADGE.enforced.tone}>{STATUS_BADGE.enforced.label}</StatusBadge>
            </div>
            <div className="px-4 py-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-ink-primary mb-0.5">docker runtime · Bash</div>
                <div className="text-xs text-ink-muted">取决于 profile 三态；需审批时走 PreToolUse 审批门</div>
              </div>
              <StatusBadge tone={STATUS_BADGE.configurable.tone}>{STATUS_BADGE.configurable.label}</StatusBadge>
            </div>
          </div>

          <div className="text-sm font-medium text-ink-primary mb-2">
            自动放行 Bash 的 profile（{posture.commandProtection.riskyProfiles.length}）
          </div>
          {posture.commandProtection.riskyProfiles.length === 0 ? (
            <EmptyState title="没有自动放行 Bash 的 profile" hint="所有可编辑 profile 的 Bash 均需审批或已禁用" />
          ) : (
            <div className="border border-line-subtle rounded-md divide-y divide-line-subtle">
              {posture.commandProtection.riskyProfiles.map((p) => {
                const view = toolCandidates.find((x) => x.profileId === p.profileId);
                // Completion is derived from the refreshed posture itself: a
                // tightened profile disappears from riskyProfiles. Never from
                // the last-saved marker — saving an unrelated tool change must
                // not disable the tighten button.
                return (
                  <div key={p.profileId} className="px-4 py-2.5 flex items-center justify-between gap-4">
                    <div className="text-sm text-ink-primary min-w-0 truncate">{p.name}</div>
                    <button
                      onClick={() => view && void tightenBash(view)}
                      disabled={saving || !view?.editable}
                      className="shrink-0 inline-flex items-center gap-1.5 px-3 h-7 rounded-md text-xs font-medium border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <TriangleAlert className="w-3.5 h-3.5" />
                      收紧为需审批
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === "skillScan" && (
        <section>
          <div className="flex flex-wrap gap-2 mb-4">
            <StatusBadge tone="blue">共 {posture.skillScan.counts.total}</StatusBadge>
            <StatusBadge tone="green">启用 {posture.skillScan.counts.enabled}</StatusBadge>
            <StatusBadge tone="gray">停用 {posture.skillScan.counts.disabled}</StatusBadge>
            <StatusBadge tone="amber">隔离待审 {posture.skillScan.counts.quarantined}</StatusBadge>
            <StatusBadge tone="red">含脚本 {posture.skillScan.counts.withScripts}</StatusBadge>
            <StatusBadge tone="purple">无效 {posture.skillScan.counts.invalid}</StatusBadge>
          </div>
          <div className="text-xs text-ink-muted mb-3">
            导入管道 fail-closed（无 off/warn/block 模式）：校验失败整包拒绝；导入后 enabled:false 隔离，启用仍受 entitlement/app allowlist/activation 守卫。
          </div>
          {posture.skillScan.packages.length === 0 ? (
            <EmptyState title="技能注册表为空" />
          ) : (
            <div className="border border-line-subtle rounded-md divide-y divide-line-subtle">
              {posture.skillScan.packages.map((p) => (
                <div key={p.name} className="px-4 py-2.5 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-ink-primary">{p.name}</span>
                  <StatusBadge tone={p.enabled ? "green" : "gray"}>{p.enabled ? "启用" : "停用"}</StatusBadge>
                  <StatusBadge tone="indigo">{p.sourceKind}</StatusBadge>
                  {p.hasScripts && <StatusBadge tone="red" title="包含 scripts/ — 启用前必须审查">含脚本</StatusBadge>}
                  {p.sha256 && <span className="text-xs text-ink-muted font-mono">{p.sha256.slice(0, 12)}</span>}
                  {!p.valid && <StatusBadge tone="amber" title="注册行解析失败（fail-closed，不可启用）">无效</StatusBadge>}
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 text-sm">
            <Link to="/admin/skills" className="text-brand hover:underline">前往 Skills 治理页处理隔离包 →</Link>
          </div>
        </section>
      )}

      {activeTab === "audit" && (
        <section>
          <SecurityAuditPanel />
        </section>
      )}
    </div>
  );
}
