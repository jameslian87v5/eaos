import assert from "node:assert/strict";
import { decideMemoryWrite } from "./user-memory-permission.js";

const MEM = "/data/user-memory/user-aaa/MEMORY.md";
const cwd = "/data/workspaces/chat-1";
const quota = 2000;
const readFile = () => "CURRENT"; // deterministic Edit base

// 1. Write to the exact memory file → allow (within quota).
assert.deepEqual(
  decideMemoryWrite({
    tool: "Write",
    toolInput: { file_path: MEM, content: "hello" },
    userMemoryRealPath: MEM,
    cwd,
    quotaBytes: quota,
    readFile,
  }),
  { decision: "allow" },
  "memory write within quota is auto-allowed"
);

// 2. Oversized Write → deny.
const big = decideMemoryWrite({
  tool: "Write",
  toolInput: { file_path: MEM, content: "x".repeat(3000) },
  userMemoryRealPath: MEM,
  cwd,
  quotaBytes: quota,
  readFile,
});
assert.equal(big?.decision, "deny", "oversized write denied");
assert.ok(/quota/i.test(big?.reason ?? ""), "deny reason mentions quota");

// 3. Edit projected against current content; small delta → allow; oversized → deny.
const editOk = decideMemoryWrite({
  tool: "Edit",
  toolInput: { file_path: MEM, old_string: "CURRENT", new_string: "now updated" },
  userMemoryRealPath: MEM,
  cwd,
  quotaBytes: quota,
  readFile,
});
assert.equal(editOk?.decision, "allow", "small edit allowed");
const editBig = decideMemoryWrite({
  tool: "Edit",
  toolInput: { file_path: MEM, old_string: "CURRENT", new_string: "Y".repeat(3000) },
  userMemoryRealPath: MEM,
  cwd,
  quotaBytes: quota,
  readFile,
});
assert.equal(editBig?.decision, "deny", "oversized edit denied");

// 4. Non-memory paths fall through (null) → keep existing approval/deny behavior.
assert.equal(
  decideMemoryWrite({
    tool: "Write",
    toolInput: { file_path: "/repo/CLAUDE.md", content: "x" },
    userMemoryRealPath: MEM,
    cwd,
    quotaBytes: quota,
    readFile,
  }),
  null,
  "CLAUDE.md write is NOT a memory write → falls through to approval"
);
assert.equal(
  decideMemoryWrite({
    tool: "Write",
    toolInput: { file_path: "/data/user-memory/user-BBB/MEMORY.md", content: "x" },
    userMemoryRealPath: MEM,
    cwd,
    quotaBytes: quota,
    readFile,
  }),
  null,
  "another user's memory path is NOT auto-allowed"
);
assert.equal(
  decideMemoryWrite({
    tool: "Write",
    toolInput: { file_path: "/workspace/output/note.txt", content: "x" },
    userMemoryRealPath: MEM,
    cwd,
    quotaBytes: quota,
    readFile,
  }),
  null,
  "workspace write falls through"
);

// 5. Read is not an auto-write decision.
assert.equal(
  decideMemoryWrite({
    tool: "Read",
    toolInput: { file_path: MEM },
    userMemoryRealPath: MEM,
    cwd,
    quotaBytes: quota,
    readFile,
  }),
  null,
  "Read is not handled by the memory write rule"
);

console.log("user-memory-permission tests passed");
