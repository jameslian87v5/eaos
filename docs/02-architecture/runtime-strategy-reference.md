# Runtime Strategy Reference

> Status: reference  
> Scope: runtime orchestration boundary for local, Docker, and future remote/K8s
> execution modes. This is a design reference, not an immediate implementation
> requirement.

## Purpose

The project currently has working `local` and `docker` runtime paths. The next
architecture step is not to replace them, but to give them a common strategy
boundary so future runtime modes can be added without spreading mode-specific
branches through `server.ts`, `Session`, and capability resolution.

This boundary should preserve the current rule:

```text
control plane declares intent
CapabilityProvider.resolve() creates a runtime-ready CapabilityBundle
runtime strategy consumes that bundle
runtime implementation executes it
```

Runtime implementations must not query capability resources, entitlement files,
Skill/MCP registries, or frontend-supplied runtime options directly.

## Runtime Modes

### Current Modes

- `local`: runs the Claude Agent SDK inside the Node server process through the
  local `AgentRuntime` implementation. It is useful for development and low
  isolation scenarios. Isolation = L1 software-layer path guard + control-plane
  parity; **no MCP in local**. See
  [ADR-002](adrs/002-local-runtime-isolation.md) and
  `docs/开发计划/local-mode-security-isolation-plan.md`.
- `docker`: runs one isolated container per Agent/chat compatibility id. It uses
  workspace and Claude home volumes, WebSocket IPC, cold resume, approval hooks,
  and `CapabilityBundle` mounts/env/sdk options.

### Future Modes

- `k8s`: runs Agent runtimes as Kubernetes workloads. This is a deployment
  technology, not a new product model.
- `remote`: delegates runtime creation, messaging, status, and shutdown to an
  external Runtime service or worker fleet. The remote service may itself use
  Docker, Kubernetes, VM sandboxes, or another substrate.
- `pool`: allocates pre-warmed sandbox workers instead of creating a fresh
  container for every Agent.
- `subprocess`: starts isolated child processes on the host. This is useful for
  some development and lightweight deployments, but weaker than Docker for
  workspace isolation.

Only `local` and `docker` are required for the current MVP.

## Strategy Boundary

The recommended TypeScript shape is intentionally small:

```ts
type RuntimeMode = "local" | "docker" | "k8s" | "remote";

interface RuntimeCreateContext {
  userId: string;
  agentId: string; // chatId compatibility id during migration
  role: "admin" | "user";
  runtimeType: RuntimeMode;
}

interface RuntimeStrategy {
  mode: RuntimeMode;
  create(ctx: RuntimeCreateContext): Promise<AgentRuntime>;
  stop(ctx: RuntimeStopContext): Promise<void>;
  getStatus(ctx: RuntimeStatusContext): RuntimeStatus;
}
```

The first implementation should keep behavior unchanged:

- `LocalRuntimeStrategy` wraps the existing `createLocalRuntime` path.
- `DockerRuntimeStrategy` wraps the existing `ContainerManager` and
  `DockerAgentRuntime` path.
- `RuntimeManager` selects the strategy by configured runtime mode.

`server.ts` should eventually call the manager rather than branching on
`RUNTIME_MODE` directly.

## Lifecycle Semantics

Every runtime mode should be expressible through the same coarse lifecycle:

```text
starting -> running -> idle -> stopping -> stopped
                    \-> failed
```

Common operations:

- `ensure/create`: start a runtime or reconnect/reuse one if possible.
- `sendMessage`: pass user input into the runtime.
- `subscribe`: attach a client or server-side event consumer.
- `health`: determine whether the runtime is usable.
- `stop`: stop execution while preserving product state where appropriate.
- `delete`: remove runtime resources tied to an Agent deletion.
- `status`: report user/admin-visible state.
- `cleanup`: stop idle runtimes according to policy.

The current Docker implementation already covers much of this through
`ContainerManager`, but the semantics are Docker-shaped. A strategy boundary
should make the common operations explicit before adding K8s or remote workers.

## Reference: openJiuwen Agent Runtime

`openJiuwen/agent-runtime` is a useful reference for the strategy pattern, not a
drop-in dependency for this project.

Relevant ideas:

- `DeploymentManager` owns the high-level deploy/list/detail/delete flow.
- `BaseDeploymentStrategy` centralizes common lifecycle state transitions.
- `SubprocessStrategy`, `DockerStrategy`, and `K8sStrategy` isolate substrate
  details.
- Per-mode deployers handle process, Docker, or K8s mechanics behind a common
  manager API.
- Deployment records include id, status, URL, tenant context, and mode-specific
  details.

What not to adopt directly:

- Python FastAPI `/query` and SSE protocol. This project uses browser WebSocket
  to Node, then Claude Agent SDK event streams.
- Low-code IR/WHL deployment. This project resolves Claude Code native Skills
  and local MCP packages into a `CapabilityBundle`.
- Direct replacement of `ContainerManager` or `DockerAgentRuntime`. They already
  implement workspace volumes, Claude home volumes, WebSocket IPC, approval
  hooks, and cold resume.
- A Python runtime server dependency during the current MVP migration.

## Recommended Migration Timing

Do not insert this as Phase 2e. Phase 2e is prompt configuration.

Treat Runtime Strategy as optional architecture hardening after the Phase 2d
resolution bridge and Phase 4 diagnostics are stable. It should not block MP3 or
MP4 completion.

The first implementation should be a behavior-preserving refactor:

1. Introduce `RuntimeStrategy` and `RuntimeManager`.
2. Move the current local/docker runtime selection out of `server.ts`.
3. Keep `ContainerManager` as the Docker implementation detail.
4. Keep `CapabilityProvider.resolve()` as the only configuration-to-runtime
   bridge.
5. Add tests proving local and Docker strategy selection preserves existing
   startup options.

Remote or K8s execution should be added later as new strategies, not as changes
to `Session` or capability resolution.
