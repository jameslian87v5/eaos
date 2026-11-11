/**
 * security-posture.ts — Octop absorption M6b: unified security posture
 * read model + the ONE narrow profile-tools write.
 *
 * The admin "安全防护中心" is a governance ENTRY POINT, not a new policy
 * domain layer. Every section is a projection of authoritative sources:
 *   - toolApproval  → agent_profiles.tools_config (DB) + platform default
 *   - fileAccess    → runtime/workspace path invariants (facts, read-only)
 *   - sensitiveInfo → EXISTING coverage only, honestly labeled; chat content
 *                     DLP is declared not_implemented (never faked as on)
 *   - commandProtection → local runtime Bash hard-deny (L1) + docker
 *                     profile-dependent approval
 *   - skillScan     → M3 skills.json registry (counts + supply-chain
 *                     manifest fields; no filesystem scanning)
 *   - audit         → governance_audit_log + agent_events entry points
 *
 * IRON LAWS:
 *   - org scoping: admin sees all profiles; org_admin sees own-org ONLY.
 *     ctx (JWT-derived) is the single org authority — never query/body.
 *   - The ONLY write path is updateProfileTools, which touches database
 *     profile toolsConfig exclusively. Platform default, hard guards
 *     (deny-default, strictMcpConfig, /opt/agent/mcp/ prefix, workspace
 *     path fences) are read-only facts here — no write can relax them.
 *   - Responses are symbol-level: no host absolute paths, no volume names,
 *     no credentials, no tool payloads.
 *   - All governance audits are metadata-only (categorical summaries).
 *   - "仅新 runtime 生效": a saved profile applies to NEWLY created
 *     runtimes — running agents are never described as updated.
 */
import { agentProfileStore } from "./agent-profile-store.js";
import { capabilityProvider } from "./capability-provider.js";
import { capabilityResourceService } from "./capability-resource.js";
import { getAllSkills } from "./skill-config.js";
import { writeGovernanceAudit } from "./org-governance.js";
import { isPrivilegedRole, type RequestContext } from "./request-context.js";
import type { ToolsConfig } from "./types.js";

export type { ToolsConfig };

export type PostureSectionStatus = "enforced" | "configurable" | "partial" | "not_implemented";

export interface ProfileToolView {
  profileId: string;
  name: string;
  orgId: string;
  editable: boolean;
  /** True when the profile has NO tools_config and inherits the platform default. */
  inheritsPlatformDefault: boolean;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  approvalRequired: string[];
}

export interface SecurityPosture {
  toolApproval: {
    status: PostureSectionStatus;
    semantics: string;
    effectiveScope: "new-runtimes-only";
    platformDefault: ProfileToolView;
    profiles: ProfileToolView[];
  };
  fileAccess: {
    status: PostureSectionStatus;
    areas: Array<{ area: string; boundaries: string[]; guards: string[] }>;
  };
  sensitiveInfo: {
    status: PostureSectionStatus;
    coverage: Array<{ area: string; status: PostureSectionStatus; detail: string }>;
  };
  commandProtection: {
    status: PostureSectionStatus;
    localBash: { status: PostureSectionStatus; policy: "hard-deny" };
    dockerBash: { status: PostureSectionStatus; policy: "profile-approval-gate" };
    riskyProfiles: Array<{ profileId: string; name: string }>;
    tighten: { supported: true; action: "move-bash-from-allowed-to-approval" };
  };
  skillScan: {
    status: PostureSectionStatus;
    mode: "fail-closed-import-quarantine";
    counts: { total: number; enabled: number; disabled: number; quarantined: number; withScripts: number; invalid: number };
    packages: Array<{
      name: string;
      enabled: boolean;
      sourceKind: string;
      sha256: string | null;
      hasScripts: boolean | null;
      copyPolicy: string | null;
      importedAt: string | null;
      valid: boolean;
    }>;
  };
  audit: {
    status: PostureSectionStatus;
    sources: string[];
    endpoints: string[];
    retentionDays: number;
  };
}

export class SecurityPostureError extends Error {
  /** Categorical code — safe for audit reasonSummary. */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SecurityPostureError";
    this.code = code;
  }
}

