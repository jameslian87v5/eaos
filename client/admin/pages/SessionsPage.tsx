import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  ContainerTable,
  authHeaders,
  type RuntimeView,
  type StopResult,
} from "../../components/AdminPanel";
import { AdminPageHeader, EmptyState, RefreshButton, SearchInput } from "../components/ui";

const API_BASE = "/api";

export function SessionsPage() {
  const [runtimes, setRuntimes] = useState<RuntimeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const fetchContainers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/containers`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRuntimes(data.runtimes ?? []);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchContainers();
    const timer = setInterval(fetchContainers, 5000);
    return () => clearInterval(timer);
  }, [fetchContainers]);

  const handleStop = async (chatId: string): Promise<StopResult | null> => {
    const res = await fetch(`${API_BASE}/admin/containers/${chatId}/stop`, {
      method: "POST",
      headers: authHeaders(),
    });
    const data: StopResult = await res.json();
    await fetchContainers();
    return data;
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return runtimes;
    const q = search.toLowerCase();
    return runtimes.filter(r => r.chatId.toLowerCase().includes(q) || r.userId.toLowerCase().includes(q));
  }, [runtimes, search]);

  return (
    <div>
      <AdminPageHeader
        title="会话"
        description={`活跃 runtime：${runtimes.length}，每 5 秒自动刷新`}
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="搜索 chatId / userId…" />
            <RefreshButton onClick={fetchContainers} />
          </>
        }
      />
      {loading ? (
        <div className="text-sm text-gray-400 py-4">加载中…</div>
      ) : runtimes.length === 0 ? (
        <EmptyState icon="🖥️" title="无活跃 Runtime" hint="用户开始对话后，Agent Runtime 会出现在这里" />
      ) : filtered.length === 0 ? (
        <EmptyState icon="🔍" title="无匹配结果" hint="尝试调整搜索条件" />
      ) : (
        <ContainerTable runtimes={filtered} onStop={handleStop} loading={loading} />
      )}
    </div>
  );
}
