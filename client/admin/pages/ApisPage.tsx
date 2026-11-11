import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { authHeaders } from "../../components/AdminPanel";
import { AdminPageHeader, EmptyState, RefreshButton } from "../components/ui";

const API_BASE = "/api";

interface RegisteredApi {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  apiUrl: string;
  method: string;
  status: string;
  timeoutMs: number;
  mcpWrapperPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export function ApisPage() {
  const [apis, setApis] = useState<RegisteredApi[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchApis = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/apis`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setApis(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchApis(); }, [fetchApis]);

  const handleDelete = async (id: string) => {
    if (!confirm("删除将同时卸载 MCP wrapper，确认？")) return;
    const res = await fetch(`${API_BASE}/admin/apis/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (res.ok) {
      toast.success("API 已删除，MCP wrapper 已卸载");
      await fetchApis();
    } else {
      toast.error("删除失败");
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="API 注册"
        description={`共 ${apis.length} 个注册 API — 注册后自动生成 MCP wrapper，出现在能力资源池中`}
        actions={
          <div className="flex gap-2">
            <RefreshButton onClick={fetchApis} />
            <button
              onClick={() => { setShowBatch(!showBatch); setShowForm(false); setEditingId(null); }}
              className="text-xs px-2.5 py-1 border border-purple-200 bg-purple-50 text-purple-700 rounded hover:bg-purple-100"
            >
              {showBatch ? "取消" : "📋 批量导入"}
            </button>
            <button
              onClick={() => { setShowForm(!showForm); setEditingId(null); setShowBatch(false); }}
              className="text-xs px-2.5 py-1 border border-blue-200 bg-blue-50 text-blue-700 rounded hover:bg-blue-100"
            >
              {showForm ? "取消" : "+ 注册 API"}
            </button>
          </div>
        }
      />

      {showBatch && (
        <BatchImport onDone={() => { setShowBatch(false); fetchApis(); }} />
      )}

      {showForm && (
        <ApiForm
          editingApi={editingId ? apis.find(a => a.id === editingId) ?? null : null}
          onDone={() => { setShowForm(false); setEditingId(null); fetchApis(); }}
        />
      )}

      {apis.length === 0 ? (
        <EmptyState icon="🔌" title="暂无注册 API" hint="点击「注册 API」创建单个，或「批量导入」粘贴 JSON 数组" />
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Display Name</th>
                <th className="px-3 py-2 font-medium">Method</th>
                <th className="px-3 py-2 font-medium">URL</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">MCP</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {apis.map((api) => (
                <tr key={api.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono text-gray-700">{api.name}</td>
                  <td className="px-3 py-2 text-gray-600">{api.displayName}</td>
                  <td className="px-3 py-2"><span className="font-mono px-1.5 py-0.5 bg-gray-100 rounded">{api.method}</span></td>
                  <td className="px-3 py-2 text-gray-500 max-w-xs truncate">{api.apiUrl}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${api.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                      {api.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {api.mcpWrapperPath ? (
                      <span className="text-green-600">✓ installed</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => { setEditingId(api.id); setShowForm(true); }}
                        className="text-blue-600 hover:underline"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleDelete(api.id)}
                        className="text-red-500 hover:underline"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BatchImport({ onDone }: { onDone: () => void }) {
  const [jsonText, setJsonText] = useState("");
  const [preview, setPreview] = useState<any[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const SAMPLE = `[
  {
    "name": "get_user_info",
    "displayName": "获取用户信息",
    "apiUrl": "http://internal-api/users",
    "method": "GET",
    "description": "根据 ID 查询用户基本信息",
    "timeoutMs": 10000
  },
  {
    "name": "create_order",
    "displayName": "创建订单",
    "apiUrl": "http://internal-api/orders",
    "method": "POST",
    "description": "创建新订单",
    "timeoutMs": 15000
  }
]`;

  const handleParse = () => {
    setParseError(null);
    if (!jsonText.trim()) {
      setPreview(null);
      return;
    }
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) {
        setParseError("JSON 必须是数组");
        setPreview(null);
        return;
      }
      for (const item of parsed) {
        if (!item.name || !item.apiUrl || !item.method) {
          setParseError(`每项必须包含 name, apiUrl, method 字段（缺少于: ${JSON.stringify(item).slice(0, 60)}…）`);
          setPreview(null);
          return;
        }
        if (item.method !== "GET" && item.method !== "POST") {
          setParseError(`method 只支持 GET/POST（${item.name}: ${item.method}）`);
          setPreview(null);
          return;
        }
      }
      setPreview(parsed);
    } catch (e: any) {
      setParseError(`JSON 解析失败: ${e.message}`);
      setPreview(null);
    }
  };

  const handleImport = async () => {
    if (!preview || preview.length === 0) return;
    setImporting(true);
    try {
      const res = await fetch(`${API_BASE}/admin/apis/batch`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ apis: preview }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`批量导入完成：成功 ${data.success} 条${data.failed > 0 ? `，失败 ${data.failed} 条` : ""}`);
        if (data.errors?.length > 0) {
          data.errors.forEach((e: any) => {
            toast.error(`#${e.index + 1} ${e.name ?? ""}: ${e.error}`);
          });
        }
        onDone();
      } else {
        toast.error(data.error || "批量导入失败");
      }
    } catch (e: any) {
      toast.error(`请求失败: ${e.message}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mb-4 p-4 bg-purple-50 border border-purple-200 rounded-lg">
      <div className="text-xs font-semibold text-purple-800 mb-2">📋 批量导入 API</div>
      <div className="text-xs text-purple-600 mb-2">
        粘贴 JSON 数组，每项需包含 <code className="bg-white px-1 rounded">name</code>,{" "}
        <code className="bg-white px-1 rounded">apiUrl</code>,{" "}
        <code className="bg-white px-1 rounded">method</code>（GET/POST）。可选: displayName, description, timeoutMs, requestParamsSchema, responseMapping
      </div>
      <textarea
        value={jsonText}
        onChange={(e) => { setJsonText(e.target.value); setPreview(null); setParseError(null); }}
        placeholder={SAMPLE}
        rows={8}
        className="w-full text-xs font-mono p-2 border border-purple-200 rounded bg-white focus:outline-none focus:border-purple-400"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleParse}
          disabled={!jsonText.trim()}
          className="text-xs px-3 py-1 border border-purple-300 bg-white text-purple-700 rounded hover:bg-purple-100 disabled:opacity-40"
        >
          预览校验
        </button>
        {preview && preview.length > 0 && (
          <button
            onClick={handleImport}
            disabled={importing}
            className="text-xs px-3 py-1 border border-green-300 bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:opacity-40"
          >
            {importing ? "导入中…" : `确认导入 ${preview.length} 条`}
          </button>
        )}
        <button
          onClick={() => { setJsonText(SAMPLE); setPreview(null); setParseError(null); }}
          className="text-xs px-2 py-1 text-purple-500 hover:underline"
        >
          填入示例
        </button>
      </div>
      {parseError && (
        <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
          ❌ {parseError}
        </div>
      )}
      {preview && preview.length > 0 && (
        <div className="mt-3 bg-white border border-purple-200 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-purple-100 text-purple-700 text-left">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">name</th>
                <th className="px-2 py-1.5 font-medium">method</th>
                <th className="px-2 py-1.5 font-medium">apiUrl</th>
                <th className="px-2 py-1.5 font-medium">description</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((item, i) => (
                <tr key={i} className="border-t border-purple-100">
                  <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                  <td className="px-2 py-1.5 font-mono text-gray-700">{item.name}</td>
                  <td className="px-2 py-1.5"><span className="font-mono px-1 bg-gray-100 rounded">{item.method}</span></td>
                  <td className="px-2 py-1.5 text-gray-500 max-w-xs truncate">{item.apiUrl}</td>
                  <td className="px-2 py-1.5 text-gray-400">{item.description ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ApiForm({ editingApi, onDone }: { editingApi: RegisteredApi | null; onDone: () => void }) {
  const [name, setName] = useState(editingApi?.name ?? "");
  const [displayName, setDisplayName] = useState(editingApi?.displayName ?? "");
  const [description, setDescription] = useState(editingApi?.description ?? "");
  const [apiUrl, setApiUrl] = useState(editingApi?.apiUrl ?? "");
  const [method, setMethod] = useState(editingApi?.method ?? "GET");
  const [requestParamsSchema, setRequestParamsSchema] = useState('{"type":"object","properties":{}}');
  const [responseMapping, setResponseMapping] = useState('{}');
  const [timeoutMs, setTimeoutMs] = useState(editingApi?.timeoutMs ?? 30000);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      let parsedSchema, parsedMapping;
      try {
        parsedSchema = JSON.parse(requestParamsSchema);
      } catch {
        toast.error("Request Params Schema 不是有效 JSON");
        setSaving(false);
        return;
      }
      try {
        parsedMapping = JSON.parse(responseMapping);
      } catch {
        toast.error("Response Mapping 不是有效 JSON");
        setSaving(false);
        return;
      }

      const body = {
        name, displayName, description: description || null,
        apiUrl, method, requestParamsSchema: parsedSchema,
        responseMapping: parsedMapping, timeoutMs,
      };

      const url = editingApi
        ? `${API_BASE}/admin/apis/${encodeURIComponent(editingApi.id)}`
        : `${API_BASE}/admin/apis`;
      const res = await fetch(url, {
        method: editingApi ? "PATCH" : "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(editingApi ? "API 已更新，MCP wrapper 已重新生成" : "API 已注册，MCP wrapper 已安装");
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
      <h3 className="text-sm font-medium text-gray-700">{editingApi ? "编辑 API" : "注册新 API"}</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-500">Name (唯一标识)</label>
          <input value={name} onChange={e => setName(e.target.value)} disabled={!!editingApi}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5 disabled:bg-gray-50" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">Display Name</label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">API URL</label>
          <input value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="http://internal-api/endpoint"
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" required />
        </div>
        <div>
          <label className="text-xs text-gray-500">Method</label>
          <select value={method} onChange={e => setMethod(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5">
            <option>GET</option><option>POST</option>
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs text-gray-500">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)}
          className="w-full text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" />
      </div>
      <div>
        <label className="text-xs text-gray-500">Request Params Schema (JSON)</label>
        <textarea value={requestParamsSchema} onChange={e => setRequestParamsSchema(e.target.value)} rows={4}
          className="w-full text-xs font-mono border border-gray-200 rounded px-2 py-1 mt-0.5" />
      </div>
      <div>
        <label className="text-xs text-gray-500">Response Mapping (JSON: paramName → jsonPath)</label>
        <textarea value={responseMapping} onChange={e => setResponseMapping(e.target.value)} rows={3}
          className="w-full text-xs font-mono border border-gray-200 rounded px-2 py-1 mt-0.5" />
      </div>
      <div>
        <label className="text-xs text-gray-500">Timeout (ms)</label>
        <input type="number" value={timeoutMs} onChange={e => setTimeoutMs(Number(e.target.value))}
          className="text-sm border border-gray-200 rounded px-2 py-1 mt-0.5" />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving}
          className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
          {saving ? "保存中…" : editingApi ? "更新 + 重生成 MCP" : "注册 + 安装 MCP"}
        </button>
        <button type="button" onClick={onDone}
          className="text-xs px-3 py-1.5 border border-gray-200 rounded hover:bg-gray-50">
          取消
        </button>
      </div>
    </form>
  );
}
