/**
 * HooksPage — FROZEN (webhook envelope model, deprecated).
 *
 * The backend CRUD endpoints have been removed (Route A redesign).
 * This page is kept as a static deprecation notice only — no API calls.
 * Hook plugin management is via data/hook-plugins.json + CapabilitiesPage.
 */

export function HooksPage() {
  return (
    <div>
      <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
        <strong>⚠️ 已弃用 — Webhook Envelope Hook 模型（API 已移除）</strong>
        <div className="mt-2 text-xs text-amber-700 space-y-1">
          <p>
            此页面原有的 Hook CRUD 功能（基于 webhook envelope 模型）已在 A2 Route A 重设计中完全移除。
            后端端点 <code className="bg-amber-100 px-1 rounded">/api/admin/applications/:id/hooks</code> 已删除。
          </p>
          <p>
            <strong>新方向：</strong>Hook 作为 app-scoped native plugin 包注册，复用 Skill/Plugin 挂载机制，
            走 <code className="bg-amber-100 px-1 rounded">capability_resources</code> 管线
           （app allowlist ∩ entitlement ∩ activation）。
          </p>
          <p>
            <strong>管理方式：</strong>当前 MVP 阶段为 file-only config
            （<code className="bg-amber-100 px-1 rounded">data/hook-plugins.json</code>），
            在 <strong>Capabilities</strong> 页面查看资源池和 entitlement。
            后续将提供 admin UI 管理路径。
          </p>
          <p>
            <strong>Rollout gate：</strong>
            环境变量 <code className="bg-amber-100 px-1 rounded">HOOK_PLUGINS_ENABLED=true</code> 才会激活 hook plugin 挂载。
            Docker 加固（egress/capdrop/readonly）为独立后续 PR。
          </p>
          <p className="pt-1">
            详见：A2 hook 重设计技术方案 + SDK precedence 实验结论。
          </p>
        </div>
      </div>
    </div>
  );
}
