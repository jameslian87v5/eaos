/**
 * hook-plugin-config.ts — reads data/hook-plugins.json and resolves local
 * native hook plugin packages (Phase 6 A2, Route A).
 *
 * A hook plugin is a Claude Code native plugin package whose plugin.json declares
 * a `hooks` source (hooks/hooks.json by convention). It is mounted into the
 * container exactly like a skill plugin and discovered by the SDK `plugins`
 * option. Hook plugins are app-supplied trusted code — the platform does NOT
 * translate or define hook semantics; it only mounts the package and lets the
 * SDK run the hooks. Platform governance (deny-default mount isolation,
 * inline PreToolUse guard, container sandbox) bounds what the hook code can do.
 *
 * Security invariants (mirrors skill-config.ts):
 *   - All hook plugin paths must resolve within the project's hooks/ or plugins/ directory.
 *   - realpath() detects symlink escapes and ../traversal.
 *   - Only type "hook-plugin" is supported.
 *   - No API accepts arbitrary host paths from the frontend.
 *
 * Note on updatedInput: hook plugins MAY technically emit updatedInput to mutate
 * tool input (the SDK applies it before the platform inline guard sees the final
 * value — proven by the precedence experiment). The platform treats updatedInput
 * as an UNSUPPORTED trusted-code convention, NOT a security boundary. Path/tool
 * safety is enforced by the container sandbox (filesystem isolation, readonly
 * rootfs, cap drop) and the inline deny guard, not by hook precedence.
 */

import path from "path";
import fs from "fs";

const PROJECT_ROOT = process.cwd();
const HOOKS_ROOT = path.resolve(PROJECT_ROOT, "hooks");
// PLUGINS_ROOT: where Skill Hub / native plugin packages are installed
// (shared with skill-config.ts / capability-installer.ts). Production
// overrides this to a persistent disk (/var/lib/chit-agentos/plugins) so
// installed hook-plugins survive release switches / clean clones. Default =
// repo plugins/ for dev. A hook plugin installed via the admin API lands
// here under plugins/<name>; bundled repo plugins/ is for first-time seed.
const PLUGINS_ROOT = process.env.PLUGINS_ROOT
  ? path.resolve(process.env.PLUGINS_ROOT)
  : path.resolve(PROJECT_ROOT, "plugins");
const HOOK_PLUGINS_CONFIG = path.resolve(PROJECT_ROOT, "data", "hook-plugins.json");

// Ensure hooks/ + plugins/ roots exist (fresh clone / empty dir).
fs.mkdirSync(HOOKS_ROOT, { recursive: true });
fs.mkdirSync(PLUGINS_ROOT, { recursive: true });

// Valid hook plugin name: alphanumeric + . _ - only, no path separators.
const VALID_HOOK_PLUGIN_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// Hook events supported by the SDK (informational only — the platform does NOT
// restrict which events a hook plugin registers; this list is used for display
// and light validation that hooks.json declares at least one known event).
const KNOWN_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Setup",
  "PreCompact",
  "PermissionRequest",
  "PermissionDenied",
]);

// ─── Types ───────────────────────────────────────────────────

export interface HookPluginConfigEntry {
  name: string;
  type: "hook-plugin";
  enabled: boolean;
  path: string;
}

export interface ResolvedHookPlugin extends HookPluginConfigEntry {
  absolutePath: string;
  version: string;
  description: string;
  pluginName: string;
  declaredEvents: string[]; // hook events declared in hooks.json
  valid: boolean;
  error?: string;
}

// ─── Internal helpers ────────────────────────────────────────

function loadConfig(): HookPluginConfigEntry[] {
  if (!fs.existsSync(HOOK_PLUGINS_CONFIG)) return [];
  try {
    return JSON.parse(fs.readFileSync(HOOK_PLUGINS_CONFIG, "utf8")) as HookPluginConfigEntry[];
  } catch (err) {
    console.warn("[HookPluginConfig] Failed to parse data/hook-plugins.json:", err);
    return [];
  }
}

