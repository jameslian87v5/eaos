/**
 * sdk-cli-check.ts — M6-fix (evt_20260819125001): pre-start detection for the
 * Claude Agent SDK native CLI binary.
 *
 * Symptom fixed: local runtime booted fine, then every chat turn failed with
 * "Native CLI binary for darwin-arm64 not found. Reinstall
 * @anthropic-ai/claude-agent-sdk without --omit=optional, or set
 * options.pathToClaudeCodeExecutable." — because the install that produced
 * node_modules had skipped the SDK's OPTIONAL platform packages (the lock file
 * was correct; @anthropic-ai/claude-agent-sdk-<platform>-<arch> was simply
 * absent from node_modules).
 *
 * This module mirrors the SDK's own resolution (sdk.mjs ZT()): resolve
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` via createRequire
 * anchored AT THE SDK'S OWN ENTRY (so a hoisted/duplicated node_modules cannot
 * diverge from what the SDK will actually spawn), then existsSync.
 *
 * Used two ways:
 *   - server.ts boot gate (local runtime only): fail fast with the remediation
 *     instead of a cryptic error on the first chat message.
 *   - standalone CLI: `npm run check:sdk-cli` (deploy/pipeline check).
 *
 * No protocol/architecture change (event constraint): detection only.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SDK_PKG = "@anthropic-ai/claude-agent-sdk";

/** Injectable seams (same minimal pattern as provider-connectors FetchLike). */
export type ResolveLike = (spec: string) => string;
export type ExistsLike = (p: string) => boolean;

export interface SdkCliCheckResult {
  ok: boolean;
  /** Absolute path of the binary the SDK will spawn (null when missing). */
  path: string | null;
  /** null when ok; otherwise a remediation message safe to print at boot. */
  message: string | null;
}

/** Candidate specifiers, mirroring the SDK (musl variants probed on linux,
 *  `.exe` suffix on win32). Order differs from the SDK (it prefers musl first
 *  when detected) but for an existence check order is irrelevant. */
export function platformCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string[] {
  const exe = platform === "win32" ? ".exe" : "";
  const base = `${SDK_PKG}-${platform}-${arch}`;
  if (platform === "linux") {
    return [`${base}/claude${exe}`, `${base}-musl/claude${exe}`];
  }
  return [`${base}/claude${exe}`];
}

/** Default resolver: anchor at the SDK's own entry so we probe exactly the
 *  copy the SDK will load from (not a parallel hoisted duplicate). */
const defaultResolve: ResolveLike = (spec) => {
  const req = createRequire(import.meta.url);
  const sdkEntry = req.resolve(SDK_PKG); // e.g. .../claude-agent-sdk/sdk.mjs
  return createRequire(sdkEntry).resolve(spec);
};

export function sdkCliRemediation(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return (
    `Native CLI binary for ${platform}-${arch} not found — the SDK's optional ` +
    `platform package ${SDK_PKG}-${platform}-${arch} is missing from node_modules ` +
    `(typically an install ran with --omit=optional). Fix: run \`npm install\` ` +
    `without omitting optional deps, or set options.pathToClaudeCodeExecutable. ` +
    `See docs/06-deployment/operations-runbook.md (SDK CLI 缺失).`
  );
}

/**
 * M3-S2 R1: the host SDK-CLI preflight applies ONLY to the `local` runtime —
 * `docker` runs the CLI inside the image, and `local-sandbox` runs the engine
 * in the Guest (host CLI presence is neither required nor meaningful; the
 * local-sandbox availability gate diagnoses its own Guest engine assets).
 */
export function sdkCliCheckApplies(runtimeMode: string): boolean {
  return runtimeMode === "local";
}

export function checkSdkCli(opts?: {
  platform?: NodeJS.Platform;
  arch?: string;
  resolveImpl?: ResolveLike;
  existsImpl?: ExistsLike;
}): SdkCliCheckResult {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  const resolveImpl = opts?.resolveImpl ?? defaultResolve;
  const existsImpl = opts?.existsImpl ?? existsSync;
  for (const spec of platformCandidates(platform, arch)) {
    try {
      const p = resolveImpl(spec);
      if (existsImpl(p)) return { ok: true, path: p, message: null };
    } catch {
      /* optional package not installed — try next candidate */
    }
  }
  return { ok: false, path: null, message: sdkCliRemediation(platform, arch) };
}

// Standalone CLI mode: `npx tsx server/sdk-cli-check.ts` → exit 1 with the
// remediation when missing (usable in deploy pipelines / pre-demo checks).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = checkSdkCli();
  if (r.ok) {
    console.log(`[sdk-cli-check] OK — ${r.path}`);
  } else {
    console.error(`[sdk-cli-check] FATAL — ${r.message}`);
    process.exit(1);
  }
}
