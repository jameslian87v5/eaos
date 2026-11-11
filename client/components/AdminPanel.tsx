import { useState, useEffect, useCallback, Fragment } from "react";

const API_BASE = "/api";

export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Types ───────────────────────────────────────────────────

export interface RuntimeView {
  userId: string;
  chatId: string;
  status: string;
  containerId: string | null;
  hostPort: number | null;
  restoreMode: string | null;
  restartCount: number;
  subscriberCount: number;
  isAgentBusy: boolean;
  hasPendingApproval: boolean;
  lastActivityAt: string | null;
  idleMs: number | null;
  lastError: string | null;
  sdkInit: SDKInitView | null;
}

export interface SkillView {
  name: string;
  type: string;
  enabled: boolean;
  path: string;
  version: string;
  description: string;
  pluginName: string;
  declaredSkillNames: string[];
  valid: boolean;
  error?: string;
  // M3a supply-chain metadata (optional; legacy rows resolve sourceKind "local"
  // server-side without rewriting the config file).
  sourceKind?: string;
  copyPolicy?: string;
  sha256?: string;
  importedAt?: string;
  // M3b fix round: server-authoritative import-time script flag — the review
  // warning must never depend on client-local state.
  hasScripts?: boolean;
}

export interface McpView {
  name: string;
  type: string; // "local" (stdio) in MVP
  enabled: boolean;
  path: string;
  version?: string;
  description?: string;
  command: string; // backend-generated: /opt/agent/mcp/<name>/run.sh
  valid: boolean;
  error?: string;
}

