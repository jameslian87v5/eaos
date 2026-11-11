import assert from "node:assert/strict";
import {
  decideMemoryWriteCore,
  projectMemoryBytes,
  MEMORY_PATH_ARG,
  MEMORY_WRITE_TOOLS,
} from "./user-memory-permission-core.js";

// This is the SINGLE source of truth for the user-memory write rule. The host
// hook (server/user-memory-permission.ts) and the container hook
// (docker/agent-entry.ts) both delegate to this core, so any drift between
// runtimes would show up here.

const MEM = "/user-memory/MEMORY.md";
const readFile = () => "CURRENT";

// 0. Module surface both sides depend on.
assert.ok(MEMORY_WRITE_TOOLS.has("Write") && MEMORY_WRITE_TOOLS.has("Edit"), "Write/Edit eligible");
assert.equal(MEMORY_PATH_ARG, "file_path");

// 1. Write to the exact memory file → allow within quota; deny over quota.
assert.equal(
  decideMemoryWriteCore({
    tool: "Write",
    toolInput: { file_path: MEM, content: "hello" },
    candidatePath: MEM,
    memoryFilePath: MEM,
    quotaBytes: 2000,
    readFile,
  })?.decision,
  "allow",
  "Write within quota allowed"
);
assert.equal(
  decideMemoryWriteCore({
    tool: "Write",
    toolInput: { file_path: MEM, content: "x".repeat(3000) },
    candidatePath: MEM,
    memoryFilePath: MEM,
    quotaBytes: 2000,
    readFile,
  })?.decision,
  "deny",
  "Write over quota denied"
);

// 2. Edit projected against current content; small delta → allow; huge → deny.
assert.equal(
  decideMemoryWriteCore({
    tool: "Edit",
    toolInput: { file_path: MEM, old_string: "CURRENT", new_string: "now" },
    candidatePath: MEM,
    memoryFilePath: MEM,
    quotaBytes: 2000,
    readFile,
  })?.decision,
  "allow",
  "small Edit allowed"
);
assert.equal(
  decideMemoryWriteCore({
    tool: "Edit",
    toolInput: { file_path: MEM, old_string: "CURRENT", new_string: "Y".repeat(3000) },
    candidatePath: MEM,
    memoryFilePath: MEM,
    quotaBytes: 2000,
    readFile,
  })?.decision,
  "deny",
  "oversized Edit denied"
);

// 3. Non-memory target → null (fall through to normal approval/deny).
assert.equal(
  decideMemoryWriteCore({
    tool: "Write",
    toolInput: { file_path: "/repo/CLAUDE.md", content: "x" },
    candidatePath: "/repo/CLAUDE.md",
    memoryFilePath: MEM,
    quotaBytes: 2000,
    readFile,
  }),
  null,
  "non-memory path falls through"
);

// 4. Non-Write/Edit tool → null.
assert.equal(
  decideMemoryWriteCore({
    tool: "Read",
    toolInput: { file_path: MEM },
    candidatePath: MEM,
    memoryFilePath: MEM,
    quotaBytes: 2000,
    readFile,
  }),
  null,
  "Read is not a memory write decision"
);

// 5. projectMemoryBytes: Write = content bytes; Edit = projected replacement.
assert.equal(
  projectMemoryBytes({
    tool: "Write",
    toolInput: { content: "abc" },
    filePath: MEM,
    readFile,
  }),
  3,
  "Write projects content bytes"
);
assert.ok(
  projectMemoryBytes({
    tool: "Edit",
    toolInput: { old_string: "CURRENT", new_string: "abc" },
    filePath: MEM,
    readFile,
  }) === 3,
  "Edit projects the replacement length (replace_all=false)"
);
assert.equal(
  projectMemoryBytes({
    tool: "Edit",
    toolInput: { old_string: "CUR", new_string: "x", replace_all: true },
    filePath: MEM,
    readFile,
  }),
  Buffer.byteLength("xRENT", "utf8"), // CURRENT → split("CUR").join("x") = "xRENT"
  "Edit replace_all=true splits/joins all occurrences"
);

console.log("user-memory-permission-core tests passed");
