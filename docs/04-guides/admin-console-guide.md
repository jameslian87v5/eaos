# Admin Console 使用指南

## 概述

Admin Console 是 Agent 平台的管理后台，面向**平台管理员**和**应用开发者**。
它提供运行时监控、能力管理、应用配置、治理审计等全生命周期管理能力。

**访问入口**：`http://localhost:5173/admin`（登录后点击左下角管理入口）

---

## 页面导航

Console 左侧导航按职能分为 5 组：

| 组 | 页面 | 面向角色 | 用途 |
|---|---|---|---|
| **总览** | Dashboard | 管理员 | 系统状态一览（容器数、会话数、资源数） |
| **运行时** | Sessions | 管理员 | 查看活跃 agent 容器、状态、端口映射 |
| | Settings | 管理员 | 运行时参数（内存/CPU/空闲停止/最大轮次） |
| | Prompt | 管理员 | 系统级 prompt 覆盖 |
| | Policy | 管理员 | 运行时策略（审批开关、免审批白名单） |
| **能力库** | Skills | 应用开发者 | 管理 native skill plugin 包 |
| | MCP | 应用开发者 | 管理 MCP server 配置 |
| | Capabilities | 应用开发者/管理员 | 统一能力资源池（skill + mcp + hook-plugin），管理 entitlement |
| | API 注册 | 应用开发者 | 注册内网 HTTP API → 自动生成 MCP wrapper |
| **应用管理** | Applications | 应用开发者 | 创建应用、管理 app key、配置能力 allowlist |
| | Agents | 应用开发者 | 查看/编辑 agent 配置（profile 覆盖、能力激活） |
| | Profiles | 管理员 | 管理 agent profile（工具暴露/审批/禁用列表） |
| **治理审计** | Users | 管理员 | 用户管理（admin/user 角色） |
| | Audit Log | 管理员 | 审计事件查询（按类型/App ID 搜索） |

> **Hooks 页面**（`/admin/hooks`）已弃用，仅显示迁移说明。Hook 管理已并入 Capabilities 体系。

---

## 核心工作流

### 1. 能力管理（应用开发者）

能力（Capability）是 agent 可以使用的工具/资源的统称。平台支持三种能力类型：

| 类型 | 配置文件 | 说明 |
|---|---|---|
| `skill` | `data/skills.json` | Claude Code native skill plugin（如代码审查、文档生成） |
| `mcp` | `data/mcp.json` | MCP server（stdio wrapper，如数据库查询、API 调用） |
| `hook-plugin` | `data/hook-plugins.json` | Hook plugin 包（PreToolUse/PostToolUse 等事件介入） |

**三层 gate 机制**（deny-by-intersection）：

```
app allowlist ∩ entitlement ∩ activation
     │              │              │
     │              │              └─ agent 级别：此 agent 是否激活了此资源
     │              └─ 用户/组织级别：此用户/组织是否有权使用此资源
     └─ 应用级别：此应用是否允许使用此资源（null = passthrough）
```

**操作流程**：
1. 在 `data/skills.json` / `data/mcp.json` / `data/hook-plugins.json` 注册资源包
2. 在 **Capabilities** 页面查看资源池状态（valid/invalid、版本、描述）
3. 点击资源 → 设置 entitlement（哪些用户/组织可以使用）
4. 在 **Agents** 页面为特定 agent 激活资源
5. 在 **Applications** 页面配置 app allowlist（应用级上界）

### 2. 应用管理（应用开发者）

应用（Application）是平台里的预设，绑定 profile + 能力 allowlist + app key。

**创建应用**：
1. 进入 **Applications** 页面
2. 输入应用名称和描述 → 点击创建
3. 生成 App Key（仅显示一次，请妥善保存）
4. 配置能力 allowlist（勾选允许此应用使用的资源）

**应用使用平台 API**：
- S2S 调用：`Authorization: Bearer <app-key>` + `X-User-JWT: <user-jwt>`（双身份鉴权）
- App-scoped 端点：`/api/apps/:appId/agents`、`/api/apps/:appId/ws`

### 3. 内网 API 注册（应用开发者）

