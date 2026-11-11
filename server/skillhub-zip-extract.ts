/**
 * skillhub-zip-extract.ts — bounded-safe ZIP extractor for Skill Hub downloads.
 *
 * R5b-2: the real Hub delivers skills as ZIP archives (application/zip,
 * filename `{slug}-{version}.zip`). This extractor is the bounded-safe
 * implementation injected into skillhub-bridge.prod.ts (replacing the R5a
 * fail-closed no-op). No third-party zip lib — uses the ZIP central directory
 * + node:zlib inflateRaw (the project's custom-binary-I/O precedent).
 *
 * Security (deny-wins on ANY violation; destDir is removed on failure so no
 * half-extracted state survives — the bridge then catches → import_failed
 * audit + no mirror + no entitlement):
 *  - filename: reject absolute paths, drive letters, `..` segments, and any
 *    entry whose resolved path escapes destDir.
 *  - symlinks: reject entries whose Unix mode is S_IFLNK (do not materialize
 *    links that could escape destDir).
 *  - methods: only STORE(0) and DEFLATE(8); anything else → reject.
 *  - bounds: maxEntries, maxTotalUncompressed, maxFileUncompressed, maxRatio
 *    (zip-bomb). Defaults are conservative.
 *  - corruption: inflateRawSync failure, or uncompressed size mismatch, or a
 *    malformed central directory → reject.
 *
 * Not a general-purpose unzipper: deliberately strict. No auto-recursion into
 * nested zips (a nested zip is extracted as a single file, not traversed).
 */
import { crc32, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, statSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface ExtractBounds {
  maxEntries?: number;
  maxTotalUncompressed?: number; // bytes
  maxFileUncompressed?: number; // bytes
  maxRatio?: number; // uncompressed/compressed
}

export const DEFAULT_BOUNDS: Required<ExtractBounds> = {
  maxEntries: 1024,
  maxTotalUncompressed: 100 * 1024 * 1024, // 100 MB
  maxFileUncompressed: 50 * 1024 * 1024, // 50 MB
  maxRatio: 100, // 100:1 — catches zip-bombs
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const S_IFLNK = 0xa000;

class ZipExtractError extends Error {
  constructor(msg: string) { super(msg); this.name = "ZipExtractError"; }
}

function findEocd(buf: Buffer): number {
  // EOCD is the last occurrence of its signature; scan back from end (max 22+64KB comment).
  const min = 22;
  const maxScan = Math.min(buf.length, 22 + 65535);
  for (let i = buf.length - min; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipExtractError("EOCD record not found — not a ZIP archive");
}

interface CentralEntry {
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  name: string;
  isSymlink: boolean;
  localOffset: number;
  // for data-descriptor (bit 3) entries the central dir has the real sizes;
  // local header sizes may be 0. We always trust the central directory.
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  if (eocd + 22 > buf.length || eocd + 22 + buf.readUInt16LE(eocd + 20) !== buf.length) {
    throw new ZipExtractError("EOCD length mismatch");
  }
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) throw new ZipExtractError("multi-disk ZIP unsupported");
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipExtractError("ZIP64 unsupported");
  const cdEnd = cdOffset + cdSize;
  if (cdEnd !== eocd || cdEnd > buf.length) throw new ZipExtractError("central-directory bounds mismatch");
  const entries: CentralEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) {
      throw new ZipExtractError(`corrupt central directory at entry ${i}`);
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const fnLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const extAttrs = buf.readUInt32LE(off + 38);
    const localOffset = buf.readUInt32LE(off + 42);
    const entryEnd = off + 46 + fnLen + extraLen + commentLen;
    if (entryEnd > cdEnd) throw new ZipExtractError(`central entry ${i} exceeds bounds`);
    const name = buf.slice(off + 46, off + 46 + fnLen).toString("utf8");
    entries.push({
      flags, method, crc, compressedSize: compSize, uncompressedSize: uncompSize,
      name, isSymlink: (extAttrs >>> 16 & 0xf000) === S_IFLNK, localOffset,
    });
    off = entryEnd;
  }
  if (off !== cdEnd) throw new ZipExtractError("central-directory size mismatch");
  return entries;
}

// Locate the compressed data for an entry by reading its local header's
// filename + extra-field lengths (sizes in the local header may be 0 if the
// data-descriptor flag is set; the central directory is authoritative).
function localDataOffset(buf: Buffer, e: CentralEntry, cdOffset: number): number {
  if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== SIG_LOCAL) {
    throw new ZipExtractError(`corrupt local header for ${e.name}`);
  }
  // Local header layout: sig(0-3) ver(4-5) flags(6-7) method(8-9) mtime(10-11)
  // mdate(12-13) crc(14-17) compSize(18-21) uncompSize(22-25) fnLen(26-27)
  // extraLen(28-29) name+extra+data. (Filename length is at offset 26, NOT 22.)
  const fnLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const localNameEnd = e.localOffset + 30 + fnLen;
  const dataStart = localNameEnd + extraLen;
  if (dataStart + e.compressedSize > cdOffset || dataStart + e.compressedSize > buf.length) {
    throw new ZipExtractError(`compressed data exceeds bounds for ${e.name}`);
  }
  const localName = buf.subarray(e.localOffset + 30, localNameEnd).toString("utf8");
  const localFlags = buf.readUInt16LE(e.localOffset + 6);
  const localMethod = buf.readUInt16LE(e.localOffset + 8);
  if (localName !== e.name || localFlags !== e.flags || localMethod !== e.method) {
    throw new ZipExtractError(`local/central header mismatch for ${e.name}`);
  }
  if ((e.flags & 1) !== 0) throw new ZipExtractError(`encrypted entry rejected: ${e.name}`);
  if ((e.flags & 8) === 0) {
    if (buf.readUInt32LE(e.localOffset + 14) !== e.crc
      || buf.readUInt32LE(e.localOffset + 18) !== e.compressedSize
      || buf.readUInt32LE(e.localOffset + 22) !== e.uncompressedSize) {
      throw new ZipExtractError(`local/central size or CRC mismatch for ${e.name}`);
    }
  }
  return dataStart;
}

