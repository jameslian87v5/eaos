/**
 * agent-capabilities.ts — Phase 2c Agent capability activation.
 *
 * Records which entitled resources are ENABLED on an Agent (per-agentId), backed
 * by data/agent-capabilities.json (no database). Enabling requires the resource
 * to pass entitlement (canConfigure) first; disabling is always allowed for the
 * owner. resolveEnabledResourceIds re-checks entitlement at read time — this is
 * the security backstop used by CapabilityProvider.resolve() in MP3 (a
 * revoked-but-still-enabled resource is excluded from the next resolved bundle).
 *
 * See docs/02-architecture/configuration-plane-interface-design.md §5
 * (AgentCapabilityService) and docs/05-migration Phase 2c/2d.
 */

import path from "path";
import fs from "fs";
import type { RequestContext } from "./request-context.js";
import {
  capabilityResourceService,
  type CapabilityResourceView,
} from "./capability-resource.js";
import { entitlementService } from "./entitlement.js";
import { resourceRegistrationService } from "./resource-registration.js";
import { applicationService } from "./application-service.js";
import { applicationCapabilitiesService } from "./application-capabilities.js";

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
// Env override keeps unit tests hermetic; unset in production → default path.
const ACTIVATION_FILE =
  process.env.AGENT_CAPABILITIES_FILE || path.resolve(DATA_DIR, "agent-capabilities.json");

// ─── Types ───────────────────────────────────────────────────

export interface AgentCapabilityView {
  resourceId: string;
  type: "skill" | "mcp" | "hook-plugin" | "connector";
  name: string;
  version?: string;
  enabled: boolean;
  entitled: boolean;
  available: boolean; // resource exists and is valid
  status: "active" | "disabled" | "deprecated" | "invalid";
  unavailableReason?: string;
  appAllowlisted: boolean; // Phase 6 (A1): true if within app allowlist (or passthrough)
  registrationStatus: "published" | "draft" | "rejected" | "disabled" | null; // M4: null = unregistered
}

export interface UpdateAgentCapabilitiesInput {
  resources: Array<{ resourceId: string; enabled: boolean }>;
}

type ActivationStore = Record<string, string[]>; // agentId → resourceId[]

// ─── Internal helpers ────────────────────────────────────────

function readFromDisk(): ActivationStore {
  if (!fs.existsSync(ACTIVATION_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(ACTIVATION_FILE, "utf8"));
    return raw && typeof raw === "object" ? (raw as ActivationStore) : {};
  } catch (err) {
    console.warn("[AgentCapabilities] Failed to parse agent-capabilities.json, using empty:", err);
    return {};
  }
}

function writeToDisk(store: ActivationStore): void {
  fs.mkdirSync(path.dirname(ACTIVATION_FILE), { recursive: true });
  fs.writeFileSync(ACTIVATION_FILE, JSON.stringify(store, null, 2) + "\n");
}

function getEnabledSet(agentId: string): Set<string> {
  return new Set(readFromDisk()[agentId] ?? []);
}

function saveEnabledSet(agentId: string, ids: string[]): void {
  const store = readFromDisk();
  // Persist the key even when empty so list views can distinguish an Agent the
  // owner explicitly configured from one that has never been touched. Runtime
  // resolution itself is deny-default either way.
  store[agentId] = ids;
  writeToDisk(store);
}

function toView(r: CapabilityResourceView, enabled: boolean, ctx: RequestContext, appAllowlisted: boolean): AgentCapabilityView {
  const entitled = entitlementService.canConfigure(ctx, r.resourceId);
  const available = r.valid && r.status !== "invalid";
  const reg = resourceRegistrationService.getRegistration(r.resourceId);
  return {
    resourceId: r.resourceId,
    type: r.type,
    name: r.name,
    version: r.version,
    enabled,
    entitled,
    available,
    status: r.status,
    unavailableReason: !available ? r.error : undefined,
    appAllowlisted,
    registrationStatus: reg ? reg.status : null,
  };
}

// ─── Public API ──────────────────────────────────────────────

export class EntitlementError extends Error {
  constructor(public readonly resourceId: string) {
    super(`Not entitled to enable capability resource "${resourceId}"`);
    this.name = "EntitlementError";
  }
}

/** Thrown when an enable targets a resource that does not exist or is invalid. */
export class ResourceNotFoundError extends Error {
  constructor(public readonly resourceId: string) {
    super(`Capability resource not found or invalid: "${resourceId}"`);
    this.name = "ResourceNotFoundError";
  }
}

