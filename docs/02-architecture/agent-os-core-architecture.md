# Agent OS 核心架构

> 状态：v2，已确认核心形态
>
> 范围：单企业、多部门部署；面向使用 Claude Agent SDK 开发独立业务应用的团队。
>
> 相关文档：[Agent OS 总体计划](../开发计划/agent-os-overall-plan.md)、[Local MicroVM Runtime 计划](../开发计划/local-microvm-runtime-整体研发计划.md)、[未来扩展计划](../开发计划/agent-os-future-extension-plan.md)、[安全整体报告](./agent-os-security-overview.md)、[Application Layer](./platform-application-layer-architecture.md)、[应用扩展点](../03-modules/application-extension-points.md)、[平台内置 Web Tools](./platform-built-in-web-tools.md)、[单企业多部门治理](./single-enterprise-org-governance-design.md)。

## 1. 一句话定位

平台提供一套可部署的 **Agent OS 软件包**：管理面、Agent Runtime 执行面、统一工作台和 SDK/API。它负责 **Agent Loop + 用户与部门治理 + MCP/Skill 能力治理 + 最小执行追踪**；应用团队提供自己的业务前端、业务逻辑和业务能力。

平台不建设应用领域层，也不要求业务代码合并进平台仓库。

## 2. 核心边界

### 平台统一负责

- 提供标准 Agent OS Runtime；当前 Runtime 内部使用 Claude Agent SDK，但 SDK 不是 Runtime 本身。
- 维护 Agent 会话、工作区、Local/Docker runtime、恢复和执行事件。
- 管理平台用户、部门、角色、Application 身份和平台访问权限；不接管应用自己的业务用户和业务授权。
- 注册、审核、授权并注入 MCP/Skill。
- 执行 Tool allow / approval / deny 策略。
- 记录一次执行属于哪个应用、用户、Agent，以及结果和成本。

### 应用开发者负责

- 独立开发业务前端和业务服务。
- 维护业务数据库、业务规则、页面流程和展示方式。
- 开发应用专属 MCP 或 Skill，并提交平台注册。
- 声明应用需要哪些能力，不直接控制 SDK、容器和宿主机路径；可以部署标准 Runtime，但不得重新实现 Agent Loop。

### 明确不做

- 不允许应用自行重实现 Agent Loop；应用可以独立部署和运维平台提供的标准 Agent OS Runtime。
- 不建设第三种自定义 Tool 协议：应用 Tool 统一通过 MCP 或 Skill 交付。
- 不引入多企业 tenant 层；现有 `org` 继续表示部门。
- 不建设复杂 Agent 发布、版本、回滚和工作流系统。
- 不建设事件总线、Span 系统或多套观测存储。

### 2.1 管理面与执行面

```text
管理面：Console、用户/部门/权限、Agent、模型、Skill/MCP、审批策略、审计
                         │ 配置与生命周期
                         ▼
执行面：Agent Runtime、Session、Workspace、隔离、恢复、Tool 执行、事件与用量
```

两者是职责边界，不要求拆成微服务或独立仓库。中央托管模式下 Console 是配置权威；独立实例模式下本地 Console/配置是权威。

### 2.2 两种部署形态

#### 中央托管模式

中央 Console 管理多个 Application，每个 Application 由业务开发团队部署一个专属执行 Runtime：

```text
中央 Console
├─ 平台工作台 Runtime
├─ 应用 A 专属 Runtime
├─ 应用 B 专属 Runtime
└─ 其他 Application Runtime
```

- 每个 Application 的 Runtime、Agent、Session、Workspace、能力、模型和升级窗口独立。
- 业务开发团队负责部署和升级自己的 Runtime；Runtime 使用标准 Agent OS Runtime，不修改 Agent Loop 核心。
- 业务团队通过 Prompt、Skill、MCP、配置和受控扩展点定制。
- Console 负责 Runtime 注册、健康、版本、生命周期、治理配置和运行记录。
- 中央 Console 是模型、能力和审批策略的配置权威。

