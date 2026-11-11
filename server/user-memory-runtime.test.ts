import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import * as svc from "./user-memory-service.js";
import { capabilityProvider } from "./capability-provider.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usermem-rt-"));
process.env.USER_MEMORY_ROOT = TMP;

const USER_A = "user-aaa-111";
const USER_B = "user-bbb-222";

// 1. Two users resolve to different host dirs; a path for A never equals B's.
svc.ensureMemory(USER_A);
svc.ensureMemory(USER_B);
assert.notEqual(svc.getHostDir(USER_A), svc.getHostDir(USER_B));
assert.notEqual(svc.getHostFile(USER_A), svc.getHostFile(USER_B));
assert.ok(svc.getHostFile(USER_A).includes(svc.sanitizeUserId(USER_A)));
assert.ok(!svc.getHostFile(USER_A).includes(svc.sanitizeUserId(USER_B)));

// 2. Bind/volume name per user (validated id, no traversal).
assert.equal(svc.getUserMemoryBindName(USER_A), "agent-user-memory-user-aaa-111");
assert.notEqual(svc.getUserMemoryBindName(USER_A), svc.getUserMemoryBindName(USER_B));

// 3. Docker mount construction (deterministic, no Docker daemon needed):
//    resolve() for docker+userId mounts ONLY that user's dir at /user-memory rw.
const bundle = capabilityProvider.resolve({ userId: USER_A, runtimeType: "docker" });
const memMount = bundle.mounts.find((m) => m.containerPath === "/user-memory");
assert.ok(memMount, "docker bundle mounts /user-memory");
assert.equal(memMount!.hostPath, svc.getHostDir(USER_A));
assert.equal(memMount!.readonly, false);
// Other user's dir is NOT mounted for A.
assert.equal(
  bundle.mounts.some((m) => m.hostPath === svc.getHostDir(USER_B)),
  false,
  "user B memory never mounted for user A"
);
// Docker prompt references the in-container memory path.
const prompt = (bundle.sdkOptions.appendSystemPrompt ?? "") + (bundle.sdkOptions.systemPrompt ?? "");
assert.ok(prompt.includes("/user-memory/MEMORY.md"), "docker prompt names the memory path");

// 4. Local mode does NOT emit a /user-memory mount (local confines via roots).
const localBundle = capabilityProvider.resolve({ userId: USER_A, runtimeType: "local" });
assert.equal(
  (localBundle.mounts || []).some((m) => m.containerPath === "/user-memory"),
  false,
  "local mode has no docker memory mount"
);

console.log("user-memory-runtime tests passed");
