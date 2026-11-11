/**
 * local-sandbox-smoke — M3-S3B RUNTIME_MODE=local-sandbox smoke (honest gate).
 *
 * The REAL runtime path only runs when the runnable conditions hold: pinned
 * msb runtime present + probed, the pinned guest ENGINE image loaded with a
 * digest matching GUEST_IMAGE_ASSET_PROOFS, and the M3-S3B Host egress
 * credential proxy configured (MODEL_EGRESS_BASE_URL/ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY in the Host env). Missing any ⇒
 * `blocked` with the exact reasons, exit 2 — NEVER a faked runtime_ready.
 *
 * When the real path runs it now exercises the FULL M3-S3B loop:
 *   start → runtime_ready → sendMessage (real user prompt) → Guest
 *   model_request intent → Host proxy executes the provider call with
 *   Host-only credentials → model_result → platform events (assistant_text +
 *   turn_completed/turn_failed).
 * Credential hygiene is verified live: the Guest `env` (read inside the live
 * sandbox via a side msb exec) and every captured event frame are scanned for
 * the real credential values; any hit ⇒ exit 1 (leak = failure, not pass).
 *
 * Run: npx tsx scripts/local-sandbox-smoke.mjs
 *   (needs the pinned msb env: MSB_PATH, MSB_HOME, DYLD_LIBRARY_PATH)
 *   exit 0 = real model call loop exercised end-to-end
 *   exit 2 = blocked with reasons (missing msb/image/credentials)
 *   exit 1 = real path attempted and failed (or credential hygiene violated)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import {
  PINNED_GUEST_IMAGE,
  PINNED_GUEST_IMAGE_DIGEST,
  PINNED_MSB_VERSION,
  pinnedMsbChecksum,
  probeGuestImageDigest,
  probeMicrosandboxRuntime,
} from "../server/microsandbox-policy.ts";
import { checkLocalSandboxAvailability, createLocalSandboxRuntimeFactory } from "../server/local-sandbox-runtime.ts";
import { findMsb } from "./local-sandbox-preflight.mjs";

/** msb resolution (M4.5-R1): explicit MSB_PATH (must exist) or controlled PATH
 * lookup only — no machine-specific fallback. Evidence records the SOURCE KIND
 * (explicit-env | path), never the absolute path. */
const msbSource = process.env.MSB_PATH ? "explicit-env" : "path";

/** Real credential VALUES present in this Host env (for hygiene scans only). */
function hostCredentialValues() {
  return [process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.MODEL_EGRESS_CREDENTIAL]
    .filter((v) => typeof v === "string" && v.length > 0);
}

const msbPath = findMsb();
const report = {
  outcome: "blocked",
  mode: "local-sandbox",
  pinned: { msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE, guestImageDigest: PINNED_GUEST_IMAGE_DIGEST },
  msb: null, // filled below when a candidate binary exists
  guestEngine: null, // filled below: digest probe of the LOADED image
  reasons: [],
  egress: null, // filled below: proxy config presence (kind only — never values)
  loop: null, // filled on the real path: events + terminal + hygiene verdicts
};

// ── 1. Host runtime probe (when a candidate binary exists) ──────────────────
if (!msbPath) {
  report.msb = { status: `absent (MSB_PATH unset/dangling and no msb on PATH — no machine-specific fallback; source=${msbSource})`, source: msbSource };
} else {
  const sha = pinnedMsbChecksum(); // platform-fixed manifest pin
  if (!sha) {
    report.msb = { status: `platform ${process.platform}-${process.arch} has no checksum manifest entry` };
  } else {
    const probe = probeMicrosandboxRuntime({ msbPath, msbVersion: PINNED_MSB_VERSION, msbSha256: sha });
    report.msb = probe.available
      ? { status: "probed ok (pinned manifest)", version: probe.version, sha256: probe.sha256, source: msbSource }
      : { status: `probe failed: ${probe.reason}`, source: msbSource };
  }
}

// ── 1b. Guest engine digest probe (M3-S3A): LOADED image must match the pin.
report.guestEngine = !msbPath
  ? { status: "not probeable (no msb binary)" }
  : (() => {
      const digest = probeGuestImageDigest(msbPath, PINNED_GUEST_IMAGE);
      return digest === null
        ? { status: `inspect failed or image '${PINNED_GUEST_IMAGE}' not loaded (msb image load -i <tar> -t ${PINNED_GUEST_IMAGE})` }
        : digest === PINNED_GUEST_IMAGE_DIGEST
          ? { status: "digest match (pinned proof manifest)", digest }
          : { status: "digest MISMATCH vs pinned proof manifest", digest, pinned: PINNED_GUEST_IMAGE_DIGEST };
    })();

// ── 1c. Egress proxy configuration (kind only — values never leave the Host)
report.egress = {
  baseUrlConfigured: Boolean((process.env.MODEL_EGRESS_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? "").trim()),
  credentialConfigured: hostCredentialValues().length > 0,
};

