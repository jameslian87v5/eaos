#!/usr/bin/env bash
# Docker Runtime Smoke Test
# Tests: login → create chat → send message → container starts → events arrive → delete chat → cleanup
set -euo pipefail

BASE="http://localhost:3999"
PASS=0
FAIL=0

ok()   { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ((FAIL++)); }

echo ""
echo "=== Docker Runtime Smoke Test ==="
echo ""

# 1. Login
echo "Step 1: Login"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}')
TOKEN=$(echo "$LOGIN" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -n "$TOKEN" ]; then ok "Login succeeded, got token"; else fail "Login failed: $LOGIN"; exit 1; fi

AUTH="Authorization: Bearer $TOKEN"

# 2. Create chat
echo "Step 2: Create chat"
CHAT=$(curl -s -X POST "$BASE/api/chats" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"name":"smoke-test"}')
CHAT_ID=$(echo "$CHAT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$CHAT_ID" ]; then ok "Chat created: $CHAT_ID"; else fail "Create chat failed: $CHAT"; exit 1; fi

# 3. WebSocket subscribe + send message + receive events
echo "Step 3: WebSocket subscribe + send message"
WS_LOG=$(mktemp)

# Use wscat or websocat if available, else use node
if command -v websocat &>/dev/null; then
  (echo '{"type":"subscribe","chatId":"'"$CHAT_ID"'"}' ; \
   sleep 1; \
   echo '{"type":"send_message","chatId":"'"$CHAT_ID"'","content":"Say exactly: pong"}' ; \
   sleep 30) | \
  websocat -n "ws://localhost:3999/ws?token=$TOKEN" 2>/dev/null | tee "$WS_LOG" &
  WS_PID=$!
  sleep 35
  kill $WS_PID 2>/dev/null || true
elif command -v node &>/dev/null; then
  node - <<'JSEOF' "$CHAT_ID" "$TOKEN" "$WS_LOG" &
const chatId = process.argv[1];
const token  = process.argv[2];
const logPath = process.argv[3];
const { WebSocket } = await import("ws").catch(() => { throw new Error("ws not found"); });
const { writeFileSync, appendFileSync } = await import("fs");
const ws = new WebSocket(`ws://localhost:3999/ws?token=${token}`);
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", chatId }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "send_message", chatId, content: "Say exactly: pong" }));
  }, 500);
});
ws.on("message", (d) => {
  const s = d.toString();
  appendFileSync(logPath, s + "\n");
  console.log("[ws]", s.slice(0, 200));
});
setTimeout(() => { ws.close(); process.exit(0); }, 40000);
JSEOF
  WS_PID=$!
  sleep 45
  kill $WS_PID 2>/dev/null || true
else
  fail "No WebSocket client available (install websocat or ws npm module)"
fi

# 4. Check container was created
echo "Step 4: Check Docker container"
CONTAINER=$(docker ps --filter "label=chatId=$CHAT_ID" --format "{{.ID}}" 2>/dev/null | head -1)
if [ -n "$CONTAINER" ]; then
  ok "Container running: $CONTAINER"
else
  fail "No container found for chatId=$CHAT_ID (may have already exited)"
fi

# 5. Check events received
echo "Step 5: Check events"
if grep -q "assistant_message\|result" "$WS_LOG" 2>/dev/null; then
  ok "Received agent response events"
else
  fail "No assistant_message/result events received"
  echo "  WS log: $(cat "$WS_LOG" 2>/dev/null | head -5)"
fi

# 6. Check DB: agent_sessions + claude_session_id
echo "Step 6: Check DB persistence"
DB_PATH="./server/data/eaos.db"
if [ -f "$DB_PATH" ]; then
  SESSIONS=$(sqlite3 "$DB_PATH" "SELECT id, claude_session_id, status FROM agent_sessions WHERE chat_id='$CHAT_ID';" 2>/dev/null)
  if [ -n "$SESSIONS" ]; then
    ok "agent_sessions row exists: $SESSIONS"
    SESSION_ID=$(echo "$SESSIONS" | cut -d'|' -f2)
    if [ -n "$SESSION_ID" ]; then ok "claude_session_id captured: $SESSION_ID"; else fail "claude_session_id is empty"; fi
  else
    fail "No agent_sessions row for chat_id=$CHAT_ID"
  fi
else
  fail "DB not found at $DB_PATH"
fi

# 7. Delete chat → container + volume cleanup
echo "Step 7: Delete chat"
DEL=$(curl -s -X DELETE "$BASE/api/chats/$CHAT_ID" -H "$AUTH")
if echo "$DEL" | grep -q '"success"'; then
  ok "Chat deleted"
else
  fail "Delete failed: $DEL"
fi

sleep 5
CONTAINER_AFTER=$(docker ps --filter "label=chatId=$CHAT_ID" --format "{{.ID}}" 2>/dev/null | head -1)
if [ -z "$CONTAINER_AFTER" ]; then ok "Container stopped after delete"; else fail "Container still running: $CONTAINER_AFTER"; fi

VOLUME_AFTER=$(docker volume ls --filter "name=agent-workspace-$CHAT_ID" --format "{{.Name}}" 2>/dev/null | head -1)
if [ -z "$VOLUME_AFTER" ]; then ok "Volume removed after delete"; else fail "Volume still exists: $VOLUME_AFTER"; fi

# Summary
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
rm -f "$WS_LOG"
[ "$FAIL" -eq 0 ]
