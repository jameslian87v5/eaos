/**
 * microsandbox-policy.ts — MicroVM launch policy validation (M3-S1).
 *
 * Plan §6 供应链铁律 (docs/开发计划/local-microvm-runtime-整体研发计划.md):
 *   - msb 与 libkrun 二进制按版本 pin + checksum 校验；生产禁用 msb update；
 *   - Guest 镜像固定版本；CPU/内存上下限；workspace 目录白名单；
 *   - 只读挂载显式声明；网络默认拒绝 + 有限出口（M1 实测：--no-net +
 *     --net-strict fail-closed）。
 *
 * ANY invalid input or unavailable runtime → FAIL CLOSED (throw
 * MicrosandboxPolicyError). The caller must refuse to start the runtime —
 * never degrade to the plain local runtime (M3-S1 hard boundary).
 *
 * Pure validation module: no fs/network in the happy path. The filesystem /
 * binary probes are separate injected deps so tests stay DI-only.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";

export const MICROSANDBOX_POLICY_VERSION = 1 as const;

/** Pinned, verified msb runtime (M1 evidence base). */
export const PINNED_MSB_VERSION = "0.6.18" as const;
/**
 * Pinned guest ENGINE image (M3-S3A, supply-chain hardened in R1): reproducible
 * OCI image built from `docker/guest/` (pinned Node 20 base by immutable
 * digest + compiled worker entry + transitive server files + pinned Claude
 * Agent SDK 0.3.185, no credentials, no Debian package installs). Docker is the
 * BUILD tool only — the runtime path is pure msb (`msb image load` + `msb run`).
 */
export const PINNED_GUEST_IMAGE = "eaos-guest:0.1.4" as const;
/**
 * Immutable identity of the pinned guest image, from `msb image inspect
 * eaos-guest:0.1.4 --format json` (loaded via `msb image load`). The engine
 * gate refuses any loaded image whose digest differs — a rebuilt image must be
 * re-proven against the real Guest before the pin is updated.
 * 0.1.4 (M3 closure R2): rebuilt from 3332112 to carry the R1 worker source —
 * `show_ui` advertised with the A2UI-contract schema + policy-bound (deny-check
 * before a2ui parking) and symlink-escape prevention in Read/Write/Edit
 * (realpath target/parent checks against policy roots). Re-proven live
 * end-to-end against the real MicroVM (see GUEST_IMAGE_ASSET_PROOFS).
 */
export const PINNED_GUEST_IMAGE_DIGEST =
  "sha256:8aed188da5dea196efcd271b0585fac7b3db7b91b3f23953758c80ca74968a3b" as const;
/**
 * Pinned base image (node:20-slim, linux/arm64) — pinned by immutable digest in
 * `docker/guest/Dockerfile` so a drifting upstream tag cannot change the build.
 * RepoDigest of the image actually verified on this host.
 */
export const PINNED_GUEST_BASE_IMAGE =
  "node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0" as const;

/** Resource bounds — the ONLY envelope a local-sandbox agent may request. */
export const RESOURCE_BOUNDS = {
  minMemoryMb: 128,
  maxMemoryMb: 4096,
  minCpuCores: 0.25,
  maxCpuCores: 4,
} as const;

/** Bounded workspace roots (≤16 mirrors ResolvedExecutionPolicy MAX_ROOTS). */
const MAX_ROOTS = 16;
const MAX_EGRESS_HOSTS = 64;

/**
 * Platform-fixed msb checksum manifest — THE supply-chain pin. Entries are
 * owner-verified assets only; callers can NEVER supply an expected checksum
 * (self-reporting was removed in M3-S1 R1). Platforms without an entry are
 * unavailable by design — no auto-install, no msb update.
 */
export const MSB_CHECKSUM_MANIFEST: Readonly<Record<string, string>> = Object.freeze({
  // Verified live on this host (macOS arm64, msb 0.6.18 release tarball).
  "darwin-arm64": "e1126c2eb873757f862a5321dcb7c7206f8617132d8a2892ab42831b380660b6",
});

/** Resolve the pinned checksum for a platform/arch (null = unpinned → unavailable). */
export function pinnedMsbChecksum(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  return MSB_CHECKSUM_MANIFEST[`${platform}-${arch}`] ?? null;
}

