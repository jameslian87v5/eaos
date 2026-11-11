/**
 * microsandbox-concurrency.ts — M3 closure: host-side concurrency cap +
 * resource reclamation for the local MicroVM runtime.
 *
 * Two small, explicit pieces (Occam — no queue machinery, no scheduler):
 *
 * ① SandboxConcurrencyLimiter: a per-chatId slot registry. When DISTINCT
 *    agents ≥ max, further sandbox starts are REJECTED with a diagnosable
 *    reason (surfaced as MicrosandboxUnavailableError by the factory thunk).
 *    R1-2: same-key re-acquire is REJECTED (no refcount, no unlimited
 *    re-entry) — a chat that already holds a slot must release it (close or
 *    fatal) before a new runtime can start for the same chat. Explicit REJECT
 *    (no queueing) is the chosen policy: a queued start would park a WS
 *    session behind an invisible waitlist; the caller retries and sees why not.
 *
 * ② reapOrphanMicrovmSandboxes: `msb list --format json` → any sandbox named
 *    `eaos-microvm-*` that the limiter does NOT track is a leftover from a
 *    crashed/killed host process → stop + rm. Runs at server boot for
 *    RUNTIME_MODE=local-sandbox (the no-orphans backstop; per-runtime close()
 *    remains the primary cleanup).
 *
 * Fail-closed: a reaper that cannot LIST simply reports and refuses to
 * guess — it never deletes on a parse failure.
 */

import { spawnSync } from "node:child_process";

/** Default cap on DISTINCT concurrently-live MicroVM sandboxes. */
export const DEFAULT_MAX_CONCURRENT_SANDBOXES = 4;

/** Sandbox name prefix owned by this platform (mirrors MicrosandboxAgentRuntime). */
export const EAOS_MICROVM_NAME_PREFIX = "eaos-microvm-";

/** Pre-rename prefix; the reaper keeps recognizing it so stale sandboxes from
 * before the identity rename are still cleaned up. */
export const LEGACY_MICROVM_NAME_PREFIX = "chatapp-microvm-";

export function resolveMaxConcurrentSandboxes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LOCAL_SANDBOX_MAX_CONCURRENT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_CONCURRENT_SANDBOXES;
  return Math.min(Math.floor(raw), 64);
}

export interface SandboxConcurrencyLimiter {
  /**
   * Acquire a slot for `key`. R1-2: same-key re-acquire is REJECTED (no
   * refcount — a chat must release its slot before starting a new runtime).
   */
  tryAcquire(key: string): { ok: true } | { ok: false; reason: string };
  /** Release the slot for `key` (no-op if not held). */
  release(key: string): void;
  /** Keys currently holding a slot (concurrency = length). */
  heldKeys(): readonly string[];
}

export function createSandboxConcurrencyLimiter(max: number): SandboxConcurrencyLimiter {
  const held = new Set<string>();
  return {
    tryAcquire(key) {
      if (!key) return { ok: false, reason: "concurrency key required" };
      if (held.has(key)) {
        return {
          ok: false,
          reason: `local-sandbox concurrency: chat '${key}' already holds a slot — release the previous runtime (close or fatal) before starting a new one (no unlimited re-entry)`,
        };
      }
      if (held.size >= max) {
        return {
          ok: false,
          reason: `local-sandbox concurrency cap reached (${held.size}/${max} sandboxes — LOCAL_SANDBOX_MAX_CONCURRENT; rejected, retry when a sandbox stops)`,
        };
      }
      held.add(key);
      return { ok: true };
    },
    release(key) {
      held.delete(key);
    },
    heldKeys() {
      return [...held];
    },
  };
}

/** Process-wide limiter (env-configured once per process). */
let sharedLimiter: SandboxConcurrencyLimiter | null = null;
export function sharedSandboxLimiter(): SandboxConcurrencyLimiter {
  if (!sharedLimiter) sharedLimiter = createSandboxConcurrencyLimiter(resolveMaxConcurrentSandboxes());
  return sharedLimiter;
}

// ─── Orphan reclamation ──────────────────────────────────────────────────────

export interface ReaperDeps {
  /** One-shot msb invocation (DI for tests; default spawnSync). */
  run?: (argv: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => { status: number | null; stdout: string; stderr: string };
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ReapResult {
  /** orphans found → removed; false on ANY listing/parse failure (refuses to guess). */
  ok: boolean;
  reason?: string;
  reaped: string[];
}

/**
 * Remove every platform-owned (`eaos-microvm-*`, or legacy `chatapp-microvm-*`)
 * sandbox NOT tracked by the limiter. Order
 * per sandbox: stop (best-effort — rm refuses on running) then rm. A sandbox
 * created between list and rm by a concurrent factory start is protected by
 * the limiter check being re-read per name.
 */
export function reapOrphanMicrovmSandboxes(
  msbPath: string,
  trackedKeys: readonly string[],
  deps: ReaperDeps = {},
): ReapResult {
  const run =
    deps.run ??
    ((argv: string[], o: { timeoutMs: number; env: NodeJS.ProcessEnv }) => {
      const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: o.timeoutMs, env: o.env });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    });
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 30_000;

  const list = run([msbPath, "list", "--format", "json"], { timeoutMs, env });
  if (list.status !== 0 || !list.stdout.trim()) {
    return { ok: false, reason: `msb list failed (status ${list.status}): ${list.stderr.slice(0, 160)}`, reaped: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    return { ok: false, reason: "msb list --format json returned unparseable output (refusing to guess)", reaped: [] };
  }
  const rows = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : Array.isArray((parsed as { sandboxes?: unknown })?.sandboxes)
      ? ((parsed as { sandboxes: Array<Record<string, unknown>> }).sandboxes)
      : null;
  if (rows === null) {
    return { ok: false, reason: "msb list --format json returned an unexpected shape (refusing to guess)", reaped: [] };
  }
  const tracked = new Set(trackedKeys);
  const reaped: string[] = [];
  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name : "";
    const owned =
      name.startsWith(EAOS_MICROVM_NAME_PREFIX) || name.startsWith(LEGACY_MICROVM_NAME_PREFIX);
    if (!owned || tracked.has(name)) continue;
    run([msbPath, "stop", name], { timeoutMs: 10_000, env }); // best-effort (stopped/rm race)
    const rm = run([msbPath, "rm", name], { timeoutMs, env });
    if (rm.status === 0) reaped.push(name);
  }
  return { ok: true, reaped };
}
