import { useState, useEffect, useCallback, Fragment } from "react";
import { toast } from "sonner";
import { AdminPageHeader, ErrorState, InfoNote, RefreshButton, StatusBadge } from "../components/ui";
import { authHeaders } from "../../components/AdminPanel";

// M1 (model-and-token-management-plan.md §6/§9-M1): standalone 模型管理 page —
// deliberately NOT part of Runtime Settings. Two views from one API:
//   - admin: full Model Catalog CRUD (shared platform pool) + per-org policy
//     editor (authorize models / set org default) with an org picker;
//   - org_admin: own-org policy editor ONLY (the catalog list it sees is its
//     own-org effective models; platform catalog writes are admin-only).
// Provider credentials never appear here — the API carries provider NAME only.

const API_BASE = "/api";

interface ModelRow {
  id: string;
  alias: string;
  provider: string;
  modelId: string | null;
  enabled: boolean;
  description: string | null;
  contextWindowTokens: number | null;
}

interface PolicyEntry { modelId: string; alias: string; enabled: boolean }
interface PolicyView {
  orgId: string;
  defaultModelId: string | null;
  defaultAlias: string | null;
  entries: PolicyEntry[];
  effective: {
    models: Array<{ id: string; alias: string }>;
    defaultAlias: string;
    defaultSource: "org" | "platform";
  };
}

interface OrgSummary { id: string; name: string }

type FormState = {
  alias: string;
  provider: string;
  modelId: string;
  contextWindowTokens: string;
  description: string;
  enabled: boolean;
};

const EMPTY_FORM: FormState = { alias: "", provider: "default", modelId: "", contextWindowTokens: "", description: "", enabled: true };

// ─── Org policy editor (shared by admin[picked org] + org_admin[own org]) ───

