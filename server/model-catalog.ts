/**
 * model-catalog.ts — M1 (docs/开发计划/model-and-token-management-plan.md §6, §9-M1).
 *
 * Platform Model Catalog + org model authorization/default-model overlay.
 * Mirrors the frozen shared-pool + entitlement pattern:
 *   - model_catalog = shared platform pool (no org_id on rows);
 *   - org_model_entitlements/org_model_policy = per-org overlay (deny-default);
 *   - catalog writes are ADMIN-ONLY (they affect every org); org_admin may
 *     edit ONLY its own org's policy (guard enforced at the route layer).
 *
 * M1 scope boundary: this module manages the catalog + org policy.
 * M2 extends it with the selection precedence (plan §3.2): Chat 选择 >
 * Agent 默认 > 组织默认 > 平台默认, each level re-validated against
 * 平台启用 ∩ 组织授权 at READ time (dangling/de-authorized overrides degrade,
 * never error the runtime). CapabilityProvider.resolve() and
 * computeConfigVersion() consume resolveEffectiveModel() — the model still
 * enters the data plane ONLY through the control-plane bridge.
 *
 * Compat (plan §9-M1 "从现有全局 runtime-settings 模型列表迁移兼容读取"):
 * ensureModelCatalogSeeded() seeds the catalog once from runtime-settings
 * models[] when the table is empty, so the new page boots showing the
 * existing global aliases instead of a blank list. Seeded rows are ordinary
 * catalog rows from then on — admin edits go to the DB, runtime-settings'
 * own panel keeps working unchanged (it remains the runtime default source).
 *
 * Provider credentials: NEVER stored, returned, or audited here — the catalog
 * carries only a provider NAME. Audits are metadata-only (writeGovernanceAudit).
 */

import db from "./database.js";
import { writeGovernanceAudit } from "./org-governance.js";
import { getRuntimeSettings } from "./runtime-settings.js";
import { randomUUID } from "node:crypto";
import type { Role } from "./request-context.js";

// ─── Types ───────────────────────────────────────────────────

