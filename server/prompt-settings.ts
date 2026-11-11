/**
 * prompt-settings.ts — local, file-backed platform-default prompt configuration.
 *
 * Phase 2e (migration plan §2e / capability-injection-paths.md §6): turns the
 * previously hard-coded prompts in capability-provider.ts into a config item,
 * following the same file-backed pattern as runtime-settings.ts. Defaults mirror
 * the previous constants EXACTLY, so behavior is unchanged until an admin edits.
 *
 * Composition (capability-injection-paths.md §6), assembled at resolve() time in
 * capability-provider.ts:
 *   final.systemPrompt       = promptSettings.systemPrompt + dynamic(A2UI preamble)
 *   final.appendSystemPrompt = promptSettings.appendBase
 *                            + dynamic skill manifest (always last, system-owned)
 *                            + dynamic(A2UI instruction)
 * This module holds ONLY the static, admin-editable platform text. The dynamic
 * layers (A2UI preamble/instruction, skill manifest) are NOT editable here — they
 * are computed at resolve() time so user-supplied text can never remove or spoof
 * the capability/skill listing.
 *
 * Effect rules:
 *   - systemPrompt / appendBase apply to NEW runtimes only (no hot reload),
 *     consistent with all other capability changes.
 *   - configVersion (capability-version.ts) folds these fields in, so a prompt
 *     edit is detected as drift by MP4c diagnostics on the next warm-resume.
 *
 * Hermetic testing: PROMPT_SETTINGS_FILE env overrides the on-disk path
 * (same convention as ENTITLEMENTS_FILE / AGENT_CAPABILITIES_FILE).
 */

import path from "path";
import fs from "fs";

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
const SETTINGS_FILE =
  process.env.PROMPT_SETTINGS_FILE || path.resolve(DATA_DIR, "prompt-settings.json");

// ─── Types ───────────────────────────────────────────────────

export interface PromptSettings {
  systemPrompt: string;
  appendBase: string;
  maxSystemPromptChars: number;
}

// Defaults mirror the previous hard-coded constants in capability-provider.ts
// (base text only — A2UI preamble/instruction are dynamic layers added at
// resolve() time, NOT part of this editable text).
export const defaultPromptSettings: PromptSettings = {
  systemPrompt:
    "你是企业内部 AI Agent，运行在隔离的 Docker workspace 中。" +
    "你可以帮助用户分析文件、编辑内容、生成结果，并在需要时使用工具完成任务。\n\n",
  appendBase:
    "重要：你运行在 Docker 容器中，当前工作目录（cwd）是 /workspace。\n" +
    "所有文件操作必须基于 /workspace 目录。不要猜测或编造其他路径。\n" +
    "如果你不确定目录内容，请先执行 `pwd` 和 `ls /workspace`。\n" +
    "用户上传文件位于 /workspace/input。\n" +
    "生成文件请保存到 /workspace/output。\n" +
    "运行时依赖应安装在 /workspace 内，例如 node_modules、.venv、.cache。\n" +
    "如需写文件、编辑文件或执行 Bash，系统可能要求用户确认。",
  maxSystemPromptChars: 8000,
};

// Bound for the maxSystemPromptChars knob itself.
const MAX_CHARS_BOUND = { min: 256, max: 50000 };

// ─── Internal helpers ────────────────────────────────────────

let cache: PromptSettings | null = null;

/** Strip C0 control chars except tab/newline/CR (rejects null bytes, ESC, etc.).
 *  Per capability-injection-paths.md §6 "strip or reject control characters".
 *  Exported so per-Agent prompt overrides (MP5b) reuse the SAME sanitization as
 *  the platform default. */
export function sanitizePromptText(s: unknown): string {
  if (typeof s !== "string") return "";
  /* eslint-disable no-control-regex */
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  /* eslint-enable no-control-regex */
}

function clampMaxChars(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultPromptSettings.maxSystemPromptChars;
  return Math.min(MAX_CHARS_BOUND.max, Math.max(MAX_CHARS_BOUND.min, num));
}

function normalize(raw: Partial<PromptSettings> | null | undefined): PromptSettings {
  const merged = { ...defaultPromptSettings, ...(raw ?? {}) };
  return {
    systemPrompt: sanitizePromptText(merged.systemPrompt),
    appendBase: sanitizePromptText(merged.appendBase),
    maxSystemPromptChars: clampMaxChars(merged.maxSystemPromptChars),
  };
}

function readFromDisk(): PromptSettings {
  if (!fs.existsSync(SETTINGS_FILE)) return { ...defaultPromptSettings };
  try {
    return normalize(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")));
  } catch (err) {
    console.warn("[PromptSettings] Failed to parse prompt-settings.json, using defaults:", err);
    return { ...defaultPromptSettings };
  }
}

// ─── Public API ──────────────────────────────────────────────

/** Returns the effective prompt settings (cached; reload via getPromptSettings(true)). */
export function getPromptSettings(forceReload = false): PromptSettings {
  if (cache === null || forceReload) {
    cache = readFromDisk();
  }
  return { ...cache };
}

/**
 * Validates, persists, and returns the merged prompt settings. Partial updates
 * allowed. Rejects oversized systemPrompt (> maxSystemPromptChars) per §6 length
 * bounds. Only affects newly created runtimes (no hot reload).
 */
export function savePromptSettings(patch: Partial<PromptSettings>): PromptSettings {
  const current = getPromptSettings();
  const next = normalize({ ...current, ...patch });
  if (next.systemPrompt.length > next.maxSystemPromptChars) {
    throw new Error(
      `systemPrompt too long: ${next.systemPrompt.length} > maxSystemPromptChars(${next.maxSystemPromptChars})`
    );
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
  cache = next;
  console.log(
    `[PromptSettings] Saved: systemPrompt ${next.systemPrompt.length} chars, appendBase ${next.appendBase.length} chars (effective on new runtimes)`
  );
  return { ...next };
}