让 agent 调用内网 HTTP API，无需手写 MCP wrapper：

1. 进入 **API 注册** 页面
2. 单个注册：填写 API 名称、URL、方法、认证信息
3. 批量导入：上传 JSON 数组（最多 50 个）
4. 平台自动生成 stdio-wrapper MCP 包 → 注册为 capability resource
5. 在 **Capabilities** 或 **Applications** 页面为 agent/应用勾选使用

**批量导入格式**：
```json
{
  "apis": [
    {
      "name": "get-customer",
      "url": "http://internal-api:8080/customer",
      "method": "GET",
      "authType": "bearer",
      "authToken": "xxx"
    }
  ]
}
```

> 批量导入会预校验：重复名称、必填字段、method 值。有校验错误时整体拒绝（400），不执行任何安装。

### 4. Agent 配置（应用开发者）

Agent 是长生命周期的企业工作成员。每个 agent 绑定一个应用。

**配置维度**：
- **Profile 覆盖**：覆盖默认 profile 的 tools/allowedTools/approvalRequired
- **能力激活**：勾选此 agent 可用的 capability resources
- **System prompt 覆盖**：自定义 agent 的系统提示词

**操作**：进入 **Agents** 页面 → 选择 agent → 编辑配置

### 5. 运行时监控（管理员）

**Sessions 页面**：
- 查看活跃 agent 容器列表（容器 ID、状态、端口映射、创建时间）
- 搜索过滤（按 chatId/agentId 搜索）
- 空闲容器自动停止（可配置 `idleStopMs`）

**Settings 页面**：
- 内存限制（`memoryMb`）
- CPU 核数（`cpuCores`）
- 空闲停止时间（`idleStopMs`，实时生效）
- 最大轮次（`maxTurns`，仅新 runtime）

### 6. 治理审计（管理员）

**Audit Log 页面**：
- 按事件类型筛选（capability_change、app_key_generated、registered_api 等）
- 按 App ID 筛选
- 全文搜索（搜索 payload 内容）
- 三分支空态：加载中 → 无数据 → 搜索无结果

**Users 页面**：
- 创建/删除用户
- 设置角色（admin / user）

---

## UI 设计原则

### 懒加载（Lazy Loading）

所有 admin 页面使用 `React.lazy()` 按需加载，减少首屏 bundle 体积。
进入特定 admin 页面时才加载对应组件。

### 搜索与空态

所有列表页面提供搜索/过滤功能，并区分三种空态：

| 状态 | 显示 | 含义 |
|---|---|---|
| Loading | "加载中…" | 数据正在从 API 获取 |
| Data empty | "暂无 XXX" | 系统中确实没有数据 |
| No search results | "未找到匹配的 XXX" | 有数据但搜索条件不匹配 |

这避免了管理员误以为系统没有数据（实际只是搜索条件不匹配）。

### 零应用创建路径

Applications 页面即使没有任何应用，也始终显示创建表单。
管理员不会陷入"没有应用 → 无法创建 → 永远没有应用"的死循环。

---

## 常见操作速查

| 我想要… | 去哪里 |
|---|---|
| 查看当前活跃的 agent 容器 | Sessions |
| 给 agent 添加一个 skill | Capabilities → 设置 entitlement → Agents → 激活 |
| 注册一个内网 API 让 agent 调用 | API 注册 |
| 创建一个新应用并生成 app key | Applications |
| 配置哪些工具需要人工审批 | Policy 或 Profiles |
| 查看谁在什么时候改了什么配置 | Audit Log |
| 调整容器内存/CPU 限制 | Settings |
| 注册一个 hook plugin | 编辑 `data/hook-plugins.json` → Capabilities 查看 |
| 管理用户权限 | Users |

---

## 相关文档

- [应用方 Hook 构建指南](./app-hook-guide.md) — 如何构建 hook plugin 包
- [应用扩展点](../03-modules/application-extension-points.md) — 平台扩展点契约
- [平台应用层架构](../02-architecture/platform-application-layer-architecture.md) — 架构设计与决策记录
- [应用层历史开发计划](../开发计划/application-layer-dev-plan.md) — 文件级实施记录
