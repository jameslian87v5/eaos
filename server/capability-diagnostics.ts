/**
 * capability-diagnostics.ts — make capability behavior observable (MP4c, scoped
 * Phase 4 pulled ahead of 2e).
 *
 * Two responsibilities:
 *   1. buildResolvedSnapshot(bundle, configVersion) — a REDACTED record of what
 *      CapabilityProvider.resolve() asked the runtime to mount/inject. Appended
 *      as a `resolved_snapshot` event at container creation (coldResume /
 *      freshStart / fallbackFromMessages). No raw env values, no absolute host
 *      paths (hostPath hashed for identity only).
 *   2. getDiagnostics(ctx, agentId) — assemble the 4-column view
 *      (configured / resolved / mounted / discovered) + two-domain diff + stale
 *      flag + recent audit timeline, for the admin diagnostics endpoint.
 *
 * Events are audit/proof, NOT source of truth — the live "configured" column
 * always comes from the control plane. See docs/05-migration Phase 4.
 */
import { createHash } from "node:crypto";
import { eventStore } from "./event-store.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { applicationService } from "./application-service.js";
import { capabilityResourceService } from "./capability-resource.js";
import { computeConfigVersion } from "./capability-version.js";
import type { CapabilityBundle } from "./capability-provider.js";
import type { RequestContext } from "./request-context.js";

// ─── Snapshot (resolved) ─────────────────────────────────────

export interface ResolvedSnapshot {
  configVersion: string;
  sdkOptions: {
    tools: string[];
    allowedTools: string[];
    disallowedTools: string[];
    skills: string[];
    plugins: Array<{ type: string; path: string }>;
    mcpServers: Array<{ name: string; command: string }>; // Phase 3
  };
  strictMcpConfig: boolean; // Phase 3: platform invariant recorded for audit
  mounts: Array<{
    containerPath: string;
    resourceId: string;
    readonly: boolean;
    hostPathHash: string; // sha256 prefix — identity only, never the raw path
  }>;
  envKeys: string[]; // KEY NAMES ONLY — never env values / secrets
}

/**
 * Build a redacted resolved snapshot from a bundle. `configVersion` is computed
 * by the caller (capability-version.ts) so the same value is available for the
 * warmResume stale check.
 */
export function buildResolvedSnapshot(
  bundle: CapabilityBundle,
  configVersion: string
): ResolvedSnapshot {
  const sdk = bundle.sdkOptions;
  const mcpServers = Object.entries(sdk.mcpServers ?? {}).map(([name, cfg]) => ({
    name,
    // Octop absorption M1b: http-type MCP entries (internal connectors) record
    // their type ONLY — the capability token lives in `headers` and is
    // deliberately NEVER serialized here (or anywhere in diagnostics).
    type: (cfg as { type?: string })?.type ?? "stdio",
    command: (cfg as { command?: string })?.command ?? "",
  }));
  return {
    configVersion,
    sdkOptions: {
      tools: sdk.tools ?? [],
      allowedTools: sdk.allowedTools ?? [],
      disallowedTools: sdk.disallowedTools ?? [],
      skills: Array.isArray(sdk.skills) ? sdk.skills : [],
      plugins: sdk.plugins ?? [],
      mcpServers,
    },
    strictMcpConfig: sdk.strictMcpConfig === true,
    mounts: bundle.mounts.map((m) => ({
      containerPath: m.containerPath,
      resourceId: m.containerPath.split("/").pop() ?? m.containerPath,
      readonly: m.readonly,
      hostPathHash: createHash("sha256").update(m.hostPath).digest("hex").slice(0, 16),
    })),
    envKeys: Object.keys(bundle.env).sort(),
  };
}

// ─── Diagnostics view ────────────────────────────────────────

export interface DiagnosticsResource {
  resourceId: string;
  name?: string;
  version?: string;
  status?: string;
}

export interface DiscoveredView {
  skills: string[];
  plugins: Array<{ name?: string; path?: string }>;
  tools: string[];
  mcpServers: string[]; // Phase 3: MCP server names the SDK connected to (from sdk_init)
}

export interface DiagnosticsDiff {
  /** Control-plane drift since the runtime was resolved (admin changed activation/entitlement). */
  configuredVsResolved: { addedSinceResolve: string[]; revokedSinceResolve: string[] };
  /** Runtime/SDK discovery problems (injection broke, or SDK built-ins). */
  resolvedVsDiscovered: {
    injectedButUnseen: string[]; // resolved asked for it, SDK didn't discover → injection bug
    seenButNotInjected: string[]; // SDK discovered, not in resolved → likely SDK built-in
  };
  /** Phase 3: MCP resolved vs discovered. injectedButUnseen = MCP we asked for that
   *  failed to connect; seenButNotInjected should be empty under strictMcpConfig
   *  (any discovered MCP not in resolved implies file-discovery leaked). */
  resolvedVsDiscoveredMcp: {
    injectedButUnseen: string[];
    seenButNotInjected: string[];
  };
}

export interface DiagnosticsView {
  agentId: string;
  configured: DiagnosticsResource[]; // LIVE: activation ∩ entitled (source of truth)
  resolved: ResolvedSnapshot | null; // last resolved_snapshot event
  mounted: ResolvedSnapshot["mounts"];
  discovered: DiscoveredView | null; // last sdk_init event
  stale: { isStale: boolean; resolvedVersion: string | null; currentVersion: string };
  diff: DiagnosticsDiff;
  recentTimeline: Array<{ eventType: string; createdAt: string; sequence: number }>;
}

