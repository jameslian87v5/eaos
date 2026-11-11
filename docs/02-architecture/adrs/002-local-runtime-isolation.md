# ADR-002: Local Runtime Isolation (software-layer confinement + control-plane parity)

> Status: Accepted (2026-07-24)
> Pairs with: [ADR-001](001-agent-container-isolation-v2.md) (agent container isolation — docker)

## Context

`RUNTIME_MODE=local` (default) runs the Claude Agent SDK **in-process on the host**
through `AgentSession` (`server/ai-client.ts`). Originally it:

- bypassed the control plane entirely — `LocalAgentRuntime` never called
  `capabilityProvider.resolve()`, so workbench-configured skill/profile/entitlement
  did not apply to local;
- had **no path confinement** — `Read`/`Grep`/`Glob` (in `allowedTools`) bypassed the
  `PreToolUse` hook entirely, so they could read any host path: cross-tenant
  `data/workspaces/<otherChatId>/` and secrets (`.env`).

`feat/hybrid-skill-scheme` is the mainline. Local is the dev / trusted-internal /
light path; docker (ADR-001) is the strong-isolation / multi-tenant / production path.

## Decision

Local isolation is **layered software confinement + control-plane parity** — not
OS-level isolation. Three parts:

### 1. L1 path guard — `server/workspace-guard.ts`

The `PreToolUse` hook confines path-taking tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`)
to the chat's workspace dir:

- realpath + `path.sep`-aware prefix (defeats symlink escape, sibling-chat, prefix
  collision like `/ws` vs `/ws-evil`);
- relative paths resolved against the SDK `cwd` (workspace root), not `process.cwd()`;
- the guard runs **before** the `allowedTools` check — `allowedTools` no longer bypasses it;
- `Bash` is denied outright in local (arbitrary commands cannot be path-validated);
- `strictMcpConfig: true` suppresses all file-based MCP discovery (a planted
  `/workspace/.mcp.json` cannot auto-connect an ungoverned MCP server).

**Known limit (explicit):** L1 is a *software* layer. It only constrains `tool_use`
that flows through the hook. TOCTOU (symlink swap between check and execute), the
hardcoded `PATH_TOOL_ARG` whitelist, and any code executing outside the tool layer
(MCP subprocess, SDK/dependency bug) are **not** covered → that is what L2/L3 are for.

### 2. Control-plane parity — Phase B

Local now calls `resolve({ runtimeType: "local" })`, so workbench-configured **skill +
profile + entitlement + app-allowlist** take effect in local too (one config surface,
two execution planes). The `resolve()` local branch emits **HOST-path** plugins (no
mount — local has no container) and drops the Docker-oriented system prompt.

### 3. No MCP in local — Phase C cancelled

Local MCP subprocesses run on the host → blast radius = the entire host. Owner
decision (2026-07-24): **local will never mount MCP**. `resolve()` local branch sets
`mcpServers = {}` permanently. Need MCP → use docker.

## Local capability boundary

| capability | local | docker |
|---|---|---|
| pre-set skill + tool/profile (admin console) | ✅ | ✅ |
| pre-set MCP | ❌ permanent (Phase C cancelled) | ✅ |
| agent / user self-build tool or mcp | ❌ never (control-plane 铁律) | ❌ never |
| isolation strength | L1 software (host shared) | container (strong) |

## Consequences

- Local = **trusted-internal / low-risk / single-tenant / dev**. Not for multi-tenant
  or untrusted workloads — use docker.
- The judgment line is **trust-source + behavior-controllability, not mechanism-ban**:
  read-only / low-side-effect capabilities (skill) are allowed; arbitrary-execution
  surfaces (`Bash`, hook-plugin in-process JS, MCP subprocess) are denied → docker.
- L2 (nsjail / seccomp, Linux-only) remains a deferred option if local ever needs
  OS-level isolation.

## Links

- Full plan + phased history: `docs/开发计划/local-mode-security-isolation-plan.md`
- Docker isolation: [ADR-001](001-agent-container-isolation-v2.md)
- Runtime strategy boundary: `docs/02-architecture/runtime-strategy-reference.md`
