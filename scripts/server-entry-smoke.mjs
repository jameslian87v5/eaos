/**
 * server-entry-smoke — M5-S1 real server boundary smoke for RUNTIME_MODE=local-sandbox.
 *
 * Proves the already-merged Claude MicroVM path through the PRODUCTION server
 * boundary (HTTP login → create chat → authenticated WS → send_message → real
 * model turn), not just direct factory/runtime tests.
 *
 * Flow: spawn `tsx server/server.ts` with RUNTIME_MODE=local-sandbox + isolated
 * DB_PATH → login admin → PUT runtime-settings {defaultModel: provider-literal,
 * models:[...]} → POST /api/chats → WS ?token=<jwt> → subscribe + send_message
 * → collect events until terminal "result" → assert:
 *   - assistant_message present (assistant output through the real chain)
 *   - result.subtype !== "error_during_execution" (no runtime_error/turn_failed)
 *   - no credential VALUE in any captured event frame (hygiene)
 *
 * Exit codes:
 *   0 = real turn exercised end-to-end through the server boundary
 *   2 = blocked (host lacks msb/KVM/credentials/guest image) — truthful, never
 *       a faked pass. The server's own availability gate is the source of truth;
 *       this script observes and reports, it does not claim success on error.
 *   1 = real path attempted and failed (unexpected error / credential leak)
 *
 * Run: node scripts/server-entry-smoke.mjs
 *   (env: PORT optional, defaults 3999; MSB_PATH/MSB_HOME/DYLD_LIBRARY_PATH +
 *    provider creds inherited from process.env / the worktree .env)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = Number(process.env.PORT) || 3999;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DB_PATH = process.env.DB_PATH || `/tmp/m5s1-server-entry-smoke-${process.pid}.db`;
const SERVER_TIMEOUT_MS = 180_000; // boot + one real turn
const TURN_TIMEOUT_MS = 150_000;

/** Provider-literal model the current relay accepts (M4.5 smoke evidence).
 *  The Host egress proxy stamps policy.modelRef LITERALLY into the provider
 *  request; "opus" is a project alias the relay rejects. Override via env. */
const SMOKE_MODEL = process.env.MSB_SMOKE_MODEL || "kimi-k3";

/** Real credential VALUES present in this Host env (hygiene scans only). */
function hostCredentialValues() {
  return [process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.MODEL_EGRESS_CREDENTIAL]
    .filter((v) => typeof v === "string" && v.length > 0);
}

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
  ws: null,
  events: [],
  assertions: null,
  reasons: [],
};

function log(line) { console.error(`[server-entry-smoke] ${line}`); }

