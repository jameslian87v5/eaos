/**
 * expert-directory.ts — Octop absorption M7a: pure helpers for the My Experts
 * directory and edit drawer. UX ONLY: the server contract is the authority —
 * /api/agents lists own agents (owner-filtered server-side), PATCH
 * /api/agents/:id re-validates every edit, and the capability boundary is
 * recomputed server-side (entitlement ∩ app allowlist ∩ activation). These
 * helpers never widen what the server will accept.
 */

export interface QuickPrompt {
  title: string;
  prompt: string;
}

/** One own-agent row from GET /api/agents (the Agent projection). */
export interface ExpertRow {
  id: string;
  title: string;
  description?: string | null;
  templateId?: string | null;
  welcomeMessage?: string | null;
  quickPrompts?: QuickPrompt[] | null;
  updatedAt?: string;
}

/** Capability option from GET /api/agent-builder/options (server upper bound). */
export interface CapabilityOption {
  resourceId: string;
  type: string;
  name: string;
  version?: string;
  description?: string;
}

/** One row from GET /api/agents/:id/capabilities (effective activation view). */
export interface CapabilityState {
  resourceId: string;
  name: string;
  enabled: boolean;
}

/** Editable draft for the M7a edit drawer (the three user-editable fields). */
export interface ExpertDraft {
  name: string;
  welcomeMessage: string;
  quickPrompts: QuickPrompt[];
}

export const EXPERT_LIMITS = {
  name: 64,
  welcome: 1000,
  quickPromptsMax: 6,
  quickTitle: 50,
  quickPrompt: 500,
};

/** Seed the edit draft from the server row (null starter → empty draft state). */
export function deriveExpertDraft(agent: ExpertRow): ExpertDraft {
  return {
    name: agent.title ?? "",
    welcomeMessage: agent.welcomeMessage ?? "",
    quickPrompts: (agent.quickPrompts ?? []).map((q) => ({ title: q.title, prompt: q.prompt })),
  };
}

function normalizedDraft(draft: ExpertDraft): ExpertDraft {
  return {
    name: draft.name.trim(),
    welcomeMessage: draft.welcomeMessage.trim(),
    quickPrompts: draft.quickPrompts.map((q) => ({
      title: q.title.trim(),
      prompt: q.prompt.trim(),
    })),
  };
}

/** Dirty = any of the three fields differs from the server row (after trim). */
export function isDraftDirty(agent: ExpertRow, draft: ExpertDraft): boolean {
  const base = {
    name: agent.title ?? "",
    welcomeMessage: agent.welcomeMessage ?? "",
    quickPrompts: (agent.quickPrompts ?? []).map((q) => ({
      title: q.title,
      prompt: q.prompt,
    })),
  };
  const next = normalizedDraft(draft);
  return (
    base.name !== next.name ||
    base.welcomeMessage !== next.welcomeMessage ||
    base.quickPrompts.length !== next.quickPrompts.length ||
    base.quickPrompts.some((q, i) => q.title !== next.quickPrompts[i].title || q.prompt !== next.quickPrompts[i].prompt)
  );
}

/**
 * Inline validation mirroring the server bounds (name 1–64; welcome ≤1000;
 * quickPrompts ≤6, title ≤50, prompt ≤500, both parts non-empty). The server
 * rejects anything these checks miss — they exist for inline errors only.
 */
export function validateExpertDraft(draft: ExpertDraft): string | null {
  const name = draft.name.trim();
  if (name.length === 0) return "名称不能为空";
  if (name.length > EXPERT_LIMITS.name) return `名称最长 ${EXPERT_LIMITS.name} 字`;
  if (draft.welcomeMessage.trim().length > EXPERT_LIMITS.welcome) return `欢迎语最长 ${EXPERT_LIMITS.welcome} 字`;
  if (draft.quickPrompts.length > EXPERT_LIMITS.quickPromptsMax) return `快捷任务最多 ${EXPERT_LIMITS.quickPromptsMax} 条`;
  for (const q of draft.quickPrompts) {
    if (q.title.trim() === "" || q.prompt.trim() === "") return "快捷任务需要标题和内容";
    if (q.title.length > EXPERT_LIMITS.quickTitle || q.prompt.length > EXPERT_LIMITS.quickPrompt) {
      return `快捷任务超长（标题 ≤${EXPERT_LIMITS.quickTitle}，内容 ≤${EXPERT_LIMITS.quickPrompt}）`;
    }
  }
  return null;
}

/**
 * Build the PATCH body — a strict whitelist of the three editable fields.
 * Control-plane keys (ownerUserId/orgId/status/templateId/appId) can never
 * appear here by construction. Empty quickPrompts → [] (server clears);
 * empty welcomeMessage → "" (server trims → clears).
 */
export function buildEditPayload(draft: ExpertDraft): {
  name: string;
  welcomeMessage: string;
  quickPrompts: QuickPrompt[];
} {
  const next = normalizedDraft(draft);
  return {
    name: next.name,
    welcomeMessage: next.welcomeMessage,
    quickPrompts: next.quickPrompts,
  };
}

/** List editing for quick prompts. */
export function addQuickPrompt(list: QuickPrompt[]): QuickPrompt[] {
  return [...list, { title: "", prompt: "" }];
}

export function updateQuickPrompt(list: QuickPrompt[], i: number, patch: Partial<QuickPrompt>): QuickPrompt[] {
  return list.map((q, j) => (j === i ? { ...q, ...patch } : q));
}

export function removeQuickPrompt(list: QuickPrompt[], i: number): QuickPrompt[] {
  return list.filter((_, j) => j !== i);
}

/**
 * Capability save diff — the PUT body only carries CHANGED entries (so an
 * untouched activation key is never rewritten), and only ids that are in the
 * server-provided options upper bound (a stale/never-entitled id can never
 * ride into the payload; the server re-validates regardless).
 */
export function buildCapabilityDiff(
  current: CapabilityState[],
  nextChecked: string[],
  options: CapabilityOption[]
): { resources: Array<{ resourceId: string; enabled: boolean }> } {
  const selectable = new Set(options.map((o) => o.resourceId));
  const nextSet = new Set(nextChecked.filter((id) => selectable.has(id)));
  const out: Array<{ resourceId: string; enabled: boolean }> = [];
  // Known capabilities: emit flips.
  for (const c of current) {
    const target = nextSet.has(c.resourceId);
    if (c.enabled !== target) out.push({ resourceId: c.resourceId, enabled: target });
  }
  // Newly checked options not present in current (never configured): enable.
  const currentIds = new Set(current.map((c) => c.resourceId));
  for (const id of nextSet) {
    if (!currentIds.has(id)) out.push({ resourceId: id, enabled: true });
  }
  return { resources: out };
}

/** templateId → display name (read-only provenance on the card/drawer). */
export function templateDisplayName(
  templateId: string | null | undefined,
  templates: Array<{ id: string; name: string }>
): string {
  if (!templateId) return "自定义";
  return templates.find((t) => t.id === templateId)?.name ?? "自定义";
}
