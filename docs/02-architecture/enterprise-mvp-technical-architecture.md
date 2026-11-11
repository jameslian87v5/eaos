# 企业可用 MVP 技术架构方案

> 适用项目：Claude Agent SDK Chat Platform  
> 日期：2026-06-08  
> 状态：架构基线草案  
> 目标：在不提前建设复杂平台能力的前提下，把当前 Demo 收敛为企业可用的最小 Agent Runtime 应用。

---

## 1. 架构目标

本 MVP 面向 **单企业部署**，但从数据模型和服务边界上预留 `orgId`、`AgentProfile`、`RuntimePolicy`、`CapabilityProvider` 等扩展口，避免后续演进到多企业 SaaS、Skill Hub、MCP Hub、API Connector 时推翻重做。

MVP 必须做到：

1. 多用户安全访问，用户之间 chat / runtime / 文件隔离。
2. Agent 在独立 Docker Runtime 中执行，不在 Web 进程内直接运行危险工具。
3. 每个 chat 拥有独立 runtime 生命周期，可 fresh start、cold resume、idle stop、delete cleanup。
4. Claude Code 原生 session 可恢复：持久化 `claudeSessionId` 和 `/root/.claude` transcript。
5. 文件流转有明确边界：上传进入 `/workspace/input`，Agent 输出进入 `/workspace/output`。
6. 工具、MCP、Skill、系统提示词、sandbox 策略通过后端能力注入，不由前端直接决定。
7. Runtime 状态、事件、错误、volume 使用量可查询，为未来控制面和运维观测留接口。

MVP 暂不做：

1. Skill Hub / MCP Hub / API Connector 平台。
2. 复杂控制台、工具市场、Skill 市场。
3. Kubernetes、分布式调度、容器池。
4. 复杂 RBAC、计费、审计报表。
5. Object Storage 强依赖。阶段一文件先走 workspace volume。

---

## 2. 已确认架构决策

| 决策 | MVP 选择 | 说明 |
|---|---|---|
| 部署形态 | 单企业单实例，预留 `orgId` | 当前不做完整 SaaS，但 schema 和 request context 不写死单租户 |
| 生产数据库 | PostgreSQL 作为生产目标 | SQLite 继续用于 local dev |
| Runtime | 每个 chat 一个 Docker Runtime | `chatId` 绑定 runtime，`userId/orgId` 作为权限和配额边界 |
| 会话恢复 | `claudeSessionId` + per-chat claude-home volume | `/root/.claude` 必须持久化，已验证 cold resume |
| 文件阶段一 | workspace volume | `/workspace/input`、`/workspace/output`，后续可迁移 object storage |
| 用户记忆 | 一用户一 `MEMORY.md` | 主机 `data/user-memory/<userId>/MEMORY.md` 为唯一源；Docker 绑定挂载到 `/user-memory`，local 模式纳入 workspaceRoots；仅该确切路径的 Write/Edit 免审批（配额内），其余路径沿用既有 approval/deny |
| 默认工具权限 | default-sandbox | Read/Grep/Glob 自动允许；Write/Edit/Bash 需要 approval；disallowedTools 默认空 |
| Capability 管理 | 本地 Provider 接口 | 不接 Hub，但定义 SDK-compatible bundle |
| 管理面 | 先做状态 API，不做复杂 UI | 未来控制台读取 runtime status / events / usage |

---

## 3. 总体分层

### 3.1 Web / API 层

职责：

- 登录、注册、当前用户信息。
- Chat CRUD。
- WebSocket 消息收发。
- 文件上传 / 下载。
- Runtime status 查询接口。

边界：

- 所有请求生成 `RequestContext = { orgId, userId, role }`。
- 前端不得直接传递 `tools`、`plugins`、`mcpServers`、sandbox 参数。
- WebSocket 必须绑定有效 JWT，并在每条 chat 消息上校验 chat ownership。

### 3.2 Identity / Context 层

职责：

- JWT 校验。
- 用户、组织、角色上下文。
- 资源所有权校验。

MVP 建议：

