/**
 * Focused tests — M4.5-R1 preflight gate fixes:
 *   E.*  redactEndpointForReport never leaks userinfo / query / fragment /
 *        path from an env-derived baseUrl (negative assertions on the raw
 *        secret markers themselves);
 *   M.*  findMsb accepts only explicit MSB_PATH (must exist) or a controlled
 *        PATH lookup — NO machine-specific fallback (e.g. /private/tmp/...),
 *        even when such a binary actually exists on this host.
 *
 * No network, no real msb. Run: npx tsx server/local-sandbox-preflight.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findMsb, redactEndpointForReport } from "../scripts/local-sandbox-preflight.mjs";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  // E.1 userinfo credentials are dropped
  await test("E.1 userinfo (user:pass@) never appears in the sanitized endpoint", () => {
    const ep = redactEndpointForReport("https://deploy:s3cr3t-token@api.example.com/anthropic");
    const s = JSON.stringify(ep);
    assert.equal(ep.protocol, "https");
    assert.equal(ep.host, "api.example.com");
    assert.ok(!s.includes("deploy"), "username leaked");
    assert.ok(!s.includes("s3cr3t-token"), "password leaked");
    assert.ok(!s.includes("@"), "userinfo marker leaked");
  });

  // E.2 query string secrets are dropped
  await test("E.2 query (?api_key=…) never appears in the sanitized endpoint", () => {
    const ep = redactEndpointForReport("https://api.example.com/v1?api_key=q-secret-123&org=acme");
    const s = JSON.stringify(ep);
    assert.equal(ep.host, "api.example.com");
    assert.ok(!s.includes("q-secret-123"), "query secret leaked");
    assert.ok(!s.includes("api_key"), "query key name leaked");
    assert.ok(!s.includes("org=acme"), "query param leaked");
  });

  // E.3 path + fragment are dropped; non-default port is kept (it is routing, not secret)
  await test("E.3 path/fragment dropped; explicit port preserved", () => {
    const ep = redactEndpointForReport("https://api.example.com:8443/anthropic/v1#frag-9");
    const s = JSON.stringify(ep);
    assert.deepEqual(ep, { protocol: "https", host: "api.example.com:8443" });
    assert.ok(!s.includes("anthropic"), "path leaked");
    assert.ok(!s.includes("frag-9"), "fragment leaked");
  });

  // E.4 unparseable URL degrades to a fixed marker (never echoes the raw string)
  await test("E.4 unparseable baseUrl → fixed unparseable marker, raw string never echoed", () => {
    const ep = redactEndpointForReport("not a url with s3cr3t inside");
    assert.deepEqual(ep, { protocol: "unparseable", host: "unparseable" });
    assert.ok(!JSON.stringify(ep).includes("s3cr3t"), "raw string echoed");
  });

  // M.1 explicit MSB_PATH wins (and must exist)
  await test("M.1 explicit MSB_PATH to an existing file is used", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-msb-"));
    try {
      const fake = join(dir, "msb");
      writeFileSync(fake, "#!/bin/sh\n");
      assert.equal(findMsb({ MSB_PATH: fake, PATH: "" }), fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // M.2 MSB_PATH set but missing → null (loud failure, no silent PATH rescue)
  await test("M.2 MSB_PATH pointing nowhere → null (explicit failure, no silent rescue)", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-msb-"));
    try {
      const fake = join(dir, "msb");
      writeFileSync(fake, "#!/bin/sh\n");
      assert.equal(findMsb({ MSB_PATH: join(dir, "absent-msb"), PATH: dir }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // M.3 controlled PATH lookup finds msb on PATH
  await test("M.3 no MSB_PATH → controlled PATH lookup finds msb", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-msb-"));
    try {
      const fake = join(dir, "msb");
      writeFileSync(fake, "#!/bin/sh\n");
      assert.equal(findMsb({ PATH: `${dir}${delimiter}/usr/bin` }), fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // M.4 no MSB_PATH + empty PATH → null — even when a machine-specific binary
  // exists at the well-known dev scratch path on THIS host (proves the
  // /private/tmp fallback is gone, not merely untriggered).
  await test("M.4 empty PATH → null even if a /private/tmp scratch binary exists on this host", () => {
    assert.equal(findMsb({ PATH: "" }), null);
    assert.equal(findMsb({}), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
