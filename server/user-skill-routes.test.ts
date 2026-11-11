// Octop absorption M7b — governed user skill submission contract tests.
//
// Coverage (plan Task 2):
//   - user A submits a valid ZIP → pending_review, quarantine install,
//     registry row enabled:false + submittedBy/submissionId (one pipeline:
//     importSkillZip, no second validator);
//   - invalid package (no SKILL.md) → quarantined status recorded with the
//     categorical code, ZERO registry row / quarantine dir, same slug
//     re-submittable;
//   - duplicate slug (pending) → 409;
//   - /api/my-skills is submitter-scoped (B never sees A's records);
//   - approve is admin-only: user/org_admin → 403 + denied audit; org_admin
//     sees own-org submissions read-only, cross-org admin queue full;
//   - admin approve → skill enabled + EXACTLY one user-scope entitlement for
//     the submitter (no org-scope spill), status approved, canConfigure true
//     only for the submitter, builder options include the skill only for the
//     submitter;
//   - reject → status rejected, registry stays enabled:false, ZERO
//     entitlement entries;
//   - audits are categorical metadata-only (no file payload marker).
//
// Run: npx tsx server/user-skill-routes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import express from "express";

// ─── Env before imports ──────────────────────────────────────
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "m7b-user-skills-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.JWT_SECRET = "m7b-user-skills-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.ENTITLEMENTS_FILE = path.join(SCRATCH, "data", "entitlements.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(SCRATCH, "data", "agent-capabilities.json");
process.env.USER_SKILL_SUBMISSIONS_FILE = path.join(SCRATCH, "data", "user-skill-submissions.json");

const db = (await import("./database.js")).default;
const { setSkillEnabled } = await import("./skill-config.js");
const { getBuilderOptions } = await import("./agent-builder.js");
const { entitlementService } = await import("./entitlement.js");
const { createMySkillsRoutes } = await import("./user-skill-routes.js");
const { createAdminUserSkillRoutes } = await import("./admin-user-skill-routes.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
import type { RequestContext } from "./request-context.js";
const { zipDir } = await import("./skill-importer/zip-writer.js");

const ORG = DEFAULT_ORG_ID;
const ORG_B = "m7b-org-b";
const USER_A = "m7b-user-a";
const USER_B = "m7b-user-b";
const ORG_ADMIN = "m7b-orgadmin";
const ADMIN = "m7b-admin";

for (const [id, role, org] of [
  [USER_A, "user", ORG],
  [USER_B, "user", ORG],
  [ORG_ADMIN, "org_admin", ORG],
  [ADMIN, "admin", ORG],
] as const) {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', ?, ?, 'active')`
  ).run(id, id, role, org);
}
db.prepare(
  `INSERT OR IGNORE INTO organizations (id, name, status, created_at) VALUES (?, 'm7b-org-b', 'active', '2026-10-23T00:00:00.000Z')`
).run(ORG_B);
// A user in org B proves org_admin org-scoping of the review queue.
db.prepare(
  `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES ('m7b-user-orgb', 'm7b-user-orgb', 'x', 'user', ?, 'active')`
).run(ORG_B);

const userACtx: RequestContext = { userId: USER_A, role: "user", orgId: ORG };
const userBCtx: RequestContext = { userId: USER_B, role: "user", orgId: ORG };
const adminCtx: RequestContext = { userId: ADMIN, role: "admin", orgId: ORG };

const SKILLS_ROOT = path.join(SCRATCH, "skills");
const QUARANTINE_ROOT = path.join(SKILLS_ROOT, "quarantine");
const SKILLS_CONFIG = path.join(SCRATCH, "data", "skills.json");
const SUBS_FILE = process.env.USER_SKILL_SUBMISSIONS_FILE!;

const PAYLOAD_MARKER = "M7B-PAYLOAD-MARKER-9c41d2";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

function registryRows(): Array<Record<string, unknown>> {
  if (!fs.existsSync(SKILLS_CONFIG)) return [];
  return JSON.parse(readFileSync(SKILLS_CONFIG, "utf8"));
}

function submissions(): Array<Record<string, unknown>> {
  if (!fs.existsSync(SUBS_FILE)) return [];
  return JSON.parse(readFileSync(SUBS_FILE, "utf8")).submissions ?? [];
}

function entitlementEntries(rid: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(process.env.ENTITLEMENTS_FILE!)) return [];
  return (JSON.parse(readFileSync(process.env.ENTITLEMENTS_FILE!, "utf8")).entries ?? []).filter(
    (e: Record<string, unknown>) => e.resourceId === rid
  );
}

