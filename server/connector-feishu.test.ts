// Octop absorption M2b (codex evt_20261021015806-m2b-instruction.md) —
// Feishu docs OAuth connector contract tests, driven against a local fake
// Feishu server (CONNECTOR_FEISHU_BASE_URL test seam).
//
// Coverage (instruction §Tests):
//   - PKCE start/callback success + token encryption (blob ciphertext only);
//   - state replay / expiry / consume-race denial (fail closed);
//   - wrong code denial;
//   - fix #1: redirect URI from operator config (CONNECTOR_OAUTH_PUBLIC_BASE_URL
//     origin-only HTTPS, loopback test seam) — never Host/X-Forwarded-*;
//   - fix #2: invalid-state callback flood writes ZERO audit rows, state-backed
//     failures still audited;
//   - fix #3: credential rotation + OAuth clear atomic (ciphertext gone);
//   - refresh success (serialized, single-use refresh token), refresh failure
//     (authorization → failed, calls denied), expired authorization view;
//   - enable/call denied before authorization;
//   - authorized search_docs / get_doc success with unique markers;
//   - live token denied after entitlement revoke / role drift / disable;
//   - raw client secret / access / refresh token absent from API responses,
//     the resolve() bundle, governance audits, and the DB file bytes;
//   - Feishu error / oversize / redirect / timeout bounded.
//
// Run: npx tsx server/connector-feishu.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import express from "express";
import type { Request } from "express";

// ─── Env before imports ──────────────────────────────────────
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "m2b-feishu-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.JWT_SECRET = "m2b-feishu-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
process.env.CONNECTOR_MCP_BASE_URL = "http://127.0.0.1:1";
process.env.CONNECTOR_REST_TIMEOUT_MS = "800";

