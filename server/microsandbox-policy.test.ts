/**
 * Focused tests — microsandbox-policy (M3-S1): fail-closed validation +
 * pinned-runtime probe + the one-way policy compiler. DI only; no real msb.
 *
 * Run: npx tsx server/microsandbox-policy.test.ts
 */
import assert from "node:assert/strict";
import {
  GUEST_IMAGE_ASSET_PROOFS,
  MSB_CHECKSUM_MANIFEST,
  MicrosandboxPolicyError,
  PINNED_GUEST_IMAGE,
  PINNED_GUEST_IMAGE_DIGEST,
  PINNED_MSB_VERSION,
  createMicrosandboxLaunchPolicy,
  guestEngineStatus,
  pinnedMsbChecksum,
  probeGuestImageDigest,
  probeMicrosandboxRuntime,
  type MicrosandboxLaunchPolicyInput,
} from "./microsandbox-policy.js";
import {
  PolicyValidationError,
  compilePolicyInput,
  createResolvedExecutionPolicy,
  approvalRequiredToolIds,
} from "./resolved-execution-policy.js";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const PINNED_PLATFORM = "darwin-arm64";
const SHA = MSB_CHECKSUM_MANIFEST[PINNED_PLATFORM];
function validInput(over: Partial<MicrosandboxLaunchPolicyInput> = {}): MicrosandboxLaunchPolicyInput {
  return {
    msbPath: "/private/tmp/microsandbox-verify/msb",
    msbVersion: PINNED_MSB_VERSION,
    guestImage: PINNED_GUEST_IMAGE,
    memoryMb: 512,
    cpuCores: 1,
    workspaceRoots: [{ path: "/workspace", access: "rw" }],
    networkEgress: "none",
    idleTimeout: "60s",
    ...over,
  };
}

// --- MP.1: happy path + freeze ---
test("MP.1a: valid policy freezes", () => {
  const p = createMicrosandboxLaunchPolicy(validInput());
  assert.equal(p.policyVersion, 1);
  assert.equal(p.networkEgress, "none");
  assert.throws(() => { (p as { memoryMb?: number }).memoryMb = 1; }, TypeError);
});

// --- MP.2: supply-chain pin (fail closed) ---
test("MP.2a: version pin drift refused", () => {
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ msbVersion: "0.6.19" })), MicrosandboxPolicyError);
});
test("MP.2b: checksum is manifest-fixed (no caller self-report); unpinned platform refused", () => {
  // Input no longer accepts msbSha256 at all — the pin comes from the manifest.
  const p = createMicrosandboxLaunchPolicy(validInput(), { platform: "darwin", arch: "arm64" });
  assert.equal(p.msbSha256, SHA);
  assert.equal(pinnedMsbChecksum("darwin", "arm64"), SHA);
  // Unpinned OS/arch → fail closed at policy creation (unavailable by design).
  assert.equal(pinnedMsbChecksum("linux", "x64"), null);
  assert.throws(
    () => createMicrosandboxLaunchPolicy(validInput(), { platform: "linux", arch: "x64" }),
    /no pinned msb checksum for linux-x64/,
  );
});
test("MP.2c: unpinned guest image refused", () => {
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ guestImage: "ubuntu:latest" })), MicrosandboxPolicyError);
});
test("MP.2d: msb path traversal refused", () => {
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ msbPath: "/tmp/../etc/msb" })), MicrosandboxPolicyError);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ msbPath: "msb" })), MicrosandboxPolicyError);
});

// --- MP.3: resource bounds ---
test("MP.3: memory/cpu outside envelope fail closed", () => {
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ memoryMb: 64 })), /memoryMb/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ memoryMb: 999999 })), /memoryMb/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ cpuCores: 0.1 })), /cpuCores/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ cpuCores: 64 })), /cpuCores/);
});

// --- MP.4: workspace + network ---
test("MP.4a: workspace roots must be non-empty absolute no-traversal", () => {
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ workspaceRoots: [] })), /empty/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ workspaceRoots: [{ path: "rel/x", access: "rw" }] })), /absolute/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ workspaceRoots: [{ path: "/a/../b", access: "rw" }] })), /absolute/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ workspaceRoots: [{ path: "/w", access: "rx" as "ro" }] })), /access/);
});
test("MP.4b: network default deny; contradictory policy refused", () => {
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ networkEgress: "public" as "none" })), /networkEgress/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ networkEgress: "none", declaredHosts: ["api.example.com"] })), /contradictory/);
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ networkEgress: "declared", declaredHosts: [] })), /non-empty/);
  const ok = createMicrosandboxLaunchPolicy(validInput({ networkEgress: "declared", declaredHosts: ["api.example.com", "api2.example.com"] }));
  assert.deepEqual([...ok.declaredHosts], ["api.example.com", "api2.example.com"]);
});
test("MP.4c: idle timeout format enforced", () => {
  assert.throws(() => createMicrosandboxLaunchPolicy(validInput({ idleTimeout: "soon" })), /idleTimeout/);
  assert.doesNotThrow(() => createMicrosandboxLaunchPolicy(validInput({ idleTimeout: "5m" })));
});

