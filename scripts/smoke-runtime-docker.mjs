#!/usr/bin/env node
/**
 * Docker Runtime Smoke Test
 *
 * End-to-end test covering:
 *   fresh start → runtime status → stop → cold resume → delete + cleanup
 *
 * Prerequisites:
 *   1. Build the agent image:
 *        docker build -t eaos-agent:latest -f docker/Dockerfile .
 *   2. Start the server in Docker mode:
 *        RUNTIME_MODE=docker PORT=3999 DB_PATH=/tmp/eaos-smoke.db npm start
 *   3. Run this script:
 *        node scripts/smoke-runtime-docker.mjs
 *
 * Exit code 0 = all checks passed. Exit code 1 = failure.
 */

import { WebSocket } from "ws";

const BASE = process.env.SMOKE_BASE || "http://localhost:3999";
const WS_BASE = BASE.replace(/^http/, "ws");
const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT || "90000", 10);

let token = "";
let chatId = "";
let passed = 0;
let failed = 0;

// ─── Helpers ────────────────────────────────────────────────

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

/**
 * Open a WebSocket, subscribe to chatId, optionally send a message,
 * and wait for specific event types (or timeout).
 *
 * Returns an array of received messages.
 */
function wsSession(chatIdToUse, { sendContent, waitForTypes = [], timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
    const received = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        resolve(received); // resolve with whatever we got
      }
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

        // Check if we got all the types we're waiting for
        if (waitForTypes.length > 0) {
          const receivedTypes = new Set(received.map((m) => m.type));
          if (waitForTypes.every((t) => receivedTypes.has(t))) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              ws.close();
              resolve(received);
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(received);
      }
    });
  });
}

/** Stop runtime via REST API (synchronous — server awaits container stop). */
async function restStop(chatIdToUse) {
  return api("POST", `/api/chats/${chatIdToUse}/runtime/stop`);
}

// ─── Test Steps ─────────────────────────────────────────────