#### 独立实例模式

应用团队部署完整的一套 Agent OS 软件包：

```text
独立 Agent OS 实例
├─ 本地 Console
├─ 本地统一工作台
├─ 本地执行 Runtime
├─ 本地用户/部门/权限
├─ 本地模型与 Skill/MCP
└─ 本地 SDK/API
```

- 实例完全自治，不依赖中央 Console，也不接受中央下发或阻断。
- 本地 Console 和配置是最终权威；应用团队自行负责部署、升级、用户体系、能力、模型和审计。
- 两种模式复用同一套 Runtime 软件和最小执行协议，但不要求共享完整控制面。

### 2.3 共同执行契约

两种部署模式必须保持以下 SDK/API 契约一致：

```text
run / stream events / approval / resume / cancel
capability declaration
health / version
usage / result
```

业务应用不直接依赖 Claude SDK 原始消息、`query()` 参数或容器选项。

### 2.4 未来演进边界

当前单 VM 版本中，平台 Node 进程管理本机 Docker，Runtime 物理绑定该进程和主机。这是首发部署形态，不是需要提前消除的问题。

未来只有出现明确容量、可用性或独立运维需求时，才把 Runtime 做成可远程部署的执行节点：中央管理面通过稳定 Runtime 协议连接执行节点，执行节点继续管理自己所在主机的 Docker。这里改变的是管理面与 Runtime 的连接方式，不是让执行脱离机器运行。

未来多引擎与多 VM 是两个独立方向：

```text
业务应用 / 平台工作台
          ↓
平台 Runtime 契约：run / events / approval / cancel / resume / health
          ↓
Engine Adapter：Claude Adapter / Pi Adapter / 其他 Adapter
          ↓
实际 Agent Engine
```

- 多 VM 解决“Runtime 在哪台机器运行、如何注册和路由”，不等于多引擎。
- 多引擎解决“同一平台契约如何驱动不同 Agent Engine”，不要求先做多 VM。
- Runtime 契约只统一平台真正依赖的最小行为；引擎差异通过能力声明暴露，不强行制造完全一致的功能表面。
- 多 VM 初版保持 Session/Workspace 对 Runtime 节点的亲和性，不先做运行中迁移、共享文件系统、消息总线或自动故障切换。
- 当控制面需要多实例共同读写状态时，先把平台元数据迁到 MySQL；Workspace 和 Claude 会话文件仍由 Runtime 节点管理，是否引入对象存储由冷恢复需求触发。

具体触发条件、阶段和验收见[未来扩展计划](../开发计划/agent-os-future-extension-plan.md)。该计划是后置路线图，不自动进入当前开发主线。

### 2.5 Runtime 隔离与多引擎演进

生产态当前仍为两种 Runtime：`local` 是可信任务的进程内最低成本路径，`docker` 是已接入生产治理的强隔离路径。`local-sandbox` 是正在验证的第三种模式：以每 Agent 一个轻量 MicroVM 承载完整 Harness 进程树，在安全、容量和生产接入门槛通过后，目标是成为默认强隔离 Runtime；在此之前 Docker 不退役，也不得从 MicroVM 不可用状态静默降级到普通 `local`。

```text
Session / Control Plane
        |
        | Platform Runtime Protocol
        v
AgentRuntime adapter
  +-- LocalAgentRuntime             (production)
  +-- DockerAgentRuntime            (production)
  +-- MicrosandboxAgentRuntime      (planned, M3)
        |
        v
MicroVM Guest Worker
        |
        +-- ClaudeHarnessAdapter     (first committed engine)
        +-- Codex/Pi/other Adapter   (independently verified stretch engines)
```