- 新增 `organizations`，启动时创建 default org。
- `users/chats/agent_sessions/agent_events/files` 都带 `org_id`。
- 暂不做复杂 RBAC，仅区分 `admin/user`。

### 3.3 Session Orchestration 层

职责：

- 管理 chat session。
- 保存当前 WebSocket subscribers。
- 将用户消息写入 DB 并推送给 runtime。
- 监听 SDK/runtime 事件并广播给前端。
- 向 RuntimeManager 上报：
  - `subscriberCount`
  - `agentBusy`
  - `pendingApproval`

必须保留：

- `MessageQueue` 长会话模式。
- `Session` 不直接依赖 Docker 细节，只依赖 `AgentRuntime`。

### 3.4 Runtime Management 层

核心组件：

- `AgentRuntime`：统一 runtime 接口。
- `DockerAgentRuntime`：Docker 容器实现。
- `ContainerManager`：runtime 生命周期管理。
- `RuntimePolicy`：idle stop、TTL、quota、安全保护条件。
- `VolumeUsageProvider`：workspace / claude-home 用量统计。
- `RuntimeStatusProvider`：给未来控制面查询状态。

职责：

- fresh start。
- warm reconnect。
- cold resume。
- idle stop。
- delete cleanup。
- crash reconciliation。
- runtime status 查询。

### 3.5 Sandbox Runtime 层

每个 chat 一个容器，核心挂载：

```text
/workspace
  chat/project 工作目录。用户上传、Agent 输出、临时文件、项目级配置、项目级 skills、运行时依赖都可以在这里

/root/.claude
  Claude Code home。保存 transcript / session state / Claude Code 自身状态，用于原生 resume

/opt/agent/plugins
  平台预装 Claude Code plugins / skills，默认只读

/opt/agent/mcp
  平台预装本地 MCP server 或 MCP config，默认只读

/opt/agent/config
  平台注入 profile / policy / prompt，默认只读

/user-memory
  当前认证用户的 MEMORY.md（一用户一文档，跨该用户的 Agent/Chat 共享）。
  主机源目录绑定挂载（读写），仅 /user-memory/MEMORY.md 这一个确切路径的
  Write/Edit 免审批并在配额内，其它路径不变。
```

原则：

- `/workspace` 是 Claude Code 的项目工作空间，允许存在项目级 `.claude/skills`、项目依赖和用户/Agent 生成内容。
- `/root/.claude` 是 Claude Code home，必须持久化以支持 `claudeSessionId` resume，不作为平台能力包缓存目录。
- `/opt/agent/*` 是平台预装能力目录，通过 `CapabilityProvider` 注入，默认只读。
- 当前 MVP 不做复杂网络网关、依赖白名单或 profile 体系；先保证目录语义清晰、运行状态可恢复。

### 3.6 Capability Injection 层

这是未来 Skill / MCP / API 能力平台的扩展口，但 MVP 只做本地 provider。

接口：

```ts
CapabilityProvider.resolve({
  orgId,
  userId,
  chatId,
  profileId,
  runtimeType
}) => CapabilityBundle
```

返回值必须贴近 Claude Agent SDK 的接收逻辑：

```ts
type CapabilityBundle = {
  sdkOptions: {
    plugins?: Array<{ type: "local"; path: string }>;
    mcpServers?: Record<string, McpServerConfig>;
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    systemPrompt?: string;
    appendSystemPrompt?: string;
    additionalDirectories?: string[];
  };
  mounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>;
  env: Record<string, string>;
};
```

注意：

- `sdkOptions.plugins[].path` 是容器内路径。
- `mounts[].hostPath` 是宿主机路径。
- 平台注入的 Skill / Plugin / MCP 文件不放 `/workspace`，使用 `/opt/agent/*`。
- 用户或项目自己创建的 `.claude/skills` 可以存在于 `/workspace`，这是 Claude Code 项目工作流的一部分，不由平台作为“预装能力”管理。
- MCP 本轮只保留 `mcpServers` 注入接口；不建设 MCP Hub，不做复杂 MCP 包安装流程。

### 3.7 Persistence / Observability 层