function OrgPolicyEditor({
  orgId,
  orgName,
  onSaved,
}: {
  orgId: string;
  orgName: string;
  onSaved?: () => void;
}) {
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [draftEntries, setDraftEntries] = useState<Array<{ modelId: string; alias: string; enabled: boolean }>>([]);
  const [draftDefault, setDraftDefault] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(orgId)}/model-policy`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPolicy(data.policy);
      setDraftEntries(data.policy.entries);
      setDraftDefault(data.policy.defaultModelId ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [orgId]);

  useEffect(() => { setPolicy(null); load(); }, [load]);

  if (error) return <div className="text-sm text-red-600">策略加载失败: {error}</div>;
  if (!policy) return <div className="text-sm text-gray-400 py-4">加载中…</div>;

  const toggle = (modelId: string, enabled: boolean) => {
    setDraftEntries((cur) => cur.map((e) => (e.modelId === modelId ? { ...e, enabled } : e)));
    if (!enabled && draftDefault === modelId) setDraftDefault(""); // mirror server hard gate
  };
  const selectable = draftEntries.filter((e) => e.enabled);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(orgId)}/model-policy`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModelId: draftDefault || null,
          models: draftEntries.map((e) => ({ modelId: e.modelId, enabled: e.enabled })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setPolicy(data.policy);
      setDraftEntries(data.policy.entries);
      setDraftDefault(data.policy.defaultModelId ?? "");
      toast.success(`已保存「${orgName}」模型策略`);
      onSaved?.();
    } catch (e) {
      toast.error(`保存失败: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-line-subtle rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-primary">组织模型策略 — {orgName}</h3>
          <p className="text-xs text-ink-muted mt-0.5">
            可用模型 = 平台启用 ∩ 本组织授权（deny-default）。生效默认：
            <code className="font-mono bg-gray-100 px-1 rounded">{policy.effective.defaultAlias}</code>
            （来源：{policy.effective.defaultSource === "org" ? "本组织" : "平台默认"}）
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="text-xs px-2.5 py-1 border border-line-subtle rounded hover:bg-gray-50">刷新</button>
          <button onClick={save} disabled={saving}
            className="text-xs px-3 py-1 bg-brand text-white rounded hover:bg-brand-hover disabled:opacity-50">
            {saving ? "保存中…" : "保存策略"}
          </button>
        </div>
      </div>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-left">
            <th className="px-2 py-1.5 font-medium border-b">授权</th>
            <th className="px-2 py-1.5 font-medium border-b">alias</th>
            <th className="px-2 py-1.5 font-medium border-b">设为组织默认</th>
          </tr>
        </thead>
        <tbody>
          {draftEntries.map((e) => (
            <tr key={e.modelId} className="border-b">
              <td className="px-2 py-1.5">
                <input type="checkbox" checked={e.enabled} onChange={(ev) => toggle(e.modelId, ev.target.checked)} />
              </td>
              <td className="px-2 py-1.5 font-mono">{e.alias}</td>
              <td className="px-2 py-1.5">
                <input
                  type="radio"
                  name={`default-${orgId}`}
                  checked={draftDefault === e.modelId}
                  disabled={!e.enabled}
                  onChange={() => setDraftDefault(e.modelId)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-ink-muted">
        服务端硬门禁：默认模型必须是「平台启用 + 本组织已授权」的模型，否则保存被拒（400）。停用平台模型会自动清空引用它的组织默认。
      </p>
    </div>
  );
}

// ─── M4: org Auto Compact policy card (plan §4.3 phase 1) ──────────
// Org overlay over the platform default. Numerics are clamped SERVER-SIDE to
// the current platform ceilings (组织值受平台上限约束) — the form shows the
// caps and surfaces the clamp result. enabled is narrow-only: an org may turn
// OFF platform-on compaction, never ON.

interface CompactPolicyView {
  enabled: boolean;
  thresholdTokens: number;
  keepRecentTurns: number;
  source?: "org" | "platform";
}

interface CompactPolicyResponse {
  policy: CompactPolicyView;
  source: "org" | "platform";
  platform: CompactPolicyView;
  caps: { minThresholdTokens: number; maxThresholdTokens: number; minKeepRecentTurns: number; maxKeepRecentTurns: number };
  stored?: CompactPolicyView;
  clamped?: string[];
}

function OrgCompactPolicyCard({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [data, setData] = useState<CompactPolicyResponse | null>(null);
  const [draft, setDraft] = useState({ enabled: true, thresholdTokens: "", keepRecentTurns: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(orgId)}/compact-policy`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as CompactPolicyResponse;
      setData(d);
      setDraft({ enabled: d.policy.enabled, thresholdTokens: String(d.policy.thresholdTokens), keepRecentTurns: String(d.policy.keepRecentTurns) });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [orgId]);

  useEffect(() => { setData(null); load(); }, [load]);

  if (error) return <div className="text-sm text-red-600">压缩策略加载失败: {error}</div>;
  if (!data) return <div className="text-sm text-gray-400 py-4">加载中…</div>;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(orgId)}/compact-policy`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: draft.enabled,
          thresholdTokens: Number(draft.thresholdTokens),
          keepRecentTurns: Number(draft.keepRecentTurns),
        }),
      });
      const d = (await res.json()) as CompactPolicyResponse & { error?: string };
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setData({ ...data, policy: d.policy, source: "org", stored: d.stored, clamped: d.clamped });
      setDraft({
        enabled: d.policy.enabled,
        thresholdTokens: String(d.stored?.thresholdTokens ?? d.policy.thresholdTokens),
        keepRecentTurns: String(d.stored?.keepRecentTurns ?? d.policy.keepRecentTurns),
      });
      toast.success(`已保存「${orgName}」压缩策略${d.clamped?.length ? `（超上限字段已收紧：${d.clamped.join("、")}）` : ""}`);
    } catch (e) {
      toast.error(`保存失败: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const effectiveOffButStoredOn = data.stored != null && data.stored.enabled && !data.policy.enabled;

  return (
    <div className="border border-line-subtle rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-primary">组织 Auto Compact 策略 — {orgName}</h3>
          <p className="text-xs text-ink-muted mt-0.5">
            当前生效：
            <code className="font-mono bg-gray-100 px-1 rounded">{data.policy.enabled ? "开启" : "关闭"}</code>
            · 阈值 {data.policy.thresholdTokens.toLocaleString()} · 保留 {data.policy.keepRecentTurns} 轮
            （来源：{data.source === "org" ? "本组织" : "平台默认"}；平台默认 {data.platform.enabled ? "开启" : "关闭"} / {data.platform.thresholdTokens.toLocaleString()} / {data.platform.keepRecentTurns} 轮）
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="text-xs px-2.5 py-1 border border-line-subtle rounded hover:bg-gray-50">刷新</button>
          <button onClick={save} disabled={saving}
            className="text-xs px-3 py-1 bg-brand text-white rounded hover:bg-brand-hover disabled:opacity-50">
            {saving ? "保存中…" : "保存策略"}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4 text-xs">
        <label className="flex items-center gap-1.5 pb-1.5">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          本组织启用（平台关闭时无法越过平台开启）
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">触发阈值 tokens（{data.caps.minThresholdTokens.toLocaleString()} – {data.caps.maxThresholdTokens.toLocaleString()}）</span>
          <input type="number" value={draft.thresholdTokens}
            onChange={(e) => setDraft({ ...draft, thresholdTokens: e.target.value })}
            className="border border-line-subtle rounded px-2 py-1 text-sm font-mono w-36" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">保留最近对话轮数（{data.caps.minKeepRecentTurns} – {data.caps.maxKeepRecentTurns}）</span>
          <input type="number" value={draft.keepRecentTurns}
            onChange={(e) => setDraft({ ...draft, keepRecentTurns: e.target.value })}
            className="border border-line-subtle rounded px-2 py-1 text-sm font-mono w-36" />
        </label>
      </div>
      {effectiveOffButStoredOn && (
        <p className="text-xs text-amber-600">平台已关闭 Auto Compact — 本组织的「启用」不会生效（组织只能收紧，不能放宽）。</p>
      )}
      <p className="text-xs text-ink-muted">
        达到阈值后在 turn 边界自动执行 /compact。服务端硬门禁：组织数值只能落在平台上限内（超出自动收紧）；
        保留轮数本轮仅作策略展示，不直接传给 SDK。
      </p>
    </div>
  );
}

