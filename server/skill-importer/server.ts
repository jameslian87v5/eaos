/**
 * server.ts — Skill Importer HTTP service (INDEPENDENT from the Agent platform
 * main app). Runs on port 8090 via `tsx server/skill-importer/server.ts`.
 *
 * Not mounted in server.ts; not part of the Agent runtime. Per design §1, this
 * is a separate service deployed beside the Hub. Admin-token Bearer gate on
 * every /api/import/* route; the Hub publish token stays server-side (env
 * SKILLHUB_PUBLISH_TOKEN) and is NEVER sent to the browser (directive §3.4,
 * §8; test: "凭证不下发前端").
 *
 * Two-phase confirm flow (live acceptance fix): scan → validate (dry-run,
 * surfaces warnings, NO publish) → operator reviews warnings → publish
 * (portal confirmWarnings=true). Publish requires prior validation; already-
 * published candidates are skipped (no duplicate publish). The scan session
 * survives validate + publish (TTL refreshed each call) so results stay
 * reviewable and retries skip published items; TTL sweep cleans up temp dirs.
 */
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSkills } from "./scanner.js";
import {
  appendScanSession,
  cleanupScanSession,
  publishConfirmedBatch,
  scanGit,
  scanUpload,
  scanZipUrl,
  selectByIds,
  startScanSession,
  validateBatch,
  type ScanHandle,
  type ScanSession,
} from "./service.js";
import { makeTempDir, rmrf } from "./sources.js";
import { zipDir } from "./zip-writer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SKILL_IMPORTER_PORT ?? "8090", 10);
const ADMIN_TOKEN = process.env.SKILL_IMPORTER_ADMIN_TOKEN ?? "";
const HUB_BASE = (process.env.SKILLHUB_URL ?? "").replace(/\/$/, "");
const HUB_PUBLISH_TOKEN = process.env.SKILLHUB_PUBLISH_TOKEN ?? "";
const HUB_VISIBILITY = process.env.SKILLHUB_PUBLISH_VISIBILITY; // optional
const SCAN_TTL_MS = 10 * 60_000;
const MAX_UPLOAD_BYTES = parseInt(process.env.SKILL_IMPORTER_MAX_UPLOAD_BYTES ?? String(50 * 1024 * 1024), 10);
const MAX_BATCH_ZIPS = parseInt(process.env.SKILL_IMPORTER_MAX_BATCH_ZIPS ?? "50", 10);

interface ScanEntry extends ScanSession {
  scanId: string;
  expiresAt: number;
  createdAt: number;
}
const scans = new Map<string, ScanEntry>();

function sweepScans(): void {
  const now = Date.now();
  for (const [id, e] of scans) {
    if (now > e.expiresAt) {
      cleanupScanSession(e);
      scans.delete(id);
    }
  }
}
setInterval(sweepScans, 60_000).unref?.();

/** Response body for a scan (single source or aggregated batch). */
function scanResponse(entry: ScanEntry) {
  const label = entry.sourceLabels.length > 1
    ? `${entry.sourceLabels.length} 个来源: ${entry.sourceLabels.join(", ").slice(0, 300)}`
    : entry.sourceLabels[0];
  return {
    scanId: entry.scanId,
    sourceLabel: label,
    skills: entry.skills.map((s) => ({
      id: s.id,
      name: s.name,
      relPath: s.relPath,
      description: s.description,
      hasScripts: s.hasScripts,
      license: s.license,
      fileCount: s.files.length,
      source: s.source,
    })),
    ignoredCount: entry.ignoredCount,
  };
}

/** Upload filename (query param) → safe display label; "" if unusable. */
function sanitizeFilename(raw: string): string {
  const b = path.basename(raw).replace(/[\r\n\0]/g, "").trim().slice(0, 120);
  return b === "." || b === ".." ? "" : b;
}

function adminAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!ADMIN_TOKEN) {
    res.status(503).json({ error: "Skill Importer admin token not configured" });
    return;
  }
  const auth = req.headers.authorization ?? "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tok || tok.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN))) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function hubConfig() {
  if (!HUB_BASE || !HUB_PUBLISH_TOKEN) throw new Error("Hub publish not configured (SKILLHUB_URL / SKILLHUB_PUBLISH_TOKEN)");
  return { baseUrl: HUB_BASE, publishToken: HUB_PUBLISH_TOKEN, visibility: HUB_VISIBILITY };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/import/scan-upload", express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }));

