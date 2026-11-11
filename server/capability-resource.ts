/**
 * capability-resource.ts — Phase 2a capability resource pool.
 *
 * A single resource-pool view over the local Skill registry (data/skills.json via
 * skill-config.ts). Skill/MCP are treated as enterprise capability resources, not
 * Agent-owned files. skill-config.ts stays the native-package validator; this
 * module is the uniform listing/lookup surface consumed by entitlement,
 * activation, and (in Phase 3/MP3) resolution.
 *
 * The `type` discriminator ("skill" | "mcp") is reserved so MCP folds in at
 * Phase 3 without changing this interface. Today only "skill" resources exist.
 *
 * See docs/02-architecture/configuration-plane-interface-design.md §5
 * (CapabilityResourceService) and docs/05-migration Phase 2a.
 */

import { getAllSkills, type ResolvedSkill } from "./skill-config.js";
import { getAllMcpServers, type ResolvedMcpServer } from "./mcp-config.js";
import { getAllHookPlugins, type ResolvedHookPlugin } from "./hook-plugin-config.js";
import { listInstances, getCatalogEntry, type ConnectorInstanceView } from "./connector-store.js";
import { entitlementService } from "./entitlement.js";
import type { RequestContext } from "./request-context.js";

export type CapabilityType = "skill" | "mcp" | "hook-plugin" | "connector";
export type ResourceStatus = "active" | "disabled" | "deprecated" | "invalid";

export interface CapabilityResourceView {
  resourceId: string; // === skill name
  type: CapabilityType;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean; // registry enabled flag (mounts on new runtime)
  status: ResourceStatus;
  valid: boolean; // native package shape valid?
  error?: string; // validation error when invalid
}

export interface CapabilityFilter {
  type?: CapabilityType;
}

export interface CapabilityResourceService {
  listResources(ctx: RequestContext, filter?: CapabilityFilter): CapabilityResourceView[];
  /**
   * Phase 7.4: org-scoped MANAGEMENT read. admin sees the full shared pool; any
   * other role sees ONLY resources their org is authorized to use (entitlement
   * canConfigure). Use this on admin management routes (GET /api/admin/capabilities,
   * /skills, /mcp). listResources itself stays ctx-agnostic because per-agent
   * views (listAgentCapabilities) and activation (getResource) rely on the full
   * pool — org-scoping there happens at the layer above.
   */
  listResourcesForCtx(ctx: RequestContext, filter?: CapabilityFilter): CapabilityResourceView[];
  getResource(ctx: RequestContext, resourceId: string): CapabilityResourceView | undefined;
  validateResource(ctx: RequestContext, resourceId: string): { valid: boolean; error?: string };
}

// skill-config uses "plugin" for native Claude Code plugin/skill packages; the
// resource pool exposes them as type "skill". "mcp" passes through for Phase 3.
function toResourceType(cfgType: "plugin" | "mcp"): CapabilityType {
  return cfgType === "mcp" ? "mcp" : "skill";
}

function toView(s: ResolvedSkill): CapabilityResourceView {
  const status: ResourceStatus = !s.valid ? "invalid" : s.enabled ? "active" : "disabled";
  return {
    resourceId: s.name,
    type: toResourceType(s.type),
    name: s.name,
    version: s.version || undefined,
    description: s.description || undefined,
    enabled: s.enabled,
    status,
    valid: s.valid,
    error: s.error,
  };
}

// Phase 3: MCP packages surface as type "mcp". mcp-config uses entry type "local"
// (the stdio transport); the resource pool exposes them uniformly as "mcp".
function mcpToView(m: ResolvedMcpServer): CapabilityResourceView {
  const status: ResourceStatus = !m.valid ? "invalid" : m.enabled ? "active" : "disabled";
  return {
    resourceId: m.name,
    type: "mcp",
    name: m.name,
    version: m.version || undefined,
    description: m.description || undefined,
    enabled: m.enabled,
    status,
    valid: m.valid,
    error: m.error,
  };
}

