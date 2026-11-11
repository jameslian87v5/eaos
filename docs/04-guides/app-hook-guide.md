# 应用方 Hook 构建指南（Route A — Hook-as-Plugin）

## 概述

平台提供 hook 扩展点，让应用方在 agent 执行工具前后插入自定义逻辑。
应用方构建 **native plugin 包**（Claude Code plugin 格式），平台通过 capability resource 管线挂载到容器内，
SDK 自动发现并执行 hook。**无需运行 webhook 服务。**

> **历史说明**：旧的 webhook envelope 模型（HTTP POST 回调）已弃用并删除。
> 如果你之前使用过 webhook hook，请迁移到 plugin 包模式。

## 工作原理

```
应用方构建 hook plugin 包（.claude-plugin/plugin.json + hooks/hooks.json）
         │
         ├─ 1. 平台管理员注册到 data/hook-plugins.json
         │     + 设置 entitlement + activation + app allowlist
         │
         ├─ 2. Agent 启动时，capability-provider.resolve() 挂载 plugin
         │     - 走 app allowlist ∩ entitlement ∩ activation 三层 gate
         │     - HOOK_PLUGINS_ENABLED=true 才生效（rollout gate）
         │     - readonly mount 到 /opt/agent/plugins/<name>
         │
         ├─ 3. SDK 自动发现 plugin 的 hooks/hooks.json
         │     - 注册声明的 hook 事件（PreToolUse, PostToolUse, ...）
         │
         ├─ 4. Agent 执行工具时，SDK 触发 hook
         │     - hook 是 command 类型：SDK spawn 子进程执行
         │     - stdin 收到事件 JSON，stdout 返回决策 JSON
         │
         └─ 5. 平台 inline PreToolUse 守卫同时运行
               - deny-wins：平台 deny 不可被 plugin allow 覆盖
               - 平台 allow 的工具：plugin 仍可 deny（收窄）
               - 平台要求审批的工具：plugin deny 可跳过人工审批
```

**铁律**：
- App hook 只能**收窄**（deny），不能**放宽**（allow 一个平台拒绝的工具）——deny-wins 语义已由 SDK precedence 实验证实。
- `updatedInput`（输入改写）为 **trusted-code policy**，非安全边界。路径安全由容器沙箱强制，不依赖 hook precedence。

## 支持的 Hook 事件

| 事件 | 触发时机 | 典型用途 |
|---|---|---|
| `PreToolUse` | 工具执行**前** | 拒绝执行、参数校验、业务规则检查 |
| `PostToolUse` | 工具执行**后** | 记录结果、审计、触发业务流程 |
| `PostToolUseFailure` | 工具执行**失败后** | 错误处理、告警 |
| `UserPromptSubmit` | 用户提交消息时 | 输入预处理、敏感信息过滤 |
| `Notification` | SDK 发出通知时 | 外部告警（Slack/邮件等） |
| `Stop` | agent 停止时 | 清理、总结、结果回调 |
| `SessionStart` | 会话开始时 | 初始化、环境检查 |
| `SessionEnd` | 会话结束时 | 清理、报告生成 |

> 完整事件列表见 SDK 文档。平台不限制 hook plugin 注册哪些事件。

## 构建 Hook Plugin 包

### 目录结构

```
hooks/my-hook-plugin/
├── .claude-plugin/
│   └── plugin.json          # 插件清单
├── hooks/
│   └── hooks.json           # hook 声明
└── scripts/
    ├── pre-tool-check.sh     # PreToolUse hook 脚本
    └── post-tool-log.sh      # PostToolUse hook 脚本
```

### plugin.json

```json
{
  "name": "my-hook-plugin",
  "version": "1.0.0",
  "description": "业务安全规则 hook：禁止写入特定路径、记录工具调用审计",
  "hooks": "./hooks/hooks.json"
}
```

### hooks.json

```json
{
  "description": "业务安全 + 审计 hooks",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-check.sh\"",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-log.sh\"",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

### Hook 脚本格式

Hook 脚本通过 **stdin** 接收事件 JSON，通过 **stdout** 返回决策 JSON。

#### 输入（stdin）

```json
{
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/workspace/output/report.md",
    "content": "..."
  },
  "tool_use_id": "tu-abc123",
  "session_id": "sess-xyz"
}
```

#### 输出（stdout）— PreToolUse

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "禁止写入 /etc/ 目录"
  }
}
```