export interface ModelCatalogEntry {
  id: string;
  alias: string;
  provider: string;
  modelId: string | null;
  enabled: boolean;
  description: string | null;
  contextWindowTokens: number | null;
  // M6 (Anthropic-only model definitions, plan §6.2 minimal). All optional —
  // legacy/seeded rows carry null. baseUrl is DIRECTORY METADATA ONLY (never
  // drives an outbound endpoint; runtime uses ANTHROPIC_BASE_URL). apiKeyEnv
  // stores the ENV-VAR NAME, never a plaintext key.
  baseUrl?: string | null;
  protocol?: string | null;
  apiKeyEnv?: string | null;
  supportsToolCall?: boolean | null;
  supportsImages?: boolean | null;
  supportsReasoning?: boolean | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateModelInput {
  alias: string;
  /** Provider NAME (display/routing hint only — never a credential). Defaults to "default". */
  provider?: string;
  modelId?: string | null;
  enabled?: boolean;
  description?: string | null;
  contextWindowTokens?: number | null;
}

export type UpdateModelInput = Partial<Omit<CreateModelInput, "alias">> & { alias?: string };

export interface OrgModelEntitlement {
  modelId: string;
  alias: string;
  enabled: boolean;
}

export interface OrgModelPolicyView {
  orgId: string;
  defaultModelId: string | null;
  defaultAlias: string | null;
  entries: OrgModelEntitlement[];
  /** Effective resolution view (plan §3.2, M1 read-only): platform-enabled ∩
   * org-entitled; default falls back to the platform default when the org
   * default is unset/invalid. informational until M2 wires runtime. */
  effective: {
    models: Array<{ id: string; alias: string }>;
    defaultAlias: string;
    defaultSource: "org" | "platform";
  };
}

export interface SetOrgModelPolicyInput {
  defaultModelId?: string | null;
  models?: Array<{ modelId: string; enabled: boolean }>;
}

// Same alias grammar as runtime-settings Stage 2 — one definition of "alias".
export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ─── Prepared statements ─────────────────────────────────────

const stmts = {
  listModels: db.prepare(`SELECT * FROM model_catalog ORDER BY alias`),
  getById: db.prepare(`SELECT * FROM model_catalog WHERE id = ?`),
  getByAlias: db.prepare(`SELECT * FROM model_catalog WHERE alias = ?`),
  insertModel: db.prepare(`
    INSERT INTO model_catalog (id, alias, provider, model_id, enabled, description, context_window_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateModel: db.prepare(`
    UPDATE model_catalog
    SET alias = ?, provider = ?, model_id = ?, enabled = ?, description = ?, context_window_tokens = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `),
  deleteModel: db.prepare(`DELETE FROM model_catalog WHERE id = ?`),
  countModels: db.prepare(`SELECT COUNT(*) AS n FROM model_catalog`),
  // M6: full-column upsert for Anthropic-only model definitions. Writes every
  // M6 column; ON CONFLICT(alias) → UPDATE (provider-scoped conflict handled
  // in importModelDefinition before this runs). Reuse for both insert+update.
  upsertModelDefinition: db.prepare(`
    INSERT INTO model_catalog
      (id, alias, provider, model_id, enabled, description, context_window_tokens,
       base_url, protocol, api_key_env, supports_tool_call, supports_images,
       supports_reasoning, max_input_tokens, max_output_tokens)
    VALUES (@id, @alias, @provider, @model_id, @enabled, @description, @context_window_tokens,
            @base_url, @protocol, @api_key_env, @supports_tool_call, @supports_images,
            @supports_reasoning, @max_input_tokens, @max_output_tokens)
    ON CONFLICT(alias) DO UPDATE SET
      provider = excluded.provider, model_id = excluded.model_id, enabled = excluded.enabled,
      description = excluded.description, context_window_tokens = excluded.context_window_tokens,
      base_url = excluded.base_url, protocol = excluded.protocol, api_key_env = excluded.api_key_env,
      supports_tool_call = excluded.supports_tool_call, supports_images = excluded.supports_images,
      supports_reasoning = excluded.supports_reasoning, max_input_tokens = excluded.max_input_tokens,
      max_output_tokens = excluded.max_output_tokens, updated_at = datetime('now')
  `),
  listEntitlements: db.prepare(`SELECT model_id, enabled FROM org_model_entitlements WHERE org_id = ?`),
  deleteEntitlements: db.prepare(`DELETE FROM org_model_entitlements WHERE org_id = ?`),
  replaceEntitlements: db.prepare(`
    INSERT INTO org_model_entitlements (org_id, model_id, enabled) VALUES (?, ?, ?)
    ON CONFLICT(org_id, model_id) DO UPDATE SET enabled = excluded.enabled
  `),
  getPolicy: db.prepare(`SELECT * FROM org_model_policy WHERE org_id = ?`),
  upsertPolicy: db.prepare(`
    INSERT INTO org_model_policy (org_id, default_model_id) VALUES (?, ?)
    ON CONFLICT(org_id) DO UPDATE SET default_model_id = excluded.default_model_id, updated_at = datetime('now')
  `),
  clearDefaultForModel: db.prepare(
    `UPDATE org_model_policy SET default_model_id = NULL, updated_at = datetime('now') WHERE default_model_id = ?`
  ),
  orgsUsingModelAsDefault: db.prepare(
    `SELECT org_id FROM org_model_policy WHERE default_model_id = ?`
  ),
  // M2: per-chat / per-agent model override (stores the ALIAS — resilient to a
  // deleted catalog row; re-validated on every read by resolveEffectiveModel).
  chatById: db.prepare(`SELECT id, org_id, model_override FROM chats WHERE id = ?`),
  agentById: db.prepare(`SELECT id, org_id, model_override FROM agents WHERE id = ?`),
  setChatModelOverride: db.prepare(
    `UPDATE chats SET model_override = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  setAgentModelOverride: db.prepare(
    `UPDATE agents SET model_override = ?, updated_at = datetime('now') WHERE id = ?`
  ),
};

// ─── Row mapping ─────────────────────────────────────────────

type Row = {
  id: string; alias: string; provider: string; model_id: string | null;
  enabled: number; description: string | null; context_window_tokens: number | null;
  base_url: string | null; protocol: string | null; api_key_env: string | null;
  supports_tool_call: number | null; supports_images: number | null; supports_reasoning: number | null;
  max_input_tokens: number | null; max_output_tokens: number | null;
  created_at: string; updated_at: string;
};

function toEntry(r: Row): ModelCatalogEntry {
  return {
    id: r.id,
    alias: r.alias,
    provider: r.provider,
    modelId: r.model_id,
    enabled: !!r.enabled,
    description: r.description,
    contextWindowTokens: r.context_window_tokens,
    baseUrl: r.base_url,
    protocol: r.protocol,
    apiKeyEnv: r.api_key_env,
    supportsToolCall: r.supports_tool_call == null ? null : !!r.supports_tool_call,
    supportsImages: r.supports_images == null ? null : !!r.supports_images,
    supportsReasoning: r.supports_reasoning == null ? null : !!r.supports_reasoning,
    maxInputTokens: r.max_input_tokens,
    maxOutputTokens: r.max_output_tokens,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Seed (compat with global runtime-settings model list) ──

/** One-time, idempotent: when model_catalog is EMPTY, seed one row per
 *  runtime-settings models[] entry. Never overwrites admin edits afterwards. */
export function ensureModelCatalogSeeded(): number {
  if ((stmts.countModels.get() as { n: number }).n > 0) return 0;
  const settings = getRuntimeSettings();
  const seed = db.transaction(() => {
    let n = 0;
    for (const m of settings.models) {
      stmts.insertModel.run(randomUUID(), m.alias, "default", null, m.enabled ? 1 : 0, null, null);
      n++;
    }
    return n;
  });
  const n = seed();
  if (n > 0) {
    console.log(`[ModelCatalog] Seeded ${n} model(s) from runtime-settings (compat, one-time)`);
  }
  return n;
}

// ─── Catalog CRUD (admin-only at the route layer) ────────────

function validateAlias(alias: unknown, label = "alias"): string {
  if (typeof alias !== "string" || !ALIAS_RE.test(alias.trim())) {
    throw new Error(`Invalid ${label} "${String(alias)}"`);
  }
  return alias.trim();
}

export function listModels(): ModelCatalogEntry[] {
  return (stmts.listModels.all() as Row[]).map(toEntry);
}

export function getModel(id: string): ModelCatalogEntry | null {
  const r = stmts.getById.get(id) as Row | undefined;
  return r ? toEntry(r) : null;
}

export function createModel(input: CreateModelInput): ModelCatalogEntry {
  const alias = validateAlias(input.alias);
  const provider = validateAlias(input.provider ?? "default", "provider");
  if (!PROVIDER_RE.test(provider)) throw new Error(`Invalid provider "${provider}"`);
  if (stmts.getByAlias.get(alias)) throw new Error(`Model alias "${alias}" already exists`);
  const ctx = typeof input.contextWindowTokens === "number"
    ? (Number.isInteger(input.contextWindowTokens) && input.contextWindowTokens > 0
        ? input.contextWindowTokens
        : (() => { throw new Error("contextWindowTokens must be a positive integer"); })())
    : null;
  const id = randomUUID();
  stmts.insertModel.run(
    id, alias, provider,
    typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : null,
    input.enabled === false ? 0 : 1,
    typeof input.description === "string" && input.description.trim() ? input.description.trim() : null,
    ctx,
  );
  return getModel(id)!;
}

// ─── M5: Provider import (plan §6.2) ─────────────────────────
// Import creates/updates a catalog row BY ALIAS, scoped to the connector's
// provider name. It NEVER touches org entitlements / org policy / Chat or
// Agent overrides (event M5-3: import only updates Model Catalog; no auto
// org authorization, no Chat switch). Upsert-by-alias is provider-scoped: a
// same-alias row under a DIFFERENT provider is a conflict (do NOT clobber
// another provider's entry).

export type ImportStatus = "imported" | "updated" | "conflict" | "invalid";

export interface ImportModelInput {
  alias: string;
  provider: string;
  modelId?: string | null;
  contextWindowTokens?: number | null;
  description?: string | null;
}

export interface ImportModelResult {
  alias: string;
  status: ImportStatus;
  /** Catalog id for imported/updated rows. */
  modelId?: string;
  error?: string;
}

export function importModel(input: ImportModelInput): ImportModelResult {
  let alias: string;
  let provider: string;
  try {
    alias = validateAlias(input.alias);
    provider = validateAlias(input.provider, "provider");
  } catch (err) {
    return { alias: String(input.alias ?? ""), status: "invalid", error: (err as Error).message };
  }
  if (!PROVIDER_RE.test(provider)) {
    return { alias, status: "invalid", error: "Invalid provider: " + provider };
  }
  const ctx =
    typeof input.contextWindowTokens === "number"
      ? Number.isInteger(input.contextWindowTokens) && input.contextWindowTokens > 0
        ? input.contextWindowTokens
        : null
      : null;
  const modelId = typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : null;
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null;

  const existing = stmts.getByAlias.get(alias) as Row | undefined;
  if (existing) {
    if (existing.provider !== provider) {
      return { alias, status: "conflict", error: "alias " + alias + " already belongs to provider " + existing.provider + " (not clobbering another provider's entry)" };
    }
    // Same provider: upsert modelId / contextWindow / description; keep enabled.
    stmts.updateModel.run(
      alias, provider, modelId, existing.enabled,
      description, ctx, existing.id,
    );
    return { alias, status: "updated", modelId: existing.id };
  }
  const id = randomUUID();
  stmts.insertModel.run(id, alias, provider, modelId, 1, description, ctx);
  return { alias, status: "imported", modelId: id };
}

// ─── M6: Anthropic-only model-definition import (plan §6.2 minimal) ──────
// Minimal JSON model definition: 10 fields (id,name,vendor,baseUrl,protocol,
// apiKeyEnv,supportsToolCall,supportsImages,supportsReasoning,maxInputTokens,
// maxOutputTokens). protocol MUST be "anthropic-compatible" (or absent) — no
// OpenAI-compatible / dual-protocol (req 1). PLAINTEXT apiKey is REJECTED
// (req 3); apiKeyEnv holds the ENV-VAR NAME only, read by the runtime from
// process.env. baseUrl is DIRECTORY METADATA ONLY (req 5): the runtime still
// uses the single deployed ANTHROPIC_BASE_URL; this column never drives an
// outbound endpoint. Import writes model_catalog ONLY (req 4): no .env
// rewrite, no org authorization, no Chat/Agent switch.

const M6_PROTOCOL = "anthropic-compatible";

export interface ModelDefinitionInput {
  /** Provider model id, e.g. "claude-sonnet-4". Maps to catalog.model_id. */
  id: string;
  /** Human alias in the catalog. Required. */
  name: string;
  /** Provider name (display/routing hint only). Maps to catalog.provider. */
  vendor: string;
  baseUrl?: string | null;
  /** Must be "anthropic-compatible" if present. Any other value is rejected. */
  protocol?: string | null;
  apiKeyEnv?: string | null;
  supportsToolCall?: boolean | null;
  supportsImages?: boolean | null;
  supportsReasoning?: boolean | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
  contextWindowTokens?: number | null;
  description?: string | null;
}

export interface ImportDefinitionResult {
  alias: string;
  status: ImportStatus;
  modelId?: string;
  error?: string;
}

function boolOrNull(v: unknown): number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return null;
  return v;
}

/** Import a single Anthropic-only model definition. Returns status; never throws
 *  on bad input (returns invalid with an error message). The `apiKey` key is
 *  typed-but-rejected: callers feed raw JSON, we must detect and refuse it. */
export function importModelDefinition(input: ModelDefinitionInput & { apiKey?: unknown }): ImportDefinitionResult {
  // req 3: forbid plaintext apiKey (the key itself, not the env-var NAME).
  if (input !== null && typeof input === "object" && "apiKey" in input) {
    return { alias: String(input.name ?? input.id ?? ""), status: "invalid",
             error: "plaintext apiKey is forbidden; use apiKeyEnv (env-var name)" };
  }
  let alias: string;
  let vendor: string;
  try {
    alias = validateAlias(input.name, "name");
    vendor = validateAlias(input.vendor, "vendor");
  } catch (err) {
    const msg = (err as Error).message;
    // UX: pasting the provider code (e.g. glm-5.3[1m]) into `name` is the
    // common mistake — point the importer at the right field instead of a
    // bare grammar error. The code itself is legal; it belongs in `id`.
    const error = msg.startsWith("Invalid name")
      ? `${msg} — name is the management alias (A-Za-z0-9._/- only, no brackets); put the provider model code in "id"`
      : msg;
    return { alias: String(input.name ?? input.id ?? ""), status: "invalid", error };
  }
  if (!PROVIDER_RE.test(vendor)) {
    return { alias, status: "invalid", error: "Invalid vendor: " + vendor };
  }
  // req 1: protocol must be anthropic-compatible (or absent). No OpenAI-compatible.
  if (input.protocol != null && input.protocol !== M6_PROTOCOL) {
    return { alias, status: "invalid",
             error: "protocol must be \"" + M6_PROTOCOL + "\" (got \"" + String(input.protocol) + "\")" };
  }
  const modelId = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  if (!modelId) {
    return { alias, status: "invalid", error: "id is required" };
  }
  // apiKeyEnv: env-var NAME only (e.g. ANTHROPIC_API_KEY). Reject anything that
  // looks like a key value (heuristic: > 40 chars or contains whitespace) so a
  // pasted secret never lands in the catalog.
  let apiKeyEnv: string | null = null;
  if (typeof input.apiKeyEnv === "string" && input.apiKeyEnv.trim()) {
    const env = input.apiKeyEnv.trim();
    if (env.length > 40 || /\s/.test(env)) {
      return { alias, status: "invalid",
               error: "apiKeyEnv must be an env-var name, not a key value" };
    }
    apiKeyEnv = env;
  }
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : null;
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null;
  const ctx = intOrNull(input.contextWindowTokens ?? input.maxInputTokens);

  // provider-scoped conflict: same alias under a DIFFERENT vendor is not clobbered.
  const existing = stmts.getByAlias.get(alias) as Row | undefined;
  if (existing && existing.provider !== vendor) {
    return { alias, status: "conflict",
             error: "alias " + alias + " already belongs to vendor " + existing.provider + " (not clobbering)" };
  }
  const id = existing?.id ?? randomUUID();
  stmts.upsertModelDefinition.run({
    id, alias, provider: vendor, model_id: modelId,
    enabled: existing?.enabled ?? 1,
    description, context_window_tokens: ctx,
    base_url: baseUrl, protocol: input.protocol ?? M6_PROTOCOL, api_key_env: apiKeyEnv,
    supports_tool_call: boolOrNull(input.supportsToolCall),
    supports_images: boolOrNull(input.supportsImages),
    supports_reasoning: boolOrNull(input.supportsReasoning),
    max_input_tokens: intOrNull(input.maxInputTokens),
    max_output_tokens: intOrNull(input.maxOutputTokens),
  });
  return { alias, status: existing ? "updated" : "imported", modelId: id };
}

export function updateModel(id: string, patch: UpdateModelInput): ModelCatalogEntry {
  const current = getModel(id);
  if (!current) throw new Error("Model not found");
  const next = {
    alias: patch.alias !== undefined ? validateAlias(patch.alias) : current.alias,
    provider: patch.provider !== undefined ? patch.provider : current.provider,
    modelId: patch.modelId !== undefined
      ? (typeof patch.modelId === "string" && patch.modelId.trim() ? patch.modelId.trim() : null)
      : current.modelId,
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    description: patch.description !== undefined
      ? (typeof patch.description === "string" && patch.description.trim() ? patch.description.trim() : null)
      : current.description,
    contextWindowTokens: patch.contextWindowTokens !== undefined ? patch.contextWindowTokens : current.contextWindowTokens,
  };
  if (!PROVIDER_RE.test(next.provider)) throw new Error(`Invalid provider "${next.provider}"`);
  if (next.alias !== current.alias && stmts.getByAlias.get(next.alias)) {
    throw new Error(`Model alias "${next.alias}" already exists`);
  }
  if (next.contextWindowTokens !== null &&
      !(Number.isInteger(next.contextWindowTokens) && next.contextWindowTokens > 0)) {
    throw new Error("contextWindowTokens must be a positive integer");
  }
  stmts.updateModel.run(next.alias, next.provider, next.modelId, next.enabled ? 1 : 0, next.description, next.contextWindowTokens, id);

  // Invariant (plan §10 admin acceptance): a DISABLED model cannot remain any
  // org's default. Disabling cascades a NULL-out of org defaults (audited by
  // the route via reasonSummary; the mutation itself is deterministic here).
  if (current.enabled && !next.enabled) {
    stmts.clearDefaultForModel.run(id);
  }
  return getModel(id)!;
}

export function deleteModel(id: string): void {
  const current = getModel(id);
  if (!current) throw new Error("Model not found");
  // Entitlements cascade via FK; org defaults NULL out via FK ON DELETE SET NULL.
  stmts.deleteModel.run(id);
}

// ─── Org model policy (org overlay) ──────────────────────────

export function getOrgModelPolicy(orgId: string): OrgModelPolicyView {
  const catalog = listModels();
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const entitlements = stmts.listEntitlements.all(orgId) as Array<{ model_id: string; enabled: number }>;
  const entById = new Map(entitlements.map((e) => [e.model_id, !!e.enabled]));

  const entries: OrgModelEntitlement[] = catalog.map((m) => ({
    modelId: m.id,
    alias: m.alias,
    enabled: entById.get(m.id) ?? false,
  }));

  const policy = stmts.getPolicy.get(orgId) as { default_model_id: string | null } | undefined;
  const defaultModel = policy?.default_model_id ? byId.get(policy.default_model_id) ?? null : null;
  // Default is only VALID while platform-enabled AND org-entitled (a disabled or
  // unentitled default degrades to the platform default — read-path fail-safe,
  // same philosophy as runtime-settings pickSafeDefault).
  const defaultValid = !!defaultModel && defaultModel.enabled && (entById.get(defaultModel.id) ?? false);
  const platformDefault = getRuntimeSettings().defaultModel;

  const effectiveModels = catalog
    .filter((m) => m.enabled && (entById.get(m.id) ?? false))
    .map((m) => ({ id: m.id, alias: m.alias }));
  const effectiveDefault = defaultValid && defaultModel ? defaultModel.alias : platformDefault;

  return {
    orgId,
    defaultModelId: defaultValid && defaultModel ? defaultModel.id : policy?.default_model_id ?? null,
    defaultAlias: defaultValid && defaultModel ? defaultModel.alias : null,
    entries,
    effective: {
      models: effectiveModels,
      defaultAlias: effectiveDefault,
      defaultSource: defaultValid ? "org" : "platform",
    },
  };
}

export function setOrgModelPolicy(orgId: string, input: SetOrgModelPolicyInput): OrgModelPolicyView {
  const catalog = listModels();
  const byId = new Map(catalog.map((m) => [m.id, m]));

  const models = Array.isArray(input.models) ? input.models : null;
  if (models) {
    const seen = new Set<string>();
    for (const m of models) {
      if (!m || typeof m.modelId !== "string" || !byId.has(m.modelId)) {
        throw new Error(`Unknown modelId "${m?.modelId}"`);
      }
      if (seen.has(m.modelId)) throw new Error(`Duplicate modelId "${m.modelId}"`);
      seen.add(m.modelId);
    }
  }

  const entitlements = models
    ?? (stmts.listEntitlements.all(orgId) as Array<{ model_id: string; enabled: number }>)
        .map((e) => ({ modelId: e.model_id, enabled: !!e.enabled }));
  const entEnabled = new Set(
    entitlements.filter((e) => e.enabled).map((e) => e.modelId)
  );

  // Hard gate: the default must be platform-ENABLED and org-ENTITLED+ENABLED
  // in the same payload (deny-default — mirrors Stage 2's save gate).
  let defaultModelId: string | null = null;
  if (input.defaultModelId != null) {
    const d = byId.get(input.defaultModelId);
    if (!d) throw new Error(`Unknown defaultModelId "${input.defaultModelId}"`);
    if (!d.enabled) throw new Error(`Default model "${d.alias}" is disabled platform-wide`);
    if (!entEnabled.has(d.id)) throw new Error(`Default model "${d.alias}" is not an enabled model of this org`);
    defaultModelId = d.id;
  }

  const tx = db.transaction(() => {
    if (models) {
      // PUT = REPLACE semantics (same contract as the capability entitlement
      // editor): models absent from the payload are REMOVED, not left stale.
      stmts.deleteEntitlements.run(orgId);
      for (const m of models) {
        stmts.replaceEntitlements.run(orgId, m.modelId, m.enabled ? 1 : 0);
      }
    }
    stmts.upsertPolicy.run(orgId, defaultModelId);
  });
  tx();
  return getOrgModelPolicy(orgId);
}

/** Orgs whose policy currently points at this model as default (for audit
 *  reasonSummary + UI warnings on disable/delete). */
export function orgsUsingModelAsDefault(modelId: string): string[] {
  return (stmts.orgsUsingModelAsDefault.all(modelId) as Array<{ org_id: string }>).map((r) => r.org_id);
}

// ─── M2: effective model resolution (plan §3.2) ──────────────
// Precedence: Chat 选择 > Agent 默认 > 组织默认 > 平台默认. Every level is
// (re-)validated at READ time against 平台启用 ∩ 组织授权 — a dangling,
// disabled, or de-authorized candidate DEGRADES to the next level (read-path
// fail-safe) instead of erroring the runtime. WRITE time additionally hard-gates
// (setChatModelOverride/setAgentModelOverride), so a stale override can only be
// produced by a later admin/policy change, never by the client.

export type ModelSource = "chat" | "agent" | "org" | "platform";

export interface EffectiveModel {
  alias: string;
  source: ModelSource;
  // M6-fix (evt_20260819132308): the catalog's REAL provider model name when
  // present (JSON-import id / admin modelId field); null on legacy/seeded rows.
  modelId: string | null;
  /** What the RUNTIME passes to the SDK: modelId ?? alias (legacy fallback).
   *  UI/policy/permissions keep using alias — only sdkOptions.model consumes
   *  this (capability-provider, the single control→data injection point). */
  runtimeModel: string;
}

/** alias is platform-ENABLED ∧ org-ENTITLED (the §3.2 usable set). */
export function isModelUsableByOrg(alias: string, orgId: string): boolean {
  const row = stmts.getByAlias.get(alias) as Row | undefined;
  if (!row || !row.enabled) return false;
  const ent = stmts.listEntitlements.all(orgId) as Array<{ model_id: string; enabled: number }>;
  return ent.some((e) => e.model_id === row.id && !!e.enabled);
}

/** Aliases the org may select from (platform-enabled ∩ org-entitled). */
export function listUsableModelAliases(orgId: string): string[] {
  const ent = new Map(
    (stmts.listEntitlements.all(orgId) as Array<{ model_id: string; enabled: number }>)
      .filter((e) => !!e.enabled)
      .map((e) => [e.model_id, true])
  );
  return (stmts.listModels.all() as Row[]).filter((r) => !!r.enabled && ent.has(r.id)).map((r) => r.alias);
}

/**
 * Resolve the model a runtime should be built with (plan §3.2). The chat's org
 * is the trusted tenant scope (chats.org_id); ctx.orgId is the fallback when
 * no chatId is given (e.g. the boot-time default bundle → platform default).
 */
export function resolveEffectiveModel(input: { chatId?: string; orgId?: string }): EffectiveModel {
  const chatRow = input.chatId
    ? (stmts.chatById.get(input.chatId) as { id: string; org_id: string; model_override: string | null } | undefined)
    : undefined;
  const orgId = chatRow?.org_id ?? input.orgId ?? "default-org";
  const agentRow = input.chatId
    ? (stmts.agentById.get(input.chatId) as { id: string; model_override: string | null } | undefined)
    : undefined;

  // 1. Chat override
  if (chatRow?.model_override && isModelUsableByOrg(chatRow.model_override, orgId)) {
    return withRuntimeModel({ alias: chatRow.model_override, source: "chat" });
  }
  // 2. Agent default (same-id bridge: agents.id === chats.id)
  if (agentRow?.model_override && isModelUsableByOrg(agentRow.model_override, orgId)) {
    return withRuntimeModel({ alias: agentRow.model_override, source: "agent" });
  }
  // 3. Org default (getOrgModelPolicy already degrades an invalid org default
  //    to the platform default and reports which one won via defaultSource).
  const policy = getOrgModelPolicy(orgId);
  if (policy.effective.defaultSource === "org") {
    return withRuntimeModel({ alias: policy.effective.defaultAlias, source: "org" });
  }
  // 4. Platform default
  return withRuntimeModel({ alias: policy.effective.defaultAlias, source: "platform" });
}

/** M6-fix (evt_20260819132308): enrich the §3.2 winner with the catalog's real
 *  provider model name. Legacy/seeded rows (model_id NULL — and non-catalog
 *  runtime-settings defaults) fall back to the alias, preserving pre-M6
 *  behavior exactly. Alias stays the management key everywhere else
 *  (UI selector / org entitlements / chat+agent overrides all key by alias). */
function withRuntimeModel(resolved: { alias: string; source: ModelSource }): EffectiveModel {
  const row = stmts.getByAlias.get(resolved.alias) as Row | undefined;
  const modelId = (row?.model_id && row.model_id.trim()) || null;
  return { ...resolved, modelId, runtimeModel: modelId ?? resolved.alias };
}

/** Read model for the selector UI: stored override + what actually wins + the
 *  org-selectable list. `overrideEffective=false` means the stored override is
 *  dangling/disabled/de-authorized and a lower level is winning (UI hint). */
export function getChatModelSelection(chatId: string): {
  override: string | null;
  overrideSource: "chat" | "agent" | null;
  effective: EffectiveModel;
  available: string[];
} | null {
  const chatRow = stmts.chatById.get(chatId) as { id: string; org_id: string; model_override: string | null } | undefined;
  if (!chatRow) return null;
  const agentRow = stmts.agentById.get(chatId) as { model_override: string | null } | undefined;
  return {
    override: chatRow.model_override ?? agentRow?.model_override ?? null,
    overrideSource: chatRow.model_override ? "chat" : agentRow?.model_override ? "agent" : null,
    effective: resolveEffectiveModel({ chatId }),
    available: listUsableModelAliases(chatRow.org_id),
  };
}

/** WRITE-time hard gate (shared by the chat + agent routes): only aliases in
 *  平台启用 ∩ 组织授权 may be stored; null clears. Categorical errors only. */
function assertSelectableAlias(alias: string, orgId: string): void {
  const row = stmts.getByAlias.get(alias) as Row | undefined;
  if (!row) throw new Error(`Unknown model "${alias}"`);
  if (!row.enabled) throw new Error(`Model "${alias}" is disabled platform-wide`);
  if (!isModelUsableByOrg(alias, orgId)) throw new Error(`Model "${alias}" is not authorized for this organization`);
}

export function setChatModelOverride(chatId: string, alias: string | null): void {
  const chatRow = stmts.chatById.get(chatId) as { org_id: string } | undefined;
  if (!chatRow) throw new Error("Chat not found");
  if (alias == null) {
    stmts.setChatModelOverride.run(null, chatId);
    return;
  }
  const normalized = validateAlias(alias);
  assertSelectableAlias(normalized, chatRow.org_id);
  stmts.setChatModelOverride.run(normalized, chatId);
}

export function setAgentModelOverride(agentId: string, alias: string | null): void {
  const agentRow = stmts.agentById.get(agentId) as { org_id: string } | undefined;
  if (!agentRow) throw new Error("Agent not found");
  if (alias == null) {
    stmts.setAgentModelOverride.run(null, agentId);
    return;
  }
  const normalized = validateAlias(alias);
  assertSelectableAlias(normalized, agentRow.org_id);
  stmts.setAgentModelOverride.run(normalized, agentId);
}

// ─── Audit helper (metadata-only) ────────────────────────────

export function auditModelChange(input: {
  actorUserId?: string | null;
  actorRole?: Role | "system" | null;
  orgId: string;
  action: "model.create" | "model.update" | "model.delete" | "model_policy.update" | "model_override.update"
    // M4: org Auto Compact policy shares the model/token governance audit trail.
    | "compact_policy.update"
    // M5: provider model import (metadata only — no credentials).
    | "model.import"
    // M6: Anthropic-only model-definition JSON import (metadata only).
    | "model.import_definition";
  objectId?: string | null;
  result?: "success" | "failure" | "denied";
  reasonSummary?: string | null;
}): void {
  writeGovernanceAudit({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    orgId: input.orgId,
    action: input.action,
    objectType: "model",
    objectId: input.objectId ?? null,
    result: input.result ?? "success",
    reasonSummary: input.reasonSummary ?? null,
  });
}
