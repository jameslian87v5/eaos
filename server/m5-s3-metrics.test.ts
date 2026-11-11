/**
 * m5-s3-metrics.test.ts — M5-S3 lifecycle metrics collector focused tests.
 *
 * Verifies: boot/recovery/stop timing recorded, status transitions correct,
 * failure category + redacted message captured, resource policy envelope
 * present, NO prompt/subject/credential/payload fields exist on events,
 * bounded ring buffer evicts oldest.
 *
 * Run: DB_PATH=/tmp/test-m5-s3-metrics.db JWT_SECRET=test npx tsx server/m5-s3-metrics.test.ts
 */
import assert from "node:assert/strict";
import { MicrosandboxMetricsCollector } from "./microsandbox-metrics.js";

let passed = 0, failed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
function atest(name: string, fn: () => Promise<void> | void): void { tests.push([name, fn]); }
async function main(): Promise<void> {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { failed++; console.error(`  FAIL - ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

// Deterministic clock for timing assertions.
function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ─── M.1: boot → ready timing + resource policy envelope ──────────────────

atest("M.1: noteBootStart → noteBootReady records elapsed + resource policy + resumed flag", () => {
  const clock = fakeClock();
  const c = new MicrosandboxMetricsCollector({ now: clock.now });
  c.noteBootStart("sb-1", false, { memoryMb: 512, cpuCores: 1, workspaceQuotaMb: 256 });
  clock.advance(120);
  c.noteBootReady("sb-1", false);
  const snap = c.snapshot();
  assert.equal(snap.length, 2);
  const boot = snap[0], ready = snap[1];
  assert.equal(boot.kind, "boot_start");
  assert.equal(boot.phase, "booting");
  assert.equal(boot.resumed, false);
  assert.deepEqual(boot.resourcePolicy, { memoryMb: 512, cpuCores: 1, workspaceQuotaMb: 256 });
  assert.equal(ready.kind, "boot_ready");
  assert.equal(ready.phase, "running");
  assert.equal(ready.elapsedMs, 120);
  assert.equal(ready.resumed, false);
});

// ─── M.2: cold recovery — resumed flag distinguishes boot from cold resume ─

atest("M.2: cold resume events carry resumed=true and use cold_resume_* kinds", () => {
  const clock = fakeClock();
  const c = new MicrosandboxMetricsCollector({ now: clock.now });
  c.noteBootStart("sb-2", true, { memoryMb: 512, cpuCores: 1, workspaceQuotaMb: 256 });
  clock.advance(200);
  c.noteBootReady("sb-2", true);
  const snap = c.snapshot();
  assert.equal(snap[0].kind, "cold_resume_start");
  assert.equal(snap[0].resumed, true);
  assert.equal(snap[1].kind, "cold_resume_ready");
  assert.equal(snap[1].elapsedMs, 200);
  assert.equal(snap[1].resumed, true);
});

// ─── M.3: boot failed — elapsed + redacted message ───────────────────────

atest("M.3: noteBootFailed records elapsed + category + redacted message", () => {
  const clock = fakeClock();
  const c = new MicrosandboxMetricsCollector({ now: clock.now });
  c.noteBootStart("sb-3", false, { memoryMb: 512, cpuCores: 1, workspaceQuotaMb: 256 });
  clock.advance(50);
  c.noteBootFailed("sb-3", false, "io", "sandbox start failed: /Users/james/secret sk-ant-1234");
  const snap = c.snapshot();
  const fail = snap[1];
  assert.equal(fail.kind, "boot_failed");
  assert.equal(fail.phase, "crashed");
  assert.equal(fail.elapsedMs, 50);
  assert.equal(fail.category, "io");
  // Message is already-redacted by the caller (microsandbox-runtime) — the
  // collector does NOT re-redact; it records what it's given. The caller
  // is responsible for calling redactRuntimeError first.
  assert.ok(fail.message?.includes("sandbox start failed"));
});

// ─── M.4: stop timing ──────────────────────────────────────────────────────

atest("M.4: noteStopStart → noteStopDone records elapsed + stopped phase", () => {
  const clock = fakeClock();
  const c = new MicrosandboxMetricsCollector({ now: clock.now });
  c.noteStopStart("sb-4");
  clock.advance(80);
  c.noteStopDone("sb-4");
  const snap = c.snapshot();
  assert.equal(snap[0].kind, "stop_start");
  assert.equal(snap[0].phase, "stopping");
  assert.equal(snap[1].kind, "stop_done");
  assert.equal(snap[1].phase, "stopped");
  assert.equal(snap[1].elapsedMs, 80);
});

// ─── M.5: turn terminal + runtime_error ────────────────────────────────────

atest("M.5: noteTurnTerminal + noteRuntimeError carry category only (no payload)", () => {
  const c = new MicrosandboxMetricsCollector();
  c.noteTurnTerminal("sb-5", "completed");
  c.noteRuntimeError("sb-5", "io", "transport error [redacted]");
  const snap = c.snapshot();
  assert.equal(snap[0].kind, "turn_terminal");
  assert.equal(snap[0].category, "completed");
  assert.equal(snap[0].elapsedMs, null);
  assert.equal(snap[1].kind, "runtime_error");
  assert.equal(snap[1].category, "io");
  assert.equal(snap[1].phase, "crashed");
});

// ─── M.6: NO prompt/subject/credential/payload fields exist on any event ───

atest("M.6: events carry ONLY operational fields — no prompt/subject/credential/payload", () => {
  const c = new MicrosandboxMetricsCollector();
  c.noteBootStart("sb-6", false, { memoryMb: 512, cpuCores: 1, workspaceQuotaMb: 256 });
  c.noteBootReady("sb-6", false);
  c.noteTurnTerminal("sb-6", "completed");
  c.noteStopStart("sb-6");
  c.noteStopDone("sb-6");
  for (const e of c.snapshot()) {
    const keys = Object.keys(e);
    // No prompt/subject/credential/tool payload fields.
    for (const forbidden of ["prompt", "subject", "content", "toolUseId", "toolResult", "credential", "apiKey", "token", "payload"]) {
      assert.ok(!keys.includes(forbidden), `event kind=${e.kind} must not carry '${forbidden}' (has: ${keys.join(",")})`);
    }
  }
});

// ─── M.7: bounded ring buffer evicts oldest ────────────────────────────────

atest("M.7: ring buffer bounded at maxEvents (default 64) — oldest evicted", () => {
  const c = new MicrosandboxMetricsCollector({ maxEvents: 3 });
  c.noteTurnTerminal("sb-7", "a");
  c.noteTurnTerminal("sb-7", "b");
  c.noteTurnTerminal("sb-7", "c");
  c.noteTurnTerminal("sb-7", "d");
  const snap = c.snapshot();
  assert.equal(snap.length, 3, "maxEvents=3 → retains last 3");
  assert.equal((snap[0] as { category?: string }).category, "b", "oldest (a) evicted");
  assert.equal((snap[2] as { category?: string }).category, "d", "newest (d) retained");
});

// ─── M.8: log sink fires for every event ───────────────────────────────────

atest("M.8: log sink receives every recorded event", () => {
  const logged: string[] = [];
  const c = new MicrosandboxMetricsCollector({ log: (e) => logged.push(e.kind) });
  c.noteBootStart("sb-8", false, { memoryMb: 512, cpuCores: 1, workspaceQuotaMb: 256 });
  c.noteBootReady("sb-8", false);
  c.noteStopStart("sb-8");
  c.noteStopDone("sb-8");
  assert.deepEqual(logged, ["boot_start", "boot_ready", "stop_start", "stop_done"]);
});

main().catch((e) => { console.error(e); process.exit(1); });
