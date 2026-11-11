import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "eaos.db");

// Ensure data directory exists
import fs from "fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Identity rename (chatapp.db → eaos.db): when running under the DEFAULT path,
// adopt a pre-rename database in place so existing installs keep their data.
// Explicit DB_PATH values are honored as-is (no rename).
if (!process.env.DB_PATH) {
  const legacyPath = path.join(__dirname, "..", "data", "chatapp.db");
  if (!fs.existsSync(DB_PATH) && fs.existsSync(legacyPath)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = legacyPath + suffix;
      if (fs.existsSync(from)) fs.renameSync(from, DB_PATH + suffix);
    }
    console.log("[DB] Migrated legacy data/chatapp.db → data/eaos.db");
  }
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create tables
db.exec(`
  -- Phase 7 (multi-tenancy): the organization (tenant) table. Every user/chat
  -- belongs to exactly one org; RequestContext.orgId flows from users.org_id
  -- (set at login) into the JWT, so orgId never comes from request params/body.
  -- 'default-org' stays the id (not renamed to test_org) to keep blast radius
  -- minimal in 7.1; it models the single existing tenant.
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'org_admin', 'user')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'anonymous',
    title TEXT NOT NULL DEFAULT 'New Chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- M5: workspace file registry. Lives in the canonical schema file so every
  -- service (quota-service, file-workspace-service) sees the table at module
  -- load regardless of import order. Input + output both tracked here — this
  -- is the per-file source of truth for storage quota.
  CREATE TABLE IF NOT EXISTS workspace_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('input', 'output')),
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_files_chat ON workspace_files(user_id, chat_id);
  -- M5 legacy dedupe: the pre-M5 schema allowed duplicate (chat_id, kind,
  -- filename) rows (an overwrite just appended a new row). Before adding the
  -- UNIQUE index below, collapse any existing duplicates to one row per key
  -- (keep the most-recently-inserted by max rowid). Without this, a deployed
  -- DB that contains an overwrite would abort startup with
  -- SQLITE_CONSTRAINT_UNIQUE when the UNIQUE index is created.
  DELETE FROM workspace_files
  WHERE rowid NOT IN (
    SELECT max_rowid FROM (
      SELECT MAX(rowid) AS max_rowid
      FROM workspace_files
      GROUP BY chat_id, kind, filename
    )
  );
  -- M5: one row per (chat, kind, filename) so an overwrite replaces the size
  -- (quota delta = new - old) instead of accumulating a duplicate. Without
  -- this, re-uploading the same path would double-count the bytes.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_files_chat_kind_name
    ON workspace_files(chat_id, kind, filename);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool_use')),
    content TEXT NOT NULL DEFAULT '',
    tool_name TEXT,
    tool_input TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    claude_session_id TEXT,
    runtime_type TEXT NOT NULL DEFAULT 'local',
    container_id TEXT,
    workspace_volume TEXT,
    status TEXT NOT NULL DEFAULT 'stopped',
    restore_mode TEXT NOT NULL DEFAULT 'fresh',
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
  );

  -- Agent OS M3: one fixed-size run metadata row per user-message execution.
  -- A "run" = one sendMessage → one result (a single Agent execution turn),
  -- DISTINCT from the long-lived agent_sessions.id. Links agent_events by
  -- run_id (events carry the run_id they belong to). Audit-volume boundary:
  -- this row is fixed-size + one per run; stream chunks / message bodies /
  -- Tool input-output / duplicated payloads are NEVER stored here (those live
  -- only in the redacted agent_events, and the run detail returns a bounded
  -- paginated event summary, not raw payloads). No subject/AppKey/Token.
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    principal_type TEXT NOT NULL DEFAULT 'user' CHECK(principal_type IN ('user','app_principal')),
    org_id TEXT NOT NULL DEFAULT 'default-org',
    app_id TEXT NOT NULL DEFAULT 'default-app',
    chat_id TEXT NOT NULL,
    config_version TEXT,
    capability_ids TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed','tool_rejected','stopped')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    usage_json TEXT,
    FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(agent_session_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_chat ON agent_runs(chat_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);


  -- Phase 5: canonical Agent identity table (same-id bridge: agents.id == chats.id).
  -- 1:1 with chats by convention; no hard FK between them to avoid a circular
  -- dependency at migration time. The invariant is enforced by chatStore
  -- create/delete + the boot backfill below + AgentService.ensureAgentRow.
  -- chats continues to serve as the (single) conversation/message container
  -- until multi-conversation-per-Agent becomes a real requirement (deferred).
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL DEFAULT 'default-org',
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 5 (MP5d): reusable Agent Profiles (prompt templates). Multiple Agents
  -- share one profile via agents.profile_id. resolve() precedence: per-Agent
  -- override > profile > platform default. profile_id has no hard FK so a deleted
  -- profile degrades gracefully (treated as no profile) rather than failing.
  CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL DEFAULT 'default-org',
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    append_system_prompt TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 6 (Application Layer): an "application" is a first-class preset the
  -- platform drives agents from — { profile (prompt template) + capability
  -- allowlist + data space + entry + credential }. Apps are NOT independent
  -- software; the platform is the engine, an app is "how this engine runs".
  -- Headless: apps bring their own frontend and call app-scoped APIs with a
  -- dual identity (app key = application principal, user JWT = operator).
  -- See docs/02-architecture/platform-application-layer-architecture.md.
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL DEFAULT 'default-org',
    name TEXT NOT NULL,
    description TEXT,
    profile_id TEXT,              -- -> agent_profiles.id (NULL = platform default prompt)
    entry_url TEXT,               -- app frontend entrypoint (informational)
    api_key_prefix TEXT,          -- non-secret key prefix for id lookup (e.g. first chars)
    api_key_hash TEXT,            -- hash-at-rest of the full app key (sha256)
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    last_used_at TEXT,            -- updated on each authenticated app call (audit)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Phase 6: per-app capability allowlist (UPPER BOUND). Effective agent
  -- capability set = app allowlist ∩ user/org entitlement ∩ agent activation
  -- (deny-by-intersection, never replace-by-precedence). No hard FK to
  -- capability_resources so a removed resource degrades gracefully.
  CREATE TABLE IF NOT EXISTS application_capabilities (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,    -- -> capability_resources.id
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(app_id, resource_id)
  );

  -- P0.1 (Agent OS §4 — application user execution-identity decoupling):
  -- internal app-principal registry. principalId widens the domain of existing
  -- user_id/owner_user_id/Map keys; no existing column changes type/semantics.
  -- subject is opaque; org_id comes only from the verified app key's org.
  CREATE TABLE IF NOT EXISTS app_principals (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    org_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(app_id, subject)
  );
  CREATE INDEX IF NOT EXISTS idx_app_principals_app ON app_principals(app_id);
  CREATE INDEX IF NOT EXISTS idx_app_principals_org ON app_principals(org_id);

  -- Agent OS M2: application access grants gate which platform principals
  -- (org / platform user) may enter an Application via the AppKey+platform-JWT
  -- path. Deny by default; only 'org' and 'user' grant types. No roles,
  -- groups, inheritance, or business-permission fields. App-principal
  -- (Runtime Token) access is authorized by the signed token and does NOT
  -- create a row here. See docs/开发计划/agent-os-overall-plan.md §6.
  CREATE TABLE IF NOT EXISTS application_access_grants (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK(principal_type IN ('org','user')),
    principal_id TEXT NOT NULL,    -- org_id for 'org', platform user_id for 'user'
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
    granted_by TEXT NOT NULL,      -- actor user id (audit)
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(app_id, principal_type, principal_id)
  );
  CREATE INDEX IF NOT EXISTS idx_app_access_grants_app ON application_access_grants(app_id);
  CREATE INDEX IF NOT EXISTS idx_app_access_grants_lookup ON application_access_grants(app_id, principal_type, principal_id);

  CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);
  CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_agent_profiles_org ON agent_profiles(org_id);
  CREATE INDEX IF NOT EXISTS idx_applications_org ON applications(org_id);
  CREATE INDEX IF NOT EXISTS idx_application_capabilities_app ON application_capabilities(app_id);

  -- DEPRECATED: Phase 6 (A2) webhook envelope model, superseded by Route A
  -- (hook-as-plugin). Table retained for existing DB compatibility; no new writes.
  -- See docs/02-architecture/platform-application-layer-architecture.md (A2 Route A).
  CREATE TABLE IF NOT EXISTS application_hooks (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('PreToolUse', 'PostToolUse')),
    matcher TEXT,                  -- tool name pattern (glob, NULL = match all)
    handler_type TEXT NOT NULL DEFAULT 'webhook' CHECK(handler_type IN ('webhook')),
    handler_url TEXT NOT NULL,     -- webhook endpoint to call
    timeout_ms INTEGER NOT NULL DEFAULT 5000,
    allowed_response_fields TEXT,  -- JSON array: which response fields the app may set
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_application_hooks_app ON application_hooks(app_id);
  CREATE INDEX IF NOT EXISTS idx_application_hooks_active ON application_hooks(app_id, status) WHERE status = 'active';

  -- Phase 6 (A3): registered internal HTTP APIs. Admin registers an internal API
  -- → capability-installer generates a stdio-wrapper MCP package under mcp/<name>/
  -- → appears in resource pool → app selects via allowlist → agent calls via MCP.
  -- See docs/开发计划/application-layer-dev-plan.md §8 (A3).
  CREATE TABLE IF NOT EXISTS registered_apis (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL DEFAULT 'default-org',
    name TEXT NOT NULL,              -- e.g. "GET_CUSTOMER_ERPID" (also MCP package name)
    display_name TEXT,               -- 中文名
    description TEXT,
    api_url TEXT NOT NULL,           -- e.g. http://ds-cmn.chit-dev/ds/GET_CUSTOMER_ERPID/1
    method TEXT NOT NULL DEFAULT 'GET' CHECK(method IN ('GET', 'POST')),
    request_params_schema TEXT,      -- JSON: parameter descriptions (inputSchema for MCP tool)
    response_mapping TEXT,           -- JSON: {code,msg,data,total} field mapping
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_registered_apis_org ON registered_apis(org_id);
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(chat_id, timestamp);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_chat ON agent_sessions(user_id, chat_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(agent_session_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_agent_events_chat ON agent_events(chat_id);
  -- Stage 1 (token management): monthly per-org token aggregation joins
  -- agent_events(result) -> chats -> users.org_id. Partial index narrows to
  -- result rows (the only ones carrying usage) + a created_at range filter.
  CREATE INDEX IF NOT EXISTS idx_agent_events_result_created ON agent_events(created_at) WHERE event_type = 'result';

  -- M1 (org governance): per-org governance quota row. Created at provision time
  -- with platform defaults; M1 only WRITES the row (no enforcement). Quota
  -- enforcement + admin query UI land in M5. NULL = "use platform default".
  -- Token budget columns (Stage 1 token management): max_tokens_monthly is the
  -- per-org monthly token ceiling (sum of input+output+cacheCreation+cacheRead
  -- across result events); token_alert_threshold_pct is the % at which the
  -- console shows "临近" and a metadata-only audit is written on crossing.
  CREATE TABLE IF NOT EXISTS org_quotas (
    org_id TEXT PRIMARY KEY,
    max_agents INTEGER,
    max_concurrent_runtimes INTEGER,
    max_storage_mb INTEGER,
    max_turns_per_runtime INTEGER,
    max_tokens_monthly INTEGER,
    token_alert_threshold_pct INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
  );

  -- M1 (org governance): governance audit log. Records lifecycle + access
  -- decisions for enterprise admins. METADATA ONLY — this table MUST NOT store
  -- passwords, tokens, secrets, chat body, file body, or external API payloads;
  -- reason_summary is a short categorical reason, never raw sensitive content.
  -- Query/export UI is M5; M1 only writes provisioning/status/last-admin events.
  CREATE TABLE IF NOT EXISTS governance_audit_log (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    actor_role TEXT,
    org_id TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT,
    object_id TEXT,
    from_org_id TEXT,
    to_org_id TEXT,
    result TEXT NOT NULL DEFAULT 'success' CHECK(result IN ('success', 'failure', 'denied')),
    reason_summary TEXT,
    request_id TEXT,
    trace_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_governance_audit_org ON governance_audit_log(org_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_governance_audit_action ON governance_audit_log(action, created_at);

  -- R5c: persistent org → TEAM-namespace mapping (铁律: each active org ↔ one
  -- TEAM namespace; persistent, NOT name-derived temp). Drives R5a TEAM sync
  -- target resolution (mapping-first; env is audited emergency fallback only).
  -- status mirrors the org lifecycle: 'active' normally, 'frozen' when the org
  -- is suspended (TEAM sync + member sync paused while frozen).
  CREATE TABLE IF NOT EXISTS org_namespace_mappings (
    org_id TEXT PRIMARY KEY,
    namespace_slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','frozen')),
    last_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_org_ns_mapping_ns ON org_namespace_mappings(namespace_slug);

  -- R5c: Hub member-sync task state machine. Desired-state generation model:
  -- the idempotency_key is a deterministic composite of
  -- (org_id, user_id, event, target_version) where target_version is the
  -- user's monotonic token_version AT ENQUEUE time. EXACT duplicate delivery
  -- (the same mutation delivered twice) shares the key → dedupes (INSERT OR
  -- IGNORE). A LATER legitimate mutation (2nd role change, suspend after a
  -- reactivate cycle) bumps token_version → a new key → a NEW task enqueues.
  -- This is the corrected model: UNIQUE(org_id,user_id,event) would have
  -- permanently suppressed legitimate repeats; it is deliberately NOT used.
  -- The runner processes pending tasks FIFO; Hub member ops are idempotent
  -- (add/remove/set-role), so older-then-newer application converges to the
  -- latest desired state. State machine: pending → succeeded | exhausted
  -- (finite retry); admin can query + replay exhausted tasks.
  -- last_error is a SHORT categorical reason only (metadata-only — NEVER the
  -- raw Hub response body / error message / token, per the no-leakage 铁律).
  CREATE TABLE IF NOT EXISTS hub_member_sync_tasks (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL,
    namespace_slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('user_create','role_change','org_move','user_suspend','user_restore')),
    target_version INTEGER NOT NULL,
    desired_role TEXT,
    desired_status TEXT,
    source_namespace_slug TEXT,
    next_attempt_at TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','succeeded','exhausted')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_hub_member_sync_state ON hub_member_sync_tasks(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_hub_member_sync_user ON hub_member_sync_tasks(org_id, user_id, created_at);

  -- M1 (model management, docs/开发计划/model-and-token-management-plan.md §6.3):
  -- the platform Model Catalog. Shared pool (NO org_id — mirrors the skills/MCP
  -- resource-pool 铁律); org visibility is the entitlement overlay below.
  -- Provider credentials NEVER live here — they stay in server env/Secret Store;
  -- this table carries only provider NAME for display/routing hints.
  CREATE TABLE IF NOT EXISTS model_catalog (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'default',
    model_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    context_window_tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- M1: org → model entitlement overlay. Absent row = NOT authorized
  -- (deny-default, same semantics as the capability entitlement layer).
  CREATE TABLE IF NOT EXISTS org_model_entitlements (
    org_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (org_id, model_id),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (model_id) REFERENCES model_catalog(id) ON DELETE CASCADE
  );

  -- M1: org model policy — org default model. context_limit / compact_threshold
  -- are M4 (deliberately NOT added now — no speculative columns). Deleting a
  -- catalog model nulls org defaults via FK (disable must cascade in service
  -- code: a disabled model cannot remain any org's default — plan §10).
  CREATE TABLE IF NOT EXISTS org_model_policy (
    org_id TEXT PRIMARY KEY,
    default_model_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (default_model_id) REFERENCES model_catalog(id) ON DELETE SET NULL
  );

  -- M4 (plan §4.3): org Auto Compact overlay. Absent row = platform default
  -- (runtime-settings.json contextCompaction). Org numerics are re-clamped on
  -- read against the CURRENT platform config (组织值受平台上限约束) — a stored
  -- org value above a lowered platform cap can never become effective. enabled
  -- is narrow-only: an org row may turn OFF platform-on compaction, never ON.
  CREATE TABLE IF NOT EXISTS org_compact_policy (
    org_id TEXT PRIMARY KEY,
    enabled INTEGER,
    threshold_tokens INTEGER,
    keep_recent_turns INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
  );

  -- Octop absorption M1a (ACTIVE—Octop优势吸收整体计划.md §3-M1): connector
  -- instances = shared platform pool (NO org_id — org visibility is the
  -- entitlement overlay, M2). Catalog entries are code-defined and immutable
  -- (server/connector-store.ts CONNECTOR_CATALOG), so kind is validated in
  -- service code, not by FK. status lifecycle: draft → ready → enabled;
  -- disabled enterable from ready/enabled (enable requires credentials).
  -- credentials_ciphertext = AES-256-GCM, base64(iv|tag|ct) of the JSON field
  -- map; the AES key lives in platform_secrets (never returned by any API).
  -- config_version bumps on credential/config change — M1b binds the
  -- internal-mcp capability token to it (stale config ⇒ no connector).
  CREATE TABLE IF NOT EXISTS connector_instances (
    id TEXT PRIMARY KEY,
    catalog_kind TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','enabled','disabled')),
    base_url TEXT NOT NULL,
    credentials_ciphertext TEXT,
    credentials_key_version INTEGER NOT NULL DEFAULT 1,
    config_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_connector_instances_kind ON connector_instances(catalog_kind, status);

  -- Octop absorption M1a: host-side secret material (connector credential
  -- AES key). Values are base64 random bytes; never exposed via API. Adding a
  -- key = new row with a distinct name; rotation re-encrypts in service code.
  CREATE TABLE IF NOT EXISTS platform_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// R5c round-2/3: desired-state columns + persisted backoff eligibility for the
// member-sync tasks (role/status/source namespace + next_attempt_at). Added via
// ALTER for existing databases (CREATE IF NOT EXISTS above only applies to
// fresh DBs). Idempotent: each ALTER is wrapped in try/catch.
for (const col of ["desired_role", "desired_status", "source_namespace_slug", "next_attempt_at"] as const) {
  try { db.exec(`ALTER TABLE hub_member_sync_tasks ADD COLUMN ${col} TEXT`); } catch { /* column exists */ }
}
// The runnable index references next_attempt_at — created AFTER the ALTER
// migrations so legacy DBs (where the column is added by ALTER) have it.
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_member_sync_runnable ON hub_member_sync_tasks(state, next_attempt_at)`);
} catch { /* index create failed (column missing) — non-fatal */ }

