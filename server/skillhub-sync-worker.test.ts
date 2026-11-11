/**
 * skillhub-sync-worker.test.ts — R5d-1 background sync closure tests.
 *
 * Covers directive §测试门禁:
 *  - shared lock (concurrent → busy, no double-sync)
 *  - config-absent → safety no-op (no Hub calls / mutation / status)
 *  - admin success path (TEAM targets, mapping-first)
 *  - same-version idempotency (skip on 2nd cycle)
 *  - 401/403/5xx/network error classification → categorical status + audit
 *  - recovery: failure then success updates lastSuccessAt
 *  - status query scoping: admin all; org_admin own-org only; cross-org absent
 *  - metadata-only: status stores categorical category, NEVER raw body/token
 *
 * Run: npx tsx server/skillhub-sync-worker.test.ts
 */
export {};

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let passed = 0, failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) passed++; else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

// ── hermetic reset ───────────────────────────────────────────────────────
const DB_PATH = "/tmp/r5d1-worker.db";
const ENT_FILE = "/tmp/r5d1-worker-ent.json";
const AC_FILE = "/tmp/r5d1-worker-ac.json";
const STATUS_FILE = "/tmp/r5d1-worker-status.json";
fs.rmSync(DB_PATH, { force: true });
fs.rmSync(`${DB_PATH}-wal`, { force: true });
fs.rmSync(`${DB_PATH}-shm`, { force: true });
fs.writeFileSync(ENT_FILE, JSON.stringify({ entries: [] }) + "\n");
fs.writeFileSync(AC_FILE, "{}\n");
fs.rmSync(STATUS_FILE, { force: true });
process.env.DB_PATH = DB_PATH;
process.env.ENTITLEMENTS_FILE = ENT_FILE;
process.env.AGENT_CAPABILITIES_FILE = AC_FILE;
process.env.SKILL_SYNC_STATUS_FILE = STATUS_FILE;

const db = (await import("./database.js")).default;
const {
  runSkillSyncCycleWith, runSkillSyncCycle, hubConfigured,
  __cycleInFlight, SKILL_SYNC_INTERVAL_MS,
} = await import("./skillhub-sync-worker.js");
const {
  recordAttempt, listStatusForScope, getStatusForScope, classifySyncError,
  clearStatusStore,
} = await import("./skillhub-sync-status.js");
const { orgNamespaceMappingService } = await import("./org-namespace-mapping.js");
const { resolveTeamSyncTargets } = await import("./skillhub-sync-targets.js");
const { orgService } = await import("./org-service.js");
// Seed orgs so the mapping FK is satisfied (mirrors org-namespace-mapping.test).
orgService.create("org-mapped", "Org Mapped");
orgService.create("org-i", "Org I");
orgService.create("org-e", "Org E");
orgService.create("org-r", "Org R");

// fakeRunOnce factory: records calls + returns configurable result per call.
function makeRunner(opts: {
  imported?: string[];
  skipped?: string[];
  errors?: Array<{ slug: string; reason: string }>;
  throwErr?: { status?: number; code?: string; message: string };
  delay?: () => Promise<void>;
} = {}) {
  const calls: Array<{ ns: string; orgId: string }> = [];
  const fn = async (ns: string, orgId: string) => {
    calls.push({ ns, orgId });
    if (opts.delay) await opts.delay();
    if (opts.throwErr) throw opts.throwErr;
    return {
      imported: opts.imported ?? [],
      skipped: opts.skipped ?? [],
      errors: opts.errors ?? [],
    };
  };
  return { fn, calls };
}

