import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, StatusBadge, RefreshButton, EmptyState, ErrorState } from "../components/ui";

const API_BASE = "/api";

interface UserView {
  id: string;
  username: string;
  role: string;
  orgId?: string;
  status?: string; // M2: active | disabled
  createdAt: string;
}

interface OrgOption {
  id: string;
  name: string;
  status: string;
}

// Phase 7.2: role options depend on the actor. admin may grant any tier;
// org_admin may only manage plain `user` accounts (server enforces too).
const ROLE_TONES: Record<string, "purple" | "blue" | "gray"> = {
  admin: "purple",
  org_admin: "blue",
  user: "gray",
};

// M2: status badge tone.
const STATUS_TONE: Record<string, "green" | "red"> = {
  active: "green",
  disabled: "red",
};

export function UsersPage() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]); // M3: active-dept dropdown
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
  const actorIsAdmin = currentUser.role === "admin";
  // org_admin can only set/keep `user`; admin can set all three tiers.
  const roleOptions = actorIsAdmin ? ["user", "org_admin", "admin"] : ["user"];

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/users`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users ?? []);
      } else {
        setError(`加载失败 (HTTP ${res.status})`);
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  // M3 review fix: org-option fetch has its own loading/error state + retry,
  // so a failed orgs fetch no longer silently degrades the create/migrate
  // selects to "empty". Independent from the users fetch — either can fail
  // without masking the other.
  const fetchOrgs = useCallback(async () => {
    setOrgsLoading(true);
    setOrgsError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/orgs`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setOrgs((data.orgs ?? []).filter((o: OrgOption) => o.status === "active"));
      } else {
        setOrgsError(`部门列表加载失败 (HTTP ${res.status})`);
      }
    } catch {
      setOrgsError("部门列表网络错误，请重试");
    } finally {
      setOrgsLoading(false);
    }
  }, []);

  // M3 review fix: the page RefreshButton refreshes BOTH the user list AND
  // the active-dept options (so a freshly provisioned dept appears in the
  // create/migrate selects after refresh).
  const refreshAll = useCallback(() => {
    fetchUsers();
    fetchOrgs();
  }, [fetchUsers, fetchOrgs]);

  useEffect(() => { fetchUsers(); fetchOrgs(); }, [fetchUsers, fetchOrgs]);

  const handleChangeRole = async (user: UserView, newRole: string) => {
    if (newRole === user.role) return;
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      toast.success(`${user.username} 角色已改为 ${newRole}`);
      await fetchUsers();
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "操作失败");
    }
  };

  const handleDelete = async (user: UserView) => {
    if (user.id === currentUser.id) {
      toast.error("不能删除自己");
      return;
    }
    if (!confirm(`确认删除用户 ${user.username}？`)) return;
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(user.id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (res.ok) {
      toast.success("用户已删除");
      await fetchUsers();
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "删除失败");
    }
  };

  // M2: admin/org_admin reset of a user's password. Server sets
  // must_change_password=1 + bumps token_version (old sessions die).
  const handleResetPassword = async (user: UserView) => {
    const newPassword = window.prompt(`为 ${user.username} 设置新临时密码（≥8 位，含字母+数字）`);
    if (newPassword === null) return;
    if (!newPassword) { toast.error("密码不能为空"); return; }
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    if (res.ok) {
      toast.success(`${user.username} 密码已重置，需重新登录`);
      await fetchUsers();
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "重置失败");
    }
  };

  // M2: disable / restore. org_admin cannot touch privileged accounts (server
  // enforces); self-disable is refused.
  const handleToggleStatus = async (user: UserView) => {
    const next = user.status === "disabled" ? "active" : "disabled";
    const verb = next === "disabled" ? "停用" : "恢复";
    if (!confirm(`确认${verb}用户 ${user.username}？${next === "disabled" ? "其旧会话将立即失效。" : ""}`)) return;
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      toast.success(`${user.username} 已${verb}`);
      await fetchUsers();
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || `${verb}失败`);
    }
  };

  // M3: cross-dept migration now uses an inline <select> of ACTIVE depts
  // (not a free-text prompt that could send a forged/inactive/typo orgId).
  // The server still validates the target is active + the actor is admin.
  // The row's org cell turns into a select + 确认/取消; on confirm, PATCH
  // orgId=<selected> bumps token_version (old JWT dies).
  const handleMigrate = async (user: UserView, newOrg: string) => {
    if (newOrg === user.orgId) { toast.error("用户已在该部门"); return false; }
    const res = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: newOrg }),
    });
    if (res.ok) {
      toast.success(`${user.username} 已迁移到 ${newOrg}（需重新登录）`);
      await fetchUsers();
      return true;
    } else {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || "迁移失败");
      return false;
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="用户"
        description={`共 ${users.length} 个用户${actorIsAdmin ? "" : "（本部门）"}`}
        actions={
          <>
            <RefreshButton onClick={refreshAll} loading={loading || orgsLoading} />
            <button
              onClick={() => setShowForm(!showForm)}
              className="text-xs px-2.5 py-1 border border-line-subtle bg-white text-ink-secondary rounded hover:bg-gray-50"
            >
              {showForm ? "取消" : "+ 创建用户"}
            </button>
          </>
        }
      />

      {showForm && (
        <UserForm
          actorIsAdmin={actorIsAdmin}
          orgs={orgs}
          orgsLoading={orgsLoading}
          orgsError={orgsError}
          onRetryOrgs={fetchOrgs}
          onDone={() => { setShowForm(false); fetchUsers(); }}
        />
      )}

      <div className="bg-white border border-line-subtle rounded-lg overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-sm text-ink-muted">加载中…</div>
        ) : error ? (
          <ErrorState title={error} onRetry={fetchUsers} />
        ) : users.length === 0 ? (
          <EmptyState icon="👤" title="暂无用户" hint="点击「创建用户」添加" />
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">用户名</th>
                <th className="px-3 py-2 font-medium">组织</th>
                <th className="px-3 py-2 font-medium">角色</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">创建时间</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isDisabled = u.status === "disabled";
                // M3 review fix: org_admin may only manage plain `user` rows.
                // Privileged accounts (admin / org_admin) are visible to
                // org_admin for transparency but read-only — no role select,
                // no reset/toggle/delete. The server enforces this too
                // (checkUserMutation denies), but the UI must not present
                // controls that can only fail. admin (cross-org) keeps full
                // controls on every row.
                const isPrivileged = u.role === "admin" || u.role === "org_admin";
                const canManageRow = actorIsAdmin || !isPrivileged;
                return (
                <UserRow
                  key={u.id}
                  user={u}
                  isDisabled={isDisabled}
                  isSelf={u.id === currentUser.id}
                  actorIsAdmin={actorIsAdmin}
                  canManageRow={canManageRow}
                  roleOptions={roleOptions}
                  orgs={orgs}
                  onChangeRole={handleChangeRole}
                  onDelete={handleDelete}
                  onResetPassword={handleResetPassword}
                  onToggleStatus={handleToggleStatus}
                  onMigrate={handleMigrate}
                />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function UserRow({
  user,
  isDisabled,
  isSelf,
  actorIsAdmin,
  canManageRow,
  roleOptions,
  orgs,
  onChangeRole,
  onDelete,
  onResetPassword,
  onToggleStatus,
  onMigrate,
}: {
  user: UserView;
  isDisabled: boolean;
  isSelf: boolean;
  actorIsAdmin: boolean;
  canManageRow: boolean; // M3 review: false for org_admin viewing privileged rows
  roleOptions: string[];
  orgs: OrgOption[];
  onChangeRole: (u: UserView, r: string) => void;
  onDelete: (u: UserView) => void;
  onResetPassword: (u: UserView) => void;
  onToggleStatus: (u: UserView) => void;
  onMigrate: (u: UserView, newOrg: string) => Promise<boolean>;
}) {
  const [migratingStatus, setMigratingStatus] = useState(false);
  const [pendingOrg, setPendingOrg] = useState(user.orgId ?? "");
  const [migrating, setMigrating] = useState(false);

  const confirmMigrate = async () => {
    setMigrating(true);
    const ok = await onMigrate(user, pendingOrg);
    setMigrating(false);
    if (ok) setMigratingStatus(false);
  };

  const orgName = orgs.find((o) => o.id === user.orgId)?.name ?? user.orgId;

  return (
    <tr className="border-t border-gray-100">
      <td className="px-3 py-2 text-gray-700">
        {user.username}
        {isSelf && <span className="ml-1.5 text-xs text-blue-500">(you)</span>}
      </td>
      <td className="px-3 py-2">
        {migratingStatus && actorIsAdmin ? (
          <div className="flex items-center gap-1">
            <select
              value={pendingOrg}
              onChange={(e) => setPendingOrg(e.target.value)}
              disabled={migrating}
              className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white disabled:opacity-50"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name} ({o.id})</option>
              ))}
            </select>
            <button onClick={confirmMigrate} disabled={migrating} className="text-indigo-600 hover:underline disabled:opacity-50">
              {migrating ? "迁移中…" : "确认"}
            </button>
            <button onClick={() => { setMigratingStatus(false); setPendingOrg(user.orgId ?? ""); }} disabled={migrating} className="text-gray-500 hover:underline">
              取消
            </button>
          </div>
        ) : (
          <StatusBadge tone="gray" title={user.orgId}>{orgName ?? "-"}</StatusBadge>
        )}
      </td>
      <td className="px-3 py-2">
        {/* M3 review: privileged rows are read-only for org_admin — show a
            badge, not an editable select. admin keeps the select on every
            row (it can demote/promote). For a plain user managed by org_admin
            the select only lists `user` (roleOptions). */}
        {canManageRow ? (
          <select
            value={user.role}
            disabled={isDisabled}
            onChange={(e) => onChangeRole(user, e.target.value)}
            className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white disabled:opacity-50"
          >
            {/* Show the current role even if the actor can't grant it (privileged accounts visible to admin). */}
            {!roleOptions.includes(user.role) && <option value={user.role}>{user.role}</option>}
            {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        ) : (
          <StatusBadge tone={ROLE_TONES[user.role] ?? "gray"}>{user.role}（只读）</StatusBadge>
        )}
        {!canManageRow && !roleOptions.includes(user.role) && null}
      </td>
      <td className="px-3 py-2">
        <StatusBadge tone={STATUS_TONE[user.status ?? "active"] ?? "gray"}>{user.status ?? "active"}</StatusBadge>
      </td>
      <td className="px-3 py-2 text-gray-400">{new Date(user.createdAt).toLocaleDateString()}</td>
      <td className="px-3 py-2 space-x-2 whitespace-nowrap">
        {/* M3 review: org_admin sees NO mutation controls on privileged rows
            (reset/toggle/delete hidden). Plain-user rows keep full controls.
            Self rows never get self-disable/delete (server refuses). Migration
            stays admin-only. */}
        {canManageRow && !isSelf && (
          <>
            <button onClick={() => onResetPassword(user)} className="text-blue-500 hover:underline">
              重置密码
            </button>
            <button onClick={() => onToggleStatus(user)}
              className={isDisabled ? "text-green-600 hover:underline" : "text-amber-600 hover:underline"}>
              {isDisabled ? "恢复" : "停用"}
            </button>
          </>
        )}
        {actorIsAdmin && !isSelf && !isDisabled && (
          <button onClick={() => { setPendingOrg(user.orgId ?? ""); setMigratingStatus(true); }} className="text-indigo-500 hover:underline">
            迁移
          </button>
        )}
        {canManageRow && !isSelf && (
          <button onClick={() => onDelete(user)} className="text-red-500 hover:underline">
            删除
          </button>
        )}
        {!canManageRow && (
          <span className="text-xs text-ink-muted">—</span>
        )}
      </td>
    </tr>
  );
}

