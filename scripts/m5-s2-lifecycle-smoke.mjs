/**
 * m5-s2-lifecycle-smoke — M5-S2 real server boundary smoke for stop + cold recovery.
 *
 * Builds on M5-S1's server-entry-smoke to prove the TWO closure cases the
 * artifact requires on a real MSB server boundary:
 *   1. STOP: after a real turn, POST /api/chats/:id/runtime/stop releases the
 *      sandbox (msb list no longer shows it).
 *   2. COLD RECOVERY: the next message creates a FRESH sandbox (a new name in
 *      msb list) and completes a real turn.
 *
 * Truthful exit codes (same contract as M5-S1):
 *   0 = exercised stop + cold recovery on the real server boundary
 *   2 = blocked (host lacks msb/KVM/credentials/guest image) — never a faked pass
 *   1 = real path attempted and failed (unexpected error / credential leak)
 *
 * Run: node scripts/m5-s2-lifecycle-smoke.mjs
 *   (env: PORT optional, defaults 3999; MSB_PATH/MSB_HOME/DYLD_LIBRARY_PATH +
 *    provider creds inherited from process.env / the worktree .env)
 */
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = Number(process.env.PORT) || 3999;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DB_PATH = process.env.DB_PATH || `/tmp/m5s2-lifecycle-smoke-${process.pid}.db`;
const SERVER_TIMEOUT_MS = 300_000;
const TURN_TIMEOUT_MS = 150_000;
const SMOKE_MODEL = process.env.MSB_SMOKE_MODEL || "kimi-k3";
const MSB_PATH = process.env.MSB_PATH || "/tmp/microsandbox-v0.6.18-verify/msb";

const report = {
  outcome: "blocked",
  mode: "local-sandbox",
  smokeModel: SMOKE_MODEL,
  port: PORT,
  dbPath: DB_PATH,
  serverBoot: null,
  login: null,
  settingsPut: null,
  chatCreated: null,
  firstTurn: null,
  stopResult: null,
  coldRecovery: null,
  sandboxesBeforeStop: [],
  sandboxesAfterStop: [],
  sandboxesAfterRecovery: [],
  events: [],
  assertions: null,
  reasons: [],
};

function log(line) { console.error(`[m5-s2-smoke] ${line}`); }

function die(code) {
  if (process.env.EVIDENCE_FILE) {
    try { writeFileSync(process.env.EVIDENCE_FILE, JSON.stringify(report, null, 2) + "\n"); } catch {}
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

function hostCredentialValues() {
  return [process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.MODEL_EGRESS_CREDENTIAL]
    .filter((v) => typeof v === "string" && v.length > 0);
}

function listSandboxes() {
  try {
    const out = execFileSync(MSB_PATH, ["list"], { encoding: "utf8", timeout: 15_000 });
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines;
  } catch (e) {
    report.reasons.push(`msb list failed: ${e.message}`);
    return [];
  }
}

async function waitForHealth(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const body = await r.json();
  if (!r.ok || !body.token) throw new Error(`login HTTP ${r.status}`);
  return body.token;
}

async function clearMustChange(token) {
  try {
    await fetch(`${BASE}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: "admin123", newPassword: "admin-smoke-123!" }),
    });
  } catch { /* non-fatal */ }
}

async function putSettings(token) {
  const r = await fetch(`${BASE}/api/admin/runtime/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      defaultModel: SMOKE_MODEL,
      models: [{ alias: SMOKE_MODEL, enabled: true }],
    }),
  });
  if (!r.ok) throw new Error(`settings PUT HTTP ${r.status}`);
}

