# Runtime Protocol v0 — 映射与冻结记录（M0.5）

> 冻结实现：`server/platform-runtime-protocol.ts`（协议）+ `server/resolved-execution-policy.ts`（策略 DTO）+ `server/claude-event-normalizer.ts`（Claude normalizer，**未接入生产链路**）。
> 合同测试：`server/runtime-protocol.test.ts`（29/29）。
> 上游输入：`docs/02-architecture/runtime-harness-coupling-inventory.md`（41 耦合点 + P-* 用例）、`docs/02-architecture/runtime-harness-capability-matrix.md`（Codex/Pi 反向校验）。
> 变更纪律：v0 字段任何改动必须显式升版（`RUNTIME_PROTOCOL_VERSION`）+ 兼容评审，禁止静默修改。

## 1. 协议面（v0）

**Command（Host → Runtime）**：`start { resumeToken?, policy }` · `send_message { runId, content }` · `approval_result { requestId, approved, message? }` · `a2ui_result { requestId, result }` · `compact` · `abort { runId }` · `close`

**Event（Runtime → Host）**：`runtime_ready { engineSessionId?, capabilities }` · `session_updated { engineSessionId }` · `assistant_text { text, final }` · `tool_requested { toolCallId, toolName, input? }` · `tool_result { toolCallId, success, output? }` · `approval_request { requestId, toolName, toolCallId?, input? }` · `a2ui_request { requestId, block, timeoutSec? }` · `workspace_changed { paths? }` · `turn_completed { usage?, costUsd?, durationMs? }` · `turn_failed { category, message }` · `runtime_error { category, message }` · `context_compacted { preTokens?, postTokens?, trigger? }`

**Framing**：`{ v, seq, kind, body }`；`seq` 每方向严格递增（从 1 起）；重复 seq = 幂等丢弃；跳号 = protocol error fail-closed；`MAX_FRAME_BYTES=256KiB`；文本/工具载荷上界 20k/5k chars（与 session.ts 现行截断一致）。

**错误分类**：`protocol | engine | timeout | io | oom | aborted | policy | internal`。

**关联 ID 语义**：`approval_request.requestId ⇄ approval_result.requestId`；`a2ui_request.requestId ⇄ a2ui_result.requestId`；`send_message.runId` 分组一轮——**事件不携带 runId**，run 关联由 Host 持有（Host 知道 currentRunId，与现行 agentRunService 一致）。

## 2. v0 冻结决策（M0 四个 open items 的裁決）

| Open item | 决策 | 依据 |
|---|---|---|
| ① slash command 面 | **(a) 中立化**：`compact` command + `context_compacted` event + `EngineCapabilities.contextCompaction` | auto-compact 是**平台策略**（session.ts L1122 评估阈值），不中立化则平台策略被引擎词汇绑架；无此能力的引擎报 false，平台跳过策略 |
| ② platform-web-tools | **不进协议**：bailian_search/web_fetch 保持引擎侧实现细节，`capabilities.mcp` 只报引擎 MCP 能力 | 协议只描述能力面，不描述具体工具目录 |
| ③ sdk-init 诊断面 | **不进协议**：model/cwd/tools/skills/plugins/mcp 快照 + slash_commands 留在 adapter 侧日志 | 白名单化收益低且易泄漏引擎私有结构；`ENGINE_PRIVATE_KEYS` 把 `slash_commands` 列为禁词由测试强制 |
| ④ getClaudeSessionId 消费点 | **engineSessionId 双通道**：`runtime_ready.engineSessionId?`（已知时）+ `session_updated`（迟到捕获，对应 docker IPC `session_id` 帧语义） | 单靠 runtime_ready 无法覆盖 docker 现行的「任意帧嗅探首次捕获」 |

## 3. Claude 原始事件 → 平台事件映射（normalizer 实现 + 测试锚点）

