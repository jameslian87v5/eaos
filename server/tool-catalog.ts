/**
 * tool-catalog.ts — SDK built-in tool definitions.
 *
 * Extracted from capability-provider.ts to avoid circular imports:
 *   capability-provider → agent-profile-store → capability-provider
 *   capability-provider → application-service → capability-provider
 *
 * This module has NO dependencies on other server modules, so it can be
 * safely imported from anywhere.
 */

export interface ToolCatalogEntry {
  name: string;
  description: string;
  risk: "none" | "low" | "high";
  supported: boolean;       // false = SDK has it but platform doesn't support yet
  defaultEnabled: boolean;  // in DEFAULT_PROFILE.tools
  requiresApproval: boolean; // not in DEFAULT_PROFILE.allowedTools
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: "Read",            description: "Read files",              risk: "none", supported: true,  defaultEnabled: true,  requiresApproval: false },
  { name: "Grep",            description: "Search file contents",    risk: "none", supported: true,  defaultEnabled: true,  requiresApproval: false },
  { name: "Glob",            description: "File pattern matching",   risk: "none", supported: true,  defaultEnabled: true,  requiresApproval: false },
  { name: "WebSearch",       description: "Web search",              risk: "none", supported: true,  defaultEnabled: true,  requiresApproval: false },
  { name: "WebFetch",        description: "Fetch a URL (SSRF risk)", risk: "high", supported: true,  defaultEnabled: true,  requiresApproval: true  },
  { name: "Write",           description: "Write files",             risk: "high", supported: true,  defaultEnabled: true,  requiresApproval: true  },
  { name: "Edit",            description: "Edit files",              risk: "high", supported: true,  defaultEnabled: true,  requiresApproval: true  },
  { name: "Bash",            description: "Execute shell commands",  risk: "high", supported: true,  defaultEnabled: true,  requiresApproval: true  },
  { name: "NotebookEdit",    description: "Edit Jupyter notebooks",  risk: "high", supported: false, defaultEnabled: false, requiresApproval: true  },
  { name: "TodoWrite",       description: "Task list management",    risk: "none", supported: false, defaultEnabled: false, requiresApproval: false },
  { name: "Task",            description: "Sub-agent tasks",         risk: "none", supported: false, defaultEnabled: false, requiresApproval: false },
  { name: "AskUserQuestion", description: "Ask user a question",     risk: "none", supported: false, defaultEnabled: false, requiresApproval: false },
];

export const SUPPORTED_TOOL_NAMES = new Set(
  TOOL_CATALOG.filter((t) => t.supported).map((t) => t.name)
);
