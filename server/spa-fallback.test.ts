// SPA catch-all route tests (integrated-walkthrough P2, evt_20261023050949).
// Covers: unknown browser routes serve the SPA shell; /experts + /my-skills
// deep links (hard reload) serve the SPA shell; unknown /api routes, missing
// static assets, and non-HTML namespaces keep fall-through-to-404 behavior.
// Run: npx tsx server/spa-fallback.test.ts
import express from "express";
import { shouldServeSpa, createSpaCatchAll } from "./spa-fallback.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// ─── Pure predicate ───────────────────────────────────────────
ok("unknown extension-less path serves SPA", shouldServeSpa("/definitely-not-a-route"));
ok("known SPA routes serve SPA", ["/admin", "/admin/users", "/experts", "/experts/x", "/my-skills", "/my-skills/x"].every(shouldServeSpa));
ok("/api paths never serve SPA", ["/api", "/api/unknown-route", "/api/admin/users"].every((p) => !shouldServeSpa(p)));
ok("non-HTML namespaces never serve SPA", ["/ws", "/assets", "/embed", "/embed/apps/x/widget", "/health", "/client"].every((p) => !shouldServeSpa(p)));
ok("file-like paths never serve SPA", ["/favicon.ico", "/assets/missing.js", "/logo.svg", "/widget.html"].every((p) => !shouldServeSpa(p)));
ok("prefix boundaries: /apix and /assetsx are SPA paths, not exclusions", shouldServeSpa("/apix") && shouldServeSpa("/assetsx"));

// ─── HTTP harness (same express pattern as user-skill-routes.test.ts) ──
const SPA_BODY = "<!doctype html><html><body>SPA-INDEX-STUB</body></html>";
const app = express();
app.get("/api/health", (_q, res) => res.json({ ok: true }));
app.get("*", createSpaCatchAll((_q, res) => res.type("html").send(SPA_BODY)));
const server = app.listen(0);
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function get(p: string) {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, body: await r.text() };
}

{
  const r = await get("/definitely-not-a-route");
  ok("HTTP: unknown browser route → 200 SPA shell", r.status === 200 && r.body === SPA_BODY, `status=${r.status}`);

  for (const p of ["/admin", "/admin/users", "/experts", "/my-skills"]) {
    const rr = await get(p);
    ok(`HTTP: ${p} (hard reload) → SPA shell`, rr.status === 200 && rr.body === SPA_BODY, `status=${rr.status}`);
  }

  const api = await get("/api/unknown-route");
  ok("HTTP: unknown /api route → 404, NOT index.html", api.status === 404 && api.body !== SPA_BODY, `status=${api.status}`);

  const health = await get("/api/health");
  ok("HTTP: real /api route still wins over the catch-all", health.status === 200 && health.body.includes("ok"));

  const asset = await get("/assets/missing.js");
  ok("HTTP: missing static asset → 404, NOT index.html", asset.status === 404 && asset.body !== SPA_BODY, `status=${asset.status}`);

  const ico = await get("/favicon.ico");
  ok("HTTP: missing favicon → 404, NOT index.html", ico.status === 404 && ico.body !== SPA_BODY, `status=${ico.status}`);
}

server.close();
console.log(`\nAll ${pass} assertions passed.`);
