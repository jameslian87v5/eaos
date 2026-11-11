/**
 * CapabilityProvider — local default implementation
 *
 * Per enterprise-mvp-technical-architecture.md §3.6 and §6:
 * - MVP only needs a LocalCapabilityProvider reading from config/defaults.
 * - Front-end must NOT decide tools/plugins/mcpServers directly.
 * - Future: RemoteCapabilityProvider calls an external Skill/MCP hub.
 *
 * Path conventions for future plugin/mcp/config:
 *   /opt/agent/plugins/<pluginId>  — skill packages (readonly mount)
 *   /opt/agent/mcp/<mcpId>         — local MCP server binaries (readonly mount)
 *   /opt/agent/config              — injected config files (readonly mount)
 *   /workspace/input               — user uploaded files (NOT a capability source)
 *   /workspace/output              — agent produced files
 */

import { getEnabledPlugins, type ResolvedSkill } from "./skill-config.js";
import { getEnabledMcpServers, type ResolvedMcpServer } from "./mcp-config.js";
import { getEnabledHookPlugins, type ResolvedHookPlugin } from "./hook-plugin-config.js";
import { getRuntimeSettings } from "./runtime-settings.js";
// M2: effective model precedence (Chat > Agent > org > platform). model-catalog
// imports database/org-governance/runtime-settings only — no cycle with this module.
import { resolveEffectiveModel } from "./model-catalog.js";
// M5: org-level max_turns_per_runtime quota caps the global maxTurns at resolve.
import { getQuota } from "./quota-service.js";
import { getPromptSettings } from "./prompt-settings.js";
import { A2UI_INSTRUCTION, A2UI_SYSTEM_PROMPT_PREAMBLE, isA2UIEnabled } from "./a2ui-prompt.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { applicationService } from "./application-service.js";
import { agentService } from "./agent-service.js";
import { agentProfileStore } from "./agent-profile-store.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";
import * as userMemoryService from "./user-memory-service.js";
import { buildUserMemoryPrompt } from "./user-memory-prompt.js";
// Octop absorption M1b: connector injection (internal MCP + capability token).
import { getCatalogEntry, listInstances } from "./connector-store.js";
import { mintConnectorToken } from "./connector-capability-token.js";

function connectorMcpBaseUrl(): string {
  // Container→host egress endpoint for the internal MCP route. Override for
  // non-Docker-Desktop hosts (e.g. a LAN address or an nginx front).
  return process.env.CONNECTOR_MCP_BASE_URL || `http://host.docker.internal:${process.env.PORT || 3001}`;
}

// ─── Types ──────────────────────────────────────────────────

export interface CapabilityResolveContext {
  orgId?: string;
  userId?: string;
  chatId?: string;
  role?: "admin" | "user";
  profileId?: string;
  runtimeType?: "local" | "docker";
}

export interface CapabilityMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface CapabilityBundle {
  sdkOptions: {
    plugins?: Array<{ type: "local"; path: string }>;
    mcpServers?: Record<string, unknown>;
    // Phase 3: platform invariant — when true the SDK ignores ALL file-based MCP
    // discovery (project .mcp.json, user settings, plugins, managed-mcp.json) and
    // uses ONLY the mcpServers option we emit here. Prevents a planted
    // /workspace/.mcp.json from bypassing the control plane. Always true.
    strictMcpConfig?: boolean;
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    // SDK 0.2.120+: single place to turn skills on. Replaces passing 'Skill' in allowedTools (deprecated since 0.2.133).
    skills?: string[] | "all";
    systemPrompt?: string;
    appendSystemPrompt?: string;
    additionalDirectories?: string[];
    maxTurns?: number;
    // M2 (model selection, plan §3.2): the EFFECTIVE model alias resolved by
    // CapabilityProvider.resolve (Chat > Agent > org > platform, each level
    // validated 平台启用 ∩ 组织授权). Set ONLY here — the single control→data
    // injection point; nothing client-supplied can reach this field.
    // Consumers: local (LocalAgentRuntime → AgentSessionOptions.model) and
    // docker (AGENT_SDK_OPTIONS → agent-entry sdkOptions.model).
    model?: string;
  };
  mounts: CapabilityMount[];
  env: Record<string, string>;
}

