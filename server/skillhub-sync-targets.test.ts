// R5a TEAM sync target resolution (mapping-first). Run: npx tsx server/skillhub-sync-targets.test.ts
// Fails until server/skillhub-sync-targets.ts is implemented.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r5c-st-"));
process.env.DB_PATH = path.join(TMP, "st.db");
process.env.ENTITLEMENTS_FILE = path.join(TMP, "ent.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(TMP, "ac.json");
fs.writeFileSync(process.env.ENTITLEMENTS_FILE, JSON.stringify({ entries: [] }));
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE, JSON.stringify({ agents: {} }));

const db = (await import("./database.js")).default;
const { orgService } = await import("./org-service.js");
const { orgNamespaceMappingService } = await import("./org-namespace-mapping.js");
const { resolveTeamSyncTargets } = await import("./skillhub-sync-targets.js");

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`${name}: ${(e as Error).message}`); }
}

orgService.create("org-a", "Org A");
orgService.create("org-b", "Org B");
orgService.create("org-c", "Org C");
orgNamespaceMappingService.upsert("org-a", "team-a");
orgNamespaceMappingService.upsert("org-b", "team-b");

// ─── 1. mapping present → mapping targets win (env ignored) ─────────────
ok("1. mapping-first wins over env", () => {
  const audits: string[] = [];
  const targets = resolveTeamSyncTargets({
    envTargets: [{ namespaceSlug: "team-a", orgId: "org-a" }],
    audit: (a: string) => audits.push(a),
  });
  assert.equal(targets.length, 2, "two active mappings → two targets");
  assert.ok(targets.some((t) => t.namespaceSlug === "team-a" && t.orgId === "org-a"));
  assert.ok(targets.some((t) => t.namespaceSlug === "team-b" && t.orgId === "org-b"));
  // env did not silently override mapping
  assert.ok(!audits.includes("skillhub.sync_target_env_fallback"), "no env fallback audited when mapping present");
});

// ─── 2. env conflicts with mapping → mapping wins, audited (not silent) ─
ok("2. env override ignored + audited", () => {
  const audits: string[] = [];
  const targets = resolveTeamSyncTargets({
    envTargets: [{ namespaceSlug: "team-a", orgId: "org-evil" }],
    audit: (a: string) => audits.push(a),
  });
  const a = targets.find((t) => t.namespaceSlug === "team-a");
  assert.ok(a && a.orgId === "org-a", "mapping org wins; env's org-evil ignored");
  assert.ok(audits.includes("skillhub.sync_target_env_override_ignored"), "env override attempt audited (not silent)");
});

// ─── 3. no mapping for an org → env is the audited emergency fallback ───
ok("3. env fallback when no mapping", () => {
  // org-c has no mapping; env provides a target for it
  const audits: string[] = [];
  const targets = resolveTeamSyncTargets({
    envTargets: [{ namespaceSlug: "team-c", orgId: "org-c" }],
    audit: (a: string) => audits.push(a),
  });
  const c = targets.find((t) => t.orgId === "org-c");
  assert.ok(c && c.namespaceSlug === "team-c", "env target used for org with no mapping (emergency fallback)");
  assert.ok(audits.includes("skillhub.sync_target_env_fallback"), "env fallback audited");
});

// ─── 4. empty mapping + empty env → no targets (no-op sync) ─────────────
ok("4. empty → no targets", () => {
  // delete mappings for org-a/org-b to simulate empty
  db.prepare("DELETE FROM org_namespace_mappings").run();
  const targets = resolveTeamSyncTargets({ envTargets: [], audit: () => {} });
  assert.equal(targets.length, 0, "no mapping + no env → no targets");
});

// ─── 5. frozen mapping excluded from TEAM sync targets ──────────────────
ok("5. frozen excluded", () => {
  orgNamespaceMappingService.upsert("org-a", "team-a");
  orgNamespaceMappingService.upsert("org-b", "team-b");
  orgNamespaceMappingService.setFrozen("org-b", true);
  const targets = resolveTeamSyncTargets({ envTargets: [], audit: () => {} });
  assert.ok(!targets.some((t) => t.orgId === "org-b"), "frozen org's mapping excluded from TEAM sync");
  assert.ok(targets.some((t) => t.orgId === "org-a"), "active mapping still included");
  orgNamespaceMappingService.setFrozen("org-b", false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
