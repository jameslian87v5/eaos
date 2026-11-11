/**
 * agent-builder.ts — Octop absorption M6a: governed expert creation.
 *
 * The workbench "创建 Agent" journey, server-orchestrated in ONE contract so
 * the client never chains multiple write APIs into a half-built Agent:
 *   GET  /api/agent-builder/options → { templates, capabilities }
 *   POST /api/agent-builder         → { agent }  (routes in agent-builder-routes.ts)
 *
 * Templates are CREATION PRESETS only (id/name/description/systemPrompt/
 * welcomeMessage/quickPrompts/icon/color) — not a second profile system, not
 * a marketplace, not an application domain model. Everything a template
 * presets could be typed by hand in the drawer.
 *
 * Capability upper bound (invariant): the selectable set is
 *   user entitlement ∩ default-app allowlist ∩ {active, valid, registered}
 * computed server-side for BOTH the options listing AND the create
 * re-validation — the client filter is UX, never authority. A tampered
 * capabilityIds entry rejects the WHOLE creation.
 *
 * Failure convergence: the agent row + per-Agent prompt override + starter
 * metadata (template_id / welcome_message / quick_prompts) are written in ONE
 * SQLite transaction; the activation store (JSON file, non-transactional) is
 * written afterwards and its failure compensates by deleting the agent row
 * (which also cleans the activation key via AgentService.deleteChat). No
 * visible Agent, no residual activation, no starter half-state survives.
 *
 * Starter metadata is SERVER-persisted (agents table columns) — never
 * localStorage; quick prompts fill the composer but never auto-send.
 */
import db from "./database.js";
import { agentService } from "./agent-service.js";
import { agentCapabilityService } from "./agent-capabilities.js";
import { entitlementService } from "./entitlement.js";
import { capabilityResourceService, type CapabilityResourceView } from "./capability-resource.js";
import { resourceRegistrationService } from "./resource-registration.js";
import { applicationCapabilitiesService } from "./application-capabilities.js";
import { sanitizePromptText, getPromptSettings } from "./prompt-settings.js";
import { assertOrgActive, OrgNotActiveError } from "./org-governance.js";
import { assertQuota, QuotaExceededError } from "./quota-service.js";
import type { RequestContext } from "./request-context.js";
import type { Agent } from "./types.js";

// The workbench IS the default application — the builder always creates
// default-app agents (chatId == agentId compatibility bridge unchanged).
const BUILDER_APP_ID = "default-app";

// ─── Types ────────────────────────────────────────────────────

export interface QuickPrompt {
  title: string;
  prompt: string;
}

export interface ExpertTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  welcomeMessage: string;
  quickPrompts: QuickPrompt[];
  /** lucide-react icon name (client maps it; never executed server-side). */
  icon: string;
  /** Tailwind token hint (client maps to classes; never a raw class string). */
  color: string;
}

export interface BuilderCapabilityOption {
  resourceId: string;
  type: string;
  name: string;
  version?: string;
  description?: string;
}

export interface AgentBuilderOptions {
  templates: ExpertTemplate[];
  capabilities: BuilderCapabilityOption[];
}

export interface CreateExpertAgentInput {
  templateId: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  welcomeMessage?: string;
  quickPrompts?: QuickPrompt[];
  capabilityIds?: string[];
  /**
   * Fix-round idempotency: a client-generated id (8–128 chars, e.g. UUID).
   * Retries and concurrent duplicate POSTs carrying the SAME id replay the
   * ONE agent that id created instead of minting duplicates. An id that
   * already belongs to a DIFFERENT owner is rejected (no cross-owner replay).
   */
  clientRequestId?: string;
}

export class AgentBuilderError extends Error {
  /** Categorical code — safe for audit reasonSummary (no prompt text). */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentBuilderError";
    this.code = code;
  }
}

// ─── Built-in templates (creation presets, plain data) ────────

