#!/usr/bin/env node
/**
 * m2b-browser-check.mjs — Octop absorption M2b browser acceptance for the
 * Feishu docs OAuth connector UI flow (evt_20261021015806 §Browser evidence).
 *
 * Drives a REAL Chromium against the production-served dist bundle, with a
 * local fake Feishu server as the CONNECTOR_FEISHU_BASE_URL test double:
 *   admin: catalog 飞书文档 card → create (draft, no baseUrl) → write-only
 *   credential form (clientId/clientSecret, password inputs) → enable
 *   BLOCKED before authorization → 去授权 opens the fake consent page →
 *   302 back to the unauthenticated callback → /admin/connectors?oauth=success
 *   → toast + authorized badge + expiry → enable → enabled;
 *   secrets never rendered in any DOM; the authorize URL carries no secret.
 *
 * Run: NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m2b-browser-check.mjs
 */
import { chromium } from "/tmp/m1d-pw/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const PORT = 3904;
const DB_PATH = "/tmp/m2b-browser.db";
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = `m2b-cli-${Date.now().toString(36)}`;
const CLIENT_SECRET = `m2b-sec-${crypto.randomBytes(12).toString("hex")}`;
const ADMIN_PASS = "m2b-admin-1";
const SHOT_DIR = path.join(process.cwd(), "docs/06-deployment/evidence/m2b-browser");
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  results.push(line);
  cond ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Fake Feishu (PKCE-verifying consent + token endpoint) ────────
const codeToChallenge = new Map();
const issuedAccessTokens = [];
const authorizeSeen = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake-feishu");
  if (url.pathname === "/authen/v1/authorize" && req.method === "GET") {
    authorizeSeen.push(url);
    const state = url.searchParams.get("state") ?? "";
    const code = `brw-code-${state.slice(0, 8)}`;
    codeToChallenge.set(code, url.searchParams.get("code_challenge") ?? "");
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    res.statusCode = 302;
    res.setHeader("location", `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
    res.end();
    return;
  }
  if (url.pathname === "/authen/v2/oauth/token" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = JSON.parse(body || "{}");
      if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }
      const expected = codeToChallenge.get(form.code);
      const recomputed = crypto.createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
      if (form.grant_type === "authorization_code" && expected && recomputed === expected) {
        codeToChallenge.delete(form.code);
        const at = `m2b-brw-at-${crypto.randomBytes(8).toString("hex")}`;
        issuedAccessTokens.push(at);
        res.end(JSON.stringify({ access_token: at, refresh_token: `m2b-brw-rt-${crypto.randomBytes(8).toString("hex")}`, expires_in: 3600 }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid_grant" }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const FAKE_PORT = fake.address().port;
console.log(`[m2b] fake feishu on :${FAKE_PORT}`);

// ─── 2. Real backend (local runtime, temp DB, fake endpoints) ────────
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
const server = spawn("npx", ["tsx", "server/server.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    RUNTIME_MODE: "local",
    ALLOW_DEV_JWT_SECRET: "1",
    CONNECTOR_FEISHU_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    // Fix round #1: redirect URI authority is operator-configured (loopback
    // HTTP = local test seam, same policy as the feishu endpoint allowlist).
    CONNECTOR_OAUTH_PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (d) => { const s = d.toString(); serverLog.push(s); });
server.stderr.on("data", (d) => { serverLog.push(d.toString()); });

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(1000);
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok || r.status === 401 || r.status === 404) ready = true; } catch {}
}
ok("backend ready (local runtime, port 3904, temp DB)", ready);
if (!ready) {
  console.error("FATAL: backend never became ready; server log tail:\n" + serverLog.slice(-20).join(""));
  try { server.kill("SIGKILL"); } catch {}
  process.exit(1);
}

// Pre-boot: resolve the fresh-DB admin password change via API (not a UI step).
try {
  let login = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) })).json();
  if (login?.mustChangePassword) {
    await fetch(`${BASE}/api/auth/change-password`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` }, body: JSON.stringify({ oldPassword: "admin123", newPassword: ADMIN_PASS }) });
  }
} catch {}

