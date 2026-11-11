#!/usr/bin/env node
// r5b-skillhub-deploy-smoke.mjs — R5b-1 deployment baseline smoke.
//
// Scope (R5b-1 only): verify the real iflytek/skillhub release stack is up,
// healthy (real HTTP, not container-running-only), with a REPRODUCIBLE
// baseline (fixed SKILLHUB_VERSION=vX.Y.Z tag OR SKILLHUB_EXPECTED_REPODIGESTS
// set+matching), storage provider = local, and no secret leakage in logs.
// NOT a generic deploy framework.
//
// Non-destructive: does not stop/remove containers or volumes. Persistence
// and backup/restore (DB + object-storage volume) are rehearsed manually per
// docs/06-deployment/skillhub-runbook.md.
//
// Usage (run from the upstream clone dir containing compose.release.yml):
//   node <path-to>/scripts/r5b-skillhub-deploy-smoke.mjs
// Env:
//   SKILLHUB_COMPOSE_FILE  (default compose.release.yml)
//   SKILLHUB_ENV_FILE      (default .env.release; the smoke reads the real
//                          secret values from here for the log scan — values
//                          are NEVER printed; fail-closed if file/values absent)
//   SKILLHUB_API_URL       (default http://localhost:8080)
//   SKILLHUB_WEB_URL       (default http://localhost:80 — release WEB_PORT default)
//   SKILLHUB_EXPECTED_REPODIGESTS  (comma-separated full repoDigest strings,
//                          e.g. ghcr.io/iflytek/skillhub-server@sha256:...,...)
//                          REQUIRED for a reproducible baseline when
//                          SKILLHUB_VERSION is a moving tag (latest/edge/unset);
//                          the smoke VERIFIES each image's repoDigest matches.
//                          A fixed vX.Y.Z tag also satisfies reproducibility.
//                          `latest` alone BLOCKS — not a reproducible pin.
//
// Exit 0 = PASS, non-zero = BLOCKED/FAIL with a precise reason.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { repoOf, validateExpectedDigests } from "./r5b-skillhub-digest.mjs";

const COMPOSE_FILE = process.env.SKILLHUB_COMPOSE_FILE || "compose.release.yml";
const ENV_FILE = process.env.SKILLHUB_ENV_FILE ?? ".env.release";
const WEB_URL = process.env.SKILLHUB_WEB_URL || "http://localhost:80";
const API_URL = process.env.SKILLHUB_API_URL || "http://localhost:8080";
const EXPECTED_DIGESTS = (process.env.SKILLHUB_EXPECTED_REPODIGESTS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Path validation: reject anything that isn't a sane relative/absolute path.
// (No shell is used below — execFileSync with arg arrays — but we still guard
// against path-traversal-ish input to keep the script honest.)
const PATH_RE = /^[A-Za-z0-9._\/-]+$/;
function assertPath(p, label) {
  if (!PATH_RE.test(p)) throw new Error(`invalid ${label}: ${JSON.stringify(p)}`);
}
assertPath(COMPOSE_FILE, "SKILLHUB_COMPOSE_FILE");
if (ENV_FILE && !PATH_RE.test(ENV_FILE)) assertPath(ENV_FILE, "SKILLHUB_ENV_FILE");

// execFileSync (no shell) everywhere → env values cannot inject shell syntax.
function run(file, args, { timeout = 60000, maxBuffer } = {}) {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout, maxBuffer, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (e) {
    return (e.stdout || "").toString().trim() || e.message;
  }
}
// docker compose base args (no shell); include --env-file only when present.
function composeArgs(sub) {
  const a = ENV_FILE && fs.existsSync(ENV_FILE) ? ["--env-file", ENV_FILE] : [];
  a.push("-f", COMPOSE_FILE);
  return a.concat(sub);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// 0. Docker present
let dockerOk = true;
try {
  execFileSync("docker", ["--version"], { stdio: "ignore", timeout: 5000 });
  execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 10000 });
} catch { dockerOk = false; }
check("docker engine available", dockerOk, dockerOk ? "" : "docker not installed or daemon not running");
if (!dockerOk) { console.log("\nBLOCKED: docker engine unavailable."); process.exit(2); }

// 1. Compose stack running — `ps -q` (container IDs) is stable across versions.
const ids = run("docker", ["compose", ...composeArgs(["ps", "-q"])]).split("\n").map((l) => l.trim()).filter(Boolean);
check("release stack has running services", ids.length >= 4, `running containers=${ids.length} (expect >=4)`);
if (ids.length === 0) { console.log("\nBLOCKED: stack not running. See runbook §3."); process.exit(3); }

// 2. Real HTTP health (NOT container-running-only).
let apiOk = false, apiDetail = "";
for (const p of ["/actuator/health", "/api/v1/health", "/healthz"]) {
  const code = run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", `${API_URL}${p}`]);
  if (/^2\d\d$/.test(code)) { apiOk = true; apiDetail = `${p} → ${code}`; break; }
  if (code && code !== "000") apiDetail = `${p} → ${code}`;
}
check("backend API HTTP health (2xx)", apiOk, apiDetail || "no health endpoint returned 2xx");

// 3. Web reachable (real HTTP).
const webCode = run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", WEB_URL]);
check("web UI HTTP reachable (2xx)", /^2\d\d$/.test(webCode), `${WEB_URL} → ${webCode}`);

