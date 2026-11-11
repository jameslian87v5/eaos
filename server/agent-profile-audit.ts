/**
 * agent-profile-audit.ts — redacted audit payload for per-Agent profile/prompt
 * edits (MP5c; extended in MP5d to cover profileId assignment).
 *
 * When an owner/admin PATCHes an Agent's description, L2 prompt, or assigned
 * profile, we append an `agent_profile_updated` event to `agent_events` under the
 * OWNER's timeline. `agent_events` is audit/proof — the `agents` row is the
 * source of truth — so the payload must NEVER carry the prompt/profile plaintext.
 * It records only:
 *   - actor  : who made the change (admin may act on another user's Agent)
 *   - ownerUserId : whose Agent it is (timeline key)
 *   - changedFields + per-field change:
 *       text fields  -> { action: set|cleared, length, sha256 }
 *       profileId    -> { action: set|cleared, profileId }   (a reference, not secret)
 *   - configVersion { before, after } : so the drift is visible
 *
 * Pure (no DB) → unit-testable. The server.ts PATCH handler calls this then
 * hands the payload to `eventStore.appendEvent`.
 */
import { createHash } from "node:crypto";
import type { RequestContext } from "./request-context.js";

export interface ProfileUpdateFields {
  description?: string | null;
  systemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  profileId?: string | null;
  /** M7a edits — name is the live chat title text. */
  name?: string | null;
  welcomeMessage?: string | null;
  /** M7a edit — the normalized {title, prompt}[] starter (or null to clear). */
  quickPrompts?: unknown;
}

export interface ProfileAuditChange {
  action: "set" | "cleared";
  length?: number; // present for text fields
  sha256?: string; // present for text fields (identity, no plaintext)
  profileId?: string | null; // present for the profileId field (reference, not secret)
  count?: number; // present for the quickPrompts field (list cardinality)
}

export interface ProfileUpdateAuditPayload {
  actor: { userId: string; role: string };
  ownerUserId: string;
  changedFields: string[];
  changes: Record<string, ProfileAuditChange>;
  configVersion: { before: string; after: string };
}

/** Redact a text field: action + length + short sha256 identity, no plaintext. */
function redactText(requested: string | null | undefined, stored: string | null): ProfileAuditChange {
  const action: "set" | "cleared" =
    requested === null || requested === undefined ? "cleared" : "set";
  const text = stored ?? "";
  return {
    action,
    length: text.length,
    sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}

/**
 * Build the REDACTED audit payload for a per-Agent profile/prompt edit. Only the
 * fields present in `fields` appear in `changes` / `changedFields`; `after`
 * supplies the stored values used for length/sha256 (text) or the assigned id
 * (profileId).
 */
export function buildProfileUpdateAudit(args: {
  actor: RequestContext;
  ownerUserId: string;
  fields: ProfileUpdateFields;
  after: {
    description?: string | null;
    systemPrompt: string | null;
    appendSystemPrompt: string | null;
    profileId?: string | null;
    name?: string | null;
    welcomeMessage?: string | null;
    quickPrompts?: unknown;
  };
  configVersion: { before: string; after: string };
}): ProfileUpdateAuditPayload {
  const { actor, ownerUserId, fields, after, configVersion } = args;
  const changes: Record<string, ProfileAuditChange> = {};
  if (fields.description !== undefined) {
    changes.description = redactText(fields.description, after.description ?? null);
  }
  if (fields.systemPrompt !== undefined) {
    changes.systemPrompt = redactText(fields.systemPrompt, after.systemPrompt);
  }
  if (fields.appendSystemPrompt !== undefined) {
    changes.appendSystemPrompt = redactText(fields.appendSystemPrompt, after.appendSystemPrompt);
  }
  if (fields.profileId !== undefined) {
    // profileId references an agent_profile — not secret content — so record it
    // plainly (action + the assigned id, or null on clear).
    changes.profileId = {
      action: fields.profileId === null || fields.profileId === undefined ? "cleared" : "set",
      profileId: after.profileId ?? null,
    };
  }
  // M7a fields — same redaction discipline: text → action+length+sha256,
  // quickPrompts → action+count only.
  if (fields.name !== undefined) {
    changes.name = redactText(fields.name, after.name ?? null);
  }
  if (fields.welcomeMessage !== undefined) {
    changes.welcomeMessage = redactText(fields.welcomeMessage, after.welcomeMessage ?? null);
  }
  if (fields.quickPrompts !== undefined) {
    const list = Array.isArray(after.quickPrompts) ? (after.quickPrompts as unknown[]) : null;
    changes.quickPrompts = {
      action: list === null ? "cleared" : "set",
      count: list === null ? 0 : list.length,
    };
  }
  return {
    actor: { userId: actor.userId, role: actor.role ?? "user" },
    ownerUserId,
    changedFields: Object.keys(changes),
    changes,
    configVersion,
  };
}
