/**
 * agent-edit-routes.ts — Octop absorption M7a: per-Agent edit route layer.
 *
 * PATCH /api/agents/:agentId, extracted from the inline server.ts handler
 * (MP5b) so it is route-testable with the x-test-actor harness. Behavior is
 * the moved MP5b logic PLUS the M7a field whitelist extension:
 *   name (≤64, trims, updates the live chats.title — the Agent view's title),
 *   welcomeMessage (≤1000, nullable clears),
 *   quickPrompts (the M6a stored shape {title, prompt}[] — the client starter
 *   read path renders that shape, so the edit path reuses the create-path
 *   normalizeQuickPrompts exactly; null/[] clears).
 *
 * Zero-partial-write invariant: every field is validated BEFORE any DB write;
 * name (chats row) and the agent fields (agents row) are written in ONE SQLite
 * transaction, so a mid-flight failure can never leave a renamed-but-unsaved
 * or half-updated Agent.
 *
 * Control-plane keys (ownerUserId/orgId/status/templateId/appId) are NOT in
 * the whitelist — unknown keys are ignored, never written.
 *
 * Audit (MP5c family): metadata-only — field names + length/count, no
 * plaintext — appended to the OWNER's timeline with configVersion before/after.
 */
import express from "express";
import type { Request, Response } from "express";
import db from "./database.js";
import { ctxFromReq } from "./request-context.js";
import { agentService } from "./agent-service.js";
import { agentProfileStore } from "./agent-profile-store.js";
import { computeConfigVersion } from "./capability-version.js";
import { eventStore } from "./event-store.js";
import { buildProfileUpdateAudit } from "./agent-profile-audit.js";
import { AgentBuilderError, normalizeQuickPrompts, type QuickPrompt } from "./agent-builder.js";

const NAME_MAX = 64;
const WELCOME_MAX = 1000;