// The platform default profile, as a read-only posture view.
function platformDefaultView(): ProfileToolView {
  const profile = capabilityProvider.getDefaultProfile();
  return {
    profileId: "platform-default",
    name: profile.name,
    orgId: "-",
    editable: false,
    inheritsPlatformDefault: false,
    tools: [...profile.tools],
    allowedTools: [...profile.allowedTools],
    disallowedTools: [...profile.disallowedTools],
    approvalRequired: profile.tools.filter(
      (t) => !profile.allowedTools.includes(t) && !profile.disallowedTools.includes(t)
    ),
  };
}

function profileView(input: {
  profileId: string;
  name: string;
  orgId: string;
  toolsConfig: ToolsConfig | null;
  platformDefault: ProfileToolView;
}): ProfileToolView {
  const effective = input.toolsConfig ?? {
    tools: input.platformDefault.tools,
    allowedTools: input.platformDefault.allowedTools,
    disallowedTools: input.platformDefault.disallowedTools,
  };
  return {
    profileId: input.profileId,
    name: input.name,
    orgId: input.orgId,
    editable: true,
    inheritsPlatformDefault: input.toolsConfig === null,
    tools: [...effective.tools],
    allowedTools: [...effective.allowedTools],
    disallowedTools: [...effective.disallowedTools],
    approvalRequired: effective.tools.filter(
      (t) => !effective.allowedTools.includes(t) && !effective.disallowedTools.includes(t)
    ),
  };
}

function assertPrivileged(ctx: RequestContext): void {
  if (!isPrivilegedRole(ctx.role)) {
    throw new SecurityPostureError("forbidden", "security posture requires admin or org_admin");
  }
}

export function buildSecurityPosture(ctx: RequestContext): SecurityPosture {
  assertPrivileged(ctx);

  const platformDefault = platformDefaultView();
  const dbProfiles = ctx.role === "admin"
    ? agentProfileStore.list()
    : agentProfileStore.listByOrg(ctx.orgId);
  const profiles = dbProfiles.map((p) =>
    profileView({ profileId: p.id, name: p.name, orgId: p.orgId, toolsConfig: p.toolsConfig ?? null, platformDefault })
  );

  // Frozen boundary: full catalog visibility = admin only. org_admin gets the
  // entitlement-scoped VIEW (same canConfigure pattern as /api/admin/skills) —
  // unentitled global/org-B skills never appear in their posture.
  const entitledSkillIds = new Set(
    capabilityResourceService
      .listResourcesForCtx(ctx, { type: "skill" })
      .map((r) => r.resourceId)
  );
  const skills = getAllSkills().filter((s) => entitledSkillIds.has(s.name));
  const packages = skills.map((s) => ({
    name: s.name,
    enabled: s.enabled,
    sourceKind: s.sourceKind ?? "local",
    sha256: s.sha256 ?? null,
    hasScripts: s.hasScripts ?? null,
    copyPolicy: s.copyPolicy ?? null,
    importedAt: s.importedAt ?? null,
    valid: s.valid,
  }));

  return {
    toolApproval: {
      status: "configurable",
      semantics:
        "disabled = disallowedTools; auto-allowed = allowedTools; approval = tools − allowedTools − disallowedTools (mutually exclusive; allowed/disallowed ⊆ tools)",
      effectiveScope: "new-runtimes-only",
      platformDefault,
      profiles,
    },
    fileAccess: {
      status: "enforced",
      areas: [
        {
          area: "agent-workspace",
          boundaries: ["workspace/input (user uploads)", "workspace/output (agent artifacts)"],
          guards: ["per-chat named volumes", "path-traversal validation on every workspace I/O", "binary-safe tar I/O"],
        },
        {
          area: "skill-mounts",
          boundaries: ["/opt/agent/plugins/<name> (read-only)"],
          guards: ["registry realpath containment check", "read-only mount", "enabled:false quarantine before admin review"],
        },
        {
          area: "mcp-binaries",
          boundaries: ["/opt/agent/mcp/"],
          guards: ["prefix enforcement (all MCP commands must live under /opt/agent/mcp/)", "strictMcpConfig", "SSRF + HTTPS checks on remote endpoints"],
        },
        {
          area: "local-runtime",
          boundaries: ["workspace path prefix validation"],
          guards: ["in-process tool calls confined to the workspace prefix", "Bash unavailable (see command protection)"],
        },
      ],
    },
    sensitiveInfo: {
      status: "partial",
      coverage: [
        { area: "governance-audit", status: "enforced", detail: "metadata-only rows (categorical reasons; no prompt/key/payload columns)" },
        { area: "run-summary", status: "enforced", detail: "run summaries and event projections redact toolInput/toolOutput and raw payloads" },
        { area: "connector-credentials", status: "enforced", detail: "external-service raw credentials encrypted host-side; they never enter containers (only short-lived scoped internal-mcp access keys do)" },
        { area: "chat-content-dlp", status: "not_implemented", detail: "chat message content is stored as sent; no content-level DLP scanning exists today" },
      ],
    },
    commandProtection: {
      status: "partial",
      localBash: { status: "enforced", policy: "hard-deny" },
      dockerBash: { status: "configurable", policy: "profile-approval-gate" },
      riskyProfiles: profiles
        .filter((p) => p.allowedTools.includes("Bash"))
        .map((p) => ({ profileId: p.profileId, name: p.name })),
      tighten: { supported: true, action: "move-bash-from-allowed-to-approval" },
    },
    skillScan: {
      status: "enforced",
      mode: "fail-closed-import-quarantine",
      counts: {
        total: packages.length,
        enabled: packages.filter((p) => p.enabled).length,
        disabled: packages.filter((p) => !p.enabled).length,
        quarantined: packages.filter((p) => p.sourceKind === "zip" && !p.enabled).length,
        withScripts: packages.filter((p) => p.hasScripts === true).length,
        invalid: packages.filter((p) => !p.valid).length,
      },
      packages,
    },
    audit: {
      status: "enforced",
      sources: ["governance_audit_log (org-scoped, metadata-only)", "agent_events (runtime decision events)"],
      endpoints: ["/api/admin/governance-audit", "/api/admin/audit"],
      retentionDays: 180,
    },
  };
}

