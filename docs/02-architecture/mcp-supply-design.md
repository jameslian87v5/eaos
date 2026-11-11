# MCP Supply Design (Platform-Managed, outside iflytek Skill Hub)

> **Status: current authority for platform MCP server supply.** This design
> governs the MCP-server resource pool that the platform itself owns and
> operates. It is **distinct from** and **outside** the iflytek Skill Hub
> integration (`docs/06-deployment/skillhub-r5b2-contract-forensics.md`),
> which supplies **skills** (native-plugin packages), not platform MCP
> servers. No speculative Hub UI or Hub API is assumed here. Of the
> lifecycle stages, **register / distribute / disable / inject are
> implemented** today; **review and a dedicated MCP audit trail are target
> gaps** (§3), not current — the design does not claim MCP servers are
> reviewed or audited as a present fact. The Hub plays no role in MCP supply.

## 1. Scope and non-goals

**In scope:** the lifecycle of a platform MCP server — a long-running local
subprocess that exposes tools/resources to an agent via the MCP protocol,
mounted into a runtime as `/opt/agent/mcp/<name>` and emitted to the SDK via
`sdkOptions.mcpServers`.

**Non-goals (explicit):**
- **No speculative Hub UI / Hub API.** The superseded
  `docs/03-modules/skill-hub-interface-contract.md` (`X-Hub-Key`,
  `/api/hub/*`) is NOT an MCP supply path and must not be revived as one.
  The Hub supplies skills; MCP supply is platform-local.
- **No per-org MCP directory.** Consistent with the shared-pool + entitlement
  model (CLAUDE.md 多租户铁律), the MCP pool is a shared platform pool;
  `data/mcp.json` records carry **no `org_id`**. org visibility/authorization
  is the entitlement overlay (Phase 7.3), not a per-org directory.
- **No front-end / user direct control.** Front-end / users NEVER set
  `mcpServers` / host paths / Docker options directly (capability-provider
  铁律). They declare intent to the control plane; `CapabilityProvider.resolve`
  translates.

## 2. Resource model

An MCP server entry (`data/mcp.json`, `McpConfigEntry`) has exactly:
`{name, type:"local", enabled, path, description?}`. `name` is the identity
in the shared pool; `path` is a project-relative path under `mcp/`
(realpath-validated against the `mcp/` root). **There is no `command`,
`args`, or `env` field on the entry** — the entry carries no executable
shape and no environment.

The resolved form (`ResolvedMcpServer extends McpConfigEntry`) adds:
`containerPath = /opt/agent/mcp/<name>`, `command = /opt/agent/mcp/<name>/run.sh`
(**backend-generated, never read from config**), `args: []` (reserved;
MVP has no per-server args), `absolutePath`, `version?`. The platform
synthesizes the `run.sh` launcher from trusted `name`; config supplies no
shell, no args, no env. This resolved shape is the only thing the data
plane consumes.

## 3. Lifecycle boundaries (control plane vs data plane)

| Stage | Owner | Boundary |
|---|---|---|
| **Registration** | platform admin (admin-only) | admin installs an MCP server into the shared pool via `a3-capability-installer`; `name` collision/shape validated by `mcp-config.ts`. org_admin **cannot** install (writes the shared pool → affects all orgs). |
| **Review** | platform admin (target boundary; current gap) | **Target:** admin reviews an entry before it is enabled. **Current gap:** the installer (`capability-installer.ts`) derives `enabled` directly from the upstream API `status === "active"` (`upsertMcpConfig`); there is **no separate MCP review state, review action, or MCP-specific audit trail** today. A dedicated review/audit step for MCP is a target boundary, not an implemented fact. |
| **Publish / distribute** | platform control plane | distribution = the shared `data/mcp.json` is the single source; runtimes consume the resolved form via `CapabilityProvider.resolve`. There is no separate "publish" step to a marketplace — the pool IS the distribution. |
| **Disable** | platform admin (global) / org_admin (own-org entitlement only) | admin toggles `enabled` globally (`setMcpServerEnabled`); org_admin can only narrow via own-org entitlement (deny-by-intersection), never widen. |
| **Audit** | governance audit log (general; no MCP-specific trail) | install/enable/disable flow through the platform's general governance audit (metadata-only: actor/role/org/object/result/reason-summary). There is **no MCP-dedicated audit trail** today; "review" is not an audited MCP action (it is a gap, §3 Review row). |
| **Runtime injection** | `CapabilityProvider.resolve` (the bridge) | resolve merges `app allowlist ∩ entitlement ∩ agent activation` (deny-by-intersection) → emits `sdkOptions.mcpServers` (resolved container paths) + `strictMcpConfig:true` (always). |

