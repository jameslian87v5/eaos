# Plugin 构建与安装指南

> **面向两类开发者**：Skill Hub 开发者（制作 plugin 包）和应用开发者（使用平台 API 安装和管理 plugin）。
>
> 关联文档：
> - `docs/02-architecture/plugin-installer-design.md` — Installer 设计方案
> - `docs/02-architecture/skill-hub-design.md` — Skill Hub 市场设计
> - `docs/03-modules/application-extension-points.md` — 扩展点契约
> - `docs/04-guides/app-hook-guide.md` — Hook plugin 详细指南

---

## 1. 概念速览

```
Skill Hub（独立项目）          Plugin Installer（本平台）         Runtime
┌──────────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│ git 仓库          │     │ POST /plugins/import      │     │ capability-      │
│ ├── catalog.json │────▶│  → staged copy            │────▶│  provider.resolve()│
│ └── plugins/*    │     │  → real validator          │     │  → mount to container│
│                  │     │  → config registration     │     │  → SDK plugins 选项  │
│ clone 到本地缓存  │     │  → audit                   │     │  → 三层 gate     │
└──────────────────┘     └──────────────────────────┘     └─────────────────┘
```

**两类 plugin 包**（都是 Claude Code native plugin）：

| 类型 | 目录结构要求 | 注册到 | 运行时机制 |
|---|---|---|---|
| `skill` | `.claude-plugin/plugin.json` + `skills/*/SKILL.md` | `data/skills.json` → `skills/<name>/` | SDK `plugins` 选项 + 只读 mount `/opt/agent/plugins/<name>` |
| `hook-plugin` | `.claude-plugin/plugin.json` + `hooks/hooks.json` | `data/hook-plugins.json` → `hooks/<name>/` | 同上，SDK 自动发现 `hooks/hooks.json` 并执行 hook 脚本 |

> **MCP 是独立的第三条路径**（`installApiAsMcp()`），不接受外部 plugin 包。MCP 的 `command` 由平台生成（`/opt/agent/mcp/<name>/run.sh`），不接受包元数据里的 command/args。

---

## 2. Skill Hub 开发者：如何构建 Plugin 包

### 2.1 Skill Plugin 包结构

```
my-skill/
├── .claude-plugin/
│   └── plugin.json          # 必需：插件清单
├── skills/
│   └── my-skill/
│       └── SKILL.md          # 必需：skill 描述文件
└── scripts/                   # 可选：辅助脚本
    └── helper.sh
```

#### plugin.json

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "代码审查 skill，覆盖安全/性能/可维护性"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 插件名，必须匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`，且与安装时 `name` 一致 |
| `version` | 是 | 语义化版本，安装后从 manifest 读取为真相源 |
| `description` | 否 | 展示用描述 |
| `skills` | 否 | skills 目录路径，默认 `"skills"` |

#### SKILL.md

```markdown
---
name: my-skill
description: 系统性代码审查，覆盖安全/性能/可维护性
---

# 代码审查 Skill

当用户要求代码审查时，按以下维度检查：
1. 安全漏洞
2. 性能问题
3. 可维护性
...
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` (frontmatter) | 是 | skill 名称，建议与目录名一致 |
| `description` (frontmatter) | 是 | 一句话描述，模型用此判断何时调用此 skill |
| 正文 | 是 | skill 指令内容，模型调用 skill 时读取 |

### 2.2 Hook Plugin 包结构

```
my-hook-plugin/
├── .claude-plugin/
│   └── plugin.json          # 必需
├── hooks/
│   └── hooks.json           # 必需：hook 声明
└── scripts/
    ├── pre-tool-check.sh     # PreToolUse hook 脚本
    └── post-tool-log.sh      # PostToolUse hook 脚本
