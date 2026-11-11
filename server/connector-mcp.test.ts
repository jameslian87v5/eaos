// Octop absorption M1b (codex evt_20261020075047) — internal MCP + capability
// token + REST connector POC contract tests.
//
// Focused proof for the M1b boundary (artifact evt_20261020073311-m1b):
//   - resolve() injection: default agent (no activation) → NO connector MCP;
//     authorized docker agent → exactly ONE http MCP server exposing
//     rest_request; local runtime → none;
//   - deny-default intersection is re-derived per MCP call (entitlement
//     revoke kills a still-registered token);
//   - token matrix: forged / wrong-audience / expired / revoked /
//     runtime-replaced / stale-config / wrong-tool / wrong-instance → deny;
//   - disable + runtime stop revoke IMMEDIATELY (not at expiry);
//   - credential isolation: raw credential absent from the resolved bundle
//     (env / mounts / mcpServers JSON); the MCP header carries ONLY the
//     short-lived capability token;
//   - rest_request guards: absolute path / protocol-relative / backslash /
//     non-GET-POST / redirect / oversized response / timeout rejected;
//   - real GET/POST success against a local fixture upstream (Authorization
//     header host-side injected from the stored credential).
//
// NOT tested here (M1d): real Docker container egress, agent-entry SDK wiring,
// browser UI.
//
// Run: npx tsx server/connector-mcp.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

// ─── Env before imports ──────────────────────────────────────
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "m1b-connector-mcp-test-"));
process.chdir(SCRATCH); // BEFORE dynamic imports — data/ resolves under scratch
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.JWT_SECRET = "m1b-connector-mcp-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.CONNECTOR_REST_TIMEOUT_MS = "800";
process.env.CONNECTOR_MCP_BASE_URL = "http://127.0.0.1:1"; // route URL is asserted structurally

const db = (await import("./database.js")).default;
const store = await import("./connector-store.js");
const tokens = await import("./connector-capability-token.js");
const { createInternalConnectorMcpRoutes } = await import("./connector-mcp.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");

const CREDENTIAL = "m1b-upstream-token-4e21";
const AGENT = "agent-m1b-1";
const USER = "user-m1b";
const ORG = DEFAULT_ORG_ID;

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// ─── Fixture upstream service ─────────────────────────────────

const seenAuth: string[] = [];
const fixture = http.createServer((req, res) => {
  seenAuth.push(String(req.headers.authorization ?? ""));
  const url = new URL(req.url ?? "/", "http://fixture");
  const route = url.pathname.replace(/\/+$/, "");
  if (route === "/hello" || route === "/api/v1/hello") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, route, query: Object.fromEntries(url.searchParams) }));
    return;
  }
  if (route === "/echo-auth") {
    // M1b fix #1 fixture: echoes the Authorization header it received.
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ echoedAuth: String(req.headers.authorization ?? "") }));
    return;
  }
  if (route === "/echo" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ echoed: JSON.parse(body || "{}") }));
    });
    return;
  }
  if (route === "/redirect") {
    res.statusCode = 302;
    res.setHeader("location", "https://evil.example.com/x");
    res.end();
    return;
  }
  if (route === "/big") {
    res.setHeader("content-type", "text/plain");
    res.end("x".repeat(1024 * 1024)); // 1MB > 256KB cap
    return;
  }
  if (route === "/big-chunked") {
    // M1b fix #5 fixture: chunked (NO content-length) 1MB stream.
    res.setHeader("content-type", "text/plain");
    res.setHeader("transfer-encoding", "chunked");
    for (let i = 0; i < 32; i++) res.write("y".repeat(32 * 1024));
    res.end();
    return;
  }
  if (route === "/slow") {
    setTimeout(() => res.end("late"), 2000);
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const FIXTURE_PORT = (fixture.address() as { port: number }).port;
const FIXTURE_BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

// ─── MCP route harness ────────────────────────────────────────

const mcpApp = express();
mcpApp.use(express.json({ limit: "1mb" }));
mcpApp.use("/api/mcp/connectors", createInternalConnectorMcpRoutes());
const mcpServer = mcpApp.listen(0);
const MCP_PORT = (mcpServer.address() as { port: number }).port;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/api/mcp/connectors`;

async function rpc(
  instanceId: string,
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
  id = 1
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${MCP_BASE}/${instanceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function toolCall(instanceId: string, token: string, args: Record<string, unknown>) {
  return rpc(instanceId, token, "tools/call", { name: "rest_request", arguments: args });
}

// ─── World setup: one enabled instance + activation + entitlement ──

const instance = store.createInstance({
  catalogKind: "internal-rest",
  name: "fixture-upstream",
  baseUrl: FIXTURE_BASE,
});
store.writeCredentials(instance.id, { apiToken: CREDENTIAL });
store.enableInstance(instance.id);

const adminCtx = { userId: "admin-root", role: "admin" as const, orgId: ORG };
const userCtx = { userId: USER, role: "user" as const, orgId: ORG };

// M1b fix #2: the per-call reauthorization reloads the user from the DB —
// the principal must EXIST there (active, matching role/org) for calls to pass.
db.prepare(
  `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', 'user', ?, 'active')`
).run(USER, USER, ORG);