## 4. Governance guards (铁律 — cannot be widened by app/hook/org_admin)

- **deny-default**: an MCP server not explicitly entitled+activated is NOT
  injected. No implicit grant.
- **`/opt/agent/mcp/` prefix**: `agent-entry.ts` enforces that the
  **backend-generated resolved `command`** (`/opt/agent/mcp/<name>/run.sh`,
  produced by `resolve` from trusted `name`) starts with `/opt/agent/mcp/`
  (data-plane guard, runs in the container). There is no config-supplied
  command to reject — the entry carries no `command` field (§2); the only
  `command` is the one the platform itself generated.
- **`strictMcpConfig: true` (always)**: the SDK uses ONLY the `mcpServers`
  emitted by `resolve`; a planted `/workspace/.mcp.json` or project-level
  discovery cannot bypass the control plane.
- **Backend-generated launcher**: `run.sh` is synthesized by the platform
  from trusted `name`; config carries **no** `command`/`args`/`env` to
  inject (the entry has none), so no free-form shell can be planted.
- **Metadata-only audit**: audit records the action + categorical reason,
  NEVER `env` secrets, request/response payloads, or tokens.
- **Admin-only install/global-enable**: writes the shared pool → admin-only.
  org_admin own-org entitlement is the only org-scoped write, and it can only
  narrow (deny-by-intersection), never widen above the global pool.

## 5. Runtime injection flow (data plane)

> MCP subprocesses run **only inside the Docker runtime**. The launcher
> (`/opt/agent/mcp/<name>/run.sh`) and its mount exist in the agent
> container. The **local runtime** (`LocalAgentRuntime`, in-process
> `AgentSession`) intentionally receives **no `mcpServers`** — MCP server
> processes are a Docker-runtime capability, not an in-process one.

```
CapabilityProvider.resolve(ctx)
  → read shared pool (getEnabledMcpServers)
  → apply app allowlist (Phase 6 上界)
  → apply entitlement overlay (org-scoped, deny-by-intersection)
  → apply agent activation (per-agent)
  → for each surviving entry: ResolvedMcpServer { containerPath, command=/opt/agent/mcp/<name>/run.sh, args:[] }
  → emit sdkOptions.mcpServers (Docker runtime only) + strictMcpConfig:true
  → DockerAgentRuntime mounts /opt/agent/mcp/<name>:ro into the container
  → agent-entry.ts enforces /opt/agent/mcp/ prefix + strictMcpConfig
  → SDK query() spawns the MCP subprocess (local to the container, sandboxed)
```

Every layer can only NARROW; deny-wins on any intersection miss. The local
runtime path does not emit `mcpServers` at all.

## 6. Relationship to iflytek Skill Hub (explicit non-overlap)

- The Hub (forensics `docs/06-deployment/skillhub-r5b2-contract-forensics.md`)
  supplies **skills** (native-plugin packages, R5b-2 verified-live CLI
  routes). It does NOT supply platform MCP servers.
- R5c round-6 live-verified that the Hub's member/freeze routes are
  M2M-excluded (HTTP 403 `unsupported(path)` from `ApiTokenScopeFilter`,
  SUPER_ADMIN-session-only). That boundary concerns Hub member sync, not MCP
  supply; MCP supply has no Hub dependency and is unaffected.
- A future "skill that wraps an MCP server" is a skill-package concern
  (R5b-2 repackage path), not a change to this MCP supply design: the MCP
  server itself still flows through §3 above.

## 7. Backlog (non-speculative, platform-local)

- Dedicated MCP review/audit step (today `enabled` is derived from upstream
  API `status === "active"` with no separate MCP review state or audit — see
  §3; a real review + metadata-only audit trail is a target boundary, not a
  Hub item).
- Per-org MCP entitlement UI (admin surfaces own-org + cross-org views;
  already covered by Phase 7.3 entitlement overlay, no new directory).
- MCP subprocess resource limits (cpu/mem caps at the container level, not
  a Hub concern).

No item in §7 assumes a Hub UI or Hub API. If a future Hub version adds an
MCP-supply surface, it must be live-verified (R5b-2 forensics pattern)
before this design references it.
