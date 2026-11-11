// R5c org→namespace persistent mapping. Run: npx tsx server/org-namespace-mapping.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r5c-map-"));
process.env.DB_PATH = path.join(TMP, "map.db");
process.env.ENTITLEMENTS_FILE = path.join(TMP, "ent.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(TMP, "ac.json");
fs.writeFileSync(process.env.ENTITLEMENTS_FILE, JSON.stringify({ entries: [] }));
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE, JSON.stringify({ agents: {} }));

const db = (await import("./database.js")).default;
const { orgService } = await import("./org-service.js");
const { orgNamespaceMappingService } = await import("./org-namespace-mapping.js");

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`${name}: ${(e as Error).message}`); }
}

orgService.create("org-a", "Org A");
orgService.create("org-b", "Org B");

// ─── 1. persistence: upsert + read back (not name-derived temp) ─────────
ok("1. upsert persists; read back", () => {
  const m = orgNamespaceMappingService.upsert("org-a", "team-a");
  assert.equal(m.orgId, "org-a");
  assert.equal(m.namespaceSlug, "team-a");
  assert.equal(m.status, "active");
  const got = orgNamespaceMappingService.getForOrg("org-a");
  assert.ok(got, "mapping persisted (survives across reads, not temp-derived)");
});

// ─── 2. idempotent re-upsert (same org+ns) does not duplicate ───────────
ok("2. idempotent re-upsert", () => {
  orgNamespaceMappingService.upsert("org-a", "team-a");
  orgNamespaceMappingService.upsert("org-a", "team-a");
  const all = orgNamespaceMappingService.listActive();
  const aMappings = all.filter((m) => m.orgId === "org-a");
  assert.equal(aMappings.length, 1, "re-upsert same org+ns does not duplicate");
});

// ─── 3. 1:1 铁律: namespace collision across orgs rejected ───────────────
ok("3. namespace collision rejected (1:1)", () => {
  orgNamespaceMappingService.upsert("org-b", "team-b");
  assert.throws(
    () => orgNamespaceMappingService.upsert("org-b", "team-a"),
    /already mapped/,
    "a namespace owned by another org cannot be claimed (1:1)"
  );
});

// ─── 4. cross-org: getForNamespace returns the owning org (deny check) ──
ok("4. cross-org ownership lookup", () => {
  const owner = orgNamespaceMappingService.getForNamespace("team-a");
  assert.ok(owner && owner.orgId === "org-a", "namespace owner is org-a, not org-b");
  const noOwner = orgNamespaceMappingService.getForNamespace("team-zzz");
  assert.equal(noOwner, undefined, "unmapped namespace has no owner");
});

// ─── 5. freeze/unfreeze mirrors org suspend/activate ────────────────────
ok("5. freeze/unfreeze idempotent", () => {
  orgNamespaceMappingService.setFrozen("org-a", true);
  assert.equal(orgNamespaceMappingService.getForOrg("org-a")!.status, "frozen");
  orgNamespaceMappingService.setFrozen("org-a", true); // idempotent
  assert.equal(orgNamespaceMappingService.getForOrg("org-a")!.status, "frozen");
  orgNamespaceMappingService.setFrozen("org-a", false);
  assert.equal(orgNamespaceMappingService.getForOrg("org-a")!.status, "active");
});

// ─── 6. listActive excludes frozen (R5a TEAM sync targets) ───────────────
ok("6. listActive excludes frozen", () => {
  orgNamespaceMappingService.setFrozen("org-b", true);
  const active = orgNamespaceMappingService.listActive();
  const bActive = active.filter((m) => m.orgId === "org-b");
  assert.equal(bActive.length, 0, "frozen mapping not in active TEAM sync targets");
  orgNamespaceMappingService.setFrozen("org-b", false);
});

// ─── 7. invalid namespace slug rejected ──────────────────────────────────
ok("7. invalid slug rejected", () => {
  assert.throws(() => orgNamespaceMappingService.upsert("org-a", "Bad Slug"), /Invalid namespace slug/);
  assert.throws(() => orgNamespaceMappingService.upsert("org-a", "../escape"), /Invalid namespace slug/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