// Entitlement: org-scope allow so a plain USER context also passes (exercises
// the non-admin path of the intersection, not just admin-bypass).
entitlementService.setEntitlements(adminCtx, `connector:${instance.id}`, [
  { scopeType: "org", scopeId: ORG, effect: "allow" },
]);

// ─── A: resolve() injection matrix ────────────────────────────

let bundleToken: string | null = null;
{
  // A1. Default agent (no activation) → NO connector MCP, deny-default.
  const b0 = capabilityProvider.resolve({
    userId: USER, chatId: "agent-unconfigured", role: "user",
    runtimeType: "docker", orgId: ORG,
  });
  ok("A1 default agent: no connector MCP",
    Object.keys(b0.sdkOptions.mcpServers ?? {}).every((k) => !k.startsWith("connector-")));

  // A2. Activated docker agent → exactly ONE http MCP server with rest_request.
  agentCapabilityService.updateAgentCapabilities(userCtx, AGENT, {
    resources: [{ resourceId: `connector:${instance.id}`, enabled: true }],
  });
  const b1 = capabilityProvider.resolve({
    userId: USER, chatId: AGENT, role: "user",
    runtimeType: "docker", orgId: ORG,
  });
  const entries = Object.entries(b1.sdkOptions.mcpServers ?? {}).filter(([k]) => k.startsWith("connector-"));
  ok("A2 exactly one connector server", entries.length === 1, JSON.stringify(entries.map(([k]) => k)));
  const [name, cfg] = entries[0] as [string, any];
  ok("A2 server name is instance-scoped", name === `connector-${instance.id}`);
  ok("A2 http type + tools", cfg.type === "http" && Array.isArray(cfg.tools) && cfg.tools.some((t: any) => t?.name === "rest_request"));
  ok("A2 url binds instance route", String(cfg.url).endsWith(`/api/mcp/connectors/${instance.id}`));
  const auth = String(cfg.headers?.authorization ?? "");
  ok("A2 header carries a JWT (3 segments)", auth.startsWith("Bearer ") && auth.split(".").length === 3);
  bundleToken = auth.slice(7);

  // A3. Credential isolation: the raw credential NEVER enters the bundle.
  const bundleJson = JSON.stringify(b1);
  ok("A3 bundle carries no raw credential", !bundleJson.includes(CREDENTIAL));
  ok("A3 bundle env empty (no secret env)", Object.keys(b1.env).every((k) => !k.toLowerCase().includes("token")));

  // A4. Local runtime → no connector MCP (Phase-B parity: local has no MCP).
  const b2 = capabilityProvider.resolve({
    userId: USER, chatId: AGENT, role: "user",
    runtimeType: "local", orgId: ORG,
  });
  ok("A4 local runtime: no connector MCP",
    Object.keys(b2.sdkOptions.mcpServers ?? {}).every((k) => !k.startsWith("connector-")));

  // A5. Unactivated-but-entitled agent still gets nothing (activation leg).
  const b3 = capabilityProvider.resolve({
    userId: USER, chatId: "agent-entitled-only", role: "user",
    runtimeType: "docker", orgId: ORG,
  });
  ok("A5 no-activation agent: no connector MCP",
    Object.keys(b3.sdkOptions.mcpServers ?? {}).every((k) => !k.startsWith("connector-")));
}

