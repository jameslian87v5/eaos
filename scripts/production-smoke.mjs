#!/usr/bin/env node
/**
 * Task 5 — parameterized production smoke (plan §Task 5).
 *
 * Env:
 *   SMOKE_BASE_URL     default http://127.0.0.1:3001
 *   SMOKE_USERNAME     required (base flow)
 *   SMOKE_PASSWORD     required (base flow)
 *   SMOKE_TIMEOUT_MS   per-turn timeout, default 120000
 *   SMOKE_EXTENDED=1    run extended flow (approval-reject, skill, Bailian,
 *                      LocalFetch-approve, audit queryability)
 *   SMOKE_SKILL_NAME   skill name used by the extended skill step
 *   DASHSCOPE_API_KEY  present → extended Bailian step runs, else SKIP
 *   SMOKE_CHECK_DOCKER=1  run the on-VM HostIp=127.0.0.1 container check
 *                         (needs docker CLI; otherwise SKIP)
 *   SMOKE_DB_PATH      eaos.db path for the runId/audit queryability check
 *                      (co-located/on-VM only; else SKIP). Read-only via
 *                      better-sqlite3, cross-checked against
 *                      GET /api/admin/runs/:runId.
 *
 * Output: PASS/FAIL/SKIP per step + total time. Tokens/passwords are held in
 * memory only and NEVER printed. Missing required config → SKIP with the
 * variable NAMES listed, exit code 2. Any FAIL → exit 1 (staging gate).
 */
import { WebSocket } from "ws";
import { execFileSync } from "node:child_process";

const BASE_URL = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3001";
const USERNAME = process.env.SMOKE_USERNAME;
const PASSWORD = process.env.SMOKE_PASSWORD;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 120000);
const EXTENDED = process.env.SMOKE_EXTENDED === "1" || process.env.EXTENDED === "1";
const SKILL_NAME = process.env.SMOKE_SKILL_NAME;
const HAS_DASHSCOPE = Boolean(process.env.DASHSCOPE_API_KEY);
const CHECK_DOCKER = process.env.SMOKE_CHECK_DOCKER === "1";
const DB_PATH = process.env.SMOKE_DB_PATH;

const results = [];
const t0 = Date.now();