// Migration: add user_id column if not exists (for existing databases)
try {
  db.exec(`ALTER TABLE chats ADD COLUMN user_id TEXT NOT NULL DEFAULT 'anonymous'`);
} catch {
  // Column already exists
}

// Phase 7 (multi-tenancy): tenant columns on the data-plane ownership roots.
// Existing rows backfill to 'default-org' via NOT NULL DEFAULT. org_id is the
// trusted tenant key carried in RequestContext; it is never taken from request
// params/body — it originates from users.org_id at login and is baked into the
// JWT claim. messages/agent_sessions/agent_events inherit org via the chat
// ownership chain (verifyChatOwnership), so no column is added on them in 7.1.
try {
  db.exec(`ALTER TABLE users ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default-org'`);
} catch {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE chats ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default-org'`);
} catch {
  // Column already exists
}

// Phase 7: seed the default tenant row (idempotent). 'default-org' is the only
// tenant in 7.1; all existing users/chats belong to it. Real tenants land in 7.2.
db.exec(`
  INSERT OR IGNORE INTO organizations (id, name) VALUES ('default-org', '默认组织');
`);

// M1 (org governance): organizations.status lifecycle. ALTER-added (idempotent)
// so existing DBs backfill to 'active' via the NOT NULL DEFAULT — the single
// pre-existing tenant (default-org) and any 7.2-created orgs are active. CHECK
// is intentionally NOT on the ALTER (SQLite ADD COLUMN restricts CHECK); the
// four legal values {provisioning,active,suspended,archived} are enforced in
// the app layer (server/org-governance.ts ORG_STATUSES). Transitions:
//   provisioning → active  (provision txn success)
//   active ↔ suspended     (admin)
//   archived               (reserved; no entry point in M1)
//   any other jump         → rejected
try {
  db.exec(`ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  console.log("[DB] M1: added organizations.status lifecycle column");
} catch {
  // Column already exists
}

// M1: seed the default-org quota row (idempotent) so the bootstrap tenant has a
// governance quota record like any provisioned org. Defaults = NULL (use
// platform default); M5 fills in real numbers + enforcement.
db.exec(`
  INSERT OR IGNORE INTO org_quotas (org_id) VALUES ('default-org');
`);

// M2b (Octop absorption, Feishu docs OAuth connector): additive columns on
// connector_instances. oauth_ciphertext = AES-256-GCM encrypted user-token
// blob (access/refresh/expiresAt) — never plaintext, never in any API
// response. oauth_status / oauth_expires_at = secret-free authorization
// bookkeeping (the view surface). Additive so the status CHECK constraint on
// existing rows is untouched — the contract-first lifecycle (draft →
// app_configured → pending_authorization → authorized → enabled/disabled) maps
// onto status ('draft'→'ready'→'enabled'/'disabled') + oauth_status.
try {
  db.exec(`ALTER TABLE connector_instances ADD COLUMN oauth_ciphertext TEXT`);
  db.exec(`ALTER TABLE connector_instances ADD COLUMN oauth_status TEXT`);
  db.exec(`ALTER TABLE connector_instances ADD COLUMN oauth_expires_at TEXT`);
  console.log("[DB] M2b: added connector_instances OAuth columns");
} catch {
  // Columns already exist
}

// M2 (model selection, plan §4.1): nullable per-chat / per-agent model override.
// Stores the model ALIAS (not catalog row id) so a deleted catalog row degrades
// gracefully (override falls through the precedence chain) instead of dangling.
// Validation lives in model-catalog.ts at WRITE time (platform-enabled ∧
// org-entitled) and again at READ time (read-path fail-safe).
for (const table of ["chats", "agents"] as const) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN model_override TEXT`);
    console.log(`[DB] M2: added ${table}.model_override column`);
  } catch {
    // Column already exists
  }
}

