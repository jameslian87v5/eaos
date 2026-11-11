/**
 * runtime-settings.ts — local, file-backed runtime configuration.
 *
 * Per docs/admin-console-workbench-design.md §5 & §9:
 *   - Backed by data/runtime-settings.json (NO database in this phase).
 *   - Only fields that map to real backend behavior are configurable.
 *   - Defaults mirror previous hard-coded values, so behavior is unchanged
 *     until an admin edits the settings.
 *
 * Effect rules:
 *   idleStopMs               → live: affects subsequent idle detection sweeps.
 *   memoryMb / cpuCores      → only new Docker runtimes.
 *   maxTurns                 → only new Agent runtimes (SDK options).
 *   maxWorkspaceMb /
 *   maxClaudeHomeMb          → soft limits: display + warning only, NOT enforced.
 */

import path from "path";
import fs from "fs";

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
const SETTINGS_FILE = path.resolve(DATA_DIR, "runtime-settings.json");

// ─── Types ───────────────────────────────────────────────────

export interface ModelAlias {
  alias: string;
  enabled: boolean;
}

export interface RuntimeSettings {
  idleStopMs: number;
  memoryMb: number;
  cpuCores: number;
  maxTurns: number;
  maxWorkspaceMb: number;
  maxClaudeHomeMb: number;
  // MP4c (R1): when true, a configVersion drift on warm-resume forces a
  // resolve+rebuild instead of reconnecting the stale container. Default false
  // — warm resume promises continuity; surface drift via diagnostics + manual
  // Stop/Rebuild unless an admin opts in.
  autoRebuildOnConfigDrift: boolean;
  // User MEMORY.md quota (single global platform setting). Byte cap enforced at
  // both the service API and the tool boundary (Write/Edit). See user-memory-service.ts.
  userMemoryQuotaBytes: number;
  // Stage 2 (coarse global model management): the platform-wide default model
  // alias + the selectable alias list. Coarse BY DESIGN — no per-agent model,
  // no org entitlement, no realModelId mapping, no cost, no multi-provider
  // routing (codex-agreed boundary). The alias resolves provider-side.
  defaultModel: string;
  models: ModelAlias[];
  // M4 (plan §4.3, phase 1): platform-default Auto Compact policy. An org may
  // override via org_compact_policy, but org values are clamped to the
  // PLATFORM_MAX_* caps in compact-policy.ts (组织值受平台上限约束).
  contextCompaction: {
    enabled: boolean;
    thresholdTokens: number;
    keepRecentTurns: number;
  };
}

// Defaults mirror previous hard-coded behavior (docker-runtime: 512MB / 1 CPU; SDK maxTurns 100;
// model alias "opus" was the hard-coded value in ai-client.ts / agent-entry.ts).
export const defaultSettings: RuntimeSettings = {
  idleStopMs: 30 * 60 * 1000,
  memoryMb: 512,
  cpuCores: 1,
  maxTurns: 100,
  maxWorkspaceMb: 1024,
  maxClaudeHomeMb: 100,
  autoRebuildOnConfigDrift: false,
  userMemoryQuotaBytes: 64 * 1024,
  defaultModel: "opus",
  models: [{ alias: "opus", enabled: true }],
  contextCompaction: { enabled: true, thresholdTokens: 100_000, keepRecentTurns: 10 },
};

// ─── Stage 2: model list sanitize + default validation ───────────────────

const MAX_MODEL_ALIASES = 20;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;

/** Sanitize the alias list: string-trim, shape-check, dedupe (keep first),
 *  cap length. A malformed entry is DROPPED, not fatal — a hand-edited file
 *  must not brick runtime boot; saveRuntimeSettings is where we reject hard. */
export function sanitizeModelAliases(raw: unknown): ModelAlias[] {
  if (!Array.isArray(raw)) return [{ ...defaultSettings.models[0] }];
  const out: ModelAlias[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const alias = typeof (item as any).alias === "string" ? (item as any).alias.trim() : "";
    if (!ALIAS_RE.test(alias) || seen.has(alias) || out.length >= MAX_MODEL_ALIASES) continue;
    seen.add(alias);
    out.push({ alias, enabled: Boolean((item as any).enabled) });
  }
  return out.length ? out : [{ ...defaultSettings.models[0] }];
}

/** READ-path fail-safe: a hand-edited file whose defaultModel is unknown or
 *  disabled degrades to the FIRST enabled alias (never to a disabled model),
 *  falling back to the platform default when nothing is enabled. SAVE-path
 *  validation (saveRuntimeSettings) is the hard gate; this keeps boot alive. */