平台中立适配层已经完成前置设计和合同实现：M0 盘点出 41 个 Claude 耦合点；M0.5 冻结 `PlatformRuntimeCommand`、`PlatformRuntimeEvent`、`EngineCapabilities` 和 `ResolvedExecutionPolicy`，并实现尚未接入生产链路的 Claude normalizer。Host 始终是身份、能力、审批、runId、审计和资源策略权威；Guest 与 Harness Adapter 只负责编译策略、执行引擎并转换标准事件，不得建立第二套权限或审批体系。

截至 2026-09-15，M1 真实 MicroVM POC 已通过文件、跨 Agent workspace、进程和私网/metadata 网络隔离验证，生命周期冷启动约 `220-231 ms`、恢复约 `136-138 ms`；最终提交 `ed8b25e` 已由合并提交 `e01f108` 纳入主线，但尚未接入生产 Runtime。M2 当前 ACTIVE，将在同机上比较 Local、Docker 和 MicroVM 的 1/10/50/100 实例资源与长稳表现；只有 M2 给出 Go 结论后，M3 才能修改生产 Runtime。

阶段状态、证据、限制和准入条件以 [Local MicroVM Runtime 计划](../开发计划/local-microvm-runtime-整体研发计划.md) 的状态表为权威来源；本架构文档只维护稳定边界和已被验证的架构结论。

## 3. 核心组件

```text
独立业务应用
  前端 + 业务后端
          │ App Key + 平台 User JWT 或应用用户 subject
          ▼
Application API
  应用身份、受众校验、Agent 访问
          ▼
  Agent Runtime
  Session → Claude Agent SDK（当前内部引擎）→ Tool/Approval
          │
          ├── CapabilityProvider → MCP / Skill
          ├── Workspace / Runtime
          └── Execution Record → runId / result / cost

企业管理台
  部门、用户、Application、能力、审批策略、审计
```

### 3.1 Application API

Application 是外部业务应用接入平台的边界。管理员创建 Application 后，平台生成：

```text
appId
appKey
可访问部门/用户
可使用 MCP/Skill
Tool 策略
```

应用后端保存 `appKey`，浏览器只持有平台签发的短期 Token（用户 JWT、Widget Token 或 app-scoped Runtime Token）。`appKey` 不得进入浏览器代码或前端环境变量。

调用方与校验身份的关系有三条路径：

```text
S2S（应用后端） : App Key + 平台 User JWT        — 管理面 / 服务调用
S2S（应用后端） : App Key + Runtime Token        — 应用后端代 subject 操作
浏览器（M1）   : Runtime Token only（无 AppKey）— 应用用户直接访问
```

每次调用校验执行主体：`App Key → 哪个应用在调用`（S2S 路径），`User JWT / Runtime Token → 哪个执行主体正在操作`。Token-only 路径下，Runtime Token 自身同时证明应用与主体：服务端按 Token 内的 `appId` 重新读取当前 Application 记录，校验 Application 处于 active、Token 绑定的 `apiKeyPrefix` 等于当前 `applications.api_key_prefix`（AppKey 轮换即失效）、principal 处于 active 且归属本应用、org 一致、可选 Agent 绑定，全程不需要明文 AppKey。

二者都通过后，平台仍需确认执行主体能访问该 Application 的 Agent，并确认目标 Agent 属于该 Application。

平台用户是默认身份路径。应用也可以先使用自己的身份系统认证用户，再由应用后端用 `appKey + opaque subject` 换取短期 `app-scoped Runtime Token`（`POST /api/apps/:appId/runtime-tokens`）。该 Token 只携带 `appId`、opaque `principalId`、`apiKeyPrefix`、可选 Agent/会话绑定和过期时间，**不携带原始 subject**（subject 由服务端 `resolvePrincipal` 解析，仅用于审计）；平台不解释应用的业务角色、部门和数据权限。浏览器凭该 Token 即可访问本 Application 下属于当前执行主体的 REST/WS 资源，无需 AppKey；应用 MCP/API 负责校验该 subject 的业务数据权限。只有明确配置的可信映射，才可继承平台用户的企业级权限。

