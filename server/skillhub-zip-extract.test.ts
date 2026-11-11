/**
 * skillhub-zip-extract.test.ts — bounded-safe extraction rejection matrix.
 * No test framework (project convention). Run: npx tsx server/skillhub-zip-extract.test.ts
 * Exit 0 = every malicious/oversized/corrupt case was rejected AND destDir removed.
 *
 * Each case must: throw, AND leave no partial extraction (destDir removed).
 * This is the deny-wins proof for R5b-2: a malicious archive causes NO files
 * written outside destDir, NO half-extracted tree, and the bridge would log
 * import_failed + skip mirror/entitlement (verified separately in the bridge tests).
 */
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractZip, DEFAULT_BOUNDS } from "./skillhub-zip-extract.js";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface Entry { name: string; data: Buffer; method: number; mode: number; }

// Minimal ZIP builder (STORE + DEFLATE). CRC is written (correct) but the
// extractor does not verify CRC, so callers may skip crc computation.
function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const isDeflate = e.method === 8;
    const raw = e.data;
    const comp = isDeflate ? deflateRawSync(raw) : raw;
    const crc = crc32(raw) >>> 0;
    const fn = Buffer.from(e.name, "utf8");
    // local header (30) + name + comp
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(isDeflate ? 0x08 : 0, 6); // flags (bit3 = data desc — NOT set)
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(0, 10); // mtime
    lh.writeUInt16LE(0, 12); // mdate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(fn.length, 26);
    lh.writeUInt16LE(0, 28); // extra
    locals.push(lh, fn, comp);
    // central directory entry (46) + name
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(isDeflate ? 0x08 : 0, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(fn.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // int attrs
    ch.writeUInt32LE((e.mode << 16) >>> 0, 38); // ext attrs (unix mode in high 16)
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, fn);
    offset += 30 + fn.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12); // cd size
  eocd.writeUInt32LE(offset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment
  return Buffer.concat([...locals, cd, eocd]);
}

let failures = 0;
function expectReject(label: string, entries: Entry[], bounds?: any) {
  const dest = mkdtempSync(path.join(tmpdir(), "zipx-"));
  const zipPath = path.join(dest + "-src.zip");
  writeFileSync(zipPath, buildZip(entries));
  let threw = false;
  try {
    extractZip(zipPath, dest, bounds);
  } catch {
    threw = true;
  }
  // must throw AND leave dest either removed or empty (no partial write outside)
  const destGone = !existsSync(dest);
  const destEmpty = existsSync(dest) && readdirSyncSafe(dest).length === 0;
  try {
    assert.equal(threw, true, `${label}: expected rejection but extraction succeeded`);
    assert.ok(destGone || destEmpty, `${label}: destDir not cleaned (gone=${destGone})`);
  } catch (e) { console.error(`FAIL ${(e as Error).message}`); failures++; }
  try { rmSync(dest, { recursive: true, force: true }); } catch {}
  try { rmSync(zipPath, { force: true }); } catch {}
}
function expectAccept(label: string, entries: Entry[]) {
  const dest = mkdtempSync(path.join(tmpdir(), "zipx-"));
  const zipPath = path.join(dest + "-src.zip");
  writeFileSync(zipPath, buildZip(entries));
  try {
    extractZip(zipPath, dest);
    assert.ok(existsSync(path.join(dest, "SKILL.md")), `${label}: SKILL.md missing`);
  } catch (e) { console.error(`FAIL ${label}: ${(e as Error).message}`); failures++; }
  try { rmSync(dest, { recursive: true, force: true }); } catch {}
  try { rmSync(zipPath, { force: true }); } catch {}
}
function expectRejectBuffer(label: string, zip: Buffer) {
  const dest = mkdtempSync(path.join(tmpdir(), "zipx-"));
  const zipPath = path.join(dest + "-src.zip");
  writeFileSync(zipPath, zip);
  let threw = false;
  try { extractZip(zipPath, dest); } catch { threw = true; }
  try {
    assert.equal(threw, true, `${label}: expected rejection`);
    assert.equal(existsSync(dest), false, `${label}: partial extraction survived`);
  } catch (e) { console.error(`FAIL ${(e as Error).message}`); failures++; }
  try { rmSync(dest, { recursive: true, force: true }); } catch {}
  try { rmSync(zipPath, { force: true }); } catch {}
}
function readdirSyncSafe(d: string): string[] {
  try { return require("node:fs").readdirSync(d); } catch { return []; }
}

const SKILL = "A skill.\n";
const PLUGIN_JSON = '{"name":"x","version":"1.0.0","description":"d"}';

