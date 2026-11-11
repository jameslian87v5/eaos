/**
 * skillhub-client.test.ts — real-contract HTTP client tests (fake fetch).
 * Run: npx tsx server/skillhub-client.test.ts
 *
 * R5b-2: replaces the stale cursor / /api/v1/skills?namespace= / bundle.zip
 * assumptions with the REAL Hub contract (docs/06-deployment/skillhub-r5b2-contract-forensics.md):
 *  - envelope {code,msg,data,timestamp,requestId}; code===0 success.
 *  - listNamespaces: /api/v1/namespaces?page=&size= → Spring PageResponse
 *    (data.content[] + data.totalPages).
 *  - listPublishedSkills(ns): /api/cli/v1/skills/search?limit= → data.items[]
 *    each {namespace, slug, latestVersion, summary}; filter client-side.
 *  - getVersionDetail: /api/cli/v1/skills/{ns}/{slug}/resolve?version= → data.fingerprint.
 *  - downloadSkill: /api/cli/v1/skills/{ns}/{slug}/versions/{v}/download →
 *    application/zip; filename from Content-Disposition; local sha256.
 */
export {};

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

let passed = 0, failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) passed++; else { failed++; failures.push(msg); console.error(`  ❌ ${msg}`); }
}

interface FakeResp {
  url: string;
  status: number;
  body?: any;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: Record<string, string>;
}
function fakeFetch(responses: FakeResp[]): (url: string, init?: any) => Promise<any> {
  return async (url: string) => {
    const r = responses.find((r) => !r.url || url.includes(r.url));
    if (!r) return { ok: false, status: 404, json: async () => ({ code: 404, msg: "not found", data: null }), text: async () => "", headers: { get: () => null } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: r.json ?? (async () => r.body),
      text: r.text ?? (async () => JSON.stringify(r.body)),
      arrayBuffer: r.arrayBuffer ?? (async () => new TextEncoder().encode(JSON.stringify(r.body ?? "")).buffer),
      headers: { get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null },
    };
  };
}

const { createSkillhubClient, SkillhubApiError } = await import("./skillhub-client.js");

// 1. listNamespaces: real Portal shape data.items[] + data.total + data.size
//    (VERIFIED live: /api/v1/namespaces returns {code,msg,data:{items,total,page,size}},
//    NOT Spring PageResponse.content/totalPages).
{
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/api/v1/namespaces?page=0", status: 200, body: { code: 0, msg: "ok", data: { items: [{ slug: "global", displayName: "Global", type: "GLOBAL", status: "ACTIVE" }, { slug: "org-x", type: "TEAM", status: "ACTIVE" }], total: 2, page: 0, size: 100 } } },
  ]) });
  const ns = await c.listNamespaces();
  assert(ns.length === 2, "1.1 listNamespaces data.items length 2");
  assert(ns[0].slug === "global" && ns[0].type === "GLOBAL", "1.1 global/GLOBAL");
  assert(ns[1].slug === "org-x" && ns[1].type === "TEAM", "1.1 org-x/TEAM");
}

// 2. listNamespaces multi-page (total > size → two requests)
{
  const seen: string[] = [];
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: async (url: string) => {
    seen.push(url);
    const page = url.includes("page=0") ? 0 : 1;
    return { ok: true, status: 200, json: async () => ({ code: 0, msg: "ok", data: { items: [{ slug: `ns${page}`, type: "TEAM", status: "ACTIVE" }], total: 2, page, size: 1 } }), headers: { get: () => null } };
  } });
  const ns = await c.listNamespaces();
  assert(ns.length === 2, "2.1 two pages → 2 namespaces");
  assert(seen.length === 2, "2.1 fetched 2 pages");
}

// 3. listPublishedSkills: search data.items[] filtered by namespace
{
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/api/cli/v1/skills/search", status: 200, body: { code: 0, msg: "ok", data: { items: [
      { namespace: "global", slug: "agentguard", latestVersion: "1.1", summary: "" },
      { namespace: "other", slug: "x", latestVersion: "2.0", summary: "" },
      { namespace: "global", slug: "ai-claim-checker", latestVersion: "1.0.0", summary: "" },
    ], total: 3, limit: 1000 } } },
  ]) });
  const skills = await c.listPublishedSkills("global");
  assert(skills.length === 2, "3.1 filter → 2 global skills");
  assert(skills[0].slug === "agentguard" && skills[0].latestVersion === "1.1", "3.1 agentguard 1.1");
  assert(skills[1].slug === "ai-claim-checker", "3.1 ai-claim-checker");
}

// 4. getVersionDetail: resolve → data.fingerprint (the content hash)
{
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/resolve?version=1.1", status: 200, body: { code: 0, msg: "ok", data: { namespace: "global", slug: "agentguard", version: "1.1", versionId: 7, fingerprint: "abc123", downloadUrl: "..." } } },
  ]) });
  const v = await c.getVersionDetail("global", "agentguard", "1.1");
  assert(v.sha256 === "abc123", "4.1 sha256 = fingerprint");
  assert(v.version === "1.1", "4.1 version");
}

