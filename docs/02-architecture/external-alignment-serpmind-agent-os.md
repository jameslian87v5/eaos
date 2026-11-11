# External Alignment — SerpMind™ Enterprise Agent OS

> Purpose: competitive / architectural alignment against a peer enterprise
> Agent OS product (星流计算 NovuInfra · SerpMind™ Enterprise Agent OS).
> Unlike `external-alignment-reference.md` (a mechanism-level design guardrail,
> explicitly "not a market research report"), this document is a deliberate
> competitive positioning + gap analysis across **background, motivation,
> goals, implementation, and results**. It validates our boundaries against a
> peer and surfaces the strategic choice (whether to enter the full-stack
> Infra race or stay the application-layer Agent OS course).
>
> Source: `https://novuinfra.cn/serpmind-agent-os.html` (accessed 2026-08-17).

## 0. Product Snapshot (from the vendor page)

SerpMind™ Enterprise Agent OS — 星流计算 (NovuInfra) 的新一代企业级 Agent OS。

- **Architecture**: 控制面 / 数据面分离的企业级**多进程 Agent 架构**；以
  **Agent Runtime** 为核心运行层；治理与安全通过**控制层 + 侧车 (sidecar)
  机制**协同部署；Runtime 保持轻量，支持企业级运行管理与生产级治理。
- **State management**: 围绕 Agent 运行过程中的上下文与状态管理，提供基于
  Agent 语义的 **KV Cache 智能调度**——通过 **Agent-ID / Session-ID** 感知
  Agent 状态，与**三级智能内存架构**协同，实现 KV Cache 在不同内存层级之间
  的动态调度与恢复。
- **Three-layer architecture**: **Runtime + Governance + Security**.
- **Core advantages**: 可治理（权限/策略/审计/安全运行）、可扩展（Runtime/
  治理/安全分层）、可落地（私域部署、政企安全可控）.
- **Four-layer capability stack**: AI 算力基础设施 + 本地大模型 + SerpMind
  Agent OS + 行业 Agent 应用（医疗/政务/制造/能源/教育/企业服务）.
- **Sibling product**: 玄矩™ A1 | Agent Native Server (自研算力).

## 1. Per-Capability Alignment

| SerpMind 能力 | 我们的现状 | 对齐度 |
|---|---|---|
| 控制面/数据面分离的多进程 Agent 架构 | control plane（声明意图：agent 定义/profile/capability/entitlement/activation/runtime policy）+ data plane（Docker runtime/SDK `query()`/MCP 子进程/tool calls）+ 桥 `server/capability-provider.ts` `CapabilityProvider.resolve()`；多进程 = 每 chat 一 Docker 容器（`server/container-manager.ts` + `server/docker-runtime.ts`） | ✅ 强相同 |
| Agent Runtime 为核心运行层 | `server/agent-runtime.ts` `AgentRuntime` 接口 + `LocalAgentRuntime`/`DockerAgentRuntime`；`ContainerManager` 生命周期优先级 warm reconnect → cold resume → `from_messages` → fresh start | ✅ 相同（差异：我们 Runtime 消费 SDK `query()`，不自研推理引擎） |
| 治理与安全经**控制层 + 侧车(sidecar)**协同 | 治理守卫齐备（entitlement 叠加 / org 隔离 / deny-default / `/opt/agent/mcp/` 前缀 / 路径校验 / 审计），但用**容器内 `PreToolUse` hook（`docker/agent-entry.ts`）+ host `server/approval.ts` `ApprovalManager`**，**不是独立 sidecar 进程** | ⚠️ 治理相同、部署形态不同 |
| Runtime 保持轻量 | 容器内只跑 `docker/agent-entry.ts`（WS server + SDK `query()` + 审批 hook + 路径前缀校验）；治理在 host 控制面 | ✅ 相同理念 |
| **KV Cache 智能调度**（Agent-ID/Session-ID 感知 + 三级智能内存 + 跨内存层级动态调度与恢复） | **完全无**。我们有 cold resume（`claudeSessionId` + `agent-claude-home-<chatId>` 卷，恢复 Claude Code 会话状态），但那是**会话状态恢复**，**不是 KV cache 跨内存层级调度** | ❌ 整层缺失 |
| Runtime + Governance + Security 三层架构 | 概念对齐：Runtime（`agent-runtime`/`docker-runtime`/`ai-client`）+ Governance（`server/entitlement.ts` / `server/governance-audit-service.ts` / `capability-provider` 守卫）+ Security（路径校验 / MCP 前缀 / approval / Docker 隔离） | ✅ 相同 |
| 可治理（权限/策略/审计/安全运行） | JWT + 三档角色（admin / org_admin / user）+ entitlement 叠加 + org 隔离 + 审计（`agent_events` / `governance-audit-service` / capability 变更审计 / `agent-profile-audit`）+ deny-default + approval | ✅ 强相同（甚至更细：org 级 entitlement 叠加 + deny-by-intersection） |
| 可扩展（分层） | control/data plane + 桥 + 扩展点（能力挂载 / Hook envelope / 事件流）+ Application Layer（app allowlist） | ✅ 相同 |
| 可落地（私域部署 / 政企安全可控） | 自托管 / Docker / SQLite→PostgreSQL / 全自研可控 | ✅ 强相同 |
| 四层能力体系（算力 + 本地大模型 + OS + 行业应用） | 只有后两层（OS + 行业应用 via Application Layer）；算力 + 本地大模型依赖外部（智谱 GLM，`ANTHROPIC_BASE_URL`） | ⚠️ 差异（非全栈） |
| 行业 Agent 应用（医疗/政务/航天…） | Application Layer 设计已定（A0 进行中：`applications` / `application_capabilities` 表 + `agents.app_id`），但无行业方案；R5e SSO 刚 DEFER（Demo only） | ⚠️ 哲学相同、成熟度落后 |

