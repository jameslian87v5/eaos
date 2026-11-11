/**
 * security-center.ts — Octop absorption M6b: pure client logic for the
 * unified security center (六页签安全防护中心).
 *
 * The page is a governance ENTRY POINT over the server posture contract
 * (`GET/PATCH /api/admin/security-posture`); these pure functions own the
 * tool tri-state draft so the React layer stays dumb:
 *
 *   server profile ──deriveToolDraft──▶ draft (one state per tool;
 *        overlap-normalized: disallowed > allowed > approval, so the round
 *        trip can NEVER re-emit a mutually-exclusive-violating config)
 *   draft ──buildToolsConfigPayload──▶ { toolsConfig } (EXACTLY one key;
 *        unknown tools dropped; platform default → null, never writable)
 *
 * Bash tighten is a shortcut for ONE tri-state transition
 * (allowed → approval); it never disables and offers no bypass — the
 * server re-validates everything anyway.
 */

export const POSTURE_TABS = [
  "toolApproval",
  "fileAccess",
  "sensitiveInfo",
  "commandProtection",
  "skillScan",
  "audit",
] as const;

export type PostureTab = (typeof POSTURE_TABS)[number];

export const TAB_LABELS: Record<PostureTab, string> = {
  toolApproval: "工具审批",
  fileAccess: "文件访问",
  sensitiveInfo: "敏感信息",
  commandProtection: "命令防护",
  skillScan: "技能扫描",
  audit: "审计日志",
};

// ─── Posture read model (client mirror of the server contract) ──

export type PostureSectionStatus = "enforced" | "configurable" | "partial" | "not_implemented";

export interface ProfileToolView {
  profileId: string;
  name: string;
  orgId: string;
  editable: boolean;
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

export async function loadSecurityPosture(): Promise<SecurityPosture> {
  const res = await fetch("/api/admin/security-posture", { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function saveProfileTools(
  profileId: string,
  payload: { toolsConfig: { tools: string[]; allowedTools: string[]; disallowedTools: string[] } }
): Promise<ProfileToolView> {
  const res = await fetch(`/api/admin/security-posture/profiles/${encodeURIComponent(profileId)}/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// Local import to avoid a client→server path dependency; AdminPanel owns the
// token header helper.
import { authHeaders } from "../components/AdminPanel";
export { authHeaders };

// ─── Tool tri-state draft ────────────────────────────────────

export type ToolState = "allowed" | "approval" | "disallowed";

export interface ToolDraft {
  /** Display order = the profile's tool list. */
  order: string[];
  states: Record<string, ToolState>;
}

/**
 * Profile → draft. Overlap normalization: a (defensively malformed) profile
 * with a tool in BOTH allowed and disallowed maps to ONE state — disallowed
 * wins — so the inverse mapping can never re-emit an overlapping config.
 */
export function deriveToolDraft(profile: ProfileToolView): ToolDraft {
  const states: Record<string, ToolState> = {};
  for (const tool of profile.tools) {
    if (profile.disallowedTools.includes(tool)) states[tool] = "disallowed";
    else if (profile.allowedTools.includes(tool)) states[tool] = "allowed";
    else states[tool] = "approval";
  }
  return { order: [...profile.tools], states };
}

/** Immutable state change; unknown tools (not in the draft) are ignored. */
export function setToolState(draft: ToolDraft, tool: string, state: ToolState): ToolDraft {
  if (!(tool in draft.states)) return draft;
  return { order: draft.order, states: { ...draft.states, [tool]: state } };
}

/** One-click tighten: Bash allowed → approval. No-op otherwise. */
export function tightenBashToApproval(draft: ToolDraft): ToolDraft {
  if (draft.states["Bash"] === "allowed") {
    return setToolState(draft, "Bash", "approval");
  }
  return draft;
}

/**
 * Draft → server payload. Returns null when the profile is not editable
 * (platform default / hard guards are read-only). The payload has EXACTLY
 * one key: toolsConfig — the server rejects anything else. Tools absent from
 * the draft (unknown/forged entries) are dropped, never submitted.
 */
export function buildToolsConfigPayload(
  profile: ProfileToolView,
  draft: ToolDraft
): { toolsConfig: { tools: string[]; allowedTools: string[]; disallowedTools: string[] } } | null {
  if (!profile.editable) return null;
  const known = draft.order.filter((t) => t in draft.states);
  return {
    toolsConfig: {
      tools: known,
      allowedTools: known.filter((t) => draft.states[t] === "allowed"),
      disallowedTools: known.filter((t) => draft.states[t] === "disallowed"),
    },
  };
}

/** Dirty check: does the draft still round-trip to the profile's config? */
export function draftIsDirty(profile: ProfileToolView, draft: ToolDraft): boolean {
  const payload = buildToolsConfigPayload(profile, draft);
  if (!payload) return false;
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((t) => b.includes(t));
  return !(
    sameSet(payload.toolsConfig.tools, profile.tools) &&
    sameSet(payload.toolsConfig.allowedTools, profile.allowedTools) &&
    sameSet(payload.toolsConfig.disallowedTools, profile.disallowedTools)
  );
}