function safeJoin(destDir: string, name: string): string {
  if (!name) throw new ZipExtractError("empty entry name");
  if (/^[A-Za-z]:[\\/]/.test(name) || name.startsWith("/")) {
    throw new ZipExtractError(`absolute path in entry: ${name}`);
  }
  const segments = name.split(/[\\/]/);
  if (segments.some((s) => s === "..")) {
    throw new ZipExtractError(`traversal in entry: ${name}`);
  }
  const resolved = path.resolve(destDir, ...segments);
  const base = path.resolve(destDir) + path.sep;
  if (resolved !== path.resolve(destDir) && !resolved.startsWith(base)) {
    throw new ZipExtractError(`entry escapes destDir: ${name}`);
  }
  return resolved;
}

export function extractZip(artifactPath: string, destDir: string, bounds?: ExtractBounds): void {
  const b = { ...DEFAULT_BOUNDS, ...bounds };
  const buf = statSync(artifactPath).isFile() ? readFileSync(artifactPath) : null;
  if (!buf) throw new ZipExtractError(`not a file: ${artifactPath}`);
  mkdirSync(destDir, { recursive: true });
  let totalUncomp = 0;
  try {
    const entries = readCentralDirectory(buf);
    const cdOffset = buf.readUInt32LE(findEocd(buf) + 16);
    if (entries.length > b.maxEntries) {
      throw new ZipExtractError(`too many entries: ${entries.length} > ${b.maxEntries}`);
    }
    const seenTargets = new Set<string>();
    for (const e of entries) {
      if (e.isSymlink) throw new ZipExtractError(`symlink entry rejected: ${e.name}`);
      if (e.method !== 0 && e.method !== 8) {
        throw new ZipExtractError(`unsupported compression method ${e.method} for ${e.name}`);
      }
      if (e.uncompressedSize > b.maxFileUncompressed) {
        throw new ZipExtractError(`file too large: ${e.name} ${e.uncompressedSize} > ${b.maxFileUncompressed}`);
      }
      totalUncomp += e.uncompressedSize;
      if (totalUncomp > b.maxTotalUncompressed) {
        throw new ZipExtractError(`total uncompressed exceeds limit: ${totalUncomp} > ${b.maxTotalUncompressed}`);
      }
      if (e.compressedSize === 0 && e.uncompressedSize > 0) throw new ZipExtractError(`invalid zero compressed size: ${e.name}`);
      if (e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > b.maxRatio) {
        throw new ZipExtractError(`zip-bomb ratio: ${e.name} ${e.uncompressedSize}/${e.compressedSize}`);
      }
      const target = safeJoin(destDir, e.name);
      const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
      if (seenTargets.has(targetKey)) throw new ZipExtractError(`duplicate target path: ${e.name}`);
      seenTargets.add(targetKey);
      const isDir = e.name.endsWith("/");
      const dataStart = localDataOffset(buf, e, cdOffset);
      const comp = buf.subarray(dataStart, dataStart + e.compressedSize);
      const raw = e.method === 0 ? comp : inflateRawSync(comp);
      if (raw.length !== e.uncompressedSize) {
        throw new ZipExtractError(`size mismatch: ${e.name} got ${raw.length} expected ${e.uncompressedSize}`);
      }
      if ((crc32(raw) >>> 0) !== e.crc) throw new ZipExtractError(`CRC mismatch: ${e.name}`);
      if (isDir) {
        if (raw.length !== 0) throw new ZipExtractError(`directory entry has data: ${e.name}`);
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, raw);
    }
  } catch (err) {
    // Failure cleanup: remove any partial extraction so the next run can't
    // mistake a half-extracted tree for a complete import.
    try { rmSync(destDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

/**
 * Compute the Hub's content-tree fingerprint of an extracted package dir.
 *
 * R5b-2 (VERIFIED against upstream `SkillQueryService.computeFingerprint` +
 * live `global/agentguard@1.1`): sort all files by relative POSIX path,
 * for each emit `<relPosixPath>:<bareHexSha256>\n`, then return
 * `sha256:<hex>` of the concatenated lines. This is the CONTENT fingerprint
 * (over the original package files), NOT the ZIP-archive hash — so it is the
 * correct value to compare against the `resolve` `data.fingerprint` for
 * download integrity (deny-wins on mismatch).
 *
 * Used by the sync bridge's prod extractFn after bounded-safe extraction +
 * before repackage, to verify the downloaded archive's content matches the
 * Hub-published fingerprint (tamper/corruption check beyond ZIP structural
 * integrity).
 */
export function computeContentFingerprint(dir: string): string {
  const files: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  }
  walk(dir);
  files.sort();
  let content = "";
  for (const rel of files) {
    const fileSha = createHash("sha256").update(readFileSync(path.join(dir, ...rel.split("/")))).digest("hex");
    content += `${rel}:${fileSha}\n`;
  }
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}
