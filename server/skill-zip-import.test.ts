// Octop absorption M3a (codex evt_20261021030941-m3a-instruction.md) —
// skill package schema + safe local ZIP import contract tests.
//
// Coverage (instruction §Tests):
//   - legacy {name,type,enabled,path} rows keep loading unchanged, inferred
//     sourceKind "local" in memory only (file never rewritten on read);
//   - valid native skill ZIP → quarantined under the governed skills/ root,
//     registered enabled:false + source metadata + deterministic content hash;
//   - traversal / absolute / symlink / file-count / per-file size / total
//     size / corrupted / no-SKILL.md / multi-skill / malformed slug /
//     duplicate slug rejection (deny-wins);
//   - failed import leaves no partial directory and no registry row;
//   - import does not make the resource visible to any agent (deny-default);
//   - explicit enable still flows through entitlement + activation + resolve
//     guards (activation ∩ entitlement before any mount);
//   - admin-only route gate (org_admin/user denied) + metadata-only audit
//     (no ZIP payload / file content ever reaches governance_audit_log).
//
// Run: npx tsx server/skill-zip-import.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import express from "express";

// ─── Env before imports ──────────────────────────────────────
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "m3a-skill-zip-test-"));
process.chdir(SCRATCH);
process.env.DB_PATH = path.join(SCRATCH, "data", "eaos.db");
process.env.JWT_SECRET = "m3a-skill-zip-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";

const db = (await import("./database.js")).default;
const skillConfig = await import("./skill-config.js");
const { importSkillZip, SkillZipImportError } = await import("./skill-zip-import.js");
const { createAdminSkillImportRoutes } = await import("./admin-skill-import-routes.js");
const { capabilityProvider } = await import("./capability-provider.js");
const { agentCapabilityService } = await import("./agent-capabilities.js");
const { entitlementService } = await import("./entitlement.js");
const { DEFAULT_ORG_ID } = await import("./request-context.js");
import type { RequestContext } from "./request-context.js";
const { zipDir } = await import("./skill-importer/zip-writer.js");

const ORG = DEFAULT_ORG_ID;
const adminCtx: RequestContext = { userId: "m3a-admin", role: "admin", orgId: ORG };
const userCtx: RequestContext = { userId: "m3a-user", role: "user", orgId: ORG };

const SKILLS_ROOT = path.join(SCRATCH, "skills");
const QUARANTINE_ROOT = path.join(SKILLS_ROOT, "quarantine");
const SKILLS_CONFIG = path.join(SCRATCH, "data", "skills.json");

const PAYLOAD_MARKER = "M3A-PAYLOAD-MARKER-7f3ac9";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

function expectReject(name: string, fn: () => unknown, code: string): void {
  let threw = false;
  let gotCode = "";
  try {
    fn();
  } catch (err) {
    threw = true;
    gotCode = err instanceof SkillZipImportError ? err.code : "(not SkillZipImportError)";
  }
  ok(name, threw && gotCode === code, `threw=${threw} code=${gotCode} (want ${code})`);
}

function registryRows(): Array<Record<string, unknown>> {
  if (!fs.existsSync(SKILLS_CONFIG)) return [];
  return JSON.parse(readFileSync(SKILLS_CONFIG, "utf8"));
}

// No residue: quarantine holds exactly the installed slug dirs — no staging-*
// leftovers, no partial slug dir from a rejected import.
function assertQuarantineExact(expectedSlugs: string[]): void {
  const entries = fs.existsSync(QUARANTINE_ROOT)
    ? fs.readdirSync(QUARANTINE_ROOT).filter((e) => !e.startsWith("."))
    : [];
  assert.deepEqual([...entries].sort(), [...expectedSlugs].sort(), `quarantine residue: ${entries.join(",")}`);
}

// ─── Raw (hand-rolled) ZIP builder for hostile archives ───────
// zipDir can only produce well-formed safe zips; traversal/absolute/symlink
// entries need byte-level control over the central directory.