// M6 (简化模型接入 / Anthropic-only, plan §6.2 minimal): richer model
// definition fields on model_catalog. All nullable — existing rows (incl. the
// runtime-settings seed) backfill to NULL and behave as before. baseUrl is
// DIRECTORY METADATA ONLY (req 5): the runtime still uses the single deployed
// ANTHROPIC_BASE_URL; this column never drives an outbound endpoint. apiKeyEnv
// stores the ENV-VAR NAME (never a plaintext key — req 3 forbids it).
for (const [col, type] of [
  ["base_url", "TEXT"],
  ["protocol", "TEXT"],
  ["api_key_env", "TEXT"],
  ["supports_tool_call", "INTEGER"],
  ["supports_images", "INTEGER"],
  ["supports_reasoning", "INTEGER"],
  ["max_input_tokens", "INTEGER"],
  ["max_output_tokens", "INTEGER"],
] as const) {
  try {
    db.exec(`ALTER TABLE model_catalog ADD COLUMN ${col} ${type}`);
    console.log(`[DB] M6: added model_catalog.${col} column`);
  } catch {
    // Column already exists
  }
}

// Phase 7: org-scoped indexes. Created AFTER the ALTERs so they resolve the
// column on both fresh DBs (column in CREATE) and legacy DBs (column via ALTER).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_chats_org ON chats(org_id);
  CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