职责：

- 业务状态持久化。
- Runtime 生命周期状态持久化。
- Agent 事件 append-only 记录。
- 文件 metadata。
- Runtime status / last error / cleanup reason。

生产目标：

- PostgreSQL：业务主数据、事件、审计。
- Redis：MVP 可延后。多实例部署、分布式锁、pub/sub、短期状态时再引入。

### 3.8 Application Layer 层（Phase 6 — 规划/进行中）

职责：把「带能力的 chat 应用」收口成「应用可插入的平台」。应用 = 平台里的预设,自带前端、用 app-scoped API 调平台;**平台 = 引擎 + 治理 + 扩展点透传,不建领域层**。

- **双身份鉴权**:`app key(应用 principal) + user JWT(操作者 principal)`,两个独立 principal,app key 绝不替代用户 auth。
- **app-scoped 端点**:`/api/apps/:appId/agents`、`/api/apps/:appId/ws`,内部复用现有 handler,不重载 UI 路由(legacy chat 稳定、隔离可审计)。
- **应用预设**:profile(复用 MP5d)+ app 能力 allowlist(上界,deny-by-intersection)+ 数据空间(`appId × userId` 隔离)。
- **扩展点透传(不重新定义)**:能力挂载(已有)/ Hook 透传(规划)/ 事件流(规划)——见 `docs/03-modules/application-extension-points.md`。
- **治理守卫铁律不可被应用或应用 hook 覆盖**:deny-default、`/opt/agent/mcp/` 前缀、`strictMcpConfig`、路径校验、审计。

权威文档:`docs/02-architecture/platform-application-layer-architecture.md`(含决策记录)。
As-built:`applications` / `application_capabilities` 表已建,`agents.app_id` 已加(NOT NULL DEFAULT `'default-app'`);双身份鉴权、app-scoped API、Hook 透传尚未实现(见扩展点文档)。

---

## 4. 核心运行流程

### 4.1 发送消息

```text
Browser
  -> WebSocket chat message
  -> JWT 校验，得到 RequestContext
  -> 校验 chat ownership
  -> 写入 messages
  -> Session.sendMessage()
  -> ContainerManager.ensureRuntime()
  -> Runtime.sendMessage()
  -> Claude SDK
  -> SDK events
  -> agent_events + messages
  -> WebSocket broadcast
```

### 4.2 Fresh Start

```text
无 agent_sessions 或无 claudeSessionId
  -> CapabilityProvider.resolve()
  -> 创建 workspace volume
  -> 创建 claude-home volume
  -> 准备 capability mounts
  -> 启动 Docker container
  -> query({ persistSession: true, ...sdkOptions })
  -> 捕获 session_id
  -> 写入 agent_sessions.claude_session_id
  -> restore_mode = fresh
```

### 4.3 Cold Resume

```text
agent_sessions.status != running
且 claude_session_id 存在
  -> 挂载旧 workspace volume
  -> 挂载旧 claude-home volume 到 /root/.claude
  -> query({ resume: claudeSessionId, persistSession: true })
  -> restore_mode = claude_resume
  -> restart_count + 1
```

已验证事实：

- 仅保存 `claudeSessionId` 不够。
- 必须持久化 `/root/.claude` 中 Claude Code transcript。
- 当前 cold resume 已通过端到端 smoke test。

### 4.4 Resume Fallback

```text
Claude resume 失败
  -> restore_mode = from_messages
  -> 读取 DB messages
  -> 构造恢复上下文
  -> 推给新 Agent
  -> 记录 fallback_reason
```

MVP 仍需实现和验证此失败路径。

### 4.5 Idle Stop

触发条件：

```text
subscriberCount = 0
agentBusy = false
pendingApproval = false
idleMs > runtimePolicy.idleStopMs
```

动作：

```text
stop container
保留 workspace volume
保留 claude-home volume
agent_sessions.status = stopped
cleanup_reason = idle_timeout
```

### 4.6 Delete Chat

```text
校验 ownership
关闭 Session
stop/remove runtime container
删除 workspace volume
删除 claude-home volume
删除 messages / events / agent_sessions / files
删除 chat
```

