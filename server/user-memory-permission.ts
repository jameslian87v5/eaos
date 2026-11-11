/**
 * user-memory-permission.ts — HOST (local-runtime) adapter for the user-memory
 * exact-path write rule. Resolves the raw tool path via workspace-guard (cwd +
 * confinement), sources the quota from runtime settings (passed in by the
 * caller), and delegates the pure decision + byte projection to the shared,
 * zero-dependency core (user-memory-permission-core.ts), which is ALSO imported
 * by the docker container hook — so the auto-approve rule has ONE definition.
 *
 * Rule (plan Task 4): Write/Edit auto-allow ONLY when the resolved target is
 * EXACTLY the authenticated user's MEMORY.md; enforce projected byte quota;
 * every other path (CLAUDE.md, /workspace/input, other users' files) falls
 * through to the existing approval/deny behavior (returns null).
 */
import path from "path";
import { resolveToolPath } from "./workspace-guard.js";
import {
  decideMemoryWriteCore,
  MEMORY_PATH_ARG,
  MEMORY_WRITE_TOOLS,
  type MemoryWriteDecision,
} from "./user-memory-permission-core.js";

export type { MemoryWriteDecision };

/**
 * Decide a memory-file write for the local runtime. Returns null when the call
 * does NOT target the memory file (caller falls through to normal approval/deny).
 */
export function decideMemoryWrite(args: {
  tool: string;
  toolInput: Record<string, unknown>;
  userMemoryRealPath: string;
  cwd: string;
  quotaBytes: number;
  readFile?: (p: string) => string;
}): MemoryWriteDecision | null {
  const { tool, toolInput, userMemoryRealPath, cwd, quotaBytes } = args;
  if (!MEMORY_WRITE_TOOLS.has(tool)) return null; // only Write/Edit are eligible
  const raw = toolInput?.[MEMORY_PATH_ARG];
  if (typeof raw !== "string") return null;
  const candidate = path.resolve(resolveToolPath(raw, cwd));
  const readFile = args.readFile ?? ((p: string) => require("fs").readFileSync(p, "utf8"));
  return decideMemoryWriteCore({
    tool,
    toolInput,
    candidatePath: candidate,
    memoryFilePath: userMemoryRealPath,
    quotaBytes,
    readFile,
  });
}