// Phase 5 (MP5d): reusable Agent Profile (mirrors server AgentProfile).
export interface ProfileView {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  toolsConfig: { tools: string[]; allowedTools: string[]; disallowedTools: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

// Phase 5 (MP5f): admin Agents view — an Agent with the per-Agent prompt
// overrides folded in (mirrors server listAllAgents). systemPrompt /
// appendSystemPrompt are the OVERRIDE values (NULL → fall through to the assigned
// profile, then the platform default) under resolve() precedence
// per-Agent override > profile > platform.
export interface AgentWithOverridesView {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  profileId: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Control-plane views (mirror server CapabilityResourceView / EntitlementEntry).
export interface CapabilityResourceView {
  resourceId: string;
  type: "skill" | "mcp" | "hook-plugin";
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  status: "active" | "disabled" | "deprecated" | "invalid";
  valid: boolean;
  error?: string;
}

export interface EntitlementEntry {
  resourceId: string;
  scopeType: "org" | "user";
  scopeId: string;
  effect: "allow" | "deny";
  grantedBy?: string;
  grantedAt?: string;
}

export interface SDKInitView {
  model?: string;
  cwd?: string;
  tools: string[];
  slashCommands: string[];
  skills: string[];
  plugins: Array<{ name?: string; path?: string }>;
}

export interface RuntimePolicy {
  idleStopMs?: number;
  protectWhenBusy?: boolean;
  protectWhenPendingApproval?: boolean;
  protectWhenSubscribers?: boolean;
  deleteChatRemovesVolumes?: boolean;
  [key: string]: unknown;
}

export interface RuntimeSettings {
  idleStopMs: number;
  memoryMb: number;
  cpuCores: number;
  maxTurns: number;
  maxWorkspaceMb: number;
  maxClaudeHomeMb: number;
  // Stage 2 (coarse global model management). Optional: older drafts/responses
  // may predate these fields; the server normalizes + validates (defaultModel
  // must be an enabled alias).
  defaultModel?: string;
  models?: Array<{ alias: string; enabled: boolean }>;
  // M4 (Auto Compact): platform-default compaction policy. These values double
  // as the ORG overlay ceilings (compact-policy.ts getCompactionCaps) — lowering
  // them immediately re-clamps every stored org value on read
  // (组织值受平台上限约束).
  contextCompaction?: {
    enabled: boolean;
    thresholdTokens: number;
    keepRecentTurns: number;
  };
}

// Phase 2e: platform-default prompt config (mirrors server PromptSettings).
export interface PromptSettings {
  systemPrompt: string;
  appendBase: string;
  maxSystemPromptChars: number;
}

// Phase 6 (A1): Application view (mirrors server Application).
export interface ApplicationView {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  profileId: string | null;
  entryUrl: string | null;
  apiKeyPrefix: string | null;
  status: string;
  lastUsedAt: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  toolAllowlist: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppCapabilityView {
  appId: string;
  resourceId: string;
  enabled: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────

export function fmtIdle(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtShort(id: string | null): string {
  return id ? id.slice(0, 8) + "…" : "—";
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: "bg-green-100 text-green-700",
    ready: "bg-green-100 text-green-700",
    stopping: "bg-yellow-100 text-yellow-700",
    stopped: "bg-gray-100 text-gray-500",
    crashed: "bg-red-100 text-red-700",
    unhealthy: "bg-red-100 text-red-700",
  };
  const cls = colors[status] ?? "bg-blue-100 text-blue-700";
  return <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${cls}`}>{status}</span>;
}

// ─── Capability Diagnostics (MP4c) ───────────────────────────
// Mirrors server DiagnosticsView (server/capability-diagnostics.ts).

interface DiagResource { resourceId: string; name?: string; version?: string; status?: string; }
interface DiagResolved {
  configVersion: string;
  sdkOptions: { tools: string[]; allowedTools: string[]; disallowedTools: string[]; skills: string[]; plugins: Array<{ type: string; path: string }>; mcpServers: Array<{ name: string; command: string }> };
  strictMcpConfig: boolean;
  mounts: Array<{ containerPath: string; resourceId: string; readonly: boolean; hostPathHash: string }>;
  envKeys: string[];
}
interface DiagDiscovered { skills: string[]; plugins: Array<{ name?: string; path?: string }>; tools: string[]; mcpServers: string[]; }
interface DiagView {
  agentId: string;
  configured: DiagResource[];
  resolved: DiagResolved | null;
  mounted: DiagResolved["mounts"];
  discovered: DiagDiscovered | null;
  stale: { isStale: boolean; resolvedVersion: string | null; currentVersion: string };
  diff: {
    configuredVsResolved: { addedSinceResolve: string[]; revokedSinceResolve: string[] };
    resolvedVsDiscovered: { injectedButUnseen: string[]; seenButNotInjected: string[] };
    resolvedVsDiscoveredMcp: { injectedButUnseen: string[]; seenButNotInjected: string[] };
  };
  recentTimeline: Array<{ eventType: string; createdAt: string; sequence: number }>;
}

function DiagColumn({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="bg-white border border-gray-200 rounded p-2">
      <div className="text-gray-500 text-[10px] mb-1">{title}</div>
      <div className="font-mono text-gray-700 break-all">
        {items.length ? items.map((i) => <div key={i}>{i}</div>) : <span className="text-gray-300">—</span>}
      </div>
    </div>
  );
}

export function DiagnosticsPanel({ agentId }: { agentId: string }) {
  const [diag, setDiag] = useState<DiagView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const fetchDiag = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/admin/agents/${encodeURIComponent(agentId)}/diagnostics`, { headers: authHeaders() });
      if (res.ok) setDiag(await res.json());
      else setErr(`HTTP ${res.status}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { fetchDiag(); }, [fetchDiag]);

  if (loading) return <div className="py-3 text-xs text-gray-400">诊断加载中…</div>;
  if (err) return <div className="py-3 text-xs text-red-500">诊断加载失败: {err}</div>;
  if (!diag) return null;

  const cfgIds = diag.configured.map((c) => c.resourceId);
  // resolved ids include MCP server names alongside plugin basenames (Phase 3) —
  // mirrors the backend getDiagnostics fix so the column matches configured.
  const resIds = [
    ...(diag.resolved?.sdkOptions.plugins ?? []).map((p) => p.path.split("/").pop() ?? ""),
    ...(diag.resolved?.sdkOptions.mcpServers ?? []).map((m) => m.name),
  ].filter(Boolean);
  const discSkills = diag.discovered?.skills ?? [];
  const discMcp = (diag.discovered?.mcpServers ?? []).map((m) => `mcp:${m}`);
  const driftFree =
    diag.diff.resolvedVsDiscovered.injectedButUnseen.length === 0 &&
    diag.diff.resolvedVsDiscoveredMcp.injectedButUnseen.length === 0 &&
    diag.diff.resolvedVsDiscoveredMcp.seenButNotInjected.length === 0 &&
    diag.diff.configuredVsResolved.revokedSinceResolve.length === 0;

  return (
    <div className="py-3 px-2 space-y-3 bg-gray-50 border-t">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${diag.stale.isStale ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700"}`}>
          {diag.stale.isStale ? "⚠ 配置陈旧(warm-resume 拿到旧 bundle)" : "✓ 配置新鲜"}
        </span>
        <span className="text-[10px] text-gray-400 font-mono">
          resolved={diag.stale.resolvedVersion ?? "—"} current={diag.stale.currentVersion}
        </span>
        <button onClick={fetchDiag} className="text-[10px] text-indigo-500 underline">刷新</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <DiagColumn title="configured(live 控制面)" items={cfgIds} />
        <DiagColumn title="resolved(上次 resolve)" items={resIds} />
        <DiagColumn title="mounted(挂载)" items={diag.mounted.map((m) => m.resourceId)} />
        <DiagColumn title="discovered(SDK 报告)" items={[...discSkills, ...discMcp]} />
      </div>

      <div className="space-y-1 text-xs">
        {diag.diff.resolvedVsDiscovered.injectedButUnseen.length > 0 && (
          <div className="text-red-600 bg-red-50 px-2 py-1 rounded">
            ⚠ 注入但 SDK 未发现: {diag.diff.resolvedVsDiscovered.injectedButUnseen.join(", ")}
            <span className="text-gray-400"> (注入断裂,如 hello-skill 失明)</span>
          </div>
        )}
        {diag.diff.configuredVsResolved.revokedSinceResolve.length > 0 && (
          <div className="text-yellow-700 bg-yellow-50 px-2 py-1 rounded">
            ⚠ resolve 后被撤销: {diag.diff.configuredVsResolved.revokedSinceResolve.join(", ")}
            <span className="text-gray-400"> (control-plane 漂移,stop/重发后生效)</span>
          </div>
        )}
        {diag.diff.configuredVsResolved.addedSinceResolve.length > 0 && (
          <div className="text-blue-700 bg-blue-50 px-2 py-1 rounded">
            ℹ resolve 后新增: {diag.diff.configuredVsResolved.addedSinceResolve.join(", ")}
            <span className="text-gray-400"> (stop/重发后注入)</span>
          </div>
        )}
        {diag.diff.resolvedVsDiscoveredMcp.injectedButUnseen.length > 0 && (
          <div className="text-red-600 bg-red-50 px-2 py-1 rounded">
            ⚠ MCP 注入但 SDK 未连接: {diag.diff.resolvedVsDiscoveredMcp.injectedButUnseen.join(", ")}
            <span className="text-gray-400"> (MCP server 启动/连接失败)</span>
          </div>
        )}
        {diag.diff.resolvedVsDiscoveredMcp.seenButNotInjected.length > 0 && (
          <div className="text-red-700 bg-red-100 px-2 py-1 rounded font-medium">
            🚨 SDK 发现未注入的 MCP: {diag.diff.resolvedVsDiscoveredMcp.seenButNotInjected.join(", ")}
            <span className="text-gray-400 font-normal"> (strictMcpConfig 下不该出现 = 文件发现泄漏)</span>
          </div>
        )}
        {driftFree && <div className="text-gray-400">无漂移 / 无注入断裂</div>}
      </div>

      {diag.recentTimeline.length > 0 && (
        <div className="text-xs">
          <div className="text-gray-500 mb-1">近期事件</div>
          <div className="space-y-0.5 max-h-32 overflow-y-auto font-mono text-[10px] text-gray-500">
            {diag.recentTimeline.map((e) => (
              <div key={e.sequence}>{e.createdAt.slice(11, 19)} · {e.eventType}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Container Table ─────────────────────────────────────────

export type StopResult = { status: "stopped" | "not_found" | "already_stopped"; chatId: string };

export function ContainerTable({
  runtimes,
  onStop,
  loading,
}: {
  runtimes: RuntimeView[];
  onStop: (chatId: string) => Promise<StopResult | null>;
  loading: boolean;
}) {
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopMsg, setStopMsg] = useState<StopResult | null>(null);
  const [diagOpen, setDiagOpen] = useState<string | null>(null);

  const handleStop = async (chatId: string) => {
    setStopping(chatId);
    setStopMsg(null);
    try {
      const result = await onStop(chatId);
      if (result && result.status !== "stopped") {
        setStopMsg(result);
      }
    } finally {
      setStopping(null);
    }
  };

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">加载中…</div>;
  }

  if (runtimes.length === 0) {
    return <div className="text-sm text-gray-400 py-8 text-center">暂无活跃 Agent Runtime</div>;
  }

  return (
    <div className="overflow-x-auto">
      {stopMsg && (
        <div className={`mb-2 text-xs px-3 py-1.5 rounded ${
          stopMsg.status === "not_found" ? "bg-red-50 text-red-600" : "bg-yellow-50 text-yellow-700"
        }`}>
          {stopMsg.status === "not_found" ? `⚠ Runtime not found for chat ${fmtShort(stopMsg.chatId)}` : `ℹ Runtime already stopped (${fmtShort(stopMsg.chatId)})`}
        </div>
      )}
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-left">
            <th className="px-3 py-2 font-medium border-b">chatId</th>
            <th className="px-3 py-2 font-medium border-b">userId</th>
            <th className="px-3 py-2 font-medium border-b">状态</th>
            <th className="px-3 py-2 font-medium border-b">busy</th>
            <th className="px-3 py-2 font-medium border-b">approval</th>
            <th className="px-3 py-2 font-medium border-b">SDK init</th>
            <th className="px-3 py-2 font-medium border-b">发现 skills/plugins</th>
            <th className="px-3 py-2 font-medium border-b">订阅者</th>
            <th className="px-3 py-2 font-medium border-b">空闲时长</th>
            <th className="px-3 py-2 font-medium border-b">重启次数</th>
            <th className="px-3 py-2 font-medium border-b">操作</th>
          </tr>
        </thead>
        <tbody>
          {runtimes.map((r) => (
            <Fragment key={r.chatId}>
            <tr className="border-b hover:bg-gray-50">
              <td className="px-3 py-2 font-mono text-gray-600" title={r.chatId}>{fmtShort(r.chatId)}</td>
              <td className="px-3 py-2 font-mono text-gray-500" title={r.userId}>{fmtShort(r.userId)}</td>
              <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
              <td className="px-3 py-2">
                {r.isAgentBusy ? <span className="text-orange-500 font-medium">●</span> : <span className="text-gray-300">○</span>}
              </td>
              <td className="px-3 py-2">
                {r.hasPendingApproval ? <span className="text-yellow-500 font-medium">●</span> : <span className="text-gray-300">○</span>}
              </td>
              <td className="px-3 py-2">
                {r.sdkInit
                  ? <span className="text-green-600 font-medium" title={`model=${r.sdkInit.model || "unknown"} cwd=${r.sdkInit.cwd || "unknown"}`}>已收到</span>
                  : <span className="text-gray-400">未收到</span>}
              </td>
              <td className="px-3 py-2 max-w-[220px]">
                {r.sdkInit ? (
                  <div className="space-y-0.5">
                    <div className="font-mono text-gray-600 truncate" title={r.sdkInit.skills.join(", ") || "none"}>
                      skills: {r.sdkInit.skills.length ? r.sdkInit.skills.join(", ") : "none"}
                    </div>
                    <div className="font-mono text-gray-500 truncate" title={r.sdkInit.plugins.map((p) => `${p.name || "unknown"}:${p.path || ""}`).join(", ") || "none"}>
                      plugins: {r.sdkInit.plugins.length ? r.sdkInit.plugins.map((p) => p.name || p.path || "unknown").join(", ") : "none"}
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-center">{r.subscriberCount}</td>
              <td className="px-3 py-2 font-mono">{fmtIdle(r.idleMs)}</td>
              <td className="px-3 py-2 text-center">{r.restartCount}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <button
                  onClick={() => setDiagOpen((cur) => (cur === r.chatId ? null : r.chatId))}
                  className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-200 rounded hover:bg-indigo-100 mr-1"
                >
                  {diagOpen === r.chatId ? "收起" : "诊断"}
                </button>
                <button
                  onClick={() => handleStop(r.chatId)}
                  disabled={stopping === r.chatId || r.status === "stopped" || r.status === "stopping"}
                  className="text-xs px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 disabled:opacity-40"
                >
                  {stopping === r.chatId ? "停止中…" : "Stop"}
                </button>
              </td>
            </tr>
            {diagOpen === r.chatId && (
              <tr>
                <td colSpan={11} className="p-0">
                  <DiagnosticsPanel agentId={r.chatId} />
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {runtimes.some((r) => r.lastError) && (
        <div className="mt-3 space-y-1">
          {runtimes.filter((r) => r.lastError).map((r) => (
            <div key={r.chatId} className="text-xs text-red-600 bg-red-50 px-3 py-1.5 rounded">
              <span className="font-mono">{fmtShort(r.chatId)}</span>: {r.lastError}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Skill Table ─────────────────────────────────────────────

export function SkillTable({
  skills,
  runtimes,
  onToggle,
}: {
  skills: SkillView[];
  runtimes: RuntimeView[];
  // R1: optional — org_admin gets a read-only view (global toggle is admin-only);
  // undefined → render "—" in the action cell instead of a toggle button.
  onToggle?: (name: string, enabled: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  // SDK plugin skills are reported as `plugin-name:skill-name`, so match by prefix.
  const sdkDiscoveredCount = (pluginName: string): number =>
    runtimes.filter((r) => r.sdkInit?.skills.some((skill) => skill.startsWith(`${pluginName}:`))).length;

  const toggle = async (name: string, enabled: boolean) => {
    if (!onToggle) return;
    setBusy(name);
    try {
      await onToggle(name, enabled);
    } finally {
      setBusy(null);
    }
  };

  if (skills.length === 0) {
    return (
      <div className="text-sm text-gray-400 py-8 text-center">
        暂无 skill 配置。编辑 <code className="bg-gray-100 px-1 rounded">data/skills.json</code> 添加。
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
        ⚠️ Skill 配置变更只对<strong>新启动</strong>的 Agent Runtime 生效。如需让已有对话使用新配置，请先 Stop 该对话的 runtime，再继续对话。
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 text-gray-500 text-left">
              <th className="px-3 py-2 font-medium border-b">name</th>
              <th className="px-3 py-2 font-medium border-b">type</th>
              <th className="px-3 py-2 font-medium border-b">来源</th>
              <th className="px-3 py-2 font-medium border-b">enabled</th>
              <th className="px-3 py-2 font-medium border-b">version</th>
              <th className="px-3 py-2 font-medium border-b">声明 skills</th>
              <th className="px-3 py-2 font-medium border-b">SDK 发现</th>
              <th className="px-3 py-2 font-medium border-b">path</th>
              <th className="px-3 py-2 font-medium border-b">状态</th>
              <th className="px-3 py-2 font-medium border-b">操作</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.name} className="border-b hover:bg-gray-50">
                <td className="px-3 py-2 font-mono font-medium">{s.name}</td>
                <td className="px-3 py-2 font-mono text-gray-500">{s.type}</td>
                <td className="px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded font-mono ${
                      s.sourceKind === "zip" ? "bg-purple-50 text-purple-700" : "bg-gray-100 text-gray-500"
                    }`}>{s.sourceKind || "—"}</span>
                    {s.copyPolicy && <span className="text-gray-400 font-mono">{s.copyPolicy}</span>}
                    {s.hasScripts && (
                      <span title="包内含 scripts/ 脚本——启用前必须审查" className="text-yellow-600">⚠️脚本</span>
                    )}
                  </div>
                  {s.importedAt && (
                    <div className="text-gray-400 text-[10px] mt-0.5 font-mono" title={`${s.importedAt}${s.sha256 ? `\n${s.sha256}` : ""}`}>
                      {s.importedAt.slice(0, 10)}{s.sha256 ? ` · ${s.sha256.replace(/^sha256:/, "").slice(0, 12)}…` : ""}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {s.enabled
                    ? <span className="text-green-600 font-medium">✓ 启用</span>
                    : <span className="text-gray-400">— 禁用</span>}
                </td>
                <td className="px-3 py-2 font-mono text-gray-500">{s.version || "—"}</td>
                <td className="px-3 py-2 font-mono text-gray-600 max-w-[180px] truncate" title={s.declaredSkillNames?.join(", ") || ""}>
                  {s.declaredSkillNames?.length ? s.declaredSkillNames.join(", ") : "—"}
                </td>
                <td className="px-3 py-2 font-mono">
                  {(() => {
                    const n = sdkDiscoveredCount(s.pluginName);
                    return n > 0
                      ? <span className="text-green-600">{n} 个 runtime</span>
                      : <span className="text-gray-400">—</span>;
                  })()}
                </td>
                <td className="px-3 py-2 font-mono text-gray-400 text-xs max-w-[200px] truncate" title={s.path}>{s.path}</td>
                <td className="px-3 py-2">
                  {s.valid
                    ? <span className="text-green-600 text-xs">✓ 有效</span>
                    : <span className="text-red-500 text-xs" title={s.error}>✗ {s.error}</span>}
                </td>
                <td className="px-3 py-2">
                  {onToggle ? (
                    <button
                      onClick={() => toggle(s.name, !s.enabled)}
                      disabled={busy === s.name || (!s.valid && !s.enabled)}
                      className={`text-xs px-2 py-0.5 rounded border disabled:opacity-40 ${
                        s.enabled
                          ? "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                          : "bg-green-50 text-green-600 border-green-200 hover:bg-green-100"
                      }`}
                      title={!s.valid && !s.enabled ? "无效 skill 不能启用" : undefined}
                    >
                      {busy === s.name ? "…" : s.enabled ? "禁用" : "启用"}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-xs text-gray-400">
        可通过本面板或 <code className="bg-gray-100 px-1 rounded">data/skills.json</code> 管理启停；skill 包必须包含 <code className="bg-gray-100 px-1 rounded">.codex-plugin/plugin.json</code> 和 <code className="bg-gray-100 px-1 rounded">skills/*/SKILL.md</code>。变更只对新启动的 Agent Runtime 生效。
        已有 runtime 请 Stop 后继续对话重新创建。
      </div>
    </div>
  );
}

// ─── MCP Table (Phase 3) ─────────────────────────────────────

export function McpTable({
  mcpServers,
  onToggle,
}: {
  mcpServers: McpView[];
  // R1: optional — org_admin gets a read-only view (global toggle is admin-only).
  onToggle?: (name: string, enabled: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (name: string, enabled: boolean) => {
    if (!onToggle) return;
    setBusy(name);
    try {
      await onToggle(name, enabled);
    } finally {
      setBusy(null);
    }
  };

  if (mcpServers.length === 0) {
    return (
      <div className="text-sm text-gray-400 py-8 text-center">
        暂无 MCP 配置。把包放在 <code className="bg-gray-100 px-1 rounded">mcp/&lt;name&gt;/</code>（含可执行 <code className="bg-gray-100 px-1 rounded">run.sh</code>），并在 <code className="bg-gray-100 px-1 rounded">data/mcp.json</code> 注册。
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
        ⚠️ MCP 配置变更只对<strong>新启动</strong>的 Agent Runtime 生效。如需让已有对话使用新配置，请先 Stop 该对话的 runtime，再继续对话。
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 text-gray-500 text-left">
              <th className="px-3 py-2 font-medium border-b">name</th>
              <th className="px-3 py-2 font-medium border-b">type</th>
              <th className="px-3 py-2 font-medium border-b">enabled</th>
              <th className="px-3 py-2 font-medium border-b">version</th>
              <th className="px-3 py-2 font-medium border-b">command（容器内）</th>
              <th className="px-3 py-2 font-medium border-b">path</th>
              <th className="px-3 py-2 font-medium border-b">状态</th>
              <th className="px-3 py-2 font-medium border-b">操作</th>
            </tr>
          </thead>
          <tbody>
            {mcpServers.map((m) => (
              <tr key={m.name} className="border-b hover:bg-gray-50">
                <td className="px-3 py-2 font-mono font-medium">{m.name}</td>
                <td className="px-3 py-2 font-mono text-gray-500">{m.type}</td>
                <td className="px-3 py-2">
                  {m.enabled
                    ? <span className="text-green-600 font-medium">✓ 启用</span>
                    : <span className="text-gray-400">— 禁用</span>}
                </td>
                <td className="px-3 py-2 font-mono text-gray-500">{m.version || "—"}</td>
                <td className="px-3 py-2 font-mono text-gray-600 max-w-[220px] truncate" title={m.command}>{m.command || "—"}</td>
                <td className="px-3 py-2 font-mono text-gray-400 text-xs max-w-[180px] truncate" title={m.path}>{m.path}</td>
                <td className="px-3 py-2">
                  {m.valid
                    ? <span className="text-green-600 text-xs">✓ 有效</span>
                    : <span className="text-red-500 text-xs" title={m.error}>✗ {m.error}</span>}
                </td>
                <td className="px-3 py-2">
                  {onToggle ? (
                    <button
                      onClick={() => toggle(m.name, !m.enabled)}
                      disabled={busy === m.name || (!m.valid && !m.enabled)}
                      className={`text-xs px-2 py-0.5 rounded border disabled:opacity-40 ${
                        m.enabled
                          ? "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                          : "bg-green-50 text-green-600 border-green-200 hover:bg-green-100"
                      }`}
                      title={!m.valid && !m.enabled ? "无效 MCP 不能启用" : undefined}
                    >
                      {busy === m.name ? "…" : m.enabled ? "禁用" : "启用"}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-xs text-gray-400">
        MCP 包必须含可执行 <code className="bg-gray-100 px-1 rounded">run.sh</code>；<code className="bg-gray-100 px-1 rounded">command</code> 由后端固定生成（<code className="bg-gray-100 px-1 rounded">/opt/agent/mcp/&lt;name&gt;/run.sh</code>），不接受前端任意 command。MCP tool 调用默认需审批。
      </div>
    </div>
  );
}

// ─── Agent Profile Manager (Phase 5 MP5d) ────────────────────

// Tool catalog entry (mirrors server ToolCatalogEntry)
interface ToolCatalogEntry {
  name: string;
  description: string;
  risk: "none" | "low" | "high";
  supported: boolean;
  defaultEnabled: boolean;
  requiresApproval: boolean;
}

// Fetch + cache tool catalog (module-level singleton)
let _toolCatalog: ToolCatalogEntry[] | null = null;
async function getToolCatalog(): Promise<ToolCatalogEntry[]> {
  if (_toolCatalog) return _toolCatalog;
  try {
    const res = await fetch(`${"/api"}/admin/tool-catalog`, { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      _toolCatalog = (data.catalog ?? []).filter((t: ToolCatalogEntry) => t.supported);
    }
  } catch {}
  return _toolCatalog ?? [];
}

// Tool config editor: lets admin pick which tools are exposed + auto-allowed
function ToolConfigEditor({
  value,
  onChange,
}: {
  value: { tools: string[]; allowedTools: string[]; disallowedTools: string[] } | null;
  onChange: (v: { tools: string[]; allowedTools: string[]; disallowedTools: string[] } | null) => void;
}) {
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  useEffect(() => { getToolCatalog().then(setCatalog); }, []);

  const enabled = value ?? { tools: [], allowedTools: [], disallowedTools: [] };

  const toggleTool = (name: string) => {
    const tools = enabled.tools.includes(name)
      ? enabled.tools.filter((t) => t !== name)
      : [...enabled.tools, name];
    const allowedTools = enabled.allowedTools.filter((t) => t !== name);
    onChange({ ...enabled, tools, allowedTools });
  };

  const toggleAllowed = (name: string) => {
    if (!enabled.tools.includes(name)) return;
    const allowedTools = enabled.allowedTools.includes(name)
      ? enabled.allowedTools.filter((t) => t !== name)
      : [...enabled.allowedTools, name];
    onChange({ ...enabled, allowedTools });
  };

  const reset = () => onChange(null);
  const enableAll = () => {
    onChange({
      tools: catalog.map((t) => t.name),
      allowedTools: catalog.filter((t) => !t.requiresApproval).map((t) => t.name),
      disallowedTools: [],
    });
  };

  return (
    <div className="border border-gray-200 rounded p-3 bg-white space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">Tool 配置（NULL = 走平台默认 profile）</span>
        <div className="flex gap-2">
          <button onClick={enableAll} className="text-xs px-2 py-0.5 border rounded hover:bg-gray-100">全选默认</button>
          <button onClick={reset} className="text-xs px-2 py-0.5 border rounded text-red-600 hover:bg-red-50">清除为 NULL</button>
        </div>
      </div>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-left">
            <th className="px-2 py-1 font-medium border-b">tool</th>
            <th className="px-2 py-1 font-medium border-b">risk</th>
            <th className="px-2 py-1 font-medium border-b">exposed</th>
            <th className="px-2 py-1 font-medium border-b">auto-allow</th>
          </tr>
        </thead>
        <tbody>
          {catalog.map((t) => (
            <tr key={t.name} className="border-b hover:bg-gray-50">
              <td className="px-2 py-1 font-mono">{t.name}<div className="text-gray-400 text-[10px]">{t.description}</div></td>
              <td className="px-2 py-1">
                <span className={t.risk === "high" ? "text-red-500" : t.risk === "low" ? "text-yellow-600" : "text-gray-400"}>{t.risk}</span>
              </td>
              <td className="px-2 py-1"><input type="checkbox" checked={enabled.tools.includes(t.name)} onChange={() => toggleTool(t.name)} /></td>
              <td className="px-2 py-1"><input type="checkbox" checked={enabled.allowedTools.includes(t.name)} disabled={!enabled.tools.includes(t.name)} onChange={() => toggleAllowed(t.name)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {value === null && <div className="text-xs text-gray-400 italic">当前为 NULL — resolve() 会使用平台 DEFAULT_PROFILE</div>}
    </div>
  );
}

export type ProfileInput = { name: string; description: string; systemPrompt: string; appendSystemPrompt: string; toolsConfig: { tools: string[]; allowedTools: string[]; disallowedTools: string[] } | null };

export function ProfileEditor({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ProfileInput;
  submitLabel: string;
  onSubmit: (vals: ProfileInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState(initial.appendSystemPrompt);
  const [toolsConfig, setToolsConfig] = useState(initial.toolsConfig);
  const [showTools, setShowTools] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setErr("name 必填"); return; }
    setSaving(true);
    setErr(null);
    try {
      await onSubmit({ name, description, systemPrompt, appendSystemPrompt, toolsConfig });
    } catch (e: any) {
      setErr(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 border border-indigo-200 rounded-lg bg-indigo-50/40 p-4 space-y-3 max-w-3xl">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-700">name</span>
        <input value={name} onChange={(e) => setName(e.target.value)}
          className="border border-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-700">description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)}
          className="border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-700">
          systemPrompt（留空 = NULL → 走 per-Agent / 平台默认优先级）
        </span>
        <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4}
          className="border border-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
        <span className="text-xs text-gray-400">{systemPrompt.length} 字符（控制字符服务端自动剥离）</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-700">appendSystemPrompt</span>
        <textarea value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} rows={4}
          className="border border-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
      </label>
      <div>
        <button onClick={() => setShowTools(!showTools)} className="text-xs px-2 py-1 border rounded hover:bg-gray-100">
          {showTools ? "收起 Tools" : "展开 Tools 配置"}
        </button>
        {toolsConfig ? (
          <span className="text-xs text-gray-400 ml-2">已配置 {toolsConfig.tools.length} 个 tools</span>
        ) : (
          <span className="text-xs text-gray-400 ml-2">NULL（走平台默认）</span>
        )}
      </div>
      {showTools && (
        <ToolConfigEditor
          value={toolsConfig}
          onChange={setToolsConfig}
        />
      )}
      <div className="flex items-center gap-3">
        <button onClick={submit} disabled={saving}
          className="text-xs px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
          {saving ? "保存中…" : submitLabel}
        </button>
        <button onClick={onCancel}
          className="text-xs px-3 py-1 border border-gray-200 bg-white text-gray-600 rounded hover:bg-gray-50">
          取消
        </button>
        {err && <span className="text-xs text-red-500">{err}</span>}
      </div>
    </div>
  );
}

export function ProfileManager({
  profiles,
  onCreate,
  onUpdate,
  onDelete,
}: {
  profiles: ProfileView[];
  onCreate: (input: ProfileInput) => Promise<void>;
  onUpdate: (id: string, input: ProfileInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"idle" | "create" | { edit: string }>("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [delErr, setDelErr] = useState<string | null>(null);

  const editing = typeof mode === "object" ? profiles.find((p) => p.id === mode.edit) ?? null : null;

  const handleDelete = async (p: ProfileView) => {
    if (!confirm(`删除 profile "${p.name}"？指向它的 Agent 会被解除分配（profile_id 置空）。`)) return;
    setBusy(p.id);
    setDelErr(null);
    try {
      await onDelete(p.id);
    } catch (e: any) {
      setDelErr(e.message || "删除失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="mb-3 text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
        ⚠️ Profile 变更只对<strong>新启动</strong>的 Agent Runtime 生效（同 Skill/MCP/Prompt）。优先级：
        per-Agent 覆盖 &gt; profile &gt; 平台默认。要把 profile 分配给具体 Agent，请在
        <strong> Agents</strong> 标签页操作。
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">共 {profiles.length} 个 profile（可复用角色模板）</span>
        <button
          onClick={() => setMode("create")}
          disabled={mode !== "idle"}
          className="text-xs px-2.5 py-1 bg-indigo-50 text-indigo-600 border border-indigo-200 rounded hover:bg-indigo-100 disabled:opacity-40"
        >
          + 新建 Profile
        </button>
      </div>

      {profiles.length === 0 ? (
        <div className="text-sm text-gray-400 py-6 text-center">
          暂无 profile。点「+ 新建 Profile」创建一个可复用的角色模板（systemPrompt 等）。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-3 py-2 font-medium border-b">name</th>
                <th className="px-3 py-2 font-medium border-b">description</th>
                <th className="px-3 py-2 font-medium border-b">systemPrompt</th>
                <th className="px-3 py-2 font-medium border-b">append</th>
                <th className="px-3 py-2 font-medium border-b">更新时间</th>
                <th className="px-3 py-2 font-medium border-b">操作</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium">{p.name}</td>
                  <td className="px-3 py-2 text-gray-600 max-w-[200px] truncate" title={p.description ?? ""}>{p.description || "—"}</td>
                  <td className="px-3 py-2 font-mono text-gray-500 max-w-[180px] truncate" title={p.systemPrompt ?? ""}>
                    {p.systemPrompt ? `${p.systemPrompt.length} 字` : <span className="text-gray-300">NULL(走默认)</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-500 max-w-[160px] truncate" title={p.appendSystemPrompt ?? ""}>
                    {p.appendSystemPrompt ? `${p.appendSystemPrompt.length} 字` : <span className="text-gray-300">NULL</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-400">{p.updatedAt.slice(0, 19).replace("T", " ")}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <button
                      onClick={() => setMode({ edit: p.id })}
                      disabled={mode !== "idle"}
                      className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 border border-blue-200 rounded hover:bg-blue-100 mr-1 disabled:opacity-40"
                    >编辑</button>
                    <button
                      onClick={() => handleDelete(p)}
                      disabled={busy === p.id || mode !== "idle"}
                      className="text-xs px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 disabled:opacity-40"
                    >{busy === p.id ? "…" : "删除"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {delErr && <div className="mt-2 text-xs text-red-500">{delErr}</div>}

      {mode === "create" && (
        <ProfileEditor
          initial={{ name: "", description: "", systemPrompt: "", appendSystemPrompt: "", toolsConfig: null }}
          submitLabel="创建"
          onCancel={() => setMode("idle")}
          onSubmit={async (v) => { await onCreate(v); setMode("idle"); }}
        />
      )}
      {editing && (
        <ProfileEditor
          initial={{
            name: editing.name,
            description: editing.description ?? "",
            systemPrompt: editing.systemPrompt ?? "",
            appendSystemPrompt: editing.appendSystemPrompt ?? "",
            toolsConfig: editing.toolsConfig ?? null,
          }}
          submitLabel="保存"
          onCancel={() => setMode("idle")}
          onSubmit={async (v) => { await onUpdate(editing.id, v); setMode("idle"); }}
        />
      )}
    </div>
  );
}

// ─── Agent Assignment Manager (Phase 5 MP5f) ─────────────────

export type AgentAssignmentInput = {
  profileId: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
};

// Inline editor for ONE Agent: bind a reusable Profile + set per-Agent prompt
// overrides. Patches /api/agents/:id (owner or admin). Empty text → NULL → fall
// through under resolve() precedence (per-Agent override > profile > platform).
export function AgentAssignmentEditor({
  agent,
  profiles,
  maxChars,
  onSubmit,
  onCancel,
}: {
  agent: AgentWithOverridesView;
  profiles: ProfileView[];
  maxChars: number | undefined;
  onSubmit: (vals: AgentAssignmentInput) => Promise<void>;
  onCancel: () => void;
}) {
  // A dangling profileId (profile deleted in the Profiles tab) would not match any
  // <option>; default to "none" so saving clears it instead of 400-ing.
  const profileIdValid =
    agent.profileId != null && profiles.some((p) => p.id === agent.profileId);
  const [profileId, setProfileId] = useState(profileIdValid && agent.profileId ? agent.profileId : "");
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt ?? "");
  const [appendSystemPrompt, setAppendSystemPrompt] = useState(agent.appendSystemPrompt ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cap = maxChars ?? Number.POSITIVE_INFINITY;
  const sysOver = systemPrompt.length > cap;
  const appOver = appendSystemPrompt.length > cap;

  const submit = async () => {
    if (sysOver || appOver) { setErr("prompt 超长，服务端会拒绝"); return; }
    setSaving(true);
    setErr(null);
    try {
      await onSubmit({
        profileId: profileId === "" ? null : profileId,
        systemPrompt: systemPrompt.trim() === "" ? null : systemPrompt,
        appendSystemPrompt: appendSystemPrompt.trim() === "" ? null : appendSystemPrompt,
      });
    } catch (e: any) {
      setErr(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // Effective-resolve hint for systemPrompt under the precedence chain.
  const effectiveSystemHint = systemPrompt.trim()
    ? "per-Agent 覆盖（最高优先级）"
    : profileId !== ""
      ? `走 profile「${profiles.find((p) => p.id === profileId)?.name ?? "已删除"}」`
      : "走平台默认 systemPrompt";

  return (
    <div className="mt-3 border border-indigo-200 rounded-lg bg-indigo-50/40 p-4 space-y-3 max-w-3xl">
      <div className="text-xs text-gray-500">
        Agent <code className="font-mono bg-gray-100 px-1 rounded">{fmtShort(agent.id)}</code>
        {agent.title ? <> · <span className="text-gray-700">{agent.title}</span></> : null}
        {!profileIdValid && agent.profileId != null && (
          <span className="ml-2 text-yellow-700">⚠ 原 profile 已被删除，保存将清除分配</span>
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-700">
          分配 Profile（留空 = 无 profile → 走 per-Agent 覆盖 / 平台默认）
        </span>
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)}
          className="border border-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400">
          <option value="">— 无 profile —</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-700">
          per-Agent systemPrompt（留空 = NULL → {effectiveSystemHint}）
        </span>
        <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4}
          className={`border rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 ${
            sysOver ? "border-red-400 focus:ring-red-400" : "border-gray-200 focus:ring-indigo-400"
          }`} />
        <span className={`text-xs ${sysOver ? "text-red-600" : "text-gray-400"}`}>
          {systemPrompt.length}{maxChars ? ` / ${maxChars}` : ""} 字符（控制字符服务端自动剥离）
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-700">per-Agent appendSystemPrompt</span>
        <textarea value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} rows={4}
          className={`border rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 ${
            appOver ? "border-red-400 focus:ring-red-400" : "border-gray-200 focus:ring-indigo-400"
          }`} />
        <span className={`text-xs ${appOver ? "text-red-600" : "text-gray-400"}`}>
          {appendSystemPrompt.length}{maxChars ? ` / ${maxChars}` : ""} 字符
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button onClick={submit} disabled={saving}
          className="text-xs px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={onCancel}
          className="text-xs px-3 py-1 border border-gray-200 bg-white text-gray-600 rounded hover:bg-gray-50">
          取消
        </button>
        {err && <span className="text-xs text-red-500">{err}</span>}
      </div>
    </div>
  );
}

export function AgentsManager({
  agents,
  profiles,
  maxChars,
  onSave,
}: {
  agents: AgentWithOverridesView[];
  profiles: ProfileView[];
  maxChars: number | undefined;
  onSave: (agentId: string, vals: AgentAssignmentInput) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const profileName = (id: string | null): string | null =>
    id ? profiles.find((p) => p.id === id)?.name ?? "(已删除 profile)" : null;

  const handleSave = async (agentId: string, vals: AgentAssignmentInput) => {
    setBusy(agentId);
    try {
      await onSave(agentId, vals);
      setEditingId(null);
    } finally {
      setBusy(null);
    }
  };

  const editing = editingId ? agents.find((a) => a.id === editingId) ?? null : null;

  return (
    <div>
      <div className="mb-3 text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
        ⚠️ 分配 profile / per-Agent prompt 变更只对<strong>新启动</strong>的 Agent Runtime 生效（同 Profile/Skill/Prompt）。优先级：
        per-Agent 覆盖 &gt; profile &gt; 平台默认。已有 runtime 请在 Sessions 中 <strong>Stop</strong> 后由用户重发触发重建。
      </div>

      {agents.length === 0 ? (
        <div className="text-sm text-gray-400 py-6 text-center">
          暂无 Agent（还没有任何对话/agent 记录）。先创建一个对话，再回来分配 profile / 设置 per-Agent prompt。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-3 py-2 font-medium border-b">title</th>
                <th className="px-3 py-2 font-medium border-b">owner</th>
                <th className="px-3 py-2 font-medium border-b">profile</th>
                <th className="px-3 py-2 font-medium border-b">sys 覆盖</th>
                <th className="px-3 py-2 font-medium border-b">append 覆盖</th>
                <th className="px-3 py-2 font-medium border-b">更新时间</th>
                <th className="px-3 py-2 font-medium border-b">操作</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <Fragment key={a.id}>
                  <tr className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-700 max-w-[200px] truncate" title={a.title}>
                      {a.title || fmtShort(a.id)}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-500" title={a.userId}>{fmtShort(a.userId)}</td>
                    <td className="px-3 py-2 font-mono text-gray-600">
                      {profileName(a.profileId) ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-500 max-w-[140px] truncate" title={a.systemPrompt ?? ""}>
                      {a.systemPrompt ? `${a.systemPrompt.length} 字` : <span className="text-gray-300">NULL</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-500 max-w-[140px] truncate" title={a.appendSystemPrompt ?? ""}>
                      {a.appendSystemPrompt ? `${a.appendSystemPrompt.length} 字` : <span className="text-gray-300">NULL</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-400">{a.updatedAt.slice(0, 19).replace("T", " ")}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button
                        onClick={() => setEditingId((cur) => (cur === a.id ? null : a.id))}
                        disabled={busy !== null && busy !== a.id}
                        className={`text-xs px-2 py-0.5 rounded border disabled:opacity-40 ${
                          editingId === a.id
                            ? "bg-indigo-50 text-indigo-600 border-indigo-200"
                            : "bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100"
                        }`}
                      >
                        {editingId === a.id ? "收起" : "分配 / Prompt"}
                      </button>
                    </td>
                  </tr>
                  {editingId === a.id && editing && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <AgentAssignmentEditor
                          key={a.id}
                          agent={editing}
                          profiles={profiles}
                          maxChars={maxChars}
                          onSubmit={(vals) => handleSave(a.id, vals)}
                          onCancel={() => setEditingId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Capability Resource Table (control-plane resource pool) ──

export function CapabilityTable({
  resources,
  editingResource,
  onEdit,
}: {
  resources: CapabilityResourceView[];
  editingResource: string | null;
  onEdit: (resourceId: string) => void;
}) {
  if (resources.length === 0) {
    return (
      <div className="text-sm text-gray-400 py-8 text-center">
        暂无能力资源。资源池来自 <code className="bg-gray-100 px-1 rounded">data/skills.json</code> + <code className="bg-gray-100 px-1 rounded">data/mcp.json</code> + <code className="bg-gray-100 px-1 rounded">data/hook-plugins.json</code>。
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-left">
            <th className="px-3 py-2 font-medium border-b">resourceId</th>
            <th className="px-3 py-2 font-medium border-b">type</th>
            <th className="px-3 py-2 font-medium border-b">status</th>
            <th className="px-3 py-2 font-medium border-b">version</th>
            <th className="px-3 py-2 font-medium border-b">description</th>
            <th className="px-3 py-2 font-medium border-b">操作</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => (
            <tr key={r.resourceId} className="border-b hover:bg-gray-50">
              <td className="px-3 py-2 font-mono font-medium">{r.resourceId}</td>
              <td className="px-3 py-2 font-mono text-gray-500">{r.type}</td>
              <td className="px-3 py-2">
                <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                  r.status === "active" ? "bg-green-100 text-green-700"
                  : r.status === "invalid" ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-500"
                }`}>{r.status}</span>
              </td>
              <td className="px-3 py-2 font-mono text-gray-500">{r.version || "—"}</td>
              <td className="px-3 py-2 text-gray-600 max-w-[260px] truncate" title={r.description || ""}>
                {r.description || "—"}
              </td>
              <td className="px-3 py-2">
                <button
                  onClick={() => onEdit(r.resourceId)}
                  className={`text-xs px-2 py-0.5 rounded border ${
                    editingResource === r.resourceId
                      ? "bg-blue-50 text-blue-600 border-blue-200"
                      : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                  }`}
                >
                  {editingResource === r.resourceId ? "编辑中" : "编辑授权"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Capability Entitlement Editor (inline panel) ─────────────

export function EntitlementEditor({
  resourceId,
  entries,
  onSave,
  onCancel,
}: {
  resourceId: string;
  entries: EntitlementEntry[];
  onSave: (entries: Array<{ scopeType: "org" | "user"; scopeId: string; effect: "allow" | "deny" }>) => Promise<void>;
  onCancel: () => void;
}) {
  // Local working copy — PUT replaces ALL entries for this resource.
  const [draft, setDraft] = useState<
    Array<{ scopeType: "org" | "user"; scopeId: string; effect: "allow" | "deny" }>
  >(entries.map((e) => ({ scopeType: e.scopeType, scopeId: e.scopeId, effect: e.effect })));
  const [newScope, setNewScope] = useState<"org" | "user">("user");
  const [newScopeId, setNewScopeId] = useState("");
  const [newEffect, setNewEffect] = useState<"allow" | "deny">("allow");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const id = newScopeId.trim();
    if (!id) { setErr("scopeId 不能为空"); return; }
    setErr(null);
    setDraft([...draft, { scopeType: newScope, scopeId: id, effect: newEffect }]);
    setNewScopeId("");
  };
  const remove = (idx: number) => setDraft(draft.filter((_, i) => i !== idx));
  const handleSave = async () => {
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };

  return (
    <div className="mt-3 border border-blue-200 rounded-lg bg-blue-50/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-gray-800">
          授权：<code className="font-mono bg-gray-100 px-1 rounded">{resourceId}</code>
        </h4>
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving}
            className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
            {saving ? "保存中…" : "保存"}
          </button>
          <button onClick={onCancel}
            className="text-xs px-3 py-1 border border-gray-200 bg-white text-gray-600 rounded hover:bg-gray-50">
            取消
          </button>
        </div>
      </div>
      <div className="text-xs text-gray-500 mb-3">
        规则：admin 全权；非 admin = <strong>deny 默认</strong>，<strong>user 优先级 &gt; org</strong>，<strong>deny 覆盖 allow</strong>。
        保存以 PUT 替换该资源全部条目（服务端记录 grantedBy/grantedAt）。
      </div>

      {draft.length === 0 ? (
        <div className="text-xs text-gray-400 py-2 mb-3">暂无条目（= 非 admin 默认拒绝）</div>
      ) : (
        <table className="w-full text-xs border-collapse mb-3">
          <thead>
            <tr className="bg-gray-50 text-gray-500 text-left">
              <th className="px-2 py-1.5 font-medium border-b">scope</th>
              <th className="px-2 py-1.5 font-medium border-b">scopeId</th>
              <th className="px-2 py-1.5 font-medium border-b">effect</th>
              <th className="px-2 py-1.5 font-medium border-b">操作</th>
            </tr>
          </thead>
          <tbody>
            {draft.map((e, idx) => (
              <tr key={idx} className="border-b">
                <td className="px-2 py-1.5 font-mono">{e.scopeType}</td>
                <td className="px-2 py-1.5 font-mono text-gray-600">{e.scopeId}</td>
                <td className="px-2 py-1.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                    e.effect === "allow" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>{e.effect}</span>
                </td>
                <td className="px-2 py-1.5">
                  <button onClick={() => remove(idx)}
                    className="text-xs px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100">
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500">新增：</span>
        <select value={newScope} onChange={(e) => setNewScope(e.target.value as "org" | "user")}
          className="border border-gray-200 rounded px-2 py-1">
          <option value="user">user</option>
          <option value="org">org</option>
        </select>
        <input value={newScopeId} onChange={(e) => setNewScopeId(e.target.value)}
          placeholder={newScope === "user" ? "userId" : "orgId (default-org)"}
          className="border border-gray-200 rounded px-2 py-1 font-mono text-xs w-64" />
        <select value={newEffect} onChange={(e) => setNewEffect(e.target.value as "allow" | "deny")}
          className="border border-gray-200 rounded px-2 py-1">
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
        <button onClick={add}
          className="px-3 py-1 bg-gray-50 text-gray-700 border border-gray-200 rounded hover:bg-gray-100">
          + 添加
        </button>
        {err && <span className="text-red-500">{err}</span>}
      </div>
    </div>
  );
}

// ─── Policy Panel ─────────────────────────────────────────────

export function PolicyPanel({ policy }: { policy: RuntimePolicy | null }) {
  if (!policy) return <div className="text-sm text-gray-400 py-4">加载中…</div>;
  return (
    <div className="text-xs font-mono space-y-1 bg-gray-50 rounded p-3">
      {Object.entries(policy).map(([k, v]) => (
        <div key={k} className="flex gap-4">
          <span className="text-gray-500 w-48 shrink-0">{k}</span>
          <span className="text-gray-800">{JSON.stringify(v)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Runtime Settings Form ────────────────────────────────────

// Numeric settings rendered by the grid below. Kept as an explicit subset (NOT
// keyof RuntimeSettings) so `draft[f.key]` stays number — Stage 2 added
// defaultModel/models to RuntimeSettings which are edited by ModelSettingsPanel.
type NumericSettingsKey = "idleStopMs" | "memoryMb" | "cpuCores" | "maxTurns";

const FIELD_META: { key: NumericSettingsKey; label: string; hint: string; step?: number }[] = [
  { key: "idleStopMs", label: "空闲停止 (ms)", hint: "空闲多久自动停止 runtime。立即影响后续 idle 检测。", step: 60000 },
  { key: "memoryMb", label: "内存上限 (MB)", hint: "新建 Docker runtime 的内存限制。仅对新 runtime 生效。" },
  { key: "cpuCores", label: "CPU 核数", hint: "新建 Docker runtime 的 CPU 限制。仅对新 runtime 生效。", step: 0.25 },
  { key: "maxTurns", label: "最大轮次 (maxTurns)", hint: "Agent SDK 单次会话 turn 上限。仅对新 runtime 生效。" },
];

// Stage 2: coarse global model management panel — alias list (enable/disable,
// add/remove) + global default select (enabled aliases only). The default
// alias cannot be disabled client-side (mirror of the server's hard gate).
const ALIAS_INPUT_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;

function ModelSettingsPanel({
  models,
  defaultModel,
  onChange,
}: {
  models: Array<{ alias: string; enabled: boolean }>;
  defaultModel: string;
  onChange: (models: Array<{ alias: string; enabled: boolean }>, defaultModel: string) => void;
}) {
  const [newAlias, setNewAlias] = useState("");
  const enabledAliases = models.filter((m) => m.enabled);
  const canAdd = ALIAS_INPUT_RE.test(newAlias.trim()) && !models.some((m) => m.alias === newAlias.trim());

  const setEnabled = (alias: string, enabled: boolean) => {
    // The current default must stay enabled — switch the default first.
    if (!enabled && alias === defaultModel) return;
    onChange(models.map((m) => (m.alias === alias ? { ...m, enabled } : m)), defaultModel);
  };
  const removeAlias = (alias: string) => {
    if (alias === defaultModel) return; // cannot remove the current default
    onChange(models.filter((m) => m.alias !== alias), defaultModel);
  };
  const addAlias = () => {
    if (!canAdd) return;
    onChange([...models, { alias: newAlias.trim(), enabled: false }], defaultModel);
    setNewAlias("");
  };

  return (
    <div className="border border-gray-200 rounded p-3 max-w-2xl space-y-2">
      <div className="text-xs font-medium text-gray-700">模型管理（全局粗粒度）</div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-600">默认模型</span>
        <select
          value={defaultModel}
          onChange={(e) => onChange(models, e.target.value)}
          className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
        >
          {enabledAliases.length === 0 && <option value="">（无已启用 alias）</option>}
          {enabledAliases.map((m) => (
            <option key={m.alias} value={m.alias}>{m.alias}</option>
          ))}
        </select>
        <span className="text-gray-400">仅对新启动的 Runtime 生效；alias 由 provider 侧解析</span>
      </div>
      <div className="space-y-1">
        {models.map((m) => (
          <div key={m.alias} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={m.enabled}
              onChange={(e) => setEnabled(m.alias, e.target.checked)}
              disabled={m.alias === defaultModel}
              title={m.alias === defaultModel ? "当前默认模型不可停用（先切换默认）" : undefined}
            />
            <span className="font-mono">{m.alias}</span>
            {m.alias === defaultModel && <span className="text-xs text-blue-600">默认</span>}
            <button
              onClick={() => removeAlias(m.alias)}
              disabled={m.alias === defaultModel}
              className="text-xs text-red-600 hover:underline disabled:opacity-40 disabled:no-underline"
              title={m.alias === defaultModel ? "当前默认模型不可删除（先切换默认）" : undefined}
            >
              删除
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2 text-sm">
          <input
            value={newAlias}
            onChange={(e) => setNewAlias(e.target.value)}
            placeholder="新增 alias（如 glm-4.7）"
            className="border border-gray-200 rounded px-2 py-1 text-sm font-mono w-52"
          />
          <button
            onClick={addAlias}
            disabled={!canAdd}
            className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

export function RuntimeSettingsForm({
  settings,
  onSave,
}: {
  settings: RuntimeSettings | null;
  onSave: (patch: Partial<RuntimeSettings>) => Promise<RuntimeSettings | null>;
}) {
  const [draft, setDraft] = useState<RuntimeSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setDraft(settings); }, [settings]);

  if (!draft) return <div className="text-sm text-gray-400 py-4">加载中…</div>;

  const update = (k: keyof RuntimeSettings, v: string) => {
    setSaved(false);
    setDraft({ ...draft, [k]: Number(v) });
  };

  // M4: platform-default Auto Compact policy (threshold / keep / enabled).
  // Server clamps to the same bands as org overlays.
  const updateCompaction = (patch: Partial<NonNullable<RuntimeSettings["contextCompaction"]>>) => {
    setSaved(false);
    setDraft({
      ...draft,
      contextCompaction: {
        enabled: true,
        thresholdTokens: 100_000,
        keepRecentTurns: 10,
        ...draft.contextCompaction,
        ...patch,
      },
    });
  };
  const cc = draft.contextCompaction ?? { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const result = await onSave(draft);
      if (result) { setDraft(result); setSaved(true); }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 max-w-2xl">
        {FIELD_META.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-700">{f.label}</span>
            <input
              type="number"
              step={f.step ?? 1}
              value={draft[f.key]}
              onChange={(e) => update(f.key, e.target.value)}
              className="border border-gray-200 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <span className="text-xs text-gray-400">{f.hint}</span>
          </label>
        ))}
      </div>

      {/* Stage 2 (coarse global model management): alias list + global default.
          Coarse by design — no per-agent / org entitlement / realModelId mapping.
          Server is the hard gate (defaultModel must be an ENABLED alias → 400);
          the client guard mirrors it to avoid a doomed save. */}
      <ModelSettingsPanel
        models={draft.models ?? []}
        defaultModel={draft.defaultModel ?? ""}
        onChange={(models, defaultModel) => {
          setSaved(false);
          setDraft({ ...draft, models, defaultModel });
        }}
      />

      {/* M4: platform-default Auto Compact. These values double as the org
          overlay ceilings — lowering them re-clamps stored org values on read. */}
      <div className="border border-gray-200 rounded-lg p-3 space-y-2 max-w-2xl">
        <div className="text-xs font-medium text-gray-700">
          Auto Compact（平台默认策略，同时是组织上限）
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-1.5 text-xs pb-1.5">
            <input
              type="checkbox"
              checked={cc.enabled}
              onChange={(e) => updateCompaction({ enabled: e.target.checked })}
            />
            启用自动压缩
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-gray-500">触发阈值 tokens（1,000 – 1,000,000）</span>
            <input
              type="number"
              value={cc.thresholdTokens}
              onChange={(e) => updateCompaction({ thresholdTokens: Number(e.target.value) })}
              className="border border-gray-200 rounded px-2 py-1 text-sm font-mono w-36"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-gray-500">保留最近对话轮数（1 – 100）</span>
            <input
              type="number"
              value={cc.keepRecentTurns}
              onChange={(e) => updateCompaction({ keepRecentTurns: Number(e.target.value) })}
              className="border border-gray-200 rounded px-2 py-1 text-sm font-mono w-36"
            />
          </label>
        </div>
        <p className="text-xs text-gray-400">
          达到阈值后在 turn 边界自动执行 /compact（不打断进行中的回复）。组织策略只能在本平台值内收紧，不能放宽。
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-sm px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存设置"}
        </button>
        {saved && <span className="text-xs text-green-600">✓ 已保存</span>}
      </div>

      <div className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded px-3 py-2 max-w-2xl">
        配置已保存后：<strong>idleStopMs</strong> 立即影响后续 idle 检测；
        <strong> memory / cpu / maxTurns / 默认模型</strong> 仅对新启动的 Runtime 生效。
        已有 Runtime 请在 Sessions 中 <strong>Stop</strong> 后由用户继续对话重新创建。
        服务端会对超出范围的值进行裁剪；<strong>defaultModel 必须是已启用的 alias</strong>（否则保存被拒）。
      </div>
    </div>
  );
}

// ─── Prompt Settings Form (Phase 2e) ──────────────────────────

export function PromptSettingsForm({
  settings,
  onSave,
}: {
  settings: PromptSettings | null;
  onSave: (patch: Partial<PromptSettings>) => Promise<PromptSettings | null>;
}) {
  const [draft, setDraft] = useState<PromptSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setDraft(settings); }, [settings]);

  if (!draft) return <div className="text-sm text-gray-400 py-4">加载中…</div>;

  const update = (k: keyof PromptSettings, v: string) => {
    setSaved(false);
    setDraft({ ...draft, [k]: v });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const result = await onSave(draft);
      if (result) { setDraft(result); setSaved(true); }
    } finally {
      setSaving(false);
    }
  };

  const over = draft.systemPrompt.length > draft.maxSystemPromptChars;

  return (
    <div className="space-y-5 max-w-3xl">
      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-sm font-medium text-ink-primary">
          系统提示词
          <code className="font-mono text-[11px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
            systemPrompt
          </code>
        </span>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => update("systemPrompt", e.target.value)}
          rows={5}
          className={`w-full px-3 py-2 text-sm rounded-lg border bg-white focus:outline-none focus:ring-2 leading-relaxed ${
            over
              ? "border-red-400 focus:ring-red-400/30"
              : "border-line-subtle focus:ring-brand/30 focus:border-brand"
          }`}
        />
        <span className={`text-xs ${over ? "text-red-600" : "text-gray-400"}`}>
          {draft.systemPrompt.length} / {draft.maxSystemPromptChars} 字符
          {over && " · 超长，保存将被服务端拒绝"}
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-sm font-medium text-ink-primary">
          追加上下文
          <code className="font-mono text-[11px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
            appendBase
          </code>
        </span>
        <textarea
          value={draft.appendBase}
          onChange={(e) => update("appendBase", e.target.value)}
          rows={8}
          className="w-full px-3 py-2 text-sm rounded-lg border border-line-subtle bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand leading-relaxed"
        />
        <span className="text-xs text-gray-400">{draft.appendBase.length} 字符</span>
      </label>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || over}
          className="text-sm px-4 h-9 bg-brand hover:bg-brand-hover text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {saved && <span className="text-xs text-green-600">已保存</span>}
      </div>

      <div className="text-xs text-ink-secondary bg-gray-50 border border-line-subtle rounded-md px-3 py-2.5 leading-relaxed">
        Prompt 变更仅对新启动的 Runtime 生效。已有 Runtime 请在 Sessions 中 Stop 后继续对话触发重建。
      </div>
    </div>
  );
}

// ─── Storage Policy Panel ─────────────────────────────────────

export function StoragePanel({ settings }: { settings: RuntimeSettings | null }) {
  if (!settings) return <div className="text-sm text-gray-400 py-4">加载中…</div>;
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
        ⚠️ Soft limit only. <strong>Not enforced yet.</strong> 当前仅用于展示与诊断，不会阻止上传、不会阻止 Agent 写文件、不会自动清理。
      </div>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-left">
            <th className="px-3 py-2 font-medium border-b">Volume</th>
            <th className="px-3 py-2 font-medium border-b">Soft Limit</th>
            <th className="px-3 py-2 font-medium border-b">Used</th>
            <th className="px-3 py-2 font-medium border-b">Enforced</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b">
            <td className="px-3 py-2 font-mono">workspace</td>
            <td className="px-3 py-2 font-mono">{settings.maxWorkspaceMb} MB</td>
            <td className="px-3 py-2 text-gray-400">Not measured</td>
            <td className="px-3 py-2 text-gray-400">No</td>
          </tr>
          <tr className="border-b">
            <td className="px-3 py-2 font-mono">claude-home</td>
            <td className="px-3 py-2 font-mono">{settings.maxClaudeHomeMb} MB</td>
            <td className="px-3 py-2 text-gray-400">Not measured</td>
            <td className="px-3 py-2 text-gray-400">No</td>
          </tr>
        </tbody>
      </table>
      <div className="text-xs text-gray-400">
        软限制值可在 <strong>Runtime Settings</strong> 中通过 API 调整（maxWorkspaceMb / maxClaudeHomeMb）。
        实时容量统计与强制限制属于后续阶段。
      </div>
    </div>
  );
}

// ─── Network Policy Panel ─────────────────────────────────────

export function NetworkPanel() {
  return (
    <div className="space-y-3 max-w-2xl">
      <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-3 py-2">
        <strong>Network Policy: not enforced in MVP.</strong> 当前为只读展示，不提供网络开关，避免制造安全假象。
      </div>
      <div className="text-xs font-mono space-y-1 bg-gray-50 rounded p-3">
        <div className="flex gap-4"><span className="text-gray-500 w-56 shrink-0">Network Policy</span><span className="text-gray-800">not enforced in MVP</span></div>
        <div className="flex gap-4"><span className="text-gray-500 w-56 shrink-0">Internet Access</span><span className="text-gray-800">allowed by runtime environment</span></div>
        <div className="flex gap-4"><span className="text-gray-500 w-56 shrink-0">Private Network Blocking</span><span className="text-gray-800">not enforced</span></div>
      </div>
      <div className="text-xs text-gray-400">
        真正的网络隔离需要 Docker network mode、egress proxy、DNS/firewall 等支持，属于后续单独设计。
      </div>
    </div>
  );
}

// ─── Phase 6 (A1): Applications Manager ─────────────────────

// App-level tool allowlist editor (simpler than profile ToolConfigEditor:
// just a checkbox list of supported tools, null = passthrough)
function AppToolAllowlistEditor({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  useEffect(() => { getToolCatalog().then(setCatalog); }, []);

  const selected = value ?? [];

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((t) => t !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <div className="border border-gray-200 rounded p-3 bg-white space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">
          {value === null ? "NULL（passthrough — 全部允许）" : `已选 ${selected.length} 个 tools`}
        </span>
        <div className="flex gap-2">
          <button onClick={() => onChange(catalog.map((t) => t.name))} className="text-xs px-2 py-0.5 border rounded hover:bg-gray-100">全选</button>
          <button onClick={() => onChange([])} className="text-xs px-2 py-0.5 border rounded hover:bg-gray-100">清空（deny all）</button>
          <button onClick={() => onChange(null)} className="text-xs px-2 py-0.5 border rounded text-red-600 hover:bg-red-50">设为 NULL</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {catalog.map((t) => (
          <label key={t.name} className="flex items-center gap-1 text-xs border rounded px-2 py-1 hover:bg-gray-50">
            <input type="checkbox" checked={selected.includes(t.name)} onChange={() => toggle(t.name)} />
            <span className="font-mono">{t.name}</span>
            <span className={t.risk === "high" ? "text-red-400" : "text-gray-400"}>({t.risk})</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function ApplicationsManager({
  applications,
  capabilities,
  appCaps,
  editingApp,
  newAppKey,
  profiles,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
  onGenKey,
  onEditCaps,
  onSaveCaps,
  onCloseCaps,
  onDismissKey,
}: {
  applications: ApplicationView[];
  capabilities: CapabilityResourceView[];
  appCaps: AppCapabilityView[];
  editingApp: string | null;
  newAppKey: string | null;
  profiles: ProfileView[];
  onRefresh: () => void;
  onCreate: (name: string, description?: string) => Promise<void>;
  onUpdate: (id: string, patch: Partial<ApplicationView>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onGenKey: (id: string) => Promise<void>;
  onEditCaps: (appId: string) => void;
  onSaveCaps: (appId: string, resources: Array<{ resourceId: string; enabled: boolean }>) => Promise<void>;
  onCloseCaps: () => void;
  onDismissKey: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editEntryUrl, setEditEntryUrl] = useState("");
  const [editSystemPrompt, setEditSystemPrompt] = useState("");
  const [editAppendPrompt, setEditAppendPrompt] = useState("");
  const [editToolAllowlist, setEditToolAllowlist] = useState<string[] | null>(null);
  const [editProfileId, setEditProfileId] = useState<string>("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [capDraft, setCapDraft] = useState<Array<{ resourceId: string; enabled: boolean }>>([]);

  // Sync capDraft when appCaps changes
  useEffect(() => {
    if (editingApp && appCaps.length >= 0) {
      // Build draft from existing caps, plus all available resources not yet configured
      const existing = new Map(appCaps.map(c => [c.resourceId, c.enabled]));
      const draft = capabilities.map(r => ({
        resourceId: r.resourceId,
        enabled: existing.get(r.resourceId) ?? false,
      }));
      setCapDraft(draft);
    }
  }, [editingApp, appCaps, capabilities]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await onCreate(newName.trim(), newDesc.trim() || undefined);
    setNewName("");
    setNewDesc("");
  };

  const handleSaveEdit = async (id: string) => {
    await onUpdate(id, {
      name: editName.trim() || undefined,
      description: editDesc.trim() || null,
      entryUrl: editEntryUrl.trim() || null,
      profileId: editProfileId === "" ? null : editProfileId,
      systemPrompt: editSystemPrompt.trim() || null,
      appendSystemPrompt: editAppendPrompt.trim() || null,
      toolAllowlist: editToolAllowlist,
    });
    setEditingId(null);
  };

  const startEdit = (app: ApplicationView) => {
    setEditingId(app.id);
    setEditName(app.name);
    setEditDesc(app.description ?? "");
    setEditEntryUrl(app.entryUrl ?? "");
    setEditProfileId(app.profileId ?? "");
    setEditSystemPrompt(app.systemPrompt ?? "");
    setEditAppendPrompt(app.appendSystemPrompt ?? "");
    setEditToolAllowlist(app.toolAllowlist ?? null);
    setShowPrompt(false);
    setShowTools(false);
  };

  const handleSaveCaps = async () => {
    if (!editingApp) return;
    await onSaveCaps(editingApp, capDraft);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-500">
          共 {applications.length} 个应用 — 管理 app key、能力 allowlist（deny-by-intersection）
        </span>
        <button onClick={onRefresh} className="text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50">
          🔄 刷新
        </button>
      </div>

      {/* New app key display */}
      {newAppKey && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-300 rounded">
          <div className="text-xs font-semibold text-yellow-800 mb-1">⚠️ 新 App Key（仅显示一次，请妥善保存）</div>
          <div className="flex items-center gap-2">
            <code className="text-xs bg-white px-2 py-1 rounded border break-all flex-1">{newAppKey}</code>
            <button onClick={() => navigator.clipboard.writeText(newAppKey)} className="text-xs px-2 py-1 border rounded hover:bg-gray-50">
              复制
            </button>
            <button onClick={onDismissKey} className="text-xs px-2 py-1 border rounded hover:bg-gray-50">
              关闭
            </button>
          </div>
        </div>
      )}

      {/* Create new app */}
      <div className="mb-4 flex items-end gap-2">
        <div>
          <label className="text-xs text-gray-500 block mb-1">名称</label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="My App"
            className="text-sm border rounded px-2 py-1 w-40"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">描述</label>
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Optional"
            className="text-sm border rounded px-2 py-1 w-48"
          />
        </div>
        <button
          onClick={handleCreate}
          disabled={!newName.trim()}
          className="text-sm px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        >
          + 创建
        </button>
      </div>

      {/* App table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50 text-gray-500 text-left">
              <th className="px-3 py-2 font-medium border-b">name</th>
              <th className="px-3 py-2 font-medium border-b">id</th>
              <th className="px-3 py-2 font-medium border-b">status</th>
              <th className="px-3 py-2 font-medium border-b">key prefix</th>
              <th className="px-3 py-2 font-medium border-b">entry URL</th>
              <th className="px-3 py-2 font-medium border-b">actions</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((app) => (
              <Fragment key={app.id}>
                <tr className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-700">{app.name}</td>
                  <td className="px-3 py-2 font-mono text-gray-400">{fmtShort(app.id)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                      app.status === "active" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}>{app.status}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-400">{app.apiKeyPrefix ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-400">{app.entryUrl ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5">
                      <button onClick={() => startEdit(app)} className="text-xs px-2 py-0.5 border rounded hover:bg-gray-100">编辑</button>
                      <button onClick={() => onGenKey(app.id)} className="text-xs px-2 py-0.5 border rounded hover:bg-gray-100">生成 Key</button>
                      <button onClick={() => onEditCaps(app.id)} className="text-xs px-2 py-0.5 border rounded hover:bg-gray-100">能力</button>
                      {app.status === "active" && app.id !== "default-app" && (
                        <button onClick={() => onDelete(app.id)} className="text-xs px-2 py-0.5 border rounded text-red-600 hover:bg-red-50">禁用</button>
                      )}
                    </div>
                  </td>
                </tr>
                {/* Inline edit row */}
                {editingId === app.id && (
                  <tr className="bg-blue-50">
                    <td colSpan={6} className="px-3 py-3">
                      <div className="flex items-end gap-2 mb-2">
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">名称</label>
                          <input value={editName} onChange={(e) => setEditName(e.target.value)} className="text-sm border rounded px-2 py-1 w-40" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">描述</label>
                          <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className="text-sm border rounded px-2 py-1 w-48" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Entry URL</label>
                          <input value={editEntryUrl} onChange={(e) => setEditEntryUrl(e.target.value)} placeholder="https://..." className="text-sm border rounded px-2 py-1 w-48" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 block mb-1">Profile（默认继承给新建 Agent）</label>
                          <select value={editProfileId} onChange={(e) => setEditProfileId(e.target.value)}
                            className="text-sm border rounded px-2 py-1 w-40 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400">
                            <option value="">— 无 profile —</option>
                            {profiles.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        </div>
                        <button onClick={() => setShowPrompt(!showPrompt)} className="text-xs px-2 py-1 border rounded hover:bg-gray-100">
                          {showPrompt ? "收起 Prompt" : "展开 Prompt"}
                        </button>
                        <button onClick={() => setShowTools(!showTools)} className="text-xs px-2 py-1 border rounded hover:bg-gray-100">
                          {showTools ? "收起 Tools" : "展开 Tools"}
                        </button>
                        <button onClick={() => handleSaveEdit(app.id)} className="text-sm px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600">保存</button>
                        <button onClick={() => setEditingId(null)} className="text-sm px-3 py-1 border rounded hover:bg-gray-100">取消</button>
                      </div>
                      {showPrompt && (
                        <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-blue-200">
                          <div className="text-xs text-gray-500">
                            Prompt 优先级：per-Agent 覆盖 &gt; <strong>App Prompt</strong> &gt; profile &gt; 平台默认。留空 = NULL → 走下层。
                          </div>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-gray-700">systemPrompt</span>
                            <textarea value={editSystemPrompt} onChange={(e) => setEditSystemPrompt(e.target.value)} rows={4}
                              placeholder="留空 = 走 profile / 平台默认"
                              className="border border-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                            <span className="text-xs text-gray-400">{editSystemPrompt.length} 字符</span>
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-gray-700">appendSystemPrompt</span>
                            <textarea value={editAppendPrompt} onChange={(e) => setEditAppendPrompt(e.target.value)} rows={4}
                              placeholder="留空 = 走 profile / 平台默认"
                              className="border border-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                          </label>
                        </div>
                      )}
                      {showTools && (
                        <div className="mt-2 pt-2 border-t border-blue-200">
                          <div className="text-xs text-gray-500 mb-2">
                            Tool Allowlist（上界收窄）。NULL = passthrough（全部允许）。勾选 = 仅允许这些内置 tools。Skill 不受此限制。
                          </div>
                          <AppToolAllowlistEditor
                            value={editToolAllowlist}
                            onChange={setEditToolAllowlist}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Capability allowlist editor */}
      {editingApp && (
        <div className="mt-4 p-4 border rounded bg-gray-50">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-700">
              能力 Allowlist — {applications.find(a => a.id === editingApp)?.name ?? editingApp}
            </span>
            <div className="flex gap-2">
              <button onClick={handleSaveCaps} className="text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600">保存</button>
              <button onClick={onCloseCaps} className="text-xs px-3 py-1 border rounded hover:bg-gray-100">关闭</button>
            </div>
          </div>
          <div className="text-xs text-gray-500 mb-2">
            勾选 = 允许该应用使用此能力。未配置任何行 = passthrough（全部允许）。配置了行但全部不勾选 = deny all。
          </div>
          {capDraft.length === 0 ? (
            <div className="text-xs text-gray-400 py-2">暂无可用能力资源</div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-white text-gray-500 text-left">
                  <th className="px-2 py-1.5 font-medium border-b">resourceId</th>
                  <th className="px-2 py-1.5 font-medium border-b">name</th>
                  <th className="px-2 py-1.5 font-medium border-b">type</th>
                  <th className="px-2 py-1.5 font-medium border-b">allowed</th>
                </tr>
              </thead>
              <tbody>
                {capDraft.map((row) => {
                  const res = capabilities.find(c => c.resourceId === row.resourceId);
                  return (
                    <tr key={row.resourceId} className="border-b hover:bg-white">
                      <td className="px-2 py-1.5 font-mono text-gray-600">{row.resourceId}</td>
                      <td className="px-2 py-1.5">{res?.name ?? "—"}</td>
                      <td className="px-2 py-1.5">{res?.type ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={(e) => {
                            setCapDraft(prev => prev.map(r =>
                              r.resourceId === row.resourceId ? { ...r, enabled: e.target.checked } : r
                            ));
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ─── AdminPanel ───────────────────────────────────────────────

type Tab = "containers" | "settings" | "prompt" | "storage" | "skills" | "mcp" | "profiles" | "agents" | "capabilities" | "network" | "policy" | "applications";

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("containers");
  const [runtimes, setRuntimes] = useState<RuntimeView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [mcpServers, setMcpServers] = useState<McpView[]>([]);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [agents, setAgents] = useState<AgentWithOverridesView[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityResourceView[]>([]);
  const [entitlements, setEntitlements] = useState<EntitlementEntry[]>([]);
  const [editingResource, setEditingResource] = useState<string | null>(null);
  const [policy, setPolicy] = useState<RuntimePolicy | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [promptSettings, setPromptSettings] = useState<PromptSettings | null>(null);
  const [containersLoading, setContainersLoading] = useState(true);
  const [applications, setApplications] = useState<ApplicationView[]>([]);
  const [appCaps, setAppCaps] = useState<AppCapabilityView[]>([]);
  const [editingApp, setEditingApp] = useState<string | null>(null);
  const [newAppKey, setNewAppKey] = useState<string | null>(null);

  const fetchContainers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/containers`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRuntimes(data.runtimes ?? []);
      }
    } catch {} finally {
      setContainersLoading(false);
    }
  }, []);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/skills`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills ?? []);
      }
    } catch {}
  }, []);

  const fetchMcpServers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/mcp`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setMcpServers(data.mcpServers ?? []);
      }
    } catch {}
  }, []);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/agent-profiles`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles ?? []);
      }
    } catch {}
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/agents`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents ?? []);
      }
    } catch {}
  }, []);

  const fetchCapabilities = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/capabilities`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setCapabilities(data.resources ?? []);
      }
    } catch {}
  }, []);

  const fetchEntitlements = useCallback(async (resourceId: string): Promise<boolean> => {
    // Clear first so a failed/non-OK fetch can NEVER leave the previously-selected
    // resource's entries visible (stale A entries would otherwise save onto B).
    setEntitlements([]);
    try {
      const res = await fetch(`${API_BASE}/admin/capabilities/${encodeURIComponent(resourceId)}/entitlements`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setEntitlements(data.entries ?? []);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/runtime/policy`, { headers: authHeaders() });
      if (res.ok) setPolicy(await res.json());
    } catch {}
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/runtime/settings`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings ?? null);
      }
    } catch {}
  }, []);

  const fetchPromptSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/prompt-settings`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setPromptSettings(data.settings ?? null);
      }
    } catch {}
  }, []);

  const fetchApplications = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/admin/applications`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setApplications(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, []);

  const fetchAppCaps = useCallback(async (appId: string) => {
    try {
      const res = await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(appId)}/capabilities`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAppCaps(Array.isArray(data) ? data : []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchContainers();
    fetchSkills();
    fetchMcpServers();
    fetchProfiles();
    fetchAgents();
    fetchCapabilities();
    fetchPolicy();
    fetchSettings();
    fetchPromptSettings();
    fetchApplications();
    const timer = setInterval(fetchContainers, 5000);
    return () => clearInterval(timer);
  }, [fetchContainers, fetchSkills, fetchMcpServers, fetchProfiles, fetchAgents, fetchCapabilities, fetchPolicy, fetchSettings, fetchPromptSettings, fetchApplications]);

  const handleStop = async (chatId: string): Promise<StopResult | null> => {
    const res = await fetch(`${API_BASE}/admin/containers/${chatId}/stop`, {
      method: "POST",
      headers: authHeaders(),
    });
    const data: StopResult = await res.json();
    await fetchContainers();
    return data;
  };

  const handleSaveSettings = async (patch: Partial<RuntimeSettings>): Promise<RuntimeSettings | null> => {
    const res = await fetch(`${API_BASE}/admin/runtime/settings`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = await res.json();
    setSettings(data.settings ?? null);
    return data.settings ?? null;
  };

  const handleSavePromptSettings = async (patch: Partial<PromptSettings>): Promise<PromptSettings | null> => {
    const res = await fetch(`${API_BASE}/admin/prompt-settings`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = await res.json();
    setPromptSettings(data.settings ?? null);
    return data.settings ?? null;
  };

  const handleToggleSkill = async (name: string, enabled: boolean): Promise<void> => {
    const action = enabled ? "enable" : "disable";
    await fetch(`${API_BASE}/admin/skills/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: authHeaders(),
    });
    await fetchSkills();
  };

  const handleToggleMcp = async (name: string, enabled: boolean): Promise<void> => {
    const action = enabled ? "enable" : "disable";
    await fetch(`${API_BASE}/admin/mcp/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: authHeaders(),
    });
    await fetchMcpServers();
  };

  const profileInputToBody = (v: ProfileInput) => ({
    name: v.name,
    description: v.description.trim() || null,
    systemPrompt: v.systemPrompt.trim() || null,
    appendSystemPrompt: v.appendSystemPrompt.trim() || null,
    toolsConfig: v.toolsConfig ?? null,
  });

  const handleCreateProfile = async (v: ProfileInput): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/agent-profiles`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(profileInputToBody(v)),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    await fetchProfiles();
  };

  const handleUpdateProfile = async (id: string, v: ProfileInput): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/agent-profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(profileInputToBody(v)),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    await fetchProfiles();
  };

  const handleDeleteProfile = async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/agent-profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchProfiles();
  };

  // Phase 5 (MP5f): bind a profile + set per-Agent prompt overrides. Patches the
  // owner-or-admin endpoint (re-validates profileId, writes agent_profile_updated
  // audit). Refresh the agents list so the table reflects the new override state.
  const handleSaveAgentAssignment = async (
    agentId: string,
    vals: AgentAssignmentInput
  ): Promise<void> => {
    const res = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(vals),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    await fetchAgents();
  };

  const handleEditCapability = async (resourceId: string) => {
    // Toggle off when clicking the resource already being edited.
    if (editingResource === resourceId) { setEditingResource(null); return; }
    // Fetch entitlements BEFORE mounting the editor (keyed by resourceId) so its
    // useState initializer sees the fresh entries. Only mount on success — a
    // failed fetch must not open an editor seeded with stale/empty entries.
    const ok = await fetchEntitlements(resourceId);
    if (!ok) return;
    setEditingResource(resourceId);
  };

  const handleSaveEntitlements = async (
    resourceId: string,
    entries: Array<{ scopeType: "org" | "user"; scopeId: string; effect: "allow" | "deny" }>
  ): Promise<void> => {
    await fetch(`${API_BASE}/admin/capabilities/${encodeURIComponent(resourceId)}/entitlements`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    await fetchEntitlements(resourceId); // refresh after PUT
  };

  // Phase 6 (A1): Application management handlers
  const handleCreateApp = async (name: string, description?: string): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    await fetchApplications();
  };

  const handleUpdateApp = async (id: string, patch: Partial<ApplicationView>): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await fetchApplications();
  };

  const handleDeleteApp = async (id: string): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    await fetchApplications();
  };

  const handleGenAppKey = async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(id)}/key`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      setNewAppKey(data.key ?? null);
      await fetchApplications();
    }
  };

  const handleSaveAppCaps = async (appId: string, resources: Array<{ resourceId: string; enabled: boolean }>): Promise<void> => {
    await fetch(`${API_BASE}/admin/applications/${encodeURIComponent(appId)}/capabilities`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ resources }),
    });
    await fetchAppCaps(appId);
  };

  const tabCls = (t: Tab) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      tab === t
        ? "border-blue-500 text-blue-600"
        : "border-transparent text-gray-500 hover:text-gray-700"
    }`;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-10 px-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-800">Admin Console</h2>
            <p className="text-xs text-gray-400">Runtime 工作台 · Sessions / Settings / Storage / Skill / Network</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1"
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b shrink-0 px-1">
          <button className={tabCls("containers")} onClick={() => setTab("containers")}>
            Sessions
            {runtimes.length > 0 && (
              <span className="ml-1.5 text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-full">
                {runtimes.length}
              </span>
            )}
          </button>
          <button className={tabCls("settings")} onClick={() => setTab("settings")}>
            Runtime Settings
          </button>
          <button className={tabCls("prompt")} onClick={() => setTab("prompt")}>
            Prompt
          </button>
          <button className={tabCls("storage")} onClick={() => setTab("storage")}>
            Storage
          </button>
          <button className={tabCls("skills")} onClick={() => setTab("skills")}>
            Skill 配置
            {skills.filter((s) => s.enabled).length > 0 && (
              <span className="ml-1.5 text-xs bg-green-100 text-green-600 px-1.5 py-0.5 rounded-full">
                {skills.filter((s) => s.enabled).length}
              </span>
            )}
          </button>
          <button className={tabCls("mcp")} onClick={() => setTab("mcp")}>
            MCP 配置
            {mcpServers.filter((m) => m.enabled).length > 0 && (
              <span className="ml-1.5 text-xs bg-green-100 text-green-600 px-1.5 py-0.5 rounded-full">
                {mcpServers.filter((m) => m.enabled).length}
              </span>
            )}
          </button>
          <button className={tabCls("profiles")} onClick={() => setTab("profiles")}>
            Profiles
            {profiles.length > 0 && (
              <span className="ml-1.5 text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full">
                {profiles.length}
              </span>
            )}
          </button>
          <button className={tabCls("agents")} onClick={() => setTab("agents")}>
            Agents
            {agents.length > 0 && (
              <span className="ml-1.5 text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full">
                {agents.length}
              </span>
            )}
          </button>
          <button className={tabCls("capabilities")} onClick={() => setTab("capabilities")}>
            Capabilities
            {capabilities.filter((c) => c.status === "active").length > 0 && (
              <span className="ml-1.5 text-xs bg-green-100 text-green-600 px-1.5 py-0.5 rounded-full">
                {capabilities.filter((c) => c.status === "active").length}
              </span>
            )}
          </button>
          <button className={tabCls("applications")} onClick={() => setTab("applications")}>
            Applications
            {applications.length > 0 && (
              <span className="ml-1.5 text-xs bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full">
                {applications.length}
              </span>
            )}
          </button>
          <button className={tabCls("network")} onClick={() => setTab("network")}>
            Network
          </button>
          <button className={tabCls("policy")} onClick={() => setTab("policy")}>
            Policy
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5">
          {tab === "containers" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                  活跃 runtime: <strong>{runtimes.length}</strong>，每 5 秒自动刷新
                </span>
                <button
                  onClick={fetchContainers}
                  className="text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50"
                >
                  🔄 刷新
                </button>
              </div>
              <ContainerTable runtimes={runtimes} onStop={handleStop} loading={containersLoading} />
            </div>
          )}
          {tab === "settings" && (
            <div>
              <div className="mb-3 text-xs text-gray-500">
                可配置 Runtime 参数（file-backed: <code className="bg-gray-100 px-1 rounded">data/runtime-settings.json</code>）
              </div>
              <RuntimeSettingsForm settings={settings} onSave={handleSaveSettings} />
            </div>
          )}
          {tab === "prompt" && (
            <div>
              <div className="mb-3 text-xs text-gray-500">
                平台默认 Prompt（file-backed:{" "}
                <code className="bg-gray-100 px-1 rounded">data/prompt-settings.json</code>）—
                Phase 2e。默认值与迁移前硬编码常量逐字节一致，编辑前行为不变。
              </div>
              <PromptSettingsForm settings={promptSettings} onSave={handleSavePromptSettings} />
            </div>
          )}
          {tab === "storage" && (
            <div>
              <div className="mb-3 text-xs text-gray-500">Storage Policy（软限制，当前未强制）</div>
              <StoragePanel settings={settings} />
            </div>
          )}
          {tab === "skills" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                  共 {skills.length} 个 skill，{skills.filter((s) => s.enabled).length} 个已启用
                </span>
                <button
                  onClick={fetchSkills}
                  className="text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50"
                >
                  🔄 刷新
                </button>
              </div>
              <SkillTable skills={skills} runtimes={runtimes} onToggle={handleToggleSkill} />
            </div>
          )}
          {tab === "mcp" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                  共 {mcpServers.length} 个 MCP，{mcpServers.filter((m) => m.enabled).length} 个已启用
                  （注册表 = <code className="bg-gray-100 px-1 rounded">data/mcp.json</code>）
                </span>
                <button
                  onClick={fetchMcpServers}
                  className="text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50"
                >
                  🔄 刷新
                </button>
              </div>
              <McpTable mcpServers={mcpServers} onToggle={handleToggleMcp} />
            </div>
          )}
          {tab === "profiles" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                  共 {profiles.length} 个 profile（可复用角色模板；优先级 per-Agent 覆盖 &gt; profile &gt; 平台默认）
                </span>
                <button
                  onClick={fetchProfiles}
                  className="text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50"
                >
                  🔄 刷新
                </button>
              </div>
              <ProfileManager
                profiles={profiles}
                onCreate={handleCreateProfile}
                onUpdate={handleUpdateProfile}
                onDelete={handleDeleteProfile}
              />
            </div>
          )}
          {tab === "agents" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                  共 {agents.length} 个 Agent — 分配可复用 profile + 设置 per-Agent prompt（优先级 per-Agent 覆盖 &gt; profile &gt; 平台默认）
                </span>
                <button
                  onClick={fetchAgents}
                  className="text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50"
                >
                  🔄 刷新
                </button>
              </div>
              <AgentsManager
                agents={agents}
                profiles={profiles}
                maxChars={promptSettings?.maxSystemPromptChars}
                onSave={handleSaveAgentAssignment}
              />
            </div>
          )}
          {tab === "capabilities" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500">
                  共 {capabilities.length} 个能力资源，{capabilities.filter((c) => c.status === "active").length} 个 active
                  （资源池 = <code className="bg-gray-100 px-1 rounded">data/skills.json</code>）
                </span>
                <button
                  onClick={fetchCapabilities}
                  className="text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50"
                >
                  🔄 刷新
                </button>
              </div>
              <CapabilityTable
                resources={capabilities}
                editingResource={editingResource}
                onEdit={handleEditCapability}
              />
              {editingResource && (
                <EntitlementEditor
                  key={editingResource}
                  resourceId={editingResource}
                  entries={entitlements}
                  onSave={(entries) => handleSaveEntitlements(editingResource, entries)}
                  onCancel={() => setEditingResource(null)}
                />
              )}
            </div>
          )}
          {tab === "applications" && (
            <ApplicationsManager
              applications={applications}
              capabilities={capabilities}
              appCaps={appCaps}
              editingApp={editingApp}
              newAppKey={newAppKey}
              profiles={profiles}
              onRefresh={fetchApplications}
              onCreate={handleCreateApp}
              onUpdate={handleUpdateApp}
              onDelete={handleDeleteApp}
              onGenKey={handleGenAppKey}
              onEditCaps={(appId) => { setEditingApp(appId); setNewAppKey(null); fetchAppCaps(appId); }}
              onSaveCaps={handleSaveAppCaps}
              onCloseCaps={() => setEditingApp(null)}
              onDismissKey={() => setNewAppKey(null)}
            />
          )}
          {tab === "network" && (
            <div>
              <div className="mb-3 text-xs text-gray-500">Network Policy（只读）</div>
              <NetworkPanel />
            </div>
          )}
          {tab === "policy" && (
            <div>
              <div className="mb-3 text-xs text-gray-500">当前生效的 RuntimePolicy（只读诊断）</div>
              <PolicyPanel policy={policy} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
