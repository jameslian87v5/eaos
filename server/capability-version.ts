/**
 * capability-version.ts — configVersion for capability diagnostics (MP4c).
 *
 * A deterministic hash over the NORMALIZED control-plane inputs that
 * CapabilityProvider.resolve() consumes, so "what the runtime was built from"
 * (stored in resolved_snapshot) can be compared against "what the control plane
 * currently says" to detect drift — notably R1 warm-resume staleness.
 *
 * Security (Codex MP4c constraint): hashes ONLY normalized semantic inputs —
 * activation ids, registry ids+versions, profile fields, relevant runtime
 * settings. NEVER absolute host paths, env values, or secrets.
 *
 * See docs/05-migration Phase 4 + docs/03-modules/skill-injection-mechanism.md.
 */
import { createHash } from "node:crypto";
import { agentCapabilityService } from "./agent-capabilities.js";
import { applicationService } from "./application-service.js";
import { applicationCapabilitiesService } from "./application-capabilities.js";
import { getEnabledPlugins } from "./skill-config.js";
import { getEnabledMcpServers } from "./mcp-config.js";
import { capabilityProvider } from "./capability-provider.js";
import { getRuntimeSettings } from "./runtime-settings.js";
import { getPromptSettings } from "./prompt-settings.js";
import { agentService } from "./agent-service.js";
import { agentProfileStore } from "./agent-profile-store.js";
// M2: effective model folded in so model changes flip configVersion (drift).
import { resolveEffectiveModel } from "./model-catalog.js";
import type { RequestContext } from "./request-context.js";

/**
 * Compute the current configVersion for an Agent. Stable across unchanged
 * control-plane state; changes on any activation / entitlement / registry /
 * profile / (new-runtime) settings edit.
 */
export function computeConfigVersion(ctx: RequestContext, agentId: string): string {
  // Resolve the authoritative appId from DB (agents.app_id).
  const appId = applicationService.getAppIdForAgent(agentId);
  // activation ∩ entitled ∩ app allowlist (entitlement effects are materialized
  // inside resolveEnabledResourceIds, so revocation flips the version).
  const activated = [...agentCapabilityService.resolveEnabledResourceIdsForApp(ctx, agentId, appId)].sort();

  // Phase 6 (A0): app allowlist as structured data (Codex: distinguish null vs []).
  // null = passthrough (no rows), [] = all disabled, [...] = upper bound.
  const rawAllowlist = applicationCapabilitiesService.resolveAppAllowlist(appId);
  const appAllowlist =
    rawAllowlist === null
      ? { mode: "passthrough" as const }
      : { mode: "allowlist" as const, ids: [...rawAllowlist].sort() };

  // registry-enabled resources with versions.
  const registry = getEnabledPlugins()
    .map((s) => ({ name: s.name, version: s.version }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Phase 3: MCP registry (registry-enabled servers). Enabling/disabling an MCP
  // in data/mcp.json flips configVersion → surfaced as drift by diagnostics.
  const mcpRegistry = getEnabledMcpServers()
    .map((m) => ({ name: m.name, version: m.version }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const profile = capabilityProvider.getDefaultProfile();
  const settings = getRuntimeSettings();
  const prompt = getPromptSettings();
  // Phase 5 (MP5b): per-Agent prompt overrides. Folded in so editing an Agent's
  // prompt flips configVersion → MP4c stale detection → next runtime picks it up.
  const agentPrompt = agentService.getAgentPromptOverrides(agentId);
  // Phase 5 (MP5d): assigned-profile prompt + the profile_id assignment. Folded
  // in so editing a profile OR reassigning an Agent's profile flips configVersion.
  const profilePrompt = agentProfileStore.promptForAgent(agentId);
  // Phase 6: app-level prompt overrides. Folded in so editing an app's prompt
  // flips configVersion → warm-resume stale detection picks it up.
  const appPrompt = applicationService.getAppPromptOverrides(appId);
  // Built-in tools config: profile-level tools_config + app-level tool_allowlist.
  const profileToolsConfig = agentId ? agentProfileStore.toolsConfigForAgent(agentId) : null;
  const appToolAllowlist = applicationService.getAppToolAllowlist(appId);
  // M2: effective model (§3.2 precedence). Folded in so a chat/agent/org/platform
  // model change flips configVersion → warm-resume drift is surfaced by the
  // existing MP4c/R1 diagnostics (no hot-switch; next runtime picks it up).
  // M6-fix: runtimeModel folded in too — editing a catalog row's model_id under
  // the same alias must also flip the version (warm runtimes carry the old
  // upstream name until rebuilt).
  const effectiveModel = resolveEffectiveModel({ chatId: agentId, orgId: ctx.orgId });

  const normalized = {
    activated,
    appId,
    appAllowlist,
    registry,
    mcpRegistry,
    model: { alias: effectiveModel.alias, runtimeModel: effectiveModel.runtimeModel, source: effectiveModel.source },
    profile: {
      tools: [...(profileToolsConfig?.tools ?? profile.tools)].sort(),
      allowedTools: [...(profileToolsConfig?.allowedTools ?? profile.allowedTools)].sort(),
      disallowedTools: [...(profileToolsConfig?.disallowedTools ?? profile.disallowedTools)].sort(),
      approvalRequiredTools: [...profile.approvalRequiredTools].sort(),
    },
    appToolAllowlist: appToolAllowlist ? [...appToolAllowlist].sort() : null,
    // Only the runtime-settings fields that affect NEW runtimes (per CLAUDE.md
    // per-field effect rules). idleStopMs and size limits don't change injection.
    runtime: {
      maxTurns: settings.maxTurns,
      memoryMb: settings.memoryMb,
      cpuCores: settings.cpuCores,
    },
    // Phase 2e: platform-default prompt text. Folded in so a prompt-settings edit
    // flips configVersion and is surfaced as drift by MP4c diagnostics. Only the
    // static admin-editable fields (not the dynamic A2UI/skill-manifest layers,
    // which are already represented via activation ids / are global flags).
    // Phase 5 (MP5b): per-Agent override text folded in too, so a per-Agent prompt
    // edit is detected as drift on the next warm-resume.
    // Phase 6: app-level prompt overrides folded in too.
    prompt: {
      systemPrompt: prompt.systemPrompt,
      appendBase: prompt.appendBase,
      agentSystemPrompt: agentPrompt.systemPrompt,
      agentAppendSystemPrompt: agentPrompt.appendSystemPrompt,
      profileSystemPrompt: profilePrompt.systemPrompt,
      profileAppendSystemPrompt: profilePrompt.appendSystemPrompt,
      profileId: agentPrompt.profileId,
      appSystemPrompt: appPrompt.systemPrompt,
      appAppendSystemPrompt: appPrompt.appendSystemPrompt,
    },
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}
