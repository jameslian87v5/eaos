/**
 * local-sandbox-runtime.ts — M3-S2 wiring: RUNTIME_MODE=local-sandbox branch.
 *
 * Bridge between the existing control plane (CapabilityProvider.resolve() +
 * runtime settings) and the M3-S1 MicrosandboxAgentRuntime. This module does
 * NOT re-implement permission resolution — it compiles already-governed
 * control-plane outputs into the launch policy + hostMounts + resolved
 * execution policy, and gates the whole path on real availability.
 *
 * Frozen boundaries (M3-S2, engine gate upgraded in M3-S3A):
 *   - FAIL CLOSED, NO LOCAL FALLBACK: msb not configured, guest engine image
 *     not digest-proven (M3-S3A: loaded digest must equal the pinned digest),
 *     egress credential proxy absent, or resources inexpressible by msb →
 *     MicrosandboxUnavailableError with the exact reasons. The plain local
 *     runtime is NEVER silently used.
 *   - Guest-engine honesty: the pinned image's components are only as good as
 *     their real-Guest probe evidence (GUEST_IMAGE_ASSET_PROOFS); a rebuilt
 *     image with a different digest is unproven = unavailable. No fake
 *     runtime_ready.
 *   - Long-term model keys never enter the Guest: real Claude query goes
 *     through the M3-S3B Host credential proxy (Guest submits model_request
 *     INTENTS; Host stamps the governed model + executes with Host-only
 *     credentials; Guest sees only redacted results). Proxy absent ⇒ the
 *     availability gate refuses the whole path (deny-all Guest broker).
 */

import { mkdirSync, realpathSync } from "node:fs";
import {
  PINNED_GUEST_IMAGE,
  PINNED_MSB_VERSION,
  guestEngineStatus,
  probeGuestImageDigest,
} from "./microsandbox-policy.js";
import {
  MicrosandboxUnavailableError,
  createMicrosandboxRuntime,
  type MicrosandboxRuntimeOptions,
  type MsbHostMount,
} from "./microsandbox-runtime.js";
import {
  compilePolicyInput,
  createResolvedExecutionPolicy,
} from "./resolved-execution-policy.js";
import {
  ModelEgressProxy,
  resolveModelEgressTarget,
  type ModelEgressTargetConfig,
} from "./model-egress-proxy.js";
import { sharedSandboxLimiter, type SandboxConcurrencyLimiter } from "./microsandbox-concurrency.js";
import { sharedMicrosandboxMetrics } from "./microsandbox-metrics.js";
import { snapshotChatHistory } from "./local-sandbox-history.js";
import { chatStore } from "./chat-store.js";
import type { HistoryReplayMessage } from "./platform-runtime-protocol.js";
import type { CapabilityBundle } from "./capability-provider.js";
import type { RuntimeFactory } from "./agent-runtime.js";
import {
  getRuntimeSettings,
  validateLocalSandboxSettings,
  type RuntimeSettings,
} from "./runtime-settings.js";

/** Runtime modes the server knows (fail closed on anything else). */
export const KNOWN_RUNTIME_MODES = ["local", "docker", "local-sandbox"] as const;
export type KnownRuntimeMode = (typeof KNOWN_RUNTIME_MODES)[number];

/**
 * M3-S2 R1: apply the ALLOWED_TOOLS env override to a local-sandbox bundle —
 * REPLACES allowedTools (never `tools`), exactly matching the local and docker
 * branches (`envAllowedToolsOverride ?? bundle.sdkOptions.allowedTools`).
 * Applied BEFORE policy compilation so the resolved policy carries the
 * narrowed auto-approve list. Note: unlike docker (which passes the list
 * through to the container), the policy compiler validates allowed ⊆ exposed
 * and fails closed on an override naming an unexposed tool.
 */
export function applyAllowedToolsNarrowing(
  bundle: CapabilityBundle,
  override: readonly string[] | null | undefined,
): CapabilityBundle {
  if (!override) return bundle;
  return {
    ...bundle,
    sdkOptions: { ...bundle.sdkOptions, allowedTools: [...override] },
  };
}