## 2. Same Points (核心相同)

1. **控制面/数据面分离** —— 完全一致的设计哲学；`CapabilityProvider.resolve()`
   即"控制→数据"的南向桥，对应 SerpMind 的控制层/数据层分离。
2. **多进程 Agent 隔离** —— 都用容器化（我们每 chat 一 Docker 容器 + 双命名卷
   `agent-workspace-<chatId>` / `agent-claude-home-<chatId>`）。
3. **Runtime + 治理 + 安全 三层** —— 概念对齐。
4. **企业治理铁律**（权限/策略/审计/私域可控）—— 一致，我们甚至更细：
   org 级 entitlement 叠加 + deny-by-intersection（`app allowlist ∩ entitlement ∩
   agent activation`）。
5. **平台不建领域层** —— 一致（我们 = 引擎 + 治理 + 扩展点透传；SerpMind 的
   行业 Agent 应用是独立一层，由应用自带 know-how）。

## 3. Difference Points (关键差异)

1. **KV Cache 智能调度 + 三级智能内存** —— SerpMind 作为"算力 + 本地大模型
   全栈"的核心差异化护城河，属**推理引擎层**（vLLM/SGLang 级）。我们消费外部
   GLM，**完全不碰这层**。这是最大差异，决定赛道归属。
2. **侧车 (sidecar) 机制** —— 他们独立 sidecar 进程；我们用容器内 `PreToolUse`
   hook + host `ApprovalManager`，治理效果近似、部署形态不同（in-container vs
   sidecar process）。
3. **全栈 vs 单层** —— SerpMind 四层（算力 + 本地大模型 + OS + 行业应用）；
   我们只有后两层。算力与大模型依赖外部（智谱 GLM）。
4. **自研推理引擎** —— 他们有玄矩™ A1 (Agent Native Server)；我们无。
5. **落地成熟度** —— SerpMind 已产品化，有客户案例 + 行业方案（医疗 / 政务 /
   智慧病房 / 商业航天）；我们底座成型（MP5f），Application Layer A0 进行中，
   品牌与上线专项 P0/P1 收尾，无行业方案，R5e SSO 刚 DEFER（Demo only）。
6. **Application Layer 设计**（我们多出）—— 我们有 `app_id` / app allowlist /
   双身份鉴权（app key + user JWT）/ deny-by-intersection（A0 进行中），这是
   SerpMind 页面未细化的"行业应用"层，算我们多出来的一块设计。

## 4. Five-Angle Analysis

### 4.1 背景 (Background)
- **SerpMind**: 星流是"全栈 AI Infra 提供商"，**自有算力（玄矩 A1）+ 本地大模型**，
  需要一个把 Agent 纳入企业治理的 OS 层串起全栈。
- **我们**: 从一个简单聊天 demo 迁移而来，**没有 Infra / 算力层**，定位是从 chat
  结构演进成企业 Agent 平台（`chatId == agentId` 兼容桥）。
