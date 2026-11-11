# Skill 注入与发现机制

> 面向后续开发者：解释 Claude Agent SDK 原生的 skill 发现/调用机制，以及本项目当前的 skill 注册与注入实现，并为后续 Skill Hub 扩展提供依据。
>
> 适用版本：`@anthropic-ai/claude-agent-sdk@^0.3.183`
>
> **MVP 方案决策（混合方案）**：skill 采用 Claude Code **native plugin** 包格式
> （`.claude-plugin/plugin.json` + `skills/*/SKILL.md`），通过 SDK `plugins` 选项 +
> 只读挂载注入。**entitlement 强制力来自 mount 物理隔离**（未授权 skill 不挂载
> → 容器内无文件）。三层各司其职：
> - **暴露 Skill 工具**：`resolve()` 在有启用 skill 时把 `"Skill"` 注入 `sdkOptions.tools`
>   （SDK 的 `skills` 选项**不会**自动暴露 Skill 工具——它只过滤）。
> - **过滤 skill 清单**：`sdkOptions.skills`（entitlement-gated skill 名列表）控制
>   哪些 skill 对模型可见。
> - **免审批**：`PreToolUse` hook 兜底放行 `"Skill"`（替代 deprecated 的
>   `allowedTools: ["Skill"]`，0.2.133 起 deprecated）。
>
> 关键区分：`skills` 选项是"上下文过滤器不是沙箱"（未列出的 skill 文件仍可在磁盘
> 上被 Read/Bash 访问），所以它**不承担 entitlement 强制语义**——物理 mount 隔离
> 才是。注意 **`allowedTools:["Skill"]`（免审批）被 deprecated ≠ `tools:["Skill"]`
> （暴露）被 deprecated**——后者仍必需，且不与 `skills` 选项互斥（一个负责暴露开关，
> 一个负责过滤清单）。

---

## 1. 背景与术语

| 术语 | 含义 |
| --- | --- |
| **Plugin（插件）** | 一个目录，含 `.claude-plugin/plugin.json` 清单 + `skills/`、`agents/`、`hooks/` 等子目录。SDK 通过 `plugins` 选项加载。 |
| **Skill（技能）** | 插件内 `skills/<skill-name>/SKILL.md` 文件。启动时只读取 metadata（name/description），被调用时才加载完整内容。 |
| **`Skill` 工具** | SDK 内部动态工具，模型通过它在对话中执行某个 skill。 |
| **CapabilityProvider** | 本项目的能力解析层，决定每个 runtime 注入哪些 tools/plugins/mcpServers/prompt。 |
| **AgentRuntime** | 一次会话对应的隔离执行环境（本项目为 Docker 容器）。 |

---

## 2. Claude Agent SDK 原生机制

### 2.1 Skill 是文件系统 artifact，不是注册 API

SDK 不提供注册 skill 的编程接口。Skill 完全由文件系统结构定义：

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json        # 插件清单：name, version, description, skills
└── skills/
    └── my-skill/
        └── SKILL.md        # 技能正文（frontmatter + 指令）
