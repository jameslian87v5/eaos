/**
 * zip-writer.ts — store-only ZIP writer for the Skill Importer.
 *
 * Why hand-rolled (no `archiver`/`jszip` dep): the directive says "优先最少
 * 文件和既有依赖". We WRITE only our own trusted skill-package zips (never
 * parse untrusted zips — that's `skillhub-zip-extract.ts`), so a store-only
 * writer is small and safe. Store (method 0) = no compression; the Hub
 * accepts standard zips regardless of method.
 *
 * Output layout: entries are RELATIVE to the input dir (top-level SKILL.md at
 * the zip root) — matches the Hub skill-package shape (forensics §5b: top-level
 * SKILL.md + assets, NOT a nested native-plugin layout).
 *
 * Bounded: max file count, max per-file bytes, max total bytes; rejects path
 * traversal / absolute paths; no symlinks (lstat isSymbolicLink → skip+flag).
 * Throw on any bound breach → caller discards the partial buffer (never uploads
 * a truncated skill).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface ZipWriteBounds {
  maxFiles?: number; // default 500
  maxFileBytes?: number; // default 20 * 1024 * 1024 (20 MiB)
  maxTotalBytes?: number; // default 50 * 1024 * 1024 (50 MiB)
}

const DEFAULT_BOUNDS: Required<ZipWriteBounds> = {
  maxFiles: 500,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

// CRC32 (IEEE 802.3 polynomial) — standard zip CRC.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n >>> 0;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS timestamp (1980 epoch). Clamp pre-1980 to 1980-01-01.
function dosTime(d: Date): { time: number; date: number } {
  const t = d.getTime() < 315532800000 ? new Date(315532800000) : d;
  return {
    time: ((t.getHours() & 0x1f) << 11) | ((t.getMinutes() & 0x3f) << 5) | ((t.getSeconds() >> 1) & 0x1f),
    date: (((t.getFullYear() - 1980) & 0x7f) << 9) | (((t.getMonth() + 1) & 0xf) << 5) | (t.getDate() & 0x1f),
  };
}

interface Entry {
  name: string;
  data: Buffer;
  crc: number;
  time: number;
  date: number;
}

export interface ZipWriteResult {
  buffer: Buffer;
  fileCount: number;
  totalUncompressed: number;
}

/**
 * Walk `dir` and produce a store-only ZIP buffer with entries relative to
 * `dir`. Rejects traversal/absolute/symlink; enforces bounds. Throws on any
 * violation (caller must discard partial output).
 */
export function zipDir(dir: string, bounds?: ZipWriteBounds): ZipWriteResult {
  const b = { ...DEFAULT_BOUNDS, ...bounds };
  const entries: Entry[] = [];
  const stack: string[] = [dir];
  let total = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(cur);
    } catch (e) {
      throw new Error(`zip: cannot read dir ${cur}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const name of names) {
      const full = path.join(cur, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue; // unreadable entry — skip, don't fail the whole zip
      }
      if (st.isSymbolicLink()) {
        throw new Error(`zip: symlink not allowed: ${path.relative(dir, full)}`);
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue; // skip sockets/fifos/devices
      const rel = path.relative(dir, full);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`zip: path escapes root: ${rel}`);
      }
      if (entries.length + 1 > b.maxFiles) {
        throw new Error(`zip: exceeds maxFiles ${b.maxFiles} at ${rel}`);
      }
      if (st.size > b.maxFileBytes) {
        throw new Error(`zip: file exceeds maxFileBytes ${b.maxFileBytes}: ${rel} (${st.size})`);
      }
      const data = fs.readFileSync(full);
      total += data.length;
      if (total > b.maxTotalBytes) {
        throw new Error(`zip: exceeds maxTotalBytes ${b.maxTotalBytes} at ${rel}`);
      }
      const { time, date } = dosTime(st.mtime);
      entries.push({ name: rel.replace(/\\/g, "/"), data, crc: crc32(data), time, date });
    }
  }
  return buildZip(entries);
}

function buildZip(entries: Entry[]): ZipWriteResult {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let total = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    // Local file header (30 bytes) + name + data
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed (2.0)
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(0, 8); // method = store
    lh.writeUInt16LE(e.time, 10);
    lh.writeUInt16LE(e.date, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.data.length, 18); // compressed (== uncompressed for store)
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra
    const localHeader = Buffer.concat([lh, nameBuf]);
    chunks.push(localHeader, e.data);
    // Central directory record (46 bytes) + name
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(e.time, 12);
    cd.writeUInt16LE(e.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameBuf]));
    offset += localHeader.length + e.data.length;
    total += e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD start
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  chunks.push(cdBuf, eocd);
  return { buffer: Buffer.concat(chunks), fileCount: entries.length, totalUncompressed: total };
}

/** sha256 of a buffer — for tests/logging (never the Hub fingerprint contract). */
export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