// scan: git / zip-url (JSON body)
app.post("/api/import/scan", adminAuth, async (req, res) => {
  const body = req.body ?? {};
  const kind = String(body.kind ?? "");
  const url = typeof body.url === "string" ? body.url : "";
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;
  let handle: ScanHandle;
  try {
    if (kind === "git") handle = await scanGit(url, ref);
    else if (kind === "zip-url") handle = await scanZipUrl(url);
    else return res.status(400).json({ error: "kind must be git|zip-url|zip-upload" });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
  const scanId = crypto.randomBytes(12).toString("hex");
  const entry: ScanEntry = { ...startScanSession(handle), scanId, expiresAt: Date.now() + SCAN_TTL_MS, createdAt: Date.now() };
  scans.set(scanId, entry);
  res.json(scanResponse(entry));
});

// scan: zip-upload (raw zip body; one ZIP per request).
// Batch: the browser sends multiple ZIPs sequentially with ?scanId= from the
// first response — each call extracts + scans its own temp dir and APPENDS the
// candidates to that scan session (ids never reused). ?filename= labels the
// source for display and the root-candidate name fallback.
app.post("/api/import/scan-upload", adminAuth, async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: "empty upload" });
  const label = sanitizeFilename(String(req.query.filename ?? "")) || `upload:${Date.now()}`;
  const prevScanId = typeof req.query.scanId === "string" ? req.query.scanId : "";
  const prev = prevScanId ? scans.get(prevScanId) : undefined;
  if (prevScanId && !prev) return res.status(404).json({ error: "scan not found or expired" });
  if (prev && prev.sourceLabels.length >= MAX_BATCH_ZIPS) {
    return res.status(400).json({ error: `batch limit reached (${MAX_BATCH_ZIPS} ZIPs per scan)` });
  }
  let handle: ScanHandle;
  try {
    handle = scanUpload(buf, label);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
  if (prev) {
    appendScanSession(prev, handle);
    prev.expiresAt = Date.now() + SCAN_TTL_MS; // refresh TTL on each append
    res.json(scanResponse(prev));
    return;
  }
  const scanId = crypto.randomBytes(12).toString("hex");
  const entry: ScanEntry = { ...startScanSession(handle), scanId, expiresAt: Date.now() + SCAN_TTL_MS, createdAt: Date.now() };
  scans.set(scanId, entry);
  res.json(scanResponse(entry));
});

// validate (Phase A, dry-run): surface warnings/errors per selected candidate; NEVER publish.
// Idempotent — re-validate refreshes the cached warnings. Session preserved.
app.post("/api/import/validate", adminAuth, async (req, res) => {
  const body = req.body ?? {};
  const scanId = String(body.scanId ?? "");
  const namespace = String(body.namespace ?? "");
  const selectedIds: string[] = Array.isArray(body.selected) ? body.selected.map(String) : [];
  const entry = scans.get(scanId);
  if (!entry) return res.status(404).json({ error: "scan not found or expired" });
  if (!namespace) return res.status(400).json({ error: "namespace required" });
  if (selectedIds.length === 0) return res.status(400).json({ error: "select at least one skill" });
  const wanted = selectByIds(entry, selectedIds);
  if (!wanted) return res.status(400).json({ error: "some selected ids not in scan" });
  let cfg;
  try { cfg = hubConfig(); } catch (e) { return res.status(503).json({ error: e instanceof Error ? e.message : String(e) }); }
  try {
    const result = await validateBatch(cfg, namespace, wanted);
    entry.expiresAt = Date.now() + SCAN_TTL_MS; // refresh TTL (operator is reviewing)
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// publish (Phase B): portal publish with confirmWarnings=true. Requires prior
// validation (the explicit-confirmation precondition). Already-published
// candidates are skipped (no duplicate publish). Session preserved until TTL.
app.post("/api/import/publish", adminAuth, async (req, res) => {
  const body = req.body ?? {};
  const scanId = String(body.scanId ?? "");
  const namespace = String(body.namespace ?? "");
  const selectedIds: string[] = Array.isArray(body.selected) ? body.selected.map(String) : [];
  const entry = scans.get(scanId);
  if (!entry) return res.status(404).json({ error: "scan not found or expired" });
  if (!namespace) return res.status(400).json({ error: "namespace required" });
  if (selectedIds.length === 0) return res.status(400).json({ error: "select at least one skill" });
  const wanted = selectByIds(entry, selectedIds);
  if (!wanted) return res.status(400).json({ error: "some selected ids not in scan" });
  let cfg;
  try { cfg = hubConfig(); } catch (e) { return res.status(503).json({ error: e instanceof Error ? e.message : String(e) }); }
  try {
    const result = await publishConfirmedBatch(cfg, namespace, wanted);
    entry.expiresAt = Date.now() + SCAN_TTL_MS; // refresh TTL (results reviewable)
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// namespaces: proxy Hub namespace list (publish-token Bearer; slug/name only)
app.get("/api/import/namespaces", adminAuth, async (_req, res) => {
  if (!HUB_BASE || !HUB_PUBLISH_TOKEN) return res.status(503).json({ error: "Hub not configured" });
  try {
    const r = await fetch(`${HUB_BASE}/api/v1/namespaces`, { headers: { Authorization: `Bearer ${HUB_PUBLISH_TOKEN}`, Accept: "application/json" } });
    const body = await r.json();
    const items = Array.isArray(body?.data?.items) ? body.data.items : Array.isArray(body?.data) ? body.data : [];
    const namespaces = items
      .map((n: any) => ({ slug: n?.slug ?? n?.name ?? "", name: n?.name ?? n?.displayName ?? n?.slug ?? "" }))
      .filter((n: any) => n.slug);
    res.json({ namespaces });
  } catch {
    res.status(502).json({ error: "namespace fetch failed" });
  }
});

app.get("/api/import/health", (_req, res) => res.json({ ok: true, hubConfigured: Boolean(HUB_BASE && HUB_PUBLISH_TOKEN) }));
app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log(`[skill-importer] listening on http://localhost:${PORT}`);
  if (!ADMIN_TOKEN) console.warn("[skill-importer] WARNING: SKILL_IMPORTER_ADMIN_TOKEN unset — all requests will 503");
  if (!HUB_BASE || !HUB_PUBLISH_TOKEN) console.warn("[skill-importer] WARNING: SKILLHUB_URL / SKILLHUB_PUBLISH_TOKEN unset — publish will 503");
});
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });

export { app, scans, sweepScans, makeTempDir, rmrf, scanForSkills, zipDir };
