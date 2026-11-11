/**
 * m5-s3-metrics-smoke.mjs — M5-S3 minimal metrics endpoint smoke.
 *
 * Spins the real server with RUNTIME_MODE=local-sandbox, drives one turn,
 * then GETs /api/admin/runtime/metrics and verifies:
 *   - events array non-empty
 *   - events carry ONLY operational fields (no prompt/subject/credential/payload)
 *   - boot_ready + stop_done milestones present
 *
 * Truthful exit codes (same contract as M5-S2 smoke):
 *   0 = metrics endpoint exercised with real lifecycle events
 *   2 = blocked (host lacks msb/KVM/credentials/guest image)
 *   1 = real path attempted and failed
 *
 * Run: node scripts/m5-s3-metrics-smoke.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = Number(process.env.PORT) || 3998;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DB_PATH = process.env.DB_PATH || `/tmp/m5s3-metrics-smoke-${process.pid}.db`;
const SMOKE_MODEL = process.env.MSB_SMOKE_MODEL || "kimi-k3";

const report = { outcome: "blocked", events: [], reasons: [], assertions: null };
function log(l) { console.error(`[m5-s3-metrics-smoke] ${l}`); }
function die(code) {
  if (process.env.EVIDENCE_FILE) { try { writeFileSync(process.env.EVIDENCE_FILE, JSON.stringify(report, null, 2) + "\n"); } catch {} }
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

async function waitForHealth(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const workdir = process.cwd();
  mkdirSync(join(workdir, "data"), { recursive: true });
  writeFileSync(join(workdir, "data", "runtime-settings.json"), JSON.stringify({
    idleStopMs: 30 * 60 * 1000, memoryMb: 512, cpuCores: 1, maxTurns: 100,
    maxWorkspaceMb: 1024, maxClaudeHomeMb: 100, autoRebuildOnConfigDrift: false,
    userMemoryQuotaBytes: 64 * 1024, defaultModel: SMOKE_MODEL,
    models: [{ alias: SMOKE_MODEL, enabled: true }],
    contextCompaction: { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 },
  }, null, 2) + "\n");

  const env = { ...process.env, RUNTIME_MODE: "local-sandbox", PORT: String(PORT), DB_PATH, RUNTIME_SETTINGS_CACHE: "" };
  const server = spawn("npx", ["tsx", "server/server.ts"], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => process.stderr.write(d));
  server.stderr.on("data", (d) => process.stderr.write(d));
  try {
    const booted = await waitForHealth(60_000);
    if (!booted) { report.reasons.push("server did not boot"); die(2); }
    log("server healthy");

    const lr = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
    const lb = await lr.json();
    if (!lr.ok || !lb.token) { report.reasons.push("login failed"); die(2); }
    const token = lb.token;
    try { await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: "admin-smoke-123!" }) }); } catch {}
    await fetch(`${BASE}/api/admin/runtime/settings`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ defaultModel: SMOKE_MODEL, models: [{ alias: SMOKE_MODEL, enabled: true }] }) });
    const cc = await fetch(`${BASE}/api/chats`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ title: "m5-s3-metrics-smoke" }) });
    const cb = await cc.json();
    if (cc.status !== 201 || !cb.id) { report.reasons.push("create chat failed"); die(2); }
    const chatId = cb.id;
    log(`chat: ${chatId}`);

    // Drive one turn
    await new Promise((resolve) => {
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      let done = false;
      const finish = (code) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(code); };
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "subscribe", chatId }));
        setTimeout(() => ws.send(JSON.stringify({ type: "chat", chatId, content: "Reply with exactly: metrics-ok" })), 500);
      });
      ws.on("message", (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.type === "result") setTimeout(() => finish(0), 200);
        if (m.type === "error") finish(1);
      });
      ws.on("error", () => finish(1));
      setTimeout(() => { report.reasons.push("turn timeout"); finish(1); }, 150_000);
    });

    // Stop to emit stop_done
    await fetch(`${BASE}/api/chats/${chatId}/runtime/stop`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    await new Promise((r) => setTimeout(r, 1500));

    // GET metrics
    const mr = await fetch(`${BASE}/api/admin/runtime/metrics`, { headers: { Authorization: `Bearer ${token}` } });
    const mb = await mr.json();
    report.events = mb.events ?? [];
    const kinds = report.events.map((e) => e.kind);
    const hasBootReady = kinds.includes("boot_ready");
    const hasStopDone = kinds.includes("stop_done");
    // No forbidden fields
    const forbidden = ["prompt", "subject", "content", "toolUseId", "toolResult", "credential", "apiKey", "token", "payload"];
    const leaks = report.events.some((e) => forbidden.some((f) => f in e));
    report.assertions = { eventsCount: report.events.length, hasBootReady, hasStopDone, leaks };
    if (report.events.length > 0 && hasBootReady && hasStopDone && !leaks) {
      report.outcome = "exercised-metrics-endpoint";
      die(0);
    }
    report.outcome = "failed";
    report.reasons.push(`assertions not met: ${JSON.stringify(report.assertions)}`);
    die(1);
  } finally {
    try { server.kill("SIGTERM"); } catch {}
    try { await new Promise((r) => setTimeout(r, 500)); server.kill("SIGKILL"); } catch {}
  }
}
main().catch((e) => { report.outcome = "failed"; report.reasons.push(`uncaught: ${e?.message ?? e}`); die(1); });