// ─── Admin: catalog create/edit form ─────────────────────────

function ModelForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  submitLabel: string;
  onSubmit: (f: FormState) => Promise<void>;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof FormState, v: string | boolean) => setForm({ ...form, [k]: v });
  return (
    <div className="flex flex-wrap items-end gap-2 border border-line-subtle rounded-lg p-3 bg-gray-50/50">
      <label className="text-xs">
        <span className="block text-ink-muted mb-1">alias *</span>
        <input value={form.alias} onChange={(e) => set("alias", e.target.value)} placeholder="glm-4.7"
          className="border border-line-subtle rounded px-2 py-1 text-sm font-mono w-36" />
      </label>
      <label className="text-xs">
        <span className="block text-ink-muted mb-1">provider</span>
        <input value={form.provider} onChange={(e) => set("provider", e.target.value)} placeholder="default"
          className="border border-line-subtle rounded px-2 py-1 text-sm font-mono w-28" />
      </label>
      <label className="text-xs">
        <span className="block text-ink-muted mb-1">modelId（可选）</span>
        <input value={form.modelId} onChange={(e) => set("modelId", e.target.value)}
          className="border border-line-subtle rounded px-2 py-1 text-sm font-mono w-40" />
      </label>
      <label className="text-xs">
        <span className="block text-ink-muted mb-1">上下文窗口（可选）</span>
        <input value={form.contextWindowTokens} onChange={(e) => set("contextWindowTokens", e.target.value)} placeholder="128000"
          className="border border-line-subtle rounded px-2 py-1 text-sm font-mono w-28" />
      </label>
      <label className="text-xs flex-1 min-w-[180px]">
        <span className="block text-ink-muted mb-1">描述（可选）</span>
        <input value={form.description} onChange={(e) => set("description", e.target.value)}
          className="border border-line-subtle rounded px-2 py-1 text-sm w-full" />
      </label>
      <label className="text-xs flex items-center gap-1 pb-1.5">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        启用
      </label>
      <button
        onClick={async () => { setSaving(true); try { await onSubmit(form); } finally { setSaving(false); } }}
        disabled={saving || !form.alias.trim()}
        className="text-xs px-3 py-1.5 bg-brand text-white rounded hover:bg-brand-hover disabled:opacity-50"
      >
        {saving ? "…" : submitLabel}
      </button>
      {onCancel && (
        <button onClick={onCancel} className="text-xs px-2.5 py-1.5 border border-line-subtle rounded hover:bg-gray-50">取消</button>
      )}
    </div>
  );
}

