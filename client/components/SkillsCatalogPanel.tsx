import { useEffect, useMemo, useState } from "react";
import { BookOpen, Search, X } from "lucide-react";

interface CatalogItem {
  name: string;
  description: string | null;
  namespace: string | null;
  updatedAt: string | null;
  version: string | null;
}

interface CatalogPayload {
  hubOnline: boolean;
  items: CatalogItem[];
}

interface SkillsCatalogPanelProps {
  open: boolean;
  onClose: () => void;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function SkillsCatalogPanel({ open, onClose }: SkillsCatalogPanelProps) {
  const [payload, setPayload] = useState<CatalogPayload>({ hubOnline: true, items: [] });
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    fetch("/api/skills/hub-catalog", { headers: authHeaders() })
      .then(async (res) => {
        if (!res.ok) throw new Error("catalog unavailable");
        return res.json() as Promise<CatalogPayload>;
      })
      .then((data) => {
        if (active) setPayload(data);
      })
      .catch(() => {
        if (active) setPayload({ hubOnline: false, items: [] });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return payload.items;
    return payload.items.filter((item) =>
      [item.name, item.description, item.namespace].some((value) =>
        value?.toLowerCase().includes(needle)
      )
    );
  }, [payload.items, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="presentation" onMouseDown={onClose}>
      <aside
        className="flex h-full w-full max-w-lg flex-col bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="技能目录"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <BookOpen className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-gray-900">技能目录</h2>
              <p className="text-xs text-gray-500">浏览 Skill Hub 已发布技能</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            title="关闭"
            aria-label="关闭技能目录"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="border-b border-gray-100 px-5 py-3">
          <label className="flex h-10 items-center gap-2 border border-gray-300 bg-white px-3 focus-within:border-blue-500">
            <Search className="h-4 w-4 text-gray-400" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              placeholder="搜索技能"
              aria-label="搜索技能"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="py-12 text-center text-sm text-gray-500">正在加载...</div>
          ) : !payload.hubOnline ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-gray-700">技能目录暂时不可用</p>
              <p className="mt-1 text-xs text-gray-500">请稍后重试</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-gray-500">
              {query ? "未找到匹配技能" : "暂无已发布技能"}
            </div>
          ) : (
            <div className="grid gap-3">
              {filtered.map((item, index) => (
                <article key={`${item.namespace ?? "global"}:${item.name}:${index}`} className="border border-gray-200 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 text-sm font-semibold text-gray-900">{item.name}</h3>
                    {item.version && (
                      <span className="shrink-0 bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{item.version}</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm leading-5 text-gray-600">
                    {item.description || "暂无说明"}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                    <span>{item.namespace || "global"}</span>
                    {item.updatedAt && <span>更新于 {new Date(item.updatedAt).toLocaleDateString()}</span>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <footer className="border-t border-gray-200 px-5 py-3 text-xs text-gray-500">
          目录仅供参考，实际可用以管理员配置为准。
        </footer>
      </aside>
    </div>
  );
}