/** Startup guard: unknown RUNTIME_MODE must refuse to boot, not default. */
export function assertKnownRuntimeMode(mode: string): asserts mode is KnownRuntimeMode {
  if (!(KNOWN_RUNTIME_MODES as readonly string[]).includes(mode)) {
    throw new Error(`unknown RUNTIME_MODE '${mode}' (known: ${KNOWN_RUNTIME_MODES.join(", ")}) — refusing to start (fail closed)`);
  }
}

export interface LocalSandboxFactoryDeps {
  /**
   * Guest engine preflight (default: GUEST_IMAGE_ASSET_PROOFS digest gate —
   * the LOADED image must match the pinned digest; unproven = unavailable).
   */
  engineStatus?: (image: string) => { ok: boolean; missing: string[] };
  /** Digest of the loaded msb image (default: probeGuestImageDigest via msb). */
  imageDigest?: (image: string) => string | null;
  /**
   * Egress credential proxy readiness (default: M3-S3B env-based target
   * resolution — base URL + credential both present ⇒ ready; absent ⇒ blocked,
   * deny-all Guest broker).
   */
  credentialProxyReady?: () => boolean;
  /** Egress target resolution override (tests). Default: resolveModelEgressTarget. */
  egressTarget?: () => ModelEgressTargetConfig | null;
  /** Resolve a host path to its REAL absolute form (msb rejects symlinked
   * sources like /tmp on macOS). Default: mkdir -p + realpathSync. */
  realpath?: (p: string) => string;
  /** Passthrough to createMicrosandboxRuntime for tests (skipProbe/probeDeps/launcher/launcherDeps). */
  runtimeDeps?: Partial<Pick<MicrosandboxRuntimeOptions, "skipProbe" | "probeDeps" | "launcher" | "launcherDeps">>;
  /** M3 closure: concurrency limiter (default: process-wide sharedSandboxLimiter). */
  limiter?: SandboxConcurrencyLimiter;
}

export interface LocalSandboxFactoryInput {
  chatId: string;
  /** Docker-shaped capability bundle (container-path mounts) from resolve(). */
  bundle: CapabilityBundle;
  /** Host dir mounted at guest /workspace (the chat workspace root). */
  workspaceHostDir: string;
  settings?: RuntimeSettings;
  /** msb binary path; default process.env.MSB_PATH. */
  msbPath?: string;
  deps?: LocalSandboxFactoryDeps;
}

export interface LocalSandboxAvailability {
  ok: boolean;
  reasons: string[];
}

/**
 * Collect EVERY blocking reason in one pass (diagnosable, not one-at-a-time):
 * msb config, guest engine assets, credential proxy, resource expressibility,
 * and host-path realpath-ability of every mount.
 */