- 差异：他们自下而上（算力 → OS），我们自上而下（应用 → OS），起点相反。

### 4.2 动机 (Motivation)
- **SerpMind**: 企业 Agent **持续运行**需求 → 需 Runtime + 治理 + 安全；政企私域可控。
- **我们**: `CLAUDE.md` 明文——差异化 = **企业治理 + agent 安全触达内网 API +
  全自托管可控**。
- 几乎一致：都是"Agent 要进企业生产，必须可治理、可私域"。

### 4.3 目标 (Goals)
- **SerpMind**: 企业级 Agent OS，覆盖运行 / 治理 / 安全，轻量 Runtime + 生产级治理。
- **我们**: 平台 = **引擎 + 治理 + 扩展点透传，绝不建应用领域层**（语义 / 口径 /
  知识库 / 业务前端 = 应用自带）。
- 相同：都把"治理 + 运行"当核心；差异：他们顺带做算力 / 大模型，我们明确不做领域层。

### 4.4 实现 (Implementation)
- **相同**: 控制面 / 数据面分离 ✅；多进程容器隔离 ✅；Runtime + 治理 + 安全三层 ✅；
  企业治理铁律 ✅；平台不建领域层 ✅。
- **差异**:
  1. **KV Cache 智能调度 + 三级智能内存** —— 他们核心差异化，我们完全没有
     （属推理引擎层，消费外部 GLM）。
  2. **侧车机制** —— 他们独立 sidecar 进程；我们容器内 hook + host ApprovalManager。
  3. **全栈 vs 单层** —— 他们四层；我们只有后两层。
  4. **自研推理引擎** —— 他们有玄矩 A1；我们无。
  5. **Application Layer** —— 我们有 app allowlist / 双身份鉴权 / deny-by-intersection
     （A0 进行中），他们页面未细化这层。

### 4.5 结果 (Results)
- **SerpMind**: 已**产品化落地**，有客户案例 + 行业方案（医疗 / 政务 / 智慧病房 / 商业航天）。
- **我们**: 底座成型（MP5f：agents 表 / profile / capability / entitlement / Docker
  治理 / diagnostics / 审计），Application Layer A0 进行中，**品牌与上线专项
  P0/P1 进行中**，**无行业方案**，R5e SSO 刚 DEFER（Demo only）。
- 差异：成熟度落后一个段位——他们到"行业方案 + 客户案例"，我们到"底座成型 +
  品牌上线收尾"。

## 5. Strategic Conclusion

**架构哲学高度一致**（控制面/数据面分离、多进程隔离、Runtime + 治理 + 安全、
平台不建领域层、私域可控），**治理甚至更细**（org 级 entitlement 叠加 +
deny-by-intersection）。但两个核心差异决定了我们与 SerpMind 不是同类竞品：

1. **缺 KV Cache 智能调度 + 三级智能内存** —— 这是 SerpMind 作为"算力 + 本地
   大模型全栈"的护城河，属推理引擎层；我们消费外部 GLM 不碰这层。
2. **不是全栈 Infra** —— 我们只有"OS + 行业应用"两层，算力与大模型依赖外部。

### Strategic choice (not a technical patch)

若要对标追赶，最该决策的是：**是否自建 / 接入本地大模型推理引擎层（vLLM /
SGLang 级 KV cache 调度）**。

- **不做** → 永远只是"Agent OS 应用层"，与 SerpMind 错位共存（他们全栈、我们
  治理 + 应用层），可作为其上层的 OS 被集成或并存。
- **做** → 进入 SerpMind 的全栈赛道，投入量级完全不同（自研 / 运维推理引擎 +
  本地大模型 + 算力），是战略转向，不是补丁。

当前主线（品牌与上线专项 P0/P1 + Application Layer A0–A4）维持"Agent OS 应用层
+ 企业治理"定位；是否进入推理引擎层应作为独立战略决策单独立项评估，不在当前
开发主线内。

## 6. Cross-References

- `external-alignment-reference.md` —— 机制级设计 guardrail（Claude Code /
  MCP / OpenAI / Kubernetes），非竞品对标。
- `docs/02-architecture/platform-application-layer-architecture.md` —— 我们的"平台不建
  领域层"权威计划。
- `docs/02-architecture/single-enterprise-org-governance-design.md` —— org 级
  治理（对应 SerpMind "可治理"）。
- `docs/开发计划/品牌与上线专项整体计划.md` —— 当前主线（对应"落地成熟度
  落后"的现状）。
