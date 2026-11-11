/**
 * mcp-config.ts — reads data/mcp.json and resolves local stdio MCP server packages.
 *
 * Phase 3 (MP3a). Mirrors skill-config.ts 1:1 in structure and security model:
 *   - All MCP paths must resolve within the project's mcp/ directory (realpath).
 *   - Only type "local" (stdio) is supported in MVP (remote SSE/HTTP rejected).
 *   - Each package must contain an executable `run.sh` entry point.
 *   - `command` is NEVER read from config — the backend always generates
 *     `/opt/agent/mcp/<name>/run.sh`, so the container's /opt/agent/mcp/ prefix
 *     guard in agent-entry.ts holds and no arbitrary command can be injected.
 *   - No API accepts arbitrary host paths or commands from the frontend.
 *
 * Together with capability-provider.ts setting strictMcpConfig:true, MCP servers
 * reach the SDK ONLY via registry → resolve() → mcpServers option; the SDK's own
 * file discovery (.mcp.json in cwd / user settings / plugins) is disabled. See
 * docs/03-modules/mcp-import-guide.md and the MP3 Codex review.
 */

import path from "path";
import fs from "fs";

const PROJECT_ROOT = process.cwd();
const MCP_ROOT = path.resolve(PROJECT_ROOT, "mcp");
const MCP_CONFIG = process.env.MCP_CONFIG_FILE || path.resolve(PROJECT_ROOT, "data", "mcp.json");

// Ensure mcp/ directory exists (fresh clone / empty dir), mirroring skill-config.
fs.mkdirSync(MCP_ROOT, { recursive: true });

// Valid MCP name: same rule as skills — no path separators (prevents traversal
// in container path construction /opt/agent/mcp/<name>).
const VALID_MCP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// ─── Types ───────────────────────────────────────────────────

export interface McpConfigEntry {
  name: string;
  type: "local";
  enabled: boolean;
  path: string;
  description?: string;
}

export interface ResolvedMcpServer extends McpConfigEntry {
  absolutePath: string;
  containerPath: string; // /opt/agent/mcp/<name>
  command: string; // /opt/agent/mcp/<name>/run.sh (backend-generated, never from config)
  args: string[]; // [] (reserved; MVP has no per-server args)
  version?: string;
  valid: boolean;
  error?: string;
}

// ─── Internal helpers ────────────────────────────────────────

function loadConfig(): McpConfigEntry[] {
  if (!fs.existsSync(MCP_CONFIG)) return [];
  try {
    return JSON.parse(fs.readFileSync(MCP_CONFIG, "utf8")) as McpConfigEntry[];
  } catch (err) {
    console.warn("[McpConfig] Failed to parse data/mcp.json:", err);
    return [];
  }
}

function resolveAndValidatePath(mcpPath: string): string {
  if (!fs.existsSync(MCP_ROOT)) {
    throw new Error("mcp/ directory does not exist");
  }
  const candidate = path.resolve(PROJECT_ROOT, mcpPath);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Path does not exist: ${mcpPath}`);
  }
  const realCandidate = fs.realpathSync(candidate);
  const realRoot = fs.realpathSync(MCP_ROOT);
  if (!realCandidate.startsWith(realRoot + path.sep) && realCandidate !== realRoot) {
    throw new Error(`Path escapes mcp/ directory: ${mcpPath}`);
  }
  return realCandidate;
}

function invalid(cfg: McpConfigEntry, error: string): ResolvedMcpServer {
  return { ...cfg, absolutePath: "", containerPath: "", command: "", args: [], valid: false, error };
}

function resolveOne(cfg: McpConfigEntry): ResolvedMcpServer {
  // Type gate: only local stdio in MVP (remote SSE/HTTP deferred to Phase 3+).
  if (cfg.type !== "local") {
    return invalid(cfg, `type "${cfg.type}" not supported (only "local" in MVP)`);
  }

  // Name validation — prevents path traversal in container path construction.
  if (!VALID_MCP_NAME.test(cfg.name)) {
    return invalid(cfg, `invalid mcp name "${cfg.name}": must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`);
  }

  let absolutePath: string;
  try {
    absolutePath = resolveAndValidatePath(cfg.path);
  } catch (err) {
    return invalid(cfg, (err as Error).message);
  }

  // Entry point: run.sh must exist AND be executable. The container prefix
  // guard requires command to start with /opt/agent/mcp/, so the entry is
  // invoked as /opt/agent/mcp/<name>/run.sh — it must be runnable as-is.
  const runSh = path.join(absolutePath, "run.sh");
  if (!fs.existsSync(runSh)) {
    return invalid(cfg, "run.sh entry point not found");
  }
  try {
    fs.accessSync(runSh, fs.constants.X_OK);
  } catch {
    return invalid(cfg, "run.sh is not executable");
  }

  // Optional package metadata (mcp.json). Not required for MVP — presence is
  // informative (version surfaces in diagnostics/admin); absence is fine.
  let version: string | undefined;
  let description: string | undefined;
  const manifestPath = path.join(absolutePath, "mcp.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (typeof manifest.version === "string") version = manifest.version;
      if (typeof manifest.description === "string") description = manifest.description;
    } catch {
      // Non-fatal: manifest is optional metadata; a broken one does not block.
    }
  }

  const containerPath = `/opt/agent/mcp/${cfg.name}`;
  return {
    ...cfg,
    description: description ?? cfg.description,
    absolutePath,
    containerPath,
    command: `${containerPath}/run.sh`, // backend-generated — NEVER read command from config
    args: [],
    version,
    valid: true,
  };
}

// ─── Public API ──────────────────────────────────────────────

/** Returns all MCP servers (enabled + disabled) for Admin UI display. */
export function getAllMcpServers(): ResolvedMcpServer[] {
  return loadConfig().map(resolveOne);
}

/** Returns only valid, enabled MCP servers for CapabilityProvider injection. */
export function getEnabledMcpServers(): ResolvedMcpServer[] {
  return loadConfig()
    .filter((cfg) => cfg.enabled)
    .map(resolveOne)
    .filter((m) => m.valid);
}

/**
 * Toggle an MCP server's enabled flag in data/mcp.json.
 * Writes back the full config. Returns the resolved server, or null if not found.
 * Only affects newly created runtimes (no hot reload) — same contract as skills.
 */
export function setMcpServerEnabled(name: string, enabled: boolean): ResolvedMcpServer | null {
  if (!VALID_MCP_NAME.test(name)) return null;
  const config = loadConfig();
  const entry = config.find((c) => c.name === name);
  if (!entry) return null;
  entry.enabled = enabled;
  fs.mkdirSync(path.dirname(MCP_CONFIG), { recursive: true });
  fs.writeFileSync(MCP_CONFIG, JSON.stringify(config, null, 2) + "\n");
  console.log(`[McpConfig] MCP server "${name}" ${enabled ? "enabled" : "disabled"} (effective on new runtimes)`);
  return resolveOne(entry);
}