// Phase 6 (A2, Route A): hook plugin packages surface as type "hook-plugin".
// They flow through the SAME entitlement/activation/app-allowlist pipeline as
// skills and MCP — NOT a parallel plane (Codex review evt_20260630_hook_route_a_tech_plan).
function hookPluginToView(p: ResolvedHookPlugin): CapabilityResourceView {
  const status: ResourceStatus = !p.valid ? "invalid" : p.enabled ? "active" : "disabled";
  return {
    resourceId: p.name,
    type: "hook-plugin",
    name: p.name,
    version: p.version || undefined,
    description: p.description || undefined,
    enabled: p.enabled,
    status,
    valid: p.valid,
    error: p.error,
  };
}

// Octop absorption M1b: connector instances surface as type "connector" with
// the stable resource id `connector:<instanceId>`. They flow through the SAME
// entitlement/activation/app-allowlist pipeline as skills/MCP — no parallel
// grant table. enabled = admin enabled the instance AND credentials are
// present (an enabled-but-credentialless instance can never resolve into a
// runtime, so it is not an activatable resource yet).
function connectorToView(i: ConnectorInstanceView): CapabilityResourceView {
  const kindValid = !!getCatalogEntry(i.catalogKind);
  const ready = kindValid && i.status === "enabled" && i.credentialsPresent;
  const status: ResourceStatus = !kindValid ? "invalid" : ready ? "active" : "disabled";
  return {
    resourceId: `connector:${i.id}`,
    type: "connector",
    name: `connector:${i.name}`,
    description: getCatalogEntry(i.catalogKind)?.displayName ?? undefined,
    enabled: ready,
    status,
    valid: kindValid,
    error: kindValid ? undefined : `unknown connector kind: ${i.catalogKind}`,
  };
}

class CapabilityResourceServiceImpl implements CapabilityResourceService {
  listResources(_ctx: RequestContext, filter?: CapabilityFilter): CapabilityResourceView[] {
    // Phase 3: skills + MCP share one resource pool. Entitlement/activation key
    // by bare resourceId (name), so a global-unique-name invariant is enforced
    // here: any name claimed by more than one skill/mcp is marked invalid, which
    // blocks activation (getResource().valid === false → ResourceNotFoundError)
    // and surfaces in the Admin UI. resolve() drops collisions defensively too.
    const all = [
      ...getAllSkills().map(toView),
      ...getAllMcpServers().map(mcpToView),
      ...getAllHookPlugins().map(hookPluginToView),
      ...listInstances().map(connectorToView),
    ];

    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.resourceId, (counts.get(r.resourceId) ?? 0) + 1);
    const collided = new Set(
      [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k)
    );
    if (collided.size > 0) {
      for (const r of all) {
        if (collided.has(r.resourceId)) {
          r.valid = false;
          r.status = "invalid";
          r.error = `resourceId collision: "${r.resourceId}" is used by more than one skill/mcp`;
        }
      }
      console.warn(
        `[CapabilityResource] resourceId collision detected: ${[...collided].join(", ")} (marked invalid)`
      );
    }

    return all.filter((r) => !filter?.type || r.type === filter.type);
  }

  getResource(ctx: RequestContext, resourceId: string): CapabilityResourceView | undefined {
    return this.listResources(ctx).find((r) => r.resourceId === resourceId);
  }

  /**
   * Phase 7.4: org-scoped management read. admin = full pool; non-admin = only
   * resources their org is authorized to use (entitlement canConfigure). The
   * raw pool stays shared/global; this is the org-scoped VIEW over it.
   */
  listResourcesForCtx(ctx: RequestContext, filter?: CapabilityFilter): CapabilityResourceView[] {
    const all = this.listResources(ctx, filter);
    if (ctx.role === "admin") return all;
    return all.filter((r) => entitlementService.canConfigure(ctx, r.resourceId));
  }

  validateResource(ctx: RequestContext, resourceId: string): { valid: boolean; error?: string } {
    const r = this.getResource(ctx, resourceId);
    if (!r) return { valid: false, error: "resource not found" };
    return { valid: r.valid, error: r.error };
  }
}

export const capabilityResourceService: CapabilityResourceService =
  new CapabilityResourceServiceImpl();