// ─── M5: Provider import panel (plan §6.2) ──────────────────────
// Admin-only: preview a whitelisted provider's /models list, check a subset,
// import into the Model Catalog. Provider id is validated server-side against
// the connector whitelist — NO arbitrary URL. Credentials live only in
// process.env; never returned to the browser. Import touches the catalog ONLY
// (no org authorization, no Chat switch).

interface ProviderInfo { id: string; name: string; configured: boolean }
interface ProviderModel { id: string; displayName?: string; contextWindowTokens?: number | null }
interface PreviewResult {
  status: "ok" | "not_configured" | "timeout" | "auth_failed" | "unavailable" | "error";
  models: ProviderModel[];
  message?: string;
}
interface ImportResult { alias: string; status: "imported" | "updated" | "conflict" | "invalid"; modelId?: string; error?: string }

const PREVIEW_STATUS_LABEL: Record<PreviewResult["status"], string> = {
  ok: "", not_configured: "凭证未配置（服务端环境变量）", timeout: "请求超时",
  auth_failed: "鉴权失败（凭证无效或过期）", unavailable: "Provider 不可达", error: "错误",
};

function ProviderImportPanel({ onImported }: { onImported: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  // Per-model draft: imported = selected; alias editable (default = sanitized id).
  const [draft, setDraft] = useState<Array<{ selected: boolean; alias: string; model: ProviderModel }>>([]);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/models/providers`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { providers: ProviderInfo[] };
      setProviders(data.providers ?? []);
      setProviderId((cur) => cur || data.providers?.[0]?.id || "");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const sanitizeAlias = (id: string) =>
    id.replace(/[^A-Za-z0-9._\/-]/g, "-").replace(/^[^A-Za-z0-9]/, "x").slice(0, 64) || "model";

  const doPreview = async () => {
    if (!providerId) return;
    setBusy(true);
    setError(null);
    setResults(null);
    setPreview(null);
    setDraft([]);
    try {
      const res = await fetch(`${API_BASE}/admin/models/providers/${encodeURIComponent(providerId)}/preview`, {
        method: "POST", headers: authHeaders(),
      });
      const data = (await res.json()) as PreviewResult & { error?: string };
      setPreview(data);
      if (data.status === "ok" && data.models.length) {
        setDraft(data.models.map((m) => ({ selected: true, alias: sanitizeAlias(m.id), model: m })));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    const picked = draft.filter((d) => d.selected && d.alias.trim());
    if (!picked.length || !providerId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/models/import`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          models: picked.map((d) => ({
            alias: d.alias.trim(),
            modelId: d.model.id,
            contextWindowTokens: d.model.contextWindowTokens ?? null,
          })),
        }),
      });
      const data = (await res.json()) as { results?: ImportResult[]; error?: string; summary?: Record<string, number> };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResults(data.results ?? []);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-line-subtle rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-ink-muted">Provider（服务端白名单）</span>
          <select value={providerId} onChange={(e) => { setProviderId(e.target.value); setPreview(null); setDraft([]); setResults(null); }}
            className="border border-line-subtle rounded px-2 py-1.5 text-sm min-w-[12rem] bg-white">
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}（{p.id}）{p.configured ? "" : " · 未配置凭证"}</option>
            ))}
          </select>
        </label>
        <button onClick={doPreview} disabled={busy || !providerId}
          className="text-xs px-3 py-1.5 border border-line-subtle rounded bg-white hover:bg-gray-50 disabled:opacity-50">
          {busy ? "…" : "预览模型"}
        </button>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      {preview && preview.status !== "ok" && (
        <div className="text-xs text-amber-600">
          预览失败：{PREVIEW_STATUS_LABEL[preview.status] ?? preview.status}{preview.message ? ` — ${preview.message}` : ""}
        </div>
      )}

      {preview && preview.status === "ok" && (
        <>
          {draft.length === 0 ? (
            <div className="text-xs text-ink-muted">Provider 返回空模型列表。</div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-left">
                  <th className="px-2 py-1.5 font-medium border-b">导入</th>
                  <th className="px-2 py-1.5 font-medium border-b">provider 模型 ID</th>
                  <th className="px-2 py-1.5 font-medium border-b">导入为 alias（可编辑）</th>
                  <th className="px-2 py-1.5 font-medium border-b">上下文窗口</th>
                </tr>
              </thead>
              <tbody>
                {draft.map((d, i) => (
                  <tr key={d.model.id + i} className="border-b">
                    <td className="px-2 py-1.5">
                      <input type="checkbox" checked={d.selected}
                        onChange={(e) => setDraft((cur) => cur.map((x, j) => j === i ? { ...x, selected: e.target.checked } : x))} />
                    </td>
                    <td className="px-2 py-1.5 font-mono">{d.model.id}{d.model.displayName ? `（${d.model.displayName}）` : ""}</td>
                    <td className="px-2 py-1.5">
                      <input value={d.alias}
                        onChange={(e) => setDraft((cur) => cur.map((x, j) => j === i ? { ...x, alias: e.target.value } : x))}
                        className="border border-gray-200 rounded px-2 py-1 text-sm font-mono w-44" />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-gray-500">{d.model.contextWindowTokens ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex items-center gap-3">
            <button onClick={doImport} disabled={busy || !draft.some((d) => d.selected && d.alias.trim())}
              className="text-xs px-3 py-1.5 bg-brand text-white rounded hover:bg-brand-hover disabled:opacity-50">
              {busy ? "导入中…" : "导入选中模型"}
            </button>
            <span className="text-xs text-ink-muted">仅写入模型目录，不授权任何组织、不切换已有 Chat。</span>
          </div>
        </>
      )}

      {results && (
        <div className="border-t border-gray-100 pt-2 space-y-1">
          <div className="text-xs font-medium text-ink-primary">导入结果</div>
          {results.map((r, i) => (
            <div key={r.alias + i} className="text-xs">
              <code className="font-mono">{r.alias}</code>：
              {r.status === "imported" && <span className="text-green-600">已新增</span>}
              {r.status === "updated" && <span className="text-blue-600">已更新（同 provider 覆盖 modelId/窗口）</span>}
              {r.status === "conflict" && <span className="text-amber-600">冲突 — {r.error}</span>}
              {r.status === "invalid" && <span className="text-red-600">无效 — {r.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── M6: Anthropic-only JSON definition import ───────────────
// Paste one model object or { models: [...] }. protocol 固定 anthropic-compatible；
// 明文 apiKey 被拒绝（用 apiKeyEnv 环境变量名）；baseUrl 仅目录元数据 ——
// 运行时仍使用部署的单一 ANTHROPIC_BASE_URL endpoint。
const JSON_EXAMPLE = `{
  "models": [{
    "id": "claude-sonnet-5",
    "name": "claude-sonnet-5",
    "vendor": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "protocol": "anthropic-compatible",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "supportsToolCall": true,
    "supportsImages": true,
    "supportsReasoning": true,
    "maxInputTokens": 1000000,
    "maxOutputTokens": 64000
  }]
}`;

function JsonImportPanel({ onImported }: { onImported: () => void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doImport = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    setSummary(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError("JSON 解析失败：" + (e as Error).message);
      setBusy(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/admin/models/import-json`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = (await res.json()) as { results?: ImportResult[]; error?: string; summary?: Record<string, number> };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResults(data.results ?? []);
      setSummary(data.summary ?? null);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-line-subtle rounded-lg p-4 space-y-3">
      <div className="text-xs text-ink-muted">
        仅支持 <code className="font-mono">anthropic-compatible</code> 协议（Anthropic Messages API）。
        明文 <code className="font-mono">apiKey</code> 会被拒绝，请用 <code className="font-mono">apiKeyEnv</code>（环境变量名，服务端从进程环境读取）。
        <code className="font-mono">baseUrl</code> 仅作目录元数据，运行时使用部署的 Anthropic endpoint（单一 <code className="font-mono">ANTHROPIC_BASE_URL</code>）。
        导入只写模型目录，不回写 .env、不自动授权组织、不切换已有 Chat。
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false}
        placeholder={JSON_EXAMPLE}
        className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs font-mono" />
      <div className="flex items-center gap-3">
        <button onClick={doImport} disabled={busy || !text.trim()}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded hover:bg-brand-hover disabled:opacity-50">
          {busy ? "导入中…" : "导入 JSON 模型定义"}
        </button>
        <button onClick={() => setText(JSON_EXAMPLE)} disabled={busy}
          className="text-xs px-3 py-1.5 border border-line-subtle rounded bg-white hover:bg-gray-50 disabled:opacity-50">
          填入示例
        </button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
      {summary && (
        <div className="text-xs text-ink-muted">
          新增 {summary.imported ?? 0} · 更新 {summary.updated ?? 0} · 冲突 {summary.conflict ?? 0} · 无效 {summary.invalid ?? 0}
        </div>
      )}
      {results && (
        <div className="border-t border-gray-100 pt-2 space-y-1">
          {results.map((r, i) => (
            <div key={r.alias + i} className="text-xs">
              <code className="font-mono">{r.alias || "(未命名)"}</code>：
              {r.status === "imported" && <span className="text-green-600">已新增</span>}
              {r.status === "updated" && <span className="text-blue-600">已更新</span>}
              {r.status === "conflict" && <span className="text-amber-600">冲突 — {r.error}</span>}
              {r.status === "invalid" && <span className="text-red-600">无效 — {r.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────

export function ModelsPage() {
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const role: string = currentUser.role ?? "user";
  const isAdmin = role === "admin";

  const [models, setModels] = useState<ModelRow[]>([]);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string>("");
  const [scope, setScope] = useState<"platform" | "org">("platform");
  const [effectiveDefault, setEffectiveDefault] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [jsonImporting, setJsonImporting] = useState(false);

  const fetchModels = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch(`${API_BASE}/admin/models`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setModels(data.models ?? []);
      setScope(data.scope ?? "platform");
      setEffectiveDefault(data.effectiveDefault ?? null);
    } catch {
      setLoadError(true);
    }
  }, []);

  const fetchOrgs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/orgs`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const list: OrgSummary[] = data.orgs ?? [];
      setOrgs(list);
      // admin picks any org (default-org first); org_admin sees only its own row.
      setSelectedOrg((cur) => cur || list[0]?.id || "");
    } catch { /* sidebar-level failures are non-fatal for this page */ }
  }, []);

  useEffect(() => { fetchModels(); fetchOrgs(); }, [fetchModels, fetchOrgs]);

  const create = async (f: FormState) => {
    const res = await fetch(`${API_BASE}/admin/models`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: f.alias.trim(),
        provider: f.provider.trim() || "default",
        modelId: f.modelId.trim() || null,
        contextWindowTokens: f.contextWindowTokens.trim() ? Number(f.contextWindowTokens) : null,
        description: f.description.trim() || null,
        enabled: f.enabled,
      }),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(`创建失败: ${data.error || res.status}`); return; }
    toast.success(`模型 ${data.model.alias} 已创建`);
    setCreating(false);
    fetchModels();
  };

  const update = async (id: string, patch: Record<string, unknown>) => {
    const res = await fetch(`${API_BASE}/admin/models/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(`更新失败: ${data.error || res.status}`); return; }
    if (data.clearedOrgDefaults?.length) {
      toast.warning(`已停用并清空 ${data.clearedOrgDefaults.length} 个组织的默认模型引用`);
    }
    setEditingId(null);
    fetchModels();
  };

  const remove = async (m: ModelRow) => {
    if (!confirm(`删除模型 ${m.alias}？引用它的组织授权一并移除，组织默认将被清空。`)) return;
    const res = await fetch(`${API_BASE}/admin/models/${encodeURIComponent(m.id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(`删除失败: ${data.error || res.status}`); return; }
    toast.success(`模型 ${m.alias} 已删除`);
    fetchModels();
  };

  return (
    <div>
      <AdminPageHeader
        title="模型管理"
        description="平台模型目录与组织模型授权（M1）。目录是共享平台池（仅 admin 可写）；组织策略 = 授权集合 + 组织默认模型。凭证只存在于服务端环境。"
        actions={<RefreshButton onClick={fetchModels} />}
      />

      {loadError && <ErrorState onRetry={fetchModels} />}

      {/* ── Catalog (admin: full CRUD; org_admin: own-org effective view) ── */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-ink-primary">
            模型目录 {isAdmin ? "" : "（本组织可用）"}
            <span className="ml-2 text-xs font-normal text-ink-muted">共 {models.length} 个，{models.filter((m) => m.enabled).length} 个启用</span>
          </h2>
          {isAdmin && !creating && (
            <div className="flex gap-2">
              <button onClick={() => { setCreating(true); setEditingId(null); setImporting(false); setJsonImporting(false); }}
                className="text-xs px-2.5 py-1 bg-brand-soft text-brand border border-brand/30 rounded hover:bg-brand/10">
                + 新增模型
              </button>
              <button onClick={() => { setImporting((v) => !v); setCreating(false); setEditingId(null); setJsonImporting(false); }}
                className={`text-xs px-2.5 py-1 border rounded ${importing ? "bg-brand text-white border-brand" : "bg-white text-ink-secondary border-line-subtle hover:bg-gray-50"}`}>
                从 Provider 导入
              </button>
              <button onClick={() => { setJsonImporting((v) => !v); setCreating(false); setEditingId(null); setImporting(false); }}
                className={`text-xs px-2.5 py-1 border rounded ${jsonImporting ? "bg-brand text-white border-brand" : "bg-white text-ink-secondary border-line-subtle hover:bg-gray-50"}`}>
                JSON 导入（Anthropic）
              </button>
            </div>
          )}
        </div>

        {isAdmin && importing && (
          <div className="mb-3">
            <ProviderImportPanel onImported={fetchModels} />
          </div>
        )}

        {isAdmin && jsonImporting && (
          <div className="mb-3">
            <JsonImportPanel onImported={fetchModels} />
          </div>
        )}

        {!isAdmin && (
          <InfoNote>
            你看到的是本组织被授权且平台启用的模型（当前生效默认 <code className="font-mono">{effectiveDefault ?? "—"}</code>）。
            平台目录的增删改与 Provider 导入由平台 admin 在此页操作；组织级授权在下方策略区。
          </InfoNote>
        )}

        {isAdmin && creating && (
          <div className="mb-3">
            <ModelForm initial={EMPTY_FORM} submitLabel="创建" onSubmit={create} onCancel={() => setCreating(false)} />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-2 py-1.5 font-medium border-b">alias</th>
                <th className="px-2 py-1.5 font-medium border-b">provider</th>
                <th className="px-2 py-1.5 font-medium border-b">modelId</th>
                <th className="px-2 py-1.5 font-medium border-b">上下文窗口</th>
                <th className="px-2 py-1.5 font-medium border-b">描述</th>
                <th className="px-2 py-1.5 font-medium border-b">状态</th>
                {isAdmin && <th className="px-2 py-1.5 font-medium border-b">操作</th>}
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <Fragment key={m.id}>
                  <tr className="border-b hover:bg-gray-50">
                    <td className="px-2 py-1.5 font-mono font-medium">{m.alias}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-500">{m.provider}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-500">{m.modelId ?? "—"}</td>
                    <td className="px-2 py-1.5 font-mono text-gray-500">{m.contextWindowTokens ?? "—"}</td>
                    <td className="px-2 py-1.5 text-gray-600 max-w-[220px] truncate" title={m.description ?? ""}>{m.description ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <StatusBadge tone={m.enabled ? "green" : "gray"}>{m.enabled ? "启用" : "停用"}</StatusBadge>
                    </td>
                    {isAdmin && (
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <button onClick={() => update(m.id, { enabled: !m.enabled })}
                          className={`text-xs px-2 py-0.5 rounded border mr-1 ${m.enabled ? "bg-gray-50 text-gray-600 border-gray-200" : "bg-green-50 text-green-600 border-green-200"}`}>
                          {m.enabled ? "停用" : "启用"}
                        </button>
                        <button onClick={() => { setEditingId(editingId === m.id ? null : m.id); setCreating(false); }}
                          className="text-xs px-2 py-0.5 rounded border bg-blue-50 text-blue-600 border-blue-200 mr-1">
                          {editingId === m.id ? "收起" : "编辑"}
                        </button>
                        <button onClick={() => remove(m)} className="text-xs px-2 py-0.5 rounded border bg-red-50 text-red-600 border-red-200">
                          删除
                        </button>
                      </td>
                    )}
                  </tr>
                  {editingId === m.id && (
                    <tr>
                      <td colSpan={7} className="px-2 py-2 bg-gray-50/60">
                        <ModelForm
                          initial={{
                            alias: m.alias,
                            provider: m.provider,
                            modelId: m.modelId ?? "",
                            contextWindowTokens: m.contextWindowTokens != null ? String(m.contextWindowTokens) : "",
                            description: m.description ?? "",
                            enabled: m.enabled,
                          }}
                          submitLabel="保存"
                          onCancel={() => setEditingId(null)}
                          onSubmit={async (f) => {
                            await update(m.id, {
                              alias: f.alias.trim(),
                              provider: f.provider.trim() || "default",
                              modelId: f.modelId.trim() || null,
                              contextWindowTokens: f.contextWindowTokens.trim() ? Number(f.contextWindowTokens) : null,
                              description: f.description.trim() || null,
                              enabled: f.enabled,
                            });
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {models.length === 0 && (
                <tr><td colSpan={isAdmin ? 7 : 6} className="px-2 py-6 text-center text-gray-400">暂无模型（目录首次启动会从全局 runtime-settings 种子兼容读取）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Org policy ── */}
      <section>
        <h2 className="text-sm font-semibold text-ink-primary mb-2">组织模型授权与默认模型</h2>
        {orgs.length > 0 ? (
          <>
            {isAdmin && (
              <div className="flex items-center gap-2 mb-3 text-xs">
                <span className="text-ink-muted">组织</span>
                <select value={selectedOrg} onChange={(e) => setSelectedOrg(e.target.value)}
                  className="border border-line-subtle rounded px-2 py-1 text-sm">
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}（{o.id}）</option>)}
                </select>
              </div>
            )}
            {selectedOrg && (
              <>
                <OrgPolicyEditor
                  key={selectedOrg}
                  orgId={selectedOrg}
                  orgName={orgs.find((o) => o.id === selectedOrg)?.name ?? selectedOrg}
                  onSaved={fetchModels}
                />
                {/* M4: org Auto Compact overlay（同 org 策略区） */}
                <div className="mt-3">
                  <OrgCompactPolicyCard
                    key={`compact-${selectedOrg}`}
                    orgId={selectedOrg}
                    orgName={orgs.find((o) => o.id === selectedOrg)?.name ?? selectedOrg}
                  />
                </div>
              </>
            )}
          </>
        ) : (
          <div className="text-sm text-gray-400 py-4">组织列表加载中…</div>
        )}
        <InfoNote>
          M1 变更只影响新 runtime 与授权/默认的解析视图；全局默认模型仍在 Runtime Settings（Stage 2 粗粒度配置）中，Chat 级选择属 M2。
        </InfoNote>
      </section>
    </div>
  );
}
