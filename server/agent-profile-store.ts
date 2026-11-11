/**
 * agent-profile-store.ts — CRUD + resolution for reusable Agent Profiles
 * (Phase 5 MP5d).
 *
 * A Profile is a shareable prompt template (systemPrompt + appendSystemPrompt).
 * Multiple Agents point to one via `agents.profile_id`. resolve() precedence:
 *   per-Agent override (agents.system_prompt) > profile > platform default.
 *
 * `profile_id` has no hard FK, so a deleted profile degrades to "no profile"
 * (promptForAgent returns nulls) rather than erroring. deleteProfile also nulls
 * the dangling references for cleanliness.
 *
 * Like chat-store / event-store: singleton + prepared statements.
 */
import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import { getPromptSettings, sanitizePromptText } from "./prompt-settings.js";
import { SUPPORTED_TOOL_NAMES } from "./tool-catalog.js";
import type { AgentProfile, ToolsConfig } from "./types.js";

const stmts = {
  list: db.prepare(
    `SELECT id, org_id AS orgId, name, description, system_prompt AS systemPrompt,
            append_system_prompt AS appendSystemPrompt, tools_config AS toolsConfigRaw,
            created_at AS createdAt, updated_at AS updatedAt
     FROM agent_profiles ORDER BY created_at ASC`
  ),
  get: db.prepare(
    `SELECT id, org_id AS orgId, name, description, system_prompt AS systemPrompt,
            append_system_prompt AS appendSystemPrompt, tools_config AS toolsConfigRaw,
            created_at AS createdAt, updated_at AS updatedAt
     FROM agent_profiles WHERE id = ?`
  ),
  insert: db.prepare(
    `INSERT INTO agent_profiles (id, org_id, name, description, system_prompt, append_system_prompt, tools_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  listByOrg: db.prepare(
    `SELECT id, org_id AS orgId, name, description, system_prompt AS systemPrompt,
            append_system_prompt AS appendSystemPrompt, tools_config AS toolsConfigRaw,
            created_at AS createdAt, updated_at AS updatedAt
     FROM agent_profiles WHERE org_id = ? ORDER BY created_at ASC`
  ),
  deleteProfile: db.prepare(`DELETE FROM agent_profiles WHERE id = ?`),
  // Null dangling agents.profile_id references on delete (resolve() also tolerates
  // a dangling id, but this keeps the data clean).
  nullAgentRefs: db.prepare(`UPDATE agents SET profile_id = NULL, updated_at = ? WHERE profile_id = ?`),
  // resolve(): the prompt contributed by an Agent's assigned profile.
  promptForAgent: db.prepare(
    `SELECT p.system_prompt AS systemPrompt, p.append_system_prompt AS appendSystemPrompt,
            p.tools_config AS toolsConfigRaw
     FROM agents a JOIN agent_profiles p ON p.id = a.profile_id WHERE a.id = ?`
  ),
};

function parseToolsConfig(raw: string | null): ToolsConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.tools) && Array.isArray(parsed.allowedTools)) {
      return {
        tools: parsed.tools,
        allowedTools: parsed.allowedTools,
        disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      };
    }
  } catch {
    // malformed JSON — treat as null
  }
  return null;
}

function validateToolsConfig(config: ToolsConfig): void {
  for (const t of config.tools) {
    if (!SUPPORTED_TOOL_NAMES.has(t)) {
      throw new Error(`Unsupported tool in tools_config: ${t}`);
    }
  }
  for (const t of config.allowedTools) {
    if (!config.tools.includes(t)) {
      throw new Error(`allowedTools contains tool not in tools: ${t}`);
    }
  }
  for (const t of config.disallowedTools) {
    if (!SUPPORTED_TOOL_NAMES.has(t)) {
      throw new Error(`Unsupported tool in disallowedTools: ${t}`);
    }
    if (!config.tools.includes(t)) {
      throw new Error(`disallowedTools contains tool not in tools: ${t}`);
    }
  }
  const overlap = config.allowedTools.filter((t) => config.disallowedTools.includes(t));
  if (overlap.length > 0) {
    throw new Error(`allowedTools and disallowedTools overlap: ${overlap.join(", ")}`);
  }
}

// Deserialize toolsConfigRaw on read
function mapProfile(row: any): AgentProfile {
  return { ...row, toolsConfig: parseToolsConfig(row.toolsConfigRaw ?? null) };
}

class AgentProfileStore {
  list(): AgentProfile[] {
    return stmts.list.all().map(mapProfile);
  }

  /** Phase 7.2: org-scoped list for org_admin (own-org profiles only). */
  listByOrg(orgId: string): AgentProfile[] {
    return stmts.listByOrg.all(orgId).map(mapProfile);
  }

  get(id: string): AgentProfile | undefined {
    const row = stmts.get.get(id);
    return row ? mapProfile(row) : undefined;
  }

  create(input: {
    name: string;
    description?: string | null;
    systemPrompt?: string | null;
    appendSystemPrompt?: string | null;
    toolsConfig?: ToolsConfig | null;
    orgId?: string;
  }): AgentProfile {
    const name = input.name?.trim();
    if (!name) throw new Error("Profile name required");
    const id = uuidv4();
    const now = new Date().toISOString();
    const orgId = input.orgId ?? "default-org";
    const systemPrompt =
      input.systemPrompt == null ? null : this.boundPromptText(sanitizePromptText(input.systemPrompt), "systemPrompt");
    const appendSystemPrompt =
      input.appendSystemPrompt == null
        ? null
        : this.boundPromptText(sanitizePromptText(input.appendSystemPrompt), "appendSystemPrompt");
    let toolsConfigJson: string | null = null;
    if (input.toolsConfig) {
      validateToolsConfig(input.toolsConfig);
      toolsConfigJson = JSON.stringify(input.toolsConfig);
    }
    stmts.insert.run(id, orgId, name, input.description ?? null, systemPrompt, appendSystemPrompt, toolsConfigJson, now, now);
    return this.get(id)!;
  }

  update(
    id: string,
    fields: {
      name?: string;
      description?: string | null;
      systemPrompt?: string | null;
      appendSystemPrompt?: string | null;
      toolsConfig?: ToolsConfig | null;
    }
  ): AgentProfile | undefined {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if (fields.name !== undefined) {
      const name = fields.name.trim();
      sets.push("name = ?");
      vals.push(name || "Untitled");
    }
    if (fields.description !== undefined) {
      sets.push("description = ?");
      vals.push(fields.description == null ? null : sanitizePromptText(fields.description));
    }
    if (fields.systemPrompt !== undefined) {
      const text =
        fields.systemPrompt == null ? null : this.boundPromptText(sanitizePromptText(fields.systemPrompt), "systemPrompt");
      sets.push("system_prompt = ?");
      vals.push(text);
    }
    if (fields.appendSystemPrompt !== undefined) {
      const text =
        fields.appendSystemPrompt == null
          ? null
          : this.boundPromptText(sanitizePromptText(fields.appendSystemPrompt), "appendSystemPrompt");
      sets.push("append_system_prompt = ?");
      vals.push(text);
    }
    if (fields.toolsConfig !== undefined) {
      if (fields.toolsConfig) {
        validateToolsConfig(fields.toolsConfig);
        sets.push("tools_config = ?");
        vals.push(JSON.stringify(fields.toolsConfig));
      } else {
        sets.push("tools_config = ?");
        vals.push(null);
      }
    }
    if (sets.length === 0) return this.get(id);
    sets.push("updated_at = ?");
    vals.push(new Date().toISOString());
    vals.push(id);
    db.prepare(`UPDATE agent_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.get(id);
  }

  deleteProfile(id: string): boolean {
    const result = stmts.deleteProfile.run(id);
    if (result.changes > 0) {
      stmts.nullAgentRefs.run(new Date().toISOString(), id);
    }
    return result.changes > 0;
  }

  /**
   * The prompt contributed by an Agent's assigned profile (null fields if the
   * Agent has no profile or the profile was deleted). Consumed by
   * CapabilityProvider.resolve() (preference: per-Agent > profile > platform)
   * and by computeConfigVersion.
   */
  promptForAgent(agentId: string): { systemPrompt: string | null; appendSystemPrompt: string | null } {
    const row = stmts.promptForAgent.get(agentId) as
      | { systemPrompt: string | null; appendSystemPrompt: string | null }
      | undefined;
    return row ?? { systemPrompt: null, appendSystemPrompt: null };
  }

  /**
   * The tools_config contributed by an Agent's assigned profile (null if the
   * Agent has no profile, the profile was deleted, or the profile has no
   * tools_config override). Consumed by CapabilityProvider.resolve().
   */
  toolsConfigForAgent(agentId: string): ToolsConfig | null {
    const row = stmts.promptForAgent.get(agentId) as
      | { toolsConfigRaw: string | null }
      | undefined;
    return row ? parseToolsConfig(row.toolsConfigRaw) : null;
  }

  private boundPromptText(text: string, field: string): string {
    const max = getPromptSettings().maxSystemPromptChars;
    if (text.length > max) {
      throw new Error(`${field} too long: ${text.length} > maxSystemPromptChars(${max})`);
    }
    return text;
  }
}

export const agentProfileStore = new AgentProfileStore();