// M3: create-user form. The org field is now a SELECT of active depts (admin
// only); org_admin has no org field — their org is forced server-side from
// the trusted JWT claim, never from the request body. The select prevents
// the client from sending a forged/inactive/typo orgId.
function UserForm({
  actorIsAdmin,
  orgs,
  orgsLoading,
  orgsError,
  onRetryOrgs,
  onDone,
}: {
  actorIsAdmin: boolean;
  orgs: OrgOption[];
  orgsLoading: boolean;
  orgsError: string | null;
  onRetryOrgs: () => void;
  onDone: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [orgId, setOrgId] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, string> = { username, password, role };
      // Only admin may choose the org; org_admin's org is forced server-side.
      // admin's selected orgId comes from the active-dept dropdown (validated
      // server-side via assertOrgActive — a forged/inactive id is rejected).
      if (actorIsAdmin && orgId) body.orgId = orgId;
      const res = await fetch(`${API_BASE}/admin/users`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success("用户已创建");
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
      <h3 className="text-sm font-medium text-gray-700">创建新用户</h3>
      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className="text-xs text-gray-500">Username</label>
          <input value={username} onChange={e => setUsername(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">Role{!actorIsAdmin && "（仅 user）"}</label>
          <select value={role} onChange={e => setRole(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5">
            <option value="user">user</option>
            {actorIsAdmin && <option value="org_admin">org_admin</option>}
            {actorIsAdmin && <option value="admin">admin</option>}
          </select>
        </div>
        {actorIsAdmin && (
          <div>
            <label className="text-xs text-gray-500">所属部门</label>
            {orgsLoading ? (
              <div className="text-xs text-ink-muted mt-1.5">加载部门列表…</div>
            ) : orgsError ? (
              <div className="text-xs text-red-600 mt-1.5">
                {orgsError} <button type="button" onClick={onRetryOrgs} className="text-blue-600 hover:underline">重试</button>
              </div>
            ) : orgs.length === 0 ? (
              <div className="text-xs text-red-600 mt-1.5">无可用部门（需先开通部门）</div>
            ) : (
              <select value={orgId} onChange={e => setOrgId(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required>
                <option value="" disabled>选择部门…</option>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.id})</option>)}
              </select>
            )}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        {/* M3 final fix: never let create fall back to default-org from a
            broken org-options state. For admin the org must be positively
            selected AND the org-options fetch must be loaded + successful +
            non-empty — disable while saving, or while orgs are loading, or
            the orgs fetch failed, or there are no active depts, or no org is
            selected. org_admin has no org field (server forces JWT org), so
            the gate only applies to admin. */}
        <button type="submit"
          disabled={saving || (actorIsAdmin && (orgsLoading || !!orgsError || orgs.length === 0 || !orgId))}
          className="text-xs px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded disabled:opacity-50">
          {saving ? "创建中…" : "创建"}
        </button>
        <button type="button" onClick={onDone}
          className="text-xs px-3 py-1.5 border border-gray-200 rounded hover:bg-gray-50">
          取消
        </button>
      </div>
    </form>
  );
}