`);

// P0-1 (brand-launch): force first-login password change. 1 = user must change
// their password before doing anything else (the seeded default admin), 0 = the
// password is user-chosen/already-changed. ALTER-added (incremental) so existing
// users default 0 — they are not the seeded admin and are treated as provisioned.
try {
  db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
} catch {
  // Column already exists
}

// M2 (user lifecycle): users.status + users.token_version. ALTER-added
// (idempotent) so existing DBs backfill — status='active', token_version=1.
// CHECK is intentionally NOT on the ALTER (SQLite ADD COLUMN restricts CHECK);
// the two legal values {active, disabled} are enforced in the app layer
// (server/auth.ts USER_STATUSES). token_version is the "or equivalent minimal
// mechanism" for JWT invalidation: login bakes the current value into the JWT;
// disable / reset / migrate bump it, so any old JWT fails the version check at
// the next protected entry (authMiddleware + WS connect). Existing users
// backfill to 1, which matches the tokenVersion absent-claim default for
// pre-M2 JWTs, so a logging-in user gets a fresh v1 token and old sessions
// are not spuriously invalidated.
try {
  db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  console.log("[DB] M2: added users.status lifecycle column");
} catch {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`);
  console.log("[DB] M2: added users.token_version column");
} catch {
  // Column already exists
}

