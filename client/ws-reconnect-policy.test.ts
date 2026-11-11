// Run: npx tsx client/ws-reconnect-policy.test.ts
// Verifies the WS reconnect policy: 4001 (auth) and 4003 (password change)
// are non-reconnectable; transient closes reconnect.
import assert from "node:assert/strict";

// Mirror of the shouldReconnect logic in App.tsx. Kept in sync manually —
// the real hook is in react-use-websocket; this asserts the policy shape.
function shouldReconnect(code: number | undefined): boolean {
  return code !== 4003 && code !== 4001;
}

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// 4001 = auth failure (expired/invalid token, disabled account) — do NOT retry.
ok("4001 auth failure → no reconnect", shouldReconnect(4001) === false);

// 4003 = password change required / app-key mismatch — do NOT retry.
ok("4003 password change → no reconnect", shouldReconnect(4003) === false);

// 1000 = normal close — reconnect (server restart clean close is still
// a transient drop from the app's perspective).
ok("1000 normal close → reconnect", shouldReconnect(1000) === true);

// 1006 = abnormal close (network drop) — reconnect.
ok("1006 abnormal close → reconnect", shouldReconnect(1006) === true);

// 1011 = server error — reconnect (might be transient).
ok("1011 server error → reconnect", shouldReconnect(1011) === true);

// undefined = unknown close — reconnect (default).
ok("undefined → reconnect (default)", shouldReconnect(undefined) === true);

// 4002 / 4004 = other custom codes — reconnect (only 4001/4003 are permanent).
ok("4002 → reconnect", shouldReconnect(4002) === true);
ok("4004 → reconnect", shouldReconnect(4004) === true);

console.log(`${pass} passed, 0 failed`);
