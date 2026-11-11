/**
 * entitlement.ts — Phase 2b configuration entitlement (Phase 7.3: org-aware).
 *
 * Controls WHO may attach a capability resource to an Agent. File-backed
 * (data/entitlements.json), no database. Locked rules (migration Phase 2b):
 *   - admin-bypass: admin role may configure all resources.
 *   - default effect: DENY (least privilege).
 *   - precedence: user > org (org < team < user chain reserved; team not built).
 *   - deny-overrides-allow within a scope.
 *   - grantedBy + grantedAt persisted for audit even though MVP merges admin roles.
 *
 * Phase 7.3 (multi-tenancy): org-scope is the tenant boundary. canConfigure and
 * listEntitledResources match org-scope entries ONLY against ctx.orgId, so an
 * allow scoped to orgA never grants orgB (cross-org deny is structural, not
 * policy). setEntitlements guards the WRITE path: a non-admin (org_admin) may
 * only write org-scope entries for their own org — no cross-org, no user-scope
 * spill. listEntriesForCtx scopes the READ path the same way. See
 * docs/02-architecture/configuration-plane-interface-design.md §5 and
 * docs/05-migration Phase 2b + 7.3.
 */

import path from "path";
import fs from "fs";
import type { RequestContext } from "./request-context.js";

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
// Env override keeps unit tests hermetic; unset in production → default path.
const ENTITLEMENTS_FILE =
  process.env.ENTITLEMENTS_FILE || path.resolve(DATA_DIR, "entitlements.json");

// ─── Types ───────────────────────────────────────────────────

export type ScopeType = "org" | "user";
export type Effect = "allow" | "deny";

export interface EntitlementEntry {
  resourceId: string;
  scopeType: ScopeType;
  scopeId: string; // orgId (org-scope) or userId (user-scope)
  effect: Effect;
  grantedBy: string; // userId of the admin who set it (audit)
  grantedAt: string; // ISO timestamp (audit)
}

/** Input shape for setEntitlements — audit fields are filled by the service. */
export type EntitlementEntryInput = Omit<EntitlementEntry, "resourceId" | "grantedBy" | "grantedAt">;

interface EntitlementStore {
  entries: EntitlementEntry[];
}

// ─── Internal helpers ────────────────────────────────────────

function readFromDisk(): EntitlementStore {
  if (!fs.existsSync(ENTITLEMENTS_FILE)) return { entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(ENTITLEMENTS_FILE, "utf8"));
    return { entries: Array.isArray(raw?.entries) ? (raw.entries as EntitlementEntry[]) : [] };
  } catch (err) {
    console.warn("[Entitlement] Failed to parse entitlements.json, using empty:", err);
    return { entries: [] };
  }
}

function writeToDisk(store: EntitlementStore): void {
  fs.mkdirSync(path.dirname(ENTITLEMENTS_FILE), { recursive: true });
  fs.writeFileSync(ENTITLEMENTS_FILE, JSON.stringify(store, null, 2) + "\n");
}

function entriesFor(resourceId: string): EntitlementEntry[] {
  return readFromDisk().entries.filter((e) => e.resourceId === resourceId);
}

// Resolve a scope's entries: deny wins over allow; empty → "none".
function resolveScope(entries: EntitlementEntry[]): Effect | "none" {
  if (entries.some((e) => e.effect === "deny")) return "deny";
  if (entries.some((e) => e.effect === "allow")) return "allow";
  return "none";
}

// ─── Public API ──────────────────────────────────────────────

/** Phase 7.3: a non-admin tried to write an entitlement entry outside their org. */
export class EntitlementScopeError extends Error {
  constructor(scopeType: string, scopeId: string, actorOrg: string) {
    super(
      `Entitlement entry ${scopeType}:${scopeId} is outside the caller's org "${actorOrg}"`
    );
    this.name = "EntitlementScopeError";
  }
}

export interface EntitlementService {
  canConfigure(ctx: RequestContext, resourceId: string): boolean;
  listEntitledResources(ctx: RequestContext): string[];
  setEntitlements(
    ctx: RequestContext,
    resourceId: string,
    entries: EntitlementEntryInput[]
  ): EntitlementEntry[];
  /** Raw entries (admin/audit view) — NOT org-filtered. */
  listEntries(resourceId: string): EntitlementEntry[];
  /** Phase 7.3: org-filtered entries for the caller. admin sees all; anyone else
   *  sees only own-org org-scope entries. Use this on privileged admin routes. */
  listEntriesForCtx(ctx: RequestContext, resourceId: string): EntitlementEntry[];
  /** Phase 7.5: org-aggregate view across ALL resources — admin sees every
   *  entry; anyone else sees only own-org org-scope entries (the caller's
   *  org-authorized resource set). Use this on the org-aggregate admin route
   *  (GET /api/admin/entitlements). */
  listAllEntriesForCtx(ctx: RequestContext): EntitlementEntry[];
  /**
   * M7b fix round P1-2: fail-closed preflight for the approve write chain.
   * The file read path silently falls back to empty on malformed bytes, so a
   * write would RESET the store — callers must preflight before enabling
   * anything. Throws EntitlementStoreError on invalid bytes/shape.
   */
  assertHealthy(): void;
}

