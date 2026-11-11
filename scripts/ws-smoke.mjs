/**
 * Docker runtime smoke test - WebSocket phase
 * Usage: node scripts/ws-smoke.mjs <chatId> <token>
 */
import { WebSocket } from "ws";

const chatId = process.argv[2];
const token  = process.argv[3];

if (!chatId || !token) {
  console.error("Usage: node ws-smoke.mjs <chatId> <token>");
  process.exit(1);
}

const events = [];
const ws = new WebSocket(`ws://localhost:3999/ws?token=${token}`);

ws.on("open", () => {
  console.log("[ws] connected");
  ws.send(JSON.stringify({ type: "subscribe", chatId }));
  setTimeout(() => {
    console.log("[ws] sending message...");
    ws.send(JSON.stringify({ type: "send_message", chatId, content: "Reply with just the word: pong" }));
  }, 1000);
});

ws.on("message", (d) => {
  const msg = JSON.parse(d.toString());
  events.push(msg);
  console.log("[ws event]", msg.type, msg.content ? msg.content.slice(0, 80) : "");
  if (msg.type === "result") {
    console.log("\n=== RESULT ===");
    console.log("Events received:", events.map(e => e.type).join(", "));
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (e) => { console.error("[ws error]", e.message); process.exit(1); });

// Timeout after 60s
setTimeout(() => {
  console.log("\n=== TIMEOUT — events so far:", events.map(e => e.type).join(", "));
  ws.close();
  process.exit(1);
}, 60000);