```

- `plugin.json` 的 `name` 必须与加载方约定一致；`skills` 字段指向技能目录（默认 `./skills/`）。
- 每个 skill 目录必须含 `SKILL.md`，其 frontmatter 可声明 `allowed-tools`、`user-invocable` 等。

> **plugin.json 需要遵守 Claude Code plugin schema**：按官方文档，未知顶层字段会产生 warning；字段类型错误会导致插件校验失败。不要把 Codex marketplace 风格的 `interface` 块混入 Claude Code `.claude-plugin/plugin.json`，否则会污染原生插件清单，也会让平台自己的导入校验和 SDK 校验语义不一致。
>
> 平台侧可以在 Admin 导入阶段使用更严格的质量门禁，例如只允许：`name`、`version`、`description`、`author`（`{name, email?, url?}`）、`homepage`、`repository`、`license`、`keywords`、`skills`、`commands`、`agents`、`hooks`、`outputStyles`、`mcpServers`、`lspServers`。但这应被定义为平台策略，而不是误认为 SDK 运行时会因未知字段必然拒绝插件。

### 2.2 加载链路（SDK 内部）

1. 通过 `options.plugins` 传入本地插件路径：

   ```ts
   plugins: [{ type: "local", path: "/abs/path/to/my-plugin" }]
   ```

   `path` 指向**插件根目录**（即 `.claude-plugin/` 和 `skills/` 的父目录）。

2. SDK 内部 `getSkills()` 扫描，产出两类：
   - `skillDirCommands`：来自 settings 目录的 skill
   - `pluginSkills`：来自 `plugins` 加载的插件 skill

   两者合并进**斜杠命令列表**（slash commands），并注入到 `Skill` 工具中。

3. `Skill` 工具是 SDK 内部动态工具，定义约为：

   ```js
   { name: "Skill", isEnabled: () => true,
     userFacingName: (a) => a?.skill ? `/${a.skill}` : "Skill",
     description: async ({ skill }) => `Execute skill: ${skill}`,
     prompt: async () => /* 动态列出全部可用 skill */ }
   ```

   注意：`Skill` **不在** `sdk-tools.d.ts` 的静态 schema 列表里（那里只有 Read/Bash/Glob/Grep/Edit/Write/Task/WebFetch 等），因为它是**运行时动态工具**。

### 2.3 模型如何"知道"有哪些 skill

关键点：**模型的 skill 感知来自 `Skill` 工具的描述（prompt），而不是 systemPrompt。**

`Skill` 工具的 prompt 在运行时动态生成，内容类似：

```
Execute a skill within the main conversation.
When users ask you to perform tasks, check if any of the available skills below
can help complete the task more effectively. Skills provide specialized capabilities...
<这里列出全部可用 skill 的 name + description>
```

SDK 日志中可见：`Skills and commands included in Skill tool: <list>`。

**因此，只要 `Skill` 工具被启用，模型就能在工具描述里看到完整 skill 清单**，无需读文件。

### 2.4 验证手段：system init 消息

插件/skill 加载成功后，会出现在 SDK 的 system initialization 消息里：

```ts
message.skills          // 例如 ["hello-skill:hello-skill", "minimal-plugin:minimal-plugin-skill"]
message.plugins         // [{ name, path }]
message.slash_commands  // 含 skill 对应的 /命令
message.tools           // 含 "Skill"（若已启用）
```

插件 skill 以 `plugin-name:skill-name` 前缀出现。本项目 Admin Console 的 Sessions 面板已展示该 `sdkInit` 快照。

### 2.5 两个关键选项语义（极易踩坑）

**(a) `tools` 选项是"内建工具基集"白名单**

```ts
tools?: string[] | { type: "preset"; preset: "claude_code" }
```

- `string[]` → 只暴露列出的内建工具。映射为 CLI `--tools <names>`。
- `[]` → 禁用全部内建工具。
- `{ type:"preset", preset:"claude_code" }` → 启用全部默认工具（CLI `--tools default`）。

> **若用显式数组且不含 `Skill`，则 `Skill` 工具不会暴露给模型** → 模型不知道有 skill，只能用 Read/Grep 去翻文件目录。这正是本项目早期的 bug。

**(b) `systemPrompt` 字符串会整段替换默认提示**

```ts
systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string }
```

- `string` → **完全替换** Claude Code 默认系统提示。
- `{ type:"preset", preset:"claude_code", append }` → 保留默认 + 追加。

> 本项目当前传自定义字符串 `systemPrompt`。由于 skill 感知来自 `Skill` 工具描述（§2.3）而非 systemPrompt，**自定义 systemPrompt 不影响 skill 发现**。但若未来依赖默认提示中的其它 Claude Code 行为，应改用 preset+append 形式。

### 2.6 `skills` 选项（SDK 0.2.x+）与本项目的混合用法

SDK `0.2.x` 起新增了 `options.skills` 选项，`0.2.133` 起 `allowedTools` 里传 `'Skill'` 被标记为 deprecated（推荐改用 `skills`）。其类型与语义：

```ts
skills?: string[] | "all"
```

- 省略（默认）：SDK 不做自动配置，CLI 自身默认仍生效（**不等于"关闭 skills"**）。
- `"all"`：启用全部被发现的 skill。
- `string[]`：仅启用列出的 skill（按 `SKILL.md` 的 `name`/目录名，或 `plugin:skill` 限定名）。

**关键限制（SDK 官方原文）**：

> *"This is a context filter, not a sandbox: unlisted skills are hidden from the model's listing and rejected by the Skill tool, but their files remain on disk and are reachable via Read/Bash."*

即 `skills` 是**上下文过滤器，不是沙箱**：未列出的 skill 只是对模型"隐藏"，其文件仍在磁盘上，模型可用 `Read`/`Bash` 直接读取。

**本项目的混合方案**：三层机制各司其职（实证校正，见 §2.3/§2.5a/§4）：

| 层 | 机制 | 职责 |
| --- | --- | --- |
| **entitlement 强制** | `mounts` 只挂载 entitled skill → 未授权 skill 不在容器文件系统 | 安全不变量：deny-default 物理强制 |
| **Skill 工具暴露** | `tools` 含 `"Skill"`（`resolve()` 在 `skillNames` 非空时注入） | **暴露** Skill 工具给模型（`skills` 选项不负责此事） |
| **skill 清单过滤** | `sdkOptions.skills: skillNames`（entitlement-gated 名列表） | **过滤**哪些 skill 对模型可见（上下文过滤器，非沙箱） |
| **免审批** | PreToolUse hook `|| input.tool_name === "Skill"` 兜底 | Skill 调用只加载指令，无破坏性副作用（替代 deprecated `allowedTools:["Skill"]`） |

`resolve()` 同时产出 `plugins`（挂载路径）+ `mounts`（只读挂载）+ `skills`（过滤清单）+ `tools`（含 `"Skill"` 时暴露 Skill 工具），四者来源一致（同一个 `enabledSkills` 集合）。当没有 skill 被启用时，`skillNames: []` → `resolve()` 不把 `"Skill"` 注入 `tools` → 不暴露空的 Skill 工具。

> **实证（SDK 0.3.183）**：仅传 `skills` 选项而 `tools` 不含 `"Skill"` 时，`system.init.message.tools` 不含 `"Skill"`，模型对全部 skill 失明（即便已 discovered + mounted + entitlement-gated 正确）。必须 `tools` 含 `"Skill"` 才暴露 Skill 工具。这与 §2.5(a) 一致——`tools` 显式数组不含 `Skill` 则 Skill 工具不暴露。

> **为什么不只用 `skills` 做 entitlement 门控**：`skills` 选项是上下文过滤器不是沙箱——未授权 skill 的文件仍在容器内，模型可用 Read/Bash 读取。物理 mount 隔离才是 deny-default 的强制手段。
>
> **`allowedTools:["Skill"]` vs `tools:["Skill"]` vs `skills` 选项（三者常被混淆）**：
> - `tools:["Skill"]` —— **暴露** Skill 工具（模型才能看到/调用 skill）。**必需，未 deprecated。**
> - `skills:["name",...]` —— **过滤**哪些 skill 对模型可见（上下文过滤器）。与 `tools:["Skill"]` **并用**，不互斥。
> - `allowedTools:["Skill"]` —— **免审批** Skill 调用。0.2.133 起 **deprecated**，本项目改用 PreToolUse hook 兜底。
>
> SDK 0.2.133 release note 的「deprecated」仅针对 `allowedTools:["Skill"]`（免审批），**不**针对 `tools:["Skill"]`（暴露）。早期迁移（commit 91fb30f）误把 `tools` 里的 `"Skill"` 一并移除，导致模型失明——已校正（`resolve()` 在有 skill 时注入）。

**DEFAULT_PROFILE 当前状态**（基集不含 `"Skill"`；`resolve()` 在有启用 skill 时动态注入）：

```ts
const DEFAULT_PROFILE: ToolProfile = {
  tools:        ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],  // 基集，不含 "Skill"
  allowedTools: ["Read", "Grep", "Glob"],
  // "Skill" 由 resolve() 在 skillNames.length > 0 时注入 sdkOptions.tools（暴露 Skill 工具）
};
```

**`resolve()` 产出**：

```ts
sdkOptions: {
  plugins,              // [{ type:"local", path:"/opt/agent/plugins/<name>" }]
  skills: skillNames,   // entitlement-gated skill 过滤清单
  tools: skillNames.length > 0 ? [...DEFAULT_PROFILE.tools, "Skill"] : DEFAULT_PROFILE.tools,  // 有 skill 时暴露 Skill 工具
  allowedTools: DEFAULT_PROFILE.allowedTools,  // 不含 "Skill"（免审批走 PreToolUse hook）
  ...
}
```

**`agent-entry.ts` 消费**：

```ts
// query() 传 skills 选项
...(SKILLS !== undefined ? { skills: SKILLS } : {}),

