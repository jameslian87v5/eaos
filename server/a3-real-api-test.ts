/**
 * Real API wrapper test — registers the actual internal API and runs
 * the generated wrapper against it via JSON-RPC protocol.
 *
 * Uses --resolve to map ds-cmn.chit-dev to 110.242.70.57 (cloud hub DNS).
 * The API may return 403 (gateway auth) — that's fine, we're testing
 * that the wrapper correctly forwards the HTTP response as MCP result.
 */

import { rmSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const TEST_DB = "/tmp/test-a3-real-api.db";
const TEST_MCP_CONFIG = "/tmp/test-a3-real-mcp.json";
process.env.DB_PATH = TEST_DB;
process.env.MCP_CONFIG_FILE = TEST_MCP_CONFIG;

rmSync(TEST_DB, { force: true });
rmSync(TEST_MCP_CONFIG, { force: true });

const { registeredApiService } = await import("./registered-api-service.js");
const { installApiAsMcp, uninstallApiMcp } = await import("./capability-installer.js");

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.error(`✗ ${msg}`); }
}

function rpcCall(runShPath: string, messages: object[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [runShPath], { cwd: path.dirname(runShPath) });
    const responses: string[] = [];
    let stderr = "";

    child.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc) responses.push(line);
        } catch { /* ignore */ }
      }
    });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("close", () => {
      if (stderr) console.log(`  [wrapper stderr] ${stderr.trim()}`);
      resolve(responses);
    });
    child.on("error", reject);
    for (const msg of messages) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    }
    child.stdin.end();
  });
}

// Like rpcCall but keeps stdin open for `keepOpenMs` to allow async fetch to complete
function rpcCallWithDelay(runShPath: string, messages: object[], keepOpenMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [runShPath], { cwd: path.dirname(runShPath) });
    const responses: string[] = [];
    let stderr = "";
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { child.stdin.end(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      resolve(responses);
    };

    child.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc) {
            responses.push(line);
            // Got response — close after a short delay
            setTimeout(finish, 100);
          }
        } catch { /* ignore */ }
      }
    });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("close", () => {
      if (stderr) console.log(`  [wrapper stderr] ${stderr.trim()}`);
      finish();
    });
    child.on("error", reject);

    for (const msg of messages) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    }
    // Keep stdin open for async fetch, then force close
    setTimeout(finish, keepOpenMs);
  });
}

async function main() {
  const MCP_ROOT = path.resolve(process.cwd(), "mcp");

  // Register the real API
  const api = registeredApiService.create({
    name: "get_customer_erpid",
    displayName: "查询客户是否存在该产品线",
    description: "查询客户是否存在该产品线（高优）",
    apiUrl: "http://ds-cmn.chit-dev/ds/GET_CUSTOMER_ERPID/1",
    method: "GET",
    timeoutMs: 61000,
  });

  installApiAsMcp(api);
  const pkgDir = path.join(MCP_ROOT, "get_customer_erpid");

  assert(existsSync(path.join(pkgDir, "server.cjs")), "Real API: server.cjs generated");
  assert(existsSync(path.join(pkgDir, "run.sh")), "Real API: run.sh generated");

  // Protocol test: initialize + tools/list first (synchronous responses)
  console.log("\n--- Spawning wrapper, sending initialize + tools/list ---");
  const responses1 = await rpcCall(path.join(pkgDir, "run.sh"), [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  assert(responses1.length >= 2, `Real API: got ${responses1.length} JSON-RPC responses`);

  // initialize
  const initResp = JSON.parse(responses1[0]);
  assert(initResp.result?.serverInfo?.name === "get_customer_erpid", "Real API: serverInfo name correct");

  // tools/list
  const listResp = JSON.parse(responses1[1]);
  const tool = listResp.result?.tools?.[0];
  assert(tool?.name === "get_customer_erpid", "Real API: tool name correct");
  assert(tool?.description === "查询客户是否存在该产品线", "Real API: tool description is Chinese name");

  // tools/call separately — the async fetch needs time to complete before stdin closes
  // This is a SOFT check: the real API may be behind a gateway (403), unreachable,
  // or timeout. We only assert the wrapper attempted the HTTP call and returned
  // *some* JSON-RPC response (success or error). This is a protocol smoke test,
  // NOT an API readiness gate.
  console.log("\n--- Spawning wrapper, sending tools/call (soft check) ---");
  const responses2 = await rpcCallWithDelay(path.join(pkgDir, "run.sh"), [
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_customer_erpid", arguments: {} } },
  ], 15000); // wait up to 15s for response

  if (responses2.length >= 1) {
    const callResp = JSON.parse(responses2[0]);
    if (callResp.result?.content?.[0]?.text !== undefined) {
      const text = callResp.result.content[0].text;
      console.log(`  [HTTP response body] ${text.substring(0, 300) || "(empty — likely 403 with no body)"}`);
      assert(true, "Real API (soft): tools/call returned MCP result with HTTP response body");
      // Classify the response for visibility
      if (text === "" || text.includes("403") || text.includes("Forbidden")) {
        console.log("  → Gateway returned 403/empty — wrapper correctly forwarded it as MCP result");
      } else if (text.includes('"code"') || text.includes('"data"')) {
        console.log("  → API returned JSON data — integration looks healthy");
      }
    } else if (callResp.error) {
      console.log(`  [wrapper error] ${callResp.error.message}`);
      // Error is valid — wrapper correctly reported fetch failure as JSON-RPC error
      assert(true, "Real API (soft): tools/call returned JSON-RPC error (network/DNS/timeout)");
    } else {
      assert(false, "Real API (soft): tools/call returned unexpected JSON-RPC shape");
    }
  } else {
    // No response at all — wrapper process died or hung. This is a real failure.
    assert(false, "Real API (soft): tools/call produced no JSON-RPC response (wrapper may have crashed)");
  }

  // Cleanup
  uninstallApiMcp("get_customer_erpid");
  try { registeredApiService.delete(api.id); } catch {}

  console.log(`\n${failed === 0 ? "✅" : "❌"} Real API wrapper test ${failed === 0 ? "passed" : "FAILED"} (${passed}/${passed + failed})`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