// ─── B: MCP protocol + real rest_request over the fixture ─────

{
  // B1. initialize / tools/list shapes.
  const init = await rpc(instance.id, bundleToken, "initialize");
  ok("B1 initialize 200", init.status === 200 && init.body.result?.serverInfo?.name === `connector-${instance.id}`);
  const list = await rpc(instance.id, bundleToken, "tools/list");
  ok("B1 tools/list exposes rest_request",
    list.status === 200 && list.body.result?.tools?.some((t: any) => t.name === "rest_request"));

  // B2. GET success: host-side credential injection + query passthrough.
  seenAuth.length = 0;
  const get = await toolCall(instance.id, bundleToken!, { method: "GET", path: "/hello", query: { x: 1 } });
  const getPayload = JSON.parse(JSON.parse(get.body.result?.content?.[0]?.text ?? "{}").body ?? "{}");
  ok("B2 GET ok", get.status === 200 && get.body.result?.isError !== true && getPayload.ok === true);
  ok("B2 query passthrough", getPayload.query?.x === "1");
  ok("B2 upstream saw stored credential (host-side injection)",
    seenAuth.length > 0 && seenAuth[seenAuth.length - 1] === `Bearer ${CREDENTIAL}`);

  // B3. POST success: body round-trips.
  const post = await toolCall(instance.id, bundleToken!, { method: "POST", path: "/echo", body: { a: "b" } });
  const postPayload = JSON.parse(JSON.parse(post.body.result?.content?.[0]?.text ?? "{}").body ?? "{}");
  ok("B3 POST echo", post.status === 200 && postPayload.echoed?.a === "b");

  // B4. Method guard: PUT rejected as tool error.
  const put = await toolCall(instance.id, bundleToken!, { method: "PUT", path: "/hello" });
  ok("B4 PUT rejected", put.body.result?.isError === true && /GET|POST/.test(put.body.result?.content?.[0]?.text ?? ""));

  // B5. Path guards: absolute / protocol-relative / backslash / origin escape.
  for (const badPath of ["https://evil.example.com/x", "//evil.example.com/x", "/\\evil.example.com", "hello"]) {
    const r = await toolCall(instance.id, bundleToken!, { method: "GET", path: badPath });
    ok(`B5 path guard: ${JSON.stringify(badPath)}`, r.body.result?.isError === true);
  }

  // B6. Redirect: never followed (manual), bounded error.
  const red = await toolCall(instance.id, bundleToken!, { method: "GET", path: "/redirect" });
  ok("B6 redirect rejected", red.body.result?.isError === true && /重定向/.test(red.body.result?.content?.[0]?.text ?? ""));

  // B7. Oversized response: bounded (content-length early-return, ≤300KB).
  const big = await toolCall(instance.id, bundleToken!, { method: "GET", path: "/big" });
  const bigText = big.body.result?.content?.[0]?.text ?? "";
  ok("B7 response capped", big.body.result?.isError === true && bigText.includes("上限") && bigText.length < 300 * 1024);

  // B8. Timeout: wall-clock bound (fixture sleeps 2s, timeout 800ms).
  const slow = await toolCall(instance.id, bundleToken!, { method: "GET", path: "/slow" });
  ok("B8 timeout bounded", slow.body.result?.isError === true && /超时/.test(slow.body.result?.content?.[0]?.text ?? ""));
}

// ─── C: token rejection matrix (each via real MCP call) ───────