class AgentCapabilityServiceImpl {
  listAgentCapabilities(ctx: RequestContext, agentId: string): AgentCapabilityView[] {
    const enabled = getEnabledSet(agentId);
    // Phase 2b: a non-admin sees only resources they are entitled to configure,
    // PLUS any resource already enabled on this Agent (so they can disable it,
    // including a revoked-but-enabled one). Admin sees the full pool. This keeps
    // the full resource pool from leaking to non-admin users.
    //
    // Phase 6 (A1): compute appAllowlisted from DB appId (Codex: must not let
    // request URL appId drive the flag). null allowlist = passthrough = all true.
    const appId = applicationService.getAppIdForAgent(agentId);
    const appAllowlist = applicationCapabilitiesService.resolveAppAllowlist(appId);
    const allowSet = appAllowlist === null ? null : new Set(appAllowlist);
    const appAllowed = (rid: string): boolean =>
      allowSet === null ? true : allowSet.has(rid);

    return capabilityResourceService
      .listResources(ctx)
      .filter(
        (r) =>
          ctx.role === "admin" ||
          entitlementService.canConfigure(ctx, r.resourceId) ||
          enabled.has(r.resourceId)
      )
      .map((r) => toView(r, enabled.has(r.resourceId), ctx, appAllowed(r.resourceId)));
  }

  /**
   * Enable/disable resources on an Agent. Enabling requires the resource to
   * exist and be valid (getResource) AND pass entitlement (canConfigure);
   * disabling is always allowed. The whole op is applied only if every enable
   * passes — a rejected enable throws and persists nothing. The resource-validity
   * check runs before entitlement so admin-bypass (authz) still cannot enable an
   * arbitrary/unknown resource id.
   */
  updateAgentCapabilities(
    ctx: RequestContext,
    agentId: string,
    input: UpdateAgentCapabilitiesInput
  ): AgentCapabilityView[] {
    const enabled = getEnabledSet(agentId);
    for (const op of input.resources) {
      if (op.enabled) {
        const res = capabilityResourceService.getResource(ctx, op.resourceId);
        if (!res || !res.valid) {
          throw new ResourceNotFoundError(op.resourceId);
        }
        if (!entitlementService.canConfigure(ctx, op.resourceId)) {
          throw new EntitlementError(op.resourceId);
        }
        enabled.add(op.resourceId);
      } else {
        enabled.delete(op.resourceId);
      }
    }
    saveEnabledSet(agentId, [...enabled]);
    return this.listAgentCapabilities(ctx, agentId);
  }

  /**
   * Resource IDs enabled on the Agent AND currently entitled AND within the
   * app allowlist (deny-by-intersection). This is the intersection
   *   app allowlist ∩ enabled ∩ entitled
   * that CapabilityProvider.resolve() consumes. Re-checking entitlement here is
   * the revocation backstop.
   *
   * Phase 6 (A0): appId is resolved internally from agents.app_id (DB authority).
   * Callers CANNOT pass a forged appId — use resolveEnabledResourceIdsForApp
   * only when you have already resolved the authoritative appId from DB.
   */
  resolveEnabledResourceIds(ctx: RequestContext, agentId: string): string[] {
    const appId = applicationService.getAppIdForAgent(agentId);
    return this.resolveEnabledResourceIdsForApp(ctx, agentId, appId);
  }

  /**
   * Same as resolveEnabledResourceIds but accepts an already-resolved
   * authoritative appId. The caller MUST have resolved it from
   * applicationService.getAppIdForAgent(agentId) — never from user input.
   * This method exists so callers who already have the appId (e.g.
   * capability-provider, capability-version, diagnostics) avoid a redundant
   * DB lookup. If you are not sure, use resolveEnabledResourceIds instead.
   */
  resolveEnabledResourceIdsForApp(ctx: RequestContext, agentId: string, authoritativeAppId: string): string[] {
    const enabled = getEnabledSet(agentId);
    const entitled = [...enabled].filter((rid) => entitlementService.canConfigure(ctx, rid));
    // M4 (resource governance): registration-status gate — draft/rejected/
    // disabled resources never resolve into ANY new local or Docker runtime
    // (global kill switch). No registration row → legacy fallthrough. This is
    // the 4th leg of deny-by-intersection; app allowlist + entitlement +
    // activation are unchanged.
    const resolvable = entitled.filter((rid) => resourceRegistrationService.isResolvable(rid));
    // Phase 6 (A0): apply app allowlist as upper bound (deny-by-intersection).
    const appAllowlist = applicationCapabilitiesService.resolveAppAllowlist(authoritativeAppId);
    if (appAllowlist === null) return resolvable; // passthrough — no upper bound
    const allowSet = new Set(appAllowlist);
    return resolvable.filter((rid) => allowSet.has(rid));
  }

  /**
   * Whether the Agent has been explicitly configured (key present in the
   * activation store), regardless of the current enabled set or entitlement.
   * This is useful for UI/diagnostic semantics only; CapabilityProvider.resolve()
   * is deny-default for both missing keys and empty activation sets.
   */
  hasAnyActivation(agentId: string): boolean {
    return Object.prototype.hasOwnProperty.call(readFromDisk(), agentId);
  }

  /**
   * M6a: remove an Agent's activation key entirely (agent deletion path).
   * Prevents orphan keys in agent-capabilities.json outliving their agents.
   * No-op when the key is absent; returns whether a key was removed.
   */
  deleteAgentActivation(agentId: string): boolean {
    const store = readFromDisk();
    if (!Object.prototype.hasOwnProperty.call(store, agentId)) return false;
    delete store[agentId];
    writeToDisk(store);
    return true;
  }
}

export const agentCapabilityService = new AgentCapabilityServiceImpl();