// ── 1. config-absent → safety no-op (no Hub calls / mutation / status) ────
{
  clearStatusStore();
  delete process.env.SKILLHUB_URL;
  delete process.env.SKILLHUB_TOKEN;
  assert(hubConfigured() === false, "1. hubConfigured=false when env absent");
  const { fn, calls } = makeRunner({ imported: ["foo"] });
  const r = await runSkillSyncCycleWith(
    [{ namespaceSlug: "ns-a", orgId: "org-a" }], fn, { hubConfigured: false },
  );
  assert(r.disabled === true, "1. disabled=true when Hub unconfigured");
  assert(calls.length === 0, "1. runOnce NOT called (no-op)");
  assert(r.imported === 0 && r.skipped === 0 && r.errors === 0, "1. zero counts");
  assert(listStatusForScope({ requesterRole: "admin", requesterOrgId: "" }).length === 0, "1. no status recorded (no fact)");
  console.log("✓ 1. config-absent → safety no-op (no calls / no mutation / no status)");
}

// ── 2. shared lock: concurrent cycle → busy, no double-sync ──────────────
{
  clearStatusStore();
  process.env.SKILLHUB_URL = "http://hub";
  process.env.SKILLHUB_TOKEN = "tok";
  let release: () => void = () => {};
  const block = new Promise<void>((resolve) => { release = resolve; });
  const { fn, calls } = makeRunner({ imported: ["foo"], delay: () => block });
  // Start a cycle that blocks inside runOnce; do NOT await yet.
  const p1 = runSkillSyncCycleWith([{ namespaceSlug: "ns-a", orgId: "org-a" }], fn, { hubConfigured: true });
  // Yield so p1 enters runOnce + sets cycleInFlight.
  await Promise.resolve(); await Promise.resolve();
  assert(__cycleInFlight() === true, "2. lock held while cycle in flight");
  // Second cycle while the first is in flight → busy, no runOnce call.
  const r2 = await runSkillSyncCycleWith([{ namespaceSlug: "ns-a", orgId: "org-a" }], fn, { hubConfigured: true });
  assert(r2.busy === true && r2.disabled === true, "2. second cycle → busy+disabled");
  assert(r2.imported === 0, "2. busy cycle imported 0");
  // Release the first cycle.
  release();
  const r1 = await p1;
  assert(__cycleInFlight() === false, "2. lock released after cycle completes");
  assert(r1.imported === 1, "2. first cycle imported 1");
  assert(calls.length === 1, `2. runOnce called exactly once (no double-sync), got ${calls.length}`);
  console.log("✓ 2. shared lock: concurrent → busy, no double-sync");
}

// ── 3. mapping-first: runSkillSyncCycle resolves TEAM targets from mapping
{
  clearStatusStore();
  // Seed a real mapping; the env fallback is empty so mapping drives targets.
  db.prepare("DELETE FROM org_namespace_mappings").run();
  orgNamespaceMappingService.upsert("org-mapped", "ns-mapped");
  const r = await runSkillSyncCycleWith(
    resolveTeamSyncTargets(), // mapping-first
    makeRunner({ imported: ["foo"] }).fn,
    { hubConfigured: true },
  );
  assert(r.targets === 1, `3. exactly 1 TEAM target from mapping, got ${r.targets}`);
  assert(r.disabled === false, "3. cycle enabled (Hub configured + targets)");
  assert(r.imported === 1, "3. imported 1");
  console.log("✓ 3. mapping-first: targets resolved from org_namespace_mappings");
}

// ── 4. same-version idempotency: 2nd cycle skip (marker-based, runSyncOnce
//     contract) — modelled via runOnce returning skipped on 2nd call ──────
{
  clearStatusStore();
  const calls: string[] = [];
  const runOnce = async (ns: string) => {
    calls.push(ns);
    // 1st call imports, 2nd call skips (marker match — idempotent).
    if (calls.length === 1) return { imported: ["foo"], skipped: [], errors: [] };
    return { imported: [], skipped: ["foo"], errors: [] };
  };
  const t1 = [{ namespaceSlug: "ns-i", orgId: "org-i" }];
  const r1 = await runSkillSyncCycleWith(t1, runOnce, { hubConfigured: true });
  assert(r1.imported === 1, "4. cycle1 imported foo");
  const r2 = await runSkillSyncCycleWith(t1, runOnce, { hubConfigured: true });
  assert(r2.imported === 0 && r2.skipped === 1, "4. cycle2 skip (idempotent)");
  const s = getStatusForScope("ns-i", { requesterRole: "admin", requesterOrgId: "" })!;
  assert(s.lastResult === "success" && s.skipped === 1, "4. status reflects skip on 2nd cycle");
  assert(!!s.lastSuccessAt, "4. lastSuccessAt set");
  console.log("✓ 4. same-version idempotency: 2nd cycle skip");
}