/**
 * Guest engine asset PROOF manifest (M3-S3A): what each pinned guest image is
 * PROVEN to contain, anchored to the image's immutable digest. A row is only
 * earned by real Guest probes (`msb run <image> -- …` on this host, recorded
 * in provenBy) — never assumed from the Dockerfile. At runtime the engine gate
 * re-probes the LOADED image digest via `msb image inspect`; unknown image,
 * unprobeable digest, or digest mismatch ⇒ unavailable (fail closed). A
 * boolean-only manifest (M3-S2's GUEST_ENGINE_ASSETS) could not express any of
 * that and is replaced by this.
 */
export interface GuestImageAssetProof {
  readonly image: string;
  readonly digest: string;
  readonly components: Readonly<{ node: boolean; workerEntry: boolean; claudeSdk: boolean }>;
  /** Real Guest probe outputs that earned the components row (never assumed). */
  readonly provenBy: Readonly<{
    nodeVersion: string;
    workerProbe: string;
    sdkResolve: string;
  }>;
}

export const GUEST_IMAGE_ASSET_PROOFS: Readonly<Record<string, GuestImageAssetProof>> = Object.freeze({
  [PINNED_GUEST_IMAGE]: Object.freeze({
    image: PINNED_GUEST_IMAGE,
    digest: PINNED_GUEST_IMAGE_DIGEST,
    components: Object.freeze({ node: true, workerEntry: true, claudeSdk: true }),
    // Proven live 2026-09-17 on this host (msb 0.6.18, darwin-arm64) against
    // eaos-guest:0.1.4 (M3-closure R2 rebuild from 3332112: R1 worker source
    // — show_ui A2UI-contract schema + policy-bound parking, symlink-escape
    // prevention in Read/Write/Edit; base pinned by digest, no Debian package
    // installs). Real Guest probes run via `msb run eaos-guest:0.1.4 -- …`:
    //   msb run -- node --version → v20.20.2
    //   msb run -- node -e "require.resolve('@anthropic-ai/claude-agent-sdk')"
    //     → /opt/agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
    //   msb run -- sh -c 'env | grep -ciE "anthropic|api_key|auth_token|app_key|jwt|secret|token"'
    //     → 0 (no credential variable in the Guest env)
    // Full loop driven end-to-end through the Host egress credential proxy
    // (DashScope anthropic-compatible endpoint, governed model glm-5.2 — the
    // proxy stamps the model literally; `opus` is rejected by the provider, so
    // the smoke carries the real model id): runtime_ready → sendMessage("Reply
    // with exactly: sandbox-ok") → Guest model_request intent → Host proxy
    // real provider call → assistant_text:"sandbox-ok" → turn_completed. Guest
    // env scan clean (8 vars sampled, 0 credential matches); event frames and
    // report scanned for the real credential values — zero leaks.
    provenBy: Object.freeze({
      nodeVersion: "v20.20.2",
      workerProbe:
        "start frame (policy egress host-proxy) → {\"type\":\"runtime_ready\"}; full model loop live-proven against 0.1.4: Guest model_request intent → Host proxy real provider call (governed model glm-5.2, DashScope anthropic-compatible endpoint) → assistant_text:\"sandbox-ok\" → turn_completed; Guest env scan clean (8 vars sampled, 0 credential var/value); event frames + report scan zero credential leaks",
      sdkResolve: "/opt/agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    }),
  } satisfies GuestImageAssetProof),
  // 0.1.3 provenBy (M3 closure C1–C4, 2026-09-17) retained for history:
  //   node v20.20.2 / SDK resolve / Guest env 0 / runtime_ready → Read real
  //   content same-turn / Write gated on approval / unexposed tool refused
  //   zero-exec / APPROVED Bash fail-closed not-implemented / refusals ride
  //   same-runId continuation / terminal → turn_completed / 64M quota 8M write
  //   ok + 100M refused. Digest: sha256:587dc002…9bde4. Superseded by 0.1.4.
});

/**
 * M3 closure — guest image RELEASE SIGNATURES (ed25519 over
 * `<image>@<pinned digest>`). The digest pin guards against a DRIFTING loaded
 * image; the signature guards the pin ITSELF: a pin edit without platform
 * release sign-off is unavailable, exactly like a digest mismatch. The
 * private key never lives in this repo — re-pinning a rebuilt image requires
 * re-proving the Guest probes AND re-signing the new digest
 * (scripts/sign-guest-image.mjs, run by the release holder).
 *
 * R3 — FIXED TRUST ANCHOR: this public key is the STABLE release root. It is
 * NOT rotated per image rebuild. The R2 private key (established 2026-09-17
 * to sign 0.1.4) was persisted to a repo-external 0600 location as the fixed
 * release key; future rebuilt images are re-signed with THIS key (ed25519 is
 * deterministic, so re-signing the same `<image>@<digest>` reproduces the
 * identical hex). Generating a new keypair per rebuild is FORBIDDEN — it
 * silently rotates the trust anchor. Key generation/persistence/rotation/
 * loss handling: docs/06-deployment/release-key-runbook.md. The private key
 * PATH/contents are NEVER written into source, evidence, or logs.
 */
export const GUEST_IMAGE_RELEASE_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAejGnYEaLUsOW7rMU8BuzJ4qC17o0Muj3DNUOcYWVttI=
-----END PUBLIC KEY-----` as const;

/** image → hex(ed25519 signature over `${image}@${digest}`). */
export const GUEST_IMAGE_RELEASE_SIGNATURES: Readonly<Record<string, string>> = Object.freeze({
  // Signed 2026-09-17 by the FIXED M3 release key (R3 anchor — see
  // GUEST_IMAGE_RELEASE_SIGNING_PUBLIC_KEY comment + release-key-runbook.md)
  // over
  // "eaos-guest:0.1.4@sha256:8aed188da5dea196efcd271b0585fac7b3db7b91b3f23953758c80ca74968a3b"
  // AFTER the live re-proof above. Re-signing this payload with the fixed key
  // reproduces this exact hex (ed25519 deterministic); the signature gate
  // (S.1) verifies it under the pinned public key. Re-pinning without
  // re-signing fails the engine gate.
  [PINNED_GUEST_IMAGE]:
    "4bbdc5977c99a27371322f389b87ca5c669f1094986fb772bf56ee0dd8e02d33fef419c41dfe9912512d03d3505716b7a9dce8b069154ea50ea1543833fdd50b",
});

/**
 * Guest engine preflight: ok only when the image has a proof row, the LOADED
 * image's digest is probeable AND equals the pinned digest, the pinned digest
 * carries a VALID release signature, and every component is proven present.
 * Anything else → missing reasons (fail closed).
 */
export function guestEngineStatus(
  image: string,
  actualDigest: string | null,
  deps: { signatures?: Readonly<Record<string, string>>; signingPublicKey?: string } = {},
): { ok: boolean; missing: string[] } {
  const proof = GUEST_IMAGE_ASSET_PROOFS[image];
  if (!proof) {
    return { ok: false, missing: [`guest image '${image}' has no GUEST_IMAGE_ASSET_PROOFS entry (unknown asset = unavailable)`] };
  }
  if (actualDigest === null || actualDigest === undefined) {
    return { ok: false, missing: [`guest image '${image}' digest not probeable (image not loaded or inspect failed — unproven = unavailable)`] };
  }
  if (actualDigest !== proof.digest) {
    return { ok: false, missing: [`guest image '${image}' digest MISMATCH: loaded ${actualDigest} ≠ pinned ${proof.digest} (rebuilt image must be re-proven and re-pinned)`] };
  }
  // M3 closure: release-signature gate — the pinned digest must carry a valid
  // ed25519 signature from the platform release key ON TOP of the digest pin.
  // A pinned-but-unsigned digest (pin edit without release sign-off) or a
  // tampered signature is unavailable, exactly like a digest mismatch.
  const signatures = deps.signatures ?? GUEST_IMAGE_RELEASE_SIGNATURES;
  const sig = signatures[image];
  if (!sig) {
    return { ok: false, missing: [`guest image '${image}' has no release signature (re-pinning requires signing the new digest with the platform release key)`] };
  }
  try {
    const key = createPublicKey(deps.signingPublicKey ?? GUEST_IMAGE_RELEASE_SIGNING_PUBLIC_KEY);
    const okSig = edVerify(null, Buffer.from(`${image}@${proof.digest}`, "utf8"), key, Buffer.from(sig, "hex"));
    if (!okSig) {
      return { ok: false, missing: [`guest image '${image}' release signature INVALID (digest or signature tampered — fail closed)`] };
    }
  } catch {
    return { ok: false, missing: [`guest image '${image}' release signature not verifiable (malformed key/signature)`] };
  }
  const missing: string[] = [];
  const c = proof.components;
  if (!c.node) missing.push("node runtime");
  if (!c.workerEntry) missing.push("worker entry (local-agent-entry)");
  if (!c.claudeSdk) missing.push("claude agent sdk");
  return { ok: missing.length === 0, missing };
}

/**
 * Probe the digest of a LOADED msb image (`msb image inspect --format json`).
 * Returns null unless the inspect succeeds and yields a string digest — the
 * caller treats null as "unproven = unavailable". No msbPath → null (the msb
 * config reason is reported separately by the availability gate).
 */
export function probeGuestImageDigest(
  msbPath: string | null | undefined,
  image: string,
  deps: { inspect?: (msbPath: string, image: string) => string | null } = {},
): string | null {
  if (!msbPath) return null;
  const inspect =
    deps.inspect ??
    ((p: string, img: string) => {
      const r = spawnSync(p, ["image", "inspect", img, "--format", "json"], { encoding: "utf8", timeout: 15000 });
      if (r.status !== 0 || !r.stdout) return null;
      try {
        const parsed = JSON.parse(r.stdout) as { digest?: unknown };
        return typeof parsed.digest === "string" && parsed.digest ? parsed.digest : null;
      } catch {
        return null;
      }
    });
  return inspect(msbPath, image);
}

export class MicrosandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosandboxPolicyError";
  }
}

export interface MicrosandboxLaunchPolicyInput {
  /** Absolute path to the pinned msb binary (env-driven verified runtime). */
  msbPath: string;
  /** Expected msb version string (must equal PINNED_MSB_VERSION). */
  msbVersion: string;
  guestImage: string;
  memoryMb: number;
  cpuCores: number;
  /** Guest-visible workspace mount points (absolute, no ".."). */
  workspaceRoots: Array<{ path: string; access: "ro" | "rw" }>;
  /**
   * Network egress. "none" is the only safe default; "declared" requires an
   * explicit host allowlist (RFC1918/link-local/metadata are refused by the
   * runtime layer regardless — msb --net-strict).
   */
  networkEgress: "none" | "declared";
  declaredHosts?: string[];
  /** Per-sandbox idle timeout (msb flag value, e.g. "60s"). */
  idleTimeout: string;
  /**
   * M3 closure — HARD per-agent workspace write quota (MB). Compiled into
   * `--mount-dir …:quota=<N>M` on every WRITABLE mount (msb host-enforced);
   * the Guest physically cannot exceed it. Within WORKSPACE_QUOTA_BOUNDS or
   * absent (absent = no quota flag; the factory always sets it from
   * runtime-settings maxWorkspaceMb).
   */
  workspaceQuotaMb?: number;
}

export interface MicrosandboxLaunchPolicy {
  readonly policyVersion: typeof MICROSANDBOX_POLICY_VERSION;
  readonly msbPath: string;
  readonly msbVersion: string;
  readonly msbSha256: string;
  readonly guestImage: string;
  readonly memoryMb: number;
  readonly cpuCores: number;
  readonly workspaceRoots: ReadonlyArray<Readonly<{ path: string; access: "ro" | "rw" }>>;
  readonly networkEgress: "none" | "declared";
  readonly declaredHosts: ReadonlyArray<string>;
  readonly idleTimeout: string;
  readonly workspaceQuotaMb?: number;
}

/** Bounds for the workspace write quota (mirrors runtime-settings maxWorkspaceMb). */
export const WORKSPACE_QUOTA_BOUNDS = { minMb: 64, maxMb: 102400 } as const;

const IDLE_TIMEOUT_RE = /^\d+(s|m|h)$/;
const ABS_NO_TRAVERSAL = (p: string) => p.startsWith("/") && !p.split("/").includes("..");

/** Validate + freeze a launch policy. Throws on ANY violation (fail closed).
 * The msb checksum is resolved from the platform-fixed manifest (never
 * caller-supplied); unpinned platform/arch → refused here. */
export function createMicrosandboxLaunchPolicy(
  input: MicrosandboxLaunchPolicyInput,
  platformOpts: { platform?: string; arch?: string } = {},
): MicrosandboxLaunchPolicy {
  const bad = (msg: string): never => {
    throw new MicrosandboxPolicyError(msg);
  };

  if (!input || typeof input !== "object") bad("launch policy input required");
  if (!ABS_NO_TRAVERSAL(String(input.msbPath ?? ""))) bad("msbPath must be absolute without '..'");
  if (input.msbVersion !== PINNED_MSB_VERSION) {
    bad(`msbVersion '${input.msbVersion}' != pinned ${PINNED_MSB_VERSION} (pin drift refused)`);
  }
  const platform = platformOpts.platform ?? process.platform;
  const arch = platformOpts.arch ?? process.arch;
  const msbSha256 = pinnedMsbChecksum(platform, arch);
  if (msbSha256 === null) {
    throw new MicrosandboxPolicyError(
      `no pinned msb checksum for ${platform}-${arch} (verified assets: ${Object.keys(MSB_CHECKSUM_MANIFEST).join(", ")}) — runtime unavailable here by design`,
    );
  }
  if (input.guestImage !== PINNED_GUEST_IMAGE) {
    bad(`guestImage '${input.guestImage}' != pinned ${PINNED_GUEST_IMAGE}`);
  }

  const memoryMb = Number(input.memoryMb);
  if (!Number.isFinite(memoryMb) || memoryMb < RESOURCE_BOUNDS.minMemoryMb || memoryMb > RESOURCE_BOUNDS.maxMemoryMb) {
    bad(`memoryMb ${input.memoryMb} outside [${RESOURCE_BOUNDS.minMemoryMb}, ${RESOURCE_BOUNDS.maxMemoryMb}]`);
  }
  const cpuCores = Number(input.cpuCores);
  if (!Number.isFinite(cpuCores) || cpuCores < RESOURCE_BOUNDS.minCpuCores || cpuCores > RESOURCE_BOUNDS.maxCpuCores) {
    bad(`cpuCores ${input.cpuCores} outside [${RESOURCE_BOUNDS.minCpuCores}, ${RESOURCE_BOUNDS.maxCpuCores}]`);
  }

  if (!Array.isArray(input.workspaceRoots)) bad("workspaceRoots must be an array");
  if (input.workspaceRoots.length === 0) bad("workspaceRoots must not be empty (agent needs a workspace)");
  if (input.workspaceRoots.length > MAX_ROOTS) bad(`workspaceRoots exceeds ${MAX_ROOTS}`);
  for (const r of input.workspaceRoots) {
    if (!r || !ABS_NO_TRAVERSAL(String(r.path ?? ""))) bad("workspaceRoots[].path must be absolute without '..'");
    if (r.access !== "ro" && r.access !== "rw") bad("workspaceRoots[].access must be 'ro'|'rw'");
  }

  if (input.networkEgress !== "none" && input.networkEgress !== "declared") {
    bad("networkEgress must be 'none'|'declared' (default deny)");
  }
  let declaredHosts: string[] = [];
  if (input.networkEgress === "declared") {
    const hosts = input.declaredHosts;
    if (!Array.isArray(hosts) || hosts.length === 0) {
      throw new MicrosandboxPolicyError("declared egress requires a non-empty declaredHosts allowlist");
    }
    if (hosts.length > MAX_EGRESS_HOSTS) bad(`declaredHosts exceeds ${MAX_EGRESS_HOSTS}`);
    const seen = new Set<string>();
    for (const h of hosts) {
      if (typeof h !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/.test(h)) bad(`invalid declared host '${h}'`);
      if (seen.has(h)) bad(`duplicate declared host '${h}'`);
      seen.add(h);
    }
    declaredHosts = [...(hosts as string[])];
  } else if (input.declaredHosts !== undefined && input.declaredHosts.length > 0) {
    bad("declaredHosts set while networkEgress='none' (contradictory policy)");
  }

  if (!IDLE_TIMEOUT_RE.test(String(input.idleTimeout ?? ""))) bad("idleTimeout must match /\\d+(s|m|h)/");
  if (input.workspaceQuotaMb !== undefined) {
    const q = Number(input.workspaceQuotaMb);
    if (!Number.isInteger(q) || q < WORKSPACE_QUOTA_BOUNDS.minMb || q > WORKSPACE_QUOTA_BOUNDS.maxMb) {
      bad(`workspaceQuotaMb ${input.workspaceQuotaMb} outside [${WORKSPACE_QUOTA_BOUNDS.minMb}, ${WORKSPACE_QUOTA_BOUNDS.maxMb}] MB (integer)`);
    }
  }

  return Object.freeze({
    policyVersion: MICROSANDBOX_POLICY_VERSION,
    msbPath: input.msbPath,
    msbVersion: input.msbVersion,
    msbSha256,
    guestImage: input.guestImage,
    memoryMb,
    cpuCores,
    workspaceRoots: Object.freeze(input.workspaceRoots.map((r) => Object.freeze({ ...r }))),
    networkEgress: input.networkEgress,
    declaredHosts: Object.freeze(declaredHosts),
    idleTimeout: input.idleTimeout,
    ...(input.workspaceQuotaMb !== undefined ? { workspaceQuotaMb: input.workspaceQuotaMb } : {}),
  });
}

// ─── Runtime availability probe (DI; fs/spawn injected) ─────────────────────

export interface MicrosandboxProbeDeps {
  /** msb path → {isFile, sizeBytes} | null (inject statSync). */
  stat?: (p: string) => { isFile: boolean; sizeBytes: number } | null;
  /** Run `msb --version` (inject spawnSync). Returns trimmed stdout or null. */
  versionOf?: (msbPath: string) => string | null;
  /** sha256 of the binary (inject; default: shasum -a 256). */
  sha256Of?: (msbPath: string) => string | null;
}

export interface MicrosandboxAvailability {
  available: boolean;
  reason?: string;
  /** Evidence fields (never secret values). */
  version?: string;
  sha256?: string;
}

/**
 * Probe the pinned runtime: binary exists, version matches the pin, checksum
 * matches the policy. Any mismatch → unavailable (fail closed). No msb
 * invocation beyond `--version`; NEVER runs `msb update`.
 */
export function probeMicrosandboxRuntime(
  policy: Pick<MicrosandboxLaunchPolicy, "msbPath" | "msbVersion" | "msbSha256">,
  deps: MicrosandboxProbeDeps = {},
): MicrosandboxAvailability {
  const stat = deps.stat ?? ((p: string) => {
    try {
      const st = statSync(p);
      return { isFile: st.isFile(), sizeBytes: st.size };
    } catch {
      return null;
    }
  });
  const versionOf = deps.versionOf ?? ((p: string) => {
    const r = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return null;
    return (r.stdout || "").trim().split("\n")[0] || null;
  });
  const sha256Of = deps.sha256Of ?? ((p: string) => {
    const r = spawnSync("shasum", ["-a", "256", p], { encoding: "utf8", timeout: 10000 });
    if (r.status !== 0) return null;
    const m = (r.stdout || "").match(/^[a-f0-9]{64}/);
    return m ? m[0] : null;
  });

  const st = stat(policy.msbPath);
  if (!st || !st.isFile) {
    return { available: false, reason: `msb binary absent or not a file: ${policy.msbPath}` };
  }
  // Defense in depth: the expected checksum must BE a manifest value — a
  // hand-built policy carrying an off-manifest checksum is refused even if
  // the binary happens to match it.
  if (!Object.values(MSB_CHECKSUM_MANIFEST).includes(policy.msbSha256)) {
    return { available: false, reason: "policy checksum is not in the pinned manifest (self-reported checksums refused)" };
  }
  const v = versionOf(policy.msbPath);
  if (v === null) return { available: false, reason: "msb --version failed" };
  if (!v.includes(policy.msbVersion)) {
    return { available: false, reason: `msb version '${v}' does not match pin '${policy.msbVersion}'` };
  }
  const sum = sha256Of(policy.msbPath);
  if (sum === null) return { available: false, reason: "msb sha256 computation failed" };
  if (sum !== policy.msbSha256) {
    return { available: false, reason: "msb sha256 MISMATCH vs pinned policy (supply-chain gate)" };
  }
  return { available: true, version: v, sha256: sum };
}
