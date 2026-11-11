import { useState, useEffect, useCallback } from "react";
import {
  PolicyPanel,
  NetworkPanel,
  authHeaders,
  type RuntimePolicy,
} from "../../components/AdminPanel";

const API_BASE = "/api";

export function PolicyPage() {
  const [policy, setPolicy] = useState<RuntimePolicy | null>(null);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/runtime/policy`, { headers: authHeaders() });
      if (res.ok) setPolicy(await res.json());
    } catch {}
  }, []);

  useEffect(() => { fetchPolicy(); }, [fetchPolicy]);

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 text-xs text-gray-500">当前生效的 RuntimePolicy（只读诊断）</div>
        <PolicyPanel policy={policy} />
      </div>
      <div>
        <div className="mb-3 text-xs text-gray-500">Network Policy（只读）</div>
        <NetworkPanel />
      </div>
    </div>
  );
}
