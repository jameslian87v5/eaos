# 外部对标：OpenOcta

> 状态：观点文档（非实现计划）。用于校准 Agent OS 的战略定位与主攻方向。
> 对象：OpenOcta（`github.com/openocta/openocta`，OSS 桌面端 + 商业 Server 版）。
> 信息源截止：2026-09。公开仓库 `openocta/openocta`、`openocta/openocta_skills`、官方 README、腾讯云开发者社区架构解析、OpenOcta 官网（产品/定价/部署文档）。
> **事实性边界（2026-09-03 codex 两轮复核后修正）**：
> - **OSS 桌面端**：源码可审（`openocta/openocta`），事实判断有据。
> - **Server 商业版**：官网有 v2.0 版本/定价/部署文档，**产品存在性可核验，但源码不可审**；实现细节、客户案例、认证声明一律标"待核验"，不作事实。
> - 初稿曾把 Server 存在本身标待核验，本轮已修正为"可核验产品但不可审源码"。

## 1. 它是什么

杭州乘云数字科技（Hangzhou Chengyun Digital Technology Co., Ltd.）推出的 IT Ops Agent（AIOps）。两层形态：

- **OSS 桌面端**（源码可审，`openocta/openocta`）：单 Go 二进制 + `go:embed` 内嵌前端，默认监听 `127.0.0.1:18900`（HTTP/WebSocket），兼容 OpenClaw Gateway WS 协议。Windows/macOS 桌面 + Linux `.deb`/`.rpm`（systemd `openocta.service`）。Go 1.24+ 构建。
- **Server 商业版**（官网可核验产品/定价/部署文档，源码不可审）：据官网存在 v2.0 版本、定价档与部署文档；集群/多租户/Ultra 等企业档的**实现细节、客户案例、认证**待核验，不作事实。

**能力（OSS 桌面端公开可审）**：告警风暴聚合 + 根因假设、自然语言巡检任务、智能数据问答（监控/日志/工单/容量/成本）、Skills/MCP/数字员工连 Zabbix/Prometheus/K8s/数据库/云平台。

**相关仓库**：`openocta/openocta`（主仓）、`openocta/openocta_skills`（第三方 Skill：MySQL/K8s/TiDB 巡检等）。

**版本/体量**：公开仓库 v1.0.6（2026-07-15），star 数无决策价值已删除。

**待核验、不作事实**：Server 商业版的集群/Ultra 多租户实现深度、K8s 命名空间级隔离、等保 2.0 认证、公开客户案例（国网/上港/华夏银行/上期所等）、信通院标准参编——以上有竞品宣称但无一手可审来源，标待核验。

## 2. 定位差异（一句话）

- **OpenOcta**：桌面级 AIOps 成品。卖"IT 运维场景闭环 + Skills 市场 + 桌面端开箱即用"。单 Go 自研 runtime，多模型喂进同一个 Agent Loop。
- **我们**：引擎 + 治理 + 扩展点透传，不建领域层。卖"应用可插入的 agent 底座 + agent 安全触达内网 API + 容器级隔离"。

## 3. 关键对比轴

| 维度 | OpenOcta（公开仓库可核验） | 我们 | 判断 |
|---|---|---|---|
| 多租户 | OSS 桌面端无企业多租户；Server 商业版多租户深度**待核验**（源码不可审） | Phase 7 控制平面 org 隔离已收口（三档角色 + entitlement 叠加 + 治理守卫不可放宽）；数据平面 per-row org_id 是登记 debt | 待核验档对齐后再比；不假设对方没有 |
| 隔离 | OSS 桌面端进程级运行 + 命令校验 + ApprovalQ（公开 README）；Server 版隔离深度待核验 | 每 chat 一个 Docker 容器 + 命名卷 + AutoRemove + PreToolUse hook + 4 层路径校验 | 我们更硬（容器 vs 进程），代价是部署更重 |
| 部署 | OSS 单 Go 二进制 + 内嵌前端，桌面双击 / systemd；Server 版据官网有部署文档 | Node + tsx + React + Docker + Nginx + systemd | 他们轻一个量级 |
| 扩展 | Skills 热插拔（`openocta_skills` 仓库）+ MCP + 数字员工预设角色 | native plugin + MCP + Hook envelope + 应用层 + control/data plane 分离铁律 | 他们"运维场景 + skill 市场"更落地；我们"应用层透传 + 守卫"更底座 |
| 信创 | 公开层面为国产公司（杭州乘云）+ 国产模型适配；全栈信创/等保认证**待核验** | 智谱/Zhipu（GLM）算半个；无国产 OS/云 | 待核验，不假设对方碾压也不假设对方没有 |
| 成熟度 | OSS 公开仓库 v1.0.6；公开客户案例**待核验** | 品牌与上线专项进行中，无公开案例 | 不假设对方有标杆案例 |