// PreToolUse 兜底免审批 Skill（skills 选项启用后 Skill 工具不在 ALLOWED_TOOLS 里）
if (ALLOWED_TOOLS.includes(input.tool_name) || input.tool_name === "Skill") {
  return {};  // auto-approve
}
```

---

## 3. 本项目当前实现

### 3.1 数据流总览

```
data/skills.json
   │  (enabled plugin 列表)
   ▼
server/skill-config.ts        解析 + 安全校验 + 发现 SKILL.md
   │  getEnabledPlugins(): ResolvedSkill[]
   ▼
server/capability-provider.ts 生成 CapabilityBundle
   │  - sdkOptions.plugins:   [{ type:"local", path:"/opt/agent/plugins/<name>" }]
   │  - sdkOptions.tools:     [...,"Skill"]
   │  - mounts:               host skill 目录 → /opt/agent/plugins/<name> (ro)
   ▼
server/docker-runtime.ts      创建容器时注入
   │  - AGENT_TOOLS / AGENT_ALLOWED_TOOLS 环境变量
   │  - AGENT_SDK_OPTIONS (plugins/systemPrompt/...)
   │  - Binds: host → /opt/agent/plugins/<name>:ro
   ▼
docker/agent-entry.ts         容器内消费，构造 query() options
   │  - plugins 路径前缀校验 (/opt/agent/plugins/)
   ▼
