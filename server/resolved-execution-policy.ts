/**
 * ResolvedExecutionPolicy — platform-neutral execution DTO (M0.5 freeze).
 *
 * Plan §5.3 (docs/开发计划/local-microvm-runtime-整体研发计划.md):
 * - ONE-WAY, read-only view over the existing governance result. The only
 *   sources are CapabilityProvider.resolve() output, runtime-settings, and
 *   static platform safety defaults. Phase-1 adds NO admin config surface.
 * - approvalRequired is NEVER stored: it is always DERIVED as
 *   exposed − allowed − denied (the platform invariant
 *   `approvalRequired = tools − allowedTools − disallowedTools`).
 * - Inexpressible constraints FAIL CLOSED (createResolvedExecutionPolicy
 *   throws; the caller must refuse to start the runtime).
 * - No secrets: credential values never ride this DTO (plan §2 staged
 *   credential policy — M1 short-lived test creds / M3 egress proxy).
 *
 * This module is intentionally dependency-free (pure TS, no imports) so it
 * can be consumed on both sides of the Host/Guest boundary.
 */

export interface GovernedMcpDescriptor {
  /** Unique server name within the policy. */
  name: string;
  transport: "stdio" | "in-process";
  /**
   * stdio only: absolute path to the server executable. Engine adapters
   * apply their own governed-root prefix rule (e.g. /opt/agent/mcp/ in the
   * Docker image); the platform-neutral check here is absolute + no "..".
   */
  command?: string;
  readonly args?: readonly string[];
}

export interface WorkspacePolicyRoot {
  path: string;
  access: "ro" | "rw";
}

export interface WorkspacePolicy {
  /** Explicitly mounted roots. Unlisted host paths must not exist to the guest. */
  readonly roots: readonly WorkspacePolicyRoot[];
  /** Engine-private state dir (e.g. session store), neutral name. */
  engineStateRoot?: string;
}

/**
 * Fail-closed default is "none". "public-https" allows only declared public
 * HTTPS egress (RFC1918/link-local/metadata always blocked at the runtime
 * layer); "declared" allows exactly declaredHosts.
 */
export interface NetworkPolicy {
  egress: "none" | "public-https" | "declared";
  readonly declaredHosts?: readonly string[];
}

export interface ResourcePolicy {
  maxMemoryMb?: number;
  maxCpuCores?: number;
  maxTurns?: number;
  workspaceQuotaMb?: number;
}

/**
 * M3-S3B egress mode. "host-proxy": the Guest's engine calls go through the
 * Host credential proxy (the Guest submits model_request INTENTS; the Host
 * stamps governed model/provider/target and executes with Host-only
 * credentials). Absent = deny-all broker (fail closed, M3-S1 semantics).
 * NEVER carries a credential value (plan §2: no secrets on this DTO).
 */
export interface EgressPolicy {
  mode: "host-proxy";
}

export interface ResolvedExecutionPolicyInput {
  modelRef: string;
  exposedToolIds: string[];
  allowedToolIds: string[];
  deniedToolIds: string[];
  mcpServers: GovernedMcpDescriptor[];
  workspacePolicy: WorkspacePolicy;
  networkPolicy: NetworkPolicy;
  resourcePolicy: ResourcePolicy;
  egress?: EgressPolicy;
}

export interface ResolvedExecutionPolicy {
  readonly modelRef: string;
  readonly exposedToolIds: readonly string[];
  readonly allowedToolIds: readonly string[];
  readonly deniedToolIds: readonly string[];
  readonly mcpServers: readonly GovernedMcpDescriptor[];
  readonly workspacePolicy: Readonly<WorkspacePolicy>;
  readonly networkPolicy: Readonly<NetworkPolicy>;
  readonly resourcePolicy: Readonly<ResourcePolicy>;
  readonly egress?: Readonly<EgressPolicy>;
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

// Bounds — defensive caps so a hostile control-plane bug cannot smuggle an
// unbounded policy across the wire.
const MAX_TOOLS = 100;
const MAX_MCP_SERVERS = 50;
const MAX_HOSTS = 100;
const MAX_ROOTS = 16;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function assertStringList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) throw new PolicyValidationError(`${field} must be an array`);
  if (value.length > max) throw new PolicyValidationError(`${field} exceeds ${max} entries`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isNonEmptyString(item)) throw new PolicyValidationError(`${field} entries must be non-empty strings`);
    if (seen.has(item)) throw new PolicyValidationError(`${field} contains duplicate '${item}'`);
    seen.add(item);
    out.push(item);
  }
  return out;
}

function assertFinitePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PolicyValidationError(`${field} must be a finite positive number`);
  }
  return value;
}

/**
 * Construct + validate a policy. Throws PolicyValidationError on ANY
 * violation — never coerces, never silently drops a constraint (fail closed).
 */
export function createResolvedExecutionPolicy(input: ResolvedExecutionPolicyInput): ResolvedExecutionPolicy {
  if (!isNonEmptyString(input?.modelRef)) throw new PolicyValidationError("modelRef must be a non-empty string");

  const exposedToolIds = assertStringList(input.exposedToolIds, "exposedToolIds", MAX_TOOLS);
  const allowedToolIds = assertStringList(input.allowedToolIds, "allowedToolIds", MAX_TOOLS);
  const deniedToolIds = assertStringList(input.deniedToolIds, "deniedToolIds", MAX_TOOLS);

  // Subset + disjointness (plan §5.3: 防止 compiler 漂移)
  const exposed = new Set(exposedToolIds);
  for (const t of allowedToolIds) {
    if (!exposed.has(t)) throw new PolicyValidationError(`allowedToolIds '${t}' is not in exposedToolIds`);
  }
  for (const t of deniedToolIds) {
    if (!exposed.has(t)) throw new PolicyValidationError(`deniedToolIds '${t}' is not in exposedToolIds`);
    if (allowedToolIds.includes(t)) throw new PolicyValidationError(`'${t}' is both allowed and denied`);
  }
  // Empty exposedToolIds is VALID: L0/L1 text-only engines expose no tools.

  // MCP descriptors
  if (!Array.isArray(input.mcpServers)) throw new PolicyValidationError("mcpServers must be an array");
  if (input.mcpServers.length > MAX_MCP_SERVERS) throw new PolicyValidationError(`mcpServers exceeds ${MAX_MCP_SERVERS}`);
  const mcpNames = new Set<string>();
  for (const m of input.mcpServers) {
    if (!isNonEmptyString(m?.name)) throw new PolicyValidationError("mcpServers[].name must be a non-empty string");
    if (mcpNames.has(m.name)) throw new PolicyValidationError(`duplicate mcp server name '${m.name}'`);
    mcpNames.add(m.name);
    if (m.transport === "stdio") {
      if (!isNonEmptyString(m.command)) throw new PolicyValidationError(`stdio mcp '${m.name}' requires a command`);
      if (!m.command.startsWith("/")) throw new PolicyValidationError(`stdio mcp '${m.name}' command must be an absolute path`);
      if (m.command.split("/").includes("..")) throw new PolicyValidationError(`stdio mcp '${m.name}' command must not contain '..'`);
    } else if (m.transport !== "in-process") {
      throw new PolicyValidationError(`mcp '${m.name}' has unsupported transport '${m.transport}'`);
    }
  }

  // Workspace / network / resource
  const wp = input.workspacePolicy;
  if (!wp || !Array.isArray(wp.roots)) throw new PolicyValidationError("workspacePolicy.roots must be an array");
  if (wp.roots.length > MAX_ROOTS) throw new PolicyValidationError(`workspacePolicy.roots exceeds ${MAX_ROOTS}`);
  for (const r of wp.roots) {
    if (!isNonEmptyString(r?.path) || !r.path.startsWith("/") || r.path.split("/").includes("..")) {
      throw new PolicyValidationError("workspacePolicy.roots[].path must be absolute without '..'");
    }
    if (r.access !== "ro" && r.access !== "rw") throw new PolicyValidationError("workspacePolicy.roots[].access must be 'ro'|'rw'");
  }

  const np = input.networkPolicy;
  if (!np || !["none", "public-https", "declared"].includes(np.egress)) {
    throw new PolicyValidationError("networkPolicy.egress must be 'none'|'public-https'|'declared'");
  }
  const declaredHosts = np.egress === "declared" ? assertStringList(np.declaredHosts ?? [], "networkPolicy.declaredHosts", MAX_HOSTS) : undefined;

  const rp = input.resourcePolicy ?? {};
  const resourcePolicy: ResourcePolicy = {
    ...(rp.maxMemoryMb !== undefined ? { maxMemoryMb: assertFinitePositiveNumber(rp.maxMemoryMb, "resourcePolicy.maxMemoryMb") } : {}),
    ...(rp.maxCpuCores !== undefined ? { maxCpuCores: assertFinitePositiveNumber(rp.maxCpuCores, "resourcePolicy.maxCpuCores") } : {}),
    ...(rp.maxTurns !== undefined ? { maxTurns: assertFinitePositiveNumber(rp.maxTurns, "resourcePolicy.maxTurns") } : {}),
    ...(rp.workspaceQuotaMb !== undefined ? { workspaceQuotaMb: assertFinitePositiveNumber(rp.workspaceQuotaMb, "resourcePolicy.workspaceQuotaMb") } : {}),
  };

  // M3-S3B: the ONLY accepted egress mode is the Host credential proxy;
  // absent stays absent (deny-all broker on the Guest, M3-S1 semantics).
  if (input.egress !== undefined && input.egress.mode !== "host-proxy") {
    throw new PolicyValidationError("egress.mode must be 'host-proxy'");
  }

  // Deep-freeze: the DTO crossing the boundary is read-only.
  return Object.freeze({
    modelRef: input.modelRef,
    exposedToolIds: Object.freeze([...exposedToolIds]),
    allowedToolIds: Object.freeze([...allowedToolIds]),
    deniedToolIds: Object.freeze([...deniedToolIds]),
    mcpServers: Object.freeze(input.mcpServers.map((m) => Object.freeze({ ...m, args: m.args ? Object.freeze([...m.args]) : undefined }))),
    workspacePolicy: Object.freeze({
      roots: Object.freeze(wp.roots.map((r) => Object.freeze({ ...r }))),
      ...(wp.engineStateRoot !== undefined ? { engineStateRoot: wp.engineStateRoot } : {}),
    }),
    networkPolicy: Object.freeze({ egress: np.egress, ...(declaredHosts ? { declaredHosts: Object.freeze([...declaredHosts]) } : {}) }),
    resourcePolicy: Object.freeze(resourcePolicy),
    ...(input.egress !== undefined ? { egress: Object.freeze({ mode: input.egress.mode }) } : {}),
  });
}

