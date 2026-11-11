# Agent Platform Domain Model

> Status: draft  
> Scope: domain model for the Agent-first enterprise MVP.  
> Related: `docs/00-product/agent-first-enterprise-prd.md`,
> `docs/02-architecture/external-alignment-reference.md`.

## 1. Domain Principle

The long-lived product object is the Agent instance.

Runtime containers, conversations, files, events, and capability resolution are
supporting concepts around the Agent. They should not become the product root.

## 2. Target Object Graph

```text
Organization
  -> Users
  -> Capability Resources
  -> Entitlements
  -> Applications                     # Phase 6 (Application Layer): 应用预设
       -> Application Capability Allowlist   # -> Capability Resources (upper bound)
       -> Agents
            -> Workspace
            -> Agent Profile
            -> Agent Capability Activations
            -> Runtime Sessions
            -> Conversations
                 -> Messages
            -> Files / Artifacts
            -> Events / Audit
```

MVP bridge:

```text
current chatId == target agentId == current conversationId
```

This bridge preserves current runtime behavior while letting product and interface
design move toward the target model.

## 3. Core Objects

### Organization

Enterprise boundary.

MVP:

- single default org may be sufficient;
- `orgId` should remain present in context and future schemas.

Target fields:

```text
id
name
status
createdAt
```

### User

Human platform user.

MVP fields already mostly exist:

```text
id
orgId
username
displayName
role: admin | user
createdAt
```

User role is not a full RBAC system. MVP only needs admin/user.

### Application

企业内一个「应用预设」——平台按它驱动 Agent 实例。应用 **不是独立软件**,是平台里的一份预设
(profile + 能力 allowlist + 数据空间 + 入口 + 凭证)。**Agent 归属一个 Application。**

> Phase 6 (Application Layer)。As-built:`applications` 表已建(`server/database.ts`)。
> 权威架构:`docs/02-architecture/platform-application-layer-architecture.md`。

As-built 字段(取自 `applications` 表):

```text
id, orgId
name, description
profileId          -> Agent Profile(提示词模板,NULL = 平台默认)
entryUrl           前端入口(信息性)
apiKeyPrefix / apiKeyHash   应用凭证(hash-at-rest,prefix 用于 id lookup)
status             active | disabled
lastUsedAt         审计(每次鉴权调用更新)
createdAt, updatedAt
```

关系与铁律:

- 一个 Application 归属 Organization;**Agents 归属一个 Application**(`agents.app_id`,NOT NULL DEFAULT `'default-app'`,规范归属在 agents、**不镜像 chats**)。
- Application 经 `application_capabilities` 声明**能力 allowlist(上界)**,引用 Capability Resources;实例能力 = `app allowlist ∩ entitlement ∩ agent activation`(**deny-by-intersection**)。
- `default-app` = 现有 chat 工作台,作为一等公民应用行(**不留 NULL**)。
- **平台不建应用领域层**:语义层 / 口径 / 知识库 / 对账 / 业务前端永远是 Application 自带的 know-how,平台碰不得。

### Extension Point(扩展点)

平台向 Application 暴露的、应用可注册/透传的介入点。原则:**透传 + 守卫,不重新定义**
(平台把 SDK 接口贡献出来,怎么用让应用实现;不发明 DSL)。

> Phase 6。详见 `docs/03-modules/application-extension-points.md`。

三类:

```text
能力挂载(已有):   Application 注册 skill/mcp/hook-plugin -> 平台校验 + 注入容器 + 审批。
Hook 透传(已落地): Application 构建 native plugin 包(.claude-plugin/plugin.json + hooks/hooks.json)
                  -> 走 capability resource 管线(type=hook-plugin, app allowlist ∩ entitlement ∩ activation)
                  -> SDK 自动发现并执行 hook 脚本(command type)。
                  平台不翻译 hook 语义;inline PreToolUse deny-wins 守卫 + 容器沙箱为安全边界。
                  updatedInput 定性为 trusted-code policy,非安全边界。
                  治理守卫铁律不可被应用 hook 覆盖(见下)。
事件流(规划):     平台把 agent 事件流透传推给 Application(webhook / app-scoped WS)。
```