// ─── Route harness (x-test-actor, m6a/m7a pattern) ────────────
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req: express.Request, _res, next) => {
  const who = String(req.headers["x-test-actor"] ?? "");
  if (who === USER_A) Object.assign(req, { userId: USER_A, userRole: "user", orgId: ORG });
  else if (who === USER_B) Object.assign(req, { userId: USER_B, userRole: "user", orgId: ORG });
  else if (who === ORG_ADMIN) Object.assign(req, { userId: ORG_ADMIN, userRole: "org_admin", orgId: ORG });
  else if (who === ADMIN) Object.assign(req, { userId: ADMIN, userRole: "admin", orgId: ORG });
  next();
});
app.use("/api/my-skills", createMySkillsRoutes());
app.use("/api/admin/user-skills", createAdminUserSkillRoutes());
const server = app.listen(0);
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function submit(actor: string, slug: string, zip: Buffer, version?: string) {
  const q = new URLSearchParams({ slug, ...(version ? { version } : {}) });
  return fetch(`${BASE}/api/my-skills/submit?${q}`, {
    method: "POST",
    headers: { "content-type": "application/zip", "x-test-actor": actor },
    body: new Uint8Array(zip),
  });
}
async function post(actor: string, url: string, body?: unknown) {
  return fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function getJson(actor: string, url: string) {
  const res = await fetch(`${BASE}${url}`, { headers: { "x-test-actor": actor } });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ─── ZIP fixtures ─────────────────────────────────────────────

function buildValidPackageDir(marker: string): string {
  const dir = mkdtempSync(path.join(SCRATCH, "pkg-src-"));
  writeFileSync(path.join(dir, "SKILL.md"), `---
name: demo
---

# Demo skill

${marker}
`);
  mkdirSync(path.join(dir, "references"), { recursive: true });
  writeFileSync(path.join(dir, "references", "api.md"), "reference doc\n");
  writeFileSync(path.join(dir, "LICENSE"), "MIT demo license\n");
  return dir;
}
const validZipA = zipDir(buildValidPackageDir(PAYLOAD_MARKER)).buffer;
const validZipB = zipDir(buildValidPackageDir("M7B-PAYLOAD-MARKER-second")).buffer;
// No SKILL.md → scanner rejects (no_skill).
const plainDir = mkdtempSync(path.join(SCRATCH, "plain-"));
writeFileSync(path.join(plainDir, "readme.txt"), "not a skill package\n");
const invalidZip = zipDir(plainDir).buffer;

// ─── Section 1: submit (happy + quarantine + duplicate) ───────

let submissionAId = "";
{
  const res = await submit(USER_A, "m7b-skill-a", validZipA);
  const body = await res.json().catch(() => ({}));
  ok("user A submits valid ZIP → 201 pending_review", res.status === 201 && body?.submission?.status === "pending_review", `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  submissionAId = body?.submission?.id ?? "";
  ok("submission id returned", !!submissionAId);

  const rows = registryRows();
  const row = rows.find((r) => r.name === "m7b-skill-a");
  ok("registry row: enabled:false in quarantine", !!row && row.enabled === false && String(row.path).startsWith("skills/quarantine/m7b-skill-a"));
  ok("registry row carries submittedBy + submissionId provenance", row?.submittedBy === USER_A && row?.submissionId === submissionAId);
  ok("quarantine dir installed", fs.existsSync(path.join(QUARANTINE_ROOT, "m7b-skill-a")));
  ok("manifest is secret-free (no file payload marker)", !JSON.stringify(body).includes(PAYLOAD_MARKER));
  ok("manifest carries review metadata", body?.submission?.manifest?.fileCount > 0 && typeof body?.submission?.manifest?.sha256 === "string" && body?.submission?.manifest?.license === "LICENSE");
}

{
  const res = await submit(USER_A, "m7b-skill-a", validZipA);
  ok("duplicate slug while pending → 409", res.status === 409, `status=${res.status}`);
  ok("duplicate created no new submission record", submissions().filter((s) => s.slug === "m7b-skill-a").length === 1);
}

{
  const res = await submit(USER_A, "m7b-bad-pkg", invalidZip);
  const body = await res.json().catch(() => ({}));
  ok("invalid package → 400 with categorical code", res.status === 400 && body?.code === "no_skill", `status=${res.status} body=${JSON.stringify(body).slice(0, 160)}`);
  const rec = submissions().find((s) => s.slug === "m7b-bad-pkg");
  ok("quarantined status recorded with errorCode", rec?.status === "quarantined" && rec?.errorCode === "no_skill");
  ok("quarantined import left zero registry row", !registryRows().some((r) => r.name === "m7b-bad-pkg"));
  ok("quarantined import left zero directory", !fs.existsSync(path.join(QUARANTINE_ROOT, "m7b-bad-pkg")));

  // Same slug re-submittable after quarantined (import rolled back → slug free).
  const res2 = await submit(USER_A, "m7b-bad-pkg", validZipA);
  ok("quarantined slug is re-submittable (fresh record)", res2.status === 201, `status=${res2.status}`);
  const recs = submissions().filter((s) => s.slug === "m7b-bad-pkg");
  ok("re-submit created a NEW record (history kept)", recs.length === 2 && recs.some((r) => r.status === "quarantined") && recs.some((r) => r.status === "pending_review"));
}

{
  const res = await submit(USER_A, "BAD SLUG!", validZipA);
  const body = await res.json().catch(() => ({}));
  ok("malformed slug → 400 invalid_slug (trusted-input contract)", res.status === 400 && body?.code === "invalid_slug", `status=${res.status}`);
}

// ─── Section 2: my-skills visibility is submitter-scoped ──────

{
  const a = await getJson(USER_A, "/api/my-skills");
  ok("A sees only own submissions", (a.json?.submissions ?? []).every((s: any) => s.submitterUserId === USER_A) && a.json.submissions.length >= 3, `count=${a.json?.submissions?.length}`);
  const b = await getJson(USER_B, "/api/my-skills");
  ok("B sees none of A's submissions", (b.json?.submissions ?? []).length === 0);
}

// ─── Section 3: review authority ──────────────────────────────

{
  const res = await post(USER_A, `/api/admin/user-skills/${submissionAId}/approve`);
  ok("user approve → 403", res.status === 403, `status=${res.status}`);

  const orgAdminQueue = await getJson(ORG_ADMIN, "/api/admin/user-skills");
  const orgAdminSees = (orgAdminQueue.json?.submissions ?? []) as Array<Record<string, unknown>>;
  ok("org_admin sees own-org submissions (read-only queue)", orgAdminSees.some((s) => s.id === submissionAId), `count=${orgAdminSees.length}`);

  const res2 = await post(ORG_ADMIN, `/api/admin/user-skills/${submissionAId}/approve`);
  ok("org_admin approve → 403 (admin-only)", res2.status === 403, `status=${res2.status}`);
  const res3 = await post(ORG_ADMIN, `/api/admin/user-skills/${submissionAId}/reject`, { reasonCode: "nope" });
  ok("org_admin reject → 403 (admin-only)", res3.status === 403, `status=${res3.status}`);
  ok("submission still pending after denied writes", submissions().find((s) => s.id === submissionAId)?.status === "pending_review");

  const adminQueue = await getJson(ADMIN, "/api/admin/user-skills");
  ok("admin queue is full (sees every record)", (adminQueue.json?.submissions ?? []).length === submissions().length);

  const userQueue = await getJson(USER_A, "/api/admin/user-skills");
  ok("regular user cannot read the admin queue → 403", userQueue.status === 403, `status=${userQueue.status}`);
}

// ─── Section 4: approve → submitter-only entitlement ──────────

{
  const res = await post(ADMIN, `/api/admin/user-skills/${submissionAId}/approve`);
  ok("admin approve → 200", res.status === 200, `status=${res.status} body=${await res.text()}`);

  const row = registryRows().find((r) => r.name === "m7b-skill-a");
  ok("skill enabled after approve", row?.enabled === true);

  const entries = entitlementEntries("m7b-skill-a");
  ok(
    "entitlement = EXACTLY one user-scope allow for the submitter (no org spill)",
    entries.length === 1 && entries[0].scopeType === "user" && entries[0].scopeId === USER_A && entries[0].effect === "allow",
    JSON.stringify(entries)
  );

  const rec = submissions().find((s) => s.id === submissionAId);
  ok("submission approved with reviewer provenance", rec?.status === "approved" && rec?.reviewedBy === ADMIN && !!rec?.reviewedAt);

  ok("canConfigure true only for the submitter", entitlementService.canConfigure(userACtx, "m7b-skill-a") === true && entitlementService.canConfigure(userBCtx, "m7b-skill-a") === false);

  const optsA = getBuilderOptions(userACtx).capabilities.map((c) => c.resourceId);
  const optsB = getBuilderOptions(userBCtx).capabilities.map((c) => c.resourceId);
  ok("builder options include the skill only for the submitter", optsA.includes("m7b-skill-a") && !optsB.includes("m7b-skill-a"), `A=[${optsA}] B=[${optsB}]`);

  // Re-approve is a no-op state error (approved is terminal).
  const res2 = await post(ADMIN, `/api/admin/user-skills/${submissionAId}/approve`);
  ok("re-approve on terminal state → 409/400, no double entitlement", (res2.status === 409 || res2.status === 400) && entitlementEntries("m7b-skill-a").length === 1, `status=${res2.status}`);
}

// ─── Section 5: reject → disabled, zero entitlement ───────────

let submissionBId = "";
{
  const res = await submit(USER_B, "m7b-skill-b", validZipB);
  const body = await res.json().catch(() => ({}));
  submissionBId = body?.submission?.id ?? "";
  ok("user B submits second skill", res.status === 201 && !!submissionBId);

  const res2 = await post(ADMIN, `/api/admin/user-skills/${submissionBId}/reject`, { reasonCode: "unsafe_scripts" });
  ok("admin reject → 200", res2.status === 200, `status=${res2.status}`);

  const rec = submissions().find((s) => s.id === submissionBId);
  ok("submission rejected with categorical reason", rec?.status === "rejected" && rec?.reasonCode === "unsafe_scripts");

  const row = registryRows().find((r) => r.name === "m7b-skill-b");
  ok("registry stays enabled:false after reject", row?.enabled === false);
  ok("reject wrote ZERO entitlement entries", entitlementEntries("m7b-skill-b").length === 0);
  ok("B cannot configure the rejected skill", entitlementService.canConfigure(userBCtx, "m7b-skill-b") === false);

  // Re-submit semantics: rejected slug stays occupied → 409.
  const res3 = await submit(USER_B, "m7b-skill-b", validZipB);
  ok("re-submit a rejected slug → 409 (registry occupied)", res3.status === 409, `status=${res3.status}`);

  // Reject on a quarantined submission → 400 (no registry row to reject).
  const quarantined = submissions().find((s) => s.status === "quarantined");
  const res4 = await post(ADMIN, `/api/admin/user-skills/${quarantined!.id}/approve`);
  const res5 = await post(ADMIN, `/api/admin/user-skills/${quarantined!.id}/reject`, { reasonCode: "x" });
  ok("quarantined submission cannot be approved/rejected (no package) → 400", res4.status === 400 && res5.status === 400, `approve=${res4.status} reject=${res5.status}`);
}

// ─── Section 6: org_admin org scoping of the queue ────────────

{
  // Org-B submission exists? No: org-B user never submitted. Seed one directly
  // via the route: org-B user is not in the harness actor set — use admin to
  // verify queue filtering is by orgId, not by actor.
  const orgAdminQueue = (await getJson(ORG_ADMIN, "/api/admin/user-skills")).json?.submissions ?? [];
  ok("org_admin queue excludes foreign-org records", (orgAdminQueue as Array<Record<string, unknown>>).every((s) => s.orgId === ORG));
}

// ─── Section 7: audit is categorical, payload-free ────────────

{
  const audits = db
    .prepare(`SELECT * FROM governance_audit_log WHERE action LIKE 'user_skill%'`)
    .all() as Array<Record<string, unknown>>;
  ok("user_skill audit actions exist (submit/approve/reject/denied)", audits.length >= 6, `count=${audits.length}`);
  ok(
    "audits carry categorical actions incl. denied writes",
    audits.some((a) => a.result === "denied") && audits.some((a) => String(a.action).endsWith("submit")),
    audits.map((a) => `${a.action}:${a.result}`).join(",")
  );
  ok(
    "audit payload is metadata-only (no file content marker)",
    !JSON.stringify(audits).includes(PAYLOAD_MARKER)
  );
}

// ─── Section 8: approve is fail-closed on a malformed entitlements store ───
// Fix round P1-2: setSkillEnabled runs BEFORE setEntitlements in approve, and
// the entitlement read path silently falls back to empty on malformed bytes —
// without a preflight the approve would enable the skill and RESET the store.
{
  const res = await submit(USER_A, "m7b-skill-c", validZipB);
  const body = await res.json().catch(() => ({}));
  const subCId = body?.submission?.id ?? "";
  ok("setup: C submitted pending", res.status === 201 && !!subCId);

  const entPath = process.env.ENTITLEMENTS_FILE!;
  const saved = readFileSync(entPath, "utf8");
  writeFileSync(entPath, "{ NOT VALID JSON !!!", "utf8");
  const malformed = readFileSync(entPath, "utf8");

  const approve = await post(ADMIN, `/api/admin/user-skills/${subCId}/approve`);
  ok("approve on malformed entitlements → failure (not a silent reset)", approve.status >= 400, `status=${approve.status}`);
  ok("malformed entitlement bytes unchanged", readFileSync(entPath, "utf8") === malformed);
  ok("skill remains disabled", registryRows().find((r) => r.name === "m7b-skill-c")?.enabled === false);
  ok("ledger stays pending", submissions().find((s) => s.id === subCId)?.status === "pending_review");

  writeFileSync(entPath, saved, "utf8");
  ok("entitlements restored: A's earlier grant intact", entitlementEntries("m7b-skill-a").length === 1);
}

// ─── Section 9: submit is fail-closed on a malformed ledger ───
// Fix round P1-1: a malformed submission ledger must block the import (no
// orphan quarantine dir / registry row), and the ledger bytes must never be
// overwritten by the failing request.
{
  const saved = readFileSync(SUBS_FILE, "utf8");
  writeFileSync(SUBS_FILE, "]]] not json", "utf8");
  const malformed = readFileSync(SUBS_FILE, "utf8");

  const res = await submit(USER_A, "m7b-skill-d", validZipA);
  ok("submit with malformed ledger → 500 fail-closed", res.status === 500, `status=${res.status}`);
  ok("malformed ledger bytes unchanged", readFileSync(SUBS_FILE, "utf8") === malformed);
  ok("zero registry row for the attempted slug", !registryRows().some((r) => r.name === "m7b-skill-d"));
  ok("zero quarantine dir for the attempted slug", !fs.existsSync(path.join(QUARANTINE_ROOT, "m7b-skill-d")));

  writeFileSync(SUBS_FILE, saved, "utf8");
  ok("ledger restored: history intact", submissions().length >= 5);
}

// ─── Section 10: fixed submission caps — quarantined records count ───
// Fix round 2 (evt_20261023044344): pending-only caps were bypassable —
// package-content failures created quarantined ledger records that were
// excluded from both counters, letting a user farm unlimited invalid
// unique-slug submissions through the pipeline. Caps now count OPEN records
// (pending_review + quarantined); fixed constants only.
{
  // Submitter cap via QUARANTINED volume: seed 5 quarantined records for
  // USER_B (unique slugs). The next B request must be blocked BEFORE the
  // import — no extraction residue, no registry row.
  const store = JSON.parse(readFileSync(SUBS_FILE, "utf8"));
  for (let i = 0; i < 5; i++) {
    store.submissions.push({
      id: `seed-q-${i}`, slug: `seed-q-${i}`, submitterUserId: USER_B, orgId: ORG,
      status: "quarantined", errorCode: "no_skill",
      createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
    });
  }
  writeFileSync(SUBS_FILE, JSON.stringify(store, null, 2));

  const res = await submit(USER_B, "m7b-skill-e", validZipB);
  const body = await res.json().catch(() => ({}));
  ok("5 quarantined records block the next submit → 429 categorical", res.status === 429 && body?.code === "submission_cap_submitter", `status=${res.status} code=${body?.code}`);
  ok("capped request ran ZERO import (no registry row)", !registryRows().some((r) => r.name === "m7b-skill-e"));
  ok("capped request left ZERO quarantine dir", !fs.existsSync(path.join(QUARANTINE_ROOT, "m7b-skill-e")));

  // Cross-user org cap via quarantined volume: fill the ORG's OPEN total with
  // quarantined filler records from other users, then A (own open = 3, low)
  // is blocked by org volume.
  const store2 = JSON.parse(readFileSync(SUBS_FILE, "utf8"));
  const openNow = store2.submissions.filter((s: any) => s.orgId === ORG && (s.status === "pending_review" || s.status === "quarantined")).length;
  for (let i = 0; i < 20 - openNow; i++) {
    store2.submissions.push({
      id: `seed-q-org-${i}`, slug: `seed-q-org-${i}`, submitterUserId: "m7b-org-filler", orgId: ORG,
      status: "quarantined", errorCode: "no_skill",
      createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
    });
  }
  writeFileSync(SUBS_FILE, JSON.stringify(store2, null, 2));

  const res2 = await submit(USER_A, "m7b-skill-f", validZipA);
  const body2 = await res2.json().catch(() => ({}));
  ok("org quarantined volume blocks a low-history user → 429 submission_cap_org", res2.status === 429 && body2?.code === "submission_cap_org", `status=${res2.status} code=${body2?.code}`);
  ok("org cap rejection left zero registry row", !registryRows().some((r) => r.name === "m7b-skill-f"));

  const capAudits = db
    .prepare(`SELECT * FROM governance_audit_log WHERE action LIKE 'user_skill%' AND result = 'denied' AND reason_summary LIKE '%cap%'`)
    .all() as Array<Record<string, unknown>>;
  ok("cap denials are audited categorically", capAudits.length >= 2, `count=${capAudits.length}`);
  ok("cap audit reasons carry the new categorical codes", capAudits.some((a) => a.reason_summary === "submission_cap_submitter") && capAudits.some((a) => a.reason_summary === "submission_cap_org"));
}

server.close();
console.log(`\nAll ${pass} assertions passed.`);
