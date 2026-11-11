// Run: npx tsx client/runtime-url.test.ts  (Task 1 Step 1)
// No test framework — plain node:assert, same convention as server tests.
import assert from "node:assert/strict";
import { buildWebSocketUrl } from "./runtime-url.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// 1. HTTPS origin → wss, same host, /ws path.
ok("https → wss same-origin",
  buildWebSocketUrl({ protocol: "https:", host: "agentos.example.com" }) === "wss://agentos.example.com/ws");

// 2. HTTP dev origin (Vite) → ws, host INCLUDING port preserved, /ws path.
ok("http:5173 → ws with port",
  buildWebSocketUrl({ protocol: "http:", host: "localhost:5173" }) === "ws://localhost:5173/ws");

// 3. Explicit non-default port on https.
ok("https with port keeps port",
  buildWebSocketUrl({ protocol: "https:", host: "agentos.example.com:8443" }) === "wss://agentos.example.com:8443/ws");

// 4. Token with query-string special chars must be percent-encoded via
//    URLSearchParams — never raw string concatenation. Assert the ROUND TRIP
//    through new URL().searchParams (exactly how the server decodes it):
//    URLSearchParams form-encodes space as '+', which searchParams.get
//    decodes back — both sides of the contract in one assertion.
{
  const url = buildWebSocketUrl({ protocol: "https:", host: "a.example.com" }, "abc&def=gh ij+");
  const parsed = new URL(url);
  ok("token round-trips via URLSearchParams",
    parsed.searchParams.get("token") === "abc&def=gh ij+",
    url);
  ok("encoded token has no raw & or space", !/[ &]/.test(parsed.search.slice(1)), url);
}

// 5. No token → bare /ws, no trailing ?.
ok("no token → bare /ws",
  buildWebSocketUrl({ protocol: "https:", host: "a.example.com" }, undefined) === "wss://a.example.com/ws");

console.log(`${pass} passed, 0 failed`);