/**
 * DERIVED, never stored (plan §5.3): approval set = exposed − allowed − denied.
 */
export function approvalRequiredToolIds(policy: ResolvedExecutionPolicy): string[] {
  const allowed = new Set(policy.allowedToolIds);
  const denied = new Set(policy.deniedToolIds);
  return policy.exposedToolIds.filter((t) => !allowed.has(t) && !denied.has(t));
}

// ─── M3-S1: one-way compiler (CapabilityBundle view → policy input) ─────────
//
// Single-direction compile, never a second permission resolver (M3-S1 hard
// boundary): the ONLY inputs are the existing CapabilityProvider.resolve()
// output (structurally typed below — this module stays import-free so both
// Host and Guest can consume it) plus runtime-settings resource values.
// Anything the bundle cannot express fails CLOSED (throws) — the caller must
// refuse to start the runtime rather than guess.

/** Structural view of CapabilityProvider's bundle (no import; both-sides safe). */
export interface CapabilityBundleView {
  sdkOptions: {
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    mcpServers?: Record<string, unknown>;
    maxTurns?: number;
    model?: string;
  };
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
}

/** Structural view of the runtime-settings fields the policy consumes. */
export interface RuntimeSettingsView {
  defaultModel: string;
  memoryMb?: number;
  cpuCores?: number;
}

