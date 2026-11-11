/**
 * skill-importer.test.ts — focused MVP tests.
 *
 * Covers the directive's required cases:
 *  1. 混合仓库只发现 SKILL.md（资源随包、非 Skill 忽略）
 *  2. 资源（scripts/references/assets）随包保留
 *  3. 恶意/损坏 ZIP 拒绝（scanUpload boundary → extractZip throw）
 *  4. 10 个候选逐项失败隔离（一个失败不中断批次）
 *  5. Hub validate 失败不 publish（publish endpoint 从未被调用）
 *  6. 凭证不下发前端（outcome 字符串不含 token，即便 Hub msg 回显 token）
 *  7. zipDir 往返（写出的 zip 能被 extractZip 读回，结构正确）
 *  8. 根目录 SKILL.md（真实 Hub 单 Skill 包形，如 global/agentguard@1.1）：
 *     scanUpload 必须发现 1 个 Skill（name 取 frontmatter，relPath "."）
 *  9. 批量上传：多个 ZIP 汇总进一个 scan session，候选用稳定 id（非 basename）
 * 10. 选择按 id：同名候选可区分；未知/重复 id 拒绝（deny）
 *
 * Full malicious-archive matrix (traversal/abs/symlink/zip-bomb/…) is covered
 * by `server/skillhub-zip-extract.test.ts`; here we only assert the Importer
 * boundary propagates its throw (no bypass).
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanForSkills } from "./scanner.js";
import {
  appendScanSession,
  cleanupScanSession,
  packageSkill,
  publishConfirmedBatch,
  scanUpload,
  selectByIds,
  startScanSession,
  validateBatch,
} from "./service.js";
import { zipDir } from "./zip-writer.js";
import { extractZip } from "../skillhub-zip-extract.js";
import type { HubPublishConfig } from "./hub-publish.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

function makeRepo(): { repo: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "si-repo-"));
  const mkdir = (p: string) => fs.mkdirSync(path.join(base, p), { recursive: true });
  const w = (p: string, c: string) => fs.writeFileSync(path.join(base, p), c);
  // Two real skills with resources.
  mkdir("skills/foo/scripts"); mkdir("skills/foo/references");
  w("skills/foo/SKILL.md", "# Foo\nA foo skill.\n## Details\nDoes foo things.");
  w("skills/foo/scripts/run.sh", "echo hi");
  w("skills/foo/references/r.md", "ref");
  mkdir("skills/bar/assets");
  w("skills/bar/SKILL.md", "Bar skill.");
  w("skills/bar/assets/a.txt", "asset");
  w("skills/bar/LICENSE", "MIT");
  // 10 more candidates for the isolation test.
  for (let i = 1; i <= 10; i++) {
    mkdir(`skills/cand-${i}`);
    w(`skills/cand-${i}/SKILL.md`, `# Cand ${i}\nCandidate skill #${i}.`);
  }
  // Non-Skill content (must be IGNORED — no SKILL.md).
  mkdir("agents"); w("agents/persona.md", "# persona");
  mkdir("commands"); w("commands/cmd.md", "# command");
  mkdir("hooks"); w("hooks/h.md", "# hook");
  mkdir("mcp"); w("mcp/m.json", "{}");
  w("README.md", "# repo"); // plain markdown at root, no SKILL.md
  return { repo: base, cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} } };
}

// ── stub fetch: two-phase (validate = CLI dry-run, publish = portal) ─────────
// Mirrors the live OpenAPI contract:
//   validate  POST /api/cli/v1/skills/{ns}/publish/validate → data.CliDryRunResponse
//   publish   POST /api/v1/skills/{ns}/publish?visibility=&confirmWarnings=true → data.PublishResponse
interface StubCall { url: string; auth: string | undefined; method: string; body?: any; }
function makeStubFetch(opts: {
  validateValid?: boolean; validateWarnings?: string[]; validateErrors?: string[];
  validateEnvelopeFail?: boolean; // HTTP 400 / code!=0
  publishOk?: boolean; publishStatus?: string;
  echoTokenInMsg?: string;
}) {
  const calls: StubCall[] = [];
  const f = async (url: string | URL | Request, init?: any) => {
    const u = String(url);
    const isValidate = u.includes("/publish/validate");
    const isPortalPublish = u.includes("/api/v1/skills/") && u.includes("/publish") && !isValidate;
    calls.push({ url: u, auth: init?.headers?.Authorization, method: init?.method, body: init?.body });
    if (isValidate) {
      const fail = opts.validateEnvelopeFail;
      const msg = opts.echoTokenInMsg && fail ? opts.echoTokenInMsg : (fail ? "validate failed" : "ok");
      const data = fail ? {} : {
        valid: opts.validateValid ?? true,
        errors: opts.validateErrors ?? [],
        warnings: opts.validateWarnings ?? [],
        resolvedSlug: "resolved-slug", resolvedVersion: "1.0.0",
      };
      return new Response(JSON.stringify({ code: fail ? 4001 : 0, msg, data }), {
        status: fail ? 400 : 200, headers: { "content-type": "application/json" },
      });
    }
    if (isPortalPublish) {
      const okFlag = opts.publishOk ?? true;
      const msg = opts.echoTokenInMsg && !okFlag ? opts.echoTokenInMsg : (okFlag ? "ok" : "rejected");
      const data = okFlag ? { skillId: 1, namespace: "team-ns", slug: "resolved-slug", version: "1.0.0", status: opts.publishStatus ?? "PENDING_REVIEW", fileCount: 3, totalSize: 1024 } : {};
      return new Response(JSON.stringify({ code: okFlag ? 0 : 4002, msg, data }), {
        status: okFlag ? 200 : 400, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: 404, msg: "no route", data: {} }), { status: 404, headers: { "content-type": "application/json" } });
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

const TOKEN = "secret-publish-token-DO-NOT-LEAK-1234567890";
const cfg = (fetchImpl: typeof fetch, visibility = "private"): HubPublishConfig => ({ baseUrl: "http://hub.test", publishToken: TOKEN, fetchImpl, visibility });

async function main() {
  const { repo, cleanup } = makeRepo();
  try {
    // ── 1 + 2: mixed-repo discovery + resources follow ────────────────────
    console.log("Test 1+2: mixed-repo SKILL.md-only discovery + resources follow");
    {
      const r = scanForSkills(repo);
      // 2 named + 10 cand = 12 skills; non-skill dirs ignored.
      ok("finds foo+bar+cand-1..10 (12 skills)", r.skills.length === 12, `got ${r.skills.length}`);
      ok("ignoredCount >= 5 (agents/commands/hooks/mcp/... )", r.ignoredCount >= 5, `got ${r.ignoredCount}`);
      const foo = r.skills.find((s) => s.name === "foo")!;
      ok("foo found", Boolean(foo));
      ok("foo.hasScripts true", foo.hasScripts);
      ok("foo.files includes SKILL.md", foo.files.includes("SKILL.md"));
      ok("foo.files includes scripts/run.sh", foo.files.includes("scripts/run.sh"));
      ok("foo.files includes references/r.md", foo.files.includes("references/r.md"));
      const bar = r.skills.find((s) => s.name === "bar")!;
      ok("bar.license === LICENSE", bar.license === "LICENSE");
      ok("bar.files includes assets/a.txt", bar.files.includes("assets/a.txt"));
      // No non-skill dir became a candidate.
      ok("no candidate named agents/commands/hooks/mcp", !r.skills.some((s) => ["agents", "commands", "hooks", "mcp"].includes(s.name)));
    }

    // ── 3: malicious/corrupt ZIP rejected at scanUpload boundary ───────────
    console.log("Test 3: corrupt ZIP rejected");
    {
      const corrupt = Buffer.from("not a zip file at all");
      let threw = false;
      try { scanUpload(corrupt, "test:corrupt"); } catch { threw = true; }
      ok("scanUpload(corrupt) throws", threw);
    }

    // ── 4: validate (Phase A) captures warnings/errors; NEVER publishes ───────
    console.log("Test 4: validate surfaces warnings/errors, no publish called");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name)); // 10
      ok("10 cand candidates", cands.length === 10, `got ${cands.length}`);
      // Build a stateful session (validateBatch mutates skills in place).
      const h = scanUpload(packageSkill(cands[0]), "t4"); // throwaway handle to get a ScanSession shape
      const session = startScanSession(h);
      // replace skills with the 10 cands (carrying dir from the real repo)
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      const stub = makeStubFetch({ validateValid: true, validateWarnings: ["uses .ssh read", "network egress"], publishOk: true });
      const out = await validateBatch(cfg(stub.fetch), "team-ns", session.skills);
      try {
        ok("total === 10", out.total === 10);
        ok("all cleared (valid=10)", out.valid === 10, `got ${out.valid}`);
        ok("invalid === 0", out.invalid === 0);
        ok("every item carries 2 warnings", out.items.every((i) => i.warnings.length === 2), "warnings missing");
        ok("warnings surfaced verbatim", out.items[0].warnings.includes("uses .ssh read"));
        ok("resolvedSlug/Version surfaced", out.items[0].resolvedSlug === "resolved-slug" && out.items[0].resolvedVersion === "1.0.0");
        ok("all states=validated", session.skills.every((s) => (s as any).pubState === "validated"));
        // CRITICAL: validate MUST NOT have called any publish endpoint.
        ok("no publish endpoint called during validate", stub.calls.every((c) => !c.url.includes("/api/v1/skills/") || c.url.includes("/publish/validate") === false ? !c.url.includes("/publish") || c.url.includes("/publish/validate") : false) && !stub.calls.some((c) => c.url.includes("/api/v1/skills/") && c.url.includes("/publish") && !c.url.includes("/publish/validate")));
      } finally { cleanupScanSession(session); }
    }

    // ── 5: publish REQUIRES prior validate; un-validated → no publish call ────
    console.log("Test 5: publish without prior validate is denied (no publish call)");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name)).slice(0, 5);
      const h = scanUpload(packageSkill(cands[0]), "t5");
      const session = startScanSession(h);
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      const stub = makeStubFetch({ validateValid: true, publishOk: true });
      const out = await publishConfirmedBatch(cfg(stub.fetch), "team-ns", session.skills);
      try {
        ok("total === 5", out.total === 5);
        ok("succeeded === 0", out.succeeded === 0);
        ok("failed === 5 (all denied)", out.failed === 5);
        ok("every item reason = not validated", out.items.every((i) => i.reason === "not validated — run validate first"));
        // CRITICAL: no portal publish call when candidates weren't validated.
        ok("publish endpoint never called (no prior validate)", !stub.calls.some((c) => c.url.includes("/api/v1/skills/") && c.url.includes("/publish") && !c.url.includes("/publish/validate")));
      } finally { cleanupScanSession(session); }
    }

    // ── 6: full two-phase happy path — validate ok → portal publish ───────────
    console.log("Test 6: two-phase happy path (validate → portal confirmWarnings=true → PENDING_REVIEW)");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name)).slice(0, 3);
      const h = scanUpload(packageSkill(cands[0]), "t6");
      const session = startScanSession(h);
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      const stub = makeStubFetch({ validateValid: true, validateWarnings: ["w1"], publishOk: true, publishStatus: "PENDING_REVIEW" });
      try {
        const v = await validateBatch(cfg(stub.fetch), "team-ns", session.skills);
        ok("validate: 3 valid", v.valid === 3, `got ${v.valid}`);
        ok("validate: 3 reached (warnings present)", v.items.every((i) => i.ok && i.warnings.length === 1));
        const p = await publishConfirmedBatch(cfg(stub.fetch), "team-ns", session.skills);
        ok("publish: total === 3", p.total === 3);
        ok("publish: succeeded === 3", p.succeeded === 3, `got ${p.succeeded}`);
        ok("publish: all phase=publish", p.items.every((i) => i.phase === "publish"));
        // CRITICAL: publish used the PORTAL endpoint with confirmWarnings=true query.
        const pubCalls = stub.calls.filter((c) => c.url.includes("/api/v1/skills/") && c.url.includes("/publish") && !c.url.includes("/publish/validate"));
        ok("publish used portal /api/v1/skills/{ns}/publish", pubCalls.length === 3 && pubCalls.every((c) => /\/api\/v1\/skills\/team-ns\/publish/.test(c.url)), `got ${pubCalls.length}`);
        ok("publish carried confirmWarnings=true", pubCalls.every((c) => c.url.includes("confirmWarnings=true")));
        ok("visibility in publish query (not form)", pubCalls.every((c) => c.url.includes("visibility=private")));
        ok("states=published after success", session.skills.every((s) => (s as any).pubState === "published"));
        // Fix round 3: Hub PublishResponse.status preserved on the publish item (not "sent for review" blanket).
        ok("publish item carries Hub status (PENDING_REVIEW)", p.items.every((i) => i.ok && i.status === "PENDING_REVIEW"), `status=${p.items.map((i)=>i.status).join(",")}`);
      } finally { cleanupScanSession(session); }
    }

    // ── 7: no duplicate publish — re-publish skips already-published ─────────
    console.log("Test 7: no duplicate publish (already-published skipped)");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name)).slice(0, 2);
      const h = scanUpload(packageSkill(cands[0]), "t7");
      const session = startScanSession(h);
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      const stub = makeStubFetch({ validateValid: true, publishOk: true });
      try {
        await validateBatch(cfg(stub.fetch), "team-ns", session.skills);
        const p1 = await publishConfirmedBatch(cfg(stub.fetch), "team-ns", session.skills);
        ok("first publish: 2 succeeded", p1.succeeded === 2);
        const callsAfterFirst = stub.calls.length;
        // Re-publish same candidates — must be a no-op (skip), no new publish calls.
        const p2 = await publishConfirmedBatch(cfg(stub.fetch), "team-ns", session.skills);
        ok("second publish: 2 succeeded (cached)", p2.succeeded === 2);
        ok("no new publish calls on retry (no duplicate)", stub.calls.length === callsAfterFirst, `+${stub.calls.length - callsAfterFirst} calls`);
        ok("retry items are cached publish results", p2.items.every((i) => i.ok));
      } finally { cleanupScanSession(session); }
    }

    // ── 7b: validate-fail-no-publish (errors block; publish denies) ───────────
    console.log("Test 7b: validate errors block publish (per-item isolation)");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name));
      const h = scanUpload(packageSkill(cands[0]), "t7b");
      const session = startScanSession(h);
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      // validate reports blocking errors (valid=false)
      const stub = makeStubFetch({ validateValid: false, validateErrors: ["missing frontmatter name"], publishOk: true });
      try {
        const v = await validateBatch(cfg(stub.fetch), "team-ns", session.skills);
        ok("validate: 0 valid (all invalid)", v.valid === 0);
        ok("validate: 10 invalid", v.invalid === 10, `got ${v.invalid}`);
        ok("validate: errors surfaced", v.items.every((i) => i.errors.length === 1 && i.errors[0] === "missing frontmatter name"));
        ok("states=failed after invalid", session.skills.every((s) => (s as any).pubState === "failed"));
        const p = await publishConfirmedBatch(cfg(stub.fetch), "team-ns", session.skills);
        ok("publish: 0 succeeded (none validated)", p.succeeded === 0);
        ok("publish: all denied (not validated)", p.items.every((i) => i.reason === "not validated — run validate first"));
        ok("publish endpoint never called (validate failed)", !stub.calls.some((c) => c.url.includes("/api/v1/skills/") && c.url.includes("/publish") && !c.url.includes("/publish/validate")));
      } finally { cleanupScanSession(session); }
    }

    // ── 7d: namespace-bound validation — validate vs A, publish vs B → deny ──
    console.log("Test 7d: publish denied when namespace differs from validated namespace (no call)");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name)).slice(0, 2);
      const h = scanUpload(packageSkill(cands[0]), "t7d");
      const session = startScanSession(h);
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      const stub = makeStubFetch({ validateValid: true, publishOk: true, publishStatus: "PENDING_REVIEW" });
      try {
        // validate against namespace "team-A"
        const v = await validateBatch(cfg(stub.fetch), "team-A", session.skills);
        ok("validate vs team-A: 2 valid", v.valid === 2);
        ok("cached namespace = team-A", session.skills.every((s) => (s as any).validation?.namespace === "team-A"));
        // publish against a DIFFERENT namespace "team-B" → must deny, no publish call
        const p = await publishConfirmedBatch(cfg(stub.fetch), "team-B", session.skills);
        ok("publish vs team-B: 0 succeeded", p.succeeded === 0);
        ok("publish vs team-B: 2 denied", p.failed === 2);
        ok("every item reason = namespace mismatch", p.items.every((i) => i.reason?.includes("namespace mismatch") && i.reason?.includes("team-A") && i.reason?.includes("team-B")));
        ok("states=failed after mismatch", session.skills.every((s) => (s as any).pubState === "failed"));
        // CRITICAL: portal publish endpoint NEVER called when namespace mismatches.
        ok("publish endpoint never called (namespace mismatch)", !stub.calls.some((c) => c.url.includes("/api/v1/skills/") && c.url.includes("/publish") && !c.url.includes("/publish/validate")));
        // Now publish against the SAME namespace "team-A" → succeeds, status preserved.
        // Reset pubState to validated (mismatch set it failed) by re-validating against team-A.
        const v2 = await validateBatch(cfg(stub.fetch), "team-A", session.skills);
        ok("re-validate vs team-A: 2 valid again", v2.valid === 2);
        const callsBefore = stub.calls.length;
        const p2 = await publishConfirmedBatch(cfg(stub.fetch), "team-A", session.skills);
        ok("publish vs team-A: 2 succeeded", p2.succeeded === 2, `got ${p2.succeeded}`);
        ok("publish called 2× (namespace match)", stub.calls.length - callsBefore === 2);
        ok("status preserved (PENDING_REVIEW)", p2.items.every((i) => i.ok && i.status === "PENDING_REVIEW"));
      } finally { cleanupScanSession(session); }
    }

    // ── 7e: real Hub warning-only dry-run is CONFIRMABLE (live fix) ──────────
    // Live Hub sets data.valid=false whenever warnings exist (CLI publish
    // hardcodes confirmWarnings=false → reject). A warning-only result
    // (envelope ok, valid:false, errors:[], warnings non-empty) MUST be treated
    // as confirmable (validated) AFTER surfacing warnings — NOT as a failure.
    console.log("Test 7e: warning-only dry-run (valid:false+errors[]+warnings) → confirmable");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name)).slice(0, 2);
      const h = scanUpload(packageSkill(cands[0]), "t7e");
      const session = startScanSession(h);
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      // Real agentguard@1.1 shape: envelope ok, valid:false, errors:[], warnings:[.clawignore]
      const stub = makeStubFetch({ validateValid: false, validateErrors: [], validateWarnings: ["Disallowed file extension: .clawignore"], publishOk: true, publishStatus: "PENDING_REVIEW" });
      try {
        const v = await validateBatch(cfg(stub.fetch), "r5-hub-dept", session.skills);
        ok("validate: 2 confirmable (warning-only)", v.valid === 2, `got ${v.valid}`);
        ok("validate: 0 invalid", v.invalid === 0);
        ok("validate: 0 errored", v.errored === 0);
        ok("every item ok=true (warning-only confirmable)", v.items.every((i) => i.ok === true));
        ok("valid=false surfaced", v.items.every((i) => i.valid === false));
        ok("warnings surfaced verbatim (.clawignore)", v.items.every((i) => i.warnings.includes("Disallowed file extension: .clawignore")));
        ok("no errors", v.items.every((i) => i.errors.length === 0));
        ok("states=validated (confirmable, not failed)", session.skills.every((s) => (s as any).pubState === "validated"));
        // CRITICAL: validate MUST NOT publish.
        ok("no publish during validate", !stub.calls.some((c) => c.url.includes("/api/v1/skills/") && c.url.includes("/publish") && !c.url.includes("/publish/validate")));
        // After confirm → portal publish reaches PENDING_REVIEW (warning-only was confirmable).
        const p = await publishConfirmedBatch(cfg(stub.fetch), "r5-hub-dept", session.skills);
        ok("publish: 2 succeeded (warning-only confirmed)", p.succeeded === 2, `got ${p.succeeded}`);
        ok("publish: status PENDING_REVIEW", p.items.every((i) => i.ok && i.status === "PENDING_REVIEW"));
        ok("publish used portal confirmWarnings=true", stub.calls.some((c) => c.url.includes("/api/v1/skills/r5-hub-dept/publish") && c.url.includes("confirmWarnings=true")));
      } finally { cleanupScanSession(session); }
    }

    // ── 7c: credential not leaked in outcome even if Hub msg echoes token ────
    console.log("Test 7c: credential not leaked in outcome strings (validate fail echoes token)");
    {
      const r = scanForSkills(repo);
      const cands = r.skills.filter((s) => /^cand-\d+$/.test(s.name)).slice(0, 3);
      const h = scanUpload(packageSkill(cands[0]), "t7c");
      const session = startScanSession(h);
      (session as any).skills = cands.map((c, i) => ({ ...c, id: `cand-${i + 1}`, source: "repo", pubState: "pending" as const }));
      (session as any).cleanups = [h.cleanup];
      // validate envelope fails AND msg echoes the token → reason must be sanitized.
      const stub = makeStubFetch({ validateEnvelopeFail: true, publishOk: false, echoTokenInMsg: `error for ${TOKEN}` });
      try {
        const v = await validateBatch(cfg(stub.fetch), "team-ns", session.skills);
        ok("no validate reason contains the token", v.items.every((i) => !i.reason?.includes(TOKEN)), "token leaked in reason!");
        ok("Authorization Bearer sent server-side (validate)", stub.calls.filter((c) => c.url.includes("/publish/validate")).every((c) => c.auth === `Bearer ${TOKEN}`));
        ok("validate-fail → states=failed", session.skills.every((s) => (s as any).pubState === "failed"));
      } finally { cleanupScanSession(session); }
    }

    // ── 8: zipDir round-trip (write → extract → structure) ─────────────────
    console.log("Test 8: zipDir round-trip");
    {
      const r = scanForSkills(repo);
      const foo = r.skills.find((s) => s.name === "foo")!;
      const z = packageSkill(foo);
      ok("zip buffer non-empty", z.length > 0);
      // Verify it parses back.
      const tmpZip = path.join(os.tmpdir(), `si-rt-${process.pid}.zip`);
      const tmpX = fs.mkdtempSync(path.join(os.tmpdir(), "si-rt-"));
      try {
        fs.writeFileSync(tmpZip, z);
        extractZip(tmpZip, tmpX); // must not throw
        ok("extractZip(zipDir output) succeeds", true);
        ok("SKILL.md present at top level", fs.existsSync(path.join(tmpX, "SKILL.md")));
        ok("scripts/run.sh present", fs.existsSync(path.join(tmpX, "scripts", "run.sh")));
        ok("references/r.md present", fs.existsSync(path.join(tmpX, "references", "r.md")));
        // No nested wrapper dir (top-level SKILL.md = Hub shape).
        ok("no wrapper dir (foo/SKILL.md must NOT exist)", !fs.existsSync(path.join(tmpX, "foo", "SKILL.md")));
      } finally {
        try { fs.unlinkSync(tmpZip); } catch {}
        try { fs.rmSync(tmpX, { recursive: true, force: true }); } catch {}
      }
    }

    // ── 9: zipDir rejects traversal/symlink (boundary) ─────────────────────
    console.log("Test 9: zipDir rejects boundary breaches");
    {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "si-bad-"));
      try {
        fs.mkdirSync(path.join(d, "ok"));
        fs.writeFileSync(path.join(d, "ok", "SKILL.md"), "x");
        // Symlink escaping root.
        try { fs.symlinkSync(os.tmpdir(), path.join(d, "ok", "escape")); } catch {}
        let threw = false;
        try { zipDir(d); } catch { threw = true; }
        ok("zipDir rejects symlink escape", threw);
      } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    }

    // ── 10: REAL multipart body + portal endpoint + confirmWarnings (capture) ─
    // Proves via a local http server: (a) validate POST is multipart/form-data
    // with a `file` part + visibility form field + Bearer + token-not-in-body;
    // (b) publish POST hits the PORTAL /api/v1/skills/{ns}/publish with
    // confirmWarnings=true + visibility in the QUERY (not the form).
    console.log("Test 10: real multipart + portal publish confirmWarnings=true");
    {
      const http = await import("node:http");
      const captures: any[] = [];
      const srv = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const cap = { url: req.url ?? "", ct: req.headers["content-type"], auth: req.headers["authorization"], body: Buffer.concat(chunks) };
          captures.push(cap);
          // Validate → CliDryRunResponse (valid, warnings); Publish → PublishResponse.
          const isValidate = cap.url.includes("/publish/validate");
          const data = isValidate
            ? { valid: true, errors: [], warnings: ["preview warning"], resolvedSlug: "foo", resolvedVersion: "1.0.0" }
            : { skillId: 1, namespace: "team-ns", slug: "foo", version: "1.0.0", status: "PENDING_REVIEW", fileCount: 1, totalSize: 10 };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 0, msg: "ok", data }));
        });
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const addr = (srv.address() as any).port as number;
      try {
        const r = scanForSkills(repo);
        const foo = r.skills.find((s) => s.name === "foo")!;
        const zip = packageSkill(foo);
        const cfgLocal: HubPublishConfig = { baseUrl: `http://127.0.0.1:${addr}`, publishToken: TOKEN, visibility: "private" };
        const { validateAndPublish } = await import("./hub-publish.js");
        const out = await validateAndPublish(cfgLocal, "team-ns", { name: "foo", zip });
        ok("validate→publish ok (code 0)", out.ok && out.code === 0, `ok=${out.ok}`);
        ok("portal publish status surfaced (PENDING_REVIEW)", (out as any).status === "PENDING_REVIEW", `status=${(out as any).status}`);
        const vcap = captures.find((c) => c.url.includes("/publish/validate"));
        ok("validate request captured", !!vcap);
        ok("validate content-type multipart/form-data", vcap?.ct?.startsWith("multipart/form-data") ?? false, vcap?.ct ?? "none");
        ok("validate Authorization Bearer set", vcap?.auth === `Bearer ${TOKEN}`);
        const vbody = vcap!.body.toString("latin1");
        ok("validate body has `file` form field", vbody.includes('name="file"'));
        ok("validate body has visibility form field (private)", vbody.includes("visibility") && vbody.includes("private"));
        ok("validate body carries zip bytes (PK signature)", vbody.includes("PK\x03\x04") || vcap!.body.includes(Buffer.from("PK\x03\x04")));
        ok("token NOT in validate multipart body", !vbody.includes(TOKEN));
        const pcap = captures.find((c) => c.url.includes("/api/v1/skills/") && c.url.includes("/publish") && !c.url.includes("/publish/validate"));
        ok("publish request captured (portal endpoint)", !!pcap, "portal publish not called");
        ok("publish URL = portal /api/v1/skills/team-ns/publish", pcap?.url?.startsWith("/api/v1/skills/team-ns/publish?") ?? false, pcap?.url ?? "none");
        ok("publish URL carries confirmWarnings=true", pcap?.url?.includes("confirmWarnings=true") ?? false, pcap?.url ?? "none");
        ok("publish URL carries visibility=private (query, not form)", pcap?.url?.includes("visibility=private") ?? false, pcap?.url ?? "none");
        ok("publish Authorization Bearer set", pcap?.auth === `Bearer ${TOKEN}`);
        ok("token NOT in publish multipart body", !pcap!.body.toString("latin1").includes(TOKEN));
      } finally {
        srv.close();
      }
    }

    // ── 11: REAL Hub package shape — root SKILL.md (regression, fix round 1) ──
    // Mirrors the real published package `global/agentguard@1.1` (verified
    // 2026-08-17): ZIP root holds SKILL.md (frontmatter name/description/license)
    // + package.json + scripts/*.js + root .md files + .clawignore — NO wrapper
    // dir. scanUpload MUST discover exactly 1 skill from this shape.
    console.log("Test 11: real Hub root-SKILL.md package shape regression");
    {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "si-hub-"));
      try {
        const w = (p: string, c: string) => fs.writeFileSync(path.join(base, p), c);
        fs.mkdirSync(path.join(base, "scripts"), { recursive: true });
        w("SKILL.md", "---\nname: agentguard\ndescription: GoPlus AgentGuard — AI agent security guard.\nlicense: MIT\n---\n# AgentGuard\nSecurity guard skill body.\n");
        w("package.json", '{"name":"agentguard","version":"1.1.0"}');
        w("README.md", "# agentguard\n");
        w(".clawignore", "node_modules\n");
        w("patrol-checks.md", "patrol rules");
        w("scripts/auto-scan.js", "console.log('scan')");
        w("scripts/guard-hook.js", "console.log('hook')");
        const zip = zipDir(base).buffer; // store-only zip of the package dir
        const h = scanUpload(zip, "agentguard-1.1.zip");
        ok("root-SKILL.md zip → exactly 1 skill", h.result.skills.length === 1, `got ${h.result.skills.length}`);
        const s = h.result.skills[0];
        ok("name from frontmatter (agentguard)", s.name === "agentguard", `got ${s.name}`);
        ok("relPath is '.' (root candidate)", s.relPath === ".", `got ${s.relPath}`);
        ok("hasScripts true", s.hasScripts);
        ok("files include package.json", s.files.includes("package.json"));
        ok("files include scripts/auto-scan.js", s.files.includes("scripts/auto-scan.js"));
        ok("files include .clawignore", s.files.includes(".clawignore"));
        // Re-packaging a root candidate keeps the Hub shape (top-level SKILL.md).
        const out = path.join(os.tmpdir(), `si-hubrt-${process.pid}.zip`);
        const ox = fs.mkdtempSync(path.join(os.tmpdir(), "si-hubrt-"));
        try {
          fs.writeFileSync(out, packageSkill(s));
          extractZip(out, ox);
          ok("packageSkill(root candidate) → top-level SKILL.md", fs.existsSync(path.join(ox, "SKILL.md")));
          ok("re-packaged zip has no wrapper dir", !fs.existsSync(path.join(ox, "agentguard")));
        } finally {
          try { fs.unlinkSync(out); } catch {}
          try { fs.rmSync(ox, { recursive: true, force: true }); } catch {}
        }
        h.cleanup();
      } finally { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }
    }

    // ── 12: root candidate name fallback (no frontmatter name) ───────────────
    console.log("Test 12: root candidate name fallback chain");
    {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "si-nofm-"));
      try {
        fs.writeFileSync(path.join(d, "SKILL.md"), "Plain skill with no frontmatter.\n");
        const withName = scanForSkills(d, "my-pkg.zip");
        ok("fallback to rootName", withName.skills[0]?.name === "my-pkg.zip", `got ${withName.skills[0]?.name}`);
        const noName = scanForSkills(d);
        const n = noName.skills[0]?.name ?? "";
        ok("no rootName → '(root)' (temp basename NEVER leaks)", n === "(root)", `got ${n}`);
        ok("temp basename not in name", !n.includes(path.basename(d)), `"${n}" leaks "${path.basename(d)}"`);
      } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    }

    // ── 13: batch session — multiple zips, stable ids, same-name candidates ──
    console.log("Test 13: batch upload aggregation with stable candidate ids");
    {
      // Two root-only Hub-shape zips whose skills share the SAME frontmatter
      // name (basename/relPath collision — ids must disambiguate).
      const mkZip = (marker: string) => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "si-dup-"));
        fs.mkdirSync(path.join(d, "docs"), { recursive: true });
        fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: dup-skill\ndescription: dup ${marker}\n---\nBody ${marker}\n`);
        fs.writeFileSync(path.join(d, marker), marker);
        fs.writeFileSync(path.join(d, "docs", "x.md"), "doc");
        const buf = zipDir(d).buffer;
        fs.rmSync(d, { recursive: true, force: true });
        return buf;
      };
      const h1 = scanUpload(mkZip("a.txt"), "pkg-a.zip");
      const h2 = scanUpload(mkZip("b.txt"), "pkg-b.zip");
      const session = startScanSession(h1);
      appendScanSession(session, h2);
      const dirs = session.skills.map((s) => s.dir); // capture before cleanup
      try {
        ok("2 candidates aggregated", session.skills.length === 2, `got ${session.skills.length}`);
        ok("ids are stable and unique (cand-1, cand-2)", session.skills[0].id === "cand-1" && session.skills[1].id === "cand-2", `got ${session.skills.map((s) => s.id).join(",")}`);
        ok("same-name collision preserved (both 'dup-skill')", session.skills.every((s) => s.name === "dup-skill"));
        ok("source labels distinguish (pkg-a.zip/pkg-b.zip)", session.sourceLabels.join("|") === "pkg-a.zip|pkg-b.zip");
        ok("ignoredCount accumulates (docs/ × 2)", session.ignoredCount === 2, `got ${session.ignoredCount}`);
        // Selection by id: exactly the second zip's candidate, not both.
        const sel = selectByIds(session, ["cand-2"]);
        ok("selectByIds picks exactly cand-2", sel !== null && sel.length === 1 && sel[0].id === "cand-2");
        ok("selected candidate carries its own dir/files", sel !== null && sel[0].files.includes("b.txt") && !sel[0].files.includes("a.txt"));
        ok("selectByIds(unknown id) → null (deny)", selectByIds(session, ["cand-99"]) === null);
        ok("selectByIds(duplicate id) → null (deny)", selectByIds(session, ["cand-1", "cand-1"]) === null);
        ok("selectByIds(mixed known+unknown) → null (deny)", selectByIds(session, ["cand-1", "nope"]) === null);
      } finally {
        cleanupScanSession(session);
      }
      ok("cleanupScanSession removes BOTH temp dirs", dirs.every((d) => !fs.existsSync(d)));
    }

    // ── 14: root SKILL.md + nested skills → root dropped (child wins) ────────
    console.log("Test 14: root SKILL.md dropped when nested skills exist");
    {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "si-mixed-"));
      try {
        fs.mkdirSync(path.join(d, "skills", "inner"), { recursive: true });
        fs.writeFileSync(path.join(d, "SKILL.md"), "---\nname: root-skill\n---\nRoot body\n");
        fs.writeFileSync(path.join(d, "skills", "inner", "SKILL.md"), "Inner body\n");
        const r = scanForSkills(d, "myrepo");
        ok("only nested candidate kept", r.skills.length === 1, `got ${r.skills.length}`);
        ok("kept candidate is skills/inner", r.skills[0]?.relPath === "skills/inner", `got ${r.skills[0]?.relPath}`);
        ok("root candidate dropped (no double packaging)", !r.skills.some((s) => s.relPath === "."));
      } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    }
  } finally {
    cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