已验证：

- 删除 chat 后 `agent-workspace-<chatId>` 和 `agent-claude-home-<chatId>` 可清理。
- volume 删除需要短重试，避免 Docker AutoRemove 释放延迟导致 409 conflict。

---

## 5. RuntimePolicy

不要把生命周期规则散落成常量。MVP 引入统一 policy：

```ts
type RuntimePolicy = {
  idleStopMs: number;
  workspaceTtlMs: number;
  claudeHomeTtlMs: number;
  maxWorkspaceBytes: number;
  maxClaudeHomeBytes: number;
  protectWhenBusy: boolean;
  protectWhenPendingApproval: boolean;
  protectWhenSubscribers: boolean;
  deleteChatRemovesVolumes: boolean;
};
```

默认建议：

| 项 | 默认值 |
|---|---|
| idleStopMs | 30 分钟 |
| workspaceTtlMs | 7 天未访问 |
| claudeHomeTtlMs | 30 天未访问或随 chat 生命周期 |
| maxWorkspaceBytes | 1GB soft limit |
| maxClaudeHomeBytes | 100MB soft limit |
| protectWhenBusy | true |
| protectWhenPendingApproval | true |
| protectWhenSubscribers | true |
| deleteChatRemovesVolumes | true |

阶段一可以先做 soft limit：统计、记录、拒绝新增大文件或提示清理。硬 quota 后续再结合存储方案处理。

---

## 6. CapabilityProvider 设计

### 6.1 为什么需要这个接口

Skill、MCP、API Connector、Prompt、Tool Policy、Sandbox Policy 都属于 Agent 运行能力。当前平台不应该内建完整能力市场，而应消费一个统一的能力声明。

MVP 实现：

```text
LocalCapabilityProvider
  从 config/capabilities.json 或默认配置读取
```

未来扩展：

```text
RemoteCapabilityProvider
  调用外部 Skill/MCP/API 能力平台
```

### 6.2 Skill / Plugin

Claude Agent SDK 的加载入口是：

```ts
plugins: [
  { type: "local", path: "/opt/agent/plugins/<pluginId>" }
]
```

SDK 会转成 Claude Code CLI 参数：

```text
--plugin-dir /opt/agent/plugins/<pluginId>
```

因此平台导入 skill 的正确路径：

```text
Skill Hub / 本地包
  -> 下载、校验、缓存到宿主机
  -> Docker 只读挂载到 /opt/agent/plugins/<pluginId>
  -> SDK options.plugins 使用容器内路径
```

MVP 约束：

- 平台预装 skill/plugin 走 `CapabilityProvider -> plugins option -> /opt/agent/plugins/*`。
- 用户或项目自己创建的 skill 可以放在 `/workspace/.claude/skills`，这符合 Claude Code 的项目级工作方式。
- `/root/.claude` 主要用于 Claude Code home/session，不作为平台 skill 包缓存目录。
- 本轮不实现 Skill Hub、安装市场、版本管理或审批发布流程。

用户维度控制方式：

```text
userId -> profileId -> enabled capabilities -> plugins
```

平台能力文件本体按 org/system/project 缓存和挂载，启用关系后续按 profile/user/chat 控制。用户项目级 skills 随 `/workspace` 生命周期走。

### 6.3 MCP

Claude Agent SDK 的加载入口是：

```ts
mcpServers: {
  myServer: {
    command: "node",
    args: ["/opt/agent/mcp/my-server/server.js"]
  }
}
```

SDK 会转成：

```text
--mcp-config <json>
```

本地 MCP：

- 包缓存到宿主机。
- 只读挂载到 `/opt/agent/mcp/<mcpId>`。
- `mcpServers` 使用容器内路径。

远程 MCP：

- 不需要挂载文件。
- `mcpServers` 使用远程配置。
- secrets 通过安全 env 或 secret mount 注入。

