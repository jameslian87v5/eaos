import assert from "node:assert/strict";
import { buildUserMemoryPrompt } from "./user-memory-prompt.js";
import { USER_MEMORY_CONTAINER_FILE } from "./user-memory-service.js";

const dockerPath = USER_MEMORY_CONTAINER_FILE; // "/user-memory/MEMORY.md"
const hostPath = "/tmp/host/data/user-memory/user-xyz/MEMORY.md";

// 1. Prompt names the runtime path.
const dockerPrompt = buildUserMemoryPrompt(dockerPath);
assert.ok(dockerPrompt.includes(dockerPath), "docker prompt contains the in-container path");
assert.ok(dockerPrompt.includes("Memory"), "prompt is the memory instruction");

const hostPrompt = buildUserMemoryPrompt(hostPath);
assert.ok(hostPrompt.includes(hostPath), "local prompt contains the host path");

// 1b. The EXACT supplied path must drive the read + write instructions for BOTH
//     runtimes (no bare relative `MEMORY.md` that would be ambiguous/wrong path).
assert.ok(
  dockerPrompt.includes(`read \`${dockerPath}\``),
  "docker read instruction uses the exact in-container path"
);
assert.ok(
  dockerPrompt.includes(`\`${dockerPath}\`; never access`),
  "docker write instruction uses the exact in-container path"
);
assert.ok(
  hostPrompt.includes(`read \`${hostPath}\``),
  "local read instruction uses the exact host path"
);
assert.ok(
  hostPrompt.includes(`\`${hostPath}\`; never access`),
  "local write instruction uses the exact host path"
);
assert.equal(
  dockerPrompt.includes("read `MEMORY.md`"),
  false,
  "docker must NOT use the bare relative filename in the read instruction"
);
assert.equal(
  hostPrompt.includes("read `MEMORY.md`"),
  false,
  "local must NOT use the bare relative filename in the read instruction"
);

// 2. Prompt does NOT instruct editing CLAUDE.md or another user's file.
assert.equal(hostPrompt.includes("edit CLAUDE.md"), false, "must not instruct editing CLAUDE.md");
assert.ok(hostPrompt.toLowerCase().includes("never"), "prompt forbids out-of-scope memory edits");

// 3. Prompt tells the agent to read at task start + keep concise + never store secrets.
assert.ok(/read/i.test(dockerPrompt), "instructs to read memory");
assert.ok(/secret/i.test(dockerPrompt), "forbids storing secrets");
assert.ok(/concise/i.test(dockerPrompt), "asks to keep it concise");

console.log("user-memory-prompt tests passed");
