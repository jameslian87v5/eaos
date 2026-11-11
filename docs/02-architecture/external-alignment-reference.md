# External Alignment Reference

> Purpose: collect a small set of primary references that should constrain the
> Agent-first enterprise platform design. This is not a market research report.
> It is a design guardrail document for PRD, domain model, configuration-plane,
> Skill/MCP, and runtime architecture work.

## 1. Scope

Use only mechanisms that affect our architecture:

- Claude Code plugin/skill discovery and package shape.
- MCP architecture and stdio runtime implications.
- Agent/conversation/run-style object separation.
- Control plane / data plane separation for runtime orchestration.

Do not copy external product structures blindly. Use them to validate boundaries,
terminology, and interface direction.

## 2. Claude Code Skills And Plugins

Primary references:

- Claude Code plugins reference: https://code.claude.com/docs/en/plugins-reference
- Claude Code skills guide: https://code.claude.com/docs/en/skills

Relevant facts:

- A Claude Code plugin is a self-contained directory of components. It can include
  skills, agents, hooks, MCP servers, LSP servers, monitors, themes, and other
  metadata.
- Plugin skills are discovered from `skills/<skill-name>/SKILL.md`, command files,
  or a root `SKILL.md` in specific cases.
- Claude Code can discover plugin skills automatically when the plugin is installed
  or loaded.
- `.claude-plugin/plugin.json` defines plugin metadata and component paths. The
  manifest is optional in some layouts, but using it gives explicit metadata and
  path control.
- Current official docs say `name` is the only required manifest field if a
  manifest is present.
- Current official docs say unrecognized top-level fields are warnings, not load
  blockers. Wrong field types still fail validation. This corrects our earlier
  assumption that any unknown top-level field would reject the plugin.
- Plugin MCP servers can be declared through `.mcp.json` or `plugin.json`, but they
  execute as MCP servers and carry a stronger runtime/security boundary than pure
  prompt skills.
- Skill descriptions and names are loaded so Claude knows what is available. The
  docs also call out that users can ask what skills are available as a diagnostic.

Design implications for this project:

- Keep native Claude Code plugin/skill structure. Do not invent a separate skill
  runtime format.
- Platform-side import should validate and normalize Claude Code plugin packages,
  then mount them into the Agent runtime as plugins.
- Treat `SKILL.md` discovery as the canonical skill instruction source.
- Treat platform static scans as `declared skills`; reserve `SDK discovered skills`
  for `system/init` data returned by the running SDK.
- Use `claude plugin validate --strict` semantics as a CI/admin quality gate later,
  but do not encode stale assumptions about unknown fields causing runtime failure.
- Keep Skill and MCP as different capability types even if both enter through the
  same CapabilityProvider. MCP can execute external processes and needs stronger
  configuration and entitlement handling.

## 3. MCP Architecture And Transport

Primary references:

- MCP architecture: https://modelcontextprotocol.io/docs/learn/architecture
- MCP transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

Relevant facts:

- MCP uses a host/client/server architecture. An AI application host connects to
  one or more MCP servers, with a dedicated client connection per server.
- Local stdio MCP servers are typically launched by the client as subprocesses.
- MCP stdio uses JSON-RPC over stdin/stdout. Servers must only write valid MCP
  protocol messages to stdout; stderr may be used for logs.
- MCP also supports Streamable HTTP, but local stdio is the simpler MVP shape for
  a container sandbox.

Design implications for this project:

- MVP should support local stdio MCP only.
- MCP server binaries/config should be platform-managed resources mounted under
  `/opt/agent/mcp`, not arbitrary user-provided host paths.
- Admin/user UI should not accept arbitrary command strings for runtime execution.
  Store MCP resources in a resource pool, then resolve them to vetted runtime specs.
- MCP config must support env/secret references eventually, but raw secrets should
  not be stored in plain agent capability config or exposed to the frontend.