MVP 本轮只要求接口形状符合 Claude Agent SDK 的 `mcpServers` 注入方式，不建设 MCP Hub，也不限制网络下载策略。后续真正接入 MCP 时，再按本地 MCP / 远程 MCP 分别补安装、密钥和审计策略。

### 6.4 Tool Policy

默认 profile（default-sandbox）：

```text
tools: Read, Grep, Glob, Write, Edit, Bash
allowedTools: Read, Grep, Glob
approvalRequiredTools: Write, Edit, Bash
disallowedTools: []
```

沙盒负责隔离风险，Agent 默认具备完整工作能力。Read/Grep/Glob 自动允许；Write/Edit/Bash 默认需要用户 approval。disallowedTools 默认空，可后续配置禁用。

后续可按企业需要配置更严格 profile：

```text
tools: Read, Grep, Glob
allowedTools: Read, Grep, Glob
disallowedTools: Bash, Write, Edit
```

当前 MVP 先不建设复杂 profile 体系。前端不能直接传 `tools/plugins/mcpServers`，但可以在后续产品设计中选择由后端定义好的能力集合。

---

## 7. 最小数据模型

生产目标 PostgreSQL。SQLite local dev 可保留同构 schema。

```text
organizations
  id, name, created_at

users
  id, org_id, username, password_hash, display_name, role, created_at

agent_profiles
  id, org_id, name, system_prompt, tool_policy_json, runtime_policy_json, enabled

user_agent_profiles
  user_id, profile_id, is_default

chats
  id, org_id, user_id, profile_id, title, created_at, updated_at

messages
  id, org_id, chat_id, role, content, timestamp

agent_sessions
  id, org_id, user_id, chat_id
  claude_session_id
  runtime_type, status, restore_mode
  container_id, container_name, host_port
  workspace_volume, claude_home_volume
  restart_count
  last_activity_at, last_heartbeat_at
  last_error, cleanup_reason
  created_at, updated_at

agent_events
  id, org_id, user_id, chat_id, agent_session_id
  sequence, event_type, payload_json, created_at

files
  id, org_id, user_id, chat_id
  kind              -- input | output
  filename, path, mime_type, size_bytes
  created_at
```

> **Phase 5 (Option C) as-built 与上面这张目标草图有出入**：实际多了一张
> `agents` 表（与 `chats` 同 id 桥接、无硬 FK），`profile_id` 及 per-Agent 的
> `system_prompt` / `append_system_prompt` 落在 `agents` 上而不是 `chats` 上；
> `agent_profiles` 目前只实现了子集 `{ id, org_id, name, description,
> system_prompt, append_system_prompt }`（暂无 `tool_policy_json` /
> `runtime_policy_json` / `enabled`）；`user_agent_profiles` 尚未建。详见
> 内部迁移文档（未随开源发布） §Phase 5
> As-built。

关键要求：

- 所有业务查询必须带 `org_id` 或通过 ownership 校验间接约束。
- `agent_events` append-only，用于 UI 重放和审计。
- `files.path` 阶段一指向 workspace 内路径，未来可替换 object key。

---

## 8. 最小 API

### 8.1 Chat

```text
GET    /api/chats
POST   /api/chats
GET    /api/chats/:id
DELETE /api/chats/:id
GET    /api/chats/:id/messages
```

### 8.2 Files

```text
POST /api/chats/:id/files/input
GET  /api/chats/:id/files
GET  /api/chats/:id/files/:fileId/download
```

阶段一：

- 上传写入 `/workspace/input`。
- 下载读取 `/workspace/output` 或文件表记录路径。

### 8.3 Runtime Status

```text
GET  /api/chats/:id/runtime
POST /api/chats/:id/runtime/stop
POST /api/chats/:id/runtime/restart
```

MVP 可先只做查询，stop/restart 作为 admin-only。

返回字段：

```json
{
  "chatId": "chat_x",
  "status": "running",
  "restoreMode": "claude_resume",
  "containerId": "abc",
  "hostPort": 36015,
  "claudeSessionId": "c3e...",
  "restartCount": 1,
  "lastActivityAt": "...",
  "workspaceVolume": "agent-workspace-...",
  "claudeHomeVolume": "agent-claude-home-...",
  "workspaceBytes": 1048576,
  "claudeHomeBytes": 94208,
  "lastError": null
}
```

