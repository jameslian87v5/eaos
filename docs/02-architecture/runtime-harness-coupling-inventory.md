# Runtime–Harness 耦合清单（M0）

> 状态：M0 交付物，`docs/开发计划/local-microvm-runtime-整体研发计划.md` §7 M0「Claude 耦合盘点」。
> 盘点基线：commit `dcdf45b`（branch `feat/hybrid-skill-scheme`）。
> 用途：为 M0.5「平台 Runtime Protocol 冻结」提供 source → candidate 映射与 parity 测试用例清单。本文只盘点与映射，不定义协议代码。

## 0. 结论概览

| 文件 | 耦合点 | 性质 |
|---|---|---|
| `server/agent-runtime.ts` | 7 | 接口层：RuntimeEvent 开放 envelope + Claude 会话语义 |
| `server/session.ts` | 13 | **最重**：handleSDKMessage 直解 Claude 消息体系 |
| `server/ai-client.ts` | 8 | local data plane：query() options + PreToolUse hook envelope |
| `server/docker-runtime.ts` | 6 | IPC 边界透传 Claude envelope + 凭证/会话 env |
| `docker/agent-entry.ts` | 7 | 容器侧镜像 of ai-client（双份维护） |

**已经中立的部分**（M0.5 可直接复用，不需要迁移）：`AgentRuntime` 接口本体的 `sendMessage/getEventStream/abort/close/getStatus`；`handleApprovalResponse({id,approved,message})` 与 `forwardA2UiResult(requestId,result)`（`agent-runtime.ts:56-59`）；docker IPC 帧类型 `approval_request/a2ui_request/a2ui_response`（`server/ipc-protocol.ts`）；`files_updated` 的产生侧（Host `scanOutputFiles()`，`session.ts:1104-1113`）；runId/审计的记录侧（`session.ts:701-716`，事件 payload 已 camelCase 规范化）。

**双份实现 warning**：`ai-client.ts`（local）与 `docker/agent-entry.ts`（docker）各自维护一份 query() 配置 + PreToolUse hook + MessageQueue + A2UI 挂载。M0.5 的 Claude normalizer/compiler 必须收敛为一份（否则 parity 测试要维护三份漂移）。

## 1. `server/agent-runtime.ts`

| ID | 位置 | Claude 私有语义 | M0.5 candidate | Parity |
|---|---|---|---|---|
| AR-01 | L12-15 | `RuntimeEvent { type: string; [k: string]: unknown }` — 开放 envelope，实际载荷是 Claude SDK 消息原样 | 替换为 `PlatformRuntimeEvent` 判别联合；`RuntimeEvent` 保留为过渡别名 | 全部 P-* |
| AR-02 | L25 `onSessionId` | 回调捕获 Claude `session_id` | `runtime_ready { engineSessionId }` 事件（Host 订阅而非回调注入） | P-SESS-01 |
| AR-03 | L27 `resume?: string` | Claude session resume token | `PlatformRuntimeCommand.start { resumeToken? }`（中立命名，compiler 翻译为引擎 resume） | P-SESS-02 |
| AR-04 | L29 `capabilityBundle.sdkOptions` | CapabilityBundle 内嵌 Claude SDK options（tools/allowedTools/plugins/mcpServers/skills/model） | `ResolvedExecutionPolicy`（计划 §5.3：单向派生、compiler 翻译） | P-POL-01 |
| AR-05 | L90-116 `buildLocalSessionOptions` | local runtime 组装 Claude query options（含 model "opus" 链） | `claude-harness-adapter` 的 policy compiler（Guest/adapter 侧，Host 不再组装引擎 options） | P-POL-02 |
| AR-06 | L138-147 `getEventStream` | 直接 yield SDK 原始消息 + 从任意 message 嗅探 `session_id` | adapter 内 normalizer 先转换，流上只有平台事件 | P-SESS-01 |
| AR-07 | L134 `getClaudeSessionId()` | 公开 Claude 会话 ID getter（ContainerManager 消费） | 改走 engineSessionId 统一通道（见 §6 open items） | P-SESS-01 |

## 2. `server/session.ts`（handleSDKMessage，L792-1158）