Claude Agent SDK query()      原生加载 → 注入 Skill 工具
```

### 3.2 配置文件 `data/skills.json`

```json
[
  { "name": "hello-skill",    "type": "plugin", "enabled": true, "path": "skills/hello-skill" },
  { "name": "minimal-plugin", "type": "plugin", "enabled": true, "path": "skills/minimal-plugin" }
]
```

- `type` 当前仅支持 `"plugin"`（`"mcp"` 预留，未实现）。
- `path` 必须位于项目 `skills/` 目录内（防路径穿越）。
- `enabled` 由 Admin Console 或手动编辑切换，**仅对新建 runtime 生效**（无热重载到已有容器）。

### 3.3 `server/skill-config.ts` — 解析与校验

`resolveOne()` 的校验链（任一失败则 `valid=false`，附 `error`）：

1. `type === "plugin"`，否则拒绝。
2. `name` 匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`（防容器路径穿越）。
3. `path` 经 `realpathSync` 解析后必须落在 `skills/` 内（防 symlink/`..` 逃逸）。
4. 必须存在 `.claude-plugin/plugin.json`（Claude Code 原生位置）。
5. `plugin.name === cfg.name` 且 `plugin.version` 非空。
6. `plugin.skills`（默认 `skills`）目录存在且在插件目录内。
7. 至少发现一个 `skills/*/SKILL.md`，记入 `declaredSkillNames`（平台静态扫描，区别于 SDK 运行时 `sdkInit.skills`）。

