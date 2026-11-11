/**
 * connector-capability-token.ts — Octop absorption M1b
 * (codex evt_20261020075047 / artifact evt_20261020073311-m1b-instruction.md §3).
 *
 * Short-lived INTERNAL-MCP capability token + in-memory runtime-scoped
 * active/revocation registry. This is the ONLY thing that enters a runtime's
 * MCP configuration — external-service raw credentials never leave the host.
 *
 * Token contract:
 *   - JWT, audience "internal-mcp", claim kind "internal-mcp". Tokens with any
 *     other (or missing) audience are structurally rejected — browser/user
 *     app/widget JWTs can never be replayed here even though they share the
 *     signing secret.
 *   - Bound claims: orgId, appId, agentId, runtimeId, connectorInstanceId,
 *     allowedTools, configVersion (+ userId/role for per-call revalidation of
 *     the authorization intersection). exp + jti (registry-tracked).
 *   - TTL short + configurable: CONNECTOR_MCP_TOKEN_TTL_MS (default 15 min,
 *     clamped to [1 min, 24 h]).
 *
 * Registry semantics (all in-memory — process restart clears every token,
 * which is fail-closed: runtimes rebuild on next message):
 *   - mint() first revokes any still-active token for the SAME
 *     (agentId, connectorInstanceId): a re-resolved runtime's token replaces
 *     the old runtime's token, so stale-runtime tokens die immediately.
 *   - revokeForRuntime(runtimeKey) — ContainerManager.stopRuntime hook.
 *   - revokeForConnector(instanceId) — connector-store disableInstance hook.
 *   - verify() requires the jti to be ACTIVE in the registry (in addition to
 *     signature/exp) — revocation is immediate, never waits for expiry.
 *
 * The token is never serialized into audit, logs, diagnostics, or responses.
 * Only capability-provider.resolve() mints (into the bundle MCP header) and
 * connector-mcp.ts verifies.
 */

import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

export const INTERNAL_MCP_AUDIENCE = "internal-mcp";

const DEFAULT_TTL_MS = 15 * 60_000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

function tokenTtlMs(): number {
  const raw = Number(process.env.CONNECTOR_MCP_TOKEN_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, raw));
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

export interface ConnectorTokenClaims {
  kind: "internal-mcp";
  orgId: string;
  appId: string;
  agentId: string;
  runtimeId: string;
  runtimeKey: string;
  connectorInstanceId: string;
  allowedTools: string[];
  configVersion: number;
  userId: string;
  role: "admin" | "org_admin" | "user";
  jti: string;
  aud: string;
  exp: number;
}

export interface MintConnectorTokenInput {
  orgId: string;
  appId: string;
  agentId: string;
  /** ContainerManager runtime key "userId:chatId" — revocation hook handle. */
  runtimeKey: string;
  connectorInstanceId: string;
  allowedTools: string[];
  configVersion: number;
  userId: string;
  role: "admin" | "org_admin" | "user";
}

interface RegistryEntry {
  jti: string;
  runtimeKey: string;
  agentId: string;
  connectorInstanceId: string;
  exp: number;
}

const activeTokens = new Map<string, RegistryEntry>();

function pruneExpired(now = Date.now()): void {
  for (const [jti, e] of activeTokens) {
    if (e.exp * 1000 <= now) activeTokens.delete(jti);
  }
}

export function mintConnectorToken(input: MintConnectorTokenInput): string {
  pruneExpired();
  // Replace semantics: an agent has one live runtime per connector — a fresh
  // resolve (rebuild/recovery) kills the previous runtime's token immediately.
  for (const [jti, e] of activeTokens) {
    if (e.agentId === input.agentId && e.connectorInstanceId === input.connectorInstanceId) {
      activeTokens.delete(jti);
    }
  }
  const jti = randomUUID();
  const runtimeId = `${input.runtimeKey}#${randomUUID()}`;
  const exp = Math.floor((Date.now() + tokenTtlMs()) / 1000);
  activeTokens.set(jti, {
    jti,
    runtimeKey: input.runtimeKey,
    agentId: input.agentId,
    connectorInstanceId: input.connectorInstanceId,
    exp,
  });
  return jwt.sign(
    {
      kind: "internal-mcp",
      orgId: input.orgId,
      appId: input.appId,
      agentId: input.agentId,
      runtimeId,
      runtimeKey: input.runtimeKey,
      connectorInstanceId: input.connectorInstanceId,
      allowedTools: input.allowedTools,
      configVersion: input.configVersion,
      userId: input.userId,
      role: input.role,
    },
    JWT_SECRET,
    { audience: INTERNAL_MCP_AUDIENCE, expiresIn: tokenTtlMs() / 1000, jwtid: jti }
  );
}

export class ConnectorTokenError extends Error {}

/**
 * Verify signature + audience + expiry + active registry entry. Returns the
 * claims on success; throws ConnectorTokenError otherwise. Callers then do the
 * per-call semantic checks (instance state, configVersion, authorization
 * intersection, tool binding) in connector-mcp.ts.
 */
export function verifyConnectorToken(token: string): ConnectorTokenClaims {
  let claims: Record<string, unknown>;
  try {
    claims = jwt.verify(token, JWT_SECRET, { audience: INTERNAL_MCP_AUDIENCE }) as Record<
      string,
      unknown
    >;
  } catch (err: any) {
    throw new ConnectorTokenError(`token rejected: ${err?.message ?? "invalid"}`);
  }
  if (claims.kind !== "internal-mcp") {
    throw new ConnectorTokenError("token rejected: wrong kind");
  }
  const jti = String(claims.jti ?? "");
  pruneExpired();
  if (!activeTokens.has(jti)) {
    throw new ConnectorTokenError("token rejected: revoked or unknown jti");
  }
  return claims as unknown as ConnectorTokenClaims;
}

export function revokeConnectorTokensForRuntime(runtimeKey: string): number {
  let n = 0;
  for (const [jti, e] of activeTokens) {
    if (e.runtimeKey === runtimeKey) {
      activeTokens.delete(jti);
      n++;
    }
  }
  return n;
}

export function revokeConnectorTokensForConnector(instanceId: string): number {
  let n = 0;
  for (const [jti, e] of activeTokens) {
    if (e.connectorInstanceId === instanceId) {
      activeTokens.delete(jti);
      n++;
    }
  }
  return n;
}

/** Test/diagnostic view — token COUNTS only, never any token material. */
export function activeConnectorTokenCount(): number {
  pruneExpired();
  return activeTokens.size;
}