// 5. downloadSkill: application/zip + Content-Disposition filename + local sha
{
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(60).fill(0)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/download", status: 200, arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength), headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="agentguard-1.1.zip"' } },
  ]) });
  const dl = await c.downloadSkill("global", "agentguard", "1.1", dir);
  assert(dl.localPath.endsWith("agentguard-1.1.zip"), "5.1 filename from Content-Disposition");
  assert(fs.existsSync(dl.localPath), "5.1 file written");
  assert(dl.sha256 === createHash("sha256").update(zipBytes).digest("hex"), "5.1 local sha256");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6. downloadSkill rejects wrong Content-Type (deny-wins)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/download", status: 200, body: { code: 0, msg: "ok", data: null }, headers: { "content-type": "text/html", "content-disposition": 'attachment; filename="x.zip"' } },
  ]) });
  let threw = false;
  try { await c.downloadSkill("global", "x", "1", dir); } catch (e: any) { threw = e instanceof SkillhubApiError; }
  assert(threw, "6.1 wrong content-type rejected");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7. downloadSkill sanitizes a malicious Content-Disposition filename
{
  const zipBytes = Buffer.alloc(10, 0x41);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/download", status: 200, arrayBuffer: async () => zipBytes.buffer.slice(0, 10), headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="../../etc/evil.zip"' } },
  ]) });
  const dl = await c.downloadSkill("global", "x", "1", dir);
  const base = path.basename(dl.localPath);
  assert(!base.includes("..") && !base.includes("/"), "7.1 CD path stripped: " + base);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 8. envelope error: code≠0 → SkillhubApiError with apiCode + msg
{
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/api/v1/namespaces", status: 200, body: { code: 403, msg: "需要权限", data: null } },
  ]) });
  let threw = false;
  try { await c.listNamespaces(); } catch (e: any) {
    threw = e instanceof SkillhubApiError;
    assert(e.apiCode === 403, "8.1 apiCode=403");
    assert(e.message.includes("需要权限"), "8.1 msg transparent");
  }
  assert(threw, "8.1 code≠0 throws SkillhubApiError");
}

// 9. namespace too large (> SEARCH_LIMIT) → reject (no silent truncation)
{
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/api/cli/v1/skills/search", status: 200, body: { code: 0, msg: "ok", data: { items: [], total: 2000, limit: 1000 } } },
  ]) });
  let threw = false;
  try { await c.listPublishedSkills("global"); } catch { threw = true; }
  assert(threw, "9.1 namespace > limit rejected (no truncation)");
}

// 10. compressed package bound is enforced using actual bytes even when
// Content-Length is absent or forged small. No final or tmp file survives.
for (const [label, contentLength] of [["absent", undefined], ["forged-small", "1"]] as const) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-limit-"));
  const bytes = Buffer.alloc(9, 0x41);
  const headers: Record<string, string> = { "content-type": "application/zip" };
  if (contentLength) headers["content-length"] = contentLength;
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", maxDownloadBytes: 8, fetchImpl: fakeFetch([
    { url: "/download", status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers },
  ]) } as any);
  let threw = false;
  try { await c.downloadSkill("global", "x", "1", dir); } catch { threw = true; }
  assert(threw, `10.${label} actual oversized body rejected`);
  assert(fs.readdirSync(dir).length === 0, `10.${label} no downloaded artifact survives`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 11. declared oversized body is rejected before buffering.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-limit-"));
  let buffered = false;
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", maxDownloadBytes: 8, fetchImpl: fakeFetch([
    { url: "/download", status: 200, arrayBuffer: async () => { buffered = true; return new ArrayBuffer(0); }, headers: { "content-type": "application/zip", "content-length": "9" } },
  ]) } as any);
  let threw = false;
  try { await c.downloadSkill("global", "x", "1", dir); } catch { threw = true; }
  assert(threw && !buffered, "11. oversized Content-Length rejected before buffering");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 12. Content-Disposition is accepted only as a strict .zip basename.
for (const badName of ["evil.txt", ".zip", ".", "bad\u0001.zip"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-name-"));
  const bytes = Buffer.from("zip");
  const c = createSkillhubClient({ baseUrl: "http://hub", token: "t", fetchImpl: fakeFetch([
    { url: "/download", status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${badName}"` } },
  ]) });
  const dl = await c.downloadSkill("global", "safe", "1", dir);
  assert(path.basename(dl.localPath) === "safe-1.zip", `12. invalid filename falls back: ${JSON.stringify(badName)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nskillhub-client.test: ${passed} passed, ${failed} failed.`);
if (failed) { console.error(failures.join("\n")); process.exit(1); }
process.exit(0);