{
  // C1. No token → 401.
  const none = await rpc(instance.id, null, "tools/list");
  ok("C1 missing token 401", none.status === 401);

  // C2. Forged signature.
  const forged = jwt.sign({ kind: "internal-mcp", jti: "forged" }, "wrong-secret", {
    audience: "internal-mcp", expiresIn: "5m",
  });
  ok("C2 forged signature 401", (await rpc(instance.id, forged, "tools/list")).status === 401);

  // C3. Wrong audience (browser-style JWT signed with the SAME secret).
  const browser = jwt.sign({ sub: USER, role: "user" }, process.env.JWT_SECRET!, {
    audience: "browser", expiresIn: "5m",
  });
  ok("C3 wrong-audience 401", (await rpc(instance.id, browser, "tools/list")).status === 401);

  // C4. Expired (correct secret + audience, past exp).
  const expired = jwt.sign({ kind: "internal-mcp" }, process.env.JWT_SECRET!, {
    audience: "internal-mcp", expiresIn: "-10s",
  });
  ok("C4 expired 401", (await rpc(instance.id, expired, "tools/list")).status === 401);

  // C5. Valid signature + audience but NOT in the active registry.
  const ghost = jwt.sign({ kind: "internal-mcp", jti: "never-minted" }, process.env.JWT_SECRET!, {
    audience: "internal-mcp", expiresIn: "5m",
  });
  ok("C5 unknown jti 401", (await rpc(instance.id, ghost, "tools/list")).status === 401);

  // C6. Wrong-instance binding: token minted for a DIFFERENT connector.
  const other = store.createInstance({
    catalogKind: "internal-rest", name: "other-instance", baseUrl: FIXTURE_BASE,
  });
  store.writeCredentials(other.id, { apiToken: "other-cred" });
  store.enableInstance(other.id);
  const otherToken = tokens.mintConnectorToken({
    orgId: ORG, appId: "default-app", agentId: AGENT,
    runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: other.id,
    allowedTools: ["rest_request"], configVersion: 1,
    userId: USER, role: "user",
  });
  ok("C6 cross-instance token 401", (await rpc(instance.id, otherToken, "tools/list")).status === 401);

  // C7. Wrong tool: token allows only rest_request.
  const wrongTool = await rpc(instance.id, bundleToken, "tools/call", { name: "web_fetch", arguments: {} });
  ok("C7 wrong tool 401", wrongTool.status === 401);

  // C8. Wrong tool via tools/list-allowed path: an unregistered tool name in
  // tools/call params is rejected by token allowedTools before execution.
  const wrongTool2 = await rpc(instance.id, bundleToken, "tools/call", { name: "fs_write", arguments: {} });
  ok("C7b unknown tool 401", wrongTool2.status === 401);
}

// ─── D: immediate revocation semantics ────────────────────────