| Claude 原始（inventory ID） | 平台事件 | Parity 测试 |
|---|---|---|
| `system/init`（SN-01） | `runtime_ready`（capabilities=CLAUDE_ENGINE_CAPABILITIES；诊断不映射） | P-INIT-01 |
| `session_id` 帧内捕获（AR-06/DR-05） | `runtime_ready.engineSessionId`（ready 前）/ `session_updated`（ready 后，恰一次） | P-SESS-01 |
| `assistant.content[].type=text`（SN-04） | `assistant_text { final:false }` | P-TXT-01 |
| `result.result` 文本（SN-09） | `assistant_text { final:true }`，**与已流式文本按 trim 相等去重** | P-TXT-02 |
| `assistant.content[].type=tool_use`（SN-04） | `tool_requested`（input 经 `redactSecrets` 有界脱敏视图） | P-TOOL-01 |
| `user.content[].type=tool_result`（SN-05） | `tool_result`（`is_error`→`success` 取反；content 数组拼接；5k 截断） | P-TOOL-02 |
| `tool_use/tool_result` of `show_ui`（SN-06） | **不产生事件**（卡片即 UI；id 集合消费有界） | P-A2UI-02 |
| docker IPC `approval_request {id,toolName,toolInput,toolUseId}`（SN-07） | `approval_request`（字段中立化 + input 脱敏） | P-APR-01 |
| docker IPC `a2ui_request {requestId,block,timeoutSec}`（SN-08） | `a2ui_request` 原样（envelope 校验：requestId 非空≤100；timeoutSec 缺省或有限数≥1，**非法丢整事件** = Host respondInvalid 语义） | P-A2UI-01 |
| `result` subtype=success（SN-09/10） | `turn_completed { usage?, costUsd?, durationMs? }`；usage snake_case→camelCase（quota-service json_extract 兼容：`$.usage.inputTokens`） | P-RES-02 |
| `result` subtype≠success / is_error（SN-09） | `turn_failed { category:'engine', message }`（无 turn_completed） | P-RES-01 |
| `system/compact_boundary`（SN-02） | `context_compacted { preTokens?, postTokens?, trigger? }` | P-CMP-01 |
| IPC `error` / 连接丢失 | `runtime_error { category:'engine' \| 'io', message }` | （adapter 装配层） |
| `files_updated`（SN-11，Host scanOutputFiles） | `workspace_changed` —— **normalizer 不产生**；Host 在 turn_completed 后扫描发出（Guest-only 写层时 Guest 上报有界相对路径、Host 复验） | （Host 侧，M3） |
| slash 命令 turn（SN-11 命令渲染） | 协议不区分：命令仍走 `send_message` 透传；命令回显 = Host 依自身 turn 状态消费 `assistant_text final` | P-CMD-*（M3 Session 迁移时补） |
| 未知 system subtype（SN-03） | 不映射（Host 侧降级路径，M3 迁移保留） | — |

**中立性强制**：`scanForEnginePrivateFields` + `ENGINE_PRIVATE_KEYS`（`claudeSessionId`/`session_id`/`tool_use_id`/`tool_use`/`content_block`/`hookSpecificOutput`/`permissionDecision`/`slash_commands`/`total_cost_usd`/`duration_ms`/`ANTHROPIC_API_KEY`）——每个事件类型都有「序列化后零命中」断言（P-NEUTRAL）。

## 4. ResolvedExecutionPolicy（权限不重建）

- 唯一来源：`CapabilityProvider.resolve()` + runtime-settings + 静态安全默认；**phase-1 零新增 admin 面**；deep-freeze 只读 DTO。
- `approvalRequiredToolIds()` 恒等派生 `exposed − allowed − denied`，**不存储**（P-POL-01）；构造器强制 allowed/denied ⊆ exposed、互斥、MCP stdio 绝对路径无穿越、egress 枚举、资源正数——任何违规 throw（fail closed = 拒绝启动，plan §5.3）。
- 空 exposedToolIds 合法 = L0/L1 纯文本引擎。
- 凭证不进 DTO（env 注入通道，plan §2 分阶段策略）。

## 5. Codex/Pi 能力矩阵反向校验