平台内部用两类稳定执行身份键区分主体：平台用户 = `platform:<userId>`；应用主体 = `app_principals.id`（opaque `principalId`）。该 `principalId` 是 data plane 唯一消费的运行/存储键——它直接落在 `agents.owner_user_id`、Session Map 与工作区隔离键上，扩宽 `user_id` 的值域而**不新增列、不新增 token kind**。原始 `subject` 永不下沉到 data plane：它仅由服务端 `resolvePrincipal` 在 `app_principals` 内部登记一次，作为**审计-only** 的 `principalKey`（`app:<appId>:<subject>`）保留，运行/存储路径从不读取它。这样应用用户不必先创建到平台 `users` 表，平台仍能完成 Agent、Session、Workspace 和审计隔离。

### 3.2 Agent Runtime 与 Agent Loop

Claude Agent SDK 只在 Agent Runtime 内部运行。应用通过 SDK/API/WS 发送任务并接收流式结果，不直接传入 `tools`、`plugins`、`mcpServers`、Docker 参数或宿主机路径。

```text
应用发送消息
  → 校验 Application 和用户
  → 获取或恢复 Agent Session
  → 解析本次允许的能力
  → Agent Runtime 读取有效配置并调用 Claude Agent SDK
  → Tool Approval
  → 流式返回结果
  → 保存执行记录
```

Docker 是生产级完整运行时；Local 是开发调试模式，不承诺 MCP、Hook 和隔离能力完全一致。

#### 3.2.1 平台内置 Web Tools

`BailianSearch` 和 `LocalFetch` 是 Runtime 基础 Tool，与 `Read`、`Write`、`Bash` 同层，不是应用提交的普通 MCP 资源。它们可以使用 SDK 的进程内 MCP 作为内部适配，但不进入 `data/mcp.json`，不经过普通 MCP 的安装、entitlement、Application allowlist、Agent activation 或容器挂载。

```text
Runtime 基础 Tool
├─ SDK 内置：Read / Write / Edit / Bash / Grep / Glob
└─ 平台内置：BailianSearch / LocalFetch
```

Local 和 Docker 各自在执行进程内创建同一份 `platform-web-tools`，共享 Tool contract、审批语义和安全规则；普通第三方 MCP 仍只在 Docker 中按治理交集解析、只读挂载并由 SDK 启动。平台不得以支持这两个可信内置 Tool 为由，放开 Local 模式执行任意普通 MCP。

Bailian Search 使用部署级 `DASHSCOPE_API_KEY` 调用百炼原生联网搜索 API；Local Fetch 不需要 key。当前阶段沿用现有 `.env`/部署 Secret 注入，不建设通用 MCP Secret Store。默认策略为搜索自动放行、Fetch 需要当前用户审批；Fetch 必须阻断本机、内网、link-local、metadata、危险重定向和超大响应。详细契约见 [`platform-built-in-web-tools.md`](./platform-built-in-web-tools.md)。

### 3.3 MCP / Skill 能力治理

应用开发者可以自行开发 MCP 和 Skill，但不能提交后立即在生产运行。

```text
开发者提交
  → 平台校验并注册
  → 企业管理员审核
  → 授权给 Application/部门
  → Agent 激活
  → CapabilityProvider 解析并注入 runtime
```

应用专属能力默认只授权给该 Application，不自动共享。企业管理员可以把成熟能力分发给其他部门。

最终可用能力始终取交集：

```text
资源有效
  ∩ 部门 entitlement
  ∩ Application allowlist
  ∩ Agent activation
```

应用开发者提交能力时只需提供：名称、版本、类型、代码包或服务地址、所需环境变量、暴露的工具和网络/文件权限。

### 3.4 用户、部门与受众