async function login(page, user, pwd) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="请输入用户名"]', user);
  await page.fill('input[placeholder="请输入密码"]', pwd);
  await page.click('button[type="submit"]');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if ((await page.locator("body").innerText()).length > 50) return true;
  }
  return false;
}

let exitCode = 0;
try {
  await (async () => {
  // Refuse to run against a stale squatter on the port (the spawned server
  // would fail to bind and every request would hit the WRONG backend).
  try {
    const probe = await fetch(`${BASE}/api/health`);
    throw new Error(`port ${PORT} already serving — kill the squatter first (got HTTP ${probe.status})`);
  } catch (e) {
    if (!/fetch failed|ECONNREFUSED/.test(String(e?.message ?? e)) &&
        !String(e?.message ?? e).includes("already serving")) throw e;
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const adminOk = await login(page, "admin", ADMIN_PASS);
  ok("admin login lands in app", adminOk, page.url());

  await page.goto(`${BASE}/admin/connectors`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const bodyText = () => page.locator("body").innerText();

  // 1. Catalog card for the OAuth connector.
  ok("catalog card visible (飞书文档)", await page.getByText("飞书文档").first().isVisible());
  ok("catalog shows search_docs / get_doc tools", (await bodyText()).includes("search_docs") && (await bodyText()).includes("get_doc"));
  await page.screenshot({ path: `${SHOT_DIR}/01-catalog.png`, fullPage: true });

  // 2. Create a feishu-docs instance: select kind, name, NO baseUrl field.
  await page.selectOption("select", "feishu-docs");
  await page.waitForTimeout(300);
  ok("oauth kind hides the Base URL field (fixed endpoints hint)", (await bodyText()).includes("飞书固定端点"));
  const instName = `feishu-${Date.now().toString(36)}`;
  await page.fill('input[placeholder="my-internal-api"]', instName);
  await page.screenshot({ path: `${SHOT_DIR}/02-create-form.png`, fullPage: true });
  await page.click("button:has-text('创建')");
  await page.waitForTimeout(1200);
  const row = page.locator("tr", { hasText: instName });
  ok("created instance row appears as draft", await row.locator("text=draft").first().isVisible());
  ok("row shows （飞书固定端点） instead of a baseUrl", (await row.innerText()).includes("（飞书固定端点）"));
  await page.screenshot({ path: `${SHOT_DIR}/03-created-draft.png`, fullPage: true });

  // 3. Write-only credential form: clientId + clientSecret password inputs.
  await row.getByRole("button", { name: /写入凭证|轮换凭证/ }).click();
  await page.waitForTimeout(300);
  const credInputs = page.locator('input[type="password"][autocomplete="new-password"]');
  ok("credential form has TWO password fields (clientId/clientSecret)", (await credInputs.count()) === 2);
  const prefills = [];
  for (const h of await credInputs.elementHandles()) prefills.push(await h.inputValue());
  ok("credential inputs never prefilled", prefills.every((v) => v === ""));
  await credInputs.nth(0).fill(CLIENT_ID);
  await credInputs.nth(1).fill(CLIENT_SECRET);
  await page.screenshot({ path: `${SHOT_DIR}/04-credential-form.png`, fullPage: true });
  await page.click("button:has-text('保存')");
  await page.waitForTimeout(1500);
  ok("credential write → status ready", await page.locator("tr", { hasText: instName }).locator("text=ready").first().isVisible());
  ok("授权 column shows none badge", await page.locator("tr", { hasText: instName }).locator("text=none").first().isVisible());

  // 4. Enable is BLOCKED before authorization (button disabled).
  const enableBtn = page.locator("tr", { hasText: instName }).getByRole("button", { name: "启用" });
  ok("enable button disabled before authorization", await enableBtn.isDisabled());
  await page.screenshot({ path: `${SHOT_DIR}/05-ready-auth-none.png`, fullPage: true });

  // 5. 去授权: opens the fake consent page in a new tab; the authorize URL
  //    carries only client_id + state + PKCE challenge (never the secret).
  const popupPromise = ctx.waitForEvent("page", { timeout: 15000 });
  await page.locator("tr", { hasText: instName }).getByRole("button", { name: "去授权" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("networkidle");
  await popup.waitForTimeout(2500);
  const popupUrl = popup.url();
  ok("authorization completes in the new tab (lands on connectors page)", popupUrl.includes("/admin/connectors"), popupUrl.slice(0, 80));
  ok("callback URL carries no token/code material (param auto-cleaned by the page)",
    !popupUrl.includes("access_token") && !popupUrl.includes("code=") && popupUrl.includes("/admin/connectors"));
  ok("popup shows the 授权成功 toast", (await popup.locator("body").innerText()).includes("飞书授权成功"));
  await popup.screenshot({ path: `${SHOT_DIR}/06-oauth-success.png`, fullPage: true });
  ok("authorize request carried PKCE S256 + state (fake consent log)",
    authorizeSeen.length > 0 &&
    (authorizeSeen[authorizeSeen.length - 1].searchParams.get("code_challenge_method") === "S256") &&
    (authorizeSeen[authorizeSeen.length - 1].searchParams.get("client_id") === CLIENT_ID));

  // 6. Authorized badge + expiry visible; the popup table is live-refreshed.
  const popupRow = popup.locator("tr", { hasText: instName });
  ok("row shows authorized badge", await popupRow.locator("text=authorized").first().isVisible());
  ok("row shows authorization expiry (至 …)", (await popupRow.innerText()).includes("至 "));
  await page.screenshot({ path: `${SHOT_DIR}/07-authorized.png`, fullPage: true });

  // 7. Enable now works → enabled.
  await popupRow.getByRole("button", { name: "启用" }).click();
  await popup.waitForTimeout(1200);
  ok("enable after authorization → status enabled", await popup.locator("tr", { hasText: instName }).locator("text=enabled").first().isVisible());
  await popup.screenshot({ path: `${SHOT_DIR}/08-enabled.png`, fullPage: true });

  // 8. Secrets never rendered in any session DOM; authorize URL had no secret.
  const allDom = (await page.content()) + (await popup.content());
  ok("clientSecret NEVER rendered in DOM", !allDom.includes(CLIENT_SECRET));
  ok("fake authorize URLs carry no clientSecret",
    authorizeSeen.every((u) => !u.toString().includes(CLIENT_SECRET)));
  ok("access token never leaves the host (only the fake saw it, not the browser)",
    !allDom.includes(issuedAccessTokens[issuedAccessTokens.length - 1] ?? "nothing-issued"));

  // 9. Host server log carries no secrets.
  ok("host server log carries no clientSecret / access token",
    !serverLog.join("").includes(CLIENT_SECRET) &&
    !serverLog.join("").includes(issuedAccessTokens[issuedAccessTokens.length - 1] ?? "nothing-issued"));

  await ctx.close();
  await browser.close();

  console.log(`\n=== M2b browser check: ${pass} passed, ${fail} failed ===`);
  fs.writeFileSync(path.join(SHOT_DIR, "results.txt"), results.join("\n") + `\n\nTOTAL: ${pass} passed, ${fail} failed\n`);
  exitCode = fail > 0 ? 1 : 0;
  })();
} catch (e) {
  console.error("FATAL:", e.message);
  console.error("server log tail:\n" + serverLog.slice(-30).join(""));
  exitCode = 1;
} finally {
  try { server.kill("SIGKILL"); } catch {}
  try { fake.close(); } catch {}
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}
process.exit(exitCode);