---

## 9. 安全基线

MVP 必须补齐：

1. `JWT_SECRET` 生产环境必须显式配置，不能 fallback 到 dev secret。
2. 默认 admin 密码不能是 `admin123`，生产未配置时拒绝启动。
3. CORS 使用 allowlist。
4. 登录、注册、WebSocket、发送消息加 rate limit。
5. WebSocket 每条消息校验 chat ownership。
6. 默认 `Write / Edit / Bash` 需要 approval，不自动执行。
7. 容器不使用 bypass permission。
8. API key / MCP secrets 不写入 DB 明文，不进入 `agent_events`。
9. runtime events 中工具输入输出要做长度限制和敏感信息保护。

---

## 10. 解耦边界与演进风险

当前架构的目标不是把所有平台能力一次性做完，而是确保 MVP 实现不会把关键边界写死。以下边界必须在实现阶段持续遵守。

### 10.1 Session 与 Runtime 解耦

`Session` 只能依赖 `AgentRuntime` 接口，不应直接操作 Docker、volume、container id 或 Docker API。

允许：

```text
Session
  -> runtime.sendMessage()
  -> runtime.getEventStream()
  -> lifecycle hooks
```

不允许：

```text
Session
  -> docker.getContainer()
  -> remove volume
  -> 读取 container labels
```

原因：未来 runtime 可能从 Docker 切换为 Kubernetes、远程 runtime service 或 VM sandbox。Session 层不能绑定具体 runtime。

### 10.2 ContainerManager 不应无限膨胀

MVP 阶段 `ContainerManager` 可以继续承担生命周期编排，但应避免继续把所有职责塞进去。

当前可接受职责：

```text
ensureRuntime
freshStart / coldResume / warmReconnect
stopRuntime
deleteChat runtime cleanup
health / idle detection
```

中期应拆分的职责：

```text
RuntimeLifecycleService
  fresh / resume / stop / restart

RuntimeStateStore
  agent_sessions 状态读写

VolumeManager
  workspace / claude-home 创建、统计、删除

RuntimeSweeper
  idle stop、TTL、quota、cleanup reason
```

MVP 不要求立即拆分，但新增功能时应优先通过小 service 或 helper 注入，避免 `ContainerManager` 变成不可维护的大类。

### 10.3 CapabilityProvider 与 DockerRuntime 解耦

`CapabilityProvider` 负责回答“这个用户、这个 profile、这个 chat 允许哪些能力”。`DockerAgentRuntime` 只负责根据已准备好的 mounts/env/sdkOptions 启动容器。

正确边界：

```text
CapabilityProvider
  -> CapabilityBundle

RuntimePreparer
  -> 校验、下载、缓存、生成 mounts

DockerAgentRuntime
  -> createContainer(mounts, env)

agent-entry
  -> query({ options: sdkOptions })
```

不允许：

```text
DockerAgentRuntime 直接查 skill 表
DockerAgentRuntime 直接调用 Skill Hub
DockerAgentRuntime 直接决定用户能用哪些 MCP
前端直接传 tools/plugins/mcpServers
```

原因：能力平台未来可能独立演进，runtime 不应知道能力来源。

### 10.4 文件流转需要 FileWorkspaceService

`/workspace/input`、`/workspace/output` 是阶段一文件策略，但文件路径不应散落在 API、前端和 runtime 代码里。

建议新增轻量服务：

```text
FileWorkspaceService
  uploadInput(chatId, file)
  listFiles(chatId)
  registerOutput(chatId, path)
  getDownload(chatId, fileId)
  getWorkspacePaths(chatId)
```

MVP 阶段可只实现本地 workspace volume。未来迁移 object storage 时，只替换 FileWorkspaceService，不重写 chat/session/runtime。

### 10.5 工具权限语义必须统一

工具策略必须始终按以下语义理解：

```text
tools
  Agent 可见工具全集

allowedTools
  自动允许执行的工具

disallowedTools
  强禁止工具

approvalRequired
  tools - allowedTools - disallowedTools
```

