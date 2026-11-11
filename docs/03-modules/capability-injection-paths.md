# Capability Injection Paths

> Status: draft
> Scope: operational reference for how future capabilities and configuration are
> injected into an Agent runtime.
> Related: `docs/02-architecture/configuration-plane-interface-design.md`,
> `docs/03-modules/skill-injection-mechanism.md`,
> 内部迁移文档（未随开源发布）.

## 1. Purpose

This document explains the end-to-end path for the four kinds of future
additions to a running Agent platform:

1. API injection (external API access)
2. New Skill/tool injection
3. Environment dependency adjustment
4. Prompt configuration

All four flow through one shared pipeline. The differences are only the
injection point and the cost.

## 2. Shared Pipeline

Every capability and configuration reaches the container through one path.
There is no side channel.

```text
Control-plane config
   ↓
capabilityProvider.resolve(ctx)          server/capability-provider.ts
   ↓  produces CapabilityBundle { sdkOptions, mounts, env }
docker-runtime translates to container   server/docker-runtime.ts
   ↓  sdkOptions → AGENT_SDK_OPTIONS env var
   ↓  mounts     → bind mounts (readonly :ro)
   ↓  env        → container env vars (allowlisted)
agent-entry.ts re-validates path prefixes  docker/agent-entry.ts
   ↓
Claude Agent SDK query()
```

`CapabilityBundle` is the only object the data plane consumes:

```ts
interface CapabilityBundle {
  sdkOptions: {
    plugins?: Array<{ type: "local"; path: string }>;
    mcpServers?: Record<string, unknown>;
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    systemPrompt?: string;
    appendSystemPrompt?: string;
    additionalDirectories?: string[];
    maxTurns?: number;
  };
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
  env: Record<string, string>;
}
```

### Invariants

- The frontend/user never sets `tools`, `plugins`, or `mcpServers` directly.
  They declare intent in the control plane; `resolve()` translates it.
- Capability packages mount readonly under `/opt/agent/*`; `agent-entry.ts`
  re-validates the path prefix.
- Capability and prompt changes apply on new runtime creation/restart. Running
  containers are not hot-patched.
- The only exception is base-image dependencies (see §5, L1), which live outside
  this pipeline.

## 3. Path A: API Injection (external API access)

Integrating an external API is not adding HTTP-call code. It is registering an
MCP server that wraps the API and exposes it as tools.

```text
1. Register   MCP resource into the pool (mcp/<id>/, data/mcp.json)
2. Entitle    who may configure this API capability
              (high-risk → explicit user-scope grant)
3. Activate   Agent enables the MCP
4. Resolve    resolve() emits:
                sdkOptions.mcpServers[name] = { command: "/opt/agent/mcp/<id>/run" }
                mounts.push(/opt/agent/mcp/<id> :ro)
                env: credentials via bundle.env (allowlisted, not persisted plain)
5. Run        agent-entry validates command under /opt/agent/mcp/
              SDK spawns stdio MCP subprocess → exposes tools → default approval
```

Credentials travel through the env channel only. They are not stored in
`data/mcp.json` and are not returned to the frontend.

> Note: if "API injection" means an external system calling the platform Agent
> (embed/widget), that uses the message API `surface` context path, not this MCP
> path. See the Surface Context Boundary section in the migration plan.

## 4. Path B: New Skill/Tool Injection

The lightest path. Pure document/instruction injection, no subprocess.

> MVP decision (hybrid scheme): Skills use the Claude Code **native plugin**
> layout and are injected via the `plugins` option + readonly mount, with the
> SDK `skills` option carrying the entitlement-gated skill name list to enable
> the `Skill` tool (replacing the deprecated `allowedTools: ["Skill"]` practice).
> **Entitlement enforcement comes from mount-level physical isolation**, not from
> the `skills` option — `skills` is "a context filter, not a sandbox" (unlisted
> skills still exist on disk, reachable via Read/Bash), so only by not mounting
> unentitled plugins can we guarantee deny-default. The `skills` option's role is
> to turn skills on per SDK design intent, not to serve as the security gate.
> See `docs/03-modules/skill-injection-mechanism.md` §2.6.

```text
1. Register   Skill resource into the pool (skills/<plugin>/, data/skills.json)
              must be native Claude Code plugin/skill layout
              (a future installer can wrap a bare SKILL.md into this layout —
               see skill-injection-mechanism.md §5.5)
2. Entitle    low-risk doc skills → org default allow
3. Activate   Agent enables the Skill
4. Resolve    resolve() emits:
                sdkOptions.plugins.push({ type:"local", path:"/opt/agent/plugins/<name>" })
                mounts.push(/opt/agent/plugins/<name> :ro)
                appendSystemPrompt += skill manifest
5. Run        agent-entry validates prefix → SDK native plugin discovery
```