function pickSafeDefault(defaultModel: unknown, models: ModelAlias[]): string {
  const wanted = typeof defaultModel === "string" ? defaultModel.trim() : "";
  if (wanted && models.some((m) => m.alias === wanted && m.enabled)) return wanted;
  const firstEnabled = models.find((m) => m.enabled);
  return firstEnabled ? firstEnabled.alias : defaultSettings.defaultModel;
}

// Validation bounds — reject obviously unsafe / nonsensical values.
// Only numeric fields are bounded; autoRebuildOnConfigDrift (boolean) is not.
type BoundedKey = "idleStopMs" | "memoryMb" | "cpuCores" | "maxTurns" | "maxWorkspaceMb" | "maxClaudeHomeMb" | "userMemoryQuotaBytes";
const BOUNDS: Record<BoundedKey, { min: number; max: number }> = {
  idleStopMs:      { min: 60 * 1000,  max: 24 * 60 * 60 * 1000 }, // 1 min – 24 h
  memoryMb:        { min: 128,        max: 16384 },               // 128 MB – 16 GB
  cpuCores:        { min: 0.25,       max: 16 },
  maxTurns:        { min: 1,          max: 1000 },
  maxWorkspaceMb:  { min: 64,         max: 102400 },              // 64 MB – 100 GB
  maxClaudeHomeMb: { min: 16,         max: 10240 },               // 16 MB – 10 GB
  userMemoryQuotaBytes: { min: 1024,  max: 10 * 1024 * 1024 },    // 1 KiB – 10 MiB
};

// ─── Internal helpers ────────────────────────────────────────

let cache: RuntimeSettings | null = null;

function clampField(key: BoundedKey, value: unknown): number {
  const b = BOUNDS[key];
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultSettings[key];
  return Math.min(b.max, Math.max(b.min, num));
}

function normalize(raw: Partial<RuntimeSettings> | null | undefined): RuntimeSettings {
  const merged = { ...defaultSettings, ...(raw ?? {}) };
  // Numeric fields are clamped to BOUNDS; the boolean flag is coerced directly.
  const models = sanitizeModelAliases(merged.models);
  const defaultModel = pickSafeDefault(merged.defaultModel, models);
  // Fail-safe invariant (codex evt_20260818022809): the effective defaultModel
  // must ALWAYS be an enabled member of the returned list. pickSafeDefault's
  // platform-default fallback fires only when nothing is enabled — a hand-edited
  // all-disabled file must not yield "defaultModel: opus" while opus sits
  // disabled in the list. Re-enable it in place, or insert it if absent.
  // No-op on the save path: the hard gate already guarantees the default is
  // enabled before normalize runs.
  const modelsWithDefault = models.some((m) => m.alias === defaultModel && m.enabled)
    ? models
    : models.some((m) => m.alias === defaultModel)
      ? models.map((m) => (m.alias === defaultModel ? { ...m, enabled: true } : m))
      : [{ alias: defaultModel, enabled: true }, ...models];
  return {
    idleStopMs: clampField("idleStopMs", merged.idleStopMs),
    memoryMb: clampField("memoryMb", merged.memoryMb),
    cpuCores: clampField("cpuCores", merged.cpuCores),
    maxTurns: clampField("maxTurns", merged.maxTurns),
    maxWorkspaceMb: clampField("maxWorkspaceMb", merged.maxWorkspaceMb),
    maxClaudeHomeMb: clampField("maxClaudeHomeMb", merged.maxClaudeHomeMb),
    autoRebuildOnConfigDrift: Boolean(merged.autoRebuildOnConfigDrift),
    userMemoryQuotaBytes: clampField("userMemoryQuotaBytes", merged.userMemoryQuotaBytes),
    defaultModel,
    models: modelsWithDefault,
    // M4: nested compaction policy — boolean coerced, numerics clamped to the
    // same bands compact-policy.ts enforces for org overrides (fail-safe).
    contextCompaction: (() => {
      const raw = (merged as { contextCompaction?: Partial<RuntimeSettings["contextCompaction"]> }).contextCompaction;
      const cc = { ...defaultSettings.contextCompaction, ...(raw ?? {}) };
      const clamp = (v: unknown, min: number, max: number, dflt: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
      };
      return {
        enabled: Boolean(cc.enabled),
        thresholdTokens: clamp(cc.thresholdTokens, 1_000, 1_000_000, defaultSettings.contextCompaction.thresholdTokens),
        keepRecentTurns: clamp(cc.keepRecentTurns, 1, 100, defaultSettings.contextCompaction.keepRecentTurns),
      };
    })(),
  };
}

function readFromDisk(): RuntimeSettings {
  if (!fs.existsSync(SETTINGS_FILE)) return { ...defaultSettings };
  try {
    return normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")));
  } catch (err) {
    console.warn("[RuntimeSettings] Failed to parse runtime-settings.json, using defaults:", err);
    return { ...defaultSettings };
  }
}

