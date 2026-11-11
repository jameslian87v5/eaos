# Agent OS 安全整体报告

> 状态：当前实现与上线准备的概览。本文只回答两件事：已经做了什么，以及还需要做什么。

## 1. 安全定位

智能体不是只返回文本的接口，而是可以读数据、调用工具、修改文件和触发外部系统的执行主体。因此平台安全的核心不是单独增加一个网关，而是把下面六件事做成内生约束：

1. 谁在操作；
2. 能访问什么资源；
3. 能执行哪些动作；
4. 高风险动作是否需要人工决定；
5. 执行发生在哪里、边界是什么；
6. 出现问题后能否追溯、停止和恢复。

平台目标与百炼的安全定位一致：明确决策权限和行为边界，建立行为追溯和风险提示机制，降低智能体对应用、数据和基础设施的衍生风险。

## 2. 当前已经实现

### 2.1 身份与权限

- 平台使用 JWT + bcrypt 认证；REST 使用 Bearer Token，WebSocket 连接也必须带 Token。
- 当前角色包括 `admin`、`org_admin` 和 `user`。`org_admin` 只能管理所属部门，不能跨部门或自行提权。
- 应用接入采用“双身份”：`App Key` 代表哪个应用，用户 JWT 或 Runtime Token 代表哪个操作者；App Key 不替代用户身份。
- 应用主体、平台用户、应用和 Agent 的归属会在服务端重新校验。请求不能自行注入 `orgId` 或伪造 owner。
- Runtime Token 为短期、可绑定应用/主体/Agent 的凭证；App Key 轮换后旧 Token 失效。

### 2.2 能力与行为边界

- 前端和普通应用不能直接传入 `tools`、`plugins`、`mcpServers`、Docker 参数或宿主机路径。
- 有效能力采用交集原则：应用允许能力 ∩ 部门授权 ∩ Agent 激活配置。任何一层未授权都不能执行。
- Tool 策略区分自动放行、需要审批和明确禁止。默认情况下 `Read/Grep/Glob/Skill` 可自动执行，`Write/Edit/Bash` 需要人工审批。
- 平台治理守卫不可被应用或 Hook 放宽，包括 deny-default、MCP 命令前缀、路径校验、严格 MCP 配置和审计要求。
- Skill 必须经过平台注册/校验/授权后才能注入；普通 MCP 也不允许绕过平台配置直接启动。

### 2.3 执行隔离

- Docker 模式按 Chat/Agent 创建独立 Runtime 容器，并使用独立 workspace 和 Claude 会话卷。
- 容器内 MCP 命令必须位于 `/opt/agent/mcp/`；Skill 路径必须位于受控 `skills/` 根目录内，防止路径穿越和宿主机任意挂载。
- 用户上传进入 `/workspace/input`，Agent 产出进入 `/workspace/output`，平台不会把上传文件自动当作指令执行。
- Local 模式有开发环境路径和能力限制；生产隔离以 Docker 模式为准。
- 平台内置 `BailianSearch` 和 `LocalFetch` 受统一 Tool contract、超时和安全策略约束。Fetch 需要阻断本机、内网、metadata、危险重定向和超大响应等 SSRF 风险。

### 2.4 行为追踪与风险提示

- 一次执行有稳定 `runId`，记录操作者、应用、Agent、配置版本、能力、模型、状态、用量、成本和结果摘要。
- Tool 审批、批准/拒绝、运行失败、恢复和停止都会进入执行事件链，管理员可按 `runId` 回看。
- 审计和运行详情不保存明文 App Key、Token，也不把敏感 Tool payload 当作普通日志长期落盘。
- 高风险动作在执行前显示审批状态；拒绝后不会继续执行该动作。
- 容器有健康检查、空闲回收和恢复路径，异常 Runtime 可以停止，避免长期占用或状态失控。

### 2.5 密钥与链路

- LLM、百炼搜索、Skill Hub 等密钥通过服务端环境变量/部署 Secret 注入，不进入浏览器、代码仓库、Prompt 或审计记录。
- 对外调用使用配置的 HTTPS Base URL；生产入口计划由 Nginx 统一终止 TLS，并通过同源 WSS 连接工作台。
- 当前平台使用百炼搜索 API 时，平台负责调用边界和密钥保护；数据加密、租户隔离和“不用于训练”等能力仍属于百炼服务侧承诺，不能替代平台自身的权限和审计。

## 3. 当前边界和未完成项

下面不是“设计缺陷”，而是生产上线前必须补齐或明确的事项：

- 当前首发是单 VM + SQLite + Docker Runtime，数据库和工作区依赖本机持久盘；不具备多节点高可用能力。
- 生产 UI 静态托管、同源 WSS、Docker Agent IPC loopback 绑定、systemd/Nginx 配置和 preflight 脚本仍属于上线准备工作。
- 生产不能继续使用默认管理员密码、开发 JWT Secret 或开放 Agent IPC 端口；真实密钥需要受限权限文件或云 Secret 注入。
- SQLite 与 Docker named volumes 必须有备份、恢复和回滚演练；删除数据、保留期限和恢复负责人需要明确。
- 当前没有百炼 `enableEncrypt` 请求体加密、私网链路、KMS 模型文件加密等云侧增强能力。敏感数据场景需在部署时单独评估，不应在文档中宣称已经具备。

## 4. 即将做的事情

### P0：上线前必须完成

1. 生产入口：完整构建并托管前端，HTTPS/WSS 只经 Nginx，后端和 Agent IPC 不直接暴露公网。
2. 主机隔离：专用 Linux VM、最小开放端口、专用 `agentos` 用户、Docker 权限和目录权限检查。
3. 密钥治理：生产密钥不进 Git；管理员初始密码、JWT Secret、模型/百炼/Skill Hub key 可替换，并形成轮换记录。
4. 数据保护：备份 SQLite、配置和 Agent 持久卷；在预发完成一次“恢复后能启动并完成对话”的演练。
5. 上线验证：至少验证登录、跨部门拒绝、跨应用拒绝、审批拒绝无副作用、容器恢复、Skill/MCP 授权、Fetch SSRF 拦截和 `runId` 审计链。

### P1：运行一段时间后补强

- 增加登录失败、审批积压、异常工具调用、密钥轮换和大批量数据读取的告警。
- 增加数据分类、保留期、用户/应用注销后的删除策略。
- 增加 Docker 基础镜像扫描、依赖漏洞检查和镜像来源校验。
- 当确实需要多 VM 或跨节点故障切换时，再迁移 MySQL、引入 Runtime 节点注册和稳定 Runtime 契约；不在首发阶段提前建设。
- 当接入更多 Agent Engine 时，通过最小 `run/events/approval/cancel/resume/health` 契约隔离引擎差异。

## 5. 上线判断

当前版本已经具备“身份、能力治理、人工审批、容器隔离、执行审计”的安全底座，可以进入单 VM 预发验证；它还不是完成全部企业安全合规工作的最终形态。

上线的最低判断标准是：任何用户只能以自己的身份，在授权的应用和 Agent 中，使用授权能力；高风险动作有明确的人为决策；执行过程有 `runId` 可追溯；容器、密钥、数据和公网入口没有越界。P0 任一项未通过，就先不对外生产。

## 6. 相关文档

- [Agent OS 核心架构](./agent-os-core-architecture.md)
- [平台内置 Web Tools](./platform-built-in-web-tools.md)
- [单 VM 生产部署计划](../06-deployment/production-vm-deployment-plan.md)
- [Agent OS 总体计划](../开发计划/agent-os-overall-plan.md)
