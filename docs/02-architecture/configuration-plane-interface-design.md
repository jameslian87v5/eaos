# Configuration Plane Interface Design

> Status: draft  
> Scope: northbound/east-west/southbound configuration interfaces for the
> Agent-first enterprise MVP.  
> Related: `docs/00-product/agent-first-enterprise-prd.md`,
> `docs/01-domain/agent-platform-domain-model.md`,
> `docs/02-architecture/external-alignment-reference.md`.

## 1. Purpose

The configuration plane turns enterprise intent into runtime-ready Agent
capabilities.

It answers:

- what Agents exist;
- which interaction surface is calling the Agent;
- which Skill/MCP resources are registered;
- who can configure those resources;
- which resources are enabled on an Agent;
- what runtime snapshot should be injected into Docker/Claude SDK.

It must prevent frontend or user input from directly controlling Docker mounts,
host paths, process commands, `tools`, `plugins`, or `mcpServers`.

## 2. Plane Separation

### Control Plane

Stores desired configuration:

```text
Agent definition
Agent profile
Workspace binding
Capability resources
Capability entitlements
Agent capability activations
Runtime policy
```

### Data Plane

Executes work:

```text
Docker runtime
Claude Agent SDK query()
Claude Code plugin/skill discovery
MCP server subprocesses
Tool calls
File reads/writes
SDK/runtime events
```

### Bridge

`CapabilityProvider.resolve()` is the southbound bridge from control-plane state
to data-plane runtime snapshot.

## 3. Interface Directions

```text
Northbound:
  UI/API -> configuration services

East-West:
  internal service-to-service interfaces

Southbound:
  runtime manager -> CapabilityProvider -> Docker/SDK
```

## 4. Northbound Interfaces

Northbound APIs mutate or read declarative state. They do not accept runtime
execution specs directly.

The first-party chat/workbench and future embedded widgets should use the same
Agent-facing API semantics. The surface may provide identity and page/business
context, but it must not provide raw Docker, Claude SDK, Skill path, MCP command,
or mount configuration.

### Agent APIs

Target API shape:

```text
GET    /api/agents
POST   /api/agents
GET    /api/agents/:agentId
PATCH  /api/agents/:agentId
DELETE /api/agents/:agentId
```

MVP compatibility:

```text
current /api/chats can remain internally
UI/product language may present them as Agents
```

Create request:

```ts
type CreateAgentRequest = {
  name: string;
  description?: string;
  profileId?: string;
  initialCapabilityIds?: string[];
};
```

Validation:

- authenticated user required;
- `initialCapabilityIds` must pass entitlement;
- no host paths, Docker options, or SDK raw options accepted.

### Agent Message APIs

Target API shape:

```text
POST /api/agents/:agentId/messages
```

MVP compatibility:

```text
current /api/chats/:chatId/messages can remain internally
```

Request:

```ts
type SendAgentMessageRequest = {
  message: string;
  surface?: AgentSurfaceContext;
};

type AgentSurfaceContext = {
  surfaceType: "workbench" | "embed" | "h5" | "system-panel";
  host?: {
    appId?: string;
    origin?: string;
    route?: string;
  };
  businessContext?: {
    objectType?: string;
    objectId?: string;
    title?: string;
    selectedText?: string;
    metadata?: Record<string, string | number | boolean>;
  };
};
```

Rules:

- first-party workbench may omit `surface`;
- embedded surfaces must use short-lived server-signed identity/context later;
- production embed must validate `Origin` against an Agent/embed configuration
  allowlist;
- server normalizes and filters surface context before passing it to the Agent;
- surface context is request context, not capability configuration;
- surface context is request-scoped and should not be persisted into message or
  event history by default;
- `businessContext.objectType` must be allowlisted server-side; unknown values
  are stripped or rejected;
- `businessContext.metadata` is limited to at most 16 keys, with each string
  value limited to 512 bytes after normalization;
- external context does not bypass Agent ownership, entitlement, approval, or
  runtime policy.

### Future Embed APIs

Not MVP implementation, but reserved interface direction:

```text
POST /api/embed/sessions
GET  /embed/agents/:agentId
```

Purpose:

- create a short-lived embedded conversation session;
- validate signed host identity and allowed origin;
- bind host page/business context to a normal Agent message request;
- render the platform-provided embedded Agent conversation window.

The initial MVP should not build a production iframe/widget SDK. It should only
avoid coupling the Agent runtime path to the first-party chat page.

Security placeholders for future implementation:

- embed tokens must be server-signed and short-lived;
- embed sessions must bind `agentId`, host app id, user identity, allowed origin,
  and expiry;
- host-supplied business references are hints until a server-side integration
  adapter verifies them.

### Agent Capability APIs

```text
GET /api/agents/:agentId/capabilities
PUT /api/agents/:agentId/capabilities
```

Request:

```ts
type UpdateAgentCapabilitiesRequest = {
  resources: Array<{
    resourceId: string;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
};
```

Rules:

- caller must own the Agent or be admin;
- each resource must be entitled for the caller/org;
- per-resource config must validate against the resource schema;
- changes apply only to new runtime after stop/restart.

Response:

```ts
type AgentCapabilityView = {
  resourceId: string;
  type: "skill" | "mcp";
  name: string;
  version?: string;
  enabled: boolean;
  entitled: boolean;
  available: boolean;
  status: "active" | "disabled" | "deprecated" | "invalid";
  unavailableReason?: string;
};
```

### Capability Resource Admin APIs

```text
GET  /api/admin/capabilities
POST /api/admin/capabilities/skills/import-local
POST /api/admin/capabilities/mcp/register-local
PATCH /api/admin/capabilities/:resourceId
```

Skill local import request:

```ts
type ImportLocalSkillRequest = {
  name: string;
  path: string; // relative path under project skills/ in MVP
};
```

MCP local registration request:

```ts
type RegisterLocalMcpRequest = {
  name: string;
  path: string; // relative path under managed mcp/ root in MVP
  description?: string;
};
```

Do not accept arbitrary executable commands from frontend. MCP runtime command is
derived from the validated resource package/spec.

### Entitlement Admin APIs

```text
GET /api/admin/capabilities/:resourceId/entitlements
PUT /api/admin/capabilities/:resourceId/entitlements
```

Request:

```ts
type UpdateCapabilityEntitlementsRequest = {
  entries: Array<{
    scopeType: "org" | "user";
    scopeId: string;
    effect: "allow" | "deny";
  }>;
};
```

MVP:

- org and user scopes only;
- admin-only.

### Runtime Diagnostics APIs

Already exists directionally:

```text
GET /api/chats/:id/runtime
GET /api/admin/containers
```

Target:

```text
GET /api/agents/:agentId/runtime
GET /api/admin/runtimes
```

Diagnostics should show:

- configured capabilities;
- resolved capabilities if snapshot exists;
- SDK discovered skills/plugins;
- runtime status;
- last error;
- restart/restore mode.

## 5. East-West Internal Interfaces

### AgentService

Owns Agent CRUD and ownership checks.

```ts
interface AgentService {
  createAgent(ctx: RequestContext, input: CreateAgentInput): Agent;
  getAgent(ctx: RequestContext, agentId: string): Agent | null;
  listAgents(ctx: RequestContext): Agent[];
  updateAgent(ctx: RequestContext, agentId: string, input: UpdateAgentInput): Agent;
  assertCanAccess(ctx: RequestContext, agentId: string): Agent;
}
```

MVP can be a thin wrapper over `chatStore`.

### CapabilityResourceService

Owns resource pool registration and validation.