产物 `ResolvedSkill`：

```ts
interface ResolvedSkill extends SkillConfigEntry {
  absolutePath: string;        // host 真实路径
  version: string;
  description: string;
  pluginName: string;
  declaredSkillNames: string[]; // 平台静态扫描结果，如 ["hello-skill"]
  valid: boolean;
  error?: string;
}
```

公共 API：
- `getAllSkills()`：含启用+禁用，供 Admin UI 展示。
- `getEnabledPlugins()`：仅 `enabled && valid`，供注入。
- `setSkillEnabled(name, enabled)`：写回配置（新 runtime 生效）。

### 3.4 `server/capability-provider.ts` — 能力解析

`LocalCapabilityProvider.resolve()` 对每个 enabled skill：

```ts
const containerPath = `/opt/agent/plugins/${skill.name}`;
plugins.push({ type: "local", path: containerPath });
mounts.push({ hostPath: skill.absolutePath, containerPath, readonly: true });
skillNames.push(...skill.declaredSkillNames);
```

默认沙箱 profile（基集 `tools`/`allowedTools` 不含 `Skill`；`resolve()` 在有启用 skill 时把 `"Skill"` 注入 `sdkOptions.tools` 暴露 Skill 工具）：

```ts
const DEFAULT_PROFILE = {
  tools:        ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
  allowedTools: ["Read", "Grep", "Glob"],
  approvalRequiredTools: ["Write", "Edit", "Bash"],
};
```

`resolve()` 产出 `sdkOptions.skills: skillNames`（entitlement-gated **过滤**清单）+ 在 `skillNames.length > 0` 时把 `"Skill"` 注入 `sdkOptions.tools`（**暴露** Skill 工具）。PreToolUse hook 兜底免审批 `"Skill"`（见 §2.6）。

> **混合方案**：entitlement 强制来自 `mounts`（物理隔离）；Skill 工具**暴露**靠 `tools:["Skill"]`；skill 清单**过滤**靠 `sdkOptions.skills`。三者来源一致（同一个 `enabledSkills` 集合）。**`skills` 选项本身不暴露 Skill 工具**（实证见 §2.6）。

### 3.5 `server/docker-runtime.ts` — 容器注入

`startContainer()` 把能力固化为**容器创建时的环境变量 + bind mounts**：

```ts
env.push(`AGENT_TOOLS=${JSON.stringify(this.options.tools)}`);          // 含 Skill
env.push(`AGENT_ALLOWED_TOOLS=${JSON.stringify(this.options.allowedTools)}`);
const { tools, allowedTools, ...sdkRest } = bundle.sdkOptions;
env.push(`AGENT_SDK_OPTIONS=${JSON.stringify(sdkRest)}`);               // plugins/systemPrompt/...
// Binds: hostPath → containerPath:ro
```

> **重要：工具集与插件在容器创建那一刻就烤进了环境变量/挂载。** 修改 `capability-provider.ts` 后，已有 warm 容器不会更新 —— 必须重建容器（见 §4）。

### 3.6 `docker/agent-entry.ts` — 容器内消费

- 解析 `AGENT_TOOLS` / `AGENT_ALLOWED_TOOLS` / `AGENT_SDK_OPTIONS`。
- 安全校验：`plugins[].path` 必须以 `/opt/agent/plugins/` 开头，否则丢弃。
- 构造 SDK `query()` options，传入 `tools` / `plugins` / `systemPrompt` 等。
- `PreToolUse` hook：在 `ALLOWED_TOOLS`（含 `Skill`）内的工具自动放行，其余请求主进程审批。

---