export const EXPERT_TEMPLATES: ExpertTemplate[] = [
  {
    id: "blank",
    name: "空白助手",
    description: "从零开始，自由定义你的 Agent",
    systemPrompt: "",
    welcomeMessage: "你好！我是你的新助手，告诉我你想做什么吧。",
    quickPrompts: [],
    icon: "Sparkles",
    color: "gray",
  },
  {
    id: "doc-analysis",
    name: "文档分析",
    description: "阅读、总结、提炼文档要点与数据",
    systemPrompt:
      "你是一名文档分析专家。用户会上传或粘贴文档，请优先阅读完整内容后输出结构化摘要：核心论点、关键数据、风险与待确认项。回答要基于文档内容，不要编造。",
    welcomeMessage: "你好！把文档发给我，我来帮你总结要点、提取数据或回答文档相关问题。",
    quickPrompts: [
      { title: "总结文档要点", prompt: "请阅读文档并总结核心要点" },
      { title: "提取关键数据", prompt: "请提取文档中的关键数据并整理成表格" },
      { title: "找出风险项", prompt: "请找出文档中存在的风险和需要确认的事项" },
    ],
    icon: "FileText",
    color: "blue",
  },
  {
    id: "plan-writing",
    name: "方案撰写",
    description: "结构化撰写方案、计划与报告",
    systemPrompt:
      "你是一名方案撰写专家。输出前先明确目标、约束与受众，然后按「背景 → 目标 → 方案 → 里程碑 → 风险」的结构撰写。语言精炼，可执行项给出负责人与时间建议。",
    welcomeMessage: "你好！告诉我方案的主题和目标，我来帮你搭结构和写初稿。",
    quickPrompts: [
      { title: "写方案框架", prompt: "请为以下主题写一份方案框架：" },
      { title: "完善执行计划", prompt: "请把下面的方案细化为可执行的分阶段计划：" },
      { title: "做风险分析", prompt: "请针对以下方案做风险分析并给出应对措施：" },
    ],
    icon: "PenLine",
    color: "green",
  },
  {
    id: "project-assistant",
    name: "项目助手",
    description: "项目日常跟进：任务拆解、进度与复盘",
    systemPrompt:
      "你是一名项目助手。帮助用户拆解任务、跟踪进度、准备周报与复盘。输出使用清单与表格，任务项始终带状态（未开始/进行中/阻塞/完成）。",
    welcomeMessage: "你好！把项目目标或当前进展告诉我，我来帮你拆任务、排优先级。",
    quickPrompts: [
      { title: "拆解项目任务", prompt: "请把这个项目目标拆解为具体任务清单：" },
      { title: "生成周报", prompt: "请根据以下进展生成本周周报：" },
      { title: "项目复盘", prompt: "请对以下项目过程做一次复盘：" },
    ],
    icon: "ListTodo",
    color: "purple",
  },
];

// ─── Field bounds ─────────────────────────────────────────────

const LIMITS = {
  name: 64,
  description: 200,
  welcome: 500,
  quickPromptsMax: 6,
  quickTitle: 50,
  quickPrompt: 500,
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// M7a: exported so the edit path (agent-edit-routes.ts) reuses the EXACT
// create-path validation — one stored shape, one bound set, no drift.
export function normalizeQuickPrompts(raw: unknown): QuickPrompt[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AgentBuilderError("invalid_quick_prompts", "quickPrompts must be an array of { title, prompt }");
  }
  const out: QuickPrompt[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new AgentBuilderError("invalid_quick_prompts", "quickPrompts entries must be objects");
    }
    const title = cleanText((item as { title?: unknown }).title);
    const prompt = cleanText((item as { prompt?: unknown }).prompt);
    if (title === "" && prompt === "") continue; // empty entries are normalized away
    if (title === "" || prompt === "") {
      throw new AgentBuilderError("invalid_quick_prompts", "every quick prompt needs both a title and a prompt");
    }
    if (title.length > LIMITS.quickTitle || prompt.length > LIMITS.quickPrompt) {
      throw new AgentBuilderError("invalid_quick_prompts", `quick prompt too long (title ≤${LIMITS.quickTitle}, prompt ≤${LIMITS.quickPrompt})`);
    }
    out.push({ title, prompt });
    if (out.length > LIMITS.quickPromptsMax) {
      throw new AgentBuilderError("invalid_quick_prompts", `at most ${LIMITS.quickPromptsMax} quick prompts`);
    }
  }
  return out;
}

// ─── Capability upper bound ───────────────────────────────────

/**
 * The server-authoritative selectable set:
 *   user entitlement (canConfigure) ∩ default-app allowlist ∩ active+valid ∩
 *   registration-resolvable. The same set gates the options listing AND the
 * create re-validation — a client filter is never authority.
 */