// Phase 7.2: relax users.role CHECK to the three-tier model (admin | org_admin |
// user). SQLite cannot ALTER a CHECK in place, so on legacy DBs (created with the
// two-tier CHECK) rebuild the table once. Guarded by sqlite_master introspection:
// a no-op on fresh DBs (the CREATE TABLE above already includes 'org_admin') and
// idempotent (after the rebuild the sql text contains 'org_admin'). No inbound FKs
// reference users, so the rebuild is safe.
try {
  const usersSqlRow = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`)
    .get() as { sql: string } | undefined;
  const usersSql = usersSqlRow?.sql ?? "";
  if (usersSql && !usersSql.includes("org_admin")) {
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'org_admin', 'user')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        org_id TEXT NOT NULL DEFAULT 'default-org',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        token_version INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO users_new (id, username, password_hash, display_name, role, created_at, org_id, must_change_password)
        SELECT id, username, password_hash, display_name, role, created_at, org_id, must_change_password FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
    `);
    console.log("[DB] Phase 7.2: relaxed users.role CHECK to include 'org_admin'");
  }
} catch (e) {
  console.error("[DB] Phase 7.2 users.role CHECK migration failed:", e);
}

// Migration: add container lifecycle columns to agent_sessions
const lifecycleCols = [
  ["container_name", "TEXT"],
  ["host_port", "INTEGER"],
  ["last_activity_at", "TEXT"],
  ["restart_count", "INTEGER NOT NULL DEFAULT 0"],
  ["image_digest", "TEXT"],
  ["claude_home_volume", "TEXT"],
  ["last_error", "TEXT"],
  ["cleanup_reason", "TEXT"],
] as const;
for (const [col, type] of lifecycleCols) {
  try {
    db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${col} ${type}`);
  } catch {
    // Column already exists
  }
}

// Phase 5 (MP5b): per-Agent prompt override columns. NULL → platform default
// (data/prompt-settings.json); non-NULL → replaces it in CapabilityProvider.resolve().
// ALTER-added (incremental, like the lifecycle cols) so existing agents rows default NULL.
for (const col of ["system_prompt", "append_system_prompt"] as const) {
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT`);
  } catch {
    // Column already exists
  }
}

