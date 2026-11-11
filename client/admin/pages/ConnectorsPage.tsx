import { useState, useEffect, useCallback, Fragment } from "react";
import { toast } from "sonner";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, EmptyState, ErrorState, RefreshButton, StatusBadge } from "../components/ui";

const API_BASE = "/api";

interface CatalogEntry {
  kind: string;
  displayName: string;
  description: string;
  allowedTools: string[];
  credentialFields: Array<{ name: string; label: string; required: boolean }>;
  authKind: "api_key" | "oauth2";
}

interface AuthorizationView {
  status: "none" | "pending_authorization" | "authorized" | "expired" | "failed";
  expiresAt: string | null;
}

interface InstanceView {
  id: string;
  catalogKind: string;
  name: string;
  status: "draft" | "ready" | "enabled" | "disabled";
  baseUrl: string;
  credentialsPresent: boolean;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
  authorization?: AuthorizationView;
}

// M1c minimal page: admin-only (sidebar hides for others; backend 403 is
// authoritative). Credential form is WRITE-ONLY — never prefilled, never
// echoed; success surfaces only credentialsPresent/status/configVersion.
export function ConnectorsPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [instances, setInstances] = useState<InstanceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [formKind, setFormKind] = useState("");
  const [formName, setFormName] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [creating, setCreating] = useState(false);

  const [credOpenId, setCredOpenId] = useState<string | null>(null);
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [credSaving, setCredSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);

  const catalogByKind = (kind: string) => catalog.find((c) => c.kind === kind);
  const isOAuthKind = (kind: string) => catalogByKind(kind)?.authKind === "oauth2";

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [catRes, instRes] = await Promise.all([
        fetch(`${API_BASE}/admin/connectors/catalog`, { headers: authHeaders() }),
        fetch(`${API_BASE}/admin/connectors/instances`, { headers: authHeaders() }),
      ]);
      if (!catRes.ok || !instRes.ok) throw new Error(`HTTP ${catRes.status}/${instRes.status}`);
      setCatalog((await catRes.json()).connectors ?? []);
      setInstances((await instRes.json()).instances ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    if (formKind === "" && catalog.length > 0) setFormKind(catalog[0].kind);
  }, [catalog, formKind]);

  // M2b: OAuth callback lands here with ?oauth=success|error (no token in URL).
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("oauth");
    if (flag === "success") toast.success("飞书授权成功");
    if (flag === "error") toast.error("飞书授权失败（state 无效/过期或交换失败）");
    if (flag) {
      window.history.replaceState({}, "", "/admin/connectors");
      fetchAll();
    }
  }, [fetchAll]);

  const handleCreate = async (): Promise<void> => {
    const oauth = isOAuthKind(formKind);
    if (!formKind || !formName.trim() || (!oauth && !formBaseUrl.trim())) {
      toast.error(oauth ? "请填写 kind 与名称" : "请填写 kind、名称与 Base URL");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`${API_BASE}/admin/connectors/instances`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(
          oauth
            ? { catalogKind: formKind, name: formName.trim() }
            : { catalogKind: formKind, name: formName.trim(), baseUrl: formBaseUrl.trim() }
        ),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(`创建失败 (HTTP ${res.status})${data.error ? `：${data.error}` : ""}`);
        return;
      }
      toast.success(
        oauth ? "实例已创建（draft 状态），写入 App 凭证并完成 OAuth 授权后可启用" : "实例已创建（draft 状态），写入凭证后可启用"
      );
      setFormName("");
      setFormBaseUrl("");
      await fetchAll();
    } finally {
      setCreating(false);
    }
  };

  const handleSaveCredentials = async (inst: InstanceView): Promise<void> => {
    const fields = catalogByKind(inst.catalogKind)?.credentialFields ?? [];
    const missing = fields.filter((f) => f.required && !credValues[f.name]?.trim());
    if (missing.length > 0 || Object.keys(credValues).length === 0) {
      toast.error(`请填写必填凭证字段：${(missing.length ? missing : fields).map((f) => f.name).join(", ")}`);
      return;
    }
    setCredSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/connectors/instances/${encodeURIComponent(inst.id)}/credentials`, {
        method: "PUT",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          values: Object.fromEntries(
            fields.map((f) => [f.name, credValues[f.name] ?? ""]).filter(([, v]) => String(v).trim() !== "")
          ),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(`凭证写入失败 (HTTP ${res.status})${data.error ? `：${data.error}` : ""}`);
        return;
      }
      const updated = ((await res.json()).instance ?? {}) as InstanceView;
      // Success surfaces ONLY the secret-free view fields.
      toast.success(
        `凭证已写入 — credentialsPresent=${updated.credentialsPresent} status=${updated.status} configVersion=${updated.configVersion}` +
          (updated.authorization ? ` 授权=${updated.authorization.status}` : "")
      );
      setCredValues({});
      setCredOpenId(null);
      await fetchAll();
    } finally {
      setCredSaving(false);
    }
  };

  // M2b: open the Feishu consent page in a new tab. The authorize URL carries
  // only client_id + one-time state + PKCE challenge — no secret material.
  const handleStartOAuth = async (inst: InstanceView): Promise<void> => {
    setAuthorizing(true);
    try {
      const res = await fetch(`${API_BASE}/admin/connectors/instances/${encodeURIComponent(inst.id)}/oauth/start`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.authorizeUrl) {
        toast.error(`发起授权失败 (HTTP ${res.status})${data.error ? `：${data.error}` : ""}`);
        return;
      }
      toast.success("已发起授权 — 请在新窗口完成飞书授权");
      window.open(String(data.authorizeUrl), "_blank", "noopener");
      await fetchAll();
    } finally {
      setAuthorizing(false);
    }
  };

  const handleToggle = async (inst: InstanceView): Promise<void> => {
    const action = inst.status === "enabled" ? "disable" : "enable";
    const res = await fetch(`${API_BASE}/admin/connectors/instances/${encodeURIComponent(inst.id)}/${action}`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(`${action === "enable" ? "启用" : "禁用"}失败 (HTTP ${res.status})${data.error ? `：${data.error}` : ""}`);
      return;
    }
    toast.success(`实例 ${inst.name} 已${action === "enable" ? "启用" : "禁用"}`);
    await fetchAll();
  };

  const statusTone = (s: InstanceView["status"]) =>
    s === "enabled" ? "green" : s === "ready" ? "blue" : s === "disabled" ? "red" : "gray";

  return (
    <div>
      <AdminPageHeader
        title="Connectors"
        description={`共 ${instances.length} 个连接器实例，${instances.filter((i) => i.status === "enabled").length} 个已启用 — 凭证仅 host 侧解密使用，永不回显`}
        actions={<RefreshButton onClick={fetchAll} loading={loading} />}
      />

      {loading ? (
        <div className="text-sm text-ink-muted py-4 text-center">加载中…</div>
      ) : loadError ? (
        <ErrorState title="Connector 数据加载失败" hint="请检查后端服务后重试" onRetry={fetchAll} />
      ) : (
        <>
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-ink-primary mb-2">Catalog（平台内置连接器类型）</h3>
            {catalog.length === 0 ? (
              <EmptyState icon="🧩" title="Catalog 为空" hint="平台 catalog 为代码内置，新增类型需代码变更" />
            ) : (
              <div className="flex flex-col gap-2">
                {catalog.map((c) => (
                  <div key={c.kind} className="rounded-md border border-line-subtle bg-surface-card px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink-primary">{c.displayName}</span>
                      <StatusBadge tone="purple">{c.kind}</StatusBadge>
                    </div>
                    <p className="text-xs text-ink-muted mt-1">{c.description}</p>
                    <p className="text-xs text-ink-muted mt-0.5">工具：{c.allowedTools.join(", ")}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mb-6">
            <h3 className="text-sm font-semibold text-ink-primary mb-2">新建实例</h3>
            <div className="rounded-md border border-line-subtle bg-surface-card p-4 flex flex-wrap gap-3 items-end">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-muted">类型</span>
                <select
                  value={formKind}
                  onChange={(e) => setFormKind(e.target.value)}
                  className="border border-line-subtle rounded px-2 py-1.5 text-sm bg-surface-page"
                >
                  {catalog.map((c) => <option key={c.kind} value={c.kind}>{c.displayName}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-muted">名称</span>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="my-internal-api"
                  className="border border-line-subtle rounded px-2 py-1.5 text-sm w-48 bg-surface-page"
                />
              </label>
              {!isOAuthKind(formKind) && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-muted">Base URL</span>
                  <input
                    value={formBaseUrl}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                    placeholder="http://internal-api.local:8080/api/v1"
                    className="border border-line-subtle rounded px-2 py-1.5 text-sm w-72 bg-surface-page"
                  />
                </label>
              )}
              {isOAuthKind(formKind) && (
                <span className="text-xs text-ink-muted self-center">
                  飞书固定端点（授权与 API 地址由平台固定，无需填写）
                </span>
              )}
              <button
                onClick={handleCreate}
                disabled={creating}
                className="rounded bg-blue-600 text-white px-3 py-1.5 text-sm rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? "创建中…" : "创建"}
              </button>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-ink-primary mb-2">实例</h3>
            {instances.length === 0 ? (
              <EmptyState icon="🔌" title="暂无连接器实例" hint="用上方表单创建第一个实例" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-muted border-b border-line-subtle">
                    <th className="py-2 pr-3">名称</th>
                    <th className="py-2 pr-3">状态</th>
                    <th className="py-2 pr-3">Base URL</th>
                    <th className="py-2 pr-3">凭证</th>
                    <th className="py-2 pr-3">授权</th>
                    <th className="py-2 pr-3">configVersion</th>
                    <th className="py-2 pr-3">更新时间</th>
                    <th className="py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {instances.map((inst) => {
                    const fields = catalogByKind(inst.catalogKind)?.credentialFields ?? [];
                    const auth = inst.authorization;
                    const authTone =
                      auth?.status === "authorized" ? "green" :
                      auth?.status === "pending_authorization" ? "blue" :
                      auth?.status === "expired" || auth?.status === "failed" ? "red" : "gray";
                    const canEnable =
                      inst.status !== "draft" &&
                      (!auth || auth.status === "authorized");
                    return (
                    <Fragment key={inst.id}>
                      <tr className="border-b border-line-subtle">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-ink-primary">{inst.name}</div>
                          <div className="text-xs text-ink-muted">{inst.catalogKind}</div>
                        </td>
                        <td className="py-2 pr-3"><StatusBadge tone={statusTone(inst.status)}>{inst.status}</StatusBadge></td>
                        <td className="py-2 pr-3 text-xs text-ink-muted break-all max-w-xs">
                          {inst.baseUrl || "（飞书固定端点）"}
                        </td>
                        <td className="py-2 pr-3">{inst.credentialsPresent ? "已写入" : "未写入"}</td>
                        <td className="py-2 pr-3">
                          {auth ? (
                            <div>
                              <StatusBadge tone={authTone}>{auth.status}</StatusBadge>
                              {auth.expiresAt && (
                                <div className="text-xs text-ink-muted mt-0.5">至 {auth.expiresAt.slice(0, 19)}</div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-ink-muted">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">{inst.configVersion}</td>
                        <td className="py-2 pr-3 text-xs text-ink-muted">{inst.updatedAt}</td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            <button
                              onClick={() => { setCredOpenId(credOpenId === inst.id ? null : inst.id); setCredValues({}); }}
                              className="rounded border border-line-subtle px-2 py-1 text-xs hover:bg-surface-page"
                            >
                              {inst.credentialsPresent ? "轮换凭证" : "写入凭证"}
                            </button>
                            {auth && (
                              <button
                                onClick={() => handleStartOAuth(inst)}
                                disabled={authorizing || !inst.credentialsPresent}
                                title={!inst.credentialsPresent ? "先写入 App 凭证（clientId/clientSecret）" : "打开飞书授权页"}
                                className="rounded border border-line-subtle px-2 py-1 text-xs hover:bg-surface-page disabled:opacity-40"
                              >
                                去授权
                              </button>
                            )}
                            <button
                              onClick={() => handleToggle(inst)}
                              disabled={!canEnable}
                              title={
                                inst.status === "draft"
                                  ? "写入凭证后才能启用"
                                  : !canEnable
                                  ? "完成 OAuth 授权（authorized）后才能启用"
                                  : undefined
                              }
                              className="rounded border border-line-subtle px-2 py-1 text-xs hover:bg-surface-page disabled:opacity-40"
                            >
                              {inst.status === "enabled" ? "禁用" : "启用"}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {credOpenId === inst.id && (
                        <tr className="border-b border-line-subtle bg-surface-page">
                          <td colSpan={8} className="py-2">
                            <div className="flex gap-2 items-center flex-wrap">
                              {fields.map((f) => (
                                <label key={f.name} className="flex flex-col gap-1">
                                  <span className="text-xs text-ink-muted">{f.label}（只写，永不回显）</span>
                                  <input
                                    type="password"
                                    autoComplete="new-password"
                                    value={credValues[f.name] ?? ""}
                                    onChange={(e) => setCredValues((v) => ({ ...v, [f.name]: e.target.value }))}
                                    placeholder={f.name}
                                    className="border border-line-subtle rounded px-2 py-1 text-sm w-56 bg-surface-card"
                                  />
                                </label>
                              ))}
                              <button
                                onClick={() => handleSaveCredentials(inst)}
                                disabled={credSaving}
                                className="rounded bg-blue-600 text-white px-2.5 py-1 text-xs rounded hover:bg-blue-700 disabled:opacity-50 self-end"
                              >
                                {credSaving ? "写入中…" : "保存"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
