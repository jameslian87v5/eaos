/**
 * connector-store.ts — Octop absorption M1a
 * (docs/开发计划/ACTIVE—Octop优势吸收整体计划.md §3-M1, codex evt_20261020041142 M1a).
 *
 * Control-plane persistence for connector instances + host-side credential
 * isolation. Mirrors the frozen shared-pool + entitlement pattern:
 *   - CONNECTOR_CATALOG = code-defined, IMMUTABLE platform catalog (no DB rows
 *     to drift; adding a connector kind = a code change + review). Precedent:
 *     provider-connectors.ts hardcoded whitelist.
 *   - connector_instances = shared platform pool (no org_id; org visibility is
 *     the M2 entitlement overlay). Writes are ADMIN-ONLY at the route layer.
 *
 * Credential isolation contract (M1a):
 *   - External-service credentials are encrypted with AES-256-GCM before
 *     touching the DB; the key lives in platform_secrets (host-side only).
 *   - API responses NEVER contain plaintext, ciphertext, or decryptable
 *     material — instance views expose only `credentialsPresent: boolean`.
 *   - `decryptCredentialsForHost()` is the ONLY decryption exit; it exists for
 *     the M1b host-side internal MCP call path and is never serialized.
 *
 * State machine (codex M1a contract): draft → ready → enabled; disabled may be
 * entered from ready/enabled. draft→ready happens on credential write. Enable
 * requires credentialsPresent (draft cannot enable). Deletion is out of M1
 * scope. Enabling only makes an instance ELIGIBLE — no agent visibility is
 * granted anywhere in this module (that is M2 resolve() + entitlement).
 *
 * Audits are metadata-only (writeGovernanceAudit): field NAMES on credential
 * writes, never values.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import db from "./database.js";
import { revokeConnectorTokensForConnector } from "./connector-capability-token.js";

// ─── Catalog (immutable, code-defined) ─────────────────────────

export type ConnectorAuthKind = "api_key" | "oauth2";
export type ConnectorMcpMode = "internal";

export interface ConnectorCredentialField {
  name: string;
  label: string;
  required: boolean;
}

export interface ConnectorCatalogEntry {
  kind: string;
  displayName: string;
  description: string;
  authKind: ConnectorAuthKind;
  mcpMode: ConnectorMcpMode;
  credentialFields: ConnectorCredentialField[];
  /** Tool names the internal MCP may expose for this kind (M1b allowedTools). */
  allowedTools: string[];
  /** Host-side URL policy; full SSRF/redirect guard lands in M1b. */
  baseUrlPolicy: { schemes: string[]; note: string };
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    kind: "internal-rest",
    displayName: "通用内部 REST API",
    description:
      "受治理的通用 REST 连接器：管理员固定 base URL 与凭证（host 侧），agent 经 internal MCP 受限调用，凭证永不进容器。",
    authKind: "api_key",
    mcpMode: "internal",
    credentialFields: [
      { name: "apiToken", label: "API Token（host 侧作为 Authorization 头使用）", required: true },
    ],
    allowedTools: ["rest_request"],
    baseUrlPolicy: {
      schemes: ["http", "https"],
      note: "M1a 仅做 scheme/host 基础校验；SSRF/地址守卫在 M1b internal MCP 调用时逐次执行。",
    },
  },
  {
    kind: "feishu-docs",
    displayName: "飞书文档",
    description:
      "飞书文档 OAuth 连接器（M2b）：管理员写入 App ID/Secret，经 OAuth 授权后 agent 只能通过 search_docs / get_doc 检索与读取飞书文档；用户 token 只在 host 侧加密存储与使用，永不进容器。",
    authKind: "oauth2",
    mcpMode: "internal",
    credentialFields: [
      { name: "clientId", label: "App ID（client_id）", required: true },
      { name: "clientSecret", label: "App Secret（client_secret）", required: true },
    ],
    allowedTools: ["search_docs", "get_doc"],
    baseUrlPolicy: {
      schemes: ["https"],
      note: "飞书固定端点（authorize/token/api 均为 host 侧固定 HTTPS allowlist，实例不携带 baseUrl；CONNECTOR_FEISHU_BASE_URL 仅用于测试替身）。",
    },
  },
] as const;