/** M7b fix round P1-2: the entitlements store is malformed — refuse writes. */
export class EntitlementStoreError extends Error {
  constructor(path: string) {
    super(`entitlements store ${path} is malformed — refusing to overwrite it`);
    this.name = "EntitlementStoreError";
  }
}

class FileEntitlementService implements EntitlementService {
  assertHealthy(): void {
    if (!fs.existsSync(ENTITLEMENTS_FILE)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(ENTITLEMENTS_FILE, "utf8"));
    } catch {
      throw new EntitlementStoreError(ENTITLEMENTS_FILE);
    }
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as EntitlementStore).entries)) {
      throw new EntitlementStoreError(ENTITLEMENTS_FILE);
    }
  }

  canConfigure(ctx: RequestContext, resourceId: string): boolean {
    // admin-bypass (cross-org super-user).
    if (ctx.role === "admin") return true;

    const all = entriesFor(resourceId);
    // precedence: user > org. Phase 7.3: org-scope matches ONLY ctx.orgId, so an
    // allow scoped to another org can never grant here (structural cross-org deny).
    const userEffect = resolveScope(
      all.filter((e) => e.scopeType === "user" && e.scopeId === ctx.userId)
    );
    if (userEffect !== "none") return userEffect === "allow";
    const orgEffect = resolveScope(
      all.filter((e) => e.scopeType === "org" && e.scopeId === ctx.orgId)
    );
    if (orgEffect !== "none") return orgEffect === "allow";
    return false; // deny-default
  }

  listEntitledResources(ctx: RequestContext): string[] {
    // Admins bypass entitlement (the caller lists all resources for them).
    if (ctx.role === "admin") return [];
    const store = readFromDisk();
    const candidates = new Set<string>();
    for (const e of store.entries) {
      if (e.effect !== "allow") continue;
      // Phase 7.3: an entry matches the caller only within their own scope —
      // user-scope by userId, org-scope by ctx.orgId. Cross-org entries never match.
      const matches =
        (e.scopeType === "user" && e.scopeId === ctx.userId) ||
        (e.scopeType === "org" && e.scopeId === ctx.orgId);
      if (matches) candidates.add(e.resourceId);
    }
    // Drop any candidate that a higher-precedence deny revokes.
    return [...candidates].filter((rid) => this.canConfigure(ctx, rid));
  }

  setEntitlements(
    ctx: RequestContext,
    resourceId: string,
    incoming: EntitlementEntryInput[]
  ): EntitlementEntry[] {
    // Phase 7.3: WRITE org-scope guard. admin (cross-org super-user) may set any
    // entry. A non-admin (org_admin) may ONLY write org-scope entries for their
    // OWN org — a cross-org or user-scope entry would spill entitlements across
    // the tenant boundary. user-scope grants remain an admin-only finer tool.
    if (ctx.role !== "admin") {
      for (const e of incoming) {
        if (e.scopeType !== "org" || e.scopeId !== ctx.orgId) {
          throw new EntitlementScopeError(e.scopeType, e.scopeId, ctx.orgId);
        }
      }
    }
    // PUT semantics with a scoped-replace guard (M2a): admin replaces ALL
    // entries for this resourceId; a non-admin replaces ONLY their own org's
    // org-scope entries for it. Without the guard, an org_admin PUT would wipe
    // every other org's (and every admin-set user-scope) entry for the
    // resource — a cross-tenant destroy via replace semantics.
    const store = readFromDisk();
    const isOwnOrgOrgScope = (e: EntitlementEntry) =>
      e.resourceId === resourceId && e.scopeType === "org" && e.scopeId === ctx.orgId;
    const keep =
      ctx.role === "admin"
        ? store.entries.filter((e) => e.resourceId !== resourceId)
        : store.entries.filter((e) => !isOwnOrgOrgScope(e));
    const grantedAt = new Date().toISOString();
    const added: EntitlementEntry[] = incoming.map((e) => ({
      resourceId,
      scopeType: e.scopeType,
      scopeId: e.scopeId,
      effect: e.effect,
      grantedBy: ctx.userId,
      grantedAt,
    }));
    store.entries = [...keep, ...added];
    writeToDisk(store);
    return added;
  }

  listEntries(resourceId: string): EntitlementEntry[] {
    return entriesFor(resourceId);
  }

  listEntriesForCtx(ctx: RequestContext, resourceId: string): EntitlementEntry[] {
    const all = entriesFor(resourceId);
    if (ctx.role === "admin") return all;
    // org_admin / non-admin: own-org org-scope entries only. user-scope entries
    // are admin-visible (per-org filtering would need a user-org lookup, deferred).
    return all.filter((e) => e.scopeType === "org" && e.scopeId === ctx.orgId);
  }

  listAllEntriesForCtx(ctx: RequestContext): EntitlementEntry[] {
    const all = readFromDisk().entries;
    if (ctx.role === "admin") return all;
    // Same org-scoping rule as listEntriesForCtx, applied across ALL resources.
    return all.filter((e) => e.scopeType === "org" && e.scopeId === ctx.orgId);
  }
}

export const entitlementService: EntitlementService = new FileEntitlementService();