- MCP entitlement in MVP should control who can configure a server onto an Agent.
  Per-tool runtime authorization can remain out of scope and be handled by tool
  approval/sandbox/MCP-specific behavior.

## 4. Agent / Conversation / Run Separation

Primary reference:

- OpenAI Assistants-to-Responses migration guide: https://developers.openai.com/api/docs/assistants/migration

Relevant facts:

- The old Assistants model separated assistants, threads, and runs.
- The migration guide describes threads as server-side message collections.
- It describes runs as asynchronous processes that execute against threads.
- The newer model moves toward prompt/configuration objects, conversations that
  store context/items, and responses that execute work.

Design implications for this project:

- Do not collapse every long-lived concept into `chatId` forever.
- Our Agent should be the long-lived work member: identity, profile, workspace,
  configured capabilities, and runtime policy.
- Conversation should become the interaction/history container under an Agent.
  In the MVP, one Agent can still map to one current conversation for continuity.
- Runtime session should represent an execution/run state: container lifecycle,
  Claude session id, SDK init, events, approvals, and resume mode.
- Current code can continue using `chatId` as an interim `agentId`, but new docs
  must call this out as a compatibility bridge, not the target model.

## 5. Control Plane / Data Plane Separation

Primary reference:

- Kubernetes components: https://kubernetes.io/docs/concepts/overview/components/

Relevant facts:

- Kubernetes separates a control plane that manages desired cluster state from
  node components that run workloads.
- The API server exposes the control-plane API. Persistent state is stored in etcd.
- Schedulers/controllers observe desired state and reconcile actual runtime state.
- Node components run containers and maintain runtime execution.

Design implications for this project:

- Model Agent, capability, entitlement, runtime policy, and workspace binding as
  control-plane state.
- Model Docker containers, Claude SDK query execution, tool calls, files written
  during execution, and SDK events as data-plane/runtime behavior.
- `CapabilityProvider.resolve()` is the main control-to-data-plane bridge.
- Admin/UI APIs should mutate declarative intent: Agent config, capability
  activation, entitlements, runtime policy.
- Runtime startup should consume a resolved snapshot: SDK options, mounts, env,
  and policy. Do not let the frontend directly pass `tools`, `plugins`, or
  `mcpServers` into runtime creation.
- Runtime changes should generally apply on new runtime creation/restart, not by
  hot-patching a running container in MVP.

## 6. Consolidated Design Principles

1. Agent-first: the long-lived product object is the Agent instance, not a chat.
2. Runtime is replaceable: containers can stop, restart, and resume; they are not
   the Agent identity.
3. Capabilities are enterprise resources: Skill/MCP resources live in a managed
   resource pool, not inside a single Agent.
4. Entitlement controls configuration: MVP answers who can attach Skill/MCP to an
   Agent, not per-call dynamic authorization.
5. Activation is per Agent: an Agent stores which entitled capabilities it has
   enabled.
6. Resolution is snapshot-based: runtime starts from a resolved CapabilityBundle.
7. Native compatibility matters: Skills should remain Claude Code plugins/skills;
   MCP should remain MCP server config, not a custom replacement.
8. Current code continuity matters: keep `CapabilityProvider`, `DockerAgentRuntime`,
   `ContainerManager`, `Session`, `FileWorkspaceService`, and `eventStore` as the
   migration backbone.

## 7. References To Use In New Docs

Use this mapping when writing the next documents:

- PRD: cite Agent-first principle, capability resource pool, entitlement as
  configuration control, and MVP non-goals.
- Domain model: cite Agent / Conversation / Runtime separation.
- Configuration-plane design: cite control plane/data plane and
  `CapabilityProvider.resolve()` as the southbound runtime bridge.
- Skill/MCP module design: cite Claude Code plugin/skill structure and MCP stdio
  subprocess model.
- Migration plan: cite current `chatId` as interim `agentId` compatibility bridge.