/** Governed MCP root the engine adapter enforces (docker parity: /opt/agent/mcp/). */
export const GOVERNED_MCP_ROOT = "/opt/agent/mcp/";

/** Compile a bundle + settings into a policy input. Throws PolicyValidationError
 *  on anything unrepresentable — fail closed, no coercion. */
export function compilePolicyInput(
  bundle: CapabilityBundleView,
  settings: RuntimeSettingsView,
): ResolvedExecutionPolicyInput {
  if (!bundle || typeof bundle !== "object") throw new PolicyValidationError("capability bundle required");
  const sdk = bundle.sdkOptions ?? {};
  if (!Array.isArray(bundle.mounts)) throw new PolicyValidationError("bundle.mounts must be an array");

  const modelRef = typeof sdk.model === "string" && sdk.model ? sdk.model : settings.defaultModel;
  if (!modelRef) throw new PolicyValidationError("no modelRef (bundle.model and settings.defaultModel both absent)");

  const exposedToolIds = sdk.tools ?? [];
  const allowedToolIds = sdk.allowedTools ?? [];
  const deniedToolIds = sdk.disallowedTools ?? [];

  // MCP: only stdio servers with commands under the governed root cross;
  // anything else (in-process only exists Host-side; arbitrary command paths
  // are engine-ungoverned) FAILS CLOSED rather than being dropped silently.
  const mcpServers: GovernedMcpDescriptor[] = [];
  for (const [name, raw] of Object.entries(sdk.mcpServers ?? {})) {
    const cmd = (raw as { command?: unknown } | null)?.command;
    if (typeof cmd !== "string" || !cmd.startsWith(GOVERNED_MCP_ROOT)) {
      throw new PolicyValidationError(
        `mcp server '${name}' command missing or outside ${GOVERNED_MCP_ROOT} (inexpressible in sandbox policy)`,
      );
    }
    if (cmd.split("/").includes("..")) {
      throw new PolicyValidationError(`mcp server '${name}' command must not contain '..'`);
    }
    const args = (raw as { args?: unknown } | null)?.args;
    mcpServers.push({
      name,
      transport: "stdio",
      command: cmd,
      ...(Array.isArray(args) ? { args: args.map(String) } : {}),
    });
  }

  // Workspace: mounts are the ONLY guest-visible roots (ro/rw as declared).
  const workspacePolicy: WorkspacePolicy = {
    roots: bundle.mounts.map((m) => ({
      path: m.containerPath,
      access: m.readonly ? ("ro" as const) : ("rw" as const),
    })),
  };

  // Network: the sandbox layer defaults to deny; the bundle has no egress
  // concept, so M3-S1 compiles "none". Declared egress arrives with the
  // egress credential proxy (later M3 stage) — never guessed here.
  const networkPolicy: NetworkPolicy = { egress: "none" };

  const resourcePolicy: ResourcePolicy = {
    ...(typeof sdk.maxTurns === "number" ? { maxTurns: sdk.maxTurns } : {}),
    ...(typeof settings.memoryMb === "number" ? { maxMemoryMb: settings.memoryMb } : {}),
    ...(typeof settings.cpuCores === "number" ? { maxCpuCores: settings.cpuCores } : {}),
  };

  // createResolvedExecutionPolicy performs the full validation (bounds,
  // subset/disjointness, freeze) — a single validation authority.
  return {
    modelRef,
    exposedToolIds,
    allowedToolIds,
    deniedToolIds,
    mcpServers,
    workspacePolicy,
    networkPolicy,
    resourcePolicy,
  };
}