Adding a built-in tool (not a Skill, e.g. a new Read/Bash-class tool) is a
platform-level change to the tool profile allowlist, not a per-Agent action.

### Agent self-authored skills (future)

An Agent can write its own `SKILL.md` into its writable workspace and
self-discover it — this needs no control-plane involvement and any scheme
supports it. The control-plane boundary is at *publishing* (promoting a private
draft into the shared resource pool), not at *authoring*. Publishing crosses the
host boundary by definition (`skills/` is a readonly mount; `data/skills.json`
lives in the control plane), so an in-container Agent cannot self-publish. This
two-tier model is documented in `skill-injection-mechanism.md` §5.4 and deferred
to migration Phase 6.

## 5. Path C: Environment Dependency Adjustment

"Environment dependency" is three layers with very different cost. Identify the
layer before changing anything.

| Layer | What changes | Path | Scope | Cost |
| --- | --- | --- | --- | --- |
| L1 image base deps | `docker/Dockerfile` (python3/node/system pkgs) | edit Dockerfile → rebuild agent image | all Agents | heavy |
| L2 runtime env vars | `CapabilityBundle.env` | resolve → container Env | one Agent, new runtime | light |
| L3 workspace-local deps | `node_modules`/`.venv`/`.cache` | Agent installs into `/workspace` at runtime | one Agent, persisted in volume | medium |

Decision rule:

- generic, heavy, needed by all Agents → L1 image
- credentials, connection strings, feature flags → L2 env
- task-specific or version-varying deps → L3 workspace

Prefer L3 > L2 > L1. The closer to the workspace, the more isolated and the less
it requires an image rebuild. The system prompt already steers Agents to install
runtime deps under `/workspace`.

## 6. Path D: Prompt Configuration

Today the prompts are hard-coded constants in `capability-provider.ts`
(`DEFAULT_SYSTEM_PROMPT`, `DEFAULT_APPEND_SYSTEM_PROMPT`, plus the dynamic skill
manifest from `buildAppendSystemPrompt`). Prompt configuration should become a
config item, following the same file-backed pattern as `runtime-settings.ts`.

### Three prompt layers

```text
L1 platform default   data/prompt-settings.json
                      base systemPrompt + appendSystemPrompt
                      (replaces the current hard-coded constants)

L2 per-Agent profile  Agent Profile.systemPrompt / appendSystemPrompt
                      (maps to the domain-model Agent Profile)
                      optional override per Agent

dynamic layer         skill manifest, computed at resolve() time
                      (buildAppendSystemPrompt) — NOT user-editable
```

### Composition at resolve()

```text
final.systemPrompt =
    agentProfile.systemPrompt ?? platformDefault.systemPrompt

final.appendSystemPrompt =
    platformDefault.appendBase
  + agentProfile.appendOverride        (optional)
  + dynamicSkillManifest               (always last, system-owned)
```

The dynamic skill manifest is always appended last and is owned by the platform,
so user-supplied prompt text cannot remove or spoof the capability listing.

### Recommended config shape

Mirror `runtime-settings.ts`: file-backed, cached, validated.

```jsonc
// data/prompt-settings.json
{
  "systemPrompt": "...",        // platform default persona/role
  "appendBase": "...",          // workspace rules, path conventions
  "maxSystemPromptChars": 8000  // validation bound
}
```

### Validation and effect rules

- Validate length bounds (reject oversized prompts).
- Strip or reject control characters.
- Per-Agent overrides require ownership; admin-bypass applies as elsewhere.
- Prompt changes apply on new runtime only, consistent with other capability
  changes.

### MVP staging

- MVP step 1: move the hard-coded constants into `data/prompt-settings.json`
  via a `prompt-settings.ts` module. Behavior is unchanged until edited.
- MVP step 2: expose platform default editing in the Admin Console.
- Later: per-Agent prompt override as part of Agent Profile, after the Agent
  semantic layer (Phase 1) is stable.

## 7. Summary

All paths share one shape:

```text
register (pool) → entitle → activate (agent) → resolve (→ Bundle) → run (docker → SDK)
```

- All go through `resolve()`; the frontend cannot bypass it.
- All capability packages mount readonly under `/opt/agent/*` with prefix
  re-validation.
- All apply on new runtime, not by hot-patching.
- The only out-of-pipeline case is L1 base-image dependencies, which require an
  image rebuild and affect every Agent.