// Phase 6: per-Application prompt override columns. NULL → falls through to
// profile → platform default in CapabilityProvider.resolve().
// ALTER-added (incremental) so existing applications rows default NULL.
for (const col of ["system_prompt", "append_system_prompt"] as const) {
  try {
    db.exec(`ALTER TABLE applications ADD COLUMN ${col} TEXT`);
  } catch {
    // Column already exists
  }
}

// Built-in tools config: per-profile tool set override (JSON or NULL = inherit default).
try {
  db.exec(`ALTER TABLE agent_profiles ADD COLUMN tools_config TEXT`);
} catch {
  // Column already exists
}

// Built-in tools config: per-app tool allowlist upper bound (JSON or NULL = passthrough).
try {
  db.exec(`ALTER TABLE applications ADD COLUMN tool_allowlist TEXT`);
} catch {
  // Column already exists
}

// Phase 5 (MP5d): agents.profile_id -> agent_profiles.id. Nullable; no hard FK so
// a deleted profile degrades to "no profile" in resolve() instead of erroring.
try {
  db.exec(`ALTER TABLE agents ADD COLUMN profile_id TEXT`);
} catch {
  // Column already exists
}

// Stage 1 (token management): per-org monthly token budget + alert threshold.
// ALTER-added (incremental, like the lifecycle cols) so existing org_quotas rows
// default NULL ("use platform default"). NULL = not configured, not unlimited.
for (const [col, type] of [
  ["max_tokens_monthly", "INTEGER"],
  ["token_alert_threshold_pct", "INTEGER"],
] as const) {
  try {
    db.exec(`ALTER TABLE org_quotas ADD COLUMN ${col} ${type}`);
  } catch {
    // Column already exists
  }
}

