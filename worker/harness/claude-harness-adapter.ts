/**
 * claude-harness-adapter.ts — Claude committed engine adapter (M3-S1).
 *
 * Two one-way translations, nothing else:
 *   ① compileClaudeQueryConfig: platform policy → Claude SDK query options
 *      (tools/allowed/disallowed/model/maxTurns/mcpServers). The policy is
 *      the ONLY input — the adapter adds nothing, removes nothing, guesses
 *      nothing (inexpressible constraints already failed closed upstream).
 *   ② mapSdkMessage: raw SDK message → PlatformRuntimeEvent[], delegated to
 *      the M0.5 ClaudeEventNormalizer (bounded, redacted, deduped). Raw SDK
 *      envelopes NEVER cross the Worker boundary.
 *
 * Multi-engine neutrality (M3-S1 request): Host-facing identity fields are
 * engineId / engineSessionId / modelRef / toolCallId — engine-private names
 * live only inside this adapter.
 *
 * Capabilities: only what the adapter's focused tests actually exercise
 * (server/m3-claude-harness-adapter.test.ts) — never a promissory list.
 */

import {
  ClaudeEventNormalizer,
} from "../../server/claude-event-normalizer.js";
import {
  CLAUDE_ENGINE_CAPABILITIES,
  type EngineCapabilities,
} from "../../server/platform-runtime-protocol.js";
import type { ResolvedExecutionPolicy } from "../../server/resolved-execution-policy.js";
import { GOVERNED_MCP_ROOT } from "../../server/resolved-execution-policy.js";

export const CLAUDE_ENGINE_ID = "claude" as const;

/** Structured view of the SDK query options this adapter compiles to. */
export interface ClaudeQueryConfig {
  engineId: typeof CLAUDE_ENGINE_ID;
  model: string;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  mcpServers: Record<string, { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }>;
  /** Resume token (engine session id from a previous run), if any. */
  resume?: string;
}

/**
 * ① Policy → engine query config. Pure; throws only if the policy carries an
 * unrepresentable field (defense in depth — createResolvedExecutionPolicy
 * already validated everything it can express).
 */
export function compileClaudeQueryConfig(
  policy: ResolvedExecutionPolicy,
  extras: { resume?: string } = {},
): ClaudeQueryConfig {
  const mcpServers: ClaudeQueryConfig["mcpServers"] = {};
  for (const m of policy.mcpServers) {
    // Defense in depth: the governed root check lives in the policy compiler;
    // the adapter re-checks rather than trusting (a hostile/buggy upstream
    // must not smuggle an arbitrary command into the engine).
    if (m.transport !== "stdio" || !m.command?.startsWith(GOVERNED_MCP_ROOT)) {
      throw new Error(`mcp '${m.name}' outside ${GOVERNED_MCP_ROOT} refused by claude adapter`);
    }
    mcpServers[m.name] = { type: "stdio", command: m.command, ...(m.args ? { args: [...m.args] } : {}) };
  }
  return {
    engineId: CLAUDE_ENGINE_ID,
    model: policy.modelRef,
    tools: [...policy.exposedToolIds],
    allowedTools: [...policy.allowedToolIds],
    disallowedTools: [...policy.deniedToolIds],
    ...(policy.resourcePolicy.maxTurns !== undefined ? { maxTurns: policy.resourcePolicy.maxTurns } : {}),
    mcpServers,
    ...(extras.resume ? { resume: extras.resume } : {}),
  };
}

/** Capability set this adapter has PASSED in focused tests (M3-S1). */
export const CLAUDE_HARNESS_CAPABILITIES: EngineCapabilities = {
  ...CLAUDE_ENGINE_CAPABILITIES,
  // a2ui/mcp are compiled + mapped in tests but NOT yet exercised end-to-end
  // inside a real Guest (no node in the pinned alpine image) — declared false
  // until a later M3 stage proves them in the sandbox. maxPromisableLevel: 3.
  a2ui: false,
  mcp: false,
};

/**
 * ② SDK message → platform events. Thin wrapper: owns one normalizer per
 * session (per-turn dedup + internal-tool tracking is session state).
 */
export class ClaudeHarnessAdapter {
  readonly engineId = CLAUDE_ENGINE_ID;
  readonly capabilities: EngineCapabilities = CLAUDE_HARNESS_CAPABILITIES;
  private readonly normalizer = new ClaudeEventNormalizer();

  mapSdkMessage(raw: unknown) {
    return this.normalizer.push(raw);
  }
}