默认 sandbox profile：

```text
tools: Read, Grep, Glob, Write, Edit, Bash
allowedTools: Read, Grep, Glob
approvalRequiredTools: Write, Edit, Bash
disallowedTools: []
```

前端可以展示工具策略，但不能直接决定工具策略。

### 10.6 Workspace 与平台能力的关系

`/workspace` 是 Claude Code 的项目工作空间。用户上传文件、Agent 输出、项目代码、项目级 `.claude/skills`、运行时依赖都可以存在于这里，并随 chat workspace volume 生命周期保留和清理。

平台预装能力与 workspace 内项目内容分开管理：

```text
/workspace
  用户/项目空间，可写，可包含项目级 skills 和依赖

/opt/agent/plugins
  平台预装 plugin / skill，只读挂载

/opt/agent/mcp
  平台预装本地 MCP，只读挂载

/opt/agent/config
  平台注入配置，只读挂载
```

这不是为了禁止用户创建 skill，而是为了区分“用户项目自带能力”和“平台预装能力”。MVP 不关闭 Claude Code 默认 discovery，不做复杂网络网关，不做运行时依赖白名单；运行时安装的用户任务依赖默认落在 `/workspace`，平台能力依赖进入镜像或 `/opt/agent/*`。

### 10.7 当前架构的主要风险

| 风险 | 表现 | 控制方式 |
|---|---|---|
| Runtime 大类膨胀 | `ContainerManager` 承担所有职责 | 新增 helper/service，保留演进边界 |
| 能力注入耦合 | Docker runtime 直接查 Skill/MCP | 坚持 CapabilityBundle |
| 文件路径散落 | 前端/API/runtime 都拼 `/workspace` | 引入 FileWorkspaceService |
| 权限语义混乱 | tools/allowedTools/approval 混用 | 固定 ToolPolicy 语义 |
| 多租户后补困难 | 只传 userId/chatId | 尽早引入 orgId / RequestContext |
| 目录语义混乱 | 用户文件、项目 skill、平台能力混为一谈 | `/workspace` 是项目空间，`/opt/agent/*` 是平台预装能力 |

---

## 11. 实施优先级

### P0：把当前已验证 Runtime 固化为架构

1. 保持 `AgentRuntime` 抽象。
2. 保持 per-chat workspace volume。
3. 保持 per-chat claude-home volume。
4. 将 `claude_home_volume` 写入 DB。
5. 将 cold resume smoke test 固化为脚本。

### P1：企业 MVP 必需

1. `orgId` / `RequestContext`。
2. PostgreSQL schema。
3. 安全启动配置。
4. 默认 safe tool profile。
5. `RuntimePolicy` 模块。
6. `CapabilityProvider` 本地实现。
7. 文件上传 / 下载阶段一。
8. Runtime status API。
9. Resume fallback。

### P2：可运维边界

1. Volume usage 统计。
2. Idle stop 端到端验证。
3. Cleanup reason / last error。
4. 基础结构化日志。
5. 简单 admin-only runtime stop/restart API。

### P3：延后平台化

1. Skill Hub 对接。
2. MCP Hub 对接。
3. API Connector 平台。
4. 管理控制台 UI。
5. Object Storage。
6. Redis / 多实例部署。
7. Kubernetes。

---

## 12. 当前结论

当前项目最关键的技术风险已经不在 “Docker runtime 是否可行”。这部分已经通过：

- 容器启动。
- Claude SDK 运行。
- `claudeSessionId` 入库。
- `/root/.claude` transcript 持久化。
- cold resume。
- 删除 chat 清理 volumes。

下一步的核心是把这些能力从“局部实现”收敛成稳定架构：

```text
RequestContext
  -> AgentProfile
  -> CapabilityBundle
  -> RuntimePolicy
  -> DockerAgentRuntime
  -> agent_sessions / agent_events / files
```

这样既保持 MVP 简洁，又为未来控制面、运维观测、Skill/MCP/API 能力平台留下清晰接口。