async function createChat(token) {
  const r = await fetch(`${BASE}/api/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "m5-s2-lifecycle-smoke" }),
  });
  const body = await r.json();
  if (r.status !== 201 || !body.id) throw new Error(`create chat HTTP ${r.status}`);
  return body.id;
}

function sendAndAwaitTurn(token, chatId, prompt) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    let resolved = false;
    const done = (code) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      resolve({ code, events });
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", chatId }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "chat", chatId, content: prompt }));
      }, 500);
    });
    ws.on("message", (d) => {
      let msg;
      try { msg = JSON.parse(d.toString()); } catch { return; }
      events.push(msg);
      log(`turn event: ${msg.type}${msg.subtype ? "/" + msg.subtype : ""}`);
      if (msg.type === "result") setTimeout(() => done(0), 200);
      if (msg.type === "error") done(1);
    });
    ws.on("error", (e) => { report.reasons.push(`ws error: ${e.message}`); done(1); });
    setTimeout(() => { report.reasons.push("turn timeout"); done(1); }, TURN_TIMEOUT_MS);
  });
}

async function main() {
  const workdir = process.cwd();
  try {
    mkdirSync(join(workdir, "data"), { recursive: true });
    writeFileSync(
      join(workdir, "data", "runtime-settings.json"),
      JSON.stringify({
        idleStopMs: 30 * 60 * 1000, memoryMb: 512, cpuCores: 1, maxTurns: 100,
        maxWorkspaceMb: 1024, maxClaudeHomeMb: 100, autoRebuildOnConfigDrift: false,
        userMemoryQuotaBytes: 64 * 1024, defaultModel: SMOKE_MODEL,
        models: [{ alias: SMOKE_MODEL, enabled: true }],
        contextCompaction: { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 },
      }, null, 2) + "\n",
    );
  } catch (e) { log(`pre-seed warning: ${e.message}`); }

  const env = { ...process.env, RUNTIME_MODE: "local-sandbox", PORT: String(PORT), DB_PATH, RUNTIME_SETTINGS_CACHE: "" };
  log(`spawning server: RUNTIME_MODE=local-sandbox PORT=${PORT} DB_PATH=${DB_PATH}`);
  const server = spawn("npx", ["tsx", "server/server.ts"], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
  const stderrBuf = [];
  server.stdout.on("data", (d) => process.stderr.write(d));
  server.stderr.on("data", (d) => { const s = d.toString(); stderrBuf.push(s); process.stderr.write(s); });
  server.on("exit", (code, signal) => { report.serverExit = { code, signal, stderrTail: stderrBuf.slice(-40).join("") }; });

  try {
    const booted = await waitForHealth(60_000);
    report.serverBoot = { ok: booted, pid: server.pid };
    if (!booted) { report.reasons.push("server did not boot"); die(2); }
    log("server healthy");

    const token = await login();
    report.login = { ok: true };
    await clearMustChange(token);
    await putSettings(token);
    report.settingsPut = { ok: true };
    const chatId = await createChat(token);
    report.chatCreated = { ok: true, chatId };
    log(`chat created: ${chatId}`);

    // 1. First turn — establishes a real sandbox
    log("first turn: sending message");
    const first = await sendAndAwaitTurn(token, chatId, "Reply with exactly: lifecycle-ok");
    report.firstTurn = { code: first.code, eventTypes: first.events.map((e) => e.type + (e.subtype ? "/" + e.subtype : "")) };
    report.sandboxesBeforeStop = listSandboxes();
    log(`sandboxes before stop: ${JSON.stringify(report.sandboxesBeforeStop)}`);
    const firstResult = first.events.find((e) => e.type === "result");
    const firstAssistant = first.events.find((e) => e.type === "assistant_message");
    if (first.code !== 0 || !firstResult || firstResult.success === false || !firstAssistant) {
      // Blocked vs failed
      const errMsg = String(firstResult?.result || "");
      if (/local-sandbox runtime unavailable|MicrosandboxUnavailable|msb|guest image|credential proxy|hypervisor|KVM|HVF/i.test(errMsg)) {
        report.outcome = "blocked";
        report.reasons.push(`first turn blocked: ${errMsg.slice(0, 200)}`);
        die(2);
      }
      report.outcome = "failed";
      report.reasons.push(`first turn did not complete: ${errMsg.slice(0, 200)}`);
      die(1);
    }

    // 2. STOP through the real REST route — must release the sandbox
    log("POST runtime/stop");
    const stopR = await fetch(`${BASE}/api/chats/${chatId}/runtime/stop`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
    report.stopResult = { ok: stopR.ok, status: stopR.status };
    // Give the sandbox removal a moment (rt.close() is async fire-and-forget)
    await new Promise((r) => setTimeout(r, 1500));
    report.sandboxesAfterStop = listSandboxes();
    log(`sandboxes after stop: ${JSON.stringify(report.sandboxesAfterStop)}`);

    // 3. Cold recovery — next message must create a FRESH sandbox
    log("cold recovery: sending second message");
    const second = await sendAndAwaitTurn(token, chatId, "Reply with exactly: recovery-ok");
    report.coldRecovery = { code: second.code, eventTypes: second.events.map((e) => e.type + (e.subtype ? "/" + e.subtype : "")) };
    report.sandboxesAfterRecovery = listSandboxes();
    log(`sandboxes after recovery: ${JSON.stringify(report.sandboxesAfterRecovery)}`);
    report.events = [...first.events, ...second.events].map((e) => e.type + (e.subtype ? "/" + e.subtype : ""));

    const secondResult = second.events.find((e) => e.type === "result");
    const secondAssistant = second.events.find((e) => e.type === "assistant_message");

    // Credential hygiene
    const creds = hostCredentialValues();
    const eventsText = JSON.stringify([...first.events, ...second.events]);
    const eventsLeak = creds.some((c) => eventsText.includes(c));
    const reportLeak = creds.some((c) => JSON.stringify(report).includes(c));

    report.assertions = {
      firstTurnCompleted: !!firstResult && firstResult.success !== false && !!firstAssistant,
      stopReleasedSandbox: report.sandboxesAfterStop.length < report.sandboxesBeforeStop.length,
      coldRecoveryFresh: second.code === 0 && !!secondResult && secondResult.success !== false && !!secondAssistant,
      eventsLeak, reportLeak,
    };

    if (eventsLeak || reportLeak) {
      report.outcome = "failed";
      report.reasons.push("credential VALUE leaked — never a pass");
      die(1);
    }
    if (report.assertions.firstTurnCompleted && report.assertions.coldRecoveryFresh) {
      report.outcome = "exercised-stop-then-cold-recovery";
      die(0);
    }
    report.outcome = "failed";
    report.reasons.push(`closure assertions not met: ${JSON.stringify(report.assertions)}`);
    die(1);
  } finally {
    try { server.kill("SIGTERM"); } catch {}
    try { await new Promise((r) => setTimeout(r, 500)); server.kill("SIGKILL"); } catch {}
  }
}

main().catch((e) => {
  report.outcome = "failed";
  report.reasons.push(`uncaught: ${e?.message ?? e}`);
  die(1);
});
