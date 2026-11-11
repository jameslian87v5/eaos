// R5c round-3 migration test: prove the hub_member_sync_tasks schema migration
// is OLD-DB safe — a legacy table (round-1, no desired_* / next_attempt_at
// columns) is upgraded by the idempotent ALTER loop, and the runnable index
// (which references next_attempt_at) is created AFTER the ALTER, so legacy-DB
// startup does not crash with "no such column: next_attempt_at".
// Run: npx tsx server/r5c-migration.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r5c-mig-"));
const DB_PATH = path.join(TMP, "mig.db");
process.env.DB_PATH = DB_PATH;
process.env.ENTITLEMENTS_FILE = path.join(TMP, "ent.json");
process.env.AGENT_CAPABILITIES_FILE = path.join(TMP, "ac.json");
fs.writeFileSync(process.env.ENTITLEMENTS_FILE, JSON.stringify({ entries: [] }));
fs.writeFileSync(process.env.AGENT_CAPABILITIES_FILE, JSON.stringify({ agents: {} }));

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failed++; failures.push(`${name}: ${(e as Error).message}`); }
}

// ── 1. Build a LEGACY hub_member_sync_tasks table (round-1 schema: no
//    desired_role/desired_status/source_namespace_slug/next_attempt_at), and
//    insert a legacy row. Done with a raw better-sqlite3 handle BEFORE
//    importing database.js so the legacy table pre-exists the migrations.
const raw = new Database(DB_PATH);
raw.exec(`CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'active')`);
raw.exec(`CREATE TABLE IF NOT EXISTS hub_member_sync_tasks (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  namespace_slug TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
raw.prepare(`INSERT INTO hub_member_sync_tasks (id, idempotency_key, org_id, namespace_slug, user_id, event, target_version, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
  .run("t1", "k1", "org-a", "ns-a", "u1", "user_create", 1);
raw.close();

// ── 2. Import database.js — triggers the idempotent ALTER loop + the
//    post-ALTER runnable index creation. This MUST NOT crash on the legacy DB
//    (the round-2 bug: CREATE INDEX ... (next_attempt_at) ran inside the
//    initial exec BEFORE the ALTER added the column).
const db = (await import("./database.js")).default;
void db; // referenced below via a fresh query handle

// ── 3. The new columns + runnable index now exist on the legacy table.
ok("3. legacy table upgraded — new columns + runnable index present", () => {
  const cols = db.prepare(`PRAGMA table_info(hub_member_sync_tasks)`).all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.ok(names.includes("desired_role"), "desired_role added");
  assert.ok(names.includes("desired_status"), "desired_status added");
  assert.ok(names.includes("source_namespace_slug"), "source_namespace_slug added");
  assert.ok(names.includes("next_attempt_at"), "next_attempt_at added");
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_hub_member_sync_runnable'`).get() as { name: string } | undefined;
  assert.ok(idx && idx.name === "idx_hub_member_sync_runnable", "runnable index created AFTER the ALTER (legacy-DB safe)");
});

// ── 4. The pre-existing legacy row is intact + queryable with the new columns.
ok("4. legacy row intact + new columns readable (nullable)", () => {
  const row = db.prepare(`SELECT id, state, next_attempt_at AS nextAttemptAt, desired_role AS desiredRole FROM hub_member_sync_tasks WHERE id = ?`).get("t1") as any;
  assert.equal(row.id, "t1", "legacy row preserved");
  assert.equal(row.state, "pending", "legacy state preserved");
  assert.equal(row.nextAttemptAt, null, "next_attempt_at nullable on legacy row");
  assert.equal(row.desiredRole, null, "desired_role nullable on legacy row");
});

// ── 5. A new row can be inserted with the full desired-state + backoff columns.
ok("5. new row insertable with desired-state + next_attempt_at", () => {
  db.prepare(`INSERT INTO hub_member_sync_tasks (id, idempotency_key, org_id, namespace_slug, user_id, event, target_version, desired_role, desired_status, source_namespace_slug, next_attempt_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run("t2", "k2", "org-a", "ns-a", "u2", "org_move", 2, "org_admin", "active", "ns-old", null);
  const row = db.prepare(`SELECT desired_role AS desiredRole, source_namespace_slug AS sourceNamespaceSlug FROM hub_member_sync_tasks WHERE id = ?`).get("t2") as any;
  assert.equal(row.desiredRole, "org_admin");
  assert.equal(row.sourceNamespaceSlug, "ns-old");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.error(failures.join("\n")); process.exit(1); }
