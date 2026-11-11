import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, StatusBadge, RefreshButton, EmptyState, ErrorState } from "../components/ui";

const API_BASE = "/api";

type OrgStatus = "provisioning" | "active" | "suspended" | "archived";

interface OrgView {
  id: string;
  name: string;
  createdAt: string;
  status: OrgStatus | string;
  // M3: enterprise-overview counts (server-derived; admin list carries them).
  userCount?: number;
  activeOrgAdminCount?: number;
}

interface DeptUserView {
  id: string;
  username: string;
  role: string;
  orgId?: string;
  status?: string;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  provisioning: "amber",
  active: "green",
  suspended: "red",
  archived: "gray",
};

const STATUS_LABEL: Record<string, string> = {
  provisioning: "开通中",
  active: "运行中",
  suspended: "已停用",
  archived: "已归档",
};

const USER_STATUS_TONE: Record<string, "green" | "red"> = {
  active: "green",
  disabled: "red",
};

export function OrgsPage() {
  const [orgs, setOrgs] = useState<OrgView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  // Phase 7.2 / M3: admin may provision/rename/manage-status orgs and see the
  // enterprise overview; org_admin reads only their own dept (server-scoped).
  const canManage = currentUser.role === "admin";

  const fetchOrgs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setOrgs(data.orgs ?? []);
      } else {
        setError(`加载失败 (HTTP ${res.status})`);
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  return (
    <div>
      <AdminPageHeader
        title="组织"
        description={canManage ? `共 ${orgs.length} 个部门（管理员可开通/改名/停用/恢复；点击「详情」查看部门用户）` : "当前所属部门（只读）"}
        actions={
          <>
            <RefreshButton onClick={fetchOrgs} loading={loading} />
            {canManage ? (
              <button
                onClick={() => setShowForm(!showForm)}
                className="text-xs px-2.5 py-1 border border-line-subtle bg-white text-ink-secondary rounded hover:bg-gray-50"
              >
                {showForm ? "取消" : "+ 开通部门"}
              </button>
            ) : undefined}
          </>
        }
      />

      {showForm && canManage && <OrgForm onDone={() => { setShowForm(false); fetchOrgs(); }} />}

      <div className="bg-white border border-line-subtle rounded-lg overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-sm text-ink-muted">加载中…</div>
        ) : error ? (
          <ErrorState title={error} onRetry={fetchOrgs} />
        ) : orgs.length === 0 ? (
          <EmptyState icon="🏢" title={canManage ? "尚无部门" : "未找到所属部门"} hint={canManage ? "点击「开通部门」创建第一个部门" : undefined} />
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="px-3 py-2 font-medium">状态</th>
                {canManage && <th className="px-3 py-2 font-medium">用户数</th>}
                {canManage && <th className="px-3 py-2 font-medium">部门管理员</th>}
                <th className="px-3 py-2 font-medium">Org ID</th>
                <th className="px-3 py-2 font-medium">创建时间</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <OrgRow key={o.id} org={o} canManage={canManage} onChanged={fetchOrgs} isOwn={o.id === currentUser.orgId} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function OrgRow({ org, canManage, onChanged, isOwn }: { org: OrgView; canManage: boolean; onChanged: () => void; isOwn: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  const [showDetail, setShowDetail] = useState(false);

  const save = async () => {
    const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(org.id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      toast.success("部门已改名");
      setEditing(false);
      onChanged();
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || `HTTP ${res.status}`);
    }
  };

  // M1: status transition (suspend / activate). provisioning/archived have no
  // M1 entry point, so no action button for them.
  const transition = async (action: "suspend" | "activate") => {
    const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(org.id)}/${action}`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (res.ok) {
      toast.success(action === "suspend" ? "部门已停用" : "部门已恢复");
      onChanged();
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || `HTTP ${res.status}`);
    }
  };

  const tone = STATUS_TONE[org.status] ?? "gray";

  return (
    <>
      <tr className="border-t border-gray-100">
        <td className="px-3 py-2 text-gray-700">
          {editing ? (
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="text-sm border border-gray-200 rounded px-2 py-1 w-full" />
          ) : (
            <span>{org.name}{isOwn && <span className="ml-1.5 text-xs text-blue-500">(本部门)</span>}</span>
          )}
        </td>
        <td className="px-3 py-2"><StatusBadge tone={tone}>{STATUS_LABEL[org.status] ?? org.status}</StatusBadge></td>
        {canManage && <td className="px-3 py-2 text-gray-600">{org.userCount ?? "-"}</td>}
        {canManage && (
          <td className="px-3 py-2">
            {org.activeOrgAdminCount ? (
              <StatusBadge tone={(org.activeOrgAdminCount ?? 0) > 0 ? "blue" : "red"}>{org.activeOrgAdminCount} 位</StatusBadge>
            ) : (
              <StatusBadge tone="red">无</StatusBadge>
            )}
          </td>
        )}
        <td className="px-3 py-2"><StatusBadge tone="gray">{org.id}</StatusBadge></td>
        <td className="px-3 py-2 text-gray-400">{new Date(org.createdAt).toLocaleDateString()}</td>
        <td className="px-3 py-2">
          <div className="flex gap-2 items-center">
            <button onClick={() => setShowDetail(!showDetail)} className="text-blue-600 hover:underline">
              {showDetail ? "收起" : "详情"}
            </button>
            {canManage && (
              <>
                {editing ? (
                  <>
                    <button onClick={save} className="text-blue-600 hover:underline">保存</button>
                    <button onClick={() => { setEditing(false); setName(org.name); }} className="text-gray-500 hover:underline">取消</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => setEditing(true)} className="text-blue-600 hover:underline">改名</button>
                    {org.status === "active" && (
                      <button onClick={() => transition("suspend")} className="text-amber-600 hover:underline">停用</button>
                    )}
                    {org.status === "suspended" && (
                      <button onClick={() => transition("activate")} className="text-green-600 hover:underline">恢复</button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </td>
      </tr>
      {showDetail && (
        <tr className="border-t border-gray-100 bg-gray-50/50">
          <td colSpan={canManage ? 7 : 5} className="px-3 py-3">
            <DeptDetail orgId={org.id} />
          </td>
        </tr>
      )}
    </>
  );
}

// M3: department detail — fetches org + users + org_admins from the server
// (org_admin: server-scopes to own dept; admin: any). Renders users with role
// + status. No writes here; every mutation goes through UsersPage / PATCH.
function DeptDetail({ orgId }: { orgId: string }) {
  const [data, setData] = useState<{ org: OrgView; users: DeptUserView[]; orgAdmins: DeptUserView[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(orgId)}/detail`, { headers: authHeaders() });
      if (res.ok) {
        setData(await res.json());
      } else if (res.status === 404) {
        setError("部门不存在或无权访问");
      } else {
        setError(`加载失败 (HTTP ${res.status})`);
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  if (loading) return <div className="text-xs text-ink-muted py-4">加载部门详情…</div>;
  if (error) return <ErrorState title={error} onRetry={fetchDetail} />;
  if (!data) return null;

  const admins = data.orgAdmins;
  const plain = data.users.filter((u) => u.role === "user");

  return (
    <div className="space-y-3">
      <div className="text-xs text-ink-secondary">
        <span className="font-medium text-ink-primary">{data.org.name}</span>
        <span className="ml-2"><StatusBadge tone={STATUS_TONE[data.org.status] ?? "gray"}>{STATUS_LABEL[data.org.status] ?? data.org.status}</StatusBadge></span>
        <span className="ml-3">部门管理员 {admins.length} · 用户 {data.users.length}</span>
      </div>

      {/* M5: per-department quota + current usage (admin can edit; org_admin read). */}
      <QuotaPanel orgId={orgId} />

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">部门管理员（{admins.length}）</div>
        {admins.length === 0 ? (
          <div className="text-xs text-red-600">⚠ 本部门暂无部门管理员，需由企业管理员指派一位 org_admin</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {admins.map((u) => (
              <span key={u.id} className="text-xs px-2 py-1 bg-white border border-gray-200 rounded">
                {u.username}
                <StatusBadge tone={USER_STATUS_TONE[u.status ?? "active"] ?? "gray"}>{u.status ?? "active"}</StatusBadge>
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">用户（{plain.length}）</div>
        {plain.length === 0 ? (
          <div className="text-xs text-ink-muted">本部门暂无普通用户</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-gray-500 text-left">
              <tr>
                <th className="px-2 py-1 font-medium">用户名</th>
                <th className="px-2 py-1 font-medium">状态</th>
                <th className="px-2 py-1 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {plain.map((u) => (
                <tr key={u.id} className="border-t border-gray-100">
                  <td className="px-2 py-1 text-gray-700">{u.username}</td>
                  <td className="px-2 py-1"><StatusBadge tone={USER_STATUS_TONE[u.status ?? "active"] ?? "gray"}>{u.status ?? "active"}</StatusBadge></td>
                  <td className="px-2 py-1 text-gray-400">{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// M1: provision form — opens a department in one transaction: org + first
// org_admin (forced first-login change) + default quota + audit. The first
// admin must change their password on first login.
function OrgForm({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, adminUsername, adminPassword, adminDisplayName: adminDisplayName || undefined }),
      });
      if (res.ok) {
        toast.success("部门已开通（首位管理员需首次登录改密）");
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
      <h3 className="text-sm font-medium text-gray-700">开通新部门</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-500">Org ID（小写字母/数字/中划线）</label>
          <input value={id} onChange={(e) => setId(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">部门名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">首位部门管理员（用户名）</label>
          <input value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">初始密码（≥8 位、字母+数字）</label>
          <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-gray-500">显示名（可选）</label>
          <input value={adminDisplayName} onChange={(e) => setAdminDisplayName(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving}
          className="text-xs px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded disabled:opacity-50">
          {saving ? "开通中…" : "开通"}
        </button>
        <button type="button" onClick={onDone}
          className="text-xs px-3 py-1.5 border border-gray-200 rounded hover:bg-gray-50">取消</button>
      </div>
    </form>
  );
}

// M5: per-department quota panel — reads GET /api/admin/orgs/:id/quota (returns
// the resolved quota + a current-usage snapshot), admin edits via PUT. org_admin:
// read-only (server enforces; PUT returns 403). The numbers shown are the SAME
// ones the quota gate checks at create-Agent / start-runtime / upload-file.
function QuotaPanel({ orgId }: { orgId: string }) {
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const isAdmin = currentUser.role === "admin";
  const [quota, setQuota] = useState<{ maxAgents: number; maxConcurrentRuntimes: number; maxStorageMb: number; maxTurnsPerRuntime: number; maxTokensMonthly: number; tokenAlertThresholdPct: number; tokenStatus?: "normal" | "near" | "over"; usage: { agents: number; concurrentRuntimes: number; storageBytes: number; tokensMonthly?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; total: number; turns: number; monthStart: string } }; isDefault?: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ maxAgents: 0, maxConcurrentRuntimes: 0, maxStorageMb: 0, maxTurnsPerRuntime: 0, maxTokensMonthly: 0, tokenAlertThresholdPct: 0 });
  const [err, setErr] = useState<string | null>(null);

  const fetchQuota = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(orgId)}/quota`, { headers: authHeaders() });
      if (res.status === 404) { setQuota(null); return; }
      if (!res.ok) { setErr(`HTTP ${res.status}`); return; }
      const data = (await res.json()).quota;
      setQuota(data);
      setDraft({ maxAgents: data.maxAgents, maxConcurrentRuntimes: data.maxConcurrentRuntimes, maxStorageMb: data.maxStorageMb, maxTurnsPerRuntime: data.maxTurnsPerRuntime, maxTokensMonthly: data.maxTokensMonthly, tokenAlertThresholdPct: data.tokenAlertThresholdPct });
    } catch { setErr("网络错误"); }
  }, [orgId]);

  useEffect(() => { void fetchQuota(); }, [fetchQuota]);

  async function save() {
    setErr(null);
    const res = await fetch(`${API_BASE}/admin/orgs/${encodeURIComponent(orgId)}/quota`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!res.ok) { setErr(`保存失败: HTTP ${res.status} ${await res.text()}`); return; }
    setEditing(false);
    void fetchQuota();
  }

  if (err) return <div className="text-xs text-red-600">⚠ 配额加载失败: {err}</div>;
  if (!quota) return null;
  const mb = (b: number) => (b / (1024 * 1024)).toFixed(1);
  const kFmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const fieldFor = (label: string) =>
    label === "Agent 上限" ? "maxAgents" : label === "并发 Runtime 上限" ? "maxConcurrentRuntimes" : label === "存储上限" ? "maxStorageMb" : label === "月 Token 预算" ? "maxTokensMonthly" : label === "Token 告警阈值 %" ? "tokenAlertThresholdPct" : "maxTurnsPerRuntime";
  const Row = ({ label, max, cur, unit }: { label: string; max: number; cur: number; unit: string }) => (
    <div className="flex items-center justify-between text-xs py-1">
      <span className="text-ink-secondary">{label}</span>
      {editing ? (
        <input type="number" value={(draft as any)[fieldFor(label)]} onChange={(e) => setDraft({ ...draft, [fieldFor(label)]: parseInt(e.target.value) || 0 })} className="w-20 px-1 py-0.5 border border-line-subtle rounded" />
      ) : (
        <span className="font-mono text-ink-primary">{cur} / {max}{unit}</span>
      )}
    </div>
  );
  // Stage 1 (token management): monthly budget row + status pill + breakdown.
  // Status text is the ACTUAL server-derived status (normal/near/over), never
  // a client-side guess; the budget is soft (alert-only) — over ≠ blocked.
  const tk = quota.usage.tokensMonthly;
  const statusLabel = quota.tokenStatus === "over" ? "超预算" : quota.tokenStatus === "near" ? "临近" : "正常";
  const statusCls = quota.tokenStatus === "over" ? "bg-red-100 text-red-700" : quota.tokenStatus === "near" ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700";
  return (
    <div className="border border-line-subtle rounded p-3 bg-gray-50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">配额与用量 {quota.isDefault && <span className="text-ink-muted">(平台默认)</span>}</span>
        {isAdmin && (editing ? (
          <span className="flex gap-2">
            <button onClick={save} className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700">保存</button>
            <button onClick={() => { setEditing(false); void fetchQuota(); }} className="text-xs px-2 py-0.5 border border-line-subtle rounded">取消</button>
          </span>
        ) : <button onClick={() => setEditing(true)} className="text-xs px-2 py-0.5 border border-line-subtle bg-white rounded hover:bg-gray-50">编辑</button>)}
      </div>
      <div className="grid grid-cols-2 gap-x-4">
        <Row label="Agent 上限" max={quota.maxAgents} cur={quota.usage.agents} unit="" />
        <Row label="并发 Runtime 上限" max={quota.maxConcurrentRuntimes} cur={quota.usage.concurrentRuntimes} unit="" />
        <Row label="存储上限" max={quota.maxStorageMb} cur={Number(mb(quota.usage.storageBytes))} unit=" MB" />
        <Row label="单 Runtime 轮次上限" max={quota.maxTurnsPerRuntime} cur={0} unit="" />
        <Row label="月 Token 预算" max={quota.maxTokensMonthly} cur={tk ? tk.total : 0} unit="" />
        <Row label="Token 告警阈值 %" max={100} cur={quota.tokenAlertThresholdPct} unit="%" />
      </div>
      {tk && (
        <div className="mt-2 pt-2 border-t border-line-subtle flex items-center justify-between text-xs">
          <span className="text-ink-secondary">
            本月 Token（{tk.turns} 轮）：输入 {kFmt(tk.inputTokens)} · 输出 {kFmt(tk.outputTokens)} · 缓存写 {kFmt(tk.cacheCreationTokens)} · 缓存读 {kFmt(tk.cacheReadTokens)}
          </span>
          <span className={`px-1.5 py-0.5 rounded font-medium ${statusCls}`}>{statusLabel}</span>
        </div>
      )}
      {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
    </div>
  );
}