{
  // D1. Runtime stop revokes immediately.
  const t1 = tokens.mintConnectorToken({
    orgId: ORG, appId: "default-app", agentId: AGENT,
    runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: instance.id,
    allowedTools: ["rest_request"], configVersion: store.getInstance(instance.id).configVersion,
    userId: USER, role: "user",
  });
  ok("D1 fresh token works", (await rpc(instance.id, t1, "tools/list")).status === 200);
  tokens.revokeConnectorTokensForRuntime(`${USER}:${AGENT}`);
  ok("D1 runtime-stop revocation immediate", (await rpc(instance.id, t1, "tools/list")).status === 401);

  // D2. Disable revokes immediately (token from a re-mint).
  const t2 = tokens.mintConnectorToken({
    orgId: ORG, appId: "default-app", agentId: AGENT,
    runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: instance.id,
    allowedTools: ["rest_request"], configVersion: store.getInstance(instance.id).configVersion,
    userId: USER, role: "user",
  });
  store.disableInstance(instance.id);
  ok("D2 disable revocation immediate", (await rpc(instance.id, t2, "tools/list")).status === 401);
  store.enableInstance(instance.id); // restore for D3
  const t3 = tokens.mintConnectorToken({
    orgId: ORG, appId: "default-app", agentId: AGENT,
    runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: instance.id,
    allowedTools: ["rest_request"], configVersion: store.getInstance(instance.id).configVersion,
    userId: USER, role: "user",
  });

  // D3. Stale config: credential rotation bumps config_version → old token dies.
  store.writeCredentials(instance.id, { apiToken: "rotated-cred-2" });
  ok("D3 stale-config token rejected", (await rpc(instance.id, t3, "tools/list")).status === 401);

  // D4. Runtime replaced (re-resolve mints a new token; the old one dies).
  const t4 = tokens.mintConnectorToken({
    orgId: ORG, appId: "default-app", agentId: AGENT,
    runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: instance.id,
    allowedTools: ["rest_request"], configVersion: store.getInstance(instance.id).configVersion,
    userId: USER, role: "user",
  });
  capabilityProvider.resolve({ userId: USER, chatId: AGENT, role: "user", runtimeType: "docker", orgId: ORG });
  ok("D4 replaced-runtime token rejected", (await rpc(instance.id, t4, "tools/list")).status === 401);

  // D5. Authorization intersection is re-derived per call: revoke the org
  // entitlement → a still-registered, correctly-bound token is denied.
  const t5 = tokens.mintConnectorToken({
    orgId: ORG, appId: "default-app", agentId: AGENT,
    runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: instance.id,
    allowedTools: ["rest_request"], configVersion: store.getInstance(instance.id).configVersion,
    userId: USER, role: "user",
  });
  ok("D5 token valid before entitlement revoke", (await rpc(instance.id, t5, "tools/list")).status === 200);
  entitlementService.setEntitlements(adminCtx, `connector:${instance.id}`, [
    { scopeType: "org", scopeId: ORG, effect: "deny" },
  ]);
  ok("D5 entitlement revoke denies live token", (await rpc(instance.id, t5, "tools/list")).status === 401);
}

// ─── E: resource surface + metadata hygiene ───────────────────

{
  const { capabilityResourceService } = await import("./capability-resource.js");
  const view = capabilityResourceService.getResource(adminCtx, `connector:${instance.id}`);
  ok("E1 connector surfaces as capability resource",
    view?.type === "connector" && view.valid === true);

  // Token/credential never land in governance audits.
  const auditDump = JSON.stringify(
    db.prepare("SELECT * FROM governance_audit_log WHERE action LIKE 'connector%'").all()
  );
  ok("E2 audits carry no token material", !auditDump.includes(CREDENTIAL) && !auditDump.includes("Bearer "));
  // The resolved bundle token never equals the raw credential.
  ok("E3 bundle token != raw credential", bundleToken !== null && bundleToken !== CREDENTIAL);
}

// ─── F: M1b fix-round regressions ─────────────────────────────