| ID | 位置 | Claude 私有语义 | M0.5 candidate | Parity |
|---|---|---|---|---|
| SN-01 | L793-832 | `system` + `subtype=init`：`slash_commands`/`mcp_servers`/`model`/`cwd`/`tools`/`skills`/`plugins` 快照（sdkInitSnapshot） | `runtime_ready { engineSessionId?, capabilities, diagnostics }`；诊断快照进 diagnostics payload（字段名中立化） | P-INIT-01 |
| SN-02 | L833-851 | `system` + `subtype=compact_boundary`：`compact_metadata.{pre_tokens,post_tokens,trigger}` | `context_compacted { preTokens?, postTokens?, trigger? }` | P-CMP-01 |
| SN-03 | L852-869 | 未知 `system` subtype 降级为 command_result（`/context` `/usage` 输出） | 归入 `assistant_text { final: true, source: 'command' }` 或专用 `command_result` 事件（M0.5 定夺，见 open items） | P-CMD-02 |
| SN-04 | L872-903 | `assistant` 消息 `message.content`：string \| `Array<{type:'text'\|'tool_use'}>`；tool_use `{name,id,input}` | `assistant_text { text, final }` + `tool_requested { toolCallId, toolName, input? }` | P-TXT-01, P-TOOL-01 |
| SN-05 | L904-935 | `user` 消息 `tool_result` blocks：`{tool_use_id, content[], is_error}`；content 数组拼 text | `tool_result { toolCallId, success, output? }` | P-TOOL-02 |
| SN-06 | L890-893, 923-925 | `show_ui` tool_use/tool_result chip 过滤（a2uiToolUseIds 集合） | 平台保留：normalizer 对 `toolName === SHOW_UI_TOOL_NAME` 打 `internal: true` 标记，Session 过滤逻辑不变 | P-A2UI-02 |
| SN-07 | L936-959 | `approval_request`（docker IPC 合成）：`{id, toolName, toolInput, toolUseId}` | `approval_request { requestId, toolName, toolCallId?, input? }`（已有界脱敏规则，计划 §5.1） | P-APR-01 |
| SN-08 | L960-1025 | `a2ui_request`（IPC）：requestId 校验 + `parseShowUiArgs` 复验 + timeoutSec envelope 校验 | `a2ui_request { requestId, block, timeoutSec? }` — **已中立**，直接采纳 | P-A2UI-01 |
| SN-09 | L1026-1047 | `result`：`subtype==='success'`/`is_error`/`result` string/命令 turn 渲染；result-only 文本回退 + 与 assistant 流式去重 | `turn_completed`；命令回退与去重进 normalizer 合同（`final` 语义） | P-RES-01, P-TXT-02 |
| SN-10 | L1049-1099 | `result.usage`（`extractTokenUsage` 字段映射）/`total_cost_usd`/`duration_ms` → 记录 + finalizeRun + org 配额 | `turn_completed { usage?, costUsd?, durationMs? }`；usage 字段名 = 平台规范（camelCase），与 quota-service json_extract 的同步约束写进协议注释 | P-RES-02 |
| SN-11 | L731-734, 1029-1035 | slash command 探测（`/` 前缀）+ 命令 turn 的 result 渲染为 command_result | 保持 `send_message` 透传（平台不解析命令）；命令回显语义进 P-CMD-01 | P-CMD-01 |
| SN-12 | L1122-1156 | auto-compact：向 runtime 流发 `"/compact"` 字符串 + `compact_boundary` 关联 + in-flight 门控 | 平台策略保留；`/compact` 字符串 → `PlatformRuntimeCommand.compact {…}`（或声明 Claude adapter 专属 capability + 中立命令）— **open item** | P-CMP-02 |
| SN-13 | L288-362（broadcastAssistantText） | `<a2ui-json>` 散文切分（v1 遗留通道） | 不进协议（文本层行为保留在 Session）；协议只定义 a2ui_request 阻塞通道 | — |

## 3. `server/ai-client.ts`（local data plane）

| ID | 位置 | Claude 私有语义 | M0.5 candidate | Parity |
|---|---|---|---|---|
| AC-01 | L206-243 | `query()` options 全集：tools/allowedTools/disallowedTools/skills/plugins/systemPrompt/appendSystemPrompt/mcpServers/strictMcpConfig/persistSession/resume/permissionMode/cwd/maxTurns/model | `claude-harness-adapter` 内部实现细节；Host 只下发 `ResolvedExecutionPolicy` | P-POL-02 |
| AC-02 | L248-341 | PreToolUse hook envelope：`input.tool_name/tool_input/toolUseID` → `hookSpecificOutput.permissionDecision/Reason` | adapter 内翻译：`approval_request` ⇄ 引擎 hook 原语；Host 只见平台事件 | P-APR-01 |
| AC-03 | L35-81 | MessageQueue 推 `{type:'user', message:{role:'user', content}}`（Claude streaming-input prompt 形状） | adapter 内部；平台 `send_message { content }` | P-CMD-01 |
| AC-04 | L131-133 | `resolveLocalModel` → `"opus"` 别名链（Zhipu/GLM 经 Anthropic 兼容端点） | `ResolvedExecutionPolicy.modelRef` 中立别名；引擎侧解析真实 endpoint/model | P-POL-02 |
| AC-05 | L172-178 | `PATH_TOOL_ARG`：Claude 工具名 + 入参字段名（Read/Write/Edit/Glob/Grep 的 file_path/path）用于 L1 路径围栏 | 归入 claude adapter 的守卫配置；平台只定义 workspacePolicy，工具名字典不进协议 | P-POL-03 |
| AC-06 | L188-202 | SDK 超时墙 env：`CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`/`MCP_TOOL_TIMEOUT` = max(现有, submit+30s) | adapter 内部（A2UI 阻塞预算的引擎侧实现） | P-A2UI-01 |
| AC-07 | L236-238 | `platform-web-tools` in-process MCP（SDK `McpServerConfig` in-process 形） | `EngineCapabilities.mcp` + adapter 内挂载；平台 web 工具是否中立化 = open item（见 §6） | P-INIT-02 |
| AC-08 | L239 `persistSession: true` | Claude 会话持久化（resume 依赖） | `EngineCapabilities.sessionResume` 声明 + adapter 内配置 | P-SESS-02 |