export function getCatalogEntry(kind: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((c) => c.kind === kind);
}

// ─── Instance views (secret-free) ──────────────────────────────

export type ConnectorInstanceStatus = "draft" | "ready" | "enabled" | "disabled";

/** M2b: OAuth authorization state for oauth2-kind instances (secret-free view).
 * Contract-first lifecycle: draft → app_configured (ready) →
 * pending_authorization → authorized → enabled/disabled. The status column
 * keeps its M1 values; authorization progress lives here. */
export type ConnectorAuthorizationStatus =
  | "none"
  | "pending_authorization"
  | "authorized"
  | "expired"
  | "failed";

export interface ConnectorAuthorizationView {
  status: ConnectorAuthorizationStatus;
  /** ISO timestamp when the access token expires (null while not authorized). */
  expiresAt: string | null;
}

export interface ConnectorInstanceView {
  id: string;
  catalogKind: string;
  name: string;
  status: ConnectorInstanceStatus;
  baseUrl: string;
  credentialsPresent: boolean;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Present only for oauth2-kind instances. */
  authorization?: ConnectorAuthorizationView;
}

interface InstanceRow {
  id: string;
  catalog_kind: string;
  name: string;
  status: ConnectorInstanceStatus;
  base_url: string;
  credentials_ciphertext: string | null;
  credentials_key_version: number;
  config_version: number;
  created_at: string;
  updated_at: string;
  oauth_ciphertext: string | null;
  oauth_status: string | null;
  oauth_expires_at: string | null;
}

function authorizationView(row: InstanceRow): ConnectorAuthorizationView | undefined {
  const entry = getCatalogEntry(row.catalog_kind);
  if (!entry || entry.authKind !== "oauth2") return undefined;
  if (row.oauth_status === "pending_authorization") {
    return { status: "pending_authorization", expiresAt: row.oauth_expires_at };
  }
  if (row.oauth_status === "authorized") {
    const expired = row.oauth_expires_at !== null && new Date(row.oauth_expires_at).getTime() <= Date.now();
    return { status: expired ? "expired" : "authorized", expiresAt: row.oauth_expires_at };
  }
  if (row.oauth_status === "failed") {
    return { status: "failed", expiresAt: null };
  }
  return { status: "none", expiresAt: null };
}

function toView(row: InstanceRow): ConnectorInstanceView {
  return {
    id: row.id,
    catalogKind: row.catalog_kind,
    name: row.name,
    status: row.status,
    baseUrl: row.base_url,
    credentialsPresent: row.credentials_ciphertext !== null,
    configVersion: row.config_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(authorizationView(row) ? { authorization: authorizationView(row) } : {}),
  };
}

// ─── Credential encryption (AES-256-GCM, key in platform_secrets) ──

const SECRET_KEY_NAME = "connector_credentials_aes_key";

let cachedKey: Buffer | null = null;

function getConnectorSecretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const row = db.prepare("SELECT value FROM platform_secrets WHERE name = ?").get(SECRET_KEY_NAME) as
    | { value: string }
    | undefined;
  if (row) {
    cachedKey = Buffer.from(row.value, "base64");
    return cachedKey;
  }
  const key = randomBytes(32);
  db.prepare("INSERT INTO platform_secrets (name, value) VALUES (?, ?)").run(
    SECRET_KEY_NAME,
    key.toString("base64")
  );
  cachedKey = key;
  return key;
}

export function encryptCredentials(values: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getConnectorSecretKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(values), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join("|");
}