```

#### plugin.json

```json
{
  "name": "my-hook-plugin",
  "version": "1.0.0",
  "description": "业务安全规则 hook",
  "hooks": "./hooks/hooks.json"
}
```

#### hooks.json

```json
{
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

> Hook 脚本通过 stdin 接收事件 JSON，通过 stdout 返回决策 JSON。
> 详细格式和示例见 `docs/04-guides/app-hook-guide.md`。

#### 支持的 Hook 事件

| 事件 | 触发时机 |
|---|---|
| `PreToolUse` | 工具执行前 |
| `PostToolUse` | 工具执行后 |
| `UserPromptSubmit` | 用户提交消息时 |
| `Notification` | SDK 发出通知时 |
| `Stop` | agent 停止时 |
| `SessionStart` | 会话开始时 |
| `SessionEnd` | 会话结束时 |

> 未知事件名只 warn 不 reject（warn-but-allow 策略）。

### 2.3 安全约束（包构建时必须遵守）

| 约束 | 说明 |
|---|---|
| **名称安全** | `name` 必须匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`，防 `../` 注入 |
| **全局唯一** | `name` 跨 skill / mcp / hook-plugin 全局唯一，安装时检查 |
| **禁止 symlink** | 包内不允许包含 symlink（供应链边界，防指向包外文件） |
| **plugin.name === 注册 name** | 安装时 validator 会校验 `plugin.json` 的 `name` 与注册的 `name` 一致 |
| **skills 路径在包内** | `plugin.skills` 指向的目录必须在包目录内（防路径逃逸） |
| **hooks 文件存在且可解析** | `hooks.json` 必须存在、是有效 JSON、包含非空 `hooks` 对象 |

### 2.4 catalog.json（Skill Hub 仓库根目录）

如果你的仓库被 Skill Hub 项目 clone，在仓库根目录放 `catalog.json`：

```json
[
  {
    "name": "code-review",
    "description": "系统性代码审查",
    "version": "1.0.0",
    "author": "platform-team",
    "path": "plugins/code-review",
    "visibility": "public",
    "allowedRoles": [],
    "tags": ["code-quality", "review"],
    "hooks": false,
    "scripts": true
  }
]
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 唯一标识 |
| `description` | 是 | 展示用描述 |
| `version` | 是 | 语义化版本 |
| `path` | 是 | 仓库内相对路径，指向 `.claude-plugin/plugin.json` 所在目录 |
| `visibility` | 是 | `public` / `restricted`（按 `allowedRoles` 过滤）/ `hidden`（仅 admin） |
| `allowedRoles` | 否 | `visibility=restricted` 时生效 |
| `tags` | 否 | 分类标签 |
| `hooks` | 否 | 是否包含 hook 脚本（安全提示） |
| `scripts` | 否 | 是否包含可执行脚本（安全提示） |

> 如果仓库没有 `catalog.json`，Skill Hub 会扫描所有子目录自动生成（降级模式）。

---

## 3. 应用开发者：如何通过 API 安装和管理 Plugin

### 3.1 安装 Plugin

```
POST /api/admin/plugins/import
Authorization: Bearer <admin-jwt>
Content-Type: application/json
```

```json
{
  "path": "data/skill-hub-cache/internal-skills/plugins/code-review",
  "name": "code-review",
  "registryCategory": "skill",
  "enabled": true,
  "commitHash": "abc123def",
  "hubSourceId": "internal-skills"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `path` | 是 | 本地路径，realpath 必须在 `PLUGIN_IMPORT_ROOT`（默认 `data/skill-hub-cache`）内 |
| `name` | 是 | 安装后名称，必须匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` |
| `registryCategory` | 是 | `"skill"` 或 `"hook-plugin"` |
| `enabled` | 否 | 默认 `true` |
| `commitHash` | 否 | 来源 git commit hash（审计用） |
| `hubSourceId` | 否 | Skill Hub 源标识（审计用） |

**成功响应**（200）：

```json
{
  "resourceId": "code-review",
  "installedPath": "/path/to/skills/code-review",
  "version": "1.0.0",
  "type": "skill",
  "valid": true,
  "warnings": []
}
```

**失败响应**（400）：

```json
{
  "error": "resourceId \"code-review\" already exists (global uniqueness across skill/mcp/hook-plugin). Uninstall the existing one first."
}
```

**安装流程**（平台内部）：

```
1. 校验 name 格式 + 全局唯一
2. 校验 path 在 import root 内（realpath 检查）
3. 拒绝已存在的同名包（MVP 不支持覆盖，先 uninstall 再 import）
4. 复制到 <name>.staging/（拒绝 symlink）
5. 用真实 validator（skill-config / hook-plugin-config 的 resolveOne）校验 staging 目录
6. 校验通过 → 原子 rename staging → final
7. 写入配置文件（write-temp-and-rename）
8. 验证注册成功（getAllSkills / getAllHookPlugins 能查到且 valid=true）
9. 如果步骤 7-8 失败 → 清理 targetDir + config entry（late failure rollback）
10. 审计记录
```

### 3.2 卸载 Plugin

```
POST /api/admin/plugins/uninstall
Authorization: Bearer <admin-jwt>
Content-Type: application/json
```

```json
{
  "name": "code-review",
  "force": false
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 要卸载的 plugin 名称 |
| `force` | 否 | 默认 `false`。如果被引用则拒绝；`true` 则强制删除 |

**引用检查**（`force=false` 时）：

平台检查以下引用，任一存在则拒绝并列出引用方：
- `application_capabilities` 表：哪些 app 的 allowlist 包含此 resourceId
- `entitlement` 条目：哪些用户/组织被授权使用此资源
- agent activation（`data/agent-capabilities.json`）：暂未实现 lookup-by-resourceId，文档化 gap

**被引用时的失败响应**：

```json
{
  "error": "Plugin \"code-review\" is referenced by application(s): app-1, app-2; entitlement entries: 3. Use force=true to remove anyway."
}
```

### 3.3 列出已安装 Plugin

```
GET /api/admin/plugins/installed
Authorization: Bearer <admin-jwt>
```

可选 query 参数：`?type=skill` 或 `?type=hook-plugin`（无效值返回 400）。

**响应**：

```json
[
  {
    "name": "code-review",
    "type": "skill",
    "version": "1.0.0",
    "description": "系统性代码审查",
    "enabled": true,
    "valid": true,
    "path": "skills/code-review"
  },
  {
    "name": "my-hook-plugin",
    "type": "hook-plugin",
    "version": "1.0.0",
    "description": "业务安全规则 hook",
    "enabled": true,
    "valid": true,
    "path": "hooks/my-hook-plugin"
  }
]
```

### 3.4 安装后：设置能力门控

安装 plugin 只是注册到资源池。要让 agent 实际使用，还需设置三层 gate：

```
app allowlist ∩ entitlement ∩ activation
     │              │              │
     │              │              └─ agent 级别：此 agent 是否激活了此资源
     │              └─ 用户/组织级别：此用户/组织是否有权使用此资源
     └─ 应用级别：此应用是否允许使用此资源（null = passthrough）
```

任何一层 deny = 不挂载。这是 **deny-by-intersection** 语义。

```bash
# 1. 设置 entitlement（允许用户使用此资源）
curl -X PUT http://localhost:3001/api/admin/capabilities/code-review/entitlements \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"entries": [{"scopeType": "user", "scopeId": "user-id", "effect": "allow"}]}'

# 2. 为 agent 激活此资源
curl -X PUT http://localhost:3001/api/agents/<agentId>/capabilities \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"resources": [{"resourceId": "code-review", "enabled": true}]}'

# 3. (可选) 设置 app allowlist
curl -X PUT http://localhost:3001/api/admin/applications/<appId>/capabilities \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"resources": [{"resourceId": "code-review", "enabled": true}]}'
```

### 3.5 Hook Plugin 额外步骤

Hook plugin 需要额外开启 rollout gate：

```bash
# 环境变量（重启服务生效）
HOOK_PLUGINS_ENABLED=true
```

> rollout gate 默认关闭，Docker 加固（egress allowlist / cap drop / readonly rootfs）落地后才会默认开启。

---

## 4. 完整接入流程

### Skill Hub 开发者

```
1. 构建 plugin 包（.claude-plugin/plugin.json + skills/*/SKILL.md）
2. 本地测试：确保 plugin.json 的 name 与目录结构一致
3. 推送到 git 仓库
4. 在仓库根目录放 catalog.json（或让 Skill Hub 自动扫描）
5. 确保 name 全局唯一（不会与已有 skill/mcp/hook-plugin 冲突）
```

### 应用开发者 / 平台管理员

```
1. (Skill Hub 项目) clone 仓库到 data/skill-hub-cache/
2. 调用 POST /api/admin/plugins/import 安装 plugin
   → 平台 staged copy + validate + register
3. 设置 entitlement（用户/组织授权）
4. 为 agent 设置 activation（激活资源）
5. (可选) 设置 app allowlist（应用级上界）
6. (hook-plugin) 开启 HOOK_PLUGINS_ENABLED=true
7. Agent 启动 → resolve() 挂载 plugin → SDK 发现 skill/hook → 执行
```

---

## 5. 安全模型

### Installer 安全（供应链边界）

| 机制 | 说明 |
|---|---|
| Import root allowlist | `path` 的 realpath 必须在 `PLUGIN_IMPORT_ROOT` 内 |
| 名称正则 | 防 `../` 和特殊字符注入 |
| 全局唯一 | 跨 skill/mcp/hook-plugin 检查 name 冲突，不可绕过 |
| Symlink 拒绝 | 包内不允许 symlink，防指向包外文件 |
| Staged install | 先复制到 staging → 校验 → 原子 rename，不直接覆盖活跃包 |
| Late failure cleanup | rename 后失败 → 清理 targetDir + config entry |
| 配置原子写入 | write-temp-and-rename，防配置文件损坏 |
| 审计 | import/uninstall 都记录审计事件，包含来源元数据，不含 payload |

### Runtime 安全（治理守卫）

| 机制 | 说明 |
|---|---|
| 三层 gate | `app allowlist ∩ entitlement ∩ activation`（deny-by-intersection） |
| 物理隔离 | 未授权 skill 不 mount 到容器（entitlement 强制力来自 mount 隔离） |
| `strictMcpConfig` | SDK 忽略所有 `.mcp.json` 文件发现，只使用平台注入的 mcpServers |
| MCP command 前缀 | 必须是 `/opt/agent/mcp/<name>/run.sh`，不接受包元数据里的 command |
| Hook deny-wins | 平台 inline PreToolUse deny 不可被 plugin allow 覆盖 |
| `updatedInput` | 定性为 trusted-code policy，非安全边界；路径安全由容器沙箱强制 |
| Hook rollout gate | `HOOK_PLUGINS_ENABLED` 默认关闭 |
| 审计 | 能力变更审计 `{ appId, actorUserId, agentId, resourceName, action }` |

> **治理守卫铁律**：以上安全机制不可被应用或 hook 覆盖。

---

## 6. 常见问题

### Q: 已安装的 plugin 如何更新？

MVP 不支持覆盖。先 `POST /plugins/uninstall` 卸载，再 `POST /plugins/import` 安装新版本。

### Q: plugin name 与已有 MCP name 冲突怎么办？

全局唯一性检查会拒绝。必须先卸载冲突方（或改名）。

### Q: Skill Hub 仓库没有 catalog.json 能用吗？

能。Skill Hub 会扫描所有子目录，自动生成 catalog（降级模式）。但建议提供 `catalog.json` 以获得更好的元数据和可见性控制。

### Q: MCP 能通过 importNativePlugin 安装吗？

不能。MCP 走独立的 `installApiAsMcp()` 路径（HTTP API → stdio-wrapper MCP 包）。MCP 的 `command` 由平台生成，不接受外部包的 command/args。

### Q: hook plugin 的 updatedInput 能用吗？

技术上 SDK 支持，但平台将其定性为 **trusted-code policy，非安全边界**。应用 hook 不应依赖 `updatedInput` 绕过平台路径检查。路径/工具安全由容器沙箱强制。

---

## 7. 相关文件

| 文件 | 职责 |
|---|---|
| `server/capability-installer.ts` | `importNativePlugin()` / `uninstallNativePlugin()` / `listInstalledPlugins()` |
| `server/admin-app-routes.ts` | API 端点（import / uninstall / installed） |
| `server/skill-config.ts` | Skill plugin 注册/校验/resolve（`resolveOne` 被 installer 复用） |
| `server/hook-plugin-config.ts` | Hook plugin 注册/校验/resolve（`resolveOne` 被 installer 复用） |
| `server/capability-provider.ts` | `resolve()` 挂载 plugin 到容器（三层 gate） |
| `server/capability-resource.ts` | 聚合 skill/mcp/hook-plugin 到统一资源池 |
| `server/application-capabilities.ts` | App allowlist（`listAppsByResourceId` 用于 uninstall 引用检查） |
| `server/entitlement.ts` | Entitlement 管理（`listEntries` 用于 uninstall 引用检查） |
| `data/skills.json` | 已安装 skill 配置 |
| `data/hook-plugins.json` | 已安装 hook plugin 配置 |
