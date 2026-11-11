/**
 * sources.ts — fetch an external Skill source into a local extracted dir.
 *
 * Three input kinds (directive §4): Git URL (+ optional ref), ZIP URL(s),
 * batch ZIP upload. Each lands content into a fresh mkdtemp dir the caller
 * cleans up.
 *
 * Security (directive minimum):
 * - Git: `execFile` with an argv array (NO shell) → no command injection;
 *   `--branch <ref>` is a single value git parses, and we validate ref with
 *   a strict regex (reject `--`, `..`, `:`, leading `-`). Host allowlist via
 *   `SKILL_IMPORTER_ALLOWED_GIT_HOSTS`.
 * - ZIP URL: host allowlist (`SKILL_IMPORTER_ALLOWED_ZIP_HOSTS`), HTTPS-only
 *   in prod, Content-Length + streamed byte cap. `extractZip` (bounded-safe,
 *   reused from R5b2) handles malicious-archive rejection.
 * - Upload: `express.raw` byte cap; extractZip again.
 * - Temp dirs: `fs.mkdtemp` under a fixed base; caller removes recursively.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractZip } from "../skillhub-zip-extract.js";

const execFileP = promisify(execFile);

const TMP_BASE = process.env.SKILL_IMPORTER_TMP_BASE
  ? path.resolve(process.env.SKILL_IMPORTER_TMP_BASE)
  : path.join(os.tmpdir(), "skill-importer");

const MAX_DOWNLOAD_BYTES = parseInt(process.env.SKILL_IMPORTER_MAX_DOWNLOAD_BYTES ?? String(100 * 1024 * 1024), 10);
const GIT_TIMEOUT_MS = parseInt(process.env.SKILL_IMPORTER_GIT_TIMEOUT_MS ?? String(120000), 10);

function parseHostList(envVar: string | undefined, fallback: string[]): string[] {
  const raw = (envVar ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : fallback;
}

export function allowedGitHosts(): string[] {
  return parseHostList(process.env.SKILL_IMPORTER_ALLOWED_GIT_HOSTS, ["github.com", "gitlab.com", "gitee.com"]);
}
export function allowedZipHosts(): string[] {
  return parseHostList(process.env.SKILL_IMPORTER_ALLOWED_ZIP_HOSTS, ["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]);
}

export function makeTempDir(label: string): string {
  if (!fs.existsSync(TMP_BASE)) fs.mkdirSync(TMP_BASE, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(TMP_BASE, `${label}-`));
}

export function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** Safe ref: reject anything that looks like a git option/path-spec trick. */
export function validateGitRef(ref: string | undefined): string | null {
  if (!ref) return null;
  if (ref.length > 200) throw new Error("git ref too long");
  if (/(^|\/)\.\.(\/|$)/.test(ref) || ref.startsWith("-") || ref.includes(":") || ref.includes("\0")) {
    throw new Error(`invalid git ref: ${ref}`);
  }
  // Allow branch/tag/commit-ish: letters, digits, /, -, _, ., + (no shell meta).
  if (!/^[A-Za-z0-9._/+,-]{1,200}$/.test(ref)) throw new Error(`invalid git ref characters: ${ref}`);
  return ref;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
}

function assertAllowed(url: string, allowed: string[]): void {
  const h = hostOf(url);
  if (!allowed.some((a) => h === a || h.endsWith("." + a))) {
    throw new Error(`host not allowed: ${h}`);
  }
}

export interface FetchedSource {
  dir: string; // extracted content root
  sourceLabel: string; // for audit/UI (URL or "upload:<n>")
}

/** Git clone — shallow, single branch if ref given. No shell. */
export async function fetchGitSource(url: string, ref: string | undefined): Promise<FetchedSource> {
  assertAllowed(url, allowedGitHosts());
  // URL sanity: must start with https:// or git@ (no file://, no ssh with custom port tricks).
  if (!/^https:\/\/|^git@/.test(url)) throw new Error("git URL must be https:// or git@ form");
  const safeRef = validateGitRef(ref);
  const dir = makeTempDir("git");
  const args = ["clone", "--depth", "1", "--no-tags"];
  if (safeRef) args.push("--branch", safeRef);
  args.push("--", url, dir);
  try {
    await execFileP("git", args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    // Strip .git for cleanliness (not required).
    rmrf(path.join(dir, ".git"));
    return { dir, sourceLabel: `${url}${safeRef ? "@" + safeRef : ""}` };
  } catch (e) {
    rmrf(dir);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`git clone failed: ${msg.split("\n")[0].slice(0, 200)}`);
  }
}

/** Download a ZIP URL into a temp file, then bounded-safe extract. */
export async function fetchZipUrlSource(url: string): Promise<FetchedSource> {
  assertAllowed(url, allowedZipHosts());
  if (process.env.NODE_ENV === "production" && !url.startsWith("https://")) {
    throw new Error("zip URL must be https in production");
  }
  const zipFile = makeTempDir("zipdl") + ".zip";
  const dest = makeTempDir("zipx");
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const cl = parseInt(res.headers.get("content-length") ?? "0", 10);
    if (cl && cl > MAX_DOWNLOAD_BYTES) throw new Error(`download too large: ${cl} > ${MAX_DOWNLOAD_BYTES}`);
    const out = fs.createWriteStream(zipFile, { mode: 0o600 });
    let total = 0;
    const reader = (res.body as any as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value!.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
      out.write(Buffer.from(value!));
    }
    await new Promise<void>((resolve, reject) => out.end(() => resolve()) && out.on("error", reject));
    extractZip(zipFile, dest); // bounded-safe; throws on malicious/traversal
    return { dir: dest, sourceLabel: url };
  } finally {
    rmrf(zipFile);
  }
}

/** Extract an uploaded ZIP buffer into a fresh temp dir. */
export function extractUploadedZip(buf: Buffer, label: string): FetchedSource {
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`upload too large: ${buf.length} > ${MAX_DOWNLOAD_BYTES}`);
  const zipFile = makeTempDir("upl") + ".zip";
  const dest = makeTempDir("uplx");
  try {
    fs.writeFileSync(zipFile, buf, { mode: 0o600 });
    extractZip(zipFile, dest); // throws on malicious/traversal → caller cleans
    return { dir: dest, sourceLabel: label };
  } finally {
    rmrf(zipFile);
  }
}