export function checkLocalSandboxAvailability(input: LocalSandboxFactoryInput): LocalSandboxAvailability {
  const reasons: string[] = [];
  const deps = input.deps ?? {};

  const msbPath = input.msbPath ?? process.env.MSB_PATH;
  if (!msbPath) {
    reasons.push("MSB_PATH not configured (pinned msb runtime required — no auto-install)");
  }

  // M3-S3A engine gate: the proof manifest is keyed by immutable image digest.
  // Unknown image / unprobeable digest / digest mismatch ⇒ unavailable — a
  // rebuilt guest image is NEVER trusted until re-proven and re-pinned.
  const imageDigest = deps.imageDigest ?? ((image: string) => probeGuestImageDigest(msbPath, image));
  const engine = (deps.engineStatus ?? ((image: string) => guestEngineStatus(image, imageDigest(image))))(PINNED_GUEST_IMAGE);
  if (!engine.ok) {
    reasons.push(`guest engine unavailable on pinned image '${PINNED_GUEST_IMAGE}': ${engine.missing.join("; ")}`);
  }

  if (!(deps.credentialProxyReady ?? (() => (deps.egressTarget ?? resolveModelEgressTarget)() !== null))()) {
    reasons.push("model egress proxy not configured (MODEL_EGRESS_BASE_URL/ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY absent — long-term model keys never enter the Guest; real Claude query stays fail-closed)");
  }

  const settings = input.settings ?? getRuntimeSettings();
  try {
    const cfg = validateLocalSandboxSettings(settings);
    // msb only accepts integer --max-cpus (verified live, M3-S1 R1) — a
    // fractional setting is inexpressible: refuse, never round.
    if (!Number.isInteger(cfg.cpuCores)) {
      reasons.push(`cpuCores ${cfg.cpuCores} is fractional — msb only accepts integer --max-cpus (inexpressible, fail closed)`);
    }
  } catch (e) {
    reasons.push(`runtime settings outside MicroVM envelope: ${(e as Error).message}`);
  }

  const realpath = deps.realpath ?? ((p: string) => {
    mkdirSync(p, { recursive: true });
    return realpathSync(p);
  });
  try {
    realpath(input.workspaceHostDir);
    for (const m of input.bundle.mounts) realpath(m.hostPath);
  } catch (e) {
    reasons.push(`workspace/mount host path not real on disk: ${(e as Error).message}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Build the Session-facing RuntimeFactory for RUNTIME_MODE=local-sandbox.
 * Runs the availability gate EAGERLY (throws MicrosandboxUnavailableError with
 * every reason — rendered by the WS handler; no session is created half-way),
 * then compiles bundle+settings into the launch policy, hostMounts and the
 * resolved execution policy. The returned thunk re-validates inside
 * createMicrosandboxRuntime (probe included) — belt and suspenders.
 */
export function createLocalSandboxRuntimeFactory(input: LocalSandboxFactoryInput): RuntimeFactory {
  const availability = checkLocalSandboxAvailability(input);
  if (!availability.ok) {
    throw new MicrosandboxUnavailableError(
      `local-sandbox runtime unavailable: ${availability.reasons.join("; ")}`,
      { available: false, reason: availability.reasons.join("; ") },
    );
  }

  const settings = input.settings ?? getRuntimeSettings();
  const cfg = validateLocalSandboxSettings(settings);
  const deps = input.deps ?? {};
  const realpath = deps.realpath ?? ((p: string) => {
    mkdirSync(p, { recursive: true });
    return realpathSync(p);
  });

  // Single source of truth for mounts: the structural /workspace (rw, the
  // chat workspace) + every governed capability mount (skills ro, user memory
  // rw…). The one-way compiler turns the SAME list into the resolved policy's
  // workspace roots (engine-side governance), and buildMsbRunArgv enforces
  // bidirectional hostMounts coverage of the launch policy roots — no drift
  // between what the engine is allowed to touch and what is actually mounted.
  const effectiveMounts = [
    { hostPath: realpath(input.workspaceHostDir), containerPath: "/workspace", readonly: false },
    ...input.bundle.mounts.map((m) => ({ hostPath: realpath(m.hostPath), containerPath: m.containerPath, readonly: m.readonly })),
  ];
  const workspaceRoots: Array<{ path: string; access: "ro" | "rw" }> =
    effectiveMounts.map((m) => ({ path: m.containerPath, access: (m.readonly ? "ro" : "rw") as "ro" | "rw" }));
  const hostMounts: MsbHostMount[] =
    effectiveMounts.map((m) => ({ hostPath: m.hostPath, guestPath: m.containerPath, readonly: m.readonly }));

  const launchPolicy = {
    msbPath: input.msbPath ?? process.env.MSB_PATH ?? "",
    msbVersion: PINNED_MSB_VERSION,
    guestImage: PINNED_GUEST_IMAGE,
    memoryMb: cfg.memoryMb,
    cpuCores: cfg.cpuCores,
    workspaceRoots,
    networkEgress: "none" as const,
    idleTimeout: `${Math.max(1, Math.round(cfg.idleStopMs / 1000))}s`,
    // M3 closure: the docker-soft maxWorkspaceMb becomes a HARD mount quota on
    // MicroVM (msb `quota=<N>M`, host-enforced per writable mount). Settings
    // bounds [64, 102400] are integer-compatible with the launch-policy bound.
    workspaceQuotaMb: Math.round(cfg.maxWorkspaceMb),
  };
  // M3-S3B: when the Host egress proxy is configured, the policy carries the
  // host-proxy authorization (Guest engine start gate) and the runtime gets
  // the proxy + the governed modelRef the Host stamps on every model intent.
  const egressTarget = (deps.egressTarget ?? resolveModelEgressTarget)();
  const compiled = compilePolicyInput(
    { sdkOptions: input.bundle.sdkOptions, mounts: effectiveMounts },
    { defaultModel: cfg.defaultModel, memoryMb: cfg.memoryMb, cpuCores: cfg.cpuCores },
  );
  const policy = createResolvedExecutionPolicy({
    ...compiled,
    // Engine-side visibility of the SAME hard quota the launcher enforces —
    // one source (settings), two enforcement views, no drift.
    resourcePolicy: { ...compiled.resourcePolicy, workspaceQuotaMb: Math.round(cfg.maxWorkspaceMb) },
    ...(egressTarget !== null ? { egress: { mode: "host-proxy" as const } } : {}),
  });

  // M5-S4 C: bounded history snapshot for cold recovery. Captured EAGERLY at
  // factory creation time (the moment Session is being constructed = the
  // previous runtime was lost/stopped, so we want the history up to now).
  // Fail-closed: a store error throws here (MicrosandboxUnavailableError-
  // shaped — the WS handler renders it). restoreMode = "history_replay".
  let historySnapshot: ReadonlyArray<HistoryReplayMessage> = [];
  try {
    historySnapshot = snapshotChatHistory(input.chatId, chatStore);
  } catch (e) {
    throw new MicrosandboxUnavailableError(
      `local-sandbox runtime unavailable: history snapshot failed — ${(e as Error).message}`,
      { available: false, reason: `history snapshot failed: ${(e as Error).message}` },
    );
  }

  return (opts) => {
    // M3 closure — concurrency cap: an explicit REJECT (no queue) when the
    // platform already runs max DISTINCT agent sandboxes. R1-2: same-key
    // re-acquire is rejected (no refcount) — a chat must release its slot
    // first. Released on the runtime's close, on a failed create, AND on a
    // fatal async start/transport error (via onFatal), each exactly once.
    const limiter = deps.limiter ?? sharedSandboxLimiter();
    const slotKey = `chat:${input.chatId}`;
    const slot = limiter.tryAcquire(slotKey);
    if (!slot.ok) {
      throw new MicrosandboxUnavailableError(slot.reason, { available: false, reason: slot.reason });
    }
    let released = false;
    const releaseOnce = (): void => {
      if (!released) {
        released = true;
        limiter.release(slotKey);
      }
    };
    let rt: ReturnType<typeof createMicrosandboxRuntime>;
    try {
      rt = createMicrosandboxRuntime({
        launchPolicy,
        policy,
        hostMounts,
        ...(egressTarget !== null ? { egress: { proxy: new ModelEgressProxy({ target: egressTarget }), modelRef: policy.modelRef } } : {}),
        ...(opts?.resume ? { resumeToken: opts.resume } : {}),
        ...(historySnapshot.length > 0 ? { history: historySnapshot } : {}),
        ...(deps.runtimeDeps ?? {}),
        onFatal: releaseOnce,
        // M5-S3: lifecycle metrics — boot/recovery/stop timing, status, failure
        // category, resource policy envelope. No prompt/subject/credential/payload.
        metrics: sharedMicrosandboxMetrics(),
        metricsResourcePolicy: { memoryMb: cfg.memoryMb, cpuCores: cfg.cpuCores, workspaceQuotaMb: Math.round(cfg.maxWorkspaceMb) },
      });
    } catch (e) {
      releaseOnce();
      throw e;
    }
    const origClose = rt.close.bind(rt);
    rt.close = async () => {
      try {
        return await origClose();
      } finally {
        releaseOnce();
      }
    };
    return rt;
  };
}