function selectableCapabilities(ctx: RequestContext): BuilderCapabilityOption[] {
  const appAllowlist = applicationCapabilitiesService.resolveAppAllowlist(BUILDER_APP_ID);
  const allowSet = appAllowlist === null ? null : new Set(appAllowlist);
  // Fix-round (admin): listEntitledResources is empty for admin (entitlements
  // are a user/org concept), so admin starts from the FULL governed pool —
  // bypassing entitlement exactly like canConfigure's admin bypass, while the
  // app-allowlist / valid / active / registration legs still apply.
  const candidateIds =
    ctx.role === "admin"
      ? capabilityResourceService.listResources(ctx).map((r) => r.resourceId)
      : entitlementService.listEntitledResources(ctx);
  const out: BuilderCapabilityOption[] = [];
  for (const rid of candidateIds) {
    const res: CapabilityResourceView | undefined = capabilityResourceService.getResource(ctx, rid);
    if (!res || !res.valid || res.status !== "active") continue;
    if (!resourceRegistrationService.isResolvable(rid)) continue;
    if (allowSet !== null && !allowSet.has(rid)) continue;
    out.push({
      resourceId: res.resourceId,
      type: res.type,
      name: res.name,
      version: res.version,
      description: res.description,
    });
  }
  return out;
}

export function getBuilderOptions(ctx: RequestContext): AgentBuilderOptions {
  return {
    // Deep-clone so a caller mutating the response can never corrupt the
    // module-level presets.
    templates: EXPERT_TEMPLATES.map((t) => ({
      ...t,
      quickPrompts: t.quickPrompts.map((q) => ({ ...q })),
    })),
    capabilities: selectableCapabilities(ctx),
  };
}

// ─── Create orchestration ─────────────────────────────────────

/**
 * Create one expert Agent under default-app. Idempotency replay first (same
 * clientRequestId → same agent, owner-checked), then the M1/M5 governance
 * gates (org status + agents quota, admin exempt, zero residue on denial),
 * then validates EVERYTHING (template, text bounds, capability subset), then
 * persists agent + per-Agent prompt override + starter metadata in one SQLite
 * transaction, then writes the activation store; an activation failure
 * compensates by deleting the agent (no half state). Returns the hydrated
 * Agent read model.
 */