const db = (await import("./database.js")).default;
const store = await import("./connector-store.js");
const tokens = await import("./connector-capability-token.js");
const { createInternalConnectorMcpRoutes } = await import("./connector-mcp.js");
const { createAdminConnectorRoutes } = await import("./admin-connector-routes.js");
const oauth = await import("./connector-feishu-oauth.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
const { writeGovernanceAudit } = await import("./org-governance.js");
import type { RequestContext } from "./request-context.js";

const CLIENT_ID = "m2b-feishu-app-id";
const CLIENT_SECRET = "m2b-feishu-secret-9c31d0";
const AGENT = "agent-m2b-1";
const USER = "m2b-user";
const ORG = DEFAULT_ORG_ID;

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const adminCtx: RequestContext = { userId: "m2b-admin", role: "admin", orgId: ORG };
const userCtx: RequestContext = { userId: USER, role: "user", orgId: ORG };

// ─── Fake Feishu server ──────────────────────────────────────

interface IssuedToken {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

const authorizeRequests: Array<URL> = [];
const tokenRequests: Array<Record<string, string>> = [];
const seenBearers: string[] = [];
const codeToVerifier = new Map<string, string>(); // code → PKCE verifier
const issued = new Map<string, IssuedToken>(); // refreshToken → token pair
let refreshFailureMode = false;

const currentAccessToken = (): string | null => {
  const latest = [...issued.values()].pop();
  return latest?.accessToken ?? null;
};

const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake-feishu");
  seenBearers.push(String(req.headers.authorization ?? ""));
  const route = url.pathname;

  if (route === "/authen/v1/authorize" && req.method === "GET") {
    authorizeRequests.push(url);
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    // The fake binds the issued code to the state AND stores the expected
    // challenge for the token endpoint to verify (PKCE S256 check).
    const code = `fake-code-${state.slice(0, 8)}`;
    codeToVerifier.set(code, challenge);
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    res.statusCode = 302;
    res.setHeader("location", `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
    res.end();
    return;
  }

  if (route === "/authen/v2/oauth/token" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form: Record<string, string> = {};
      for (const kv of body.split("&")) {
        const [k, v] = kv.split("=");
        if (k) form[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
      // Accept JSON too (our client sends JSON).
      let parsed = form;
      try {
        parsed = JSON.parse(body);
      } catch { /* urlencoded */ }
      tokenRequests.push(parsed);
      if (parsed.client_id !== CLIENT_ID || parsed.client_secret !== CLIENT_SECRET) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }
      if (parsed.grant_type === "authorization_code") {
        const expectedChallenge = codeToVerifier.get(parsed.code);
        if (!expectedChallenge) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant (unknown code)" }));
          return;
        }
        // PKCE S256 verification: recompute the challenge from code_verifier.
        const recomputed = cryptoSha256B64Url(parsed.code_verifier ?? "");
        if (recomputed !== expectedChallenge) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant (pkce)" }));
          return;
        }
        codeToVerifier.delete(parsed.code); // one-time code
        const token = issue();
        res.statusCode = 200;
        res.end(JSON.stringify(token));
        return;
      }
      if (parsed.grant_type === "refresh_token") {
        if (refreshFailureMode || !issued.has(parsed.refresh_token)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_refresh_token" }));
          return;
        }
        // Single-use refresh token: rotate and kill the old one.
        issued.delete(parsed.refresh_token);
        const token = issue();
        res.statusCode = 200;
        res.end(JSON.stringify(token));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "unsupported_grant" }));
    });
    return;
  }

  if (route === "/open-apis/suite/docs-api/search/object" && req.method === "POST") {
    if (!bearerOk(req)) return unauthorized(res);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const query = JSON.parse(body || "{}").search_query ?? "";
      if (query === "oversize") {
        res.setHeader("content-type", "text/plain");
        res.end("x".repeat(1024 * 1024));
        return;
      }
      if (query === "redirect") {
        res.statusCode = 302;
        res.setHeader("location", "https://evil.example.com/x");
        res.end();
        return;
      }
      if (query === "slow") {
        setTimeout(() => res.end("late"), 2000);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        code: 0,
        data: { objects: [{ obj_id: "doc-m2b-1", title: `M2B 飞书文档: ${query}` }] },
      }));
    });
    return;
  }

  if (route.startsWith("/open-apis/docx/v1/documents/") && route.endsWith("/raw_content")) {
    if (!bearerOk(req)) return unauthorized(res);
    const docId = route.split("/")[5];
    if (docId === "bigdoc") {
      res.setHeader("content-type", "text/plain");
      res.end("y".repeat(1024 * 1024));
      return;
    }
    if (docId === "slowdoc") {
      setTimeout(() => res.end("late"), 2000);
      return;
    }
    res.setHeader("content-type", "text/plain");
    res.end(`M2B-DOC-CONTENT-${docId}`);
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
function safeRead(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
function cryptoSha256B64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}
function issue(): { access_token: string; refresh_token: string; expires_in: number } {
  const accessToken = `m2b-at-${randomBytes(8).toString("hex")}`;
  const refreshToken = `m2b-rt-${randomBytes(8).toString("hex")}`;
  issued.set(refreshToken, { accessToken, refreshToken, expiresAtMs: Date.now() + 3600_000 });
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 };
}
function bearerOk(req: http.IncomingMessage): boolean {
  const bearer = String(req.headers.authorization ?? "");
  return bearer === `Bearer ${currentAccessToken()}`;
}
function unauthorized(res: http.ServerResponse): void {
  res.statusCode = 401;
  res.end(JSON.stringify({ code: 99991668, msg: "invalid access token" }));
}

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const FAKE_PORT = (fake.address() as { port: number }).port;
process.env.CONNECTOR_FEISHU_BASE_URL = `http://127.0.0.1:${FAKE_PORT}`;

// ─── Test harness app (admin routes + callback + MCP) ─────────

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req: express.Request, _res, next) => {
  const who = String(req.headers["x-test-actor"] ?? "");
  if (who === "admin") Object.assign(req, { userId: "m2b-admin", userRole: "admin", orgId: ORG });
  else if (who === "orgAdmin") Object.assign(req, { userId: "m2b-orgadmin", userRole: "org_admin", orgId: ORG });
  else if (who === "userA") Object.assign(req, { userId: USER, userRole: "user", orgId: ORG });
  next();
});
app.use("/api/admin/connectors", createAdminConnectorRoutes());
// Callback route mirrors server.ts EXACTLY — including the fix-round #2 audit
// gate (only state-backed failures write governance audit rows).
app.get(oauth.CALLBACK_PATH, async (req, res) => {
  const outcome = await oauth.handleOAuthCallback(req as Request);
  if (!outcome.ok && outcome.auditable) {
    writeGovernanceAudit({
      actorUserId: null,
      actorRole: null,
      orgId: "default-org",
      action: "connector.oauth.callback",
      objectType: "connector_instance",
      result: "denied",
      reasonSummary: outcome.error.slice(0, 200),
    });
  }
  res.status(outcome.ok ? 200 : 400).json(outcome.ok ? { ok: true } : { ok: false, error: outcome.error });
});
app.use("/api/mcp/connectors", createInternalConnectorMcpRoutes());
const server = app.listen(0);
const APP_PORT = (server.address() as { port: number }).port;
const BASE = `http://127.0.0.1:${APP_PORT}`;
// Fix round #1: the redirect URI authority is operator-configured (loopback
// HTTP is the test seam, exactly like the production HTTPS origin).
process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL = `http://127.0.0.1:${APP_PORT}`;

async function api(
  actor: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-actor": actor },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function rpc(
  instanceId: string,
  token: string | null,
  method: string,
  params?: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/mcp/connectors/${instanceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Fix round #1: forge Host/X-Forwarded-* on a raw request — the redirect
// authority must come from config, never from these headers.
function callbackWithSpoofedHeaders(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: APP_PORT,
        path,
        headers: {
          host: "evil.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "attacker.example.com",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ─── World: users, agent, instance, entitlement, activation ───

db.prepare(
  `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', 'user', ?, 'active')`
).run(USER, USER, ORG);
db.prepare(
  `INSERT INTO agents (id, org_id, owner_user_id, name, status, app_id) VALUES (?, ?, ?, ?, 'active', 'default-app')`
).run(AGENT, ORG, USER, "m2b agent");

const instance = store.createInstance({ catalogKind: "feishu-docs", name: "m2b-feishu" });
const RID = `connector:${instance.id}`;

entitlementService.setEntitlements(adminCtx, RID, [
  { scopeType: "org", scopeId: ORG, effect: "allow" },
]);
agentCapabilityService.updateAgentCapabilities(userCtx, AGENT, {
  resources: [{ resourceId: RID, enabled: true }],
});

function resolveBundle() {
  return capabilityProvider.resolve({
    userId: USER, chatId: AGENT, role: "user",
    runtimeType: "docker", orgId: ORG,
  });
}
function connectorToken(bundle: any): string | null {
  const cfg = bundle.sdkOptions.mcpServers?.[`connector-${instance.id}`];
  return cfg ? String(cfg.headers.authorization).slice(7) : null;
}
function auditJson(): string {
  return JSON.stringify(db.prepare(`SELECT * FROM governance_audit_log`).all());
}

// ─── 1. Catalog + create (no baseUrl for oauth2) ─────────────

{
  const entry = store.getCatalogEntry("feishu-docs");
  ok("catalog has feishu-docs (oauth2, search_docs/get_doc)",
    !!entry && entry.authKind === "oauth2" &&
    entry.allowedTools.join(",") === "search_docs,get_doc");
  ok("created instance is draft with no baseUrl (fixed endpoints)",
    instance.status === "draft" && instance.baseUrl === "" && instance.authorization?.status === "none");
}

// ─── 2. App credential write → ready (still not authorizable-callable) ──

{
  const { view } = store.writeCredentials(instance.id, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  ok("app credentials write → ready, authorization none",
    view.status === "ready" && view.credentialsPresent === true && view.authorization?.status === "none" && view.configVersion === 2);

  // Enable is DENIED before authorization.
  let denied = false;
  try { store.enableInstance(instance.id); } catch { denied = true; }
  ok("enable denied before authorization", denied);

  // Not enabled → resolve() does not inject the connector at all.
  const b = resolveBundle();
  ok("resolve does not inject the unauthorized connector", !b.sdkOptions.mcpServers?.[`connector-${instance.id}`]);
}

// ─── 3. PKCE start + callback success + token encryption ─────

{
  const r = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  ok("oauth/start (admin) returns authorizeUrl", r.status === 200 && !!r.body.authorizeUrl);
  const authorizeUrl = new URL(r.body.authorizeUrl);
  ok("authorizeUrl targets the fake authorize endpoint",
    authorizeUrl.pathname === "/authen/v1/authorize" && authorizeUrl.port === String(FAKE_PORT));
  ok("authorizeUrl carries client_id + state + PKCE S256 (no secret)",
    authorizeUrl.searchParams.get("client_id") === CLIENT_ID &&
    (authorizeUrl.searchParams.get("code_challenge") ?? "").length >= 43 &&
    authorizeUrl.searchParams.get("code_challenge_method") === "S256" &&
    !r.text.includes(CLIENT_SECRET));
  ok("instance pending_authorization after start",
    store.getInstance(instance.id).authorization?.status === "pending_authorization");

  // Follow the authorize URL — the fake 302s back to our callback with code+state.
  const consent = await fetch(authorizeUrl, { redirect: "manual" });
  const location = new URL(consent.headers.get("location") ?? "", BASE);
  ok("fake consent redirects to the bound callback with code+state",
    location.pathname === oauth.CALLBACK_PATH && location.searchParams.has("code") && location.searchParams.has("state"));

  const cb = await api("admin", "GET", `${location.pathname}${location.search}`);
  ok("callback exchanges code (PKCE verified) → success", cb.status === 200 && cb.body.ok === true, cb.text.slice(0, 200));
  const view = store.getInstance(instance.id);
  ok("authorization now authorized with expiry",
    view.authorization?.status === "authorized" && !!view.authorization?.expiresAt,
    JSON.stringify(view.authorization ?? null));

  // Token encryption: the DB carries ciphertext, never plaintext tokens.
  const row = db.prepare(`SELECT oauth_ciphertext FROM connector_instances WHERE id = ?`).get(instance.id) as any;
  ok("oauth blob is ciphertext (not plaintext tokens)", !!row?.oauth_ciphertext && !row.oauth_ciphertext.includes("m2b-at-"));
  const dbBytes = readFileSync(process.env.DB_PATH!, "utf8") + safeRead(`${process.env.DB_PATH}-wal`);
  const at = currentAccessToken();
  ok("raw access token absent from the DB file bytes", !dbBytes.includes(String(at)));
  ok("raw refresh token absent from the DB file bytes", !dbBytes.includes("m2b-rt-"));
  ok("raw client secret absent from the DB file bytes", !dbBytes.includes(CLIENT_SECRET));
}

// ─── 4. State replay / wrong code / wrong redirect / expiry ───

{
  // Replay: the SAME state can be consumed only ONCE. First callback wins;
  // an immediate replay (same code+state) must fail closed.
  const start2 = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const url2 = new URL(start2.body.authorizeUrl);
  const consent = await fetch(url2, { redirect: "manual" });
  const loc = new URL(consent.headers.get("location") ?? "", BASE);
  const first = await api("admin", "GET", `${loc.pathname}${loc.search}`);
  const replay = await api("admin", "GET", `${loc.pathname}${loc.search}`);
  ok("state one-time: first callback succeeds", first.status === 200);
  ok("state one-time: replay after consume fails", replay.status === 400);

  // Consume race: two CONCURRENT callbacks with the same state — exactly one wins.
  const start3 = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const url3 = new URL(start3.body.authorizeUrl);
  const consent3 = await fetch(url3, { redirect: "manual" });
  const loc3 = new URL(consent3.headers.get("location") ?? "", BASE);
  const [a, b] = await Promise.all([
    api("admin", "GET", `${loc3.pathname}${loc3.search}`),
    api("admin", "GET", `${loc3.pathname}${loc3.search}`),
  ]);
  ok("consume race fails closed (exactly one success)",
    (a.status === 200 ? 1 : 0) + (b.status === 200 ? 1 : 0) === 1,
    JSON.stringify([a.status, b.status]));

  // Wrong code: valid state, bogus code → exchange fails, authorization failed.
  const start4 = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const url4 = new URL(start4.body.authorizeUrl);
  const consent4 = await fetch(url4, { redirect: "manual" });
  const loc4 = new URL(consent4.headers.get("location") ?? "", BASE);
  const badCode = await api("admin", "GET", `${loc4.pathname}?code=bogus-code&state=${loc4.searchParams.get("state")}`);
  ok("wrong code → exchange denied (fail closed)", badCode.status === 400);

  // Fix round #1: poisoned Host / X-Forwarded-Proto / X-Forwarded-Host on the
  // callback MUST NOT move the redirect authority — the configured origin
  // wins, so the state is consumed and the exchange completes.
  const start5 = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const url5 = new URL(start5.body.authorizeUrl);
  const consent5 = await fetch(url5, { redirect: "manual" });
  const loc5 = new URL(consent5.headers.get("location") ?? "", BASE);
  const spoofed = await callbackWithSpoofedHeaders(`${loc5.pathname}${loc5.search}`);
  ok("poisoned Host/X-Forwarded-* headers ignored (configured origin wins)",
    spoofed === 200 && store.getInstance(instance.id).authorization?.status === "authorized",
    `status=${spoofed}`);

  // State expiry: tiny TTL, wait past it.
  process.env.CONNECTOR_OAUTH_STATE_TTL_MS = "40";
  try {
    const start6 = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
    const url6 = new URL(start6.body.authorizeUrl);
    const consent6 = await fetch(url6, { redirect: "manual" });
    const loc6 = new URL(consent6.headers.get("location") ?? "", BASE);
    await new Promise((r) => setTimeout(r, 80));
    const expiredCb = await api("admin", "GET", `${loc6.pathname}${loc6.search}`);
    ok("expired state → callback denied", expiredCb.status === 400);
  } finally {
    delete process.env.CONNECTOR_OAUTH_STATE_TTL_MS;
  }

  // Re-authorize to restore authorized state for later sections.
  const start7 = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const consent7 = await fetch(new URL(start7.body.authorizeUrl), { redirect: "manual" });
  const loc7 = new URL(consent7.headers.get("location") ?? "", BASE);
  const cb7 = await api("admin", "GET", `${loc7.pathname}${loc7.search}`);
  ok("re-authorization restores authorized", cb7.status === 200 && store.getInstance(instance.id).authorization?.status === "authorized");
}

// ─── 5. org_admin/user denied on oauth/start (admin-only) ────

{
  const r = await api("orgAdmin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  ok("org_admin oauth/start → 403", r.status === 403);
  const r2 = await api("userA", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  ok("plain user oauth/start → 403", r2.status === 403);
}

// ─── 6. Authorized: enable + tools ────────────────────────────

let liveToken: string | null = null;
{
  const view = store.enableInstance(instance.id);
  ok("authorized instance enables", view.status === "enabled");

  const b = resolveBundle();
  liveToken = connectorToken(b);
  ok("resolve injects feishu connector with JWT-only header", !!liveToken && liveToken.split(".").length === 3);
  ok("resolve bundle carries no client secret / no access token",
    !JSON.stringify(b).includes(CLIENT_SECRET) && !JSON.stringify(b).includes(String(currentAccessToken())));

  const list = await rpc(instance.id, liveToken, "tools/list");
  const toolNames = (list.body?.result?.tools ?? []).map((t: any) => t.name);
  ok("tools/list exposes search_docs + get_doc only",
    list.status === 200 && toolNames.join(",") === "search_docs,get_doc",
    JSON.stringify(toolNames));

  const search = await rpc(instance.id, liveToken, "tools/call", {
    name: "search_docs", arguments: { query: "季度报告" },
  });
  const searchText = search.body?.result?.content?.[0]?.text ?? "";
  ok("search_docs succeeds with the fake marker",
    search.status === 200 && search.body?.result?.isError !== true && searchText.includes("M2B 飞书文档"),
    searchText.slice(0, 200));
  ok("search_docs uses the user access token host-side",
    seenBearers.includes(`Bearer ${currentAccessToken()}`));
  ok("search result carries no access token / client secret",
    !searchText.includes(String(currentAccessToken())) && !searchText.includes(CLIENT_SECRET));

  const doc = await rpc(instance.id, liveToken, "tools/call", {
    name: "get_doc", arguments: { doc_id: "doc-m2b-1" },
  });
  const docText = doc.body?.result?.content?.[0]?.text ?? "";
  ok("get_doc succeeds with the doc marker",
    doc.status === 200 && docText.includes("M2B-DOC-CONTENT-doc-m2b-1"), docText.slice(0, 200));

  // Agent cannot smuggle URL/headers/tokens through args — fixed endpoint only.
  const smuggle = await rpc(instance.id, liveToken, "tools/call", {
    name: "search_docs", arguments: { query: "x", path: "/admin", url: "https://evil.example.com" },
  });
  ok("extra args (path/url) are ignored — no smuggle", smuggle.status === 200 && smuggle.body?.result?.isError !== true);

  const badDoc = await rpc(instance.id, liveToken, "tools/call", {
    name: "get_doc", arguments: { doc_id: "../escape" },
  });
  ok("path-fragment doc_id rejected", badDoc.body?.result?.isError === true, JSON.stringify(badDoc.body).slice(0, 150));

  // Pending-authorization gate: a NEW flow on an enabled instance flips oauth
  // status to pending_authorization — the live token is denied mid-flow.
  const pend = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const pendUrl = new URL(pend.body.authorizeUrl);
  const pendConsent = await fetch(pendUrl, { redirect: "manual" });
  const pendLoc = new URL(pendConsent.headers.get("location") ?? "", BASE);
  const rPend = await rpc(instance.id, liveToken, "tools/call", {
    name: "search_docs", arguments: { query: "x" },
  });
  ok("pending_authorization denies the live token (401)",
    rPend.status === 401 && /oauth authorization pending_authorization/.test(JSON.stringify(rPend.body)),
    JSON.stringify(rPend.body).slice(0, 150));
  // Complete the flow to restore authorized for the refresh section.
  const pendDone = await api("admin", "GET", `${pendLoc.pathname}${pendLoc.search}`);
  ok("completing the pending flow restores authorized",
    pendDone.status === 200 && store.getInstance(instance.id).authorization?.status === "authorized");
}

// ─── 7. Refresh: success (single-use, serialized) / failure ───

{
  const oldRefresh = [...issued.keys()].pop()!;
  // Force the access token to look expired: rewrite expiresAt in the blob.
  const tokensNow = store.getOAuthTokensForHost(instance.id)!;
  store.writeOAuthTokens(instance.id, {
    accessToken: tokensNow.accessToken,
    refreshToken: tokensNow.refreshToken,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const viewExpired = store.getInstance(instance.id);
  ok("expired authorization is visible in the view", viewExpired.authorization?.status === "expired");

  const search = await rpc(instance.id, liveToken, "tools/call", {
    name: "search_docs", arguments: { query: "刷新后搜索" },
  });
  ok("expired access token auto-refreshes → call still succeeds",
    search.status === 200 && search.body?.result?.isError !== true);
  ok("old refresh token was single-use (rotated out at the fake)",
    !issued.has(oldRefresh));

  // Refresh failure mode: mark expired again, make refresh fail.
  refreshFailureMode = true;
  const t2 = store.getOAuthTokensForHost(instance.id)!;
  store.writeOAuthTokens(instance.id, {
    accessToken: t2.accessToken, refreshToken: t2.refreshToken,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const failed = await rpc(instance.id, liveToken, "tools/call", {
    name: "search_docs", arguments: { query: "应失败" },
  });
  ok("refresh failure → tool error (not silent pass)",
    failed.body?.result?.isError === true, JSON.stringify(failed.body).slice(0, 150));
  ok("authorization marked failed after refresh failure",
    store.getInstance(instance.id).authorization?.status === "failed");
  // Gate: subsequent calls denied outright (no per-call retry storm).
  const deniedList = await rpc(instance.id, liveToken, "tools/list");
  ok("failed authorization denies subsequent calls (401)",
    deniedList.status === 401, JSON.stringify(deniedList.body).slice(0, 150));
  refreshFailureMode = false;

  // Restore authorization for the drift section.
  const s = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const consent = await fetch(new URL(s.body.authorizeUrl), { redirect: "manual" });
  const loc = new URL(consent.headers.get("location") ?? "", BASE);
  const cb = await api("admin", "GET", `${loc.pathname}${loc.search}`);
  ok("re-authorization after failure works", cb.status === 200 && store.getInstance(instance.id).authorization?.status === "authorized");
}

// ─── 8. Drift / disable revocation on the live token ──────────

{
  // 8a. Role drift: change the user's role → per-call revalidation denies.
  db.prepare(`UPDATE users SET role = 'org_admin' WHERE id = ?`).run(USER);
  const rRole = await rpc(instance.id, liveToken, "tools/list");
  ok("role drift kills the live token (401)", rRole.status === 401);
  db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(USER);
  const rBack = await rpc(instance.id, liveToken, "tools/list");
  ok("restored role revalidates OK", rBack.status === 200);

  // 8b. Entitlement revoke → intersection gone.
  entitlementService.setEntitlements(adminCtx, RID, []);
  const rEnt = await rpc(instance.id, liveToken, "tools/list");
  ok("entitlement revoke kills the live token (401)", rEnt.status === 401);
  entitlementService.setEntitlements(adminCtx, RID, [{ scopeType: "org", scopeId: ORG, effect: "allow" }]);

  // 8c. Disable → immediate revocation.
  store.disableInstance(instance.id);
  const rDis = await rpc(instance.id, liveToken, "tools/list");
  ok("disable kills the live token (401)", rDis.status === 401);
  store.enableInstance(instance.id);
  ok("re-enable (still authorized) works", store.getInstance(instance.id).status === "enabled");
}

// ─── 9. App credential rotation clears authorization ──────────

{
  // Section 8 re-enabled the instance while AUTHORIZED — rotating now proves
  // the atomic fix on a fully authorized row: one transaction, so the new
  // credential can never be paired with the old client's OAuth blob.
  const rowBefore = db.prepare(`SELECT oauth_ciphertext FROM connector_instances WHERE id = ?`).get(instance.id) as any;
  ok("authorized row carries OAuth ciphertext before rotation", !!rowBefore?.oauth_ciphertext);
  store.writeCredentials(instance.id, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const view = store.getInstance(instance.id);
  ok("app credential rotation clears the user authorization",
    view.authorization?.status === "none" && view.configVersion > 2);
  const rowAfter = db.prepare(`SELECT oauth_ciphertext, oauth_expires_at FROM connector_instances WHERE id = ?`).get(instance.id) as any;
  ok("rotation is atomic: OAuth ciphertext AND expiry both cleared",
    rowAfter?.oauth_ciphertext == null && rowAfter?.oauth_expires_at == null);
  // Repeat on the already-cleared row: idempotent, still no ciphertext.
  store.writeCredentials(instance.id, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const rowAgain = db.prepare(`SELECT oauth_ciphertext FROM connector_instances WHERE id = ?`).get(instance.id) as any;
  ok("repeated credential writes keep OAuth state cleared", rowAgain?.oauth_ciphertext == null);
  // A FRESHLY minted token (post-rotation resolve) is denied at the oauth
  // gate — the user authorization is gone even though the instance stays
  // enabled; only re-authorization can restore calls.
  const bFresh = resolveBundle();
  const freshToken = connectorToken(bFresh);
  ok("resolve still injects the rotated (enabled) instance", !!freshToken);
  const rFresh = await rpc(instance.id, freshToken, "tools/call", {
    name: "search_docs", arguments: { query: "x" },
  });
  ok("fresh token denied at the oauth gate after rotation (401, none)",
    rFresh.status === 401 && /oauth authorization none/.test(JSON.stringify(rFresh.body)),
    JSON.stringify(rFresh.body).slice(0, 150));
  // And the stale live token (pre-rotation) is killed — either at the token
  // registry (configVersion bump revokes the jti) or at the oauth gate.
  const rStale = await rpc(instance.id, liveToken, "tools/list");
  ok("stale token denied after credential rotation (401)", rStale.status === 401);
}

// ─── 10. Bounded upstream behavior ────────────────────────────

{
  // Re-authorize (instance is already enabled post-rotation) for the bounded section.
  const s = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const consent = await fetch(new URL(s.body.authorizeUrl), { redirect: "manual" });
  const loc = new URL(consent.headers.get("location") ?? "", BASE);
  await api("admin", "GET", `${loc.pathname}${loc.search}`);
  const b = resolveBundle();
  liveToken = connectorToken(b);

  const oversize = await rpc(instance.id, liveToken, "tools/call", {
    name: "search_docs", arguments: { query: "oversize" },
  });
  const oversizeText = oversize.body?.result?.content?.[0]?.text ?? "";
  ok("oversize response is bounded (truncated or pre-rejected by size cap)",
    oversize.body?.result?.isError !== true && /"truncated":true/.test(oversizeText) ||
    (oversize.body?.result?.isError === true && /262144/.test(oversizeText)),
    oversizeText.slice(0, 120));

  const redirect = await rpc(instance.id, liveToken, "tools/call", {
    name: "search_docs", arguments: { query: "redirect" },
  });
  ok("upstream redirect rejected (not followed)",
    redirect.body?.result?.isError === true && /重定向被拒绝/.test(redirect.body.result.content[0].text));

  const slow = await rpc(instance.id, liveToken, "tools/call", {
    name: "get_doc", arguments: { doc_id: "slowdoc" },
  });
  ok("upstream timeout bounded (tool error)", slow.body?.result?.isError === true, JSON.stringify(slow.body).slice(0, 120));
}

// ─── 10b. Fix round #1: redirect URI from operator config ─────

{
  const saved = process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL;
  const start = () => api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  try {
    delete process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL;
    let r = await start();
    ok("missing public origin config → clear admin error, no state created",
      r.status === 400 && /CONNECTOR_OAUTH_PUBLIC_BASE_URL/.test(r.text), r.text.slice(0, 120));

    process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL = "not a url";
    r = await start();
    ok("malformed public origin config → admin error", r.status === 400 && /CONNECTOR_OAUTH_PUBLIC_BASE_URL/.test(r.text));

    process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL = "http://example.com";
    r = await start();
    ok("non-HTTPS non-loopback public origin → admin error", r.status === 400 && /HTTPS/.test(r.text));

    // Origin-only normalization: path/query on the config value are dropped.
    process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL = "https://example.com/a/b?x=1";
    r = await start();
    const redirectParam = new URL(r.body.authorizeUrl).searchParams.get("redirect_uri") ?? "";
    ok("public origin normalized to origin-only (HTTPS)",
      r.status === 200 && redirectParam === `https://example.com${oauth.CALLBACK_PATH}`, redirectParam);

    process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL = "http://localhost:9999";
    r = await start();
    const loopbackParam = new URL(r.body.authorizeUrl).searchParams.get("redirect_uri") ?? "";
    ok("loopback HTTP allowed as the local test seam",
      r.status === 200 && loopbackParam === `http://localhost:9999${oauth.CALLBACK_PATH}`, loopbackParam);
  } finally {
    process.env.CONNECTOR_OAUTH_PUBLIC_BASE_URL = saved;
  }
  // The successful starts above flipped oauth_status to pending — restore
  // authorized for the audit section.
  const s = await start();
  const consent = await fetch(new URL(s.body.authorizeUrl), { redirect: "manual" });
  const loc = new URL(consent.headers.get("location") ?? "", BASE);
  const cb = await api("admin", "GET", `${loc.pathname}${loc.search}`);
  ok("flow still completes with the configured loopback origin", cb.status === 200);
}

// ─── 10c. Fix round #2: invalid-state callbacks write NO audit rows ──

{
  const auditCount = (action?: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM governance_audit_log ${action ? "WHERE action = ?" : ""}`).get(action ? [action] : []) as { c: number }).c;

  const beforeAll = auditCount();
  // Unauthenticated flood: 50 random-state callbacks — none may write an
  // audit row (a never-valid state is attacker-controlled input, not a
  // state-backed governance event).
  const floods = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      fetch(`${BASE}${oauth.CALLBACK_PATH}?state=flood-${i}&code=flood-code-${i}`)
    )
  );
  const allRejected = floods.every((r) => r.status === 400);
  ok("invalid-state callback flood all rejected (oauth=error UX preserved)", allRejected);
  ok("50 invalid unauthenticated callbacks write ZERO audit rows",
    auditCount() === beforeAll, `before=${beforeAll} after=${auditCount()}`);

  // A VALID-state failure (state consumed, exchange failed) IS audited.
  // (The admin oauth/start call audits itself too — so scope the count to
  // callback-action rows to assert exactly one new row from the failure.)
  const cbBefore = auditCount("connector.oauth.callback");
  const s = await api("admin", "POST", `/api/admin/connectors/instances/${instance.id}/oauth/start`);
  const consent = await fetch(new URL(s.body.authorizeUrl), { redirect: "manual" });
  const loc = new URL(consent.headers.get("location") ?? "", BASE);
  const badCode = await api("admin", "GET", `${loc.pathname}?code=bogus-code&state=${loc.searchParams.get("state")}`);
  ok("state-backed failure still audited (+1 callback row)",
    badCode.status === 400 && auditCount("connector.oauth.callback") === cbBefore + 1,
    `status=${badCode.status} before=${cbBefore} after=${auditCount("connector.oauth.callback")}`);
  const lastAudit = JSON.stringify(
    db.prepare(`SELECT * FROM governance_audit_log WHERE action = 'connector.oauth.callback' ORDER BY rowid DESC LIMIT 1`).get()
  );
  ok("state-backed audit row is metadata-only (no code/state echo)",
    lastAudit.includes("denied") && !lastAudit.includes("bogus-code"));
}

// ─── 11. Secrets never in responses / audits / diagnostics ────

{
  const listResp = await api("admin", "GET", "/api/admin/connectors/instances");
  ok("instances API carries no client secret / access / refresh token",
    !listResp.text.includes(CLIENT_SECRET) &&
    !listResp.text.includes("m2b-at-") && !listResp.text.includes("m2b-rt-"));
  const audits = auditJson();
  ok("governance audits carry no token material",
    !audits.includes(CLIENT_SECRET) && !audits.includes("m2b-at-") && !audits.includes("m2b-rt-"));
  // The start response already checked; also check the callback route returned
  // only ok/error (no code echo) — covered by 400 shape above.
}

// ─── cleanup ──────────────────────────────────────────────────

await new Promise<void>((r) => server.close(() => r()));
fake.close();
rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n=== M2b feishu OAuth: ${pass} passed ===`);
