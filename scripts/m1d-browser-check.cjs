#!/usr/bin/env node
/**
 * m1d-browser-check.cjs — M1d browser visual acceptance for /admin/connectors.
 *
 * Drives a REAL Chromium against the production-served dist bundle:
 *   admin: catalog visible → create (draft) → credential write (ready) →
 *   enable/disable → secret never rendered;
 *   non-admin: no Connectors nav entry, direct URL does not expose the page.
 *
 * Run: NODE_PATH=/tmp/m1d-pw/node_modules node scripts/m1d-browser-check.cjs \
 *        http://127.0.0.1:<port> <adminUser> <adminPass> <plainUser> <plainPass> <secret>
 * (browser binaries: ~/Library/Caches/ms-playwright via `npx playwright install chromium`)
 */
const { chromium } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");

const [BASE, ADMIN_USER, ADMIN_PASS, PLAIN_USER, PLAIN_PASS, SECRET] = process.argv.slice(2);
const SHOT_DIR = path.join(process.cwd(), "docs/06-deployment/evidence/m1d-browser");
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  const line = `${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`;
  console.log(line);
  results.push(line);
  cond ? pass++ : fail++;
}

async function login(page, user, pwd) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="请输入用户名"]', user);
  await page.fill('input[placeholder="请输入密码"]', pwd);
  await page.click('button[type="submit"]');
  // Poll until the post-login app renders (login request + SPA boot).
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    if ((await page.locator("body").innerText()).length > 50) return true;
  }
  return false;
}

(async () => {
  const browser = await chromium.launch();
  const results2 = { secret: SECRET };

  // ─── Admin session ───────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const adminOk = await login(page, ADMIN_USER, ADMIN_PASS);
  ok("admin login lands in app", adminOk, page.url());

  await page.goto(`${BASE}/admin/connectors`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const bodyText = () => page.locator("body").innerText();

  // 1. Catalog visible.
  ok("catalog card visible (通用内部 REST API)", await page.getByText("通用内部 REST API").first().isVisible());
  ok("catalog shows allowed tool rest_request", (await bodyText()).includes("rest_request"));
  await page.screenshot({ path: `${SHOT_DIR}/01-catalog.png`, fullPage: true });

  // 2. Create instance → draft.
  const instName = `brw-${Date.now().toString(36)}`;
  await page.fill('input[placeholder="my-internal-api"]', instName);
  await page.fill('input[placeholder^="http://"]', "http://127.0.0.1:1");
  await page.screenshot({ path: `${SHOT_DIR}/02-create-form.png`, fullPage: true });
  await page.click("button:has-text('创建')");
  await page.waitForTimeout(1200);
  ok("created instance row appears as draft", await page.locator("tr", { hasText: instName }).locator("text=draft").first().isVisible());
  await page.screenshot({ path: `${SHOT_DIR}/03-created-draft.png`, fullPage: true });

  // 3. Credential write (password input, never prefilled) → ready.
  const row = page.locator("tr", { hasText: instName });
  await row.getByRole("button", { name: /写入凭证|轮换凭证/ }).click();
  await page.waitForTimeout(300);
  const credInput = page.locator('input[type="password"][autocomplete="new-password"]');
  ok("credential form is type=password + autocomplete=new-password", (await credInput.count()) === 1);
  const prefill = await credInput.inputValue();
  ok("credential form never prefilled", prefill === "");
  await credInput.fill(SECRET);
  await page.screenshot({ path: `${SHOT_DIR}/04-credential-form.png`, fullPage: true });
  await page.click("button:has-text('保存')");
  await page.waitForTimeout(1200);
  ok("credential write → status ready", await page.locator("tr", { hasText: instName }).locator("text=ready").first().isVisible());
  ok("credential column shows 已写入 (boolean, not the secret)", await page.locator("tr", { hasText: instName }).locator("text=已写入").first().isVisible());
  await page.screenshot({ path: `${SHOT_DIR}/05-credential-ready.png`, fullPage: true });

  // 4. Enable / disable.
  await page.locator("tr", { hasText: instName }).getByRole("button", { name: "启用" }).click();
  await page.waitForTimeout(1000);
  ok("enable → status enabled", await page.locator("tr", { hasText: instName }).locator("text=enabled").first().isVisible());
  await page.screenshot({ path: `${SHOT_DIR}/06-enabled.png`, fullPage: true });
  await page.locator("tr", { hasText: instName }).getByRole("button", { name: "禁用" }).click();
  await page.waitForTimeout(1000);
  ok("disable → status disabled", await page.locator("tr", { hasText: instName }).locator("text=disabled").first().isVisible());
  await page.screenshot({ path: `${SHOT_DIR}/07-disabled.png`, fullPage: true });

  // 5. Secret never rendered anywhere in the admin session DOM.
  const adminDom = await page.content();
  ok("secret NEVER rendered in DOM (admin session)", !adminDom.includes(SECRET));
  const pageBody = await bodyText();
  ok("instance table shows configVersion + timestamps", pageBody.includes("configVersion") || /\d{4}-\d{2}-\d{2}/.test(pageBody));

  await ctx.close();

  // ─── Non-admin session ───────────────────────────────────────
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page2 = await ctx2.newPage();
  const plainOk = await login(page2, PLAIN_USER, PLAIN_PASS);
  ok("plain user login lands in app", plainOk);

  // Direct URL: AdminLayout role guard must not expose the connectors page
  // content (backend 403 is authoritative; the page shows no data).
  const navText = await page2.locator("body").innerText();
  ok("plain user sidebar has NO Connectors entry", !navText.includes("Connectors"));
  await page2.goto(`${BASE}/admin/connectors`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(1200);
  const directDom = await page2.content();
  const directText = await page2.locator("body").innerText();
  ok("direct /admin/connectors URL exposes no catalog/instance data for plain user",
    !directText.includes("通用内部 REST API") && !directText.includes("Catalog（平台内置连接器类型）"));
  await page2.screenshot({ path: `${SHOT_DIR}/08-plain-user-direct-url.png`, fullPage: true });
  ok("secret absent from plain-user session DOM", !directDom.includes(SECRET));

  await ctx2.close();
  await browser.close();

  console.log(`\n=== M1d browser check: ${pass} passed, ${fail} failed ===`);
  fs.writeFileSync(path.join(SHOT_DIR, "results.txt"), results.join("\n") + `\n\nTOTAL: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
