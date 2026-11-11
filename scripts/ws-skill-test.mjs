import { WebSocket } from "ws";

const chatId = process.argv[2];
const token  = process.argv[3];
const wsUrl = process.env.WS_URL || `ws://localhost:${process.env.PORT || 3001}/ws`;
const prompt = process.env.SKILL_TEST_PROMPT || "Use the hello-skill skill now and report exactly what it says. Be concise.";

if (!chatId || !token) {
  console.error("Usage: node ws-skill-test.mjs <chatId> <token> (WS_URL=ws://host:port/ws)");
  process.exit(1);
}

const ws = new WebSocket(`${wsUrl}${wsUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
let finished = false;
let skillToolUsed = false;
let skillToolId = null;
let skillToolResult = false;
let timeout;

function finish(code, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (reason) console.error(`[ws] ${reason}`);
  ws.close();
  setTimeout(() => process.exit(code), 100);
}

ws.on("open", () => {
  console.log(`[ws] connected to ${wsUrl}`);
  ws.send(JSON.stringify({ type: "subscribe", chatId }));
  setTimeout(() => {
    console.log("[ws] sending message...");
    ws.send(JSON.stringify({ type: "chat", chatId, content: prompt }));
  }, 500);
});

ws.on("message", (d) => {
  let msg;
  try {
    msg = JSON.parse(d.toString());
  } catch {
    finish(1, "received invalid JSON");
    return;
  }
  if (msg.type === "tool_use") {
    console.log(`[event] type=tool_use toolName=${msg.toolName || ""} toolId=${msg.toolId || ""}`);
    if (msg.toolName === "Skill") {
      skillToolUsed = true;
      skillToolId = msg.toolId || null;
      console.log(`[evidence] skillToolUsed=true toolId=${skillToolId || ""}`);
    }
    return;
  }
  if (msg.type === "tool_result") {
    const output = typeof msg.output === "string" ? msg.output.slice(0, 500) : "";
    console.log(`[event] type=tool_result toolId=${msg.toolId || ""} output=${output}`);
    if (skillToolUsed && msg.toolId === skillToolId && !msg.isError) {
      skillToolResult = true;
      console.log("[evidence] skillToolResult=true");
    }
    return;
  }
  if (msg.type === "assistant_message") {
    console.log(`[event] type=assistant_message ${(msg.content || "").slice(0, 300)}`);
    return;
  }
  if (msg.type === "result") {
    console.log(`[event] type=result success=${msg.success === true}`);
    if (msg.success === true && skillToolUsed && skillToolResult) {
      console.log(`[evidence] skillToolUsed=${skillToolUsed} skillToolResult=${skillToolResult}`);
      finish(0);
    } else {
      finish(1, `result arrived without successful Skill evidence (skillToolUsed=${skillToolUsed}, skillToolResult=${skillToolResult})`);
    }
    return;
  }
  if (msg.type === "error") {
    finish(1, `server error: ${msg.error || msg.content || "unknown"}`);
  }
});

ws.on("error", (e) => finish(1, `ws error: ${e.message}`));
ws.on("close", () => {
  console.log("[ws] closed");
  if (!finished) process.exit(1);
});

timeout = setTimeout(() => finish(1, "timeout after 60s"), 60000);