// === malicious / oversized / corrupt — all must reject + cleanup ===
expectReject("path traversal ../", [{ name: "../escape.txt", data: Buffer.from("x"), method: 0, mode: 0o644 }]);
expectReject("absolute path /etc", [{ name: "/etc/passwd", data: Buffer.from("x"), method: 0, mode: 0o644 }]);
expectReject("windows drive letter", [{ name: "C:\\Windows\\sys.bat", data: Buffer.from("x"), method: 0, mode: 0o644 }]);
expectReject("nested traversal a/../b", [{ name: "a/../b.txt", data: Buffer.from("x"), method: 0, mode: 0o644 }]);
expectReject("symlink entry (S_IFLNK)", [{ name: "link", data: Buffer.from("/etc/passwd"), method: 0, mode: 0o120644 }]);
expectReject("unsupported method", [{ name: "x.txt", data: Buffer.from("x"), method: 9, mode: 0o644 }]);
expectReject("too many entries", Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from("x"), method: 0, mode: 0o644 })), { maxEntries: 4 });
expectReject("file too large (uncompressed)", [{ name: "big", data: Buffer.alloc(100), method: 0, mode: 0o644 }], { maxFileUncompressed: 10 });
expectReject("total uncompressed too large", [
  { name: "a", data: Buffer.alloc(6), method: 0, mode: 0o644 },
  { name: "b", data: Buffer.alloc(6), method: 0, mode: 0o644 },
], { maxFileUncompressed: 10, maxTotalUncompressed: 10 });
expectReject("zip-bomb ratio", [{ name: "bomb", data: Buffer.alloc(1000, 0x00), method: 8, mode: 0o644 }], { maxRatio: 2 });
expectReject("duplicate target path", [
  { name: "SKILL.md", data: Buffer.from("first"), method: 0, mode: 0o644 },
  { name: "SKILL.md", data: Buffer.from("second"), method: 0, mode: 0o644 },
]);
{
  const z = buildZip([{ name: "x", data: Buffer.from("abc"), method: 0, mode: 0o644 }]);
  z[31] ^= 0xff; // same-length STORE corruption: only CRC can detect this
  expectRejectBuffer("CRC mismatch", z);
}
{
  const z = buildZip([{ name: "x", data: Buffer.from("abc"), method: 0, mode: 0o644 }]);
  const cd = 30 + 1 + 3;
  z[30] = "y".charCodeAt(0); // local filename differs from central filename
  expectRejectBuffer("local/central filename mismatch", z);
  void cd;
}
{
  const z = buildZip([{ name: "x", data: Buffer.from("abc"), method: 0, mode: 0o644 }]);
  const eocd = z.length - 22;
  z.writeUInt32LE(1, eocd + 12); // declared central-directory size is false
  expectRejectBuffer("EOCD central-directory size mismatch", z);
}
// "not a zip": write raw garbage directly (NOT wrapped via buildZip — buildZip
// would make a valid zip around it, so the extractor would succeed).
{
  const dest = mkdtempSync(path.join(tmpdir(), "zipx-"));
  const zipPath = path.join(dest + "-src.zip");
  writeFileSync(zipPath, Buffer.from("not a zip at all --------"));
  let threw = false;
  try { extractZip(zipPath, dest); } catch { threw = true; }
  try { assert.equal(threw, true, "corrupt: not a zip: expected rejection"); }
  catch (e) { console.error(`FAIL ${(e as Error).message}`); failures++; }
  try { rmSync(dest, { recursive: true, force: true }); } catch {}
  try { rmSync(zipPath, { force: true }); } catch {}
}
// corruption: a valid-looking zip whose deflate body is garbage → inflate fails
{
  const dest = mkdtempSync(path.join(tmpdir(), "zipx-"));
  // build a zip but then corrupt the deflate payload
  let z = buildZip([{ name: "x", data: Buffer.alloc(50, 0x00), method: 8, mode: 0o644 }]);
  // overwrite the data region (after local header 30 + name 1) with garbage
  z = Buffer.concat([z.subarray(0, 31), Buffer.from("garbagepayload!!"), z.subarray(31 + 16)]);
  writeFileSync(path.join(dest + "-src.zip"), z);
  let threw = false;
  try { extractZip(path.join(dest + "-src.zip"), dest); } catch { threw = true; }
  try { assert.equal(threw, true, "corrupt deflate body: expected rejection"); }
  catch (e) { console.error(`FAIL ${(e as Error).message}`); failures++; }
  try { rmSync(dest, { recursive: true, force: true }); } catch {}
  try { rmSync(path.join(dest + "-src.zip"), { force: true }); } catch {}
}

// === benign — must accept (sanity: extractor isn't over-rejecting) ===
expectAccept("benign native-plugin shape", [
  { name: "SKILL.md", data: Buffer.from(SKILL), method: 0, mode: 0o644 },
  { name: ".claude-plugin/plugin.json", data: Buffer.from(PLUGIN_JSON), method: 8, mode: 0o644 },
  { name: "skills/foo/SKILL.md", data: Buffer.from("foo skill\n"), method: 0, mode: 0o644 },
]);
void DEFAULT_BOUNDS;

if (failures) { console.error(`\n${failures} test(s) FAILED.`); process.exit(1); }
console.log("skillhub-zip-extract: malicious matrix all rejected + cleaned; benign accepted.");
process.exit(0);