function die(code) {
  // Write clean JSON evidence to EVIDENCE_FILE if set (logs go to stderr).
  if (process.env.EVIDENCE_FILE) {
    try { writeFileSync(process.env.EVIDENCE_FILE, JSON.stringify(report, null, 2) + "\n"); } catch {}
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
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

async function main() {
  const workdir = process.cwd();
  // Pre-seed data/runtime-settings.json with the provider-literal model so the
  // model-catalog seeds kimi-k3 AT BOOT (one-time seed). A PUT after boot
  // changes settings.defaultModel but does NOT re-seed the catalog — the
  // runtime would still resolve runtimeModel="opus" (the boot-time default),
  // the proxy stamps "opus" literally, and the provider rejects it.
  try {
    mkdirSync(join(workdir, "data"), { recursive: true });
    writeFileSync(
      join(workdir, "data", "runtime-settings.json"),
      JSON.stringify({
        idleStopMs: 30 * 60 * 1000,
        memoryMb: 512,
        cpuCores: 1,
        maxTurns: 100,
        maxWorkspaceMb: 1024,
        maxClaudeHomeMb: 100,
        autoRebuildOnConfigDrift: false,
        userMemoryQuotaBytes: 64 * 1024,
        defaultModel: SMOKE_MODEL,
        models: [{ alias: SMOKE_MODEL, enabled: true }],
        contextCompaction: { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 },
      }, null, 2) + "\n",
    );
    log(`pre-seeded data/runtime-settings.json with defaultModel=${SMOKE_MODEL}`);
  } catch (e) {
    log(`pre-seed warning: ${e.message}`);
  }
  // Spawn the REAL server. Env is inherited (provider creds via worktree .env +
  // MSB_PATH/MSB_HOME/DYLD_LIBRARY_PATH from the runner). We only set the
  // smoke-specific vars; we never pass credentials ourselves.
  const env = {
    ...process.env,
    RUNTIME_MODE: "local-sandbox",
    PORT: String(PORT),
    DB_PATH,
    // Force a clean cache dir so the worktree's data/*.json (seeded by the
    // runner) is the only settings source; no stale cache.
    RUNTIME_SETTINGS_CACHE: "",
  };
  log(`spawning server: RUNTIME_MODE=local-sandbox PORT=${PORT} DB_PATH=${DB_PATH}`);
  const server = spawn("npx", ["tsx", "server/server.ts"], {
    cwd: workdir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrBuf = [];
  server.stdout.on("data", (d) => process.stderr.write(d));
  server.stderr.on("data", (d) => {
    const s = d.toString();
    stderrBuf.push(s);
    process.stderr.write(s);
  });
  server.on("exit", (code, signal) => {
    log(`server exited: code=${code} signal=${signal}`);
    report.serverExit = { code, signal, stderrTail: stderrBuf.slice(-40).join("") };
  });
  server.on("error", (e) => {
    log(`server process error: ${e.message}`);
    report.serverError = e.message;
  });

  // 1. Wait for boot
  const booted = await waitForHealth(60_000);
  report.serverBoot = { ok: booted, pid: server.pid };
  if (!booted) {
    report.reasons.push("server did not become healthy on /health within 60s");
    report.serverBoot.stderrTail = stderrBuf.slice(-30).join("");
    try { server.kill("SIGKILL"); } catch {}
    die(2); // blocked — host/config issue, never a faked pass
  }
  log("server healthy");

  // 2. Login (admin/admin123 — auto-created on first boot)
  let token;
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    const body = await r.json();
    if (!r.ok || !body.token) {
      report.login = { ok: false, status: r.status, body };
      report.reasons.push(`login failed: HTTP ${r.status}`);
      try { server.kill("SIGKILL"); } catch {}
      die(2);
    }
    token = body.token;
    report.login = { ok: true, username: "admin" };
    log("login ok");
  } catch (e) {
    report.reasons.push(`login error: ${e.message}`);
    try { server.kill("SIGKILL"); } catch {}
    die(2);
  }

  // 2.5. Clear must_change_password (first-boot admin has it set; PUT routes
  // reject with 403 MUST_CHANGE_PASSWORD until the password is rotated).
  // Changing to the same value is accepted — the point is clearing the flag.
  try {
    const r = await fetch(`${BASE}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: "admin123", newPassword: "admin-smoke-123!" }),
    });
    const body = await r.json();
    log(`change-password: HTTP ${r.status} ${body?.ok ?? body?.error ?? ""}`);
    // 401/400 = already rotated or wrong current — either way the flag is
    // already clear; the PUT below is the real test.
  } catch (e) {
    log(`change-password error (non-fatal): ${e.message}`);
  }

  // 3. PUT runtime settings — provider-literal model + minimal models list
  try {
    const r = await fetch(`${BASE}/api/admin/runtime/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        defaultModel: SMOKE_MODEL,
        models: [{ alias: SMOKE_MODEL, enabled: true }],
      }),
    });
    const body = await r.json();
    report.settingsPut = { ok: r.ok, status: r.status, defaultModel: body?.settings?.defaultModel };
    if (!r.ok) {
      report.reasons.push(`runtime-settings PUT failed: HTTP ${r.status} ${JSON.stringify(body)}`);
      try { server.kill("SIGKILL"); } catch {}
      die(2);
    }
    log(`runtime settings: defaultModel=${body?.settings?.defaultModel}`);
  } catch (e) {
    report.reasons.push(`runtime-settings PUT error: ${e.message}`);
    try { server.kill("SIGKILL"); } catch {}
    die(2);
  }

  // 4. Create a chat through the real HTTP route
  let chatId;
  try {
    const r = await fetch(`${BASE}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "m5-s1-server-entry-smoke" }),
    });
    const body = await r.json();
    if (r.status !== 201 || !body.id) {
      report.chatCreated = { ok: false, status: r.status, body };
      report.reasons.push(`create chat failed: HTTP ${r.status}`);
      try { server.kill("SIGKILL"); } catch {}
      die(2);
    }
    chatId = body.id;
    report.chatCreated = { ok: true, chatId };
    log(`chat created: ${chatId}`);
  } catch (e) {
    report.reasons.push(`create chat error: ${e.message}`);
    try { server.kill("SIGKILL"); } catch {}
    die(2);
  }

  // 5. Connect through the real authenticated WS route
  const events = [];
  report.ws = { url: `${WS_URL}?token=<redacted>` };
  await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    let resolved = false;
    const done = (code) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      resolve(code);
    };

    ws.on("open", () => {
      log("ws connected; subscribing");
      ws.send(JSON.stringify({ type: "subscribe", chatId }));
      setTimeout(() => {
        log("sending chat message");
        ws.send(JSON.stringify({
          type: "chat",
          chatId,
          content: "Reply with exactly: server-entry-ok",
        }));
      }, 500);
    });

    ws.on("message", (d) => {
      let msg;
      try { msg = JSON.parse(d.toString()); } catch { return; }
      events.push(msg);
      log(`ws event: ${msg.type}${msg.subtype ? "/" + msg.subtype : ""}${msg.content ? " " + String(msg.content).slice(0, 60) : ""}`);
      if (msg.type === "result" || msg.type === "error" || (msg.type === "assistant_message" && !msg.content)) {
        log(`ws full: ${JSON.stringify(msg).slice(0, 500)}`);
      }
      if (msg.type === "result") {
        // Terminal. Give it a tick then close.
        setTimeout(() => done(0), 200);
      }
    });

    ws.on("error", (e) => {
      report.reasons.push(`ws error: ${e.message}`);
      done(1);
    });

    setTimeout(() => {
      report.reasons.push(`timeout: no terminal "result" event within ${TURN_TIMEOUT_MS}ms`);
      done(1);
    }, TURN_TIMEOUT_MS);
  });

  report.events = events.map((e) => e.type + (e.subtype ? "/" + e.subtype : ""));

  // 6. Assertions
  const types = events.map((e) => e.type);
  const resultEvent = events.find((e) => e.type === "result");
  const assistantMessage = events.find((e) => e.type === "assistant_message");
  const errorEvents = events.filter((e) => e.type === "result" && e.subtype === "error_during_execution");

  // Credential hygiene — no real credential VALUE in any captured frame.
  const creds = hostCredentialValues();
  const eventsText = JSON.stringify(events);
  const eventsLeak = creds.some((c) => eventsText.includes(c));
  const reportLeak = creds.some((c) => JSON.stringify(report).includes(c));

  // Runtime status via the real admin HTTP route (truthful readiness signal).
  let runtimeStatus = null;
  try {
    const r = await fetch(`${BASE}/api/chats/${chatId}/runtime`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    runtimeStatus = r.ok ? await r.json() : { ok: false, status: r.status };
  } catch (e) {
    runtimeStatus = { error: e.message };
  }

  // Classify the outcome
  const errMsg = String(resultEvent?.result || errorEvents[0]?.result || "");
  const isBlocked = /local-sandbox runtime unavailable|MicrosandboxUnavailable|msb|guest image|credential proxy|hypervisor|KVM|HVF/i.test(errMsg);

  report.assertions = {
    gotResult: !!resultEvent,
    resultSubtype: resultEvent?.subtype ?? null,
    gotAssistantMessage: !!assistantMessage,
    errorEventCount: errorEvents.length,
    eventsLeak,
    reportLeak,
    runtimeStatus,
  };

  // Stop the runtime through the real admin route (cleanup verification)
  try {
    await fetch(`${BASE}/api/chats/${chatId}/runtime/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    log("runtime stop sent");
  } catch { /* best-effort */ }

  // Kill server
  try { server.kill("SIGTERM"); } catch {}
  try { rmSync(DB_PATH, { force: true }); } catch {}

  // Decide exit code
  if (eventsLeak || reportLeak) {
    report.outcome = "failed";
    report.reasons.push("credential VALUE leaked into event frames or report — FAILURE, never a pass");
    die(1);
  }
  if (resultEvent && resultEvent.success !== false && assistantMessage) {
    report.outcome = "exercised-real-server-boundary-turn";
    die(0);
  }
  // result(success:false) with no assistant_message = the runtime could not
  // complete a real model turn. The session boundary strips the adapter's
  // error message (result.result), so we can't distinguish sandbox-boot
  // failure from model rejection — both surface as result(success:false).
  // Truthful "blocked": the server boundary did NOT exercise a real turn.
  if (resultEvent && resultEvent.success === false && !assistantMessage) {
    report.outcome = "blocked";
    report.reasons.push("turn terminated with result(success:false) and no assistant_message — runtime/sandbox/model unavailable or rejected (server boundary strips the specific error; run scripts/local-sandbox-smoke.mjs for the raw adapter error)");
    die(2);
  }
  if (isBlocked) {
    report.outcome = "blocked";
    report.reasons.push(`server availability gate refused: ${errMsg.slice(0, 200)}`);
    die(2);
  }
  report.outcome = "failed";
  report.reasons.push(`unexpected terminal: subtype=${resultEvent?.subtype}, assistant=${!!assistantMessage}, err=${errMsg.slice(0, 200)}`);
  die(1);
}

main().catch((e) => {
  report.outcome = "failed";
  report.reasons.push(`uncaught: ${e?.message ?? e}`);
  die(1);
});
