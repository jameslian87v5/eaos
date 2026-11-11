/**
 * platform-web-tools.test.ts — Agent OS W1 (simplified): BailianSearch + LocalFetch.
 *
 * Mocked network only. No real HTTP/DNS/key. Covers:
 *   - Bailian: correct request shape (search_options nesting) + source parse,
 *     key only in Authorization header + absent from result, timeout-through-body.
 *   - LocalFetch: public fetch + HTML→text, explicit blocked IPv4 (loopback/
 *     private/metadata), explicit IPv6 literal rejection, localhost, userinfo,
 *     non-http scheme, redirect chain, size cap, timeout-through-body.
 *
 * Run: npx tsx server/platform-web-tools.test.ts
 */
import assert from "node:assert";
import { bailianSearch, fetchPublicUrl, createPlatformWebToolsServer, isBailianConfigured } from "./platform-web-tools.js";

let passed = 0;
const failures: string[] = [];
async function t(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(`${name}: ${(err as Error).message}`); console.log(`  ✗ ${name}: ${(err as Error).message}`); }
}
const cat = (e: unknown) => (e as any)?.category ?? "unknown";

const KEY = "test-dashscope-key-do-not-use";

// ─── Bailian ──────────────────────────────────────────────────

function bailianResponse(status: number, body: unknown, headers: Record<string,string> = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), async json() { return body; }, async text() { return JSON.stringify(body); } };
}

await t("B1 bailian: search_options nesting + answer/sources; key only in Authorization, not in result", async () => {
  let captured: any = null;
  const fetchImpl = (async (url: any, init: any) => {
    captured = { url, auth: init.headers?.authorization, body: JSON.parse(init.body) };
    return bailianResponse(200, {
      output: {
        choices: [{ message: { role: "assistant", content: "Paris is the capital of France." } }],
        search_info: { search_results: [
          { title: "France", url: "https://en.wikipedia.org/wiki/France", site_name: "wikipedia" },
          { title: "Paris", link: "https://example.com/paris" },
          { title: "", url: "" },
        ] },
      },
    });
  }) as any;
  const r = await bailianSearch({ query: "capital of France" }, { apiKey: KEY, fetchImpl });
  assert.equal(r.answer, "Paris is the capital of France.");
  assert.equal(r.sources.length, 2, "drops empty-url entries");
  assert.equal(r.sources[0].url, "https://en.wikipedia.org/wiki/France");
  assert.equal(r.sources[0].siteName, "wikipedia");
  // Correct DashScope shape: enable_search + result_format under parameters;
  // forced_search + enable_source under parameters.search_options.
  assert.equal(captured.body.parameters.enable_search, true);
  assert.equal(captured.body.parameters.result_format, "message");
  assert.deepEqual(captured.body.parameters.search_options, { forced_search: true, enable_source: true });
  assert.equal(captured.auth, `Bearer ${KEY}`);
  assert(!JSON.stringify(r).includes(KEY), "key must not leak into result");
});

await t("B2 bailian: 401/429/500 → upstream; timeout-through-body via abort", async () => {
  for (const status of [401, 429, 500]) {
    const fetchImpl = (async () => bailianResponse(status, {})) as any;
    const e = await bailianSearch({ query: "x" }, { apiKey: KEY, fetchImpl }).then(() => null, (e) => e);
    assert.equal(cat(e), "upstream", `status ${status} → upstream`);
  }
  // Slow body: json() rejects when the signal aborts → timeout (deadline spans body).
  const fetchImpl = (async (_u: any, init: any) => ({
    status: 200, headers: new Headers(),
    async json() { return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })); },
  })) as any;
  const e = await bailianSearch({ query: "x" }, { apiKey: KEY, fetchImpl, timeoutMs: 30 }).then(() => null, (e) => e);
  assert.equal(cat(e), "timeout");
});

// ─── LocalFetch ───────────────────────────────────────────────

function res(status: number, contentType: string, body: string, extra: Record<string,string> = {}) {
  const enc = new TextEncoder();
  return {
    status,
    headers: new Headers({ "content-type": contentType, ...extra }),
    body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }),
  };
}
const publicFetch = (async () => res(200, "text/plain", "hello world")) as any;

await t("F1 web_fetch: public 200 text + HTML→text", async () => {
  const r = await fetchPublicUrl({ url: "http://good.example/path" }, { fetchImpl: publicFetch });
  assert.equal(r.status, 200);
  assert.equal(r.text, "hello world");
  assert.equal(r.truncated, false);

  const html = (async () => res(200, "text/html", "<h1>Title</h1><p>Body</p>")) as any;
  const h = await fetchPublicUrl({ url: "https://html.example/" }, { fetchImpl: html });
  assert.match(h.text, /TITLE/i);
  assert.match(h.text, /Body/);
  assert(!h.text.includes("<"));
});

