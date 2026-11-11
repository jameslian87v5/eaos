#!/usr/bin/env node
/**
 * Capability Boundary Smoke Test (Docker mode)
 *
 * Verifies:
 *   - Default-sandbox profile enforced (full tools, Write/Edit/Bash need approval)
 *   - AGENT_SDK_OPTIONS env var reaches the container with systemPrompt/appendSystemPrompt
 *   - Container AGENT_TOOLS includes all tools; allowedTools only safe subset
 *   - HostConfig.Binds does not mount /workspace as capability source
 *   - No /workspace path in AGENT_SDK_OPTIONS plugins/mcp/additionalDirs
 *
 * Prerequisites:
 *   RUNTIME_MODE=docker PORT=3999 DB_PATH=/tmp/eaos-smoke.db npm start
 *   node scripts/smoke-capability-boundary.mjs
 */

import { WebSocket } from "ws";
import Dockerode from "dockerode";

const BASE = process.env.SMOKE_BASE || "http://localhost:3999";
const WS_BASE = BASE.replace(/^http/, "ws");
const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT || "60000", 10);
const docker = new Dockerode();

let token = "";
let chatId = "";
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (token) opts.headers["Authorization"] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

function wsSession(chatIdToUse, { sendContent, waitForTypes = [], timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
    const received = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; ws.close(); resolve(received); }
    }, timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", chatId: chatIdToUse }));
      if (sendContent) {
        ws.send(JSON.stringify({ type: "chat", chatId: chatIdToUse, content: sendContent }));
      }
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        if (waitForTypes.length > 0) {
          const types = new Set(received.map((m) => m.type));
          if (waitForTypes.every((t) => types.has(t))) {
            if (!settled) { settled = true; clearTimeout(timer); ws.close(); resolve(received); }
          }
        }
      } catch {}
    });
    ws.on("error", (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    ws.on("close", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(received); } });
  });
}

async function run() {
  console.log("═══════════════════════════════════════");
  console.log(" Capability Boundary Smoke Test");
  console.log(`  Server: ${BASE}`);
  console.log("═══════════════════════════════════════\n");

  // 1. Check admin tool-config
  console.log("Step 1: Admin tool-config");
  const loginRes = await api("POST", "/api/auth/login", { username: "admin", password: "admin123" });
  token = loginRes.data.token;
  assert(!!token, "got auth token");

  const tc = await api("GET", "/api/admin/tool-config");
  assert(tc.status === 200, `tool-config status=${tc.status}`);
  const profile = tc.data.defaultProfile;
  assert(profile.name === "default-sandbox", `profile name=${profile.name}`);
  assert(profile.tools.includes("Read"), "Read in tools");
  assert(profile.tools.includes("Grep"), "Grep in tools");
  assert(profile.tools.includes("Glob"), "Glob in tools");
  assert(profile.tools.includes("Bash"), "Bash in tools");
  assert(profile.tools.includes("Write"), "Write in tools");
  assert(profile.tools.includes("Edit"), "Edit in tools");
  assert(!profile.allowedTools.includes("Bash"), "Bash NOT in allowedTools");
  assert(!profile.allowedTools.includes("Write"), "Write NOT in allowedTools");
  assert(!profile.allowedTools.includes("Edit"), "Edit NOT in allowedTools");
  assert(profile.disallowedTools.length === 0, "disallowedTools is empty");
  assert(profile.approvalRequiredTools.includes("Bash"), "Bash in approvalRequiredTools");
  assert(profile.approvalRequiredTools.includes("Write"), "Write in approvalRequiredTools");
  assert(profile.approvalRequiredTools.includes("Edit"), "Edit in approvalRequiredTools");

  // 2. Create chat + start runtime (send message to trigger container)
  console.log("\nStep 2: Start container via chat message");
  const chatRes = await api("POST", "/api/chats");
  chatId = chatRes.data.id;
  assert(!!chatId, `chatId=${chatId}`);

  await wsSession(chatId, {
    sendContent: "Reply with exactly: OK",
    waitForTypes: ["result"],
  });

  // Give container a moment
  await new Promise((r) => setTimeout(r, 2000));

  // 3. Inspect the running container
  console.log("\nStep 3: Inspect container env and binds");
  const containers = await docker.listContainers({
    filters: { label: ["app=eaos-agent", `chatId=${chatId}`] },
  });
  assert(containers.length > 0, `found container for chatId`);

  if (containers.length > 0) {
    const containerInfo = await docker.getContainer(containers[0].Id).inspect();
    const env = containerInfo.Config.Env || [];
    const binds = containerInfo.HostConfig?.Binds || [];

    // 3a. AGENT_TOOLS must be safe
    const agentToolsEnv = env.find((e) => e.startsWith("AGENT_TOOLS="));
    assert(!!agentToolsEnv, "AGENT_TOOLS env exists");
    if (agentToolsEnv) {
      const tools = JSON.parse(agentToolsEnv.split("=").slice(1).join("="));
      assert(tools.includes("Read"), "container AGENT_TOOLS includes Read");
      assert(tools.includes("Bash"), "container AGENT_TOOLS includes Bash");
      assert(tools.includes("Write"), "container AGENT_TOOLS includes Write");
      assert(tools.includes("Edit"), "container AGENT_TOOLS includes Edit");
    }

    // 3b. AGENT_SDK_OPTIONS must exist
    const sdkOptionsEnv = env.find((e) => e.startsWith("AGENT_SDK_OPTIONS="));
    assert(!!sdkOptionsEnv, "AGENT_SDK_OPTIONS env exists");
    if (sdkOptionsEnv) {
      const opts = JSON.parse(sdkOptionsEnv.split("=").slice(1).join("="));
      assert(Array.isArray(opts.disallowedTools), "disallowedTools is array in SDK options");
      assert(opts.disallowedTools.length === 0, "disallowedTools is empty in SDK options");
      assert(typeof opts.systemPrompt === "string" && opts.systemPrompt.length > 0, "systemPrompt present in SDK options");
      assert(typeof opts.appendSystemPrompt === "string" && opts.appendSystemPrompt.includes("/workspace"), "appendSystemPrompt mentions /workspace");
      assert(Array.isArray(opts.plugins), "plugins is array");
      assert(opts.plugins.length === 0, "no plugins in default profile");
      assert(typeof opts.mcpServers === "object", "mcpServers is object");
      assert(Object.keys(opts.mcpServers).length === 0, "no MCP servers in default profile");

      // Verify no /workspace paths in plugins/mcpServers
      const pluginPaths = (opts.plugins || []).map((p) => p.path);
      assert(!pluginPaths.some((p) => p.startsWith("/workspace")), "no /workspace in plugin paths");
    }

    // 3c. Binds must not mount /workspace as capability source
    // Workspace bind should be the named volume for user data, not skill/plugin
    const capabilityBinds = binds.filter((b) =>
      b.includes("/opt/agent/") && b.includes(":ro")
    );
    console.log(`  Capability binds (readonly): ${capabilityBinds.length} (expected 0 for default profile)`);
    assert(capabilityBinds.length === 0, "no capability mounts in default profile");

    // Verify workspace bind is the named volume (not a host path being used as plugin source)
    const workspaceBind = binds.find((b) => b.includes(":/workspace"));
    assert(!!workspaceBind, "workspace volume bind exists");
    assert(!workspaceBind.includes(":ro"), "workspace is not readonly (user data, not capability)");

    // 3d. No ANTHROPIC_API_KEY leaked in AGENT_SDK_OPTIONS
    if (sdkOptionsEnv) {
      assert(!sdkOptionsEnv.includes("ANTHROPIC_API_KEY"), "no API key in SDK_OPTIONS");
    }
  }

  // 4. Cleanup
  console.log("\nStep 4: Cleanup");
  await api("POST", `/api/chats/${chatId}/runtime/stop`);
  await new Promise((r) => setTimeout(r, 2000));
  await api("DELETE", `/api/chats/${chatId}`);
  await new Promise((r) => setTimeout(r, 3000));

  // Summary
  console.log("\n═══════════════════════════════════════");
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