// ── 5. error classification: 401/403/5xx/network → categorical status +
//     audit, no raw body ─────────────────────────────────────────────────
{
  clearStatusStore();
  const cases: Array<{ err: { status?: number; code?: string; message: string }; want: string }> = [
    { err: { status: 401, message: "raw token leak xyz" }, want: "unauthorized" },
    { err: { status: 403, message: "forbidden raw" }, want: "forbidden" },
    { err: { status: 503, message: "upstream body dump" }, want: "http_5xx" },
    { err: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8080" }, want: "network" },
    { err: { message: "weird failure" }, want: "unknown" },
  ];
  for (const c of cases) {
    const ns = `ns-${c.want}`;
    const r = await runSkillSyncCycleWith(
      [{ namespaceSlug: ns, orgId: "org-e" }],
      makeRunner({ throwErr: c.err }).fn,
      { hubConfigured: true },
    );
    assert(r.disabled === false, `5. ${c.want}: cycle not disabled`);
    assert(r.errors === 1, `5. ${c.want}: aggregate errors=1 for namespace failure, got ${r.errors}`);
    const s = getStatusForScope(ns, { requesterRole: "admin", requesterOrgId: "" })!;
    assert(s.lastResult === "failure", `5. ${c.want}: lastResult=failure`);
    assert(s.errors === 1, `5. ${c.want}: status.errors=1 for namespace failure`);
    assert(s.errorCategory === c.want, `5. ${c.want}: errorCategory=${s.errorCategory}`);
    // metadata-only铁律: raw message must NOT appear in the status sidecar.
    const raw = fs.readFileSync(STATUS_FILE, "utf8");
    assert(!raw.includes(c.err.message), `5. ${c.want}: raw message leaked into status file`);
    assert(!/token|authorization|bearer/i.test(raw), `5. ${c.want}: no token-ish field in status file`);
  }
  // audit row for namespace_failed with categorical reason (no raw body).
  const auditRow = db.prepare(
    "SELECT reason_summary FROM governance_audit_log WHERE action = 'skillhub.namespace_failed' AND object_id = ?",
  ).get(`ns-${cases[0].want}`) as { reason_summary: string } | undefined;
  assert(!!auditRow, "5. skillhub.namespace_failed audit row exists");
  assert(!auditRow!.reason_summary.includes("raw token leak"), "5. audit reason is categorical (no raw body)");
  console.log("✓ 5. error classification: 401/403/5xx/network → categorical + audit (no raw body)");
}

// ── 6. recovery: failure then success updates lastSuccessAt ──────────────
{
  clearStatusStore();
  const t = [{ namespaceSlug: "ns-r", orgId: "org-r" }];
  const r1 = await runSkillSyncCycleWith(t, makeRunner({ throwErr: { status: 503, message: "boom" } }).fn, { hubConfigured: true });
  assert(r1.errors === 1 && getStatusForScope("ns-r", { requesterRole: "admin", requesterOrgId: "" })!.lastResult === "failure", "6. cycle1 failure recorded (errors=1)");
  const r2 = await runSkillSyncCycleWith(t, makeRunner({ imported: ["foo"] }).fn, { hubConfigured: true });
  assert(r2.imported === 1, "6. cycle2 success");
  const s = getStatusForScope("ns-r", { requesterRole: "admin", requesterOrgId: "" })!;
  assert(s.lastResult === "success", "6. lastResult=success after recovery");
  assert(!!s.lastSuccessAt, "6. lastSuccessAt set after recovery");
  assert(!!s.lastAttemptAt, "6. lastAttemptAt set");
  console.log("✓ 6. recovery: failure → success updates lastSuccessAt");
}

// ── 7. status query scoping: admin all; org_admin own-org; cross-org absent
{
  clearStatusStore();
  // Seed two namespace statuses in different orgs.
  recordAttempt("ns-own", "org-own", "success", { imported: 1, skipped: 0, errors: 0 }, null);
  recordAttempt("ns-other", "org-other", "success", { imported: 2, skipped: 0, errors: 0 }, null);
  recordAttempt("@global", "", "success", { imported: 3, skipped: 0, errors: 0 }, null);

  const adminAll = listStatusForScope({ requesterRole: "admin", requesterOrgId: "" });
  assert(adminAll.length === 3, `7. admin sees all 3, got ${adminAll.length}`);

  const own = listStatusForScope({ requesterRole: "org_admin", requesterOrgId: "org-own" });
  assert(own.length === 1 && own[0].namespaceSlug === "ns-own", "7. org_admin sees own-org only");
  assert(!own.find((s) => s.namespaceSlug === "ns-other"), "7. cross-dept namespace ABSENT (no existence leak)");
  assert(!own.find((s) => s.namespaceSlug === "@global"), "7. @global admin-only (no org_admin leak)");

  // Single-namespace cross-org read → null (no leak).
  const cross = getStatusForScope("ns-other", { requesterRole: "org_admin", requesterOrgId: "org-own" });
  assert(cross === null, "7. cross-org getStatus → null (no leak)");
  const ownSingle = getStatusForScope("ns-own", { requesterRole: "org_admin", requesterOrgId: "org-own" });
  assert(!!ownSingle, "7. own-org getStatus → present");
  console.log("✓ 7. status scoping: admin all; org_admin own-org; cross-org absent");
}

// ── 8. classifySyncError direct unit + status file metadata-only shape ──
{
  assert(classifySyncError({ status: 401, message: "x" } as any) === "unauthorized", "8. classify 401");
  assert(classifySyncError({ status: 404, message: "x" } as any) === "http_4xx", "8. classify 404");
  assert(classifySyncError({ status: 500, message: "x" } as any) === "http_5xx", "8. classify 500");
  assert(classifySyncError({ code: "ENOTFOUND", message: "x" } as any) === "network", "8. classify ENOTFOUND");
  assert(classifySyncError(new Error("fetch failed: network down")) === "network", "8. classify fetch failed");
  assert(classifySyncError(new Error("mystery")) === "unknown", "8. classify unknown");
  // status file shape: only categorical fields, no payload/body/token columns.
  const store = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  const keys = new Set<string>();
  for (const v of Object.values(store) as any[]) for (const k of Object.keys(v)) keys.add(k);
  const bad = [...keys].filter((k) => /payload|body|token|raw|message|stack|error/i.test(k) && k !== "errorCategory" && k !== "errors" && k !== "lastResult");
  assert(bad.length === 0, `8. status fields metadata-only, suspect=[${bad.join(",")}]`);
  console.log("✓ 8. classifySyncError unit + status file metadata-only shape");
}

// ── 9. interval default + 0 disables worker ──────────────────────────────
{
  const { startSkillSyncWorker, stopSkillSyncWorker } = await import("./skillhub-sync-worker.js");
  // SKILL_SYNC_INTERVAL_MS default is 300000 (5 min); 0 → disabled.
  assert(SKILL_SYNC_INTERVAL_MS === 300_000, `9. default interval 5min, got ${SKILL_SYNC_INTERVAL_MS}`);
  startSkillSyncWorker(0); // no-op (disabled)
  stopSkillSyncWorker();
  console.log("✓ 9. interval default 5min; 0 disables worker");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
process.exit(0);