```ts
interface CapabilityResourceService {
  listResources(ctx: RequestContext, filter?: CapabilityFilter): CapabilityResourceView[];
  importLocalSkill(ctx: RequestContext, input: ImportLocalSkillInput): CapabilityResource;
  registerLocalMcp(ctx: RequestContext, input: RegisterLocalMcpInput): CapabilityResource;
  getResource(resourceId: string): CapabilityResource | null;
  validateResource(resourceId: string): ValidationResult;
}
```

Initial implementation can adapt existing `skill-config.ts` for Skill resources.

### EntitlementService

Controls configuration authorization.

```ts
interface EntitlementService {
  canConfigure(ctx: RequestContext, resourceId: string): boolean;
  listEntitledResources(ctx: RequestContext, type?: "skill" | "mcp"): CapabilityResource[];
  setEntitlements(ctx: RequestContext, resourceId: string, entries: EntitlementEntry[]): void;
}
```

MVP rule:

- admin can configure all;
- normal users can configure resources allowed by org/user entitlement.
- initial implementation may be a small file-backed module over
  `data/entitlements.json` or resource-local `allowedUsers`; it does not require
  a dedicated class or database table until a real non-admin multi-user workflow
  proves the need.

### AgentCapabilityService

Stores per-Agent activation.

```ts
interface AgentCapabilityService {
  listAgentCapabilities(ctx: RequestContext, agentId: string): AgentCapabilityView[];
  updateAgentCapabilities(
    ctx: RequestContext,
    agentId: string,
    input: UpdateAgentCapabilitiesInput
  ): AgentCapabilityView[];
  resolveEnabledResourceIds(ctx: RequestContext, agentId: string): string[];
}
```

### CapabilityProvider

Permanent southbound interface.

Current code already has this boundary. It should evolve from global default
resolution to Agent-scoped resolution.

```ts
interface CapabilityResolveContext {
  orgId: string;
  userId: string;
  agentId: string;
  workspaceId?: string;
  profileId?: string;
  runtimeType: "local" | "docker";
}

interface CapabilityProvider {
  resolve(context: CapabilityResolveContext): CapabilityBundle;
  getDefaultProfile(): ToolProfile;
  listProfiles(): ToolProfile[];
}
```

## 6. Southbound Runtime Contract

`CapabilityBundle` is the only object Docker runtime needs for capability
injection.

```ts
type CapabilityBundle = {
  sdkOptions: {
    plugins?: Array<{ type: "local"; path: string }>;
    mcpServers?: Record<string, McpServerConfig>;
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    systemPrompt?: string | {
      type: "preset";
      preset: "claude_code";
      append?: string;
    };
    appendSystemPrompt?: string;
    additionalDirectories?: string[];
    maxTurns?: number;
  };
  mounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>;
  env: Record<string, string>;
  resolvedResources?: Array<ResolvedCapabilityResource>;
};
```

Resolved resource metadata:

```ts
type ResolvedCapabilityResource = {
  resourceId: string;
  type: "skill" | "mcp";
  name: string;
  version?: string;
  containerPath?: string;
  status: "resolved" | "skipped";
  reason?: string;
};
```

Runtime contract:

- Docker runtime consumes `sdkOptions`, `mounts`, and `env`.
- Docker runtime does not query Skill/MCP config directly.
- Runtime startup logs or persists the resolved snapshot for diagnostics later.
- Existing running containers are not hot-patched in MVP.

### Runtime Strategy Boundary

`CapabilityProvider.resolve()` is the southbound configuration bridge. The next
runtime boundary should be a small strategy layer that consumes the resolved
`CapabilityBundle` and starts the selected execution substrate.

The project currently needs only `local` and `docker`, but the boundary should
leave room for future `remote`, `k8s`, `pool`, or `subprocess` runtimes without
spreading mode-specific branches through `server.ts` and `Session`.

Rules:

- runtime strategies consume resolved bundles; they do not query control-plane
  resources directly;