// ── 2. Availability gate — REAL deps (digest-anchored engine proof + S3B proxy)
const wsDir = mkdtempSync("/private/tmp/m3s3b-smoke-ws-");
try {
  // The Host egress proxy stamps the governed model LITERALLY into the provider
  // request (no CLI-level alias mapping on the proxy path). `opus` is the project
  // alias; a provider that rejects it (DashScope: "model 'opus' does not exist")
  // must be handed a real model id the current credentials accept. Default to
  // `opus` (local/docker SDK path maps it via ANTHROPIC_DEFAULT_OPUS_MODEL); override via MSB_SMOKE_MODEL for providers that need a literal id.
  const smokeModel = process.env.MSB_SMOKE_MODEL ?? "opus";
  const bundle = {
    sdkOptions: { tools: ["Read", "Grep"], allowedTools: ["Read"], model: smokeModel },
    mounts: [], // capability mounts none for the smoke; /workspace comes from workspaceHostDir
    env: {},
  };
  const availability = checkLocalSandboxAvailability({
    chatId: "m3s3b-smoke",
    bundle,
    workspaceHostDir: wsDir,
    ...(msbPath ? { msbPath } : {}),
  });
  report.reasons = availability.reasons;

  if (!availability.ok) {
    report.blockedIsCorrect = "blocked is the honest outcome while any gate reason holds (msb config / pinned guest image digest / model egress credentials). If the credential reason is the only one, set MODEL_EGRESS_BASE_URL (or ANTHROPIC_BASE_URL) + ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in the Host env and re-run.";
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  // ── 3. Real path — the FULL M3-S3B loop (gates above are green) ──────────
  const factory = createLocalSandboxRuntimeFactory({
    chatId: "m3s3b-smoke",
    bundle,
    workspaceHostDir: wsDir,
    ...(msbPath ? { msbPath } : {}),
  });
  const rt = factory({});
  const events = [];
  const reader = (async () => { for await (const e of rt.getEventStream()) events.push(e); })();
  const waitFor = async (pred, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return pred();
  };

  // 3a. handshake
  const ready = await waitFor(() => events.some((e) => e.type === "runtime_ready" || e.type === "runtime_error"), 60_000);

  // 3b. Guest env hygiene — read `env` INSIDE the live sandbox (side exec).
  //     The sandbox name is runtime-generated; the side exec races nothing
  //     (idle-timeout keeps the sandbox alive around the live duplex).
  let guestEnvScan = "skipped (sandbox not ready)";
  if (ready && msbPath) {
    const envProbe = spawnSync(msbPath, ["exec", rt.sandboxName, "--", "env"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env }, // host-side msb client env (never enters the guest command itself)
    });
    const guestEnvText = `${envProbe.stdout ?? ""}${envProbe.stderr ?? ""}`;
    const creds = hostCredentialValues();
    const leakedVar = /ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MODEL_EGRESS_CREDENTIAL/.test(guestEnvText);
    const leakedValue = creds.some((c) => guestEnvText.includes(c));
    guestEnvScan = leakedVar
      ? "FAIL: credential VARIABLE NAME visible in Guest env"
      : leakedValue
        ? "FAIL: credential VALUE visible in Guest env"
        : `clean (no credential var or value in Guest env; ${guestEnvText.split("\n").filter(Boolean).length} vars sampled)`;
  }

  // 3c. one REAL model turn through the proxy
  let terminal = null;
  if (ready && events.some((e) => e.type === "runtime_ready")) {
    rt.sendMessage("Reply with exactly: sandbox-ok");
    const done = await waitFor(() => events.some((e) => e.type === "turn_completed" || e.type === "turn_failed"), 150_000);
    terminal = done
      ? events.find((e) => e.type === "turn_completed" || e.type === "turn_failed")
      : { type: "timeout", message: "no terminal event within 150s" };
  }

  await rt.close();
  await new Promise((r) => setTimeout(r, 300));
  void reader;

  // 3d. Event-frame hygiene — no credential value in any captured event.
  const creds = hostCredentialValues();
  const eventsText = JSON.stringify(events);
  const eventsLeak = creds.some((c) => eventsText.includes(c));
  const reportText = JSON.stringify(report);
  const reportLeak = creds.some((c) => reportText.includes(c));

  report.loop = {
    runtimeReady: events.some((e) => e.type === "runtime_ready"),
    sandboxName: rt.sandboxName,
    terminalType: terminal?.type ?? null,
    terminalMessage: terminal?.message ? String(terminal.message).slice(0, 200) : undefined,
    assistantText: events.find((e) => e.type === "assistant_text")?.text?.slice?.(0, 120) ?? null,
    events: events.map((e) => e.type + (e.message ? `: ${String(e.message).slice(0, 120)}` : "")),
    hygiene: { guestEnvScan, eventsLeak, reportLeak },
  };

  const hygieneOk = !guestEnvScan.startsWith("FAIL") && !eventsLeak && !reportLeak;
  if (!hygieneOk) {
    report.outcome = "failed";
    console.log(JSON.stringify(report, null, 2));
    process.exit(1); // a leak is a FAILURE, never a pass
  }
  report.outcome = terminal?.type === "turn_completed" ? "exercised-real-model-call" : "failed";
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = terminal?.type === "turn_completed" ? 0 : 1;
} catch (e) {
  report.outcome = "failed";
  report.reasons.push(String(e?.message ?? e));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try { rmSync(wsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
