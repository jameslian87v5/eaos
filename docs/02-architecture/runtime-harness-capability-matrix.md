# Runtime Harness 可适配性矩阵（M0）

> M0 范围补充交付物（owner 确认 Codex/Pi 纳入 M0）。`docs/开发计划/local-microvm-runtime-整体研发计划.md` §5/§7。
> **只读探测**：本机 executable/version 探测 + 仓库源码确认；未安装/升级任何 Harness、未发起模型调用、未读取任何凭证内容（`~/.codex`/`~/.pi` 仅确认目录存在）。
> 基线：commit `dcdf45b` + 探测时间 2026-09-15。**不实现 Adapter**（M4 范围）。

## 0. 证据分级

| 级别 | 含义 |
|---|---|
| `source-confirmed` | 本仓库生产代码/依赖清单直接证实（每日在生产路径运行） |
| `host-probed` | 本机只读探测（`--version`/`--help` 输出）证实 |
| `guest-unverified` | 有线索但未在真实 Guest/端到端中验证 |
| `unsupported` | 有证据表明该能力不存在或不满足平台语义 |
| `unavailable` | 本机不可探测（必须附 reason） |

## 1. Host 探测结果

| Harness | 本机状态 | 版本 |
|---|---|---|
| Claude Code CLI | `~/.nvm/.../bin/claude`（PATH ✓） | 2.1.207 |
| Claude Agent SDK | 仓库依赖 `@anthropic-ai/claude-agent-sdk@^0.3.183`（package.json:63） | ^0.3.183 |
| Codex CLI | `~/.nvm/.../bin/codex`（PATH ✓）；`~/.codex` 存在（未读内容） | codex-cli 0.144.6 |
| Pi | **PATH ✗**（`~/.pi` 目录存在，二进制不在 PATH） | —（unavailable） |

## 2. 能力矩阵

平台语义列 = 平台中立协议需要的对应能力（映射自 `runtime-harness-coupling-inventory.md`）。

| 平台语义 | Claude（SDK in-platform） | Codex CLI 0.144.6 | Pi |
|---|---|---|---|
| Linux arch（生产目标） | `source-confirmed`：docker 镜像内 arm64/x64 运行（docker/Dockerfile + 生产路径） | `host-probed`：官方 Rust 二进制发布含 linux x64/arm64；**本机 darwin 仅证 darwin-arm64**，Linux 未实测 → `guest-unverified` | `unavailable`：本机无二进制 |
| 非交互/TTY | `source-confirmed`：SDK `query()` 流式输入（ai-client.ts MessageQueue） | `host-probed`：`codex exec`（"Run Codex non-interactively"，stdin 可喂 prompt） | `unavailable` |
| 结构化事件流 | `source-confirmed`：SDK 事件流（system/assistant/user/result；session.ts handleSDKMessage 全量消费） | `host-probed`：`codex exec --json`（JSONL 事件到 stdout）；**事件 schema 未逐一核对** → 字段级 `guest-unverified` | `unavailable` |
| engineSessionId / resume | `source-confirmed`：`session_id` 捕获 + `resume` option（agent-runtime.ts L25-27；docker CLAUDE_SESSION_ID） | `host-probed`：`codex exec resume <id>` / `--last` 子命令存在；session ID 获取通道（JSONL 事件里是否稳定携带）`guest-unverified` | `unavailable` |
| 执行前 hook（PreToolUse 等价） | `source-confirmed`：SDK `hooks.PreToolUse`（ai-client.ts L248、agent-entry.ts L360） | `host-probed`（部分）：`--sandbox read-only\|workspace-write\|danger-full-access` + hooks 机制（`--dangerously-bypass-hook-trust` 暗示 hooks 存在）；**执行前逐工具 hook 的平台等价性未证** → `guest-unverified` | `unavailable` |
| 外部 approval verdict（异步回注） | `source-confirmed`：hook 返回 Promise 挂起等待 host 决策（agent-entry pendingApprovals + ApprovalManager） | `unsupported`（暂判）：`codex exec` 非交互模式无文档化的中途审批回注通道；approval 由 sandbox policy + config `approval_policy` 预决定。**M4 必须实测推翻或确认**（若确认 unsupported → 按 plan §5.2 封顶 L1 或走平台托管工具路径） | `unavailable` |
| abort | `source-confirmed`：`abortController`（ai-client.ts L244） | `guest-unverified`：进程级 SIGINT/SIGTERM 可终止（未验证优雅 abort 语义与 JSONL 尾帧） | `unavailable` |
| MCP | `source-confirmed`：`mcpServers` option + `strictMcpConfig`（平台治理已依赖） | `host-probed`：`codex mcp` 子命令 + `codex mcp-server`（Codex 自身可作 MCP server）；config.toml 管理 → 接线方式 `guest-unverified` | `unavailable` |
| usage / cost / duration | `source-confirmed`：result 事件 `usage`/`total_cost_usd`/`duration_ms`（session.ts L1049-1099，org 配额已消费） | `guest-unverified`：JSONL 事件是否含 token usage/cost 未核对 | `unavailable` |
| 工作目录 / 配置目录 / 凭证依赖 | `source-confirmed`：cwd=workspace roots（L1 围栏）；`/root/.claude` 卷；`ANTHROPIC_API_KEY/BASE_URL` env（docker-runtime.ts L124-149）；SDK 子进程还读 `~/.claude/settings.json`（已知坑：CLAUDE_CONFIG_DIR shim） | `host-probed`：`~/.codex/config.toml` + `-c` 覆盖 + `CODEX_HOME` 可重定向（help 证实）；auth 存于 `~/.codex`（存在性证实，内容未读）→ Guest 内 CODEX_HOME 重定向可行性 `guest-unverified` | `unavailable`：`~/.pi` 存在但无二进制，依赖面未知 |
| 内置工具禁用 / allow·deny 表达性 | `source-confirmed`：`tools`/`allowedTools`/`disallowedTools` 三元（approvalRequired = 差集恒等式，平台铁律） | `host-probed`（部分）：sandbox 三档可表达「读写边界」；**逐工具 allow/deny 名单的等价表达未证**（config 层是否有 tools 禁用面）→ `guest-unverified`；若不可表达 → plan §5.3「无法表达的约束必须拒绝启动」 | `unavailable` |
| 备注：外部沙箱协同 | `permissionMode:"bypassPermissions"` + PreToolUse 守卫（平台模式） | `--dangerously-bypass-approvals-and-sandbox` 自述「intended solely for environments that are externally sandboxed」——与 MicroVM「平台审批 + VM 隔离」同构（信号良好，`host-probed`） | — |