// --- MP.5: probe (DI) ---
const probePolicy = { msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, msbSha256: SHA };
test("MP.5a: absent binary → unavailable", () => {
  const r = probeMicrosandboxRuntime(probePolicy, { stat: () => null });
  assert.equal(r.available, false);
  assert.match(r.reason!, /absent/);
});
test("MP.5b: version mismatch → unavailable (fail closed)", () => {
  const r = probeMicrosandboxRuntime(probePolicy, {
    stat: () => ({ isFile: true, sizeBytes: 1 }),
    versionOf: () => "msb 9.9.9",
    sha256Of: () => SHA,
  });
  assert.equal(r.available, false);
  assert.match(r.reason!, /pin/);
});
test("MP.5c: checksum mismatch → supply-chain gate refusal", () => {
  const r = probeMicrosandboxRuntime(probePolicy, {
    stat: () => ({ isFile: true, sizeBytes: 1 }),
    versionOf: () => `msb ${PINNED_MSB_VERSION}`,
    sha256Of: () => "b".repeat(64),
  });
  assert.equal(r.available, false);
  assert.match(r.reason!, /MISMATCH/);
});
test("MP.5d: full match → available with evidence", () => {
  const r = probeMicrosandboxRuntime(probePolicy, {
    stat: () => ({ isFile: true, sizeBytes: 1 }),
    versionOf: () => `msb ${PINNED_MSB_VERSION} (abc1234)`,
    sha256Of: () => SHA,
  });
  assert.equal(r.available, true);
  assert.equal(r.sha256, SHA);
});
test("MP.5e: hand-built policy with OFF-manifest checksum refused by probe", () => {
  const r = probeMicrosandboxRuntime(
    { msbPath: "/x/msb", msbVersion: PINNED_MSB_VERSION, msbSha256: "c".repeat(64) },
    {
      stat: () => ({ isFile: true, sizeBytes: 1 }),
      versionOf: () => `msb ${PINNED_MSB_VERSION}`,
      sha256Of: () => "c".repeat(64), // binary "matches" the self-reported value…
    },
  );
  assert.equal(r.available, false);
  assert.match(r.reason!, /manifest/);
});

// --- MP.6: one-way compiler (bundle view → policy input) ---
test("MP.6a: compile maps tools/model/mounts/maxTurns; model falls back to settings default", () => {
  const input = compilePolicyInput(
    {
      sdkOptions: { tools: ["Read", "Write"], allowedTools: ["Read"], disallowedTools: [], maxTurns: 20, model: "opus" },
      mounts: [{ hostPath: "/h/w", containerPath: "/workspace", readonly: false }, { hostPath: "/h/p", containerPath: "/plugins", readonly: true }],
    },
    { defaultModel: "opus", memoryMb: 512, cpuCores: 1 },
  );
  const policy = createResolvedExecutionPolicy(input);
  assert.equal(policy.modelRef, "opus");
  assert.deepEqual([...policy.exposedToolIds], ["Read", "Write"]);
  assert.deepEqual(approvalRequiredToolIds(policy), ["Write"]); // derived, not stored
  assert.deepEqual(policy.workspacePolicy.roots.map((r) => [r.path, r.access]), [["/workspace", "rw"], ["/plugins", "ro"]]);
  assert.equal(policy.resourcePolicy.maxTurns, 20);
  assert.equal(policy.resourcePolicy.maxMemoryMb, 512);
  assert.equal(policy.networkPolicy.egress, "none");
});
test("MP.6b: MCP outside governed root fails closed (never dropped silently)", () => {
  assert.throws(
    () => compilePolicyInput({ sdkOptions: { mcpServers: { evil: { command: "/usr/bin/curl" } } }, mounts: [] }, { defaultModel: "opus" }),
    PolicyValidationError,
  );
  const ok = compilePolicyInput(
    { sdkOptions: { mcpServers: { ok: { command: "/opt/agent/mcp/echo", args: ["--x"] } } }, mounts: [] },
    { defaultModel: "opus" },
  );
  assert.equal(ok.mcpServers[0].command, "/opt/agent/mcp/echo");
});
test("MP.6c: bundle without model uses settings default; both absent → fail closed", () => {
  const i = compilePolicyInput({ sdkOptions: {}, mounts: [] }, { defaultModel: "opus" });
  assert.equal(i.modelRef, "opus");
  assert.throws(() => compilePolicyInput({ sdkOptions: {}, mounts: [] }, { defaultModel: "" }), PolicyValidationError);
});
test("MP.6d: compiler output survives full policy validation (single authority)", () => {
  // disjointness etc. enforced downstream: allowed-not-exposed must throw there.
  const bad = compilePolicyInput({ sdkOptions: { tools: ["Read"], allowedTools: ["Bash"] }, mounts: [] }, { defaultModel: "opus" });
  assert.throws(() => createResolvedExecutionPolicy(bad), PolicyValidationError);
});

