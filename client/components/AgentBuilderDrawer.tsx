/**
 * AgentBuilderDrawer.tsx — Octop absorption M6a: the three-step expert
 * creation drawer (模板 → 基本信息 → 能力选择).
 *
 * The drawer is pure UX over the governed server contract
 * (GET /api/agent-builder/options + POST /api/agent-builder). Options are
 * fetched from the server — the client never invents templates or
 * capabilities, and the server re-validates the whole create regardless.
 * Creating succeeds exactly once per click (submitting state is guarded),
 * then onCreated hands the new Agent back to the workbench.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  FileText,
  PenLine,
  ListTodo,
  X,
  Check,
  Plus,
  Trash2,
} from "lucide-react";
import {
  initDraftFromTemplate,
  validateDraft,
  buildCreatePayload,
  type AgentDraft,
  type BuilderTemplate,
  type BuilderCapabilityOption,
} from "./agent-builder";

const API_BASE = "/api";
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const TEMPLATE_ICONS: Record<string, typeof Sparkles> = {
  Sparkles,
  FileText,
  PenLine,
  ListTodo,
};

const TEMPLATE_COLORS: Record<string, string> = {
  gray: "bg-gray-100 text-gray-600 border-gray-200",
  blue: "bg-blue-50 text-blue-600 border-blue-200",
  green: "bg-green-50 text-green-600 border-green-200",
  purple: "bg-purple-50 text-purple-600 border-purple-200",
};

interface AgentBuilderDrawerProps {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: { id: string; title: string }) => void;
}

const STEPS = ["选择模板", "基本信息", "能力"] as const;

export function AgentBuilderDrawer({ open, onClose, onCreated }: AgentBuilderDrawerProps) {
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState<BuilderTemplate[]>([]);
  const [capabilities, setCapabilities] = useState<BuilderCapabilityOption[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<BuilderTemplate | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Fix-round idempotency: one request id per submission attempt-series; a
  // network-error retry REUSES it so the server replays the same agent
  // instead of creating a duplicate. Reset when the drawer reopens.
  const requestIdRef = useRef<string | null>(null);

  // Fetch governed options every time the drawer opens (entitlement can change).
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setSelectedTemplate(null);
    setDraft(null);
    setSelectedCaps([]);
    setSubmitError(null);
    setLoadError(null);
    requestIdRef.current = null;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/agent-builder/options`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setTemplates(Array.isArray(data.templates) ? data.templates : []);
        setCapabilities(Array.isArray(data.capabilities) ? data.capabilities : []);
      } catch {
        setLoadError("加载模板与能力失败，请稍后重试");
      }
    })();
  }, [open]);

  const validation = useMemo(() => (draft ? validateDraft(draft) : null), [draft]);

  if (!open) return null;

  const pickTemplate = (t: BuilderTemplate) => {
    setSelectedTemplate(t);
    setDraft(initDraftFromTemplate(t));
    setStep(1);
  };

  const updateDraft = (patch: Partial<AgentDraft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const addQuickPrompt = () => {
    setDraft((d) => (d ? { ...d, quickPrompts: [...d.quickPrompts, { title: "", prompt: "" }] } : d));
  };

  const updateQuickPrompt = (i: number, patch: Partial<{ title: string; prompt: string }>) => {
    setDraft((d) =>
      d ? { ...d, quickPrompts: d.quickPrompts.map((q, j) => (j === i ? { ...q, ...patch } : q)) } : d
    );
  };

  const removeQuickPrompt = (i: number) => {
    setDraft((d) => (d ? { ...d, quickPrompts: d.quickPrompts.filter((_, j) => j !== i) } : d));
  };

  const toggleCap = (id: string) => {
    setSelectedCaps((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!draft || validation || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (!requestIdRef.current) {
        requestIdRef.current =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
      const payload = buildCreatePayload(
        draft,
        capabilities.map((c) => c.resourceId),
        selectedCaps,
        requestIdRef.current
      );
      const res = await fetch(`${API_BASE}/agent-builder`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(body?.error || `创建失败（${res.status}）`);
        return;
      }
      onCreated({ id: body.agent.id, title: body.agent.title });
    } catch {
      setSubmitError("网络错误，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-label="创建 Agent">
      <div className="w-full max-w-xl h-full bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-semibold text-gray-800">创建 Agent</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {STEPS[step]}
              {selectedTemplate ? ` · ${selectedTemplate.name}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Progress steps */}
        <div className="px-5 pt-3 shrink-0">
          <div className="flex items-center gap-1.5">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-1.5 flex-1 last:flex-none">
                <span
                  className={`w-5 h-5 rounded-full text-[10px] flex items-center justify-center font-medium ${
                    i < step ? "bg-brand text-white" : i === step ? "bg-brand text-white" : "bg-gray-200 text-gray-500"
                  }`}
                >
                  {i < step ? <Check className="w-3 h-3" /> : i + 1}
                </span>
                <span className={`text-xs ${i === step ? "text-ink-primary font-medium" : "text-gray-400"}`}>{label}</span>
                {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-200" />}
              </div>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          {loadError && <p className="text-sm text-red-600">{loadError}</p>}

          {/* Step 1: template catalog */}
          {step === 0 && !loadError && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {templates.map((t) => {
                const Icon = TEMPLATE_ICONS[t.icon] ?? Sparkles;
                const colorCls = TEMPLATE_COLORS[t.color] ?? TEMPLATE_COLORS.gray;
                return (
                  <button
                    key={t.id}
                    onClick={() => pickTemplate(t)}
                    className="text-left p-4 border border-gray-200 rounded-lg hover:border-brand hover:shadow-sm transition-all bg-white"
                  >
                    <div className={`inline-flex w-9 h-9 items-center justify-center rounded-md border ${colorCls}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <p className="mt-2.5 font-medium text-sm text-ink-primary">{t.name}</p>
                    <p className="mt-1 text-xs text-ink-secondary leading-relaxed">{t.description}</p>
                  </button>
                );
              })}
            </div>
          )}

          {/* Step 2: basic info */}
          {step === 1 && draft && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">
                  名称 <span className="text-red-500">*</span>
                </label>
                <input
                  value={draft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                  maxLength={64}
                  placeholder="给这个 Agent 起个名字"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-brand"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">描述</label>
                <input
                  value={draft.description}
                  onChange={(e) => updateDraft({ description: e.target.value })}
                  maxLength={200}
                  placeholder="一句话说明它是做什么的"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">
                  系统提示词 <span className="text-gray-400">（来自模板，可修改）</span>
                </label>
                <textarea
                  value={draft.systemPrompt}
                  onChange={(e) => updateDraft({ systemPrompt: e.target.value })}
                  rows={5}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:border-brand resize-y"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">
                  欢迎语 <span className="text-gray-400">（首次进入空会话时显示）</span>
                </label>
                <textarea
                  value={draft.welcomeMessage}
                  onChange={(e) => updateDraft({ welcomeMessage: e.target.value })}
                  rows={2}
                  maxLength={500}
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
                      onClick={addQuickPrompt}
                      className="text-xs text-brand hover:underline flex items-center gap-0.5"
                    >
                      <Plus className="w-3 h-3" /> 添加
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {draft.quickPrompts.map((q, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <input
                        value={q.title}
                        onChange={(e) => updateQuickPrompt(i, { title: e.target.value })}
                        maxLength={50}
                        placeholder="标题"
                        className="w-32 px-2.5 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-brand"
                      />
                      <input
                        value={q.prompt}
                        onChange={(e) => updateQuickPrompt(i, { prompt: e.target.value })}
                        maxLength={500}
                        placeholder="点击后填入输入框的内容"
                        className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-md text-xs focus:outline-none focus:border-brand"
                      />
                      <button
                        onClick={() => removeQuickPrompt(i)}
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
            </div>
          )}

          {/* Step 3: capability selection (server-governed options only) */}
          {step === 2 && (
            <div>
              <p className="text-xs text-ink-secondary mb-3">
                只有你的账号已授权且当前应用允许的能力会出现在这里；创建时服务端会再次校验。
              </p>
              {capabilities.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">
                  当前没有可挂载的能力，直接创建即可。
                </p>
              ) : (
                <div className="space-y-2">
                  {capabilities.map((c) => {
                    const checked = selectedCaps.includes(c.resourceId);
                    return (
                      <button
                        key={c.resourceId}
                        onClick={() => toggleCap(c.resourceId)}
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
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-red-600 min-w-0 flex-1">
            {submitError || (step === 1 && validation ? validation : "")}
          </div>
          <div className="flex gap-2 shrink-0">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                disabled={submitting}
                className="px-4 h-9 text-sm border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                上一步
              </button>
            )}
            {step < 2 && (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={step === 1 ? !!validation || !!loadError : !selectedTemplate}
                className="px-4 h-9 text-sm bg-brand hover:bg-brand-hover text-white rounded-md disabled:opacity-50"
              >
                下一步
              </button>
            )}
            {step === 2 && (
              <button
                onClick={submit}
                disabled={submitting || !!validation}
                className="px-4 h-9 text-sm bg-brand hover:bg-brand-hover text-white rounded-md disabled:opacity-50"
              >
                {submitting ? "创建中…" : "创建"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