export function updateProfileTools(
  ctx: RequestContext,
  profileId: string,
  toolsConfig: ToolsConfig
): ProfileToolView {
  assertPrivileged(ctx);

  if (profileId === "platform-default" || profileId.trim() === "") {
    writeGovernanceAudit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "security.profile_tools.update",
      objectType: "agent_profile",
      objectId: profileId,
      result: "denied",
      reasonSummary: "platform default is read-only",
    });
    throw new SecurityPostureError("platform_default_readonly", "the platform default profile is read-only");
  }

  const profile = agentProfileStore.get(profileId);
  if (!profile) {
    writeGovernanceAudit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "security.profile_tools.update",
      objectType: "agent_profile",
      objectId: profileId,
      result: "failure",
      reasonSummary: "profile not found",
    });
    throw new SecurityPostureError("not_found", "profile not found");
  }

  if (ctx.role !== "admin" && profile.orgId !== ctx.orgId) {
    writeGovernanceAudit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "security.profile_tools.update",
      objectType: "agent_profile",
      objectId: profileId,
      result: "denied",
      reasonSummary: "cross-org profile",
    });
    // 404 semantics: do not leak the existence of another org's profile.
    throw new SecurityPostureError("cross_org", "profile not found");
  }

  let updated;
  try {
    // Normalize to exactly the three declared fields — the store persists the
    // object verbatim, so a smuggled extra key must never reach it.
    const clean: ToolsConfig = {
      tools: [...toolsConfig.tools],
      allowedTools: [...toolsConfig.allowedTools],
      disallowedTools: [...toolsConfig.disallowedTools],
    };
    updated = agentProfileStore.update(profileId, { toolsConfig: clean });
  } catch (err) {
    writeGovernanceAudit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: profile.orgId,
      action: "security.profile_tools.update",
      objectType: "agent_profile",
      objectId: profileId,
      result: "failure",
      reasonSummary: "invalid tools config",
    });
    throw new SecurityPostureError("invalid_tools_config", (err as Error).message);
  }
  if (!updated) {
    throw new SecurityPostureError("not_found", "profile not found");
  }

  // Success: metadata-only audit (counts, never the tool payload semantics).
  writeGovernanceAudit({
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId: profile.orgId,
    action: "security.profile_tools.update",
    objectType: "agent_profile",
    objectId: profileId,
    result: "success",
    reasonSummary: `tools=${toolsConfig.tools.length} allowed=${toolsConfig.allowedTools.length} disallowed=${toolsConfig.disallowedTools.length}`,
  });

  const view = profileView({
    profileId: updated.id,
    name: updated.name,
    orgId: updated.orgId,
    toolsConfig: updated.toolsConfig ?? null,
    platformDefault: platformDefaultView(),
  });
  return view;
}
