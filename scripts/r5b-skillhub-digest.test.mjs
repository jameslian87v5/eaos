// r5b-skillhub-digest.test.mjs — adversarial cases for the expected-digest validator.
// No test framework (project convention). Run: node scripts/r5b-skillhub-digest.test.mjs
// Exit 0 = all assertions pass; non-zero = a fail-closed rule regressed.

import assert from "node:assert/strict";
import { repoOf, validateExpectedDigests } from "./r5b-skillhub-digest.mjs";

const SERVER = "ghcr.io/iflytek/skillhub-server:latest";
const WEB = "ghcr.io/iflytek/skillhub-web:latest";
const SCANNER = "ghcr.io/iflytek/skillhub-scanner:latest";
const RESOLVED = [SERVER, WEB, SCANNER, "postgres:16-alpine", "redis:7-alpine"];
const RD = {
  [SERVER]: "ghcr.io/iflytek/skillhub-server@sha256:" + "a".repeat(64),
  [WEB]: "ghcr.io/iflytek/skillhub-web@sha256:" + "b".repeat(64),
  [SCANNER]: "ghcr.io/iflytek/skillhub-scanner@sha256:" + "c".repeat(64),
};
const repoDigestOf = (img) => RD[img] || "";
const E = (repo, ch) => `${repo}@sha256:${ch.repeat(64)}`;
const full = [E("ghcr.io/iflytek/skillhub-server", "a"), E("ghcr.io/iflytek/skillhub-web", "b"), E("ghcr.io/iflytek/skillhub-scanner", "c")];
const exp = {
  full,
  partial: [E("ghcr.io/iflytek/skillhub-server", "a")], // only server → must FAIL
  wrong: [E("ghcr.io/iflytek/skillhub-server", "a"), E("ghcr.io/iflytek/skillhub-web", "b"), E("ghcr.io/iflytek/skillhub-scanner", "z")],
  malformed: [E("ghcr.io/iflytek/skillhub-server", "a"), "not-an-entry", E("ghcr.io/iflytek/skillhub-web", "b"), E("ghcr.io/iflytek/skillhub-scanner", "c")],
  duplicate: [E("ghcr.io/iflytek/skillhub-server", "a"), E("ghcr.io/iflytek/skillhub-server", "a"), E("ghcr.io/iflytek/skillhub-web", "b"), E("ghcr.io/iflytek/skillhub-scanner", "c")],
  extra: [...full, E("ghcr.io/iflytek/skillhub-ghost", "d")],
  empty: [],
};

let failures = 0;
function mustReject(label, expected) {
  try {
    const r = validateExpectedDigests(RESOLVED, expected, repoDigestOf);
    assert.equal(r.ok, false, `${label}: expected fail-closed but got ok=true`);
    assert.ok(r.reasons.length > 0, `${label}: expected reasons[]`);
  } catch (e) { console.error(`FAIL ${label}: ${e.message}`); failures++; }
}
function mustAccept(label, expected) {
  try {
    const r = validateExpectedDigests(RESOLVED, expected, repoDigestOf);
    assert.equal(r.ok, true, `${label}: expected ok but got: ${r.reasons.join("; ")}`);
  } catch (e) { console.error(`FAIL ${label}: ${e.message}`); failures++; }
}

// repoOf edge cases
try {
  assert.equal(repoOf(SERVER), "ghcr.io/iflytek/skillhub-server");
  assert.equal(repoOf("ghcr.io/iflytek/skillhub-server@sha256:" + "a".repeat(64)), "ghcr.io/iflytek/skillhub-server");
  assert.equal(repoOf("localhost:5000/foo/bar:1.2.3"), "localhost:5000/foo/bar");
  assert.equal(repoOf(""), "");
} catch (e) { console.error(`FAIL repoOf: ${e.message}`); failures++; }

// Full correct set → accept
mustAccept("full correct set", exp.full);

// Partial set (only server) → REJECT (the blocker codex found)
mustReject("partial set (only server)", exp.partial);

// Wrong digest for scanner → REJECT (mismatch)
mustReject("wrong digest", exp.wrong);

// Malformed entry → REJECT
mustReject("malformed entry", exp.malformed);

// Duplicate expected for server → REJECT
mustReject("duplicate expected", exp.duplicate);

// Extra expected (ghost repo) → REJECT
mustReject("extra expected (ghost)", exp.extra);

// Empty expected → REJECT (when expectations are configured as an empty array
// yet the caller treats "empty" as "expectations present"? No — empty = no
// expectations set. This case is the caller's responsibility; the validator
// treats [] as "no entries" and rejects only if there are resolved images
// with no match, which is all of them → reject. That matches fail-closed: an
// explicitly-empty expected set must not silently pass.)
mustReject("empty expected set", exp.empty);

// No skillhub images resolved → REJECT
try {
  const r = validateExpectedDigests(["postgres:16-alpine"], exp.full, repoDigestOf);
  assert.equal(r.ok, false);
} catch (e) { console.error(`FAIL no-skillhub-resolved: ${e.message}`); failures++; }

if (failures) { console.error(`\n${failures} test(s) FAILED.`); process.exit(1); }
console.log("r5b-skillhub-digest: all adversarial cases rejected/accepted as expected.");
process.exit(0);
