#!/usr/bin/env bash
# smoke-mcp entry point (Phase 3 anchor).
#
# The container prefix guard (agent-entry.ts) requires an MCP server's `command`
# to start with /opt/agent/mcp/, so the SDK invokes us as
# /opt/agent/mcp/smoke-mcp/run.sh. We hand off to node + server.cjs. Keeping the
# interpreter inside this wrapper (rather than passing `command: "node"`) is what
# lets the prefix guard hold for arbitrary MCP packages.
set -euo pipefail
exec node "$(dirname "$0")/server.cjs" "$@"