## 4. 最重要的一条：模型适配 ≠ 引擎适配

这是判断 OpenOcta 上限的关键区分。

```
模型适配（OpenOcta 公开仓库可见）:
  Anthropic / OpenAI / DeepSeek / Qwen / Ollama（多模型供应商，喂进同一 loop）
          ↓
    同一个 OpenOcta Go Agent Loop

引擎适配（OpenOcta 未公开证明，我们亦未交付）:
  Claude Agent SDK / Codex / Pi / DeepSeek Harness
          ↓
    各自的 Agent Loop / 工具协议 / 审批机制 / 会话机制
          ↓
    统一平台 Runtime 契约
```

OpenOcta 公开架构明确：Go 自研 runtime，自己负责 Agent Loop / ToolExecutor / MCP / Session / Memory / Middleware，参考 agentsdk-go 但不直接用 Claude Agent SDK。它把 Subagents / Tasks 列为"可继续扩展的 Runtime 能力"——公开层面**不是已完成多引擎抽象的通用 Agent Runtime**（商业版本是否更进一步待核验，不作假设）。

把 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY` 接进来，不等于能跑 DeepSeek Harness 或 Codex Harness——只是多了一个模型供应商。**这正是我们假设的差异化缝隙所在，但缝隙是否真实存在、是否够大，仍待我们落地 adapter + 真客户场景验证。**

## 5. 自研 Go runtime 的天花板（可验证风险假设，非已证实事实）

> **声明**：以下不是已证实的结论，而是基于"原生 harness 协同设计"一般原理推导的**可验证风险假设**。在跑同模型、同任务的对照实验前，不作为事实陈述。

OpenOcta 在"国产模型 + AIOps 结构化场景"几乎不丢分（这是它能起来的原因）：廉价模型没有"原生 harness"可失去，ReAct loop 对巡检/告警分析够用。

**风险假设（待验证）**：在有原生 harness 的顶级模型上，自研 loop 可能拿不到协同设计边缘：

- 模型与特定 scaffolding（tool-use 格式 / streaming / 错误恢复 / 并行 tool call）协同训练；原生 harness 是权威实现，自研 loop 调 raw API 只拿模型能力不拿边缘。
- prompt cache 放置差 → 单轮更贵更慢（真金白银）。
- 新能力（interleaved thinking / 新 tool 类型 / 扩展上下文）滞后，永远追。
- Codex / Pi 等专属 harness 的 loop：当前公开 Runtime 未证明可原生承载这些 harness；未来理论上可通过进程/协议 Adapter 接入，但跨 harness 治理一致性需验证——**不排除、但未证明**。

**这不是"性能差距"（Go 算力不输甚至赢 Node），是"agentic quality + 模型协同设计"差距的假设。** 打不破还是打得破，是**待验证问题**，不是定论。

**验证方法（落地 adapter 后的第一项技术验证）**：选同一模型、同一任务集，OpenOcta 自研 Go loop vs 原生 harness 对照，对比：①工具调用成功率；②错误恢复率；③单轮 token 成本（prompt cache 命中率）；④新协议/新 tool 类型的适配周期。四项里若有 OpenOcta 系统性落后且不可追平的，假设成立；否则假设被证伪，需重新评估护城河。

> **可复现实验要求（2026-09-03 codex 补充）**：上述对照须固定——①任务集（明确条目与难度分布）；②模型与版本（精确到 model id + 日期）；③工具集合（同一组工具，避免工具差异污染）；④重试预算（每任务最大重试/最大步数上限）；⑤成功判定（客观可判的成功/失败准则，非主观打分）。五项固定后对照才有可复现性。

## 6. 我们的战略位置（架构愿景，非已交付能力）

如果 Agent OS 做成真正的多引擎企业控制面，上限可能高于 OpenOcta：

```
Agent OS Control Plane
  身份 / Application / Capability / Approval / Audit / Run
                         ↓
  统一 Runtime Contract（start / stream / approval / cancel / resume / health / usage）
                         ↓
  Engine Adapter
    Claude Adapter / Codex Adapter / Pi Adapter / DeepSeek Harness Adapter / OpenOcta Adapter
                         ↓
  具体 Agent Harness