function record(step, status, detail = "") {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ step, status });
  console.log(`[${status}] ${step}${detail ? ` — ${detail}` : ""}  (+${secs}s)`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

function wsUrl(token) {
  return `${BASE_URL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

/** Open WS, subscribe, run one turn. Resolves with collected events. */
function runTurn({ chatId, token, content, onEvent, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(wsUrl(token));
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`turn timed out after ${timeoutMs}ms; got events: ${events.map((e) => e.type).join(",") || "none"}`));
    }, timeoutMs);
    ws.on("error", (e) => { clearTimeout(timer); reject(new Error(`ws error: ${e.message}`)); });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", chatId }));
    });
    ws.on("message", (d) => {
      let msg;
      try { msg = JSON.parse(d.toString()); } catch { return; }
      events.push(msg);
      if (msg.type === "error") {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(new Error(`server error event: ${msg.error}`));
        return;
      }
      if (onEvent && onEvent(msg, ws) === "done") {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(events);
      }
    });
    // Send the user turn once subscribed (history arrives first).
    const sendWhenReady = setInterval(() => {
      if (events.some((e) => e.type === "history")) {
        clearInterval(sendWhenReady);
        ws.send(JSON.stringify({ type: "chat", chatId, content }));
      }
    }, 100);
    setTimeout(() => clearInterval(sendWhenReady), timeoutMs);
  });
}

const hasType = (events, t) => events.some((e) => e.type === t);

function dockerInspectHostIp(chatId) {
  // Find this chat's agent container and assert its 9100 port binds loopback.
  // Container names carry the chatId's first 8 chars (eaos-agent-<8>-<4>),
  // the same truncation ContainerManager itself uses, so match on that.
  const needle = chatId.replace(/-/g, "").slice(0, 8);
  const list = execFileSync("docker", [
    "ps", "-a", "--filter", "label=app=eaos-agent",
    "--format", "{{.ID}} {{.Names}}",
  ], { encoding: "utf8" });
  const line = list.split("\n").find((l) => l.includes(needle));
  if (!line) return { found: false };
  const id = line.split(" ")[0];
  const inspect = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" }))[0];
  const bindings = inspect.HostConfig?.PortBindings?.["9100/tcp"] || [];
  return { found: true, hostIps: bindings.map((b) => b.HostIp), hostPorts: bindings.map((b) => b.HostPort) };
}

async function cleanup(chatIds, token) {
  // P1.2 (review): cleanup must be VERIFIED, not assumed — a swallowed DELETE
  // error must surface as FAIL, not a silent PASS.
  if (chatIds.length === 0) {
    record("cleanup test chats", "FAIL", "no chats were created — earlier steps failed");
    return;
  }
  let ok = 0;
  const failed = [];
  for (const id of chatIds) {
    try {
      const { status } = await api(`/api/chats/${id}`, { method: "DELETE", token });
      if (status >= 200 && status < 300) ok++;
      else failed.push(`${id.slice(0, 8)}→${status}`);
    } catch (e) {
      failed.push(`${id.slice(0, 8)}→${e.message}`);
    }
  }
  if (failed.length === 0) record("cleanup test chats", "PASS", `${ok} deleted, all verified`);
  else record("cleanup test chats", "FAIL", `not deleted: ${failed.join(", ")}`);
}

/** Latest run + linked event types for a chat, read-only (audit queryability). */
async function latestRunForChat(chatId) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare(
      `SELECT id, status FROM agent_runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1`
    ).get(chatId);
    if (!run) return null;
    const events = db.prepare(
      `SELECT event_type AS type FROM agent_events WHERE run_id = ? ORDER BY sequence`
    ).all(run.id);
    return { runId: run.id, status: run.status, eventTypes: events.map((e) => e.type) };
  } finally {
    db.close();
  }
}

async function main() {
  console.log(`== chit-agentos production smoke ==`);
  console.log(`base-url: ${BASE_URL}   extended: ${EXTENDED ? "1" : "0"}   timeout: ${TIMEOUT_MS}ms`);

  // ── Base flow ─────────────────────────────────────────────────────────
  const missing = ["SMOKE_USERNAME", "SMOKE_PASSWORD"].filter(
    (n) => !process.env[n]
  );
  if (missing.length > 0) {
    console.log(`\nSKIP: missing required env: ${missing.join(", ")}`);
    process.exit(2);
  }

  // 1. Health
  try {
    const { status, json } = await api("/health");
    if (status === 200 && json?.db === "ok") record("GET /health → 200 db=ok", "PASS");
    else record("GET /health → 200 db=ok", "FAIL", `status=${status} db=${json?.db}`);
  } catch (e) { record("GET /health → 200 db=ok", "FAIL", e.message); }

  // 2. Login (token stays in memory, never printed).
  //    First-boot admins carry must_change_password=1 and every protected
  //    endpoint answers 403 MUST_CHANGE_PASSWORD. Production should use a
  //    dedicated smoke user; for a first-boot drill set SMOKE_NEW_PASSWORD and
  //    the script performs the mandatory change (runbook §8) then re-logs in.
  let token = null;
  let password = PASSWORD;
  try {
    const { status, json } = await api("/api/auth/login", {
      method: "POST", body: { username: USERNAME, password },
    });
    if (status === 200 && json?.token) {
      token = json.token;
      record("POST /api/auth/login → token", "PASS");
      if (json.mustChangePassword) {
        const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD;
        if (!NEW_PASSWORD) {
          token = null;
          record("must_change_password handled", "FAIL",
            "account must change password first: set SMOKE_NEW_PASSWORD (drill) or use a dedicated smoke user");
        } else {
          const cp = await api("/api/auth/change-password", {
            method: "POST", token, body: { oldPassword: password, newPassword: NEW_PASSWORD },
          });
          if (cp.status === 200) {
            password = NEW_PASSWORD;
            const re = await api("/api/auth/login", {
              method: "POST", body: { username: USERNAME, password },
            });
            if (re.status === 200 && re.json?.token) {
              token = re.json.token;
              record("must_change_password handled (changed + re-login)", "PASS");
            } else {
              token = null;
              record("must_change_password handled (changed + re-login)", "FAIL", `re-login status=${re.status}`);
            }
          } else {
            token = null;
            record("must_change_password handled", "FAIL", `change-password status=${cp.status}`);
          }
        }
      }
    } else record("POST /api/auth/login → token", "FAIL", `status=${status}`);
  } catch (e) { record("POST /api/auth/login → token", "FAIL", e.message); }

  const chatIds = [];
  let baseChatId = null;

  if (token) {
    // 3. Unique-timestamp chat
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    try {
      const { status, json } = await api("/api/chats", {
        method: "POST", token, body: { title: `smoke-${stamp}` },
      });
      baseChatId = json?.id ?? json?.chat?.id ?? null;
      if ((status === 200 || status === 201) && baseChatId) {
        chatIds.push(baseChatId);
        record(`POST /api/chats → unique chat (${stamp})`, "PASS");
      } else record("POST /api/chats → unique chat", "FAIL", `status=${status}`);
    } catch (e) { record("POST /api/chats → unique chat", "FAIL", e.message); }

    // 4+5. Same-origin WS turn: assistant + result within timeout
    if (baseChatId) {
      try {
        const events = await runTurn({
          chatId: baseChatId, token,
          content: "Reply with just the word: pong",
          onEvent: (m) => (m.type === "result" ? "done" : undefined),
        });
        const sawAssistant = hasType(events, "assistant_message") || hasType(events, "assistant");
        if (sawAssistant && hasType(events, "result")) {
          record("WS turn → assistant + result events", "PASS",
            `${events.length} events`);
        } else {
          record("WS turn → assistant + result events", "FAIL",
            `types seen: ${events.map((e) => e.type).join(",")}`);
        }
      } catch (e) { record("WS turn → assistant + result events", "FAIL", e.message); }

      // 6. On-VM container bind check (loopback only)
      if (CHECK_DOCKER) {
        try {
          const r = dockerInspectHostIp(baseChatId);
          if (!r.found) {
            record("agent container PortBindings HostIp=127.0.0.1", "SKIP",
              "no agent container for this chat (local runtime or already stopped)");
          } else if (r.hostIps.length > 0 && r.hostIps.every((ip) => ip === "127.0.0.1")) {
            record("agent container PortBindings HostIp=127.0.0.1", "PASS",
              `ports ${r.hostPorts.join(",")}`);
          } else {
            record("agent container PortBindings HostIp=127.0.0.1", "FAIL",
              `HostIp values: ${r.hostIps.join(",") || "(none)"}`);
          }
        } catch (e) { record("agent container PortBindings HostIp=127.0.0.1", "FAIL", e.message); }
      } else {
        record("agent container PortBindings HostIp=127.0.0.1", "SKIP",
          "set SMOKE_CHECK_DOCKER=1 on the VM to enable");
      }
    }
  }

  // ── Extended flow ─────────────────────────────────────────────────────
  if (EXTENDED && token) {
    const stamp2 = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const { json: created } = await api("/api/chats", {
      method: "POST", token, body: { title: `smoke-ext-${stamp2}` },
    });
    const extChatId = created?.id ?? created?.chat?.id ?? null;
    if (extChatId) chatIds.push(extChatId);

    if (extChatId) {
      // Extended turns allow multi-tool chains: double the base timeout.
      const extTimeout = TIMEOUT_MS * 2;

      // E1. Approval REJECT: force a Write, reject it, agent must still finish.
      // Only meaningful where approvals are actually enforced (docker runtime
      // PreToolUse / host ApprovalManager); a profile that auto-approves shows
      // no approval_request at all → SKIP, not FAIL.
      try {
        const events = await runTurn({
          chatId: extChatId, token, timeoutMs: extTimeout,
          content: "Create the file /workspace/output/smoke-approval.txt containing the single word hi. Do not do anything else.",
          onEvent: (m, ws) => {
            if (m.type === "approval_request" && m.id) {
              ws.send(JSON.stringify({
                type: "approval_response", chatId: extChatId,
                id: m.id, approved: false, message: "smoke: rejected",
              }));
            }
            return m.type === "result" ? "done" : undefined;
          },
        });
        const sawReq = hasType(events, "approval_request");
        const finished = hasType(events, "result");
        if (sawReq && finished) {
          // P1.2 (review fail-closed): rejection must mean the action did NOT
          // happen. Scan the agent output dir and ASSERT the file is absent.
          // scan-output must itself 2xx, and the files list must load — any
          // failure is FAIL, never assume absence.
          const FILE_NAME = "smoke-approval.txt";
          let absent = null; // null = verification failed (→ FAIL, not PASS)
          let listingErr = null;
          try {
            const scan = await api(`/api/chats/${extChatId}/files/scan-output`, { method: "POST", token });
            if (!(scan.status >= 200 && scan.status < 300)) {
              listingErr = `scan-output HTTP ${scan.status}`;
            } else {
              const { status: lsStatus, json: files } = await api(`/api/chats/${extChatId}/files`, { token });
              if (lsStatus === 200) {
                const list = Array.isArray(files) ? files : files?.files ?? [];
                const names = list.map((f) => f?.filename ?? f?.name ?? "");
                absent = !names.includes(FILE_NAME);
              } else {
                listingErr = `files endpoint HTTP ${lsStatus}`;
              }
            }
          } catch (e) { listingErr = e.message; }
          if (listingErr) {
            record("approval REJECT → tool denied, turn still completes", "FAIL",
              `output listing failed (fail-closed): ${listingErr}`);
          } else if (absent === false) {
            record("approval REJECT → tool denied, turn still completes", "FAIL",
              `${FILE_NAME} EXISTS despite rejection — approval gate broken`);
          } else {
            record("approval REJECT → tool denied, turn still completes", "PASS",
              "rejected Write verified absent from /workspace/output");
          }
        }
        else if (!sawReq && finished) record("approval REJECT → tool denied, turn still completes", "SKIP",
          "no approval_request observed (profile auto-approves); turn completed");
        else record("approval REJECT → tool denied, turn still completes", "FAIL",
          `approval_request=${sawReq} result=${finished}`);
      } catch (e) { record("approval REJECT → tool denied, turn still completes", "FAIL", e.message); }

      // E2. Skill (SMOKE_SKILL_NAME)
      if (SKILL_NAME) {
        try {
          const events = await runTurn({
            chatId: extChatId, token, timeoutMs: extTimeout,
            content: `Use the skill "${SKILL_NAME}" now.`,
            onEvent: (m) => (m.type === "result" ? "done" : undefined),
          });
          // P1.2 (review): the named skill must be actually INVOKED as a
          // Skill tool, AND its tool_use must be paired with a tool_result
          // by toolId — not just any tool_result anywhere in the stream.
          const skillUse = events.find((e) => {
            if (e.type !== "tool_use") return false;
            const tn = e.toolName ?? e.tool_name ?? e.tool;
            if (tn !== "Skill") return false;
            const inp = JSON.stringify(e.toolInput ?? e.tool_input ?? e.input ?? {});
            return inp.includes(SKILL_NAME);
          });
          const skillToolId = skillUse?.toolUseId ?? skillUse?.tool_use_id ?? skillUse?.id ?? null;
          const pairedResult = skillToolId
            ? events.some((e) => e.type === "tool_result" &&
                (e.toolUseId === skillToolId || e.tool_use_id === skillToolId ||
                 e.toolUseResult?.toolUseId === skillToolId))
            : false;
          if (hasType(events, "result") && skillUse && pairedResult) {
            record("skill mount → named Skill invoked (tool_use→tool_result by toolId)", "PASS",
              `Skill toolInput matched "${SKILL_NAME}"; toolId ${String(skillToolId).slice(0,8)}`);
          } else {
            record("skill mount → named Skill invoked (tool_use→tool_result by toolId)", "FAIL",
              `skillUse=${!!skillUse}; pairedResult=${pairedResult}; types: ${events.map((e) => e.type).join(",")}`);
          }
        } catch (e) { record("skill mount → named Skill invoked (tool_use→tool_result by toolId)", "FAIL", e.message); }
      } else {
        record("skill mount → tool_use/tool_result observed", "SKIP", "SMOKE_SKILL_NAME not set");
      }

      // E3. Bailian search (only when the key is configured)
      if (HAS_DASHSCOPE) {
        try {
          const events = await runTurn({
            chatId: extChatId, token, timeoutMs: extTimeout,
            content: "Search the web for today's date and reply with just the date.",
            onEvent: (m, ws) => {
              if (m.type === "approval_request" && m.id) {
                ws.send(JSON.stringify({
                  type: "approval_response", chatId: extChatId,
                  id: m.id, approved: true, message: "smoke: approved",
                }));
              }
              return m.type === "result" ? "done" : undefined;
            },
          });
          const searchTool = events.some((e) =>
            JSON.stringify(e).includes("Bailian") || JSON.stringify(e).includes("bailian_search"));
          if (hasType(events, "result") && searchTool) {
            record("Bailian search → tool executed", "PASS");
          } else {
            record("Bailian search → tool executed", "FAIL", "no Bailian tool evidence in events");
          }
        } catch (e) { record("Bailian search → tool executed", "FAIL", e.message); }
      } else {
        record("Bailian search → tool executed", "SKIP", "DASHSCOPE_API_KEY not set");
      }

      // E4. LocalFetch with approval (approve on request if one comes;
      // a profile that auto-approves still counts as long as the tool ran).
      try {
        const events = await runTurn({
          chatId: extChatId, token, timeoutMs: extTimeout,
          content: "Fetch https://example.com and reply with its page title only. Do not use any other tool.",
          onEvent: (m, ws) => {
            if (m.type === "approval_request" && m.id) {
              ws.send(JSON.stringify({
                type: "approval_response", chatId: extChatId,
                id: m.id, approved: true, message: "smoke: approved",
              }));
            }
            return m.type === "result" ? "done" : undefined;
          },
        });
        const fetchTool = events.some((e) =>
          JSON.stringify(e).includes("LocalFetch") || JSON.stringify(e).includes("web_fetch"));
        if (hasType(events, "result") && fetchTool) {
          record("LocalFetch approval → tool_result + result", "PASS",
            hasType(events, "approval_request") ? "approval requested + approved" : "auto-approved profile");
        } else {
          record("LocalFetch approval → tool_result + result", "FAIL",
            `types: ${events.map((e) => e.type).join(",")}`);
        }
      } catch (e) { record("LocalFetch approval → tool_result + result", "FAIL", e.message); }

      // E5. Event queryability: history replay contains the exchange
      try {
        const events = await new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl(token));
          const got = [];
          ws.on("error", reject);
          ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", chatId: extChatId })));
          ws.on("message", (d) => {
            const m = JSON.parse(d.toString());
            got.push(m);
            if (m.type === "history") { try { ws.close(); } catch {} resolve(got); }
          });
          setTimeout(() => reject(new Error("history timeout")), 15000);
        });
        const hist = events.find((e) => e.type === "history");
        const msgs = hist?.messages || [];
        const hasUser = msgs.some((m) => m.role === "user");
        const hasAssistant = msgs.some((m) => m.role === "assistant");
        if (hasUser && hasAssistant) record("events queryable via history replay", "PASS", `${msgs.length} messages`);
        else record("events queryable via history replay", "FAIL", `user=${hasUser} assistant=${hasAssistant}`);
      } catch (e) { record("events queryable via history replay", "FAIL", e.message); }

      // E6. runId + approval/tool audit queryable (on-VM / co-located only).
      // DB read gives the latest runId + audit event types for this chat; the
      // admin API must then serve the SAME runId and its event summary must
      // include the same approval/tool event types (M3 execution-audit end to
      // end). Fail-closed: any mismatch or missing data = FAIL.
      if (DB_PATH) {
        try {
          const STEP = "runId + approval/tool audit queryable";
          const info = await latestRunForChat(extChatId);
          if (!info) {
            record(STEP, "FAIL", "no agent_runs row for this chat");
          } else if (!info.runId) {
            record(STEP, "FAIL", "latest run has no runId (turn did not finalize?)");
          } else {
            const dbAuditTypes = info.eventTypes
              .filter((t) => t.includes("approval") || t.includes("tool"))
              .sort();
            if (dbAuditTypes.length === 0) {
              record(STEP, "FAIL",
                "no approval/tool events recorded for this run (audit set must be non-empty)");
            } else {
              const { status, json } = await api(`/api/admin/runs/${info.runId}`, { token });
              if (status !== 200) {
                record(STEP, "FAIL",
                  `admin API status=${status} (expected 200 for run ${info.runId.slice(0, 8)})`);
              } else {
                const apiRunId = json?.run?.id ?? json?.id;
                const apiEvents = Array.isArray(json?.events) ? json.events : json?.eventSummary ?? [];
                const apiAuditTypes = apiEvents
                  .map((e) => e?.eventType ?? e?.type ?? e?.event_type ?? "")
                  .filter((t) => t.includes("approval") || t.includes("tool"))
                  .sort();
                const runIdMatch = apiRunId === info.runId;
                const auditMatch = JSON.stringify(apiAuditTypes) === JSON.stringify(dbAuditTypes);
                if (runIdMatch && auditMatch) {
                  record(STEP, "PASS",
                    `run ${info.runId.slice(0, 8)} status=${info.status}; DB==API audit types [${dbAuditTypes.join(",")}]`);
                } else {
                  record(STEP, "FAIL",
                    `mismatch — runId match=${runIdMatch}; DB [${dbAuditTypes.join(",")}] vs API [${apiAuditTypes.join(",")}]`);
                }
              }
            }
          }
        } catch (e) { record("runId + approval/tool audit queryable", "FAIL", e.message); }
      } else {
        record("runId + approval/tool audit queryable", "SKIP",
          "set SMOKE_DB_PATH (co-located DB) to enable — REQUIRED for the staging gate on the VM");
      }
    } else {
      record("extended flow setup (create chat)", "FAIL", "chat creation failed");
    }
  } else if (EXTENDED) {
    record("extended flow", "SKIP", "no token (login failed above)");
  }

  // ── Cleanup + summary ─────────────────────────────────────────────────
  await cleanup(chatIds, token);

  const fails = results.filter((r) => r.status === "FAIL").length;
  const skips = results.filter((r) => r.status === "SKIP").length;
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n== SMOKE ${fails === 0 ? "PASSED" : "FAILED"} == ` +
    `${results.length - fails - skips} pass / ${fails} fail / ${skips} skip — ${total}s total`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE ABORTED:", e.message);
  process.exit(1);
});
