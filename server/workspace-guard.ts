/**
 * workspace-guard.ts — local-mode path confinement.
 *
 * This is the **local-mode layer** of "路径安全 4 层校验". The local runtime
 * runs the Claude Agent SDK `query()` **in-process on the HOST filesystem**.
 * Without this guard, `Read/Grep/Glob/Write/Edit` — which sit in `allowedTools`
 * for read-only/问数 profiles — bypass the PreToolUse hook entirely
 * (ai-client.ts: `if (allowed.includes(tool)) return {}`) and can read ANY host
 * path: other tenants' `data/workspaces/<otherChatId>/` (cross-tenant leak) and
 * secrets (`.env`). Docker mode's confinement already lives in
 * `docker/agent-entry.ts` (prefix checks); this module is the local-mode mirror.
 *
 * Pattern reused from `server/mcp-config.ts` (realpathSync + path.sep-aware prefix).
 *
 * KNOWN LIMITATION (software confinement, NOT OS-level): this constrains only
 * `tool_use` that flows through the SDK PreToolUse hook. Code executing outside
 * the tool layer (a malicious MCP subprocess, an SDK/dependency bug) is NOT
 * constrained here — that requires L2 (nsjail/seccomp) or L3 (docker/microVM).
 * See docs/开发计划/agent-runtime-isolation-plan.md (L1–L4 tiered isolation).
 */
import path from "path";
import fs from "fs";

export interface PathCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * target must EQUAL root OR live directly under `<root>/` (path.sep-aware, so
 * `/workspace/evil` is NOT treated as under `/workspace` — avoids prefix-collision
 * bypass where one root name is a prefix of another).
 */
function isUnderRoot(realTarget: string, realRoot: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * Resolve allowed roots to canonical realpaths. Roots that do not yet exist are
 * skipped (deny-default: an empty result means nothing is allowed).
 *
 * Callers that need a root to exist (e.g. a freshly-created chat whose workspace
 * dir has not been materialized yet) should `mkdirSync(root, {recursive:true})`
 * BEFORE calling this, so realpath succeeds.
 */
export function realpathRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(fs.realpathSync(r));
    } catch {
      // root missing → skip; nothing under a non-existent root can be allowed
    }
  }
  return out;
}

/**
 * Check whether `targetPath` is confined within any of the (already-realpath'd)
 * `realRoots`.
 *
 * - Symlinks are followed via `realpathSync`: an in-workspace symlink that
 *   points OUTSIDE resolves outside → rejected.
 * - For a path that does not yet exist (e.g. `Write` creating a new file,
 *   ENOENT on realpath), fall back to resolving the parent dir and checking it.
 */
export function isPathAllowed(targetPath: string, realRoots: string[]): PathCheckResult {
  if (realRoots.length === 0) {
    return { ok: false, reason: "no workspace roots configured" };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(targetPath);
  } catch {
    // ENOENT: resolve the parent and check the parent is within a root.
    const parent = path.dirname(targetPath);
    let realParent: string;
    try {
      realParent = fs.realpathSync(parent);
    } catch {
      return { ok: false, reason: "path does not exist and parent is not resolvable" };
    }
    return realRoots.some((root) => isUnderRoot(realParent, root))
      ? { ok: true }
      : { ok: false, reason: "path is outside the workspace jail" };
  }

  return realRoots.some((root) => isUnderRoot(realTarget, root))
    ? { ok: true }
    : { ok: false, reason: "path is outside the workspace jail" };
}

/**
 * Resolve a tool target path to absolute, relative to the SDK `cwd` (the
 * workspace root) when it is relative.
 *
 * The SDK resolves relative tool paths (e.g. `file.txt`, `src/a.ts`) against
 * the `cwd` option passed to `query()` — NOT against `process.cwd()`. The
 * PreToolUse hook must match that semantics BEFORE checking confinement, or
 * in-workspace relative paths get mis-resolved against the server's process
 * cwd and wrongly denied. See ai-client.ts hook. (Codex review evt_20260724013725)
 *
 * Absolute targets are returned unchanged.
 */
export function resolveToolPath(target: string, cwd: string): string {
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}
