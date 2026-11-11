/**
 * ExpertEditDrawer.tsx — Octop absorption M7a: the own-agent edit drawer.
 *
 * Edits the three M7a fields (name / welcomeMessage / quickPrompts) via
 * PATCH /api/agents/:id, and the capability activation via PUT
 * /api/agents/:id/capabilities. The capability CHECKBOX list is display-only
 * intent: options come from /api/agent-builder/options (the server-computed
 * entitlement ∩ app-allowlist upper bound) and the effective set after save is
 * what the server recomputed — not what the client asked for. Saving shows the
 * honest runtime semantics: changes apply to NEW runtimes only.
 *
 * templateId is displayed read-only (creation provenance). On failure the
 * draft is kept so the user can retry without losing edits.
 */
import { useEffect, useMemo, useState } from "react";
import { X, Check, Plus, Trash2, Save, AlertCircle } from "lucide-react";
import {
  deriveExpertDraft,
  isDraftDirty,
  validateExpertDraft,
  buildEditPayload,
  addQuickPrompt,
  updateQuickPrompt,
  removeQuickPrompt,
  buildCapabilityDiff,
  templateDisplayName,
  type ExpertRow,
  type ExpertDraft,
  type CapabilityOption,
  type CapabilityState,
} from "./expert-directory";

const API_BASE = "/api";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ExpertEditDrawerProps {
  open: boolean;
  agent: ExpertRow | null;
  capabilityOptions: CapabilityOption[];
  onClose: () => void;
  onSaved: () => void;
}

interface LoadedCaps {
  current: CapabilityState[];
  checked: string[];
}

