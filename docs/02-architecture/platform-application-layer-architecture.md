# Platform Application Layer — 产品定位与架构决策

> Status: **v3 — 加「职责边界 / 扩展点契约 / Hook 透传」;现状陈述均有源码依据(非杜撰)**
> Scope: 在已迁移完成的 agent 底座之上,新增「应用层」产品壳。
> 这份计划 **≠** migration plan(见 §5)。
> Related: `docs/00-product/agent-first-enterprise-prd.md`、
> `docs/01-domain/agent-platform-domain-model.md`、
> 内部迁移文档（未随开源发布）。
> Codex reviews: `evt_20260628145710`(v2)、本轮 v3(待审)。
> 本文不是当前开发任务入口。后续开发统一以 `docs/开发计划/agent-os-overall-plan.md` 为准；本文保留 Application Layer 的产品边界和历史决策。

---

## 0. 这份计划是什么 / 不是什么

- **是**:产品方向定位 + **平台与应用的职责边界 + 扩展点契约** + 历史决策记录。
- **不是**:当前工程任务清单；当前开发顺序和验收只看 `docs/开发计划/agent-os-overall-plan.md`。
- **不是**:Phase 0–5 存储迁移(那是 migration plan,已完成 MP5a–5f)。
- **关系**:应用层依赖 migration 成果(`agent_profiles`、`capability_resources`、`entitlement`、docker runtime、`capability-diagnostics`、审计),但 **不做存储重构、不动 docker runtime、不破坏 Phase 5 same-id bridge**。

> **本文档的「现状」与「方向」严格区分**:所有「现状」陈述都带源码位置(如 `agent-entry.ts:218`);
> 「方向/规划」是基于现状 + 已确认决策的推导,标注 *(规划)*。

---

## 1. 平台定位(第一性)

### 1.1 三条核心诉求

1. 快速接入 skill hub / MCP / plugin,与 **内网 API 充分打通**,构建能力库实现企业应用。
2. 做成 **快速模块化平台**,基于它快速构建智能问数、智能风控等应用,**不另起炉灶**。
3. **可控**:聊天记录、技能等都可控。

### 1.2 已锁定的方向

| # | 决策 | 选项 |
|---|---|---|
| 1 | 产品形态 | **平台优先** |
| 2 | 接入方式 | **Headless API/SDK** |
| 3 | 能力库来源 | **可信内部能力库**(自造/打包自维护/外部下载须审核) |
| 4 | 「应用」定义 | **应用 = 平台里的预设**(选 B:平台把应用当一等公民) |
| 5 | 租户边界 | **自用单公司**(非多租户 SaaS,暂;`org_id` 全表预留) |
| 6 | **平台厚度** | **平台 = 引擎 + 治理 + 扩展点透传。绝不建领域层、绝不重新定义 hook。** |

### 1.3 North Star(差异化)

> **企业治理 + agent 安全触达内网 API + 全自托管可控。**

平台卖的是「跑 agent 的企业级地基 + 一组扩展点」,不是某个业务(如问数)的功能。第一个应用看不出价值;建第二、三个应用(风控、看板)时,地基复用 + 统一治理,价值才显出来——这正是「不另起炉灶」的真意。

---

## 2. 应用层的形状(B 模式)

### 2.1 端到端链路

```
员工小王 ──打开──> [智能问数 前端] ──业务后端代理──> 平台 API (/api/apps/:appId/*)
                                                            │  双身份:认应用(app key)+ 认执行主体(JWT/Runtime Token)
                                                            ▼  读应用预设(profile + app 能力 allowlist + 数据空间)
                                              给小王起/复用一个「智能问数」agent 实例
                                                            │  平台能力 = app allowlist ∩ 平台 entitlement(如适用) ∩ agent activation
                                                 调内网 API、存进小王在该应用的对话空间
```

### 2.2 四个关键点

1. **前端 = Headless**:应用自带前端,REST+WS 调平台。现有 chat 工作台 = 「通用应用」参考实现。
2. **能力范围 = 应用级 allowlist(上界)**:平台能力 = `app allowlist ∩ 平台 entitlement(如适用) ∩ agent activation`。
3. **数据空间 = 按(应用 × 执行主体)隔离**；执行主体可以是平台用户，也可以是应用 opaque subject。
4. **双身份**:app key(应用 principal)+ 执行主体 Token，从第一天就分开。应用自己的业务角色和数据权限不下沉为平台 entitlement。

### 2.3「应用」实体定义

```text
id, orgId, name, description
profileId                 # 提示词模板 —— 复用 agent_profiles (MP5d)
applicationCapabilities   # 应用级能力 allowlist —— 复用 capability_resources + application_capabilities
dataSpacePolicy, entryUrl, apiKey(hash-at-rest)
```