export function createAgentEditRoutes(): express.Router {
  const router = express.Router();

  router.patch("/:agentId", express.json({ limit: "256kb" }), (req: Request, res: Response) => {
    const ctx = ctxFromReq(req);
    const agentId = req.params.agentId; // === chatId compatibility bridge
    const agent = agentService.getChat(agentId);
    // Inline access check (same rule as requireAgentAccess) — we also need the
    // owner below to scope the audit event to the OWNER's timeline. Phase 7.2:
    // org_admin may edit any agent in their own org; admin is cross-org.
    const canEdit =
      ctx.role === "admin" ||
      (ctx.role === "org_admin" && agent?.orgId === ctx.orgId) ||
      agent?.userId === ctx.userId;
    if (!agent || !canEdit) {
      return res.status(404).json({ error: "Agent not found" });
    }
    const ownerUserId = agent.userId;

    const body = req.body ?? {};
    const fields: {
      description?: string | null;
      systemPrompt?: string | null;
      appendSystemPrompt?: string | null;
      profileId?: string | null;
      welcomeMessage?: string | null;
      quickPrompts?: QuickPrompt[] | null;
    } = {};
    let name: string | undefined;
    if ("description" in body) fields.description = body.description == null ? null : String(body.description);
    if ("systemPrompt" in body) fields.systemPrompt = body.systemPrompt == null ? null : String(body.systemPrompt);
    if ("appendSystemPrompt" in body) fields.appendSystemPrompt = body.appendSystemPrompt == null ? null : String(body.appendSystemPrompt);
    if ("welcomeMessage" in body) {
      if (body.welcomeMessage == null) {
        fields.welcomeMessage = null;
      } else if (typeof body.welcomeMessage === "string") {
        const text = body.welcomeMessage.trim();
        if (text.length > WELCOME_MAX) {
          return res.status(400).json({ error: `welcomeMessage must be ≤${WELCOME_MAX} chars` });
        }
        fields.welcomeMessage = text === "" ? null : text;
      } else {
        return res.status(400).json({ error: "welcomeMessage must be a string or null" });
      }
    }
    if ("quickPrompts" in body) {
      if (body.quickPrompts == null) {
        fields.quickPrompts = null;
      } else if (Array.isArray(body.quickPrompts) && body.quickPrompts.length === 0) {
        fields.quickPrompts = null;
      } else {
        try {
          fields.quickPrompts = normalizeQuickPrompts(body.quickPrompts);
          if (fields.quickPrompts.length === 0) {
            return res.status(400).json({ error: "quickPrompts cannot be all-empty entries" });
          }
        } catch (err) {
          if (err instanceof AgentBuilderError) {
            return res.status(400).json({ error: err.message, code: err.code });
          }
          throw err;
        }
      }
    }
    if ("name" in body) {
      if (typeof body.name !== "string") {
        return res.status(400).json({ error: "name must be a string" });
      }
      const text = body.name.trim();
      if (text.length === 0 || text.length > NAME_MAX) {
        return res.status(400).json({ error: `name must be 1–${NAME_MAX} chars (after trim)` });
      }
      name = text;
    }
    if ("profileId" in body) {
      const pid = body.profileId == null ? null : String(body.profileId);
      if (pid !== null && !agentProfileStore.get(pid)) {
        return res.status(400).json({ error: `Profile not found: ${pid}` });
      }
      fields.profileId = pid;
    }
    if (name === undefined && Object.keys(fields).length === 0) {
      return res.status(400).json({
        error:
          "No updatable fields (name, description, systemPrompt, appendSystemPrompt, profileId, welcomeMessage, quickPrompts)",
      });
    }

    const cvBefore = computeConfigVersion(ctx, agentId);
    try {
      // ONE transaction: the chats.title rename and the agents-row field
      // update commit or roll back together (zero partial write).
      const tx = db.transaction(() => {
        if (name !== undefined) {
          const chat = agentService.updateChatTitle(agentId, name);
          if (!chat) throw new Error("Agent not found (title update)");
        }
        const updated = agentService.updateAgentProfile(agentId, {
          ...fields,
          quickPrompts:
            fields.quickPrompts === undefined
              ? undefined
              : fields.quickPrompts === null
                ? null
                : JSON.stringify(fields.quickPrompts),
        });
        if (!updated && name === undefined) {
          throw new Error("Agent not found");
        }
      });
      tx();
    } catch (err: any) {
      if (/too long/i.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      if (/Agent not found/i.test(err.message)) {
        return res.status(404).json({ error: "Agent not found" });
      }
      console.error("[agent-edit] update error:", err);
      return res.status(500).json({ error: "Failed to update agent profile" });
    }
    const cvAfter = computeConfigVersion(ctx, agentId);

    const afterAgent = agentService.getChat(agentId)!;
    const afterPrompt = agentService.getAgentPromptOverrides(agentId);

    // Audit (MP5c): REDACTED payload — no prompt/profile/name plaintext. Lands
    // on the OWNER's timeline (an admin may have acted on another user's
    // Agent); the actor is recorded separately. agent_events is audit/proof —
    // the `agents` row is the source of truth.
    const audit = buildProfileUpdateAudit({
      actor: ctx,
      ownerUserId,
      fields: { ...fields, name: name === undefined ? undefined : name },
      after: {
        description: afterAgent.description ?? null,
        systemPrompt: afterPrompt.systemPrompt,
        appendSystemPrompt: afterPrompt.appendSystemPrompt,
        profileId: afterAgent.profileId,
        name: afterAgent.title,
        welcomeMessage: afterAgent.welcomeMessage ?? null,
        quickPrompts: afterAgent.quickPrompts ?? null,
      },
      configVersion: { before: cvBefore, after: cvAfter },
    });
    const existingSession = eventStore.getSessionByChat(ownerUserId, agentId);
    const session = existingSession ?? eventStore.getOrCreateSession(ownerUserId, agentId, "local");
    if (!existingSession) {
      // Audit-only session: no live runtime. Mark stopped so it isn't mistaken
      // for a running container (local sessions aren't container-managed).
      eventStore.updateStatus(session.id, "stopped");
    }
    eventStore.appendEvent(ownerUserId, agentId, session.id, "agent_profile_updated", audit);

    res.json({ agent: afterAgent, prompt: afterPrompt });
  });

  return router;
}