## 3. 各 Harness 当前最高可承诺等级（L0–L4）

等级定义见计划 §5.2：L0 单轮文本 / L1 流式多轮 / L2 结构化 Tool+审批 / L3 resume·usage·MCP / L4 A2UI+完整治理。

| Harness | 最高可承诺 | 依据 | 缺口 |
|---|---|---|---|
| Claude | **L4** | 全部 `source-confirmed`（本平台生产路径） | 无（committed engine，唯一） |
| Codex | **L0**（adapter-probed, NOT deployable） | M4-S1 真实 `codex exec --json` 探测（codex-cli 0.144.6）+ `CodexHarnessAdapter`（18/18 + worker-seam 8/8 测试） | `abort=false`+`streamingText=false` 是硬 L0 闸（`maxPromisableLevel===0`）；`structuredToolEvents=false`（codex 产生 `command_execution` 但 post-hoc 不可治理→adapter **drop**，不合成 governed tool call）；`preToolApproval=false`（exec 无外部 approval verdict 回注）；`host-proxy` egress **fail-closed 拒绝**（codex 跑自己的 model loop，持 OPENAI_API_KEY，不可走平台凭证代理）；codex 不在 `eaos-guest:0.1.4`、未接 Worker、real Guest smoke = BLOCKER；**`deployable:false`，不得标 committed** |
| Pi | **无（unavailable）** | M4-S3 只读探测（2026-09-18）：`which pi pi-cli pi-agent pi-harness` 全 not found；`npm view @pi/cli` 404、`pi-cli` 仅占位包（0.0.0，非 Pi harness）；`~/.pi` 仅含空 `agent/extensions/` 目录（无二进制、无 config）；docker daemon 未运行→Guest 镜像无法探 | 无可执行物→无版本/JSONL/session/resume/abort/usage/MCP/凭证面可探；每项能力 = `unavailable`（无二进制，一切未知）。**不得实现 adapter**（无依据）。**`deployable:false`，不得标 committed**。前置：先获取 Pi 可执行物来源 + 版本钉死，再从 L0 起测 |
| DeepSeek | **无（unavailable）** | M4-S4 只读探测（2026-09-18）：`which deepseek deepseek-cli deepseek-harness ds-cli ds` 全 not found；`npm view @deepseek/cli` 404；`deepseek-cli` 1.0.2 是第三方薄 chat CLI（deps: `openai`+`commander`+`inquirer`，无 tool-use loop/JSONL/session/resume/abort/MCP，非 harness）；`deepseek-harness` 0.0.1 自述「Reserved package name... real package will be published here when development completes」（占位名，无代码）；`~/.deepseek`、`~/.config/deepseek` 均不存在；无 deepseek 相关 env key；docker daemon 未运行→Guest 镜像无法探 | DeepSeek **模型 API** 可调用（via openai SDK）但**≠ harness 已可接入**（artifact 铁律）；无任何 harness 能力可探（structured events/session/resume/pre-hook/abort/MCP/usage/cost 全 `unavailable`）。**不得实现 adapter**（无依据，不得把模型 API 误当 harness）。**`deployable:false`，不得标 committed**。前置：先确认是否存在 DeepSeek 官方/第三方 agentic harness（非薄 API wrapper），版本钉死，再从 L0 起测 |