export function decryptCredentials(payload: string): Record<string, string> {
  const [ivB64, tagB64, ctB64] = payload.split("|");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("corrupt credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", getConnectorSecretKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

/** M1b exit point: host-side internal MCP call path. Never serialize its result. */
export function decryptCredentialsForHost(instanceId: string): Record<string, string> | null {
  const row = getRow(instanceId);
  if (!row || !row.credentials_ciphertext) return null;
  return decryptCredentials(row.credentials_ciphertext);
}

// ─── Statements ────────────────────────────────────────────────

const stmts = {
  insert: db.prepare(
    `INSERT INTO connector_instances (id, catalog_kind, name, status, base_url)
     VALUES (?, ?, ?, 'draft', ?)`
  ),
  getById: db.prepare("SELECT * FROM connector_instances WHERE id = ?"),
  list: db.prepare("SELECT * FROM connector_instances ORDER BY created_at DESC, id"),
  writeCredentials: db.prepare(
    `UPDATE connector_instances
     SET credentials_ciphertext = ?, credentials_key_version = 1,
         status = CASE WHEN status = 'draft' THEN 'ready' ELSE status END,
         config_version = config_version + 1,
         updated_at = datetime('now')
     WHERE id = ?`
  ),
  setStatus: db.prepare(
    `UPDATE connector_instances SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  // M2b: OAuth bookkeeping. Token refresh does NOT bump config_version (a
  // still-valid capability token keeps authority; the host-side access token
  // is re-read per call). App-credential writes DO bump (existing statement).
  setOAuthPending: db.prepare(
    `UPDATE connector_instances
     SET oauth_status = 'pending_authorization', updated_at = datetime('now')
     WHERE id = ?`
  ),
  writeOAuth: db.prepare(
    `UPDATE connector_instances
     SET oauth_ciphertext = ?, oauth_status = 'authorized', oauth_expires_at = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ),
  markOAuthFailed: db.prepare(
    `UPDATE connector_instances
     SET oauth_status = 'failed', updated_at = datetime('now')
     WHERE id = ?`
  ),
  clearOAuth: db.prepare(
    `UPDATE connector_instances
     SET oauth_ciphertext = NULL, oauth_status = NULL, oauth_expires_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ),
};

function getRow(id: string): InstanceRow | undefined {
  return stmts.getById.get(id) as InstanceRow | undefined;
}

function requireRow(id: string): InstanceRow {
  const row = getRow(id);
  if (!row) throw new ConnectorNotFoundError(`connector instance not found: ${id}`);
  return row;
}

export class ConnectorNotFoundError extends Error {}

// ─── Validation ────────────────────────────────────────────────

function validateBaseUrl(raw: string, entry: ConnectorCatalogEntry): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("baseUrl 不是合法 URL");
  }
  if (!entry.baseUrlPolicy.schemes.includes(url.protocol.replace(":", ""))) {
    throw new Error(`baseUrl scheme 必须是 ${entry.baseUrlPolicy.schemes.join("/")}`);
  }
  if (!url.hostname) throw new Error("baseUrl 缺少 hostname");
  if (url.username || url.password) throw new Error("baseUrl 不得携带 userinfo");
  if (url.hash) throw new Error("baseUrl 不得携带 fragment");
  return url;
}

function validateCredentialValues(
  values: Record<string, string>,
  entry: ConnectorCatalogEntry
): void {
  const known = new Set(entry.credentialFields.map((f) => f.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`未知凭证字段: ${key}`);
  }
  for (const field of entry.credentialFields) {
    if (field.required && !values[field.name]) {
      throw new Error(`缺少必填凭证字段: ${field.name}`);
    }
  }
}

// ─── Service API ───────────────────────────────────────────────

export function listCatalog(): ConnectorCatalogEntry[] {
  return [...CONNECTOR_CATALOG];
}

export function listInstances(): ConnectorInstanceView[] {
  return (stmts.list.all() as InstanceRow[]).map(toView);
}

export interface CreateConnectorInstanceInput {
  catalogKind: string;
  name: string;
  /** Required for api_key kinds; oauth2 kinds use fixed endpoints (omitted). */
  baseUrl?: string;
}

export function createInstance(input: CreateConnectorInstanceInput): ConnectorInstanceView {
  const entry = getCatalogEntry(input.catalogKind);
  if (!entry) throw new Error(`未知 connector kind: ${input.catalogKind}`);
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("name 不能为空");
  if (name.length > 120) throw new Error("name 过长（≤120）");
  // M2b: oauth2 kinds use FIXED host-side endpoints — the caller cannot set a
  // base URL (the stored value is empty; endpoints resolve per call).
  const storedBaseUrl =
    entry.authKind === "oauth2" ? "" : validateBaseUrl(input.baseUrl ?? "", entry).toString();
  const id = randomUUID();
  try {
    stmts.insert.run(id, entry.kind, name, storedBaseUrl);
  } catch (err: any) {
    if (String(err?.message ?? "").includes("UNIQUE")) {
      throw new Error(`同名实例已存在: ${name}`);
    }
    throw err;
  }
  return toView(requireRow(id));
}

/**
 * Write-only credential update. Values are validated against the catalog
 * field list, encrypted, and persisted; the response view never echoes them.
 * draft→ready on first write; ready/disabled/enabled keep their status
 * (rotation on a live instance is allowed — M1b revalidates per call).
 */
export function writeCredentials(
  id: string,
  values: Record<string, string>
): { view: ConnectorInstanceView; fieldNames: string[] } {
  const row = requireRow(id);
  const entry = getCatalogEntry(row.catalog_kind);
  if (!entry) throw new Error(`实例引用未知 catalog kind: ${row.catalog_kind}`);
  validateCredentialValues(values ?? {}, entry);
  const ciphertext = encryptCredentials(values);
  // Fix round #3: for oauth2 kinds the app credential IS the OAuth client —
  // rotating it must invalidate the user authorization bound to the old
  // client IN THE SAME SQLite transaction (a crash between two separate
  // statements could otherwise leave a new credential paired with the old
  // client's OAuth token blob). The config_version bump also kills stale
  // capability tokens.
  if (entry.authKind === "oauth2") {
    db.transaction(() => {
      stmts.writeCredentials.run(ciphertext, id);
      stmts.clearOAuth.run(id);
    })();
  } else {
    stmts.writeCredentials.run(ciphertext, id);
  }
  return { view: toView(requireRow(id)), fieldNames: Object.keys(values) };
}

export function enableInstance(id: string): ConnectorInstanceView {
  const row = requireRow(id);
  if (row.status === "draft") {
    throw new Error("draft 实例不能启用：先写入凭证（draft→ready）");
  }
  if (row.status === "enabled") throw new Error("实例已处于 enabled");
  if (!row.credentials_ciphertext) {
    throw new Error("缺少凭证，不能启用");
  }
  // M2b: oauth2 kinds may only enable while AUTHORIZED (and not expired).
  const entry = getCatalogEntry(row.catalog_kind);
  if (entry?.authKind === "oauth2") {
    const auth = authorizationView(row);
    if (!auth || auth.status === "none") {
      throw new Error("OAuth 实例未授权，不能启用：先完成用户授权（authorized）");
    }
    if (auth.status !== "authorized") {
      throw new Error(`OAuth 授权状态 ${auth.status}，不能启用：需重新授权`);
    }
  }
  stmts.setStatus.run("enabled", id);
  return toView(requireRow(id));
}

export function disableInstance(id: string): ConnectorInstanceView {
  const row = requireRow(id);
  if (row.status === "draft") throw new Error("draft 实例无启用状态可停用");
  if (row.status === "disabled") throw new Error("实例已处于 disabled");
  // M1b: disable is IMMEDIATE revocation — every internal-mcp capability token
  // for this instance dies now, not at expiry. (Credential rotation does NOT
  // revoke: config_version bump already rejects stale tokens per call.)
  revokeConnectorTokensForConnector(id);
  stmts.setStatus.run("disabled", id);
  return toView(requireRow(id));
}

export function getInstance(id: string): ConnectorInstanceView {
  return toView(requireRow(id));
}

// ─── M2b: OAuth authorization bookkeeping (feishu-docs) ───────

/** Host-side exit point for the OAuth token blob. Never serialize its result.
 * `setPending` marks the one-time authorization flow in progress. */
export function setOAuthPending(id: string): void {
  requireRow(id);
  stmts.setOAuthPending.run(id);
}

export function writeOAuthTokens(
  id: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: string }
): void {
  requireRow(id);
  // Same AES-GCM envelope as app credentials; the blob NEVER leaves host-side.
  stmts.writeOAuth.run(encryptCredentials(tokens), tokens.expiresAt, id);
}

export function markOAuthFailed(id: string): void {
  requireRow(id);
  stmts.markOAuthFailed.run(id);
}

/** Decrypt the OAuth token blob for host-side use (refresh/API calls). */
export function getOAuthTokensForHost(
  id: string
): { accessToken: string; refreshToken: string; expiresAt: string } | null {
  const row = getRow(id);
  if (!row || !row.oauth_ciphertext) return null;
  return decryptCredentials(row.oauth_ciphertext) as {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  };
}