治理守卫铁律(不可被应用或应用 hook 覆盖):deny-default 能力门控、MCP `command` 必须 `/opt/agent/mcp/`
前缀、`strictMcpConfig:true`、路径前缀校验、审计 / configVersion drift、
平台 inline PreToolUse deny-wins、`HOOK_PLUGINS_ENABLED` rollout gate。

现状(已落地):hook 作为 native plugin 包走 capability resource 管线,
`server/hook-plugin-config.ts` 校验包形 + 路径穿越防护,
`server/capability-provider.ts` resolve() 挂载(三层 gate + rollout gate + collision guard),
`docker/agent-entry.ts` 保留平台 inline PreToolUse 守卫 + approval flow。
旧 webhook envelope 模型已删除。详见 `docs/04-guides/app-hook-guide.md`。

### Agent

Long-lived enterprise work member.

Target fields:

```text
id
orgId
ownerUserId
name
description
status: active | archived | deleted
visibility: private
profileId
workspaceId
runtimePolicyId
createdAt
updatedAt
```

MVP mapping:

```text
chats.id        -> agent.id
chats.user_id   -> agent.ownerUserId
chats.title     -> agent.name
```

As-built (Phase 5 / Option C): a real `agents` table now exists alongside
`chats`, joined by the same-id bridge (`agents.id == chats.id`, **no hard FK**).
The mapping above is how an `agents` row is *seeded*; `title` and timestamps stay
live from `chats`, while `orgId` / `description` / `status` / `profileId` and the
per-Agent prompt columns are the Agent's own. The `workspaceId` /
`runtimePolicyId` / `visibility` target fields are still deferred. See
内部迁移文档（未随开源发布） §Phase 5
As-built.

### Agent Profile

Declarative configuration that shapes Agent behavior.

Contains:

```text
model
systemPrompt / appendSystemPrompt
tool profile
default maxTurns
response style later
```

MVP may keep this inside `CapabilityProvider` defaults and runtime settings.

As-built (Phase 5 MP5d): a real `agent_profiles` table exists, shipping the subset
`{ id, orgId, name, description, systemPrompt, appendSystemPrompt }`. Multiple
Agents share one via `agents.profile_id` (nullable, no hard FK → a deleted profile
degrades to "no profile"). The richer target fields below (`model`,
`toolProfileId`, `defaultRuntimePolicyId`) are deferred. `resolve()` precedence:
per-Agent override > profile > platform default.

Target fields:

```text
id
orgId
name
description
model
systemPrompt
appendSystemPrompt
toolProfileId
defaultRuntimePolicyId
```

### Workspace

Agent's working directory and file persistence boundary.

MVP:

- one workspace per Agent;
- implemented with Docker workspace volume and `FileWorkspaceService`.

Target fields:

```text
id
orgId
agentId
kind: agent_default
storageType: docker_volume | local_fs | object_storage
status
createdAt
```

Workspace contains files and artifacts, but not enterprise capability resources.

### Workspace File

File metadata for uploaded inputs and Agent outputs.

Current `workspace_files` is already aligned:

```text
id
userId
chatId/current agentId
kind: input | output
filename
path
mimeType
sizeBytes
createdAt
```

Target rename:

```text
chatId -> agentId
conversationId optional later
```

### Capability Resource

Enterprise resource that can be configured onto Agents.

Types:

```text
skill
mcp
```

Target fields:

```text
id
orgId
type: skill | mcp
name
displayName
version
description
source: builtin | local | uploaded | remote
status: active | disabled | deprecated | invalid
riskLevel: low | medium | high
resourcePath
manifest
runtimeSpec
createdBy
createdAt
updatedAt
```

Current mapping:

```text
data/skills.json + skills/* -> local skill capability resources
```

MCP has no full implementation yet, but should follow the same resource-pool
pattern rather than a separate ad hoc path.

### Capability Entitlement

Configuration authorization: who may attach a capability resource to an Agent.

MVP scope:

```text
scopeType: org | user
scopeId
effect: allow | deny
```

Target fields:

```text
id
resourceId
scopeType
scopeId
effect
createdBy
createdAt
```

MVP interpretation:

- entitlement controls configuration;
- it does not perform per-call runtime authorization.

### Agent Capability Activation

Records which capabilities are enabled for an Agent.

Target fields:

```text
id
agentId
resourceId
enabled
config
createdBy
updatedAt
```