---

## 3. 平台 vs 应用 职责边界(核心)

> 用真实业务(智能问数)对着 `业务场景梳理引导手册_v0.2.md` 拆,能力分三层归位:

| 层 | 是什么 | 归谁 | 举例 |
|---|---|---|---|
| **机制** | skill/mcp 怎么注册、注入、审批、挂载;**SDK hooks 接口的透传** | **平台**(治理+运行时的一部分) | `CapabilityProvider.resolve()`、`/opt/agent/mcp/` 守卫、hooks 透传通道 |
| **通用工具件** | 跟具体业务无关的通用 skill/mcp | **平台可附带**(轻量、非领域) | 图表生成、Excel 导出、通用 SQL 执行器 |
| **领域件** | 某业务专属 know-how | **应用自带,平台不建** | 问数语义层、口径库、经销商主数据映射、对账逻辑、业务前端 |

**铁律:**
- **平台不建领域层。** 语义层/口径/知识库/对账/业务前端永远是应用的(平台碰不得,也不该碰——这是应用的 know-how)。
- **应用不绕过治理守卫。** deny-default 安全检查、路径前缀校验等铁律,不可被应用或应用 hook 关闭。
- **手册里其实混着两种产品**:🟩灵活问数(agent 场景)与 🟦固化看板(传统 BI,定时 SQL+仪表盘,甚至不需 LLM)——是**两个应用/模块**,不是一个。

> 问数总工作量里:平台接入面 ≈ 10–20%,应用领域层 ≈ 70%+,通用工具件 ≈ 余量。**「不另起炉灶」= 不重造地基(agent loop/隔离/治理/恢复),不是不写领域层。**

---

## 4. 扩展点契约 —— 平台兑现价值的接口(核心)

> 平台的不可替代价值,具体兑现为「应用可注册/透传的扩展点」。原则:**透传 + 守卫,不重新定义**(用户决策:hook 不如把接口直接贡献出来,怎么用让应用实现)。

### 4.1 能力挂载(已有 ✅)
应用注册 skill/mcp → 平台校验 + 注入容器 + 审批。*(现状:`capability-provider.ts` resolve、`skill-config.ts`、`agent-entry.ts` mcp/plugins 挂载)*

### 4.2 Hook 透传(规划 🔧 —— 关键缺口)

**现状(有据,均非配置化):**
| 项 | 现状 | 源码 |
|---|---|---|
| PreToolUse hook | 焊死,只一种用法:非白名单工具 → 发 `approval_request` 给前端用户 | `docker/agent-entry.ts:218-255`、`server/session.ts:95-116`、`server/ai-client.ts:109-120` |
| 「哪些工具要审批」 | **硬编码常量** `approvalRequiredTools=[Write,Edit,Bash]` | `server/capability-provider.ts:93-96` `DEFAULT_PROFILE` |
| 审批总开关 | **全局环境变量** `APPROVAL_ENABLED` | `server/session.ts:69` |
| 免审批白名单 | **全局环境变量** `ALLOWED_TOOLS` | `server/session.ts:70-72`、`server/server.ts:96-111` |
| `agent_profiles` 表 | **只有 prompt 字段,无 tool-profile 字段** | `server/database.ts`(MP5d) |
| 审批的「裁判」 | **只有一种:前端用户点同意/拒绝** | `server/approval.ts` `ApprovalManager`(pending Map + 推前端 + 等 WS) |
| SDK hook 富能力 | SDK 支持比当前暴露更丰富的 hooks;平台**仅用了 PreToolUse + permissionDecision 一种** | `agent-entry.ts:218` 传入(「9 事件/4 验证器/4 级粒度」来自外部参考文档,非仓库源码直接证据) |

**对照 `2026-06-26-hooks-第一性原理与design-loop.md`(用户参考文档):** 该文档描述的 Claude Code/SDK 原生 hook 体系(事件×粒度×验证器×回传),平台目前**只挑了一种用法并焊死**,应用拿不到 hook 这个扩展点。

**方向(Route A 已落地 ✅):**
- **Hook-as-plugin**: hook 作为 native plugin 包（Claude Code plugin 格式：`.claude-plugin/plugin.json` + `hooks/hooks.json`）注册,走与 skill/mcp 相同的 capability resource 管线（`type=hook-plugin`）。
- 平台 **不翻译 hook 语义**——SDK 自动发现 plugin 的 hooks.json 并执行 hook 脚本（command type）。
- 平台只保留 **inline PreToolUse 守卫**（deny-wins,经 SDK precedence 实验证实）和容器沙箱作为安全边界。
- `updatedInput`（输入改写）定性为 **trusted-code policy,非安全边界**——precedence 实验证实 plugin `updatedInput` 在 inline hook 之后生效,故路径安全由容器沙箱强制。
- **已弃用**: 旧的 webhook envelope 模型（`HookEnvelope` / `application-hook-service` / `hook-transport`）已完全删除。
- **Rollout gate**: `HOOK_PLUGINS_ENABLED=true` 才生效（默认关闭,Docker 加固后开启）。
- 详见 `docs/04-guides/app-hook-guide.md`（应用方构建指南）。