interface RawEntry {
  name: string;
  data?: Buffer;
  /** external attrs = (0o120777 << 16) → S_IFLNK in the mode bits. */
  isSymlink?: boolean;
}

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

function buildRawZip(entries: RawEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(20513, 12); // date 2020-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(20513, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(e.isSymlink ? (0o120777 << 16) >>> 0 : 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ─── Valid package fixture ────────────────────────────────────

function buildValidPackageDir(): string {
  const dir = mkdtempSync(path.join(SCRATCH, "pkg-src-"));
  writeFileSync(path.join(dir, "SKILL.md"), `---
name: demo-skill
---

# Demo skill

${PAYLOAD_MARKER} — used to prove audit rows never carry file payload.
`);
  mkdirSync(path.join(dir, "references"), { recursive: true });
  writeFileSync(path.join(dir, "references", "api.md"), "reference doc\n");
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(path.join(dir, "LICENSE"), "MIT demo license\n");
  return dir;
}

const validZip = zipDir(buildValidPackageDir()).buffer;

// ─── Route harness (x-test-actor fake identity, M2b pattern) ──

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req: express.Request, _res, next) => {
  const who = String(req.headers["x-test-actor"] ?? "");
  if (who === "admin") Object.assign(req, { userId: "m3a-admin", userRole: "admin", orgId: ORG });
  else if (who === "orgAdmin") Object.assign(req, { userId: "m3a-orgadmin", userRole: "org_admin", orgId: ORG });
  else if (who === "userA") Object.assign(req, { userId: "m3a-user", userRole: "user", orgId: ORG });
  next();
});
app.use("/api/admin/skills", createAdminSkillImportRoutes());
const server = app.listen(0);
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function postZip(
  actor: string,
  slug: string | null,
  zip: Buffer | null,
  version?: string
): Promise<{ status: number; body: any }> {
  const q = new URLSearchParams();
  if (slug !== null) q.set("slug", slug);
  if (version !== undefined) q.set("version", version);
  const res = await fetch(`${BASE}/api/admin/skills/import-zip?${q}`, {
    method: "POST",
    headers: { "content-type": "application/zip", "x-test-actor": actor },
    ...(zip !== null ? { body: new Uint8Array(zip) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ─── Section 0: legacy config backward compatibility ──────────

{
  // Legacy row: {name,type,enabled,path} only, on disk — no metadata fields.
  const legacyDir = path.join(SKILLS_ROOT, "legacy-skill");
  mkdirSync(path.join(legacyDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(legacyDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "legacy-skill", version: "1.0.0", description: "legacy" })
  );
  mkdirSync(path.join(legacyDir, "skills", "legacy-skill"), { recursive: true });
  writeFileSync(path.join(legacyDir, "skills", "legacy-skill", "SKILL.md"), `---
name: legacy-skill
---

# Legacy skill
`);
  mkdirSync(path.dirname(SKILLS_CONFIG), { recursive: true });
  const legacyRow = JSON.stringify([{ name: "legacy-skill", type: "plugin", enabled: true, path: "skills/legacy-skill" }], null, 2) + "\n";
  writeFileSync(SKILLS_CONFIG, legacyRow);

  const all = skillConfig.getAllSkills();
  ok("legacy row loads and resolves valid", all.length === 1 && all[0].valid === true && all[0].name === "legacy-skill");
  ok("legacy row infers sourceKind local in memory", all[0].sourceKind === "local");
  ok("legacy row is enabled → injectable pool", skillConfig.getEnabledPlugins().some((s) => s.name === "legacy-skill"));
  ok("legacy on-disk row unchanged after read", readFileSync(SKILLS_CONFIG, "utf8") === legacyRow);
}

// ─── Section 1: valid ZIP → quarantine + disabled + metadata ──

{
  const r = await postZip("admin", "demo-skill", validZip, "2.1.0");
  ok("route import returns 200", r.status === 200, JSON.stringify(r.body));
  const m = r.body.manifest;
  ok("manifest: name/version/enabled/sourceKind/copyPolicy",
    m.name === "demo-skill" && m.version === "2.1.0" && m.enabled === false &&
    m.sourceKind === "zip" && m.copyPolicy === "snapshot");
  ok("manifest: content hash + importedAt",
    typeof m.sha256 === "string" && m.sha256.startsWith("sha256:") && m.sha256.length === 71 &&
    typeof m.importedAt === "string" && !Number.isNaN(Date.parse(m.importedAt)));
  ok("manifest: file list + script flag + license + description",
    Array.isArray(m.files) && m.files.includes("SKILL.md") && m.files.includes("scripts/run.sh") &&
    m.hasScripts === true && m.license === "LICENSE" && typeof m.description === "string" && m.description.length > 0);
  ok("manifest: scripts warning + no validation errors",
    m.warnings.length === 1 && m.warnings[0].includes("scripts") && m.validationErrors.length === 0);
  ok("manifest is secret-free (no payload marker)", !JSON.stringify(m).includes(PAYLOAD_MARKER));

  // Disk: native-plugin shape under the governed skills/ root.
  const qdir = path.join(QUARANTINE_ROOT, "demo-skill");
  const pj = JSON.parse(readFileSync(path.join(qdir, ".claude-plugin", "plugin.json"), "utf8"));
  ok("installed plugin.json synthesized from trusted slug/version",
    pj.name === "demo-skill" && pj.version === "2.1.0");
  ok("skill body preserved under skills/<slug>/",
    fs.existsSync(path.join(qdir, "skills", "demo-skill", "SKILL.md")) &&
    fs.existsSync(path.join(qdir, "skills", "demo-skill", "scripts", "run.sh")) &&
    fs.existsSync(path.join(qdir, "skills", "demo-skill", "LICENSE")));

  // Registry row: enabled:false + full source metadata.
  const row = registryRows().find((e) => e.name === "demo-skill");
  ok("registry row: enabled:false + source metadata",
    !!row && row.enabled === false && row.type === "plugin" && row.path === "skills/quarantine/demo-skill" &&
    row.sourceKind === "zip" && row.sha256 === m.sha256 && row.copyPolicy === "snapshot" && typeof row.importedAt === "string");
  ok("registry row persists server-authoritative hasScripts:true", row?.hasScripts === true);
  ok("registry still holds the untouched legacy row",
    registryRows().some((e) => e.name === "legacy-skill" && e.sourceKind === undefined && e.hasScripts === undefined));

  const resolved = skillConfig.getAllSkills().find((s) => s.name === "demo-skill");
  ok("imported skill resolves valid via the REAL validator", !!resolved && resolved.valid === true && resolved.enabled === false);
  ok("ResolvedSkill exposes server-authoritative hasScripts (API path)", resolved?.hasScripts === true);

  // Import ≠ usable: deny-default — quarantined import is invisible to agents.
  ok("import does NOT make the skill injectable (enabled:false)",
    !skillConfig.getEnabledPlugins().some((s) => s.name === "demo-skill"));
  assertQuarantineExact(["demo-skill"]);
}

// ─── Section 2: rejections (deny-wins, no residue) ────────────

{
  const beforeRows = registryRows().length;

  expectReject("empty payload rejected", () => importSkillZip({ slug: "x-skill", zipBuffer: Buffer.alloc(0) }), "empty_zip");
  expectReject("invalid slug (traversal) rejected", () => importSkillZip({ slug: "../evil", zipBuffer: validZip }), "invalid_slug");
  expectReject("invalid slug (spaces) rejected", () => importSkillZip({ slug: "Demo Skill", zipBuffer: validZip }), "invalid_slug");
  expectReject("invalid slug (empty) rejected", () => importSkillZip({ slug: "", zipBuffer: validZip }), "invalid_slug");
  expectReject("invalid version rejected", () => importSkillZip({ slug: "v-skill", version: "1..2/evil", zipBuffer: validZip }), "invalid_version");
  expectReject("corrupted (not a zip) rejected", () => importSkillZip({ slug: "c-skill", zipBuffer: Buffer.from("definitely not a zip") }), "extract_failed");
  expectReject("traversal entry rejected", () => importSkillZip({ slug: "t-skill", zipBuffer: buildRawZip([{ name: "../evil.txt", data: Buffer.from("x") }]) }), "extract_failed");
  expectReject("absolute-path entry rejected", () => importSkillZip({ slug: "a-skill", zipBuffer: buildRawZip([{ name: "/etc/passwd", data: Buffer.from("x") }]) }), "extract_failed");
  expectReject("symlink entry rejected", () => importSkillZip({ slug: "s-skill", zipBuffer: buildRawZip([{ name: "link", data: Buffer.from("/etc/passwd"), isSymlink: true }]) }), "extract_failed");
  expectReject(
    "file-count bound (2001 entries > 2000) rejected",
    () => importSkillZip({ slug: "n-skill", zipBuffer: buildRawZip(Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from("x") }))) }),
    "extract_failed"
  );
  expectReject(
    "per-file size bound (16MB+1) rejected",
    () => importSkillZip({ slug: "b-skill", zipBuffer: buildRawZip([{ name: "big.bin", data: Buffer.alloc(16 * 1024 * 1024 + 1) }]) }),
    "extract_failed"
  );
  expectReject(
    "total size bound (5×14MB > 64MB) rejected",
    () => importSkillZip({
      slug: "tb-skill",
      zipBuffer: buildRawZip(Array.from({ length: 5 }, (_, i) => ({ name: `big${i}.bin`, data: Buffer.alloc(14 * 1024 * 1024) }))),
    }),
    "extract_failed"
  );
  expectReject("no SKILL.md rejected", () => importSkillZip({ slug: "r-skill", zipBuffer: buildRawZip([{ name: "README.md", data: Buffer.from("not a skill") }]) }), "no_skill");
  expectReject(
    "multi-skill package rejected",
    () => importSkillZip({
      slug: "m-skill",
      zipBuffer: buildRawZip([
        { name: "one/SKILL.md", data: Buffer.from("---\nname: one\n---\n# one\n") },
        { name: "two/SKILL.md", data: Buffer.from("---\nname: two\n---\n# two\n") },
      ]),
    }),
    "multiple_skills"
  );
  expectReject("duplicate slug (registry) rejected", () => importSkillZip({ slug: "demo-skill", zipBuffer: validZip }), "duplicate");
  expectReject("duplicate slug (pre-registered name) rejected", () => importSkillZip({ slug: "legacy-skill", zipBuffer: validZip }), "duplicate");

  // Duplicate install-dir occupancy (no registry row, dir exists).
  mkdirSync(path.join(QUARANTINE_ROOT, "occupied-skill"), { recursive: true });
  expectReject("duplicate slug (quarantine dir occupied) rejected", () => importSkillZip({ slug: "occupied-skill", zipBuffer: validZip }), "duplicate");

  // Failed imports leave no partial directory and no registry row.
  ok("no partial directories survive rejected imports", !fs.existsSync(path.join(QUARANTINE_ROOT, "t-skill")) && !fs.existsSync(path.join(QUARANTINE_ROOT, "m-skill")));
  assertQuarantineExact(["demo-skill", "occupied-skill"]);
  ok("no registry rows added by rejected imports", registryRows().length === beforeRows);
  const tmpLeft = fs.existsSync(SKILLS_CONFIG + ".tmp");
  ok("no .tmp registry file left behind", !tmpLeft);
}

// ─── Section 2b: no-scripts ZIP persists hasScripts:false ──────

{
  // Fix round: server-authoritative flag — a package WITHOUT scripts/ must
  // persist hasScripts:false (not merely omit the field).
  const plainDir = mkdtempSync(path.join(SCRATCH, "pkg-plain-"));
  writeFileSync(path.join(plainDir, "SKILL.md"), `---
name: plain-skill
---

# Plain skill (no scripts)
`);
  const plainZip = zipDir(plainDir).buffer;
  const manifest = importSkillZip({ slug: "plain-skill", zipBuffer: plainZip });
  ok("no-scripts manifest: hasScripts false + no warning",
    manifest.hasScripts === false && manifest.warnings.length === 0);
  const row = registryRows().find((e) => e.name === "plain-skill");
  ok("no-scripts registry row persists hasScripts:false", row?.hasScripts === false);
  const resolved = skillConfig.getAllSkills().find((s) => s.name === "plain-skill");
  ok("no-scripts ResolvedSkill carries hasScripts:false", resolved?.hasScripts === false);
  assertQuarantineExact(["demo-skill", "plain-skill", "occupied-skill"]);
}

// Route-level duplicate → 409 with code.
{
  const r = await postZip("admin", "demo-skill", validZip);
  ok("route duplicate import → 409 + code", r.status === 409 && r.body.code === "duplicate");
}

// ─── Section 3: admin-only gate + metadata-only audit ─────────

{
  const r1 = await postZip("orgAdmin", "gate-skill", validZip);
  ok("org_admin import denied (403)", r1.status === 403);
  const r2 = await postZip("userA", "gate-skill", validZip);
  ok("user import denied (403)", r2.status === 403);
  const r3 = await postZip("admin", "bad slug!", validZip);
  ok("admin bad slug rejected (400 + code)", r3.status === 400 && r3.body.code === "invalid_slug");

  const audits = db.prepare(`SELECT * FROM governance_audit_log WHERE action = 'skill.import'`).all() as Array<Record<string, unknown>>;
  ok("audit rows exist for import attempts", audits.length >= 5, `got ${audits.length}`);
  const denied = audits.filter((a) => a.result === "denied");
  ok("denied audits: org_admin/user gate, metadata-only reason", denied.length >= 2 && denied.every((a) => String(a.reason_summary ?? a.reasonSummary ?? "").includes("admin only")));
  const failures = audits.filter((a) => a.result === "failure");
  ok("failure audits carry categorical code only", failures.length >= 2 && failures.every((a) => /rejected \((invalid_slug|duplicate)\)/.test(String(a.reason_summary ?? a.reasonSummary ?? ""))));
  const success = audits.filter((a) => a.result === "success");
  ok("success audit records quarantine + enabled=false", success.length >= 1 && success.every((a) => String(a.reason_summary ?? a.reasonSummary ?? "").includes("enabled=false")));

  // Metadata-only: no audit row contains any ZIP payload/file content.
  const auditJson = JSON.stringify(audits);
  ok("audit rows never carry file payload", !auditJson.includes(PAYLOAD_MARKER) && !auditJson.includes("# Demo skill"));
  ok("rejected route imports left no residue", !fs.existsSync(path.join(QUARANTINE_ROOT, "gate-skill")) && !fs.existsSync(path.join(QUARANTINE_ROOT, "bad slug!")));
}

// ─── Section 3b: corrupted registry fails closed (fix round) ─

{
  const backup = readFileSync(SKILLS_CONFIG, "utf8");
  const variants: Array<[string, string]> = [
    ["malformed JSON", "{ not valid json !!"],
    ["non-array JSON", JSON.stringify({ entries: [] })],
    ["non-object entry", JSON.stringify(["nope"])],
  ];
  for (const [label, content] of variants) {
    writeFileSync(SKILLS_CONFIG, content);
    expectReject(`registry invalid (${label}) rejected`, () => importSkillZip({ slug: "zz-skill", zipBuffer: validZip }), "registry_invalid");
    ok(`registry bytes unchanged after rejection (${label})`, readFileSync(SKILLS_CONFIG, "utf8") === content);
    ok(`no quarantine install for corrupted registry (${label})`, !fs.existsSync(path.join(QUARANTINE_ROOT, "zz-skill")));
    ok(`no .tmp registry file left (${label})`, !fs.existsSync(SKILLS_CONFIG + ".tmp"));
  }
  assertQuarantineExact(["demo-skill", "plain-skill", "occupied-skill"]);

  // Route-level: corrupted registry → 400 + registry_invalid, no residue.
  writeFileSync(SKILLS_CONFIG, "{ broken");
  const r = await postZip("admin", "route-skill", validZip);
  ok("route import on corrupted registry → 400 + registry_invalid", r.status === 400 && r.body.code === "registry_invalid");
  ok("route import left corrupted registry byte-identical", readFileSync(SKILLS_CONFIG, "utf8") === "{ broken");
  ok("route import on corrupted registry left no residue", !fs.existsSync(path.join(QUARANTINE_ROOT, "route-skill")) && !fs.existsSync(SKILLS_CONFIG + ".tmp"));

  // Restore the real registry for the remaining sections.
  writeFileSync(SKILLS_CONFIG, backup);
}

// ─── Section 4: explicit enable flows through the guards ──────

{
  const AGENT = "agent-m3a-1";
  const USER = "m3a-user";
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', 'user', ?, 'active')`
  ).run(USER, USER, ORG);
  db.prepare(
    `INSERT INTO agents (id, org_id, owner_user_id, name, status, app_id) VALUES (?, ?, ?, ?, 'active', 'default-app')`
  ).run(AGENT, ORG, USER, "m3a agent");

  function resolveBundle() {
    return capabilityProvider.resolve({ userId: USER, chatId: AGENT, role: "user", runtimeType: "docker", orgId: ORG });
  }
  const injected = (b: ReturnType<typeof resolveBundle>): boolean =>
    (b.sdkOptions.plugins ?? []).some((p) => p.path.includes("demo-skill")) &&
    b.mounts.some((m) => m.hostPath.includes(path.join("quarantine", "demo-skill")));

  // Pre-enable: quarantined import invisible to the agent (deny-default).
  ok("pre-enable: agent bundle has no quarantined skill", !injected(resolveBundle()));

  // Global enable (the explicit admin action) — still gated by activation∩entitlement.
  const toggled = skillConfig.setSkillEnabled("demo-skill", true);
  ok("explicit global enable works", !!toggled && toggled.enabled === true);
  ok("enabled skill now in injectable pool", skillConfig.getEnabledPlugins().some((s) => s.name === "demo-skill"));

  // Enabled globally but NO activation/entitlement → still not injected.
  ok("no activation → still not injected (deny-default)", !injected(resolveBundle()));

  // Entitlement + activation → injected (full guard chain passes).
  entitlementService.setEntitlements(adminCtx, "demo-skill", [{ scopeType: "org", scopeId: ORG, effect: "allow" }]);
  agentCapabilityService.updateAgentCapabilities(userCtx, AGENT, { resources: [{ resourceId: "demo-skill", enabled: true }] });
  ok("activation ∩ entitlement → quarantined skill mounted (readonly)", injected(resolveBundle()));

  // Revocation backstop: revoke entitlement → excluded from next bundle.
  entitlementService.setEntitlements(adminCtx, "demo-skill", []);
  ok("entitlement revoked → excluded from next bundle", !injected(resolveBundle()));

  // Restore enabled:false — import success ≠ usable is the resting state.
  skillConfig.setSkillEnabled("demo-skill", false);
  ok("disable restores enabled:false", !skillConfig.getEnabledPlugins().some((s) => s.name === "demo-skill"));
}

// ─── Wrap up ──────────────────────────────────────────────────

server.close();
process.chdir(SCRATCH); // keep scratch cwd for any deferred destructors
fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\nAll ${pass} assertions passed.`);