async function run() {
  console.log("═══════════════════════════════════════");
  console.log(" Docker Runtime Smoke Test");
  console.log(`  Server: ${BASE}`);
  console.log("═══════════════════════════════════════\n");

  // 1. Login
  console.log("Step 1: Login admin");
  const loginRes = await api("POST", "/api/auth/login", { username: "admin", password: "admin123" });
  assert(loginRes.status === 200, `login status=${loginRes.status}`);
  token = loginRes.data.token;
  assert(!!token, "got auth token");

  // 2. Create chat
  console.log("\nStep 2: Create chat");
  const chatRes = await api("POST", "/api/chats");
  assert(chatRes.status === 200 || chatRes.status === 201, `create chat status=${chatRes.status}`);
  chatId = chatRes.data.id;
  assert(!!chatId, `chatId=${chatId}`);

  // 3. Send first message and wait for response
  console.log("\nStep 3: Send first message (fresh start)");
  const msgs1 = await wsSession(chatId, {
    sendContent: "Say hello in exactly 3 words",
    waitForTypes: ["result"],
  });
  const types1 = msgs1.map((m) => m.type);
  assert(types1.includes("assistant_message") || types1.includes("result"), `got agent response: [${types1.join(",")}]`);

  // 4. Check runtime status
  console.log("\nStep 4: Check runtime status (running)");
  const rt1 = await api("GET", `/api/chats/${chatId}/runtime`);
  assert(rt1.status === 200, `runtime status=${rt1.status}`);
  const rtData1 = rt1.data;
  console.log(`  status=${rtData1.status} restoreMode=${rtData1.restoreMode}`);
  assert(rtData1.status === "running" || rtData1.status === "stopped", `status is running or stopped (got ${rtData1.status})`);
  assert(rtData1.restoreMode === "fresh", `restoreMode=fresh (got ${rtData1.restoreMode})`);
  assert(!!rtData1.claudeSessionId, `claudeSessionId exists`);
  assert(!!rtData1.workspaceVolume, `workspaceVolume exists`);
  assert(!!rtData1.claudeHomeVolume, `claudeHomeVolume exists`);
  const firstSessionId = rtData1.claudeSessionId;

  // 5. Stop runtime via REST (awaited — no race)
  console.log("\nStep 5: Stop runtime via REST");
  const stopRes = await restStop(chatId);
  assert(stopRes.status === 200, `REST stop status=${stopRes.status}`);

  const rt2 = await api("GET", `/api/chats/${chatId}/runtime`);
  const rtData2 = rt2.data;
  console.log(`  status=${rtData2.status} cleanupReason=${rtData2.cleanupReason}`);
  assert(rtData2.status === "stopped", `status=stopped (got ${rtData2.status})`);
  assert(rtData2.cleanupReason === "user_request", `cleanupReason=user_request (got ${rtData2.cleanupReason})`);

  // 6. Send second message (cold resume)
  console.log("\nStep 6: Send second message (cold resume)");
  const msgs2 = await wsSession(chatId, {
    sendContent: "What did I just ask you?",
    waitForTypes: ["result"],
  });
  const types2 = msgs2.map((m) => m.type);
  assert(types2.includes("assistant_message") || types2.includes("result"), `got cold resume response: [${types2.join(",")}]`);

  // 7. Check final runtime status — strict cold resume assertions
  console.log("\nStep 7: Check final runtime status (cold resumed)");
  const rt3 = await api("GET", `/api/chats/${chatId}/runtime`);
  const rtData3 = rt3.data;
  console.log(`  status=${rtData3.status} restoreMode=${rtData3.restoreMode} restartCount=${rtData3.restartCount} claudeSessionId=${rtData3.claudeSessionId}`);
  assert(rtData3.restoreMode === "claude_resume",
    `restoreMode=claude_resume (got ${rtData3.restoreMode})`);
  assert(rtData3.restartCount >= 1, `restartCount >= 1 (got ${rtData3.restartCount})`);
  assert(rtData3.claudeSessionId === firstSessionId,
    `claudeSessionId unchanged (first=${firstSessionId}, now=${rtData3.claudeSessionId})`);

  // 8. Check tool config (admin)
  console.log("\nStep 8: Check admin tool-config");
  const tc = await api("GET", "/api/admin/tool-config");
  assert(tc.status === 200, `tool-config status=${tc.status}`);
  const prof = tc.data.defaultProfile;
  const activeTools = tc.data.activeToolConfig?.tools || prof?.tools;
  assert(Array.isArray(activeTools), "tools is array");
  assert(activeTools.includes("Read"), "Read in tools");
  assert(activeTools.includes("Bash"), "Bash in tools");
  assert(activeTools.includes("Write"), "Write in tools");
  assert(activeTools.includes("Edit"), "Edit in tools");
  const allowed = prof?.allowedTools || [];
  assert(!allowed.includes("Bash"), "Bash not in allowedTools");
  assert(!allowed.includes("Write"), "Write not in allowedTools");
  assert(!allowed.includes("Edit"), "Edit not in allowedTools");

  // 9. Delete chat
  console.log("\nStep 9: Delete chat");
  // Stop first if still running
  await restStop(chatId);
  const delRes = await api("DELETE", `/api/chats/${chatId}`);
  assert(delRes.status === 200 || delRes.status === 204, `delete chat status=${delRes.status}`);
  // Wait for async volume cleanup
  await new Promise((r) => setTimeout(r, 3000));

  // 10. Verify cleanup
  console.log("\nStep 10: Verify cleanup");
  const rt4 = await api("GET", `/api/chats/${chatId}/runtime`);
  // Should be 404 (chat gone) or status=none
  assert(rt4.status === 404 || rt4.data.status === "none", `runtime gone after delete (status=${rt4.status})`);

  // ─── Summary ────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
