#!/usr/bin/env node
/**
 * File Workspace Smoke Test (Docker mode)
 *
 * Verifies:
 *   - Upload file via API → visible inside container /workspace/input/
 *   - List files returns metadata
 *   - Other user cannot access files
 *   - Delete chat cleans up
 *
 * Prerequisites:
 *   docker pull alpine:latest
 *   RUNTIME_MODE=docker PORT=3999 DB_PATH=/tmp/eaos-smoke.db npm start
 *   node scripts/smoke-file-workspace.mjs
 */

import Dockerode from "dockerode";

const BASE = process.env.SMOKE_BASE || "http://localhost:3999";
const docker = new Dockerode();

let token = "";
let token2 = "";
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

async function api(method, path, body, authToken) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (authToken || token) opts.headers["Authorization"] = `Bearer ${authToken || token}`;
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
 * Read a file from a Docker named volume using a helper container.
 */
const HELPER_IMAGE = "eaos-agent:latest";
async function readFromVolume(volumeName, filePath) {
  try {
    const container = await docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ["cat", filePath],
      HostConfig: {
        Binds: [`${volumeName}:/workspace`],
        AutoRemove: true,
      },
    });
    await container.start();
    const logs = await container.logs({ follow: true, stdout: true, stderr: false });
    const chunks = [];
    await new Promise((resolve, reject) => {
      logs.on("data", (chunk) => chunks.push(chunk));
      logs.on("end", resolve);
      logs.on("error", reject);
    });
    await container.wait();
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

async function run() {
  console.log("═══════════════════════════════════════");
  console.log(" File Workspace Smoke Test (Docker)");
  console.log(`  Server: ${BASE}`);
  console.log("═══════════════════════════════════════\n");

  // 1. Login admin
  console.log("Step 1: Login");
  const loginRes = await api("POST", "/api/auth/login", { username: "admin", password: "admin123" });
  assert(loginRes.status === 200, `login status=${loginRes.status}`);
  token = loginRes.data.token;

  // Register + login another user for isolation test
  await api("POST", "/api/auth/register", { username: "fileuser2", password: "fileuser2pass" });
  const login2 = await api("POST", "/api/auth/login", { username: "fileuser2", password: "fileuser2pass" });
  token2 = login2.data?.token || "";

  // 2. Create chat
  console.log("\nStep 2: Create chat");
  const chatRes = await api("POST", "/api/chats");
  assert(chatRes.status === 201 || chatRes.status === 200, `create chat status=${chatRes.status}`);
  chatId = chatRes.data.id;
  assert(!!chatId, `chatId=${chatId}`);

  // 3. Upload file
  console.log("\nStep 3: Upload file");
  const fileContent = "Hello from smoke test!";
  const b64 = Buffer.from(fileContent).toString("base64");
  const uploadRes = await api("POST", `/api/chats/${chatId}/files/input`, {
    filename: "test-smoke.txt",
    content: b64,
    mimeType: "text/plain",
  });
  assert(uploadRes.status === 201, `upload status=${uploadRes.status}`);
  assert(uploadRes.data.filename === "test-smoke.txt", `filename=${uploadRes.data.filename}`);
  assert(uploadRes.data.path === "/workspace/input/test-smoke.txt", `path=${uploadRes.data.path}`);
  assert(uploadRes.data.sizeBytes === fileContent.length, `sizeBytes=${uploadRes.data.sizeBytes}`);
  const fileId = uploadRes.data.id;

  // 4. Verify file in named volume
  console.log("\nStep 4: Verify file in Docker volume");
  const volumeName = `agent-workspace-${chatId}`;
  const volumeContent = await readFromVolume(volumeName, "/workspace/input/test-smoke.txt");
  // Docker log streams have 8-byte header per chunk; strip if present
  const cleanContent = volumeContent ? volumeContent.replace(/^[\x00-\x1f]{8}/, "").trim() : null;
  assert(cleanContent === fileContent, `volume content matches (got: "${cleanContent}")`);

  // 5. List files
  console.log("\nStep 5: List files");
  const listRes = await api("GET", `/api/chats/${chatId}/files`);
  assert(listRes.status === 200, `list status=${listRes.status}`);
  assert(Array.isArray(listRes.data), "list is array");
  assert(listRes.data.length === 1, `list length=${listRes.data.length}`);
  assert(listRes.data[0].filename === "test-smoke.txt", "correct filename in list");

  // 6. Other user cannot access
  console.log("\nStep 6: Cross-user isolation");
  if (token2) {
    const otherList = await api("GET", `/api/chats/${chatId}/files`, null, token2);
    assert(otherList.status === 404, `other user gets 404 (got ${otherList.status})`);
    const otherDownload = await api("GET", `/api/chats/${chatId}/files/${fileId}/download`, null, token2);
    assert(otherDownload.status === 404, `other user download 404 (got ${otherDownload.status})`);
  } else {
    console.log("  ⚠ Skipping cross-user test (no second user token)");
  }

  // 7. Path traversal protection
  console.log("\nStep 7: Path traversal blocked");
  const traversalRes = await api("POST", `/api/chats/${chatId}/files/input`, {
    filename: "../../etc/passwd",
    content: b64,
    mimeType: "text/plain",
  });
  assert(traversalRes.status === 201, `traversal upload accepted (sanitized)`);
  assert(!traversalRes.data.filename.includes(".."), `filename sanitized: ${traversalRes.data.filename}`);
  assert(traversalRes.data.path.startsWith("/workspace/input/"), `path safe: ${traversalRes.data.path}`);

  // 8. Delete chat and verify cleanup
  console.log("\nStep 8: Delete chat + volume cleanup");
  // Stop runtime first (may not be running, that's fine)
  await api("POST", `/api/chats/${chatId}/runtime/stop`);
  await new Promise((r) => setTimeout(r, 2000));

  const delRes = await api("DELETE", `/api/chats/${chatId}`);
  assert(delRes.status === 200 || delRes.status === 204, `delete status=${delRes.status}`);
  await new Promise((r) => setTimeout(r, 3000));

  // Volume should be gone
  try {
    const vol = docker.getVolume(volumeName);
    await vol.inspect();
    assert(false, `volume ${volumeName} should be removed`);
  } catch (err) {
    assert(true, `volume ${volumeName} removed after delete`);
  }

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