await t("F2 web_fetch: blocked explicit IPv4 (loopback/private/metadata); fetch never called", async () => {
  for (const u of [
    "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.1/",
    "http://172.16.0.1/", "http://169.254.169.254/", "http://0.0.0.0/", "http://100.64.0.1/",
  ]) {
    let calls = 0;
    const e = await fetchPublicUrl({ url: u }, { fetchImpl: (async () => { calls++; return res(200,"text/plain","x"); }) as any }).then(() => null, (e) => e);
    assert.equal(cat(e), "blocked", `${u} should be blocked`);
    assert.equal(calls, 0, `${u}: fetch must not be called`);
  }
});

await t("F3 web_fetch: rejects localhost, IPv6 literals, userinfo, non-http schemes", async () => {
  for (const [u, want] of [
    ["http://localhost/", "blocked"],
    ["http://sub.localhost/", "blocked"],
    ["http://[::1]/", "blocked"],
    ["http://[0:0:0:0:0:0:0:1]/", "blocked"],
    ["http://[::ffff:127.0.0.1]/", "blocked"],
    ["http://[fd00::1]/", "blocked"],
    ["http://[fe80::1]/", "blocked"],
    ["http://user:pass@good.example/", "invalid"],
    ["ftp://good.example/", "invalid"],
    ["file:///etc/passwd", "invalid"],
  ] as const) {
    const e = await fetchPublicUrl({ url: u }, { fetchImpl: publicFetch }).then(() => null, (e) => e);
    assert.equal(cat(e), want, `${u} → ${want}`);
  }
});

await t("F4 web_fetch: redirect chain re-checks each target; final body returned", async () => {
  const script: Record<string, any> = {
    "http://a.example/": () => res(301, "text/plain", "", { location: "http://b.example/" }),
    "http://b.example/": () => res(302, "text/plain", "", { location: "http://c.example/final" }),
    "http://c.example/final": () => res(200, "text/plain", "final body"),
  };
  const fetchImpl = (async (url: string) => (Object.keys(script).find((k) => url.startsWith(k)) ? script[Object.keys(script).find((k) => url.startsWith(k))!]() : null)) as any;
  const r = await fetchPublicUrl({ url: "http://a.example/" }, { fetchImpl });
  assert.equal(r.text, "final body");
  assert.equal(r.finalUrl, "http://c.example/final");
});

await t("F5 web_fetch: redirect to blocked target is rejected", async () => {
  const fetchImpl = (async (url: string) =>
    url.startsWith("http://good.example/") ? res(302, "text/plain", "", { location: "http://127.0.0.1/" }) : null) as any;
  const e = await fetchPublicUrl({ url: "http://good.example/" }, { fetchImpl }).then(() => null, (e) => e);
  assert.equal(cat(e), "blocked");
});

await t("F6 web_fetch: size cap (>2 MiB → truncated, stream cancelled)", async () => {
  const big = new Uint8Array(3 * 1024 * 1024).fill("a".charCodeAt(0));
  let cancelled = false;
  const fetchImpl = (async () => ({
    status: 200, headers: new Headers({ "content-type": "text/plain" }),
    body: new ReadableStream<Uint8Array>({ start(c){ c.enqueue(big); }, cancel(){ cancelled = true; } }),
  })) as any;
  const r = await fetchPublicUrl({ url: "http://big.example/" }, { fetchImpl });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 100000, `text ≤ 100k (got ${r.text.length})`);
  assert.ok(cancelled, "stream cancelled at cap");
});

await t("F7 web_fetch: timeout-through-body via abort (slow stream → timeout)", async () => {
  const fetchImpl = (async (_u: string, init: any) => ({
    status: 200, headers: new Headers({ "content-type": "text/plain" }),
    body: new ReadableStream<Uint8Array>({ pull(c) { init.signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true }); } }),
  })) as any;
  const e = await fetchPublicUrl({ url: "http://slow.example/" }, { fetchImpl, timeoutMs: 30 }).then(() => null, (e) => e);
  assert.equal(cat(e), "timeout");
});

// ─── Factory ──────────────────────────────────────────────────

await t("P1 factory: key present → both tools; absent → web_fetch only", () => {
  assert.equal(isBailianConfigured({ dashscopeApiKey: "k" }), true);
  assert.equal(isBailianConfigured({}), false);
  const withKey = createPlatformWebToolsServer({ dashscopeApiKey: "k" }) as any;
  const noKey = createPlatformWebToolsServer({ dashscopeApiKey: null }) as any;
  assert.equal(withKey.name, "platform-web-tools");
  assert.equal(noKey.name, "platform-web-tools");
  assert.ok(withKey.instance, "has live MCP instance");
  assert.ok(noKey.instance, "web_fetch instance present without key");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }
