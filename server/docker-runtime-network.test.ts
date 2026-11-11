// Task 2 (P0.2) — Agent IPC port bindings must be loopback-only.
// Run: npx tsx server/docker-runtime-network.test.ts
import assert from "node:assert/strict";
import { buildAgentPortBindings } from "./docker-runtime.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const bindings = buildAgentPortBindings(34567);

// 1. The one and only key is the container WS port 9100/tcp.
ok("only 9100/tcp is bound", Object.keys(bindings).length === 1 && "9100/tcp" in bindings, JSON.stringify(Object.keys(bindings)));

// 2. HostIp is strictly the loopback literal (the literal TYPE is itself the
//    compile-time guard; the serialized-JSON check below is the runtime one).
const entries = bindings["9100/tcp"];
ok("exactly one binding entry", Array.isArray(entries) && entries.length === 1);
ok("HostIp strictly 127.0.0.1", entries[0].HostIp === "127.0.0.1", JSON.stringify(entries[0]));

// 3. HostPort is the given host port as a string (dockerode type).
ok("HostPort is string of given port", entries[0].HostPort === "34567", entries[0].HostPort);

// 4. Structural guard: the raw JSON fed to Docker never contains a wildcard
//    bind anywhere (defense against future edits reintroducing it).
ok("serialized bindings contain no 0.0.0.0", !JSON.stringify(bindings).includes("0.0.0.0"));

console.log(`${pass} passed, 0 failed`);
