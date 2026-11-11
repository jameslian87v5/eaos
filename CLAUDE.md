# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

EAOS — an open-source enterprise agent platform built natively on the Claude Agent SDK. React + Express + WebSocket + SQLite (better-sqlite3). Agents run either in-process (`local`) or one-Docker-container-per-chat (`docker`, via `RUNTIME_MODE`).

## Commands

| Purpose | Command |
|---|---|
| Dev (server + client) | `npm run dev` |
| Server only | `npm run dev:server` (:3001) |
| Client only | `npm run dev:client` (:5173) |
| Tests | `npm run test:all` (aggregate), individual `npm run test:<name>` |
| Build client | `npm run build` |

Copy `.env.example` → `.env` first; see Quickstart in README.

## Architecture in one paragraph

Control plane (agent definitions, profiles, entitlements, audit) is strictly separated from the data plane (container runtime, SDK `query()`, tool execution). All capabilities flow through `server/capability-provider.ts` `resolve()` → `CapabilityBundle { sdkOptions, mounts, env }`. Frontends and users never set tools, plugins, MCP servers, or host paths directly. Key files: `server/server.ts` (HTTP+WS entry), `server/session.ts` (orchestrator), `server/agent-runtime.ts` (runtime interface), `server/docker-runtime.ts` + `server/container-manager.ts` (container lifecycle), `docker/agent-entry.ts` (in-container entry).

## Invariants

- Deny-by-default authorization; governance guardrails cannot be relaxed by org admins, apps, or hooks.
- MCP commands inside containers must live under `/opt/agent/mcp/`.
- Credentials stay on the host; agents get scoped tokens that die with their runtime.
- Merge gate: review + `npx tsc --noEmit` clean + affected tests green, before merge.

See `docs/02-architecture/` for the target architecture and `docs/04-guides/` for developer guides.