## 4. 运维须知（常见"改了没生效"）

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 改了 `capability-provider.ts` 但新容器仍是旧工具集 | 后端进程未重载（`tsx watch` 偶发不触发） | **重启后端**；用 `docker inspect <c> --format '{{.Config.Env}}'` 看 `AGENT_TOOLS` 是否含 `Skill` |
| Stop 后仍是旧行为 | warm resume 重连到旧容器 | 容器 `AutoRemove:true`，Stop 即删除；下一条消息走 cold resume 重建 |
| 模型不列 skill、去 grep 目录 | `tools` 未含 `Skill`，或后端跑旧代码 | 确认启动日志 `Docker tool config: tools=[...,"Skill"]` |
| skill 启停不生效 | 仅对新 runtime 生效 | Stop 旧 runtime 后发消息重建 |
| 部分 skill 不出现（其它正常） | 该插件 `plugin.json` 含非标准字段（如 `interface`），被 SDK 严格 schema 静默拒绝 | 剔除非标准字段（见 §2.1）；注意 `skill-config.ts` 不校验这些字段，故 Admin 仍显示 valid，但 SDK 不加载 |

**验证清单**：
1. 后端启动日志：`[server] Docker tool config: tools=[...,"Skill"]`、`[CapabilityProvider] Injecting N skill(s)`。
2. 新容器：`AGENT_TOOLS` 含 `Skill`。
3. Admin Console → Sessions：`sdkInit.skills` 已填充。
4. 对话首问 `What Skills are available?` → 直接列出，不 grep。

---

## 5. Skill Hub 扩展依据

当前为 `LocalCapabilityProvider`（读 `data/skills.json` + 本地 `skills/`）。架构已为远程 Skill Hub 预留扩展点。

### 5.1 扩展接口

实现一个 `RemoteCapabilityProvider`，复用同一 `CapabilityBundle` 契约：

```ts
interface CapabilityBundle {
  sdkOptions: { plugins?, mcpServers?, tools?, allowedTools?, disallowedTools?,
                systemPrompt?, appendSystemPrompt?, additionalDirectories?, maxTurns? };
  mounts: Array<{ hostPath; containerPath; readonly }>;
  env: Record<string, string>;
}
```

`resolve(context)` 接收 `{ orgId, userId, chatId, profileId, runtimeType }`，按租户/用户/会话返回不同能力组合。

### 5.2 设计要点

- **来源解耦**：Hub 负责拉取/缓存插件包到本地缓存目录（如 `/opt/agent/plugins/<id>`），Provider 只产出 `plugins` + `mounts`，与现有链路完全一致。
- **保持原生包格式**：Hub 分发的包必须是 Claude Code 原生结构（`.claude-plugin/plugin.json` + `skills/*/SKILL.md`），可直接复用 `skill-config.ts` 的校验逻辑。
- **`Skill` 工具仍是开关**：无论本地或远程，注入的 profile 必须含 `Skill`，否则模型无法原生调用。
- **安全边界不变**：容器内 `agent-entry.ts` 的 `/opt/agent/plugins/` 路径前缀校验对所有来源生效；远程包落盘后仍受同一沙箱约束。
- **版本与签名**：Hub 应在 `plugin.json` 之外维护版本/校验和/签名元数据，落盘前校验完整性（本地 Provider 无此需求）。
- **热更新策略**：与本地一致，能力变更只对**新建 runtime** 生效；如需对运行中会话生效，需引入 runtime 重建流程。

### 5.3 演进路线建议

1. 抽象 `CapabilityProvider` 接口（已有隐式契约，显式化）。
2. 落地 `RemoteCapabilityProvider`：Hub 客户端 + 本地插件缓存 + 校验。
3. Provider 选择器：按 `RUNTIME_MODE` / 配置切换 Local vs Remote。
4. （可选）`type: "mcp"` 支持：扩展 `skill-config.ts` 与 `/opt/agent/mcp/` 挂载约定。

### 5.4 Agent 自创 skill：两层模型（创作 vs 发布）

"智能体自己写 SKILL.md 并优化"被拆成两个本质不同的阶段，**企业控制面的边界落在"发布"而非"创作"**：