## 4. `server/docker-runtime.ts`（IPC 边界 + 凭证）

| ID | 位置 | Claude 私有语义 | M0.5 candidate | Parity |
|---|---|---|---|---|
| DR-01 | L124-149 | env 转发：`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`AGENT_MODEL`/`CLAUDE_CODE_MAX_OUTPUT_TOKENS`/`DASHSCOPE_API_KEY` | **模型凭证路径**：计划 §2 分阶段（M1 短时效测试凭证 / M3 egress proxy）；协议不携带凭证，走 Guest 启动注入通道 | P-CRED-01 |
| DR-02 | L170-173 | `CLAUDE_SESSION_ID` env → resume | `start { resumeToken? }` | P-SESS-02 |
| DR-03 | L175-182 | `AGENT_SDK_OPTIONS` JSON（剥离 tools 后的 Claude SDK options 序列化） | `start { policy: ResolvedExecutionPolicy }`（compiler 移入 Guest/adapter） | P-POL-01 |
| DR-04 | L277-291 | `sdk_event`：容器 SDK 事件**原样**透传（`msg.event as RuntimeEvent`）— Claude envelope 跨越 WS 边界 | **协议中立性的核心切点**：normalizer 移到容器内 worker，边界上只有 PlatformRuntimeEvent | P-INIT-01, P-RES-01 |
| DR-05 | L293-298 | `session_id` IPC 帧捕获（一次性） | `runtime_ready.engineSessionId` | P-SESS-01 |
| DR-06 | L25-27, 192-195 | `agent-claude-home-<chatId>` 卷 → `/root/.claude`（Claude Code 会话状态存储） | workspacePolicy 扩展 `engineStateDir` 中立概念；迁移路径见计划 §3.1 退出门槛 | P-SESS-02 |

## 5. `docker/agent-entry.ts`（容器侧）

| ID | 位置 | Claude 私有语义 | M0.5 candidate | Parity |
|---|---|---|---|---|
| AE-01 | L333-439 | `query()` options 组装（与 AC-01 双份维护） | `claude-harness-adapter`（**唯一** Claude 实现点） | P-POL-02 |
| AE-02 | L360-433 | PreToolUse hook：平台 allow 名单（含 `"Skill"` 特判）+ `/opt/agent` 前缀守卫 + approval_request 合成 + pendingApprovals park | adapter 守卫层；平台 allow 名单来自 policy，`"Skill"` 特判收进 claude compiler | P-APR-01, P-APR-02 |
| AE-03 | L442-472 | streamEvents：`value.session_id` 嗅探、`result` subtype 日志、全部 SDK 事件原样 `sdk_event` 转发 | worker 内 normalizer 先转换再上行 | P-SESS-01, P-RES-01 |
| AE-04 | L269-274 | `CLAUDE_SESSION_ID` resume 读取 | `start.resumeToken` | P-SESS-02 |
| AE-05 | L285-331 | A2UI 容器内 MCP server + `a2ui_request` IPC + fallback timer | 已中立（SN-08 同型）；MicroVM worker 复用同一模式 | P-A2UI-01 |
| AE-06 | L180-189 | `SYSTEM_PROMPT` 兜底默认（与 ai-client L26 双份） | policy.prompt 缺省值收敛到一处 | P-POL-02 |
| AE-07 | L95-146 | `AGENT_SDK_OPTIONS` 解析 + 插件/MCP/additionalDirectories 路径守卫 | policy 校验器（`microsandbox-policy.ts` 同源逻辑） | P-POL-03 |

## 6. Open items（M0.5 冻结前必须定夺）

1. **slash command 面**：`/compact`、`/context` 等是 Claude 词汇。候选：(a) 协议加 `compact` 中立命令 + `context_compacted` 事件（SN-02/SN-12 的自然延伸）；(b) 声明为 Claude adapter 专属 capability，其他引擎报告无此能力。auto-compact 平台策略（session.ts L1122）依赖 (a) 的语义，建议 (a)。
2. **platform-web-tools**（bailian_search/web_fetch）：当前以 SDK in-process MCP 形态存在（AC-07/AE-05 注释）。是否升格为平台中立 tool 通道（不依赖 SDK MCP 原语）需在 M0.5 定，否则 EngineCapabilities.mcp 对非 Claude 引擎名不副实。
3. **sdkInitSnapshot 诊断面**：model/cwd/tools/skills/plugins/mcpServers 快照广播给前端（SN-01）。中立化后哪些字段保留、哪些是 Claude 专属诊断，需列出白名单。
4. **`getClaudeSessionId()` 外部消费**：确认 ContainerManager/恢复链路对该 getter 的调用点，迁移到 engineSessionId 事件通道（P-SESS-01 覆盖断言「无残留调用」）。

## 7. Parity 测试用例（M0.5 合同测试输入）

每例 = 同一 Claude 原始输入下，旧直解路径（session.ts 现行为）与 normalizer 输出的事件序列等价（含广播 payload 与审计 recordEvent 的 eventType/payload）。

| ID | 断言 |
|---|---|
| P-INIT-01 | `system/init` → runtime_ready（engineSessionId/capabilities/diagnostics）+ sdk_init 审计与 slash_commands 广播不回归 |
| P-INIT-02 | platform-web-tools 在 init mcp_servers 列表中出现（两路径一致） |
| P-TXT-01 | assistant content blocks 的 text 块 → assistant_text（顺序、分块不变） |
| P-TXT-02 | result-only 文本回退：同内容已流式 → 去重；未流式 → 补发（final 语义） |
| P-TOOL-01 | tool_use 块 → tool_requested（toolCallId/toolName/input）+ tool_use 审计 |
| P-TOOL-02 | tool_result 块 → tool_result（is_error→success 取反、content 拼接、5000 截断）+ show_ui chip 过滤 |
| P-APR-01 | PreToolUse 非白名单 → approval_request（含 input）+ always-allow 短路 + 审批决策审计 |
| P-APR-02 | deny verdict → 引擎侧 permissionDecision deny、零执行 |
| P-A2UI-01 | show_ui → a2ui_request（requestId/block/timeoutSec 复验）→ 提交回轮 + 超时/取消终态 |
| P-A2UI-02 | show_ui 的 tool_use/tool_result 不产生 chip（internal 标记路径） |
| P-RES-01 | result → turn_completed（subtype/is_error 映射、命令 turn 走 command_result） |
| P-RES-02 | usage/cost/duration 字段映射与 quota-service json_extract 兼容；org 配额评估触发一致 |
| P-CMD-01 | `/` 前缀消息透传引擎 + 命令 turn 渲染 command_result |
| P-CMD-02 | 未知 system subtype 降级 command_result（5000 截断）不回归 |
| P-CMP-01 | compact_boundary → context_compacted + autoCompactInFlight 释放 |
| P-CMP-02 | auto-compact 触发 → compact 命令入流 + busy 再拉起 + awaiting 门控 |
| P-SESS-01 | session_id 捕获（local 嗅探 / docker IPC 帧）→ runtime_ready.engineSessionId；无 getClaudeSessionId 残留调用 |
| P-SESS-02 | resume 链：resumeToken → 引擎 resume 配置（docker env / local option 两路径等价） |
| P-POL-01 | CapabilityBundle → ResolvedExecutionPolicy 单向派生：approvalRequired = exposed−allowed−denied 恒等 + subset 校验 |
| P-POL-02 | policy → claude compiler 输出与现 buildLocalSessionOptions/agent-entry 组装等价（tools/allowed/plugins/mcp/skills/model/prompt） |
| P-POL-03 | 路径守卫不回归：/opt/agent 前缀、additionalDirectories 排除 /workspace、L1 PATH_TOOL_ARG 字典 |
| P-CRED-01 | 凭证不进协议帧/审计/policy 序列化（仅 Guest 启动注入通道） |

## 8. 明确不耦合（无需迁移）

- 审计存储（agent_events 表 + runId 链）：payload 已规范化，引擎无关。
- org 配额/预算（evaluateTokenTurn）：消费平台 usage 规范。
- A2UI 卡片 schema/校验（a2ui-schema.ts）：平台自有。
- 文件工作区（file-workspace-service）：Host 侧。
- 消息持久化（chatStore）：role/content 模型，引擎无关。
