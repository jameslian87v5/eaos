/**
 * user-memory-service.ts — one persistent MEMORY.md per authenticated user.
 *
 * Contract (docs/开发计划/ACTIVE—用户级-MEMORY-文档实施计划.md):
 *   - One user → exactly one MEMORY.md, shared by that user's Agents/Chats.
 *   - Canonical store is a HOST file: data/user-memory/<userId>/MEMORY.md.
 *     Local runtime confines path tools to this dir; Docker runtime bind-mounts
 *     this dir at /user-memory. Single source of truth for both runtimes.
 *   - userId is sanitized to an ID-safe segment (no traversal).
 *   - Writes are atomic (temp file + rename) and quota-enforced (byte length).
 *   - No vector DB, no memory-content table, no cross-user sharing.
 *   - CLAUDE.md is never created or used here.
 */
import path from "path";
import fs from "fs";
import { getRuntimeSettings, saveRuntimeSettings } from "./runtime-settings.js";

const FILE_NAME = "MEMORY.md";
const DEFAULT_QUOTA_BYTES = 64 * 1024; // 64 KiB

/** Resolve the host root for all user memory dirs (overridable for tests). */
function memoryRoot(): string {
  return process.env.USER_MEMORY_ROOT || path.resolve(process.cwd(), "data", "user-memory");
}

/**
 * Accept only the repository's safe user-ID format (ASCII alphanumeric plus `-`/
 * `_`, non-empty) and THROW on any other value. We do NOT strip invalid
 * characters — stripping would let distinct IDs alias the same directory
 * (e.g. `a/b` and `ab` both collapsing to `ab`). Rejecting unsafe IDs up front
 * guarantees one userId ↔ one directory, with no traversal or collision.
 */
const SAFE_USER_ID_RE = /^[A-Za-z0-9_-]+$/;
export function sanitizeUserId(userId: string): string {
  const s = String(userId ?? "");
  if (!s || !SAFE_USER_ID_RE.test(s)) throw new Error("invalid userId");
  return s;
}

export function getHostDir(userId: string): string {
  return path.join(memoryRoot(), sanitizeUserId(userId));
}

export function getHostFile(userId: string): string {
  return path.join(getHostDir(userId), FILE_NAME);
}

/** Volume/bind name (informational; docker uses the host dir as bind source). */
export function getUserMemoryBindName(userId: string): string {
  return `agent-user-memory-${sanitizeUserId(userId)}`;
}

export const USER_MEMORY_CONTAINER_PATH = "/user-memory";
export const USER_MEMORY_CONTAINER_FILE = "/user-memory/MEMORY.md";
export const USER_MEMORY_FILENAME = FILE_NAME;

function template(): string {
  return (
    "# Memory\n\n" +
    "Persistent, user-level notes shared across all of this user's agents and chats.\n" +
    "Keep it concise, well-structured, and current. Never store secrets here.\n"
  );
}

/** Provision the file exactly once; never overwrite user edits. Idempotent. */
export function ensureMemory(userId: string): void {
  const dir = getHostDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const file = getHostFile(userId);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, template(), "utf8");
  }
}

/** Read the document (provisioning first so callers always see a file). */
export function read(userId: string): string {
  ensureMemory(userId);
  return fs.readFileSync(getHostFile(userId), "utf8");
}

export function getQuotaBytes(): number {
  const v = (getRuntimeSettings() as any).userMemoryQuotaBytes;
  return typeof v === "number" && v > 0 ? v : DEFAULT_QUOTA_BYTES;
}

/** Quota is a single global platform setting (not per-user). Admin-only caller. */
export function setQuotaBytes(bytes: number): number {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 1024) throw new Error("user memory quota must be >= 1024 bytes");
  saveRuntimeSettings({ userMemoryQuotaBytes: n } as any);
  return getQuotaBytes();
}

/** Return null if content fits the quota, else a denial reason. Pure. */
export function checkQuota(content: string): string | null {
  const bytes = Buffer.byteLength(content, "utf8");
  const cap = getQuotaBytes();
  return bytes > cap ? `user memory quota exceeded (${bytes} > ${cap} bytes)` : null;
}

/** Replace the document atomically; rejects oversized content. */
export function write(userId: string, content: string): void {
  ensureMemory(userId);
  const over = checkQuota(content);
  if (over) throw new Error(over);
  const file = getHostFile(userId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/** Wipe the document and recreate the empty template. */
export function clear(userId: string): void {
  const dir = getHostDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getHostFile(userId), template(), "utf8");
}

/** Current byte size of the document (0 if missing). */
export function getSizeBytes(userId: string): number {
  try {
    return fs.statSync(getHostFile(userId)).size;
  } catch {
    return 0;
  }
}
