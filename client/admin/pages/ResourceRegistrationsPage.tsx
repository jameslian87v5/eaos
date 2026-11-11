import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, StatusBadge, RefreshButton, EmptyState, ErrorState } from "../components/ui";

const API_BASE = "/api";

type RegistrationStatus = "draft" | "published" | "rejected" | "disabled";

interface Registration {
  id: string;
  resourceType: "skill" | "mcp" | "hook-plugin";
  resourceName: string;
  ownerOrgId: string | null;
  status: RegistrationStatus;
  submittedByUserId: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  rejectReason: string | null;
  description: string | null;
}

interface OrgOption { id: string; name: string; status?: string; }

const STATUS_TONE: Record<RegistrationStatus, string> = {
  draft: "amber",
  published: "green",
  rejected: "red",
  disabled: "gray",
};
const STATUS_LABEL: Record<RegistrationStatus, string> = {
  draft: "待审核",
  published: "已发布",
  rejected: "已驳回",
  disabled: "已禁用",
};
const TYPE_LABEL: Record<string, string> = {
  skill: "Skill",
  mcp: "MCP",
  "hook-plugin": "Hook",
};

export function ResourceRegistrationsPage() {
  const [regs, setRegs] = useState<Registration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const isAdmin = currentUser.role === "admin";

  const fetchRegs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/resource-registrations`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRegs(data.registrations ?? []);
      } else {
        setError(`加载失败 (HTTP ${res.status})`);
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRegs(); }, [fetchRegs]);

  return (
    <div>
      <AdminPageHeader
        title="资源治理"
        description={
          isAdmin
            ? "部门资源注册审核与企业分发（发布/驳回/禁用 + 按部门分发/回收；草案不可解析进入运行时）"
            : "本部门资源注册草案与状态（提交后由企业管理员审核；已发布且已授权的资源方可使用）"
        }
        actions={
          <>
            <RefreshButton onClick={fetchRegs} loading={loading} />
            <button
              onClick={() => setShowForm(!showForm)}
              className="text-xs px-2.5 py-1 border border-line-subtle bg-white text-ink-secondary rounded hover:bg-gray-50"
            >
              {showForm ? "取消" : "+ 提交注册"}
            </button>
          </>
        }
      />

      {showForm && <DraftForm onDone={() => { setShowForm(false); fetchRegs(); }} />}

      <div className="bg-white border border-line-subtle rounded-lg overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-sm text-ink-muted">加载中…</div>
        ) : error ? (
          <ErrorState title={error} onRetry={fetchRegs} />
        ) : regs.length === 0 ? (
          <EmptyState
            icon="🧩"
            title={isAdmin ? "尚无资源注册" : "本部门尚无注册草案"}
            hint={isAdmin ? "部门管理员可提交资源注册草案，由你审核发布" : "点击「提交注册」为本部门申请一个共享池中的资源"}
          />
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">资源</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">归属部门</th>
                <th className="px-3 py-2 font-medium">提交时间</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {regs.map((r) => (
                <RegRow key={r.id} reg={r} isAdmin={isAdmin} onChanged={fetchRegs} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RegRow({ reg, isAdmin, onChanged }: { reg: Registration; isAdmin: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [showDist, setShowDist] = useState(false);

  const call = async (path: string, body?: Record<string, unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/admin/resource-registrations/${reg.id}/${path}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        if (okMsg) toast.success(okMsg);
        onChanged();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || `HTTP ${res.status}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <tr className="border-t border-gray-100">
        <td className="px-3 py-2 text-gray-700">
          <div className="font-medium">{reg.resourceName}</div>
          {reg.description && <div className="text-xs text-gray-400">{reg.description}</div>}
          {reg.rejectReason && <div className="text-xs text-red-500 mt-0.5">驳回理由：{reg.rejectReason}</div>}
        </td>
        <td className="px-3 py-2"><StatusBadge tone="blue">{TYPE_LABEL[reg.resourceType] ?? reg.resourceType}</StatusBadge></td>
        <td className="px-3 py-2"><StatusBadge tone={STATUS_TONE[reg.status]}>{STATUS_LABEL[reg.status]}</StatusBadge></td>
        <td className="px-3 py-2 text-gray-600">
          {reg.ownerOrgId ? <StatusBadge tone="gray">{reg.ownerOrgId}</StatusBadge> : <span className="text-gray-400">企业级</span>}
        </td>
        <td className="px-3 py-2 text-gray-400">{new Date(reg.submittedAt).toLocaleDateString()}</td>
        <td className="px-3 py-2">
          <div className="flex gap-2 items-center">
            {isAdmin && reg.status === "draft" && (
              <>
                <button disabled={busy} onClick={() => call("publish", undefined, "已发布（已为本部门授权）")} className="text-green-600 hover:underline disabled:opacity-50">发布</button>
                <button disabled={busy} onClick={() => {
                  const reason = window.prompt("驳回理由（可选）") ?? "";
                  call("reject", { reason }, "已驳回");
                }} className="text-red-600 hover:underline disabled:opacity-50">驳回</button>
              </>
            )}
            {isAdmin && reg.status === "published" && (
              <>
                <button disabled={busy} onClick={() => setShowDist(!showDist)} className="text-blue-600 hover:underline">
                  {showDist ? "收起" : "分发/回收"}
                </button>
                <button disabled={busy} onClick={() => call("disable", undefined, "已禁用（全局不可解析）")} className="text-amber-600 hover:underline disabled:opacity-50">禁用</button>
              </>
            )}
            {isAdmin && reg.status === "disabled" && (
              <button disabled={busy} onClick={() => call("publish", undefined, "已重新发布")} className="text-green-600 hover:underline disabled:opacity-50">重新发布</button>
            )}
            {!isAdmin && <span className="text-gray-400">仅查看</span>}
          </div>
        </td>
      </tr>
      {showDist && isAdmin && reg.status === "published" && (
        <tr className="border-t border-gray-100 bg-gray-50/50">
          <td colSpan={6} className="px-3 py-3">
            <DistributePanel reg={reg} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

// Admin: per-org distribute / revoke panel. Lists current entitlements +
// lets admin pick a target org. ownerOrgId is shown but never editable —
// it comes from the registration (server-trusted at submit time).
function DistributePanel({ reg, onChanged }: { reg: Registration; onChanged: () => void }) {
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [entries, setEntries] = useState<Array<{ scopeType: string; scopeId: string; effect: string }>>([]);
  const [busy, setBusy] = useState(false);

  const refreshAll = useCallback(async () => {
    setOrgsLoading(true);
    setOrgsError(null);
    try {
      const [orgRes, entRes] = await Promise.all([
        fetch(`${API_BASE}/admin/orgs`, { headers: authHeaders() }),
        fetch(`${API_BASE}/admin/capabilities/${encodeURIComponent(reg.resourceName)}/entitlements`, { headers: authHeaders() }),
      ]);
      if (orgRes.ok) {
        const d = await orgRes.json();
        // M4 review fix #3: only offer ACTIVE depts for distribution. Server
        // assertOrgActive rejects non-active targets; this keeps the UI in sync.
        setOrgs((d.orgs ?? []).filter((o: OrgOption) => o.status === "active"));
      } else {
        setOrgsError(`部门列表加载失败 (HTTP ${orgRes.status})`);
      }
      if (entRes.ok) {
        const ed = await entRes.json();
        setEntries(ed.entries ?? []);
      }
    } catch {
      setOrgsError("网络错误，请重试");
    } finally {
      setOrgsLoading(false);
    }
  }, [reg.resourceName]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  const dist = async () => {
    if (!target) { toast.error("请先选择目标部门"); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/admin/resource-registrations/${reg.id}/distribute`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: target }),
      });
      if (res.ok) { toast.success(`已分发到 ${target}`); refreshAll(); onChanged(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || `HTTP ${res.status}`); }
    } finally { setBusy(false); }
  };

  const revoke = async (orgId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/admin/resource-registrations/${reg.id}/revoke`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });
      if (res.ok) { toast.success(`已从 ${orgId} 回收`); refreshAll(); onChanged(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || `HTTP ${res.status}`); }
    } finally { setBusy(false); }
  };

  const allowedOrgs = entries.filter((e) => e.effect === "allow" && e.scopeType === "org");

  return (
    <div className="space-y-3">
      <div className="text-xs text-ink-secondary">
        <span className="font-medium text-ink-primary">{reg.resourceName}</span>
        <span className="ml-2">归属：{reg.ownerOrgId ?? "企业级（显式分发）"}</span>
      </div>

      {orgsLoading ? (
        <div className="text-xs text-ink-muted">加载部门列表…</div>
      ) : orgsError ? (
        <ErrorState title={orgsError} onRetry={refreshAll} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select value={target} onChange={(e) => setTarget(e.target.value)}
            className="text-xs border border-gray-200 rounded px-2 py-1">
            <option value="">选择目标部门…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}（{o.id}）</option>)}
          </select>
          <button onClick={dist} disabled={busy || !target}
            className="text-xs px-2.5 py-1 bg-brand text-white rounded disabled:opacity-50 hover:bg-brand-hover">
            分发
          </button>
        </div>
      )}

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">当前已授权部门（{allowedOrgs.length}）</div>
        {allowedOrgs.length === 0 ? (
          <div className="text-xs text-ink-muted">暂无已授权部门{reg.ownerOrgId ? "（本部门授权在发布时自动添加）" : ""}</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allowedOrgs.map((e) => (
              <span key={e.scopeId} className="text-xs px-2 py-1 bg-white border border-gray-200 rounded flex items-center gap-1.5">
                <StatusBadge tone="gray">{e.scopeId}</StatusBadge>
                {e.scopeId === reg.ownerOrgId && <span className="text-gray-400">(归属)</span>}
                <button onClick={() => revoke(e.scopeId)} disabled={busy}
                  className="text-red-500 hover:underline disabled:opacity-50">回收</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// org_admin: owner org forced server-side from JWT (NEVER from this form).
// admin: enterprise resource (ownerOrgId=null). Resource type + name must
// reference a real, valid entry in the shared pool — the server validates.
function DraftForm({ onDone }: { onDone: () => void }) {
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const isAdmin = currentUser.role === "admin";
  const [resourceType, setResourceType] = useState<"skill" | "mcp" | "hook-plugin">("skill");
  const [resourceName, setResourceName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/resource-registrations`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ resourceType, resourceName, description: description || undefined }),
      });
      if (res.ok) {
        toast.success(isAdmin ? "企业级注册草案已提交" : "本部门注册草案已提交，待企业管理员审核");
        onDone();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || `HTTP ${res.status}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-4 mb-4 space-y-3">
      <h3 className="text-sm font-medium text-gray-700">
        提交资源注册草案{isAdmin ? "（企业级，显式分发）" : "（归属：本部门）"}
      </h3>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-gray-500">资源类型</label>
          <select value={resourceType} onChange={(e) => setResourceType(e.target.value as "skill" | "mcp" | "hook-plugin")}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5">
            <option value="skill">Skill</option>
            <option value="mcp">MCP</option>
            <option value="hook-plugin">Hook Plugin</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500">资源名称（共享池中已存在）</label>
          <input value={resourceName} onChange={(e) => setResourceName(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">说明（可选）</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" />
        </div>
      </div>
      <div className="text-xs text-gray-400">
        草案提交后由企业管理员审核发布；发布时自动为本部门授权{isAdmin ? "（企业级资源无自动授权，需显式分发）" : ""}。
        草案/驳回/禁用状态资源不会进入任何运行时。
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving || !resourceName.trim()}
          className="text-xs px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded disabled:opacity-50">
          {saving ? "提交中…" : "提交草案"}
        </button>
        <button type="button" onClick={onDone}
          className="text-xs px-3 py-1.5 border border-gray-200 rounded hover:bg-gray-50">取消</button>
      </div>
    </form>
  );
}
