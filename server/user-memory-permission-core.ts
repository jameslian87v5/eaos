/**
 * user-memory-permission-core.ts — ZERO-DEPENDENCY pure decision logic for the
 * user-memory exact-path write rule + quota enforcement.
 *
 * Deliberately free of host-only imports (no runtime-settings, no db, no fs, no
 * workspace-guard): only `path` (node builtin) and the `Buffer` global. This is
 * COPIED INTO the Docker image (see docker/Dockerfile) and imported by BOTH:
 *   - host hook:  server/user-memory-permission.ts (local runtime)
 *   - container:  docker/agent-entry.ts           (docker runtime)
 * One implementation of the decision → no drift between runtimes. This matters
 * because the rule AUTO-APPROVES writes — divergence would silently create a
 * weaker path on one side.
 *
 * Kept OUT of the core (per-side):
 *   - resolving the raw tool path to an absolute candidate
 *       host: workspace-guard.resolveToolPath(raw, cwd)
 *       container: path.resolve(target) against the fixed /user-memory/MEMORY.md
 *   - sourcing the quota (host: runtime settings; container: env var)
 *   - reading the current file content for Edit projection (injected)
 */
import path from "path";

export interface MemoryWriteDecision {
  decision: "allow" | "deny";
  reason?: string;
}

export const MEMORY_WRITE_TOOLS = new Set(["Write", "Edit"]);
export const MEMORY_PATH_ARG = "file_path";

/** Project the resulting document byte length for a Write/Edit against the
 *  memory file. `readFile` injected so the core stays disk-free / testable. */
export function projectMemoryBytes(args: {
  tool: string;
  toolInput: Record<string, unknown>;
  filePath: string;
  readFile: (p: string) => string;
}): number {
  const { tool, toolInput, filePath, readFile } = args;
  if (tool === "Write") {
    return Buffer.byteLength(String(toolInput.content ?? ""), "utf8");
  }
  if (tool === "Edit") {
    let current = "";
    try {
      current = readFile(filePath);
    } catch {
      current = "";
    }
    const oldS = String(toolInput.old_string ?? "");
    const newS = String(toolInput.new_string ?? "");
    const next = toolInput.replace_all
      ? current.split(oldS).join(newS)
      : current.replace(oldS, newS);
    return Buffer.byteLength(next, "utf8");
  }
  return 0;
}

/**
 * Decide a memory-file write given an ALREADY-RESOLVED absolute candidate path.
 * Returns null when the call does NOT target the memory file (caller falls
 * through to normal approval/deny). Otherwise allow (within quota) or deny.
 */
export function decideMemoryWriteCore(args: {
  tool: string;
  toolInput: Record<string, unknown>;
  candidatePath: string; // absolute, resolved by the caller
  memoryFilePath: string; // absolute
  quotaBytes: number;
  readFile: (p: string) => string;
}): MemoryWriteDecision | null {
  const { tool, toolInput, candidatePath, memoryFilePath, quotaBytes, readFile } = args;
  if (!MEMORY_WRITE_TOOLS.has(tool)) return null;
  if (path.resolve(candidatePath) !== path.resolve(memoryFilePath)) return null;
  const projected = projectMemoryBytes({ tool, toolInput, filePath: memoryFilePath, readFile });
  if (projected > quotaBytes) {
    return { decision: "deny", reason: `user memory quota exceeded (${projected} > ${quotaBytes} bytes)` };
  }
  return { decision: "allow" };
}