当前部署只有一个企业，`org` 表示部门。角色保持三档：

```text
admin      企业管理员，跨部门治理和审计
org_admin  部门管理员，只管理本部门
user       普通用户，只使用已授权应用和能力
```

Application 受众只支持两种配置：

- 部门：该部门的有效用户可访问。
- 指定用户：对部门授权进一步增加或排除个人。

企业管理员可以跨部门分配；部门管理员只能配置本部门。前端隐藏入口只是体验控制，服务端必须对每次请求重新校验。

平台的部门和受众治理只约束平台资源访问，不替代应用业务授权。应用用户是否能查看某个客户、报表或业务数据，由应用自己的用户系统和 MCP/API 决定。

### 3.5 Tool Approval

Tool 策略只保留三种：

```text
allow     自动执行
approval  当前操作用户确认后执行
deny      禁止执行
```

执行策略按最严格结果生效：

```text
平台底线策略 ∩ Application 策略 ∩ Agent 已激活能力
```

Application 只能收紧平台策略，不能把平台要求审批的 Tool 改为自动执行。审批记录只保存应用、Agent、用户、Tool、结果和时间，不要求保存敏感参数正文。

### 3.6 最小执行追踪

每次用户消息或应用任务生成一个 `runId`。现有事件链只需统一带上：

```text
runId
appId
agentId
subject
orgId
status
cost
createdAt
```

Tool、审批和结果事件继续保留各自业务字段，并统一携带同一个 `runId`。其中 `subject` 可以是平台用户 ID 或应用 opaque subject。这样无需建设新的 Trace 系统，也能回答：哪个应用的哪个执行主体调用了哪个 Agent、用了什么能力、是否审批、最终是否成功、产生多少成本。

治理审计与聊天/文件正文分开。管理员默认查看治理元数据，不因此获得业务正文访问权。

## 4. 给应用开发者的交付物

平台只需提供一个小型接入包：

1. `appId` 和仅供应用后端使用的 `appKey`。
2. Application API 与 WebSocket 接口说明。
3. 测试用户及其部门/角色。
4. 已授权 MCP/Skill 的名称、用途和参数。
5. 一个最小示例：后端代理、前端流式对话、审批响应和环境变量模板。

开发者的交付物则是：

1. 独立部署的业务前端和业务后端。
2. 所需 MCP/Skill 清单。
3. 自研 MCP/Skill 包及权限声明。
4. Application 需要的部门、用户和 Tool 策略。

这里的“合并开发”是两种集成，不是代码仓库合并：

```text
业务应用 → 通过 Application API 接入
业务能力 → 通过 MCP / Skill 注册
```

## 5. 当前基础与核心缺口

当前已经具备：Application API 和双身份鉴权、Local/Docker Agent Loop、CapabilityProvider、MCP/Skill 注入、用户/部门治理、Tool Approval 和运行事件记录。

为了形成第一条完整的外部应用闭环，只补三项：

1. **Application 受众配置**：部门和指定用户。
2. **Application Tool 策略**：allow / approval / deny，并保持平台策略优先。
3. **最小 runId**：把 Application、用户、Agent、审批、结果和成本串起来。

除此之外的 SDK 产品化、复杂 Manifest、事件总线、完整 Trace Span、计费和多企业租户均后置。

## 6. 完成标准

选择一个普通业务应用验证以下闭环：

1. 管理员创建 Application，分配部门、用户、MCP/Skill 和 Tool 策略。
2. 应用开发者只凭接入包完成独立前端和业务后端。
3. 应用用户登录后只能访问授权 Application 和自己的 Agent。
4. Agent 只能加载该 Application 已授权且已激活的能力。
5. 敏感 Tool 必须经过当前用户审批，拒绝后不得执行。
6. 管理员可通过 `runId` 查看本次执行的身份、能力、审批、结果和成本元数据。

达到以上六点，即具备 Agent OS 最小核心闭环。
