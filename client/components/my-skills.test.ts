// Run: npx tsx client/components/my-skills.test.ts
// M7b: pure helpers of the My Skills submission page + admin review queue.
// UX-level only — the server re-validates everything; these tests pin the
// client validation/status/reason behavior so the UI never claims authority.
import assert from "node:assert/strict";
import {
  validateSubmitForm,
  buildSubmitUrl,
  submitErrorMessage,
  statusMeta,
  canReview,
  isReviewable,
  codeLabel,
  REJECT_REASONS,
  type MySkillSubmission,
} from "./my-skills.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// ─── submit form validation (mirrors server bounds) ───────────

{
  const base = { slug: "my-skill-1", version: "", fileName: "pkg.zip", fileSize: 1024 };
  ok("valid form passes", validateSubmitForm(base) === null);
  ok("empty slug rejected", validateSubmitForm({ ...base, slug: "" }) !== null);
  ok("whitespace-only slug rejected", validateSubmitForm({ ...base, slug: "   " }) !== null);
  ok("slug with space rejected", validateSubmitForm({ ...base, slug: "BAD SLUG" }) !== null);
  ok("slug with path separator rejected", validateSubmitForm({ ...base, slug: "../etc" }) !== null);
  ok("slug over 64 chars rejected", validateSubmitForm({ ...base, slug: "a".repeat(65) }) !== null);
  ok("65-char slug boundary ok", validateSubmitForm({ ...base, slug: "a".repeat(64) }) === null);
  ok("bad version rejected", validateSubmitForm({ ...base, version: "1.0 beta" }) !== null);
  ok("good version passes", validateSubmitForm({ ...base, version: "1.0.0-beta.2+build" }) === null);
  ok("optional version empty passes", validateSubmitForm({ ...base, version: "  " }) === null);
  ok("missing file rejected", validateSubmitForm({ ...base, fileName: null, fileSize: null }) !== null);
  ok("non-zip file rejected", validateSubmitForm({ ...base, fileName: "pkg.tar.gz" }) !== null);
  ok("oversize zip rejected", validateSubmitForm({ ...base, fileSize: 80 * 1024 * 1024 + 1 }) !== null);
  ok("80MB boundary passes", validateSubmitForm({ ...base, fileSize: 80 * 1024 * 1024 }) === null);
}

// ─── submit URL building ──────────────────────────────────────

{
  ok(
    "version omitted from query when empty",
    buildSubmitUrl("/api/my-skills", " demo ", "  ") === "/api/my-skills/submit?slug=demo"
  );
  ok(
    "version included when present",
    buildSubmitUrl("/api/my-skills", "demo", "1.2.0") === "/api/my-skills/submit?slug=demo&version=1.2.0"
  );
  ok("slug is trimmed + encoded", !buildSubmitUrl("/api/my-skills", "a b", "1").includes("a b"));
}

// ─── categorical submit error mapping ─────────────────────────

{
  ok("duplicate maps to 409 guidance", submitErrorMessage(409, { code: "duplicate" }).includes("已被占用"));
  ok("no_skill maps to package guidance", submitErrorMessage(400, { code: "no_skill" }).includes("SKILL.md"));
  ok("unknown code stays bounded (no raw message)", !submitErrorMessage(400, { code: "weird", message: "SECRET" }).includes("SECRET"));
  ok("registry_invalid keeps the fail-closed wording", submitErrorMessage(500, { code: "registry_invalid" }).includes("拒绝"));
  ok("submitter cap maps to 429 guidance (open records incl. quarantined)", ["pending_cap_submitter", "submission_cap_submitter"].every((c) => submitErrorMessage(429, { code: c }).includes("上限")));
  ok("org cap maps to 429 guidance", ["pending_cap_org", "submission_cap_org"].every((c) => submitErrorMessage(429, { code: c }).includes("组织")));
  ok("store-invalid maps to zero-residue guidance", submitErrorMessage(500, { code: "submission_store_invalid" }).includes("未产生任何残留"));
}

// ─── status meta + review authority ───────────────────────────

{
  ok("pending_review label", statusMeta("pending_review").label === "待审核");
  ok("approved label", statusMeta("approved").label === "已通过");
  ok("rejected label", statusMeta("rejected").label === "已拒绝");
  ok("quarantined label", statusMeta("quarantined").label === "已隔离");

  ok("canReview: admin only", canReview("admin") === true && canReview("org_admin") === false && canReview("user") === false && canReview(undefined) === false);

  const sub = (status: MySkillSubmission["status"]): MySkillSubmission => ({
    id: "s1", slug: "x", submitterUserId: "u", orgId: "o", status, createdAt: "t", updatedAt: "t",
  });
  ok("only pending_review is reviewable", isReviewable(sub("pending_review")) === true && isReviewable(sub("approved")) === false && isReviewable(sub("rejected")) === false && isReviewable(sub("quarantined")) === false);
}

// ─── reject reason catalogue + code labels ────────────────────

{
  ok("reject reasons are all categorical tokens", REJECT_REASONS.every((r) => /^[a-z0-9_-]{1,64}$/.test(r.code) && r.label.length > 0));
  ok("codeLabel maps a known reason", codeLabel("unsafe_scripts") === "包含不安全脚本");
  ok("codeLabel maps a pipeline error", codeLabel("no_skill").includes("SKILL.md"));
  ok("codeLabel passes through unknown tokens", codeLabel("mystery") === "mystery");
  ok("codeLabel handles undefined", codeLabel(undefined) === "—");
}

console.log(`\nAll ${pass} assertions passed.`);