- `DockerRuntime` remains an implementation detail behind a Docker strategy;
- remote/K8s are future strategies, not Phase 2 requirements;
- this boundary must not change the bundle shape consumed by Docker.

See `runtime-strategy-reference.md` for the reference design and the comparison
to `openJiuwen/agent-runtime`.

## 7. Skill Resolution

Input:

```text
active Skill resources
enabled on Agent
entitled for org/user
valid native Claude Code plugin layout
```

Output:

```ts
sdkOptions.plugins.push({
  type: "local",
  path: "/opt/agent/plugins/<resource-name>"
});

mounts.push({
  hostPath: "<validated host plugin path>",
  containerPath: "/opt/agent/plugins/<resource-name>",
  readonly: true
});
```

Validation:

- resource path must remain under managed Skill root;
- plugin path must contain Claude Code native plugin/skill structure;
- static scan results are `declaredSkills`;
- runtime SDK init results are `discoveredSkills`.

## 8. MCP Resolution

MVP supports local stdio MCP only.

Input:

```text
active MCP resources
enabled on Agent
entitled for org/user
validated local package under managed MCP root
```

Recommended MVP package shape:

```text
mcp/<mcp-id>/
  mcp.json
  run
  ...
```

`run` should be a platform-vetted executable wrapper under `/opt/agent/mcp/<mcp-id>/run`.

Output:

```ts
sdkOptions.mcpServers[resource.name] = {
  type: "stdio",
  command: "/opt/agent/mcp/<mcp-id>/run",
  args: [],
  env: {
    // derived from safe config / secret refs
  }
};

mounts.push({
  hostPath: "<validated host mcp package path>",
  containerPath: "/opt/agent/mcp/<mcp-id>",
  readonly: true
});
```

Why wrapper command:

- avoids accepting arbitrary user-supplied command strings;
- aligns with the current container guard that allows commands under
  `/opt/agent/mcp/`;
- keeps interpreter details inside the managed package.

Future support can allow platform-vetted interpreter forms such as `node` with
script args under `/opt/agent/mcp`, but this should not be the first MVP shape.

## 9. Security Invariants

The configuration plane must enforce:

- frontend never passes raw SDK `plugins` or `mcpServers`;
- frontend never passes host paths;
- frontend never passes arbitrary MCP command strings;
- all resource host paths must resolve inside managed roots;
- readonly mounts for Skill/MCP packages;
- raw secrets are not stored in Agent capability config;
- entitlement controls configuration access;
- runtime approval/sandbox controls execution risk;
- capability changes apply on new runtime/restart.

## 10. Current Code Mapping

Current modules:

```text
capability-provider.ts
  Already the southbound resolver. Keep and evolve.

skill-config.ts
  Temporary local Skill registry. Later folds into CapabilityResourceService.

docker-runtime.ts
  Already consumes CapabilityBundle mounts/env/sdkOptions.

container-manager.ts
  RuntimeManager. Should keep receiving resolved runtime options, not query resources.

server.ts
  Current northbound APIs. Add Agent/Capability APIs gradually.

AdminPanel.tsx
  Current diagnostics UI. Extend toward Capability resource and entitlement views.
```

## 11. MVP Implementation Order

Recommended after docs approval:

1. Introduce Agent naming layer over current chats.
2. Introduce capability resource abstraction for current local skills.
3. Add org/user entitlement checks for configuration.
4. Add Agent capability activation, initially backed by simple data/DB storage.
5. Change `CapabilityProvider.resolve()` to use `{ agentId, userId, orgId }`.
6. Add local MCP resource shape and stdio wrapper resolution.
7. Surface configured/resolved/discovered state in Admin UI.

## 12. What Not To Build Yet

- full policy engine;
- team entitlements;
- remote Hub client;
- upload marketplace;
- runtime hot reload;
- per-MCP-tool dynamic authorization;
- arbitrary MCP command editor;
- complete agents/conversations table split before product model is validated.
