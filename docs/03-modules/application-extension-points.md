# Application Extension Points（应用扩展点）

> Status: Phase 6 A2 — Route A 已落地（hook-as-plugin）；事件流 规划中
> 关联: `docs/02-architecture/platform-application-layer-architecture.md` §4、
> `docs/01-domain/agent-platform-domain-model.md` §Extension Point、
> `docs/04-guides/app-hook-guide.md`（应用方构建指南）。
> 原则:**透传 + 守卫,不重新定义** —— 平台把 SDK 接口贡献出来,怎么用、怎么调让应用实现;平台不发明 hook DSL、不规定用法。

## 0. 为什么有这一层

平台的不可替代价值,兑现为「应用可注册/透传的扩展点」。应用靠 **配置 + 代码** 介入平台行为,
**绝不改平台源码、绝不绕过治理守卫**。这是「应用可插入」而非「应用绕过」的关键。

## 1. 三类扩展点

### 1.1 能力挂载(已有 ✅)

- 应用注册 skill/mcp/hook-plugin → 平台校验(native 包形、路径防穿越、command 前缀)→ resolve 时注入容器 → 审批。
- 现状依据: `server/capability-provider.ts` resolve、`server/skill-config.ts`、`server/hook-plugin-config.ts`、`docker/agent-entry.ts` mcp/plugins 挂载、`strictMcpConfig:true`(防 `.mcp.json` 绕过)。
- 三层 gate: `app allowlist ∩ entitlement ∩ activation`（deny-by-intersection）。

### 1.2 Hook 透传(Route A 已落地 ✅)

**平台把 SDK 的 `hooks` 接口通过 native plugin 包透传给应用,不重新定义。**

#### 设计决策：Route A（hook-as-plugin）

经过 SDK precedence 实验证实后，采用 Route A：
- Hook 作为 **native plugin 包**注册（Claude Code plugin 格式：`.claude-plugin/plugin.json` + `hooks/hooks.json`）
- 走与 skill/mcp 相同的 capability resource 管线（`type=hook-plugin`）
- 平台 **不翻译 hook 语义**——SDK 自动发现 plugin 的 hooks.json 并执行
- 平台只保留 **inline PreToolUse 守卫**（deny-wins）和容器沙箱作为安全边界

#### 已弃用：Webhook Envelope 模型

旧的 webhook envelope 模型（`HookEnvelope` / `application-hook-service` / `hook-transport`）已完全删除：
- 后端 CRUD 路由 `/api/admin/applications/:id/hooks` 已移除
- `AGENT_HOOK_ENVELOPES` 环境变量注入已移除
- `agent-entry.ts` 中的 webhook 调用逻辑已移除
- `application_hooks` 表保留但标记 DEPRECATED（兼容现有 DB）

#### 关键技术结论（precedence 实验）

| 结论 | 内容 | 影响 |
|---|---|---|
| Deny-wins ✅ | 平台 inline deny + plugin allow → 最终 deny | 平台守卫安全，plugin 无法覆盖 deny |
| updatedInput 绕过 ❌ | plugin `updatedInput` 在 inline hook 之后生效 | 定性为 trusted-code policy，非安全边界；路径安全由容器沙箱强制 |

#### 治理守卫铁律（不可被应用/hook 覆盖）

- entitlement / deny-default 能力门控
- `HOOK_PLUGINS_ENABLED` rollout gate（默认关闭，Docker 加固后开启）
- 路径穿越防护（hooks/ 目录 realpath 校验）
- 平台 inline PreToolUse deny-wins
- 审计 / configVersion drift
- **待实现**: 容器沙箱（readonly rootfs, cap drop, egress allowlist, pids limit）

#### 相关文件

| 文件 | 职责 |
|---|---|
| `server/hook-plugin-config.ts` | hook plugin 包注册/校验/启用（类比 skill-config.ts） |
| `server/capability-resource.ts` | 聚合 hook-plugin 到资源池 |
| `server/capability-provider.ts` | resolve() 挂载 hook plugin（三层 gate + rollout gate + collision guard） |
| `docker/agent-entry.ts` | 平台 inline PreToolUse 守卫 + approval flow |
| `data/hook-plugins.json` | hook plugin 配置文件 |

### 1.3 事件流(规划 🔧)

- 平台把 agent 事件流(SDK event / tool_use / tool_result / approval)透传推给应用(webhook 或 app-scoped WS)。
- 应用自行做业务反应(如问数拿到结果后自己渲染 / 落库)。**透传,不定义业务语义。**

## 2. 治理守卫铁律(不可被应用或应用 hook 覆盖)

- entitlement / deny-default 能力门控
- MCP `command` 必须 `/opt/agent/mcp/` 前缀;`strictMcpConfig:true`
- Plugin path 必须 `/opt/agent/plugins/` 前缀
- 路径前缀校验、容器隔离边界
- 审计 / configVersion drift(双 principal `{ appId, actorUserId | serviceActorId }`)
- **Hook 专属守卫**: 平台 inline PreToolUse deny-wins（precedence 实验证实）;`updatedInput` 定性为 trusted-code policy,非安全边界;路径安全由容器沙箱强制（待实现）;`HOOK_PLUGINS_ENABLED` rollout gate;每次 capability 变更审计 `{ appId, actorUserId, agentId, resourceName, action }`。

> 这几条是「治理」的本分,不属于「定义」,任何应用 / hook 都不能关掉它们。

## 3. 落地

- **A0（最小应用模型）**: ✅ 已完成
- **A1（app-scoped Agent + 能力上界）**: ✅ 已完成
- **A2（hook 扩展点 — Route A）**: ✅ 已完成（hook-as-plugin + 删除 envelope）
- **A3（capability installer）**: ✅ 已完成
- **A4（智能问数样本）**: 规划中
- **Docker 加固**: 独立后续 PR（egress allowlist / cap drop / pids limit / readonly rootfs）

历史落地顺序与不可逆决策见 `docs/02-architecture/platform-application-layer-architecture.md` §7；当前开发顺序见 `docs/开发计划/agent-os-overall-plan.md`。