const AUDIT_TYPES = new Set([
  "resolved_snapshot",
  "sdk_init",
  "capability_activation_changed",
  "entitlement_changed",
  "runtime_config_stale",
  "runtime_stopped",
  "agent_profile_updated",
  "application_created",
  "application_updated",
  "application_capability_changed",
  // Agent OS M2 (r2): approval request + decision audit (metadata-only).
  "approval_request",
  "approval_decision",
]);

/**
 * The SDK reports skills as `<pluginName>:<skillDir>`; resolve() stores
 * `declaredSkillNames` (the skill dir names). Normalize discovered to the dir
 * name so the two are comparable.
 */
function normalizeDiscoveredSkill(s: string): string {
  return s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
}

function parseJson<T>(payloadJson: string): T {
  return JSON.parse(payloadJson) as T;
}

/**
 * Assemble the diagnostics view for an Agent (agentId === chatId).
 */
export function getDiagnostics(ctx: RequestContext, agentId: string): DiagnosticsView {
  const { userId } = ctx;

  // Phase 6 (A0): resolve authoritative appId from DB.
  const appId = applicationService.getAppIdForAgent(agentId);

  // configured (LIVE source of truth) — activation ∩ entitled ∩ app allowlist.
  const configuredIds = agentCapabilityService.resolveEnabledResourceIdsForApp(ctx, agentId, appId);
  const configured: DiagnosticsResource[] = configuredIds.map((rid) => {
    const r = capabilityResourceService.getResource(ctx, rid);
    return { resourceId: rid, name: r?.name, version: r?.version, status: r?.status };
  });

  // resolved — latest resolved_snapshot.
  const resolvedEvent = eventStore.getLatestEventByType(userId, agentId, "resolved_snapshot");
  const resolved: ResolvedSnapshot | null = resolvedEvent
    ? parseJson<ResolvedSnapshot>(resolvedEvent.payloadJson)
    : null;
  const mounted = resolved?.mounts ?? [];

  // discovered — latest sdk_init.
  const initEvent = eventStore.getLatestEventByType(userId, agentId, "sdk_init");
  const discovered: DiscoveredView | null = initEvent
    ? parseJson<DiscoveredView>(initEvent.payloadJson)
    : null;

  // stale — resolved configVersion vs current control plane.
  const currentVersion = computeConfigVersion(ctx, agentId);
  const resolvedVersion = resolved?.configVersion ?? null;
  const isStale = resolvedVersion !== null && resolvedVersion !== currentVersion;

  // diffs
  // Resolved ids come from BOTH plugin mount-path basenames AND MCP server names
  // (Phase 3). Omitting MCP here would make an already-resolved MCP falsely appear
  // in addedSinceResolve. See Codex MP3 implementation review (should-fix #1).
  const resolvedIds = [
    ...(resolved?.sdkOptions.plugins ?? []).map((p) => p.path.split("/").pop() ?? ""),
    ...(resolved?.sdkOptions.mcpServers ?? []).map((m) => m.name),
  ].filter(Boolean);
  const addedSinceResolve = configuredIds.filter((id) => !resolvedIds.includes(id));
  const revokedSinceResolve = resolvedIds.filter((id) => !configuredIds.includes(id));

  const resolvedSkillNames = resolved?.sdkOptions.skills ?? [];
  const discoveredSkillDirs = (discovered?.skills ?? []).map(normalizeDiscoveredSkill);
  const injectedButUnseen = resolvedSkillNames.filter((s) => !discoveredSkillDirs.includes(s));
  const seenButNotInjected = discoveredSkillDirs.filter((s) => !resolvedSkillNames.includes(s));

  // Phase 3: MCP resolved vs discovered. Under strictMcpConfig, seenButNotInjected
  // should always be empty — any discovered MCP not in resolved implies file
  // discovery leaked past the gate.
  const resolvedMcpNames = (resolved?.sdkOptions.mcpServers ?? []).map((m) => m.name);
  const discoveredMcpNames = discovered?.mcpServers ?? [];
  const injectedButUnseenMcp = resolvedMcpNames.filter((n) => !discoveredMcpNames.includes(n));
  const seenButNotInjectedMcp = discoveredMcpNames.filter((n) => !resolvedMcpNames.includes(n));

  // timeline — recent audit events (newest first).
  const allEvents = eventStore.getEventsByChat(userId, agentId);
  const recentTimeline = allEvents
    .filter((e) => AUDIT_TYPES.has(e.eventType))
    .slice(-20)
    .reverse()
    .map((e) => ({ eventType: e.eventType, createdAt: e.createdAt, sequence: e.sequence }));

  return {
    agentId,
    configured,
    resolved,
    mounted,
    discovered,
    stale: { isStale, resolvedVersion, currentVersion },
    diff: {
      configuredVsResolved: { addedSinceResolve, revokedSinceResolve },
      resolvedVsDiscovered: { injectedButUnseen, seenButNotInjected },
      resolvedVsDiscoveredMcp: {
        injectedButUnseen: injectedButUnseenMcp,
        seenButNotInjected: seenButNotInjectedMcp,
      },
    },
    recentTimeline,
  };
}