// 4. Registry RepoDigests — derive refs from compose-resolved images (honors
//    SKILLHUB_VERSION, NOT hard-coded :latest), then verify against EXPECTED.
//    Reproducibility is MANDATORY for a baseline PASS: either SKILLHUB_VERSION
//    is a fixed release tag (vX.Y.Z) OR SKILLHUB_EXPECTED_REPODIGESTS is set
//    and validateExpectedDigests() returns ok (exactly one valid matching
//    entry per compose-resolved Skill Hub image — missing/duplicate/malformed/
//    extra/mismatch all fail closed). `latest`/`edge`/unset with no EXPECTED →
//    BLOCKED (not a reproducible baseline).
const composeImagesRaw = run("docker", ["compose", ...composeArgs(["config", "--images"])], { timeout: 30000 });
const allResolved = composeImagesRaw.split("\n").map((s) => s.trim()).filter(Boolean);
const skillhubImgs = allResolved.filter((img) => img.startsWith("ghcr.io/iflytek/skillhub-"));

let versionTag = null;
if (ENV_FILE && fs.existsSync(ENV_FILE)) {
  const m = fs.readFileSync(ENV_FILE, "utf8").match(/^SKILLHUB_VERSION=(.+)$/m);
  if (m) versionTag = m[1].trim();
}
const isFixedTag = versionTag ? /^v\d+\.\d+\.\d+/.test(versionTag) : false;

const repoDigestOf = (img) => run("docker", ["inspect", "--format", "{{range .RepoDigests}}{{.}}{{end}}", img]);
// RepoDigest format is "repo@sha256:<64hex>"; the @-suffix is the digest part.
const allHaveDigests = skillhubImgs.length >= 3 && skillhubImgs.every((img) => /@sha256:[0-9a-f]{64}$/.test(repoDigestOf(img)));

// Print captured digests (evidence) — never printing secrets, these are public registry digests.
for (const img of skillhubImgs) {
  console.log(`    ${img}\n      repoDigest=${repoDigestOf(img)}`);
}

let validation = { ok: false, reasons: ["no expectations set"] };
if (EXPECTED_DIGESTS.length > 0) {
  validation = validateExpectedDigests(allResolved, EXPECTED_DIGESTS, repoDigestOf);
}

const reproducible = isFixedTag || (EXPECTED_DIGESTS.length > 0 && validation.ok);
const reproDetail = EXPECTED_DIGESTS.length
  ? (validation.ok ? `expected set: MATCH (all ${skillhubImgs.length} images)`
     : `expected set REJECTED: ${validation.reasons.join("; ")}`)
  : (isFixedTag ? `fixed tag SKILLHUB_VERSION=${versionTag}`
     : `moving tag (${versionTag || "unset"}) — set SKILLHUB_VERSION=vX.Y.Z or SKILLHUB_EXPECTED_REPODIGESTS`);
check("reproducible baseline (fixed tag OR expected digests verified)", reproducible, reproDetail);
check("skillhub images have registry RepoDigests", allHaveDigests,
  skillhubImgs.length ? `${skillhubImgs.length} images resolved` : "no skillhub images in compose config");

// 5. Storage provider = local (R5b-1 fix) — prevents the 17-built-in-skills
//    publish failure caused by the compose default SKILLHUB_STORAGE_PROVIDER=s3.
const psId = run("docker", ["ps", "-q", "--filter", "name=server"]).split("\n")[0];
const srvEnv = run("docker", ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", psId]);
const storageProv = (srvEnv.split("\n").find((l) => l.startsWith("SKILLHUB_STORAGE_PROVIDER=")) || "").split("=")[1];
check("server SKILLHUB_STORAGE_PROVIDER=local", storageProv === "local", `got=${storageProv || "(unset → compose default s3)"}`);

// 6. Secret / token log scan — read BOTH the cookie secret and the bootstrap
//    password from .env.release (never printed), scan logs, fail-closed if the
//    env file or values are missing. This proves no real secret value leaks.
let secretVals = [];
if (ENV_FILE && fs.existsSync(ENV_FILE)) {
  const txt = fs.readFileSync(ENV_FILE, "utf8");
  const cookie = (txt.match(/^SKILLHUB_DOWNLOAD_ANON_COOKIE_SECRET=(.+)$/m) || [])[1]?.trim();
  const pw = (txt.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.+)$/m) || [])[1]?.trim();
  if (cookie) secretVals.push({ label: "cookieSecret", val: cookie });
  if (pw) secretVals.push({ label: "bootstrapPassword", val: pw });
}
let scanDetail;
if (secretVals.length < 2) {
  check("secret scan (cookie + password) fail-closed", false, `only ${secretVals.length}/2 secret values found in ${ENV_FILE}`);
} else {
  const logs = run("docker", ["compose", ...composeArgs(["logs", "--no-color", "--no-log-prefix"])], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
  const hits = secretVals.filter((s) => logs.includes(s.val));
  scanDetail = `scanned ${secretVals.length} values from ${ENV_FILE}; hits=${hits.length}` + (hits.length ? ` (${hits.map((h) => h.label).join(",")})` : "");
  check("no secret value leakage in logs (cookie + password)", hits.length === 0, scanDetail);
}

// Summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("BLOCKED checks: " + failed.map((r) => r.name).join(", "));
  process.exit(1);
}
console.log("R5b-1 SMOKE PASS (non-destructive). Persistence + DB & volume backup/restore rehearsed separately per runbook.");
process.exit(0);
