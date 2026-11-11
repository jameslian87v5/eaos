import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 0 });
await new Promise((resolve) => wss.once("listening", resolve));
const { port } = wss.address();
let observedChat = false;

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "connected" }));
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "subscribe") {
      socket.send(JSON.stringify({ type: "history", messages: [], chatId: message.chatId }));
    }
    if (message.type === "chat") {
      observedChat = true;
      socket.send(JSON.stringify({ type: "assistant_message", content: "I will inspect the skill." }));
      socket.send(JSON.stringify({
        type: "tool_use",
        toolName: "Skill",
        toolId: "tool-1",
        toolInput: { skill: "hello-skill" },
      }));
      socket.send(JSON.stringify({ type: "tool_result", toolId: "tool-1", output: "hello-skill discovered" }));
      socket.send(JSON.stringify({ type: "assistant_message", content: "hello-skill is available." }));
      socket.send(JSON.stringify({ type: "result", success: true }));
    }
  });
});

const child = spawn(process.execPath, ["scripts/ws-skill-test.mjs", "chat-1", "token-1"], {
  cwd: process.cwd(),
  env: { ...process.env, WS_URL: `ws://127.0.0.1:${port}/ws` },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve) => child.once("exit", resolve));

assert.equal(observedChat, true, `fake server did not receive chat; stdout=${stdout}; stderr=${stderr}`);
assert.equal(exitCode, 0, `smoke exited ${exitCode}; stdout=${stdout}; stderr=${stderr}`);
assert.match(stdout, /tool_use.*Skill/, `missing Skill tool_use evidence: ${stdout}`);
assert.match(stdout, /tool_result.*hello-skill discovered/, `missing Skill tool_result evidence: ${stdout}`);
assert.match(stdout, /skillToolUsed=true/, `missing final skill assertion: ${stdout}`);

await new Promise((resolve) => wss.close(resolve));
console.log("ws-skill-test regression passed");