// Map a config `path` ("hooks/<name>" or "plugins/<name>") to the right
// runtime root. Mirrors skill-config.ts: in production PLUGINS_ROOT points
// at a persistent disk, so plugins/<name> must resolve there, not against
// the code checkout. realpath containment still rejects traversal escapes.
function rootForPath(pluginPath: string): string {
  const normalized = pluginPath.replace(/^\.\//, "");
  if (normalized.startsWith("hooks/") || normalized === "hooks") return HOOKS_ROOT;
  if (normalized.startsWith("plugins/") || normalized === "plugins") return PLUGINS_ROOT;
  return PROJECT_ROOT;
}

function resolveAndValidatePath(pluginPath: string): string {
  const root = rootForPath(pluginPath);
  // Resolve the path AGAINST the mapped root, not PROJECT_ROOT, so
  // "plugins/<name>" lands under PLUGINS_ROOT in production.
  const tail = pluginPath.replace(/^(hooks|plugins)\//, "");
  const candidate = path.resolve(root, tail);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Path does not exist: ${pluginPath} (resolved under ${root})`);
  }
  const realCandidate = fs.realpathSync(candidate);
  const allowedRoots = [HOOKS_ROOT, PLUGINS_ROOT];
  const withinAllowed = allowedRoots.some((root) => {
    if (!fs.existsSync(root)) return false;
    const realRoot = fs.realpathSync(root);
    return realCandidate.startsWith(realRoot + path.sep) || realCandidate === realRoot;
  });
  if (!withinAllowed) {
    throw new Error(`Path escapes hooks/ or plugins/ directory: ${pluginPath}`);
  }
  return realCandidate;
}

function invalid(cfg: HookPluginConfigEntry, absolutePath: string, pluginName: string, error: string): ResolvedHookPlugin {
  return {
    ...cfg,
    absolutePath,
    version: "",
    description: "",
    pluginName,
    declaredEvents: [],
    valid: false,
    error,
  };
}

export function resolveOne(cfg: HookPluginConfigEntry): ResolvedHookPlugin {
  // Type gate
  if (cfg.type !== "hook-plugin") {
    return invalid(cfg, "", "", `type "${cfg.type}" not supported (only "hook-plugin")`);
  }

  // Name validation — prevents path traversal in container path construction.
  if (!VALID_HOOK_PLUGIN_NAME.test(cfg.name)) {
    return invalid(cfg, "", "", `invalid hook plugin name "${cfg.name}": must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`);
  }

  let absolutePath: string;
  try {
    absolutePath = resolveAndValidatePath(cfg.path);
  } catch (err) {
    return invalid(cfg, "", "", (err as Error).message);
  }

  // Claude Code native plugin manifest location.
  const pluginJsonPath = path.join(absolutePath, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(pluginJsonPath)) {
    return invalid(cfg, absolutePath, "", ".claude-plugin/plugin.json not found");
  }

  let plugin: any;
  try {
    plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  } catch {
    return invalid(cfg, absolutePath, "", "plugin.json parse error");
  }

  const pluginName = typeof plugin.name === "string" ? plugin.name : "";
  if (pluginName !== cfg.name) {
    return invalid(cfg, absolutePath, pluginName, `plugin.name "${pluginName}" !== config name "${cfg.name}"`);
  }
  if (!plugin.version) {
    return invalid(cfg, absolutePath, pluginName, "plugin.version is required");
  }

  // Resolve the hooks config file. plugin.json `hooks` may be a string path
  // (e.g. "./hooks/hooks.json") or omitted (default hooks/hooks.json).
  const hooksDecl = typeof plugin.hooks === "string" ? plugin.hooks : "hooks/hooks.json";
  const hooksJsonPath = path.resolve(absolutePath, hooksDecl);
  if (!hooksJsonPath.startsWith(absolutePath + path.sep)) {
    return invalid(cfg, absolutePath, pluginName, "plugin.hooks must stay inside the plugin directory");
  }
  if (!fs.existsSync(hooksJsonPath) || !fs.statSync(hooksJsonPath).isFile()) {
    return invalid(cfg, absolutePath, pluginName, `${hooksDecl} not found`);
  }

  // Parse hooks.json and extract declared events. Plugin hooks.json uses the
  // wrapper format { description?, hooks: { <Event>: [...] } }.
  let hooksJson: any;
  try {
    hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
  } catch {
    return invalid(cfg, absolutePath, pluginName, `${hooksDecl} parse error`);
  }

  const eventMap = hooksJson && typeof hooksJson === "object" && hooksJson.hooks && typeof hooksJson.hooks === "object"
    ? hooksJson.hooks
    : null;
  if (!eventMap) {
    return invalid(cfg, absolutePath, pluginName, `${hooksDecl} must have a "hooks" object (plugin wrapper format)`);
  }

  const declaredEvents = Object.keys(eventMap);
  if (declaredEvents.length === 0) {
    return invalid(cfg, absolutePath, pluginName, `${hooksDecl} declares no hook events`);
  }

  // Light validation: warn (not reject) on unknown event names so future SDK
  // events are not hard-blocked by a stale allowlist.
  const unknown = declaredEvents.filter((e) => !KNOWN_HOOK_EVENTS.has(e));
  if (unknown.length > 0) {
    console.warn(
      `[HookPluginConfig] hook plugin "${cfg.name}" declares unknown event(s): ${unknown.join(", ")} (allowed, not blocked)`
    );
  }

  return {
    ...cfg,
    absolutePath,
    version: plugin.version,
    description: plugin.description || "",
    pluginName,
    declaredEvents,
    valid: true,
  };
}

// ─── Public API ──────────────────────────────────────────────

/** Returns all hook plugins (enabled + disabled) for Admin UI display. */
export function getAllHookPlugins(): ResolvedHookPlugin[] {
  return loadConfig().map(resolveOne);
}

/** Returns only valid, enabled hook plugins for CapabilityProvider injection. */
export function getEnabledHookPlugins(): ResolvedHookPlugin[] {
  return loadConfig()
    .filter((cfg) => cfg.enabled)
    .map(resolveOne)
    .filter((p) => p.valid);
}

/**
 * Toggle a hook plugin's enabled flag in data/hook-plugins.json.
 * Writes back the full config. Returns the resolved plugin, or null if not found.
 * Only affects newly created runtimes (no hot reload) — same contract as skills.
 */
export function setHookPluginEnabled(name: string, enabled: boolean): ResolvedHookPlugin | null {
  if (!VALID_HOOK_PLUGIN_NAME.test(name)) return null;
  const config = loadConfig();
  const entry = config.find((c) => c.name === name);
  if (!entry) return null;
  entry.enabled = enabled;
  fs.mkdirSync(path.dirname(HOOK_PLUGINS_CONFIG), { recursive: true });
  fs.writeFileSync(HOOK_PLUGINS_CONFIG, JSON.stringify(config, null, 2) + "\n");
  console.log(`[HookPluginConfig] Hook plugin "${name}" ${enabled ? "enabled" : "disabled"} (effective on new runtimes)`);
  return resolveOne(entry);
}