```

企业可按任务挑引擎：Claude 复杂工具、Codex 代码、Pi 轻量本地、DeepSeek 廉价/国产——统一身份/能力/审批/成本/审计/workspace。

**但必须诚实**：这现在是架构愿景，不是产品能力。当前代码仍 Claude-Agent-SDK-bound（`AgentRuntimeOptions` 漏 Claude 类型、`RuntimeEvent` 是 stringly-typed Claude 事件、`LocalAgentRuntime` 直接 `new AgentSession`、A2UI 的 show_ui 挂在核心接口）。**交付一个真实第二引擎 adapter 之前，对外别说"多引擎优势"**——会被用"你只有一个 SDK"反打。

## 7. 我们不回避的差距

- 部署重（Node+Docker+Nginx vs 单 Go 二进制）。
- 无客户证言、无公开案例。
- 多租户数据隔离深度不够（per-row org_id 是 debt；对方若真有 K8s 命名空间级隔离则更深，待核验）。
- 国产化/信创全栈：我们弱；OpenOcta 公开层面为国产公司 + 国产模型适配，全栈深度待核验，不假设对方碾压也不假设对方没有。

## 8. 对位策略

**不逐行补到 Pro**——那样变成 OpenOcta 的劣质复刻，且永远在它后面。SSO/IM/定时任务/License/报表是跟进项，按客户需求补，不当主线。

主攻两条，别散：

1. **多引擎控制面（条件性竞争假设）**——OpenOcta 公开层面假设单一 Go harness；**若**客户真有"按任务挑引擎"需求且 OpenOcta 不能低成本满足，我们做跨引擎控制面是差异化。这不是已证实的"降维"，而是待场景验证的竞争假设。**判据不是架构图，而是：第二引擎真实闭环（adapter 落地 + 同套治理跨引擎工作）+ 真客户场景需要挑引擎**——两者同时成立才成立。
2. **容器级隔离 + agent 安全触达内网 API**——进程沙箱 vs 容器（可叠 microVM），对"agent 跑不可信代码 / 触达内网"是硬差异。

> **启动节奏（2026-09-03 codex 复核加）**：多引擎主攻 1 与 CubeSandbox 主攻 2 弹药**都是战略储备，都按触发条件后置**，当前主线仍是品牌与上线专项（P-Deploy 收尾、登录安全、错误处理、部署闭环）。多引擎**只在**明确第二引擎场景 + 负责人 + 验收任务后才启动；MicroVM **只在**主攻 2 的内网出口治理有真实需求且 CubeSandbox 开源独立性验证通过后才接入。两者都不抢占 P-Deploy 主线，**不因竞品比较就立即重构**。契约冻结、Claude adapter 封装等铺路工作可低强度做。

## 9. 赢的判据（不回避的反方）

多引擎上限只在"客户真需要按任务挑引擎"时兑现。若主流企业 agent 市场最终落在"结构化运维 + 廉价模型"——OpenOcta 的轻量 + 国产生态会赢，我们的多引擎没人买单。

**落地 adapter 后，第一个该验证的不是技术，是有没有客户场景真需要"这个任务用 Claude、那个任务用 DeepSeek"。** 有，这盘棋活；没有，我们是在为 OpenOcta 已满足的市场造更贵的东西。

## 10. 本文档的事实性边界

- §1/§3 中 OpenOcta 的 OSS 桌面端形态、仓库、架构、Skills 市场来自公开仓库可审源码。
- Server 商业版**产品存在性可核验**（官网 v2.0/定价/部署文档），但**源码不可审**；其集群/多租户/Ultra 实现深度、客户案例、认证一律待核验，不作事实。
- §5 自研 Go runtime 天花板是**可验证风险假设**，需落地 adapter 后跑同模型同任务对照实验（五项固定：任务集/模型版本/工具集合/重试预算/成功判定）证伪或证实。
- 多引擎控制面战略是**条件性竞争假设 + 架构愿景**，在真实第二引擎 adapter 落地 + 真客户场景验证前，不对外宣称为已交付能力或已证实优势。

## 11. 相关文档

- `external-alignment-cubesandbox-adaptation.md` — data-plane 弹药（microVM + 出口网关），强化主攻 2。
- `platform-application-layer-plan.md` — 应用层透传（主攻 1 的底座）。
- `docs/开发计划/品牌与上线专项整体计划.md` — 当前主线（P-Deploy / 品牌 / 上线）。
- `runtime-strategy-reference.md` — runtime 策略基线（若存在）。