| 字段 | 值 | 说明 |
|---|---|---|
| `permissionDecision` | `"allow"` \| `"deny"` | 是否允许执行该工具 |
| `permissionDecisionReason` | string | 决策原因（展示给用户） |

> **`updatedInput` 禁止使用**：虽然 SDK 支持 `updatedInput` 改写工具输入，
> 但平台将其定性为 trusted-code policy，**不作为安全边界**。
> 应用 hook 不应依赖 `updatedInput` 绕过平台路径检查。
> 路径/工具安全由容器沙箱（filesystem isolation, readonly rootfs, cap drop）强制。

#### 输出（stdout）— PostToolUse

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse"
  }
}
```

PostToolUse hook 的返回值不影响已执行的工具，仅用于副作用（日志、通知等）。

### 示例：业务安全 Hook（Bash）

```bash
#!/usr/bin/env bash
# scripts/pre-tool-check.sh — PreToolUse hook
set -euo pipefail

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# 规则 1: 禁止写入系统目录
if [[ "$tool_name" == "Write" ]] && [[ "$file_path" == /etc/* ]]; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "禁止写入系统目录 /etc/"
  }
}
JSON
  exit 0
fi

# 规则 2: 禁止执行危险命令
if [[ "$tool_name" == "Bash" ]]; then
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
  if echo "$command" | grep -qE 'rm -rf|curl.*\|.*sh|wget.*\|.*sh'; then
    cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "禁止执行危险命令模式"
  }
}
JSON
    exit 0
  fi
fi

# 默认：不干预（让平台守卫继续）
echo '{}'
```

### 示例：审计日志 Hook（Bash）

```bash
#!/usr/bin/env bash
# scripts/post-tool-log.sh — PostToolUse hook
set -euo pipefail

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // empty')

# 记录到容器内文件（可被 workspace output 机制收集）
echo "$(date -Iseconds) tool=$tool_name id=$tool_use_id" >> /workspace/output/hook-audit.log

# PostToolUse 不需要返回决策
echo '{}'
```

## 注册 Hook Plugin

### 1. 放置 plugin 包

将 plugin 包放到项目的 `hooks/` 目录下：

```
hooks/
└── my-hook-plugin/
    ├── .claude-plugin/plugin.json
    └── hooks/hooks.json
    └── scripts/
```

### 2. 配置 data/hook-plugins.json

```json
[
  {
    "name": "my-hook-plugin",
    "type": "hook-plugin",
    "enabled": true,
    "path": "hooks/my-hook-plugin"
  }
]
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | plugin 名称，必须与 plugin.json 的 `name` 一致 |
| `type` | 是 | 固定 `"hook-plugin"` |
| `enabled` | 是 | `true` 启用，`false` 禁用 |
| `path` | 是 | 相对于项目根目录的路径，**必须在 `hooks/` 目录内**（防穿越） |

### 3. 设置 Entitlement + Activation

Hook plugin 走与 skill/mcp 相同的 capability resource 管线：

```bash
# 1. Admin 设置 entitlement（允许 user 使用此资源）
curl -X PUT http://localhost:3001/api/admin/capabilities/my-hook-plugin/entitlements \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "entries": [
      { "scopeType": "user", "scopeId": "user-id", "effect": "allow" }
    ]
  }'

# 2. 为 agent 激活此资源
curl -X PUT http://localhost:3001/api/agents/<agentId>/capabilities \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "resources": [
      { "resourceId": "my-hook-plugin", "enabled": true }
    ]
  }'
```

### 4. 设置 App Allowlist（如果 agent 绑定了应用）

```bash
curl -X PUT http://localhost:3001/api/admin/applications/<appId>/capabilities \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "resources": [
      { "resourceId": "my-hook-plugin", "enabled": true }
    ]
  }'
```

### 5. 开启 Rollout Gate

```bash
# 环境变量（重启服务生效）
HOOK_PLUGINS_ENABLED=true
```

> **注意**：rollout gate 默认关闭。Docker 加固（egress allowlist / cap drop / readonly rootfs）
> 落地后才会默认开启。当前仅用于 dev / trusted-internal 环境。

## 三层 Gate 机制

Hook plugin 必须同时通过三层 gate 才会被挂载：

```
app allowlist ∩ entitlement ∩ activation
     │              │              │
     │              │              └─ agent 级别：此 agent 是否激活了此资源
     │              └─ 用户/组织级别：此用户/组织是否有权使用此资源
     └─ 应用级别：此应用是否允许使用此资源（null = passthrough，[] = 全禁）
```

任何一层 deny = 不挂载。这是 **deny-by-intersection** 语义。

## Precedence 规则

| 平台决策 | Plugin 返回 allow | Plugin 返回 deny | Plugin 超时/失败 |
|---|---|---|---|
| 平台允许 | ✅ 执行 | ❌ 拒绝 | ✅ 执行 |
| 平台要求审批 | → 人工审批 | ❌ 拒绝 | → 人工审批 |

**Plugin 永远不能 allow 一个平台要求审批的工具**——只能提前 deny 省去人工审批。

> 以上规则已由 SDK precedence 实验证实（`scripts/precedence-exp/`）：
> - 平台 inline deny + plugin allow → 最终 deny（deny-wins）
> - Plugin 的 `updatedInput` 在 inline hook 之后生效（故禁止用于安全场景）

## 与业务集成模式

### 模式 1：安全规则引擎

Hook plugin 作为业务安全规则的执行点：

```bash
# 读取业务规则配置（挂载到 workspace）
rules=$(cat /workspace/input/security-rules.json)

# 根据规则判断当前工具调用是否合规
# ... 业务逻辑 ...

# 返回 deny + 原因
```

**适用场景**：禁止特定路径写入、危险命令拦截、敏感数据保护。

### 模式 2：审计日志收集

PostToolUse hook 记录所有工具调用到 workspace，由业务系统收集：

```bash
# 记录到 workspace/output（agent 产出目录）
echo "$input" >> /workspace/output/tool-audit.jsonl
```

**适用场景**：合规审计、行为分析、成本追踪。

### 模式 3：业务流程触发

Hook 在工具执行后触发外部业务流程（通过容器内 curl）：

```bash
# PostToolUse: 工具执行完成后通知业务系统
curl -s -X POST http://business-api.internal/webhook \
  -H "Content-Type: application/json" \
  -d "{\"event\": \"tool_executed\", \"tool\": \"$tool_name\"}"
```

> **注意**：容器网络出站在 Docker 加固后会被 egress allowlist 限制。
> 当前仅 trusted-internal 环境可用。

### 模式 4：输入预处理

UserPromptSubmit hook 在用户消息提交时预处理：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/scripts/sanitize-input.py\""
          }
        ]
      }
    ]
  }
}
```

**适用场景**：敏感信息脱敏、prompt 注入检测、业务术语替换。

## 调试

- Hook 调用日志在容器 stdout（`[agent-entry]` 前缀）
- Plugin 加载日志：`[agent-entry] Plugins: N, ...`
- Capability resolve 日志：`[CapabilityProvider] Agent xxx: ... hook-plugin(s): N`
- 检查资源池：`GET /api/admin/capabilities`（type=hook-plugin 的条目）
- 检查 entitlement：`GET /api/admin/capabilities/<resourceId>/entitlements`
- 检查 activation：`GET /api/agents/<agentId>/capabilities`
- Hook 脚本 stderr 会出现在容器日志中

## 完整接入流程

```
1. 应用方构建 hook plugin 包
   hooks/my-hook-plugin/
   ├── .claude-plugin/plugin.json
   ├── hooks/hooks.json
   └── scripts/*.sh
   ↓
2. 配置 data/hook-plugins.json（注册到资源池）
   ↓
3. Admin 设置 entitlement（用户/组织授权）
   ↓
4. 为 agent 设置 activation（激活资源）
   ↓
5. (可选) 设置 app allowlist（应用级上界）
   ↓
6. 开启 HOOK_PLUGINS_ENABLED=true（rollout gate）
   ↓
7. Agent 启动 → resolve() 挂载 plugin → SDK 发现 hooks → 执行
```

## 安全边界

| 层 | 机制 | 状态 |
|---|---|---|
| 平台 inline guard | PreToolUse deny-wins | ✅ 已实现 |
| 路径穿越防护 | hooks/ 目录 realpath 校验 | ✅ 已实现 |
| 三层 gate | app allowlist ∩ entitlement ∩ activation | ✅ 已实现 |
| Rollout gate | HOOK_PLUGINS_ENABLED env | ✅ 已实现（默认关闭） |
| 容器沙箱 | filesystem isolation, readonly rootfs, cap drop | 🔧 待实现（独立 PR） |
| Egress allowlist | 容器出站网络限制 | 🔧 待实现（独立 PR） |

> **当前状态**：hook plugin 功能完整但 rollout gate 默认关闭。
> 在 Docker 加固落地前，仅用于 dev / trusted-internal 环境。