### 4.3 事件流(规划 🔧)
平台把 agent 事件流(SDK event / tool_use / result)透传推给应用(webhook 或 app-scoped WS),应用自行做业务反应(如问数拿到结果后自己渲染/落库)。**透传,不定义业务语义。**

### 4.4 治理守卫铁律(不可被应用或应用 hook 覆盖)
- entitlement / deny-default 能力门控
- MCP `command` 必须 `/opt/agent/mcp/` 前缀;`strictMcpConfig:true` 防 `.mcp.json` 绕过
- 路径前缀校验、容器隔离边界
- 审计 / configVersion drift 记录(双 principal)
- **Hook 专属守卫(Route A)**: 平台 inline PreToolUse deny-wins（precedence 实验证实）;`updatedInput` 定性为 trusted-code policy,非安全边界;`HOOK_PLUGINS_ENABLED` rollout gate（默认关闭）;路径穿越防护（hooks/ 目录 realpath 校验）;**待实现**: 容器沙箱（readonly rootfs, cap drop, egress allowlist, pids limit）。

> 这几条是「治理」的本分,不属于「定义」,任何应用/hook 都不能关掉它们。

---

## 5. 与 migration plan 的区别

| 维度 | migration plan(Phase 0–5) | **本计划(应用层)** |
|---|---|---|
| 目的 | chat demo → agent 平台(存储拆分、resolution bridge、`agents` 表) | 在底座上加「应用」产品维度 + 扩展点契约 |
| 性质 | 底层重构(Phase 5 breaking) | **新增正交维度(additive)** |
| 依赖方向 | 自底向上 | **依赖** migration 成果 |
| 是否动 docker runtime | ADR-001 + MP 系列 | **不动** |
| 是否动 `resolve()` | Phase 2d 首次驱动 | runtime 不动;`resolve()` 输入学 appId,并**透传 hooks** |
| 是否动 same-id bridge | Phase 5 建立 | **不动** |

---

## 6. 历史整体改动范围

### 6.1 数据模型(additive)
```text
applications(id, org_id, name, description, profile_id, entry_url,
              api_key_prefix, api_key_hash, status, last_used_at, ...)
application_capabilities(id, app_id, resource_id, enabled, UNIQUE(app_id, resource_id))
agents + app_id  -- NOT NULL DEFAULT 'default-app'(规范归属在 agents,不镜像 chats)
```

### 6.2 control plane
- `ApplicationService`:应用 CRUD、api_key 签发/轮转/撤销、app_id 归属解析。
- resolve 输入学 `appId`;app allowlist 作上界,**deny-by-intersection** 合并。
- `application_capabilities` 变更 → configVersion drift + 审计(同 agent/profile)。

### 6.3 data plane(复用 + 扩展点透传)
- 复用 docker runtime、SDK query、审批基础设施。
- 双身份鉴权(app key + 平台 User JWT 或应用 Runtime Token);app-scoped 端点 `/api/apps/:appId/*`,内部复用 handler。
- **Hook 透传通道(§4.2)**:应用 hooks 配置 → resolve 翻译 → 注入容器;治理守卫铁律不可覆盖。
- **事件流透传(§4.3)**。

### 6.4 admin
应用管理 tab:CRUD、绑定 allowlist、签发/轮转 key、按应用看实例/对话/审计。现有 chat 工作台 = `default` 应用一行。

### 6.5 capability installer(阶段 A3)
内网 API → stdio MCP server → 注册资源 → 应用勾选。MVP 保持 stdio-wrapper;HTTP/SSE 后置。

---

## 7. 历史落地顺序

> 主线优先 + 守卫最小化(Codex 工程计划复核 evt_20260629020913)。**历史文件级步骤 / 验证 / 里程碑 / 风险 / debt 见 `docs/开发计划/application-layer-dev-plan.md`。**