// Phase 6 (Application Layer): agents.app_id -> applications.id. Canonical app
// ownership lives on agents (the product-semantic layer), NOT mirrored to chats,
// so the Phase 5 same-id bridge (agents.id == chats.id) stays a pure identity
// invariant. NOT NULL DEFAULT 'default-app': existing rows get the default at
// ALTER time, new rows inherit it, so a row NEVER carries NULL app_id — stronger
// than "normalize on read" (Codex: no NULL long-tail → no legacy branch in every
// query/auth check). The default-app models the chat workbench as a first-class app.
try {
  db.exec(`ALTER TABLE agents ADD COLUMN app_id TEXT NOT NULL DEFAULT 'default-app'`);
} catch {
  // Column already exists
}

// M6a (Octop absorption): expert-builder starter metadata on agents — the
// template the Agent was created from, its persisted welcome message and quick
// prompts (JSON array of {title, prompt}). Nullable; absent = a plain Agent
// created via the legacy /api/chats path (no starter). Minimal column
// extension, ALTER-added like the columns above so old DBs keep working.
for (const [col, type] of [
  ["template_id", "TEXT"],
  ["welcome_message", "TEXT"],
  ["quick_prompts", "TEXT"],
] as const) {
  try {
    db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${type}`);
    console.log(`[DB] M6a: added agents.${col} column`);
  } catch {
    // Column already exists
  }
}

// M6a fix round: create-idempotency ledger. A client-supplied request id maps
// to the ONE agent it created (same owner only) so retries and concurrent
// duplicate POSTs replay the same agent instead of minting duplicates. The row
// is written in the SAME transaction as the agent; one row per successful
// create (same growth rate as agents itself).
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_builder_requests (
    request_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Phase 6 backfill: ensure the built-in `default-app` row exists (every agent's
// app_id defaults to it). Idempotent via INSERT OR IGNORE. Safe on every boot.
db.exec(`
  INSERT OR IGNORE INTO applications (id, org_id, name, description, profile_id, status)
  VALUES ('default-app', 'default-org', '通用应用',
          '内置默认应用：现有 chat 工作台（平台自带参考前端），走用户 JWT 鉴权、无 app key',
          NULL, 'active');
`);

// Minimal copilot model: built-in `copilot` app. Each user has ONE fixed copilot
// agent (app_id='copilot'); reset restarts that SAME agent's conversation while
// preserving its workspace + .claude volumes (no new agent, no brain keying).
// Idempotent via INSERT OR IGNORE. Safe on every boot.
db.exec(`
  INSERT OR IGNORE INTO applications (id, org_id, name, description, profile_id, status)
  VALUES ('copilot', 'default-org', 'Copilot',
          '内置默认 Copilot 应用：每用户一个固定 agent，重置仅重开对话、保留工作区与记忆',
          NULL, 'active');
`);

// Phase 5 backfill: for every chats row, ensure a matching agents row exists with
// the SAME id (same-id bridge). Idempotent via OR IGNORE + NOT IN — safe on every
// boot. Backfilled agents carry no per-Agent prompt (NULL) so behavior stays
// identical to the platform default until MP5b/owner sets one.
db.exec(`
  INSERT OR IGNORE INTO agents (id, org_id, owner_user_id, name, description, status, created_at, updated_at)
  SELECT id, org_id, user_id, title, NULL, 'active', created_at, updated_at
  FROM chats
  WHERE id NOT IN (SELECT id FROM agents)
`);

// Agent OS M3: link existing agent_events to a run via run_id (nullable —
// events outside a user-message turn, and legacy rows, stay NULL). Adds only
// the relation; the bounded run detail returns a redacted, paginated event
// summary, never raw payloads. Idempotent.
try {
  db.exec(`ALTER TABLE agent_events ADD COLUMN run_id TEXT`);
} catch {
  // Column already exists
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id) WHERE run_id IS NOT NULL`);

export default db;