`config` stores per-Agent resource settings:

- Skill: optional prompt parameters or feature flags later.
- MCP: env secret refs, tool allowlist, server-specific config later.

Resolution rule:

```text
resolved capabilities =
  enabled Agent activations
  ∩ active resources
  ∩ current org/user entitlement
```

### Runtime Session

A concrete execution instance for an Agent.

Current `agent_sessions` already aligns with this concept.

Target fields:

```text
id
agentId
conversationId optional
runtimeType: docker | local
status
containerId
hostPort
workspaceVolume
claudeHomeVolume
claudeSessionId
restoreMode
restartCount
lastError
lastActivityAt
createdAt
updatedAt
```

Runtime session is replaceable. It is not the Agent.

### Conversation

A message thread under an Agent.

MVP:

- one Agent has one current conversation;
- current `messages.chat_id` remains acceptable.

Target fields:

```text
id
agentId
ownerUserId
title
visibility: private
status
createdAt
updatedAt
```

Future:

- multiple conversations per Agent;
- team-visible conversations if team sharing is introduced.

### Message

User/assistant/system message in a conversation.

Current messages are chat-scoped. Target moves them to conversation-scoped while
retaining `agentId` for query convenience.

### Agent Event

Append-only operational record.

Includes:

- SDK init;
- assistant events;
- tool calls;
- approval requests;
- runtime errors;
- restart/resume events;
- capability resolution snapshot later.

Current `agent_events` is aligned.

## 4. Control State vs Runtime State

Control-plane state:

```text
Agent
Workspace binding
Agent Profile
Capability Resource
Capability Entitlement
Agent Capability Activation
Runtime Policy
```

Runtime/data-plane state:

```text
Docker container
Claude SDK query execution
Claude session id
Tool calls
Runtime events
Files written during execution
SDK init discovered skills/plugins
```

Do not let runtime state become the source of truth for configuration.

Example:

- Admin configured Skill X for Agent A: control-plane desired state.
- SDK init discovered `skill-x:analyze`: runtime observed state.

Both are useful, but they answer different questions.

## 5. Capability State Vocabulary

Use precise terms:

```text
registered
  Resource exists in enterprise resource pool.

entitled
  Current user/org is allowed to configure it.

enabled
  Agent activation says this resource should be used.

resolved
  CapabilityProvider included it in the runtime snapshot.

mounted
  Docker runtime mounted its files into the container.

discovered
  Claude SDK system init reported it.

invoked
  Agent actually used it during a run.
```

MVP should track at least:

- registered;
- entitled;
- enabled;
- discovered.

Mounted can be inferred during runtime startup, but should only be displayed as
truth after a runtime/capability snapshot exists.

Invoked can be delayed until audit/reporting work.

## 6. Current-Code Bridge

Keep these mappings explicit:

```text
chatStore.createChat()        -> create Agent in product language
ChatList                      -> Agent list in UI language
ChatWindow                    -> Agent workbench/chat surface
chatId                        -> temporary agentId
workspace volume by chatId    -> workspace volume by agentId later
claude-home volume by chatId  -> runtime/conversation state volume later
data/skills.json              -> temporary local capability registry
CapabilityProvider.resolve()  -> permanent southbound config bridge
```

Avoid a broad rename-only refactor until the domain model is stable and tests
cover the runtime path.

## 7. MVP Data Model Recommendation

Do not immediately create every target table.

Recommended MVP additions after docs are approved:

```text
capability_resources
capability_entitlements
agent_capabilities
```

Optional compatibility approach:

- keep `chats` table;
- add columns needed for Agent product language if necessary;
- introduce compatibility views/services named AgentService later.

As-built: all of the above now exists. `AgentService` has been the Agent semantic
layer since Phase 1 and, as of Phase 5 (Option C), owns a real `agents` table
alongside `chats` (same-id bridge); `capability_resources` /
`capability_entitlements` / `agent_capabilities` landed in Phase 2. Treat this
section as historical context, not a to-do list.

## 8. Deferred Decisions

- multi-conversation support;
- team-shared Agents;
- multiple workspaces per Agent;
- version-pinned capability snapshots;
- capability invocation audit;
- remote Hub package cache;
- full RBAC.

These should not block MVP design.