**A0 → A1 → A2 → A3 → A4**(串行):
- **A0** 最小应用模型(M0)
- **A1** app-scoped Agent 路径 + 能力上界(M1,首个 app-scoped agent)
- **A2** hook 扩展点(M2,Route A: hook-as-plugin + 删除 envelope)✅ 已完成
- **A3** capability installer(M3,内网 HTTP API → stdio MCP)
- **A4** 智能问数样本(M4,demand #2 兑现)

铁律:A0 先于 A1;legacy `/api/chats` / `/ws` 不破;**数据隔离推迟为 debt**(storage 重写等真实跨 app 需求触发,见工程计划 §4)。

---

## 8. 决策记录

### 8.1 Codex v2 复核已采纳(evt_20260628145710)
1. resolve 输入学 app scope(不只「不动 resolve」)。
2. 双身份 app key + user JWT。
3. app_id 落 agents、不镜像 chats、backfill 到 default 不留 NULL。
4. app-scoped 端点,复用 handler。
5. 通用应用 = default 行,不留 NULL。
6. 能力合并 deny-by-intersection(上界)。
7. MCP 保持 stdio-wrapper,HTTP/SSE 后置。

### 8.2 应用用户身份边界

12. **应用用户由应用负责**：应用认证、角色、部门和业务数据权限属于应用层；平台不复制应用用户表，也不把应用业务角色解释为平台 entitlement。
13. **平台只接收执行主体**：默认继续支持平台 User JWT；应用用户通过应用后端用 `appKey + opaque subject` 换取短期 Runtime Token，携带 `appId + opaque principalId + apiKeyPrefix + 可选 Agent/会话绑定`，**不携带原始 subject**。
14. **Token-only 浏览器边界（M1）**：浏览器 REST/WS 调用只携带 Runtime Token，不携带 `appKey`。服务端按 Token 内 `appId` 重新读取当前 Application 记录，校验 Application active、`apiKeyPrefix` 等于当前 `applications.api_key_prefix`（AppKey 轮换即失效）、principal active 且归属本应用、org 一致、可选 Agent 绑定——全程不需要明文 AppKey。S2S 的 `appKey + User JWT`、`appKey + Runtime Token` 与 Widget Token、平台工作台、legacy `/api/chats`、`/ws` 路径保持兼容。`appKey` 不得进入浏览器代码或前端环境变量。
15. **当前实现缺口明确记录**：应用主体（`appKey + opaque subject` 换取的 Runtime Token 路径）的运行/存储键已切到 `app_principals.id`（opaque `principalId`），不再指向平台 `users` 表——`agents.owner_user_id` 落该 `principalId`，Session/工作区/审计按它隔离；原始 `subject` 仅作 `app_principals` 内部 audit-only `principalKey` 保留，不下沉 data plane。仅 Widget Token 与 legacy 平台 JWT 路径的 `userId` 仍指向平台 `users` 表。后续只补执行身份抽象和最小存储隔离，不引入统一外部 IAM 或复杂联邦协议。

### 8.3 本轮 v3 新增决策
16. **平台不建领域层**(§3):语义/口径/知识库/前端 = 应用。
17. **Hook 透传不重定义**(§4.2):平台透传 SDK hooks 接口给应用,只保留治理守卫铁律;不发明 hook DSL。
18. **事件流透传**(§4.3):不定义业务语义。
19. **固化看板 ≠ 灵活问数**(§3):两个应用/模块。
20. **Hook = Route A (hook-as-plugin)**(precedence 实验后定案): hook 作为 native plugin 包走 capability resource 管线;平台不翻译 hook 语义;deny-wins 守卫 + 容器沙箱为安全边界;`updatedInput` 为 trusted-code policy 非安全边界。旧 envelope 模型已删除。
21. **Hook 守卫**(Route A): inline deny-wins / rollout gate / 路径穿越防护 / 审计 / 容器沙箱（待实现）。
22. **Hook 扩展点 = 阶段 A2**(Route A 已落地: hook-as-plugin + 删除 envelope)。
23. **证据软化**(Codex v3):「SDK 9 事件/4 验证器/4 级粒度」来自外部参考文档、非仓库源码,表述已软化。

---

## 9. 安全 / 治理盲点(落地逐条满足)
- API key:hash-at-rest + prefix/id lookup + 轮转/撤销 + last-used + 不进 browser bundle。
- 每个 ownership 检查含 app scope 或从 `agents.app_id` 推导;**请求参数 appId 不是 authority**。
- diagnostics/审计记录双 principal `{ appId, actorUserId | serviceActorId }`。
- `application_capabilities` 变更 → configVersion drift + 审计。
- **治理守卫铁律不可被应用 hook 覆盖**(§4.4)。

---

## 10. 边界一句话

> 底座(docker 治理 + 能力池 + entitlement + 审计 + profile + diagnostics)runtime 不动,已是引擎。
> 缺的是「应用」这层壳 + 「扩展点透传」(能力挂载 / **hook** / 事件流):让引擎能被**按预设驱动、被前端用 app-scoped API 调用**,
> 应用与用户作为**双 principal**受治理,且**应用靠透传+回调定制行为、绝不改平台源码、绝不绕过治理守卫**。