export function ExpertEditDrawer({
  open,
  agent,
  capabilityOptions,
  onClose,
  onSaved,
}: ExpertEditDrawerProps) {
  const [draft, setDraft] = useState<ExpertDraft | null>(null);
  const [caps, setCaps] = useState<LoadedCaps | null>(null);
  const [capsDirty, setCapsDirty] = useState(false);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Load everything fresh each time the drawer opens (entitlements drift).
  useEffect(() => {
    if (!open || !agent) return;
    setLoadError(null);
    setSaveError(null);
    setSavedNote(null);
    setCapsDirty(false);
    setDraft(deriveExpertDraft(agent));
    setCaps(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/agents/${agent.id}/capabilities`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list: CapabilityState[] = Array.isArray(data.capabilities)
          ? (data.capabilities as Array<CapabilityState & { enabled: boolean }>).map((c) => ({
              resourceId: c.resourceId,
              name: c.name,
              enabled: c.enabled,
            }))
          : [];
        if (!cancelled) setCaps({ current: list, checked: list.filter((c) => c.enabled).map((c) => c.resourceId) });
      } catch {
        if (!cancelled) setLoadError("加载能力配置失败，请稍后重试");
      }
    })();
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/agent-builder/options`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.templates)) setTemplates(data.templates);
      } catch {
        /* template names are cosmetic; fallback shows 自定义 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agent]);

  const validation = useMemo(() => (draft ? validateExpertDraft(draft) : null), [draft]);
  const dirty = useMemo(
    () => (agent && draft ? isDraftDirty(agent, draft) : false) || capsDirty,
    [agent, draft, capsDirty]
  );

  if (!open || !agent) return null;

  const toggleCap = (id: string) => {
    setCapsDirty(true);
    setCaps((c) =>
      c
        ? {
            ...c,
            checked: c.checked.includes(id) ? c.checked.filter((x) => x !== id) : [...c.checked, id],
          }
        : c
    );
  };

  const save = async () => {
    if (!draft || validation || saving) return;
    setSaving(true);
    setSaveError(null);
    setSavedNote(null);
    try {
      // Step 1: the three edit fields (strict whitelist payload).
      if (isDraftDirty(agent, draft)) {
        const res = await fetch(`${API_BASE}/agents/${agent.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify(buildEditPayload(draft)),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setSaveError(body?.error || `保存失败（${res.status}）`);
          return;
        }
      }
      // Step 2: capability flips (only the diff; server recomputes authority).
      if (capsDirty && caps) {
        const diff = buildCapabilityDiff(caps.current, caps.checked, capabilityOptions);
        if (diff.resources.length > 0) {
          const res = await fetch(`${API_BASE}/agents/${agent.id}/capabilities`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify(diff),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setSaveError(body?.error || `能力保存失败（${res.status}）`);
            return;
          }
          // The response is the server-recomputed effective set — adopt it.
          const data = await res.json().catch(() => ({}));
          if (Array.isArray(data.capabilities)) {
            const list = (data.capabilities as Array<CapabilityState & { enabled: boolean }>).map((c) => ({
              resourceId: c.resourceId,
              name: c.name,
              enabled: c.enabled,
            }));
            setCaps({ current: list, checked: list.filter((c) => c.enabled).map((c) => c.resourceId) });
          }
        }
      }
      setCapsDirty(false);
      setSavedNote("已保存。编辑与能力变更仅对新会话（新 runtime）生效。");
      onSaved();
    } catch {
      setSaveError("网络错误，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-label="编辑专家">
      <div className="w-full max-w-xl h-full bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-semibold text-gray-800">编辑专家</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {agent.title} · 来源模板 {templateDisplayName(agent.templateId, templates)}（不可更改）
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {loadError && (
            <div className="px-3 py-2 rounded-md border border-red-200 bg-red-50 text-sm text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {loadError}
            </div>
          )}

          {draft && (
            <>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">名称</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={64}
                  data-testid="edit-name"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">
                  欢迎语 <span className="text-gray-400">（首次进入空会话时显示）</span>
                </label>
                <textarea
                  value={draft.welcomeMessage}
                  onChange={(e) => setDraft({ ...draft, welcomeMessage: e.target.value })}
                  rows={2}
                  maxLength={1000}
                  data-testid="edit-welcome"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-brand resize-y"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-ink-secondary">
                    快捷任务 <span className="text-gray-400">（点击填入输入框，不会自动发送）</span>
                  </label>
                  {draft.quickPrompts.length < 6 && (
                    <button
                      onClick={() => setDraft({ ...draft, quickPrompts: addQuickPrompt(draft.quickPrompts) })}
                      className="text-xs text-brand hover:underline flex items-center gap-0.5"
                    >
                      <Plus className="w-3 h-3" /> 添加
                    </button>
                  )}
                </div>
                <div className="space-y-2" data-testid="edit-quick-prompts">
                  {draft.quickPrompts.map((q, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <input
                        value={q.title}
                        onChange={(e) =>
                          setDraft({ ...draft, quickPrompts: updateQuickPrompt(draft.quickPrompts, i, { title: e.target.value }) })
                        }
                        maxLength={50}
                        placeholder="标题"
                        className="w-32 px-2.5 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-brand"
                      />
                      <input
                        value={q.prompt}
                        onChange={(e) =>
                          setDraft({ ...draft, quickPrompts: updateQuickPrompt(draft.quickPrompts, i, { prompt: e.target.value }) })
                        }
                        maxLength={500}
                        placeholder="点击后填入输入框的内容"
                        className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-brand"
                      />
                      <button
                        onClick={() => setDraft({ ...draft, quickPrompts: removeQuickPrompt(draft.quickPrompts, i) })}
                        className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-gray-100"
                        aria-label="删除快捷任务"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {draft.quickPrompts.length === 0 && (
                    <p className="text-xs text-gray-400">无快捷任务（可留空）</p>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Capability checkboxes — display-only intent over the server bound */}
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1">能力</label>
            <p className="text-xs text-gray-400 mb-2">
              只有你的账号已授权且当前应用允许的能力会出现在这里；保存后以服务端核验结果为准。
            </p>
            {caps === null && !loadError && <p className="text-xs text-gray-400">加载能力中…</p>}
            {caps && capabilityOptions.length === 0 && (
              <p className="text-sm text-gray-400 py-4 text-center">当前没有可挂载的能力。</p>
            )}
            {caps && capabilityOptions.length > 0 && (
              <div className="space-y-2" data-testid="edit-capabilities">
                {capabilityOptions.map((c) => {
                  const known = caps.current.find((x) => x.resourceId === c.resourceId);
                  const checked = caps.checked.includes(c.resourceId);
                  return (
                    <button
                      key={c.resourceId}
                      onClick={() => toggleCap(c.resourceId)}
                      data-testid={`cap-${c.resourceId}`}
                      className={`w-full flex items-center gap-3 text-left px-3.5 py-3 border rounded-lg transition-colors ${
                        checked ? "border-brand bg-brand-soft" : "border-gray-200 hover:border-gray-300 bg-white"
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          checked ? "bg-brand border-brand" : "border-gray-300"
                        }`}
                      >
                        {checked && <Check className="w-3 h-3 text-white" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm text-ink-primary">
                          {c.name}
                          <span className="ml-1.5 text-[10px] text-gray-400 uppercase">{c.type}</span>
                        </span>
                        {c.description && (
                          <span className="block text-xs text-gray-400 truncate">{c.description}</span>
                        )}
                      </span>
                      {known?.enabled && !checked && (
                        <span className="ml-auto text-[10px] text-amber-600 shrink-0">将停用</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs min-w-0 flex-1 space-y-0.5">
            {saveError && <p className="text-red-600">{saveError}</p>}
            {validation && <p className="text-red-600">{validation}</p>}
            {savedNote && <p className="text-emerald-600">{savedNote}</p>}
            {!saveError && !validation && !savedNote && dirty && (
              <p className="text-amber-600">有未保存的修改</p>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 h-9 text-sm border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              关闭
            </button>
            <button
              onClick={save}
              disabled={saving || !!validation || !dirty}
              data-testid="edit-save"
              className="px-4 h-9 text-sm bg-brand hover:bg-brand-hover text-white rounded-md disabled:opacity-50 flex items-center gap-1.5"
            >
              <Save className="w-4 h-4" /> {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