> **M4-S1/S2 修正（2026-09-18）**：本表旧版「Codex L1」是 M0 Host 只读探测的**暂判**，已被 M4-S1 真实 `codex exec --json` 探测推翻。`maxPromisableLevel` 的实现把 `abort`+`streamingText` 都列为 L1 前置（平台不能 abort 或不能流式 → L0），故 codex 的 proven `sessionResume`/`tokenUsage` 虽真实但不越 L0。证据：`docs/06-deployment/evidence/microvm-m4/m4-s1-codex-harness-probe-2026-09-18.md`、`server/m4-codex-adapter.test.ts`、`server/m4-codex-worker-seam.test.ts`。
>
> **M4-S3 Pi 探测（2026-09-18）**：Pi 仍 **unavailable**——本机无可执行物（`which` 全失败、npm 无包、`~/.pi` 仅有空目录）。无二进制即无任何能力可验证，Pi 列每项保持 `unavailable`，不实现 adapter。证据：`docs/06-deployment/evidence/microvm-m4/m4-s3-pi-capability-probe-2026-09-18.md`。
>
> **M4-S4 DeepSeek 探测（2026-09-18）**：DeepSeek 仍 **unavailable**——无官方/第三方 agentic harness 可执行物。`deepseek-cli` 1.0.2 是第三方薄 chat CLI（仅 openai SDK 包装，无结构化事件/session/resume/abort/MCP），不构成 harness；`deepseek-harness` 0.0.1 是 npm 占位名（自述「real package will be published here when development completes」），无代码。DeepSeek **模型 API 可调用 ≠ harness 已可接入**（artifact 铁律）。DeepSeek 列每项保持 `unavailable`，不实现 adapter。证据：`docs/06-deployment/evidence/microvm-m4/m4-s4-deepseek-capability-probe-2026-09-18.md`。

## 4. 对 M0.5 协议冻结的输入

1. **Codex 的审批缺口是协议试金石（已 M4-S1 确认）**：`codex exec` 模式确无外部 approval verdict 回注（`--ask-for-approval` 仅交互式 prompt，无 pre-execution Host 回注钩子）→ `EngineCapabilities.preToolApproval=false` 的引擎在平台只能 L0，或走「平台托管可审批工具路径」（plan §5.2 已有此分级）——协议无需为此加特殊通道，能力握手即可。M4-S1 进一步确认 `command_execution` post-hoc 不可治理，adapter 必须 drop（不得合成 `tool_result`）。
2. **resume 通道统一**：Codex 的 session ID 获取方式（JSONL 事件字段）必须在 M4 核对后映射到 `runtime_ready.engineSessionId`；协议字段保持中立（禁止 `claudeSessionId` 类命名，计划 M0.5 验收已有）。
3. **凭证/配置目录重定向**：三家均需 Guest 内可控的 HOME 级隔离（`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/Pi 等价物）——纳入 M1 POC 的 Guest 环境清单，凭证仍按计划 §2 分阶段策略走注入通道，不进协议。
4. **工具禁用表达性**：Codex 若无逐工具名单，`ResolvedExecutionPolicy.compiler` 必须拒绝启动而非静默降级（plan §5.3 铁律的直接应用）。

## 5. 探测命令记录（可复跑，全部只读）

```bash
command -v claude codex pi            # claude ✓ / codex ✓ / pi ✗
claude --version                      # 2.1.207 (Claude Code)
codex --version                       # codex-cli 0.144.6
codex exec --help                     # 非交互 + --json + resume + -s sandbox 三档
codex --help | grep -iE "mcp|config"  # mcp / mcp-server / CODEX_HOME
ls -d ~/.codex ~/.pi                  # 存在性确认（内容未读取）
grep claude-agent-sdk package.json    # ^0.3.183
```

## 6. 已知限制

- Codex 能力面来自 CLI help 与版本号，**未读其源码/文档全文**（网络策略限制外部抓取），字段级判断一律标 `guest-unverified`，M4 前不得升格。
- Pi 完全黑盒（本机不可探测）；「至少 Claude/Codex/Pi 三列」中 Pi 列全部 `unavailable` 是当前诚实上限。
- 未发起任何模型调用 → 未验证真实事件序列，仅验证能力面存在性。