{
  // D-series left the world dirty: credential rotated (D3), entitlement denied
  // (D5), and every prior token for this agent+connector revoked (D1 mint).
  // Restore before the F regressions; mint a FRESH token for each consumer.
  store.writeCredentials(instance.id, { apiToken: CREDENTIAL });
  entitlementService.setEntitlements(adminCtx, `connector:${instance.id}`, [
    { scopeType: "org", scopeId: ORG, effect: "allow" },
  ]);
  const mintFresh = () =>
    tokens.mintConnectorToken({
      orgId: ORG, appId: "default-app", agentId: AGENT,
      runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: instance.id,
      allowedTools: ["rest_request"], configVersion: store.getInstance(instance.id).configVersion,
      userId: USER, role: "user",
    });

  // F1. Credential/token echo sanitization: an upstream echoing its
  // Authorization header must never leak the raw credential or the token.
  const echoToken = mintFresh();
  const echo = await toolCall(instance.id, echoToken, { method: "GET", path: "/echo-auth" });
  const echoText = echo.body.result?.content?.[0]?.text ?? "";
  ok("F1 echo sanitized: no raw credential", !echoText.includes(CREDENTIAL));
  ok("F1 echo sanitized: no capability token", !echoText.includes(echoToken));
  ok("F1 echo sanitized: redaction marker present", echoText.includes("[REDACTED]"));
  ok("F1 echo reached upstream (fixture echoed auth)", echoText.includes("echoedAuth"));

  // F2. DB-authoritative revalidation: a still-active, correctly-bound token
  // is denied when the CURRENT user/agent state no longer matches the mint.

  // F2a. Role change.
  const tRole = mintFresh();
  ok("F2a pre-change token works", (await rpc(instance.id, tRole, "tools/list")).status === 200);
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(USER);
  ok("F2a role change denies token", (await rpc(instance.id, tRole, "tools/list")).status === 401);
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(USER);

  // F2b. Org move.
  const tOrg = mintFresh();
  db.prepare("UPDATE users SET org_id = 'other-org' WHERE id = ?").run(USER);
  ok("F2b org move denies token", (await rpc(instance.id, tOrg, "tools/list")).status === 401);
  db.prepare(`UPDATE users SET org_id = ? WHERE id = ?`).run(ORG, USER);

  // F2c. Agent app binding move (agents.app_id flips from default-app).
  const tApp = mintFresh();
  db.prepare(
    `INSERT INTO agents (id, org_id, owner_user_id, name, status, app_id) VALUES (?, ?, ?, 'm1b-agent', 'active', 'other-app')`
  ).run(AGENT, ORG, USER);
  ok("F2c app move denies token", (await rpc(instance.id, tApp, "tools/list")).status === 401);
  db.prepare("DELETE FROM agents WHERE id = ?").run(AGENT);

  // F2d. User disabled.
  const tUser = mintFresh();
  db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(USER);
  ok("F2d disabled user denies token", (await rpc(instance.id, tUser, "tools/list")).status === 401);
  db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(USER);
  ok("F2d restored user works", (await rpc(instance.id, mintFresh(), "tools/list")).status === 200);

  // F4. Base URL path prefix preservation: root, /api/v1, /api/v1/ bases all
  // join the agent-relative path AFTER the prefix.
  for (const base of [FIXTURE_BASE, `${FIXTURE_BASE}/api/v1`, `${FIXTURE_BASE}/api/v1/`]) {
    const inst = store.createInstance({ catalogKind: "internal-rest", name: `base-${base.slice(-7)}`, baseUrl: base });
    store.writeCredentials(inst.id, { apiToken: CREDENTIAL });
    store.enableInstance(inst.id);
    entitlementService.setEntitlements(adminCtx, `connector:${inst.id}`, [
      { scopeType: "org", scopeId: ORG, effect: "allow" },
    ]);
    agentCapabilityService.updateAgentCapabilities(userCtx, AGENT, {
      resources: [{ resourceId: `connector:${inst.id}`, enabled: true }],
    });
    const tk = tokens.mintConnectorToken({
      orgId: ORG, appId: "default-app", agentId: AGENT,
      runtimeKey: `${USER}:${AGENT}`, connectorInstanceId: inst.id,
      allowedTools: ["rest_request"], configVersion: store.getInstance(inst.id).configVersion,
      userId: USER, role: "user",
    });
    const call = await toolCall(inst.id, tk, { method: "GET", path: "/hello" });
    const payload = JSON.parse(JSON.parse(call.body.result?.content?.[0]?.text ?? "{}").body ?? "{}");
    ok(`F4 base ${base.slice(-7)} prefix preserved`,
      call.body.result?.isError !== true && payload.ok === true && payload.route === (base.includes("/api/v1") ? "/api/v1/hello" : "/hello"));
  }

  // F5. Chunked (no content-length) oversized stream: body is bounded to the
  // 256 KiB cap exactly once — never more, and flagged truncated.
  const chunky = await toolCall(instance.id, mintFresh(), { method: "GET", path: "/big-chunked" });
  const chunkyWrapper = JSON.parse(chunky.body.result?.content?.[0]?.text ?? "{}");
  ok("F5 chunked body capped at 256 KiB", typeof chunkyWrapper.body === "string" && chunkyWrapper.body.length === 256 * 1024);
  ok("F5 chunked flagged truncated", chunkyWrapper.truncated === true);
}

mcpServer.close();
fixture.close();
console.log(`\nM1b connector-mcp tests: ${pass} passed`);
process.exit(0);