export function createExpertAgent(ctx: RequestContext, input: CreateExpertAgentInput): Agent {
  const templateId = cleanText(input.templateId);
  const template = EXPERT_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    throw new AgentBuilderError("unknown_template", `unknown template id: ${templateId || "(empty)"}`);
  }

  // Fix-round idempotency: replay FIRST (before any gate or write) so a retry
  // of an already-successful request returns the agent it created even if the
  // org has since been suspended or its quota filled up. Replaying requires
  // the HYDRATED agent to match the caller's user, org AND app scope: user
  // migration changes users.org_id without migrating agents, so the ledger
  // row alone must never satisfy the tenant boundary (fix round 2 — a
  // same-user cross-org replay would otherwise hand back an old-org Agent).
  const requestId = cleanText(input.clientRequestId);
  if (requestId !== "") {
    if (requestId.length < 8 || requestId.length > 128) {
      throw new AgentBuilderError("invalid_client_request_id", "clientRequestId must be 8–128 chars");
    }
    const existing = db
      .prepare(`SELECT agent_id, owner_user_id FROM agent_builder_requests WHERE request_id = ?`)
      .get(requestId) as { agent_id: string; owner_user_id: string } | undefined;
    if (existing) {
      if (existing.owner_user_id !== ctx.userId) {
        throw new AgentBuilderError("invalid_client_request_id", "clientRequestId already used by another user");
      }
      const agent = agentService.getChat(existing.agent_id);
      if (!agent) {
        throw new AgentBuilderError("create_failed", `idempotent replay: agent ${existing.agent_id} missing`);
      }
      if (agent.userId !== ctx.userId || agent.orgId !== ctx.orgId || agent.appId !== BUILDER_APP_ID) {
        throw new AgentBuilderError(
          "invalid_client_request_id",
          "clientRequestId belongs to an agent outside this caller's org/app scope"
        );
      }
      return agent;
    }
  }

  // Fix-round governance gates (parity with the legacy create routes — M1
  // org-status + M5 agents quota; admin exempt from both). Fail-closed BEFORE
  // any write, so denials leave zero residue.
  if (ctx.role !== "admin") {
    try {
      assertOrgActive(ctx.orgId);
    } catch (err) {
      if (err instanceof OrgNotActiveError) {
        throw new AgentBuilderError("org_not_active", err.message);
      }
      throw err;
    }
    try {
      assertQuota(ctx.orgId, "agents", {
        audit: { actorUserId: ctx.userId, actorRole: ctx.role },
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        throw new AgentBuilderError("quota_exceeded", err.message);
      }
      throw err;
    }
  }

  // Text fields: absent/empty falls back to the template preset (the drawer
  // normally merges these client-side; the server default is a convenience,
  // never a trust decision). NAME is the exception — it is the Agent's identity,
  // always user-typed in step 2, so empty is rejected rather than defaulted.
  const name = cleanText(input.name);
  const description = cleanText(input.description);
  const systemPrompt = sanitizePromptText(cleanText(input.systemPrompt) || template.systemPrompt);
  const welcomeMessage = cleanText(input.welcomeMessage) || template.welcomeMessage;
  const quickPrompts = input.quickPrompts === undefined
    ? template.quickPrompts.map((q) => ({ ...q }))
    : normalizeQuickPrompts(input.quickPrompts);

  if (name.length === 0 || name.length > LIMITS.name) {
    throw new AgentBuilderError("invalid_name", `name must be 1–${LIMITS.name} chars`);
  }
  if (description.length > LIMITS.description) {
    throw new AgentBuilderError("invalid_description", `description must be ≤${LIMITS.description} chars`);
  }
  if (welcomeMessage.length > LIMITS.welcome) {
    throw new AgentBuilderError("invalid_welcome", `welcomeMessage must be ≤${LIMITS.welcome} chars`);
  }
  if (systemPrompt.length > getPromptSettings().maxSystemPromptChars) {
    throw new AgentBuilderError("invalid_system_prompt", `systemPrompt exceeds maxSystemPromptChars(${getPromptSettings().maxSystemPromptChars})`);
  }

  // Capability gate: every requested id must be in the server-authoritative
  // selectable set — entitlement, app allowlist AND resource governance are
  // re-verified here regardless of what the client showed.
  const requested = input.capabilityIds ?? [];
  if (!Array.isArray(requested) || requested.some((c) => typeof c !== "string")) {
    throw new AgentBuilderError("capability_not_allowed", "capabilityIds must be an array of resource ids");
  }
  const selectable = new Set(selectableCapabilities(ctx).map((c) => c.resourceId));
  for (const rid of requested) {
    if (!selectable.has(rid)) {
      throw new AgentBuilderError("capability_not_allowed", `capability "${rid}" is not selectable for this user/app`);
    }
  }

  // 1. Agent row + prompt override + starter metadata in ONE transaction.
  //    The idempotency ledger row rides the same transaction (PK conflict
  //    fail-closes the create — it can only fire on a raced duplicate).
  const tx = db.transaction(() => {
    const agent = agentService.createChat(ctx.userId, name, ctx.orgId);
    if (requestId !== "") {
      db.prepare(
        `INSERT INTO agent_builder_requests (request_id, agent_id, owner_user_id, created_at) VALUES (?, ?, ?, ?)`
      ).run(requestId, agent.id, ctx.userId, new Date().toISOString());
    }
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE agents SET description = ?, system_prompt = ?, template_id = ?, welcome_message = ?, quick_prompts = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        description === "" ? null : description,
        systemPrompt === "" ? null : systemPrompt,
        templateId,
        welcomeMessage === "" ? null : welcomeMessage,
        JSON.stringify(quickPrompts),
        now,
        agent.id
      );
    if (result.changes === 0) {
      throw new AgentBuilderError("create_failed", `starter write affected 0 rows for agent ${agent.id}`);
    }
    return agent.id;
  });
  let agentId: string;
  try {
    agentId = tx();
  } catch (err) {
    if (err instanceof AgentBuilderError) throw err;
    throw new AgentBuilderError("create_failed", `agent creation failed: ${(err as Error).message}`);
  }

  // 2. Activation store (JSON file — outside the SQLite transaction). Failure
  //    compensates: delete the agent (also removes any activation key AND the
  //    idempotency ledger row so a retry re-creates cleanly).
  if (requested.length > 0) {
    try {
      agentCapabilityService.updateAgentCapabilities(ctx, agentId, {
        resources: requested.map((rid) => ({ resourceId: rid, enabled: true })),
      });
    } catch (err) {
      try {
        agentService.deleteChat(agentId);
        if (requestId !== "") {
          db.prepare(`DELETE FROM agent_builder_requests WHERE agent_id = ?`).run(agentId);
        }
      } catch (cleanupErr) {
        // Cleanup itself failing is the one unrecoverable path — surface it.
        throw new AgentBuilderError(
          "create_failed",
          `activation failed (${(err as Error).message}) AND cleanup failed (${(cleanupErr as Error).message}) — agent ${agentId} may need manual removal`
        );
      }
      throw new AgentBuilderError("create_failed", `capability activation failed: ${(err as Error).message}`);
    }
  }

  const agent = agentService.getChat(agentId);
  if (!agent) {
    throw new AgentBuilderError("create_failed", `agent ${agentId} missing after create`);
  }
  return agent;
}
