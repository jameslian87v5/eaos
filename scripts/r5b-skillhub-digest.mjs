// r5b-skillhub-digest.mjs — pure expected-digest-set validator (no side effects).
//
// Extracted from r5b-skillhub-deploy-smoke.mjs so the fail-closed semantics
// (missing / duplicate / malformed / extra / mismatch) are unit-testable
// without Docker or a running Hub.
//
// Contract: a baseline that sets SKILLHUB_EXPECTED_REPODIGESTS must provide
// EXACTLY ONE valid matching expected entry for EVERY compose-resolved
// Skill Hub image. Any deviation fails closed.

// Strip :tag or @digest from an image ref to get the bare repo name.
//   "ghcr.io/iflytek/skillhub-server:latest"  → "ghcr.io/iflytek/skillhub-server"
//   "ghcr.io/iflytek/skillhub-server@sha256:..." → "ghcr.io/iflytek/skillhub-server"
//   "localhost:5000/foo/bar:1.2.3" → "localhost:5000/foo/bar"  (port kept; tag stripped)
export function repoOf(imgRef) {
  if (!imgRef) return "";
  let r = imgRef.includes("@") ? imgRef.slice(0, imgRef.indexOf("@")) : imgRef;
  const slash = r.lastIndexOf("/");
  const colon = r.indexOf(":", slash + 1);
  if (colon >= 0) r = r.slice(0, colon);
  return r;
}

const REPO_RE = /^[A-Za-z0-9._/:-]+$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// validateExpectedDigests(resolvedImages, expected, repoDigestOf) → { ok, reasons[] }
//   resolvedImages: string[] — refs from `docker compose config --images`
//   expected:        string[] — `repo@sha256:...` entries from SKILLHUB_EXPECTED_REPODIGESTS
//   repoDigestOf:   (imgRef) => string — actual RepoDigest (registry) from `docker inspect`
// Fail-closed rules: malformed entry; duplicate expected for same repo; a
// resolved Skill Hub image with NO matching expected; multiple expected for
// one image; an expected entry matching NO resolved image; digest mismatch.
export function validateExpectedDigests(resolvedImages, expected, repoDigestOf) {
  const reasons = [];
  const skillhubImgs = (resolvedImages || []).filter((i) => i.startsWith("ghcr.io/iflytek/skillhub-"));
  if (skillhubImgs.length === 0) reasons.push("no skillhub images resolved by compose");

  const parsed = (expected || []).map((e) => {
    const at = e.lastIndexOf("@");
    if (at < 0) return { raw: e, repo: null, digest: null, malformed: true };
    const repo = e.slice(0, at);
    const digest = e.slice(at + 1);
    const malformed = !REPO_RE.test(repo) || !DIGEST_RE.test(digest);
    return { raw: e, repo, digest, malformed };
  });
  for (const p of parsed) if (p.malformed) reasons.push(`malformed expected entry: ${p.raw}`);

  const valid = parsed.filter((p) => !p.malformed);
  const counts = {};
  for (const p of valid) counts[p.repo] = (counts[p.repo] || 0) + 1;
  for (const [repo, c] of Object.entries(counts)) if (c > 1) reasons.push(`duplicate expected entries for ${repo} (${c})`);

  const seenRepos = new Set();
  for (const img of skillhubImgs) {
    const repo = repoOf(img);
    seenRepos.add(repo);
    const matches = valid.filter((p) => p.repo === repo);
    if (matches.length === 0) reasons.push(`no expected digest for ${repo} (resolved ${img})`);
    else if (matches.length > 1) reasons.push(`multiple expected entries for ${repo}`);
    else {
      const actual = repoDigestOf(img);
      if (!actual) reasons.push(`no RepoDigest for ${img}`);
      else if (actual !== matches[0].raw) reasons.push(`mismatch ${repo}: expected ${matches[0].raw} got ${actual}`);
    }
  }
  for (const p of valid) {
    if (!seenRepos.has(p.repo)) reasons.push(`extra expected entry matches no resolved image: ${p.raw}`);
  }
  return { ok: reasons.length === 0, reasons };
}