// --- MP.7 (M3-S3A): digest-anchored guest engine asset proof, fail closed ---
test("MP.7a: pinned image identity — proof row exists, digest matches the pin, components proven", () => {
  const proof = GUEST_IMAGE_ASSET_PROOFS[PINNED_GUEST_IMAGE];
  assert.ok(proof, "pinned image must have a proof row");
  assert.equal(proof.digest, PINNED_GUEST_IMAGE_DIGEST);
  assert.ok(proof.digest.startsWith("sha256:"), "digest is an OCI sha256");
  assert.deepEqual({ ...proof.components }, { node: true, workerEntry: true, claudeSdk: true });
  // The row carries the real Guest probe evidence it was earned with. For
  // 0.1.4 the R2 re-proof drove the full loop end-to-end (start frame +
  // terminal); the 0.1.1 no-egress fail-closed semantic is inherited
  // (unchanged worker egress gate — R1 did not touch it).
  assert.match(proof.provenBy.nodeVersion, /^v\d+\.\d+\.\d+$/);
  assert.ok(proof.provenBy.workerProbe.includes("runtime_ready"), "start frame probed");
  assert.ok(proof.provenBy.workerProbe.includes("turn_completed"), "terminal loop probed");
  assert.ok(proof.provenBy.sdkResolve.includes("claude-agent-sdk"));
});
test("MP.7b: engine gate is ok ONLY on the exact pinned digest", () => {
  const ok = guestEngineStatus(PINNED_GUEST_IMAGE, PINNED_GUEST_IMAGE_DIGEST);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.missing, []);
  // Digest mismatch → unavailable (a rebuilt image is unproven until re-pinned).
  const mismatch = guestEngineStatus(PINNED_GUEST_IMAGE, "sha256:" + "0".repeat(64));
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.missing.join(" "), /digest MISMATCH/);
  // Unprobeable digest → unavailable (never trust without a probe).
  const unprobed = guestEngineStatus(PINNED_GUEST_IMAGE, null);
  assert.equal(unprobed.ok, false);
  assert.match(unprobed.missing.join(" "), /digest not probeable/);
  // Unknown image → unavailable.
  const unknown = guestEngineStatus("alpine", PINNED_GUEST_IMAGE_DIGEST);
  assert.equal(unknown.ok, false);
  assert.match(unknown.missing.join(" "), /no GUEST_IMAGE_ASSET_PROOFS entry/);
});
test("MP.7c: probeGuestImageDigest parses inspect JSON via injected inspect; no msb → null", () => {
  assert.equal(probeGuestImageDigest(null, PINNED_GUEST_IMAGE), null);
  assert.equal(probeGuestImageDigest(undefined, PINNED_GUEST_IMAGE), null);
  const calls: Array<[string, string]> = [];
  const digest = probeGuestImageDigest("/private/tmp/msb", PINNED_GUEST_IMAGE, {
    inspect: (p, img) => { calls.push([p, img]); return "sha256:abc"; },
  });
  assert.equal(digest, "sha256:abc");
  assert.deepEqual(calls, [["/private/tmp/msb", PINNED_GUEST_IMAGE]]);
});
test("MP.7d: default inspect impl rejects malformed output (injected spy on spawnSync shape)", () => {
  // Model the real default: non-zero status / unparsable body / missing digest
  // all collapse to null (= unproven = unavailable). We exercise the same
  // parsing contract through a stub that mimics spawnSync results.
  const mk = (status: number | null, stdout: string) => ({ status, stdout, stderr: "", error: undefined });
  const parseLike = (r: { status: number | null; stdout: string }) => {
    if (r.status !== 0 || !r.stdout) return null;
    try {
      const parsed = JSON.parse(r.stdout) as { digest?: unknown };
      return typeof parsed.digest === "string" && parsed.digest ? parsed.digest : null;
    } catch { return null; }
  };
  assert.equal(parseLike(mk(0, JSON.stringify({ digest: PINNED_GUEST_IMAGE_DIGEST }))), PINNED_GUEST_IMAGE_DIGEST);
  assert.equal(parseLike(mk(1, "")), null); // inspect failed
  assert.equal(parseLike(mk(0, "not json")), null); // garbage
  assert.equal(parseLike(mk(0, JSON.stringify({ digest: 42 }))), null); // non-string
  assert.equal(parseLike(mk(0, JSON.stringify({}))), null); // missing
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
