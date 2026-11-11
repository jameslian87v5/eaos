/**
 * agent-builder.ts — Octop absorption M6a: pure helpers for the expert-creation
 * drawer. UX ONLY: the server contract (/api/agent-builder) is the authority —
 * these functions never widen what the server will re-validate.
 */

export interface QuickPrompt {
  title: string;
  prompt: string;
}

export interface BuilderTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  welcomeMessage: string;
  quickPrompts: QuickPrompt[];
  icon: string;
  color: string;
}

export interface BuilderCapabilityOption {
  resourceId: string;
  type: string;
  name: string;
  version?: string;
  description?: string;
}

export interface AgentDraft {
  templateId: string;
  name: string;
  description: string;
  systemPrompt: string;
  welcomeMessage: string;
  quickPrompts: QuickPrompt[];
}

/** Seed the drawer's editable draft from a template preset (step 1 → step 2). */
export function initDraftFromTemplate(template: BuilderTemplate): AgentDraft {
  return {
    templateId: template.id,
    name: "",
    description: template.description,
    systemPrompt: template.systemPrompt,
    welcomeMessage: template.welcomeMessage,
    quickPrompts: template.quickPrompts.map((q) => ({ ...q })),
  };
}

/** Trim each quick prompt; fully-empty rows are dropped (server normalizes too). */
export function normalizeQuickPrompts(raw: QuickPrompt[]): QuickPrompt[] {
  return raw
    .map((q) => ({ title: q.title.trim(), prompt: q.prompt.trim() }))
    .filter((q) => q.title !== "" || q.prompt !== "");
}

/**
 * Human-readable validation of the drawer draft. Returns null when the draft
 * is submittable. Mirrors the server bounds — the server rejects anything
 * these checks miss; these checks exist so the user sees errors inline.
 */
export function validateDraft(draft: AgentDraft): string | null {
  const name = draft.name.trim();
  if (name.length === 0) return "请为 Agent 命名";
  if (name.length > 64) return "名称最长 64 字";
  if (draft.description.trim().length > 200) return "描述最长 200 字";
  if (draft.welcomeMessage.trim().length > 500) return "欢迎语最长 500 字";
  if (draft.quickPrompts.length > 6) return "快捷任务最多 6 条";
  for (const q of draft.quickPrompts) {
    if (q.title.trim() === "" || q.prompt.trim() === "") return "快捷任务需要标题和内容";
    if (q.title.length > 50 || q.prompt.length > 500) return "快捷任务超长（标题 ≤50，内容 ≤500）";
  }
  return null;
}

/**
 * Build the POST body — a strict whitelist. Only known fields; capabilityIds
 * are filtered to the server-provided selectable set so a stale/never-entitled
 * option can never ride into the payload (the server re-validates regardless).
 * clientRequestId (fix-round): server-side idempotency — retries with the SAME
 * id replay the one agent it created instead of duplicating.
 */
export function buildCreatePayload(
  draft: AgentDraft,
  selectableCapabilityIds: string[],
  selectedCapabilityIds: string[],
  clientRequestId?: string
): {
  templateId: string;
  name: string;
  description: string;
  systemPrompt: string;
  welcomeMessage: string;
  quickPrompts: QuickPrompt[];
  capabilityIds: string[];
  clientRequestId?: string;
} {
  const selectable = new Set(selectableCapabilityIds);
  const payload = {
    templateId: draft.templateId,
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    welcomeMessage: draft.welcomeMessage.trim(),
    quickPrompts: normalizeQuickPrompts(draft.quickPrompts),
    capabilityIds: selectedCapabilityIds.filter((id) => selectable.has(id)),
  };
  if (clientRequestId) return { ...payload, clientRequestId };
  return payload;
}
