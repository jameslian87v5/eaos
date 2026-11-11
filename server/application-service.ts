/**
 * application-service.ts — Phase 6 (A0) Application CRUD + app key management.
 *
 * An "application" is a first-class preset the platform drives agents from.
 * This service owns the `applications` table: CRUD, app key sign/verify, and
 * the authoritative appId lookup for an agent (agents.app_id).
 *
 * Key design decisions (from first-principles + Codex review):
 *   - appId authority = DB (agents.app_id), NOT request params. getAppIdForAgent
 *     reads from the agents table; fallback 'default-app' for safety.
 *   - App keys are hash-at-rest: generateAppKey returns the plaintext once;
 *     verifyAppKey looks up by prefix then compares sha256 hash.
 *   - No caching in A0 — SQLite prepared statement is fast enough and avoids
 *     stale app-assignment bugs (Codex confirmed).
 *
 * See docs/02-architecture/platform-application-layer-architecture.md
 */

import { createHash, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import type { Application } from "./types.js";
import { getPromptSettings, sanitizePromptText } from "./prompt-settings.js";
import { SUPPORTED_TOOL_NAMES } from "./tool-catalog.js";
import { agentProfileStore } from "./agent-profile-store.js";

// ─── Prepared statements ─────────────────────────────────────

const stmts = {
  getApplication: db.prepare(
    `SELECT id, org_id AS orgId, name, description, profile_id AS profileId,
            entry_url AS entryUrl, api_key_prefix AS apiKeyPrefix,
            status, last_used_at AS lastUsedAt,
            system_prompt AS systemPrompt, append_system_prompt AS appendSystemPrompt,
            tool_allowlist AS toolAllowlistRaw,
            created_at AS createdAt, updated_at AS updatedAt
     FROM applications WHERE id = ?`
  ),
  listApplications: db.prepare(
    `SELECT id, org_id AS orgId, name, description, profile_id AS profileId,
            entry_url AS entryUrl, api_key_prefix AS apiKeyPrefix,
            status, last_used_at AS lastUsedAt,
            system_prompt AS systemPrompt, append_system_prompt AS appendSystemPrompt,
            tool_allowlist AS toolAllowlistRaw,
            created_at AS createdAt, updated_at AS updatedAt
     FROM applications ORDER BY created_at ASC`
  ),
  listByOrg: db.prepare(
    `SELECT id, org_id AS orgId, name, description, profile_id AS profileId,
            entry_url AS entryUrl, api_key_prefix AS apiKeyPrefix,
            status, last_used_at AS lastUsedAt,
            system_prompt AS systemPrompt, append_system_prompt AS appendSystemPrompt,
            tool_allowlist AS toolAllowlistRaw,
            created_at AS createdAt, updated_at AS updatedAt
     FROM applications WHERE org_id = ? ORDER BY created_at ASC`
  ),
  insertApplication: db.prepare(
    `INSERT INTO applications (id, org_id, name, description, profile_id, entry_url,
                               api_key_prefix, api_key_hash, status,
                               system_prompt, append_system_prompt, tool_allowlist,
                               created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
  ),
  updateApplication: db.prepare(
    `UPDATE applications SET name = ?, description = ?, profile_id = ?, entry_url = ?,
            status = ?, system_prompt = ?, append_system_prompt = ?,
            tool_allowlist = ?,
            updated_at = ? WHERE id = ?`
  ),
  updateApiKey: db.prepare(
    `UPDATE applications SET api_key_prefix = ?, api_key_hash = ?, updated_at = ? WHERE id = ?`
  ),
  updateLastUsed: db.prepare(
    `UPDATE applications SET last_used_at = ?, updated_at = ? WHERE id = ?`
  ),
  findByKeyPrefix: db.prepare(
    `SELECT id, org_id AS orgId, name, api_key_hash AS apiKeyHash, status
     FROM applications WHERE api_key_prefix = ?`
  ),
  // Authoritative appId lookup for an agent (agents.app_id).
  getAppIdForAgent: db.prepare(
    `SELECT app_id AS appId FROM agents WHERE id = ?`
  ),
};

// ─── Types ───────────────────────────────────────────────────

export interface CreateApplicationInput {
  id?: string;
  orgId?: string;
  name: string;
  description?: string | null;
  profileId?: string | null;
  entryUrl?: string | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  toolAllowlist?: string[] | null;
}

export interface UpdateApplicationInput {
  name?: string;
  description?: string | null;
  profileId?: string | null;
  entryUrl?: string | null;
  status?: "active" | "disabled";
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  toolAllowlist?: string[] | null;
}

export interface AppKeyResult {
  key: string; // plaintext key — only returned once at generation time
  prefix: string; // non-secret prefix for lookup
}

// ─── Service ─────────────────────────────────────────────────

function parseToolAllowlist(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === "string");
  } catch {
    // malformed JSON — treat as null
  }
  return null;
}

function validateToolAllowlist(allowlist: string[]): void {
  for (const t of allowlist) {
    if (!SUPPORTED_TOOL_NAMES.has(t)) {
      throw new Error(`Unsupported tool in tool_allowlist: ${t}`);
    }
  }
}

function mapApp(row: any): Application {
  return { ...row, toolAllowlist: parseToolAllowlist(row.toolAllowlistRaw ?? null) };
}

class ApplicationServiceImpl {
  getApplication(id: string): Application | undefined {
    const row = stmts.getApplication.get(id);
    return row ? mapApp(row) : undefined;
  }

  listApplications(): Application[] {
    return stmts.listApplications.all().map(mapApp);
  }

  listByOrg(orgId: string): Application[] {
    return stmts.listByOrg.all(orgId).map(mapApp);
  }

  createApplication(input: CreateApplicationInput): Application {
    const id = input.id ?? uuidv4();
    const orgId = input.orgId ?? "default-org";
    const now = new Date().toISOString();
    // Validate profileId exists if provided (prevent dangling App Profile reference).
    if (input.profileId && !agentProfileStore.get(input.profileId)) {
      throw new Error(`Profile "${input.profileId}" does not exist`);
    }
    const systemPrompt = this.boundPromptText(input.systemPrompt);
    const appendSystemPrompt = this.boundPromptText(input.appendSystemPrompt);
    let toolAllowlistJson: string | null = null;
    if (input.toolAllowlist) {
      validateToolAllowlist(input.toolAllowlist);
      toolAllowlistJson = JSON.stringify(input.toolAllowlist);
    }
    stmts.insertApplication.run(
      id,
      orgId,
      input.name,
      input.description ?? null,
      input.profileId ?? null,
      input.entryUrl ?? null,
      null, // api_key_prefix — set when key is generated
      null, // api_key_hash
      systemPrompt,
      appendSystemPrompt,
      toolAllowlistJson,
      now,
      now
    );
    const app = this.getApplication(id);
    if (!app) throw new Error(`Application ${id} missing after create`);
    return app;
  }

  updateApplication(id: string, input: UpdateApplicationInput): Application | undefined {
    const existing = this.getApplication(id);
    if (!existing) return undefined;
    // Validate profileId exists if provided and non-null (prevent dangling App Profile).
    if (input.profileId && input.profileId !== null && !agentProfileStore.get(input.profileId)) {
      throw new Error(`Profile "${input.profileId}" does not exist`);
    }
    const now = new Date().toISOString();
    const systemPrompt = input.systemPrompt !== undefined
      ? this.boundPromptText(input.systemPrompt)
      : existing.systemPrompt;
    const appendSystemPrompt = input.appendSystemPrompt !== undefined
      ? this.boundPromptText(input.appendSystemPrompt)
      : existing.appendSystemPrompt;
    let toolAllowlistJson: string | null;
    if (input.toolAllowlist !== undefined) {
      if (input.toolAllowlist) {
        validateToolAllowlist(input.toolAllowlist);
        toolAllowlistJson = JSON.stringify(input.toolAllowlist);
      } else {
        toolAllowlistJson = null;
      }
    } else {
      toolAllowlistJson = existing.toolAllowlist ? JSON.stringify(existing.toolAllowlist) : null;
    }
    stmts.updateApplication.run(
      input.name ?? existing.name,
      input.description !== undefined ? input.description : existing.description,
      input.profileId !== undefined ? input.profileId : existing.profileId,
      input.entryUrl !== undefined ? input.entryUrl : existing.entryUrl,
      input.status ?? existing.status,
      systemPrompt,
      appendSystemPrompt,
      toolAllowlistJson,
      now,
      id
    );
    return this.getApplication(id);
  }

  /**
   * Generate a new app key for an application. The key is hash-at-rest:
   * only the prefix and sha256 hash are stored; the plaintext is returned
   * once and never recoverable.
   */
  generateAppKey(appId: string): AppKeyResult {
    const raw = randomBytes(24).toString("hex");
    const key = `sap_${raw}`;
    const prefix = key.slice(0, 16); // sap_ + first 12 hex chars
    const hash = createHash("sha256").update(key).digest("hex");
    const now = new Date().toISOString();
    const result = stmts.updateApiKey.run(prefix, hash, now, appId);
    if (result.changes === 0) {
      throw new Error(`Application "${appId}" not found — cannot generate key`);
    }
    return { key, prefix };
  }

  /**
   * Verify an app key. Looks up by prefix, compares sha256 hash.
   * Returns the appId if valid + active, null otherwise.
   * Updates last_used_at on successful verification (audit).
   */
  /**
   * Verify an app key AND return the app's org. Phase 7: the app principal must
   * be org-aligned with the user principal — appAuthMiddleware / verifyWSAppAuth
   * reject when app.orgId !== user orgId. Same lookup/hash/status/audit semantics
   * as verifyAppKey; findByKeyPrefix already selects org_id.
   */
  verifyAppKeyWithOrg(key: string): { appId: string; orgId: string } | null {
    if (!key.startsWith("sap_")) return null;
    const prefix = key.slice(0, 16);
    const row = stmts.findByKeyPrefix.get(prefix) as
      | { id: string; orgId: string; apiKeyHash: string; status: string }
      | undefined;
    if (!row) return null;
    if (row.status !== "active") return null;
    const hash = createHash("sha256").update(key).digest("hex");
    if (hash !== row.apiKeyHash) return null;
    // Update last_used_at (audit, non-critical — don't fail if this errors)
    try {
      stmts.updateLastUsed.run(new Date().toISOString(), new Date().toISOString(), row.id);
    } catch {
      // ignore — audit timestamp is best-effort
    }
    return { appId: row.id, orgId: row.orgId };
  }

  /** verifyAppKey keeps its existing string|nul contract (tests depend on it);
   *  org-aware callers use verifyAppKeyWithOrg. */
  verifyAppKey(key: string): string | null {
    const r = this.verifyAppKeyWithOrg(key);
    return r ? r.appId : null;
  }

  /**
   * Get app-level prompt overrides for capability-provider.resolve().
   * Returns null for both fields if app not found (falls through to profile/platform default).
   */
  getAppPromptOverrides(appId: string): {
    systemPrompt: string | null;
    appendSystemPrompt: string | null;
  } {
    const app = this.getApplication(appId);
    if (!app) return { systemPrompt: null, appendSystemPrompt: null };
    return {
      systemPrompt: app.systemPrompt,
      appendSystemPrompt: app.appendSystemPrompt,
    };
  }

  /**
   * Get app-level tool allowlist for capability-provider.resolve().
   * Returns null if app not found or no allowlist set (passthrough = no upper bound).
   */
  getAppToolAllowlist(appId: string): string[] | null {
    const app = this.getApplication(appId);
    if (!app) return null;
    return app.toolAllowlist;
  }

  /**
   * Authoritative appId lookup for an agent. Reads from agents.app_id (DB).
   * Fallback 'default-app' if the agent row doesn't exist yet (safety).
   * No caching — SQLite prepared statement is fast enough (Codex confirmed).
   */
  getAppIdForAgent(agentId: string): string {
    const row = stmts.getAppIdForAgent.get(agentId) as { appId: string } | undefined;
    return row?.appId ?? "default-app";
  }

  private boundPromptText(value: string | null | undefined): string | null {
    if (value == null || value.trim() === "") return null;
    const sanitized = sanitizePromptText(value);
    const max = getPromptSettings().maxSystemPromptChars;
    if (sanitized.length > max) {
      throw new Error(`Prompt text too long: ${sanitized.length} > maxSystemPromptChars(${max})`);
    }
    return sanitized;
  }
}

export const applicationService = new ApplicationServiceImpl();
