#!/usr/bin/env node
/**
 * smoke-mcp — minimal stdio MCP server (Phase 3 anchor).
 *
 * `.cjs` extension forces CommonJS regardless of the nearest package.json `type`
 * field: on the host the project root is "type":"module", while in the container
 * there is no package.json near the mount — `.cjs` keeps the same module system
 * in both so `require` works everywhere.
 *
 * Hand-rolled JSON-RPC 2.0 over stdio (no @modelcontextprotocol/sdk dependency)
 * so the package is self-contained and runs with plain `node`. Exposes one tool:
 * `ping` -> returns "pong". End-to-end proof that resolve() -> mcpServers ->
 * SDK spawn -> tool registration works.
 */
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed lines — stdout must stay clean JSON-RPC only
  }
  if (!msg || msg.jsonrpc !== "2.0") return;

  // Notifications (no id) require no response (e.g. notifications/initialized).
  if (msg.id === undefined || msg.id === null) return;

  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "smoke-mcp", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "ping",
              description: "Returns 'pong'. Smoke test tool.",
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        },
      });
      break;
    case "tools/call": {
      const name = params && params.name;
      if (name !== "ping") {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });
        break;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "pong" }] },
      });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});

rl.on("close", () => process.exit(0));