// ─── Public API ──────────────────────────────────────────────

/** Returns the effective runtime settings (cached; reload via getRuntimeSettings(true)). */
export function getRuntimeSettings(forceReload = false): RuntimeSettings {
  if (cache === null || forceReload) {
    cache = readFromDisk();
  }
  return { ...cache };
}

/** Validates, persists, and returns the merged settings. Partial updates allowed.
 *  Stage 2 hard gate: the MERGED defaultModel must reference an ENABLED alias —
 *  rejects both an unknown default AND disabling the alias that is currently
 *  default without switching the default first (throws; PUT route renders 400). */
export function saveRuntimeSettings(patch: Partial<RuntimeSettings>): RuntimeSettings {
  const current = getRuntimeSettings();
  const merged = { ...current, ...patch };
  // Validate the REQUESTED default against the REQUESTED list — normalize's
  // pickSafeDefault would silently repair it, so the hard gate must run first.
  const models = sanitizeModelAliases(merged.models);
  const wantedDefault = typeof merged.defaultModel === "string" ? merged.defaultModel.trim() : current.defaultModel;
  if (!models.some((m) => m.alias === wantedDefault && m.enabled)) {
    throw new Error(
      `Invalid defaultModel "${wantedDefault}" — must be an enabled model alias (enabled: ${models.filter((m) => m.enabled).map((m) => m.alias).join(", ") || "none"})`
    );
  }
  const candidate = normalize(merged);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(candidate, null, 2) + "\n");
  cache = candidate;
  console.log(`[RuntimeSettings] Saved: idleStopMs=${candidate.idleStopMs}, memoryMb=${candidate.memoryMb}, cpuCores=${candidate.cpuCores}, maxTurns=${candidate.maxTurns}, defaultModel=${candidate.defaultModel}`);
  return { ...candidate };
}

// ─── M3-S1: local-sandbox (MicroVM) config validation ───────────────────────
//
// Additive only — NO new admin settings surface (M0.5 freeze: phase-1 adds no
// config). This validator derives + checks the values a `local-sandbox`
// runtime would consume from the EXISTING settings, so RUNTIME_MODE=local-sandbox
// wiring (next M3 stage) has a single fail-closed gate. Default mode stays
// `local`; docker is untouched.

import { RESOURCE_BOUNDS, WORKSPACE_QUOTA_BOUNDS } from "./microsandbox-policy.js";

export interface LocalSandboxConfig {
  memoryMb: number;
  cpuCores: number;
  maxTurns: number;
  idleStopMs: number;
  defaultModel: string;
  /** M3 closure: hard workspace write quota (msb mount quota, MB). */
  maxWorkspaceMb: number;
}

/**
 * Validate the local-sandbox view of the current settings. Throws when any
 * value falls outside the MicroVM resource envelope (fail closed — the caller
 * must refuse to start the runtime, never clamp silently here).
 */
export function validateLocalSandboxSettings(settings: RuntimeSettings): LocalSandboxConfig {
  if (settings.memoryMb < RESOURCE_BOUNDS.minMemoryMb || settings.memoryMb > RESOURCE_BOUNDS.maxMemoryMb) {
    throw new Error(
      `local-sandbox memoryMb ${settings.memoryMb} outside MicroVM envelope [${RESOURCE_BOUNDS.minMemoryMb}, ${RESOURCE_BOUNDS.maxMemoryMb}]`,
    );
  }
  if (settings.cpuCores < RESOURCE_BOUNDS.minCpuCores || settings.cpuCores > RESOURCE_BOUNDS.maxCpuCores) {
    throw new Error(
      `local-sandbox cpuCores ${settings.cpuCores} outside MicroVM envelope [${RESOURCE_BOUNDS.minCpuCores}, ${RESOURCE_BOUNDS.maxCpuCores}]`,
    );
  }
  if (
    !Number.isInteger(settings.maxWorkspaceMb) ||
    settings.maxWorkspaceMb < WORKSPACE_QUOTA_BOUNDS.minMb ||
    settings.maxWorkspaceMb > WORKSPACE_QUOTA_BOUNDS.maxMb
  ) {
    throw new Error(
      `local-sandbox maxWorkspaceMb ${settings.maxWorkspaceMb} outside hard-quota bounds [${WORKSPACE_QUOTA_BOUNDS.minMb}, ${WORKSPACE_QUOTA_BOUNDS.maxMb}] MB (integer)`,
    );
  }
  return {
    memoryMb: settings.memoryMb,
    cpuCores: settings.cpuCores,
    maxTurns: settings.maxTurns,
    idleStopMs: settings.idleStopMs,
    defaultModel: settings.defaultModel,
    maxWorkspaceMb: settings.maxWorkspaceMb,
  };
}