export interface ToolProfile {
  name: string;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  approvalRequiredTools: string[];
  description: string;
}

/**
 * CapabilityProvider — resolves the capability bundle for a given context.
 * MVP: only LocalCapabilityProvider exists. A future HubCapabilityProvider
 * will implement the same interface so downstream callers stay unchanged.
 */
export interface CapabilityProvider {
  resolve(context?: CapabilityResolveContext): CapabilityBundle;
  getDefaultProfile(): ToolProfile;
  listProfiles(): ToolProfile[];
}

// Phase 6 (A2, Route A) rollout gate (Codex evt_20260630_hook_route_a_tech_plan
// finding 5): native in-container hook plugin code stays OFF until container
// hardening (egress allowlist / cap drop / pids limit / readonly rootfs) lands.
// Set HOOK_PLUGINS_ENABLED=true to opt in for dev / trusted-internal only.
function isHookPluginsEnabled(): boolean {
  return process.env.HOOK_PLUGINS_ENABLED === "true";
}

// ─── Tool Catalog ───────────────────────────────────────────
// Tool catalog extracted to tool-catalog.ts to avoid circular imports.
// Re-exported here for backward compatibility.
export { TOOL_CATALOG, SUPPORTED_TOOL_NAMES, type ToolCatalogEntry } from "./tool-catalog.js";

// ─── Default sandbox profile ────────────────────────────────

const DEFAULT_PROFILE: ToolProfile = {
  name: "default-sandbox",
  // The Skill tool is enabled via the SDK `skills` option (set in resolve()), not by listing it here.
  // Web search/fetch are platform built-in tools served by the in-process MCP
  // server `platform-web-tools` (server/platform-web-tools.ts). We expose the
  // FULL SDK tool names so the PreToolUse hook and app allowlists key by the
  // same identifier the model emits. Bailian search is auto-allowed (read-only,
  // SSRF-safe upstream); web_fetch requires approval (egress + content risk).
  // The SDK-provided WebSearch/WebFetch are removed so the model sees ONE pair.
  tools: [
    "Read", "Grep", "Glob", "Write", "Edit", "Bash",
    "mcp__platform-web-tools__bailian_search",
    "mcp__platform-web-tools__web_fetch",
  ],
  // Skill invocation only loads skill instructions — auto-allowed in the runtime PreToolUse hook (no destructive side effect).
  // web_fetch is NOT auto-allowed (SSRF/data exfiltration risk — requires approval).
  allowedTools: ["Read", "Grep", "Glob", "mcp__platform-web-tools__bailian_search"],
  disallowedTools: [],
  approvalRequiredTools: ["Write", "Edit", "Bash", "mcp__platform-web-tools__web_fetch"],
  description:
    "Full workspace tools + platform web tools (bailian_search/web_fetch via in-process MCP). Read/Grep/Glob/bailian_search auto-allowed; Write/Edit/Bash/web_fetch require approval.",
};

// Platform-default prompts now live in data/prompt-settings.json (Phase 2e).
// The A2UI preamble/instruction are DYNAMIC layers (feature-flag driven), so
// they are composed at resolve() time below, not captured in a module constant —
// evaluating isA2UIEnabled() once at module load would freeze the flag and break
// the "new runtime picks up the current flag" contract. See prompt-settings.ts.
function buildAppendSystemPrompt(appendBase: string, enabledSkills: ResolvedSkill[]): string {
  let prompt = appendBase;

  if (enabledSkills.length > 0) {
    const skillLines = enabledSkills.flatMap((skill) =>
      skill.declaredSkillNames.map((skillName) => {
        const description = skill.description ? ` — ${skill.description}` : "";
        return `- ${skillName} (plugin: ${skill.name})${description}`;
      })
    );
    prompt +=
      `\n\n当前平台预装并启用的 Claude Code skills:\n${skillLines.join("\n")}\n` +
      "当用户询问你有哪些技能或当前启用了什么能力时，请基于上述列表回答；不要把目录可见性等同于 skill 已被发现。";
  }

  if (isA2UIEnabled()) {
    prompt += `\n\n${A2UI_INSTRUCTION}`;
  }

  return prompt;
}