- `EngineCapabilities` 能完整表达矩阵结论：**M4-S1 真实探测更新**——Codex = `CODEX_ENGINE_CAPABILITIES`（`streamingText:false, structuredToolEvents:false, preToolApproval:false, sessionResume:true, tokenUsage:true, costUsage:false, mcp:false, a2ui:false, abort:false, contextCompaction:false`）→ `maxPromisableLevel()===0`（`server/m4-codex-adapter.test.ts` CX.2 断言）。旧版「Codex L1 / `streamingText:true` → `maxPromisableLevel()===1`」是 M0 Host 只读探测的暂判，已被推翻：`codex exec` 不流式（JSONL 仅 final `agent_message`）且不可 abort（exec 跑到完成），两者皆 L1 前置 → L0。Pi/DeepSeek 全 unavailable → 无能力声明，等级不可承诺。
- 协议无任何引擎专属字段（Codex 的 `--json`/sandbox、Pi 的 CLI 均为 adapter 内部细节）。
- 审批缺口走能力握手：`preToolApproval:false` 的引擎由平台按 plan §5.2 降到 L0（不是 L1——`abort`+`streamingText` 都是 L1 前置），或走「平台托管可审批工具路径」；协议不需要特殊通道。M4-S1 进一步：codex `command_execution` post-hoc 不可治理 → adapter **drop**（不得合成 `tool_result`），`structuredToolEvents` 因此为 false（engine 产生 ≠ adapter 可呈现）。
- `maxPromisableLevel` 分级实现：abort + streamingText 均为 L1 前置（平台不可用无 abort 或无流式的引擎 → L0）；L2=structuredToolEvents+preToolApproval；L3=+sessionResume+tokenUsage+mcp；L4=+a2ui。
- **Pi（M4-S3 探测，2026-09-18）**：Pi 无可执行物（`which` 全失败、npm 无包、`~/.pi` 仅空目录）→ **unavailable**，无任何私有能力可映射或拒绝映射；不实现 adapter，无 `EngineCapabilities` 声明。协议层零改动。前置：获得 Pi 可执行物 + 版本钉死后，再按 Codex 流程（probe → proven-only caps → fail-closed adapter）走一遍。证据：`docs/06-deployment/evidence/microvm-m4/m4-s3-pi-capability-probe-2026-09-18.md`。
- **DeepSeek（M4-S4 探测，2026-09-18）**：DeepSeek 无 agentic harness 可执行物——`deepseek-cli` 1.0.2 是第三方薄 chat CLI（openai SDK 包装，无结构化事件/session/resume/abort/MCP），`deepseek-harness` 0.0.1 是 npm 占位名（自述未完成开发），`~/.deepseek`/`~/.config/deepseek` 不存在，env 无 deepseek key。**模型 API 可调用 ≠ harness 已可接入**（artifact 铁律）→ **unavailable**，无任何私有能力可映射或拒绝映射；不实现 adapter，无 `EngineCapabilities` 声明。协议层零改动。前置：先确认是否存在 DeepSeek agentic harness（非薄 API wrapper），版本钉死，再从 L0 起测。证据：`docs/06-deployment/evidence/microvm-m4/m4-s4-deepseek-capability-probe-2026-09-18.md`。

## 6. M1 前仍未验证的传输/framing 假设（M1 必须实证）

1. **传输通道**：microsandbox 0.6.18 实际暴露的 Host↔Guest 通道形态未知（macOS 探针未测）——v0 framing 是**逻辑帧**，物理映射（virtio-console/stdio/socket）由 M1 探测后决定；若通道无流式保证，需在 adapter 层补长度前缀分帧。
2. **seq/幂等在真实通道上的重放行为**：断线重连后对端是否重发、缓冲边界在哪——M1 断线/半开/重复帧测试覆盖。
3. **`a2ui_result.result` 的界**：当前 `unknown` + 帧上限 256KiB；A2UI block schema 的实测大小分布（M1 端到端时校准）。
4. **`workspace_changed.paths` 的 Host 复验成本**：Guest-only 写层场景未实现，Host 扫描语义按 M3 适配。
5. **Codex JSONL 事件 schema**：矩阵 `guest-unverified` 项——M4 接入时逐字段核对，不升格。

## 7. 与生产链路的关系（本阶段边界）

- `claude-event-normalizer.ts` **未被 session.ts / agent-runtime.ts 引用**——Session 迁移是 M3 的逐事件类型 cutover（双路 parity harness，inventory §7 P-* 全集）。
- `RuntimeEvent`（开放 envelope）保留不动；`PlatformRuntimeEvent` 是平行冻结面，M3 才开始收紧（plan §8 agent-runtime.ts「逐步收紧」）。
- Local/Docker 行为零改动（本次 diff 无生产文件修改）。