| 层 | Tier 1 — Workspace 本地草稿 | Tier 2 — 资源池发布 |
| --- | --- | --- |
| **位置** | `/workspace/.skills/<name>/SKILL.md`（可写、per-Agent volume，cold resume 保留） | `skills/<name>/`（host，只读挂载）+ `data/skills.json` |
| **谁创建** | Agent 自己 `Write`，无需控制面 | 控制面（admin 审批 / 发布 API） |
| **格式** | 裸 SKILL.md（对模型最友好） | native plugin（混合方案，version/audit/签名） |
| **作用域** | 仅当前 Agent 自己 | 可被授权的其他 Agent 复用 |
| **entitlement** | 不适用（私有内容） | 强制（deny-default + 物理隔离） |
| **发现方式** | SDK `skills`/`additionalDirectories` 指向 workspace（见 §2.6 末段） | `plugins` + 只读挂载 |

要点：

- **创作自由**：Agent 写自己 workspace 里的 SKILL.md 本质只是写文件，没有新权限提升——它本来就能 `Write` 任意文件再 `Read` 回来执行。任何方案都支持这种"自创自用自发现"。
- **发布受控**：让草稿进入共享资源池必须**穿过控制面边界**。这一步天然由 host 侧完成，因为 `skills/` 是只读挂载、`data/skills.json` 在控制面，**容器内的 Agent 物理上无法单方面写入**。
- **无热重载约束同样适用**：Agent 会话中途新建的 skill，要作为注册 Skill 被发现需新 runtime；但当场可直接 `Read` 自己刚写的文件执行（不依赖 Skill 工具机制）。
- **MVP 不实现 Tier 1/Tier 2 发布闭环**。MVP 仅落地混合方案的 Tier 2 注入（平台/admin 导入 native plugin）。Agent 自创草稿 + 提交发布属于后续阶段（见迁移计划 Phase 6）。

### 5.5 Skill 安装器（"最后一公里"）

现有文档（§3、§4、§5.1-5.3）都聚焦于 skill **已经在 `skills/` 目录之后**如何注入，但没有覆盖 skill 包**怎么进入** `skills/` 目录、`data/skills.json` **怎么被创建/更新**。当前是手动放目录 + 手动编辑 JSON。

参考 GitNexus 的 `setup` 自动安装器思路（检测目录 → 复制文件 → 注册配置 → 幂等合并），可补一个**本地安装器**（位于 `resolve()` 管线上游，不改控制面架构）：

```
源（本地目录 / npm 包 / Git）
   ↓ capability-installer（新）
1. 获取 skill 文件
2. 若为裸 SKILL.md，自动生成 .claude-plugin/plugin.json 包装为 native plugin（保持混合方案单一注入格式）
3. 复制到 skills/<name>/
4. 增量注册 data/skills.json（建议用 jsonc-parser AST 合并，保留注释/格式）
5. 跑 skill-config.ts 的 resolveOne() 验证包结构
   ↓
现有管线不变：skill-config → capability-provider → resolve() → Docker
```

设计约束：

- **输出格式统一为 native plugin**，不引入第二种注入格式（裸 SKILL.md 仅作为"源"，安装时被包装）。
- **不写宿主机编辑器配置**（与 GitNexus 不同）：本项目唯一注入目标是 Docker runtime，不应修改 `~/.claude.json` 等宿主机文件。
- **不绕过 entitlement**：安装只是把资源放进资源池，启用仍需 entitlement + activation。
- MVP 可选实现；优先级见迁移计划。

---

## 6. 参考

- 源码：`server/skill-config.ts`、`server/capability-provider.ts`、`server/docker-runtime.ts`、`docker/agent-entry.ts`
- SDK 类型：`node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.d.ts`（`tools` / `systemPrompt` / `plugins` 选项）、`coreTypes.d.ts`（system init 消息含 `skills`/`plugins`/`slash_commands`）
- 官方文档：Claude Code Docs — Agent Skills in the SDK / Plugins in the SDK
- 相关：`docs/02-architecture/enterprise-mvp-technical-architecture.md`（§3.6、§6 能力提供层）、`docs/docker-runtime-skill-manual-test.md`