// ─── LocalCapabilityProvider ────────────────────────────────

class LocalCapabilityProvider implements CapabilityProvider {
  /**
   * Resolve the CapabilityBundle for a given context.
   *
   * Deny-default (migration §10 + MP3 acceptance: "Runtime receives only the
   * Agent-enabled, entitled capabilities"). The skill set is driven entirely by
   * control-plane state: an Agent receives ONLY
   *     activation ∩ registry-enabled (skills.json) ∩ entitled (canConfigure).
   * An unconfigured Agent (no activation record, or empty activation) → 0 skills.
   * Entitlement is re-checked here as a revocation backstop: a revoked-but-still-
   * enabled resource is excluded from the next bundle.
   *
   * NOTE: this deliberately removes the earlier "no-activation ⇒ all enabled
   * skills" legacy fallback. That fallback was allow-default and contradicted the
   * deny-default mount-isolation principle (§10), making workbench toggles
   * non-deterministic (unconfigured agents silently received every skill).
   *
   * This bundle is consumed only by the Docker runtime (docker-runtime.ts);
   * the local AgentSession (ai-client.ts) does not use capability injection.
   */
  resolve(context?: CapabilityResolveContext): CapabilityBundle {
    // Deny-default: an Agent gets ONLY activation ∩ registry-enabled ∩ entitled.
    // No activation record (or empty activation) → 0 skills. See doc comment above.
    const agentId = context?.chatId; // chatId === agentId compatibility bridge
    let enabledSkills: ResolvedSkill[] = [];
    let enabledMcp: ResolvedMcpServer[] = [];
    let enabledHookPlugins: ResolvedHookPlugin[] = [];
    let gatedIds = new Set<string>();
    // Phase 6 (A0/A2): appId resolved from DB (agents.app_id) — used for
    // capability gating (app allowlist ∩ entitlement ∩ activation).
    const appId = agentId ? applicationService.getAppIdForAgent(agentId) : "default-app";
    if (agentId) {
      const actx: RequestContext = {
        userId: context?.userId ?? "",
        role: context?.role ?? "user",
        orgId: context?.orgId ?? DEFAULT_ORG_ID,
      };
      // Deny-default: skills AND MCP are gated by the SAME activation∩entitled∩app
      // allowlist set (resolveEnabledResourceIds returns resource ids regardless of type).
      gatedIds = new Set(
        agentCapabilityService.resolveEnabledResourceIdsForApp(actx, agentId, appId)
      );
      enabledSkills = getEnabledPlugins().filter((s) => gatedIds.has(s.name));
      enabledMcp = getEnabledMcpServers().filter((m) => gatedIds.has(m.name));
      // Phase 6 (A2, Route A): hook plugins gated by the SAME intersection set.
      // Rollout gate (Codex evt_20260630_hook_route_a_tech_plan finding 5):
      // native in-container hook code stays OFF until container hardening lands.
      // HOOK_PLUGINS_ENABLED=true opts in (dev / trusted-internal only).
      enabledHookPlugins = isHookPluginsEnabled()
        ? getEnabledHookPlugins().filter((p) => gatedIds.has(p.name))
        : [];

      // Defensive resourceId collision guard. The resource pool marks collisions
      // invalid (so they can't be freshly activated), but a pre-existing
      // activation could match a skill, an MCP, and/or a hook plugin of the same
      // name. Precedence: skill > mcp > hook-plugin. Drop the lower-precedence
      // duplicates so the bundle never emits the same id twice.
      const skillNameSet = new Set(enabledSkills.map((s) => s.name));
      enabledMcp = enabledMcp.filter((m) => {
        if (skillNameSet.has(m.name)) {
          console.warn(
            `[CapabilityProvider] MCP "${m.name}" collides with a skill of the same name — dropping MCP from bundle`
          );
          return false;
        }
        return true;
      });
      const mcpNameSet = new Set(enabledMcp.map((m) => m.name));
      enabledHookPlugins = enabledHookPlugins.filter((p) => {
        if (skillNameSet.has(p.name) || mcpNameSet.has(p.name)) {
          console.warn(
            `[CapabilityProvider] hook plugin "${p.name}" collides with a skill/mcp of the same name — dropping hook plugin from bundle`
          );
          return false;
        }
        return true;
      });

      console.log(
        `[CapabilityProvider] Agent ${agentId.slice(0, 8)}: deny-default → ${enabledSkills.length} skill(s)` +
          (enabledSkills.length ? `: ${enabledSkills.map((s) => s.name).join(", ")}` : "") +
          `, ${enabledMcp.length} mcp(s)` +
          (enabledMcp.length ? `: ${enabledMcp.map((m) => m.name).join(", ")}` : "") +
          `, ${enabledHookPlugins.length} hook-plugin(s)` +
          (enabledHookPlugins.length ? `: ${enabledHookPlugins.map((p) => p.name).join(", ")}` : "")
      );
    } else {
      // No agentId (module-level defaultBundle at startup) → deny-default baseline.
      console.log(`[CapabilityProvider] No agentId in context → deny-default 0 skills / 0 mcp`);
    }

    const plugins: Array<{ type: "local"; path: string }> = [];
    const mounts: CapabilityMount[] = [];
    const skillNames: string[] = [];
    for (const skill of enabledSkills) {
      const containerPath = `/opt/agent/plugins/${skill.name}`;
      plugins.push({ type: "local", path: containerPath });
      mounts.push({ hostPath: skill.absolutePath, containerPath, readonly: true });
      skillNames.push(...skill.declaredSkillNames);
    }

    // Phase 3: inject enabled MCP servers (deny-default + entitlement-gated, same
    // as skills). Backend-generated command keeps the /opt/agent/mcp/ prefix guard
    // valid; readonly mount = entitlement enforcement by physical isolation (an
    // unentitled MCP is simply not mounted, like an unentitled skill).
    const mcpServers: Record<string, unknown> = {};
    for (const mcp of enabledMcp) {
      mcpServers[mcp.name] = { command: mcp.command, args: mcp.args };
      mounts.push({ hostPath: mcp.absolutePath, containerPath: mcp.containerPath, readonly: true });
    }

    // Octop absorption M1b: internal-MCP connector injection — docker-class
    // runtimes ONLY (local keeps mcpServers empty; agent-entry's /opt/agent/mcp/
    // prefix guard intentionally does not apply — http entries carry no command).
    // Injection requires the FULL intersection: gatedIds (app allowlist ∩
    // activation ∩ entitlement ∩ registration) ∩ instance enabled ∩ credentials
    // present ∩ valid catalog kind. The ONLY secret entering the runtime is the
    // short-lived internal-mcp capability token (in the MCP header); raw
    // external credentials stay host-side forever.
    if (context?.runtimeType !== "local" && agentId) {
      for (const ci of listInstances()) {
        if (!gatedIds.has(`connector:${ci.id}`)) continue;
        if (ci.status !== "enabled" || !ci.credentialsPresent) continue;
        const entry = getCatalogEntry(ci.catalogKind);
        if (!entry) continue;
        const token = mintConnectorToken({
          orgId: context?.orgId ?? DEFAULT_ORG_ID,
          appId,
          agentId,
          runtimeKey: `${context?.userId ?? ""}:${agentId}`,
          connectorInstanceId: ci.id,
          allowedTools: entry.allowedTools,
          configVersion: ci.configVersion,
          userId: context?.userId ?? "",
          role: (context?.role ?? "user") as "admin" | "org_admin" | "user",
        });
        mcpServers[`connector-${ci.id}`] = {
          type: "http",
          url: `${connectorMcpBaseUrl()}/api/mcp/connectors/${ci.id}`,
          headers: { authorization: `Bearer ${token}` },
          // SDK contract: McpHttpServerConfig.tools is a tool POLICY array
          // ({name} objects), not string[] (M1b fix #3).
          tools: entry.allowedTools.map((t) => ({ name: t })),
        };
        console.log(
          `[CapabilityProvider] connector ${ci.name} (instance ${ci.id.slice(0, 8)}) → internal MCP injected for docker runtime`
        );
      }
    }

    // Phase 6 (A2, Route A): mount enabled hook plugins exactly like skill
    // plugins — readonly mount under /opt/agent/plugins/ + registered in
    // sdkOptions.plugins. The SDK auto-discovers hooks/hooks.json. The platform
    // does NOT translate hook semantics; container sandbox + inline guard bound
    // what the hook code can do. Gated by HOOK_PLUGINS_ENABLED (see resolve()).
    for (const hp of enabledHookPlugins) {
      const containerPath = `/opt/agent/plugins/${hp.name}`;
      plugins.push({ type: "local", path: containerPath });
      mounts.push({ hostPath: hp.absolutePath, containerPath, readonly: true });
    }

    // Plan Task 2: mount ONLY the authenticated user's memory dir at /user-memory
    // (read-write). The host file is the single source of truth; docker-only —
    // local mode confines the same host dir via workspaceRoots instead.
    if (context?.runtimeType !== "local" && context?.userId) {
      mounts.push({
        hostPath: userMemoryService.getHostDir(context.userId),
        containerPath: userMemoryService.USER_MEMORY_CONTAINER_PATH,
        readonly: false,
      });
    }

    // Resolve tool set: profile tools_config (if any) replaces DEFAULT_PROFILE,
    // then Skill is dynamically injected, then app tool_allowlist narrows.
    const profileToolsConfig = agentId
      ? agentProfileStore.toolsConfigForAgent(agentId)
      : null;
    const baseTools = profileToolsConfig ?? DEFAULT_PROFILE;
    let tools = [...baseTools.tools];
    let allowedTools = [...baseTools.allowedTools];
    const disallowedTools = [...baseTools.disallowedTools];

    // Expose the `Skill` tool iff there are enabled skills. The SDK `skills`
    // option only FILTERS which skills are listed — it does NOT add the Skill
    // tool to the model's tool set. "Skill" must be present in `tools` for the
    // model to see/invoke skills (skill-injection-mechanism.md §2.3/§2.5a/§4).
    // Skill is NOT in the tool catalog and is NOT subject to app tool_allowlist.
    if (skillNames.length > 0) {
      tools.push("Skill");
    }

    // App-level tool allowlist (upper bound). Only narrows catalog tools;
    // Skill is exempt (capability-layer injection, not a configurable built-in).
    const appToolAllowlist = applicationService.getAppToolAllowlist(appId);
    if (appToolAllowlist !== null) {
      tools = tools.filter((t) => t === "Skill" || appToolAllowlist.includes(t));
      allowedTools = allowedTools.filter((t) => appToolAllowlist.includes(t));
    }

    // Compose prompts at resolve() time (Phase 2e). systemPrompt = editable
    // platform default + dynamic A2UI preamble (flag evaluated NOW, not at module
    // load). appendSystemPrompt = editable appendBase + dynamic skill manifest
    // (always last, system-owned) + dynamic A2UI instruction.
    const promptSettings = getPromptSettings();
    // Phase 6: prompt precedence — per-Agent override > app prompt > profile >
    // platform default. The chosen base REPLACES lower-precedence text, but the
    // skill manifest is still appended LAST by buildAppendSystemPrompt — so no
    // per-Agent/app/profile prompt can suppress or spoof the capability/skill listing
    // (Phase 2e invariant preserved).
    const agentPrompt = agentId ? agentService.getAgentPromptOverrides(agentId) : null;
    const appPrompt = applicationService.getAppPromptOverrides(appId);
    const profilePrompt = agentId ? agentProfileStore.promptForAgent(agentId) : null;
    const baseSystemPrompt =
      agentPrompt?.systemPrompt ?? appPrompt?.systemPrompt ?? profilePrompt?.systemPrompt ?? promptSettings.systemPrompt;
    const baseAppendRaw =
      agentPrompt?.appendSystemPrompt ?? appPrompt?.appendSystemPrompt ?? profilePrompt?.appendSystemPrompt ?? promptSettings.appendBase;
    // Plan Task 3: docker gets the memory instruction appended (local injects it
    // in ai-client.ts, since local omits the bundle prompt). Kept separate from
    // capability allowlists — memory is an ordinary controlled document.
    const baseAppend =
      context?.runtimeType !== "local" && context?.userId
        ? [baseAppendRaw, buildUserMemoryPrompt(userMemoryService.USER_MEMORY_CONTAINER_FILE)].filter(Boolean).join("\n\n")
        : baseAppendRaw;
    const systemPrompt =
      baseSystemPrompt + (isA2UIEnabled() ? A2UI_SYSTEM_PROMPT_PREAMBLE : "");

    // Phase B (local-mode capability parity): local has no container, so the
    // data-plane translation differs — HOST-path plugins (no mount), drops the
    // Docker-oriented systemPrompt (local falls back to ai-client generic prompt;
    // SDK `skills` option still discovers skills), mcpServers PERMANENTLY empty
    // (Phase C cancelled — local decided NOT to mount MCP; use docker for MCP).
    // Hook plugins are NEVER loaded in local (in-process JS = red line).
    // 铁律 (codex §5): governance (deny-default / app-allowlist / entitlement)
    // ran ABOVE — this branch only rewrites the output SHAPE, never relaxes a check.
    // docker (runtimeType !== "local") unchanged.
    const isLocal = context?.runtimeType === "local";
    const finalPlugins = isLocal
      ? enabledSkills.map((s) => ({ type: "local" as const, path: s.absolutePath }))
      : plugins;
    const finalMounts = isLocal ? [] : mounts;
    const finalMcpServers = isLocal ? {} : mcpServers;

    return {
      sdkOptions: {
        plugins: finalPlugins,
        mcpServers: finalMcpServers,
        // Platform invariant (Phase 3): SDK ignores ALL .mcp.json file discovery
        // and uses ONLY the mcpServers map above. Prevents planted /workspace/.mcp.json
        // bypass. Unconditional — never per-Agent.
        strictMcpConfig: true,
        tools,
        allowedTools,
        disallowedTools,
        // Entitlement-gated skill set; empty = no skills enabled.
        skills: skillNames,
        ...(isLocal
          ? {}
          : {
              systemPrompt,
              appendSystemPrompt: buildAppendSystemPrompt(baseAppend, enabledSkills),
            }),
        maxTurns: Math.min(
          getRuntimeSettings().maxTurns,
          // M5: cap by the org's per-runtime turns quota. Cheap DB read; the orgId
          // is the server-trusted ctx claim. NULL → platform default (≥ global).
          getQuota(context?.orgId ?? "default-org").maxTurnsPerRuntime
        ),
        // M2: effective model via the §3.2 precedence (Chat > Agent > org >
        // platform), each level validated 平台启用 ∩ 组织授权 — the ONLY place
        // sdkOptions.model is set (control→data bridge iron law). Ignores any
        // model field a caller might stuff into the context. No chatId (e.g.
        // the boot-time default bundle) degrades to the platform default.
        // M6-fix (evt_20260819132308): pass the catalog's REAL provider model
        // name (model_id) — the SDK needs the upstream modelCode, not our
        // management alias. Legacy rows without model_id fall back to the
        // alias (pre-M6 behavior preserved).
        model: resolveEffectiveModel({ chatId: context?.chatId, orgId: context?.orgId }).runtimeModel,
      },
      mounts: finalMounts,
      env: {},
    };
  }

  getDefaultProfile(): ToolProfile {
    return { ...DEFAULT_PROFILE };
  }

  listProfiles(): ToolProfile[] {
    return [DEFAULT_PROFILE];
  }
}

export const capabilityProvider: CapabilityProvider = new LocalCapabilityProvider();
