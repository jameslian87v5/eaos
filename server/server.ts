import "./logger.js"; // tee stdout/stderr → logs/server-YYYY-MM-DD.log (must be first)
import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
// P0-2: fatal handlers (uncaughtException/unhandledRejection) are registered in
// logger.ts — the first import — so they also cover import/DB-open-stage failures.
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import type { WSClient, IncomingWSMessage } from "./types.js";
import { chatStore } from "./chat-store.js";
import { agentService } from "./agent-service.js";
import { getOrOpenCopilotAgent, resetCopilotAgent, setCopilotSessionCloser } from "./copilot-service.js";
import { applicationService } from "./application-service.js";
import { getOrCreateAppPrincipal } from "./app-principal.js";
import { createAppRoutes, verifyAppAgentAccess, setDeleteAgentCleanup } from "./app-routes.js";
import { createAdminAppRoutes } from "./admin-app-routes.js";
import { createSpaCatchAll } from "./spa-fallback.js";
import { verifyWSAppAuth, redactWsAuthQuery, appKeyOnlyAuthMiddleware } from "./app-auth.js";
import { Session, type ContainerLifecycleHooks } from "./session.js";
import {
  ensureAdminExists,
  assertJwtSecret,
  markLegacyDefaultAdminForChange,
  login,
  register,
  changePassword,
  getMustChangePassword,
  isMustChangeAllowed,
  verifyToken,
  verifyWidgetToken,
  getUserById,
  listAllUsers,
  listUsersInOrg,
  updateUserRole,
  deleteUser,
  countAdmins,
  verifyUserTokenCurrent,
  setUserStatus,
  resetPasswordByAdmin,
  bumpUserTokenVersion,
  migrateUserOrg,
  adminResetPassword,
  getUserAuthState,
  validatePasswordStrength,
  USER_STATUSES,
  updateUserRoleAndBumpTokenVersion,
  type TokenPayload,
  type UserStatus,
  signRuntimeToken,
  RUNTIME_TOKEN_TTL_SECONDS,
} from "./auth.js";
import db from "./database.js";
import { containerManager } from "./container-manager.js";
import { createLocalRuntime } from "./agent-runtime.js";
import { assertKnownRuntimeMode, applyAllowedToolsNarrowing, createLocalSandboxRuntimeFactory } from "./local-sandbox-runtime.js";
import { reapOrphanMicrovmSandboxes, sharedSandboxLimiter } from "./microsandbox-concurrency.js";
import { sharedMicrosandboxMetrics } from "./microsandbox-metrics.js";
import { createLocalSandboxLifecycleController, type LocalSandboxLifecycleController } from "./local-sandbox-lifecycle-controller.js";
import { withPlatformEventAdapter } from "./platform-event-adapter.js";
import { capabilityProvider, TOOL_CATALOG } from "./capability-provider.js";
import { fileWorkspaceService } from "./file-workspace-service.js";
import { boundPageContext, type TurnContext } from "./widget-context.js";
import { getAllSkills, setSkillEnabled } from "./skill-config.js";
import { createAdminSkillImportRoutes } from "./admin-skill-import-routes.js";
import { createAgentBuilderRoutes } from "./agent-builder-routes.js";
import { createAgentEditRoutes } from "./agent-edit-routes.js";
import { createSecurityPostureRoutes } from "./security-posture-routes.js";
import { getAllMcpServers, setMcpServerEnabled } from "./mcp-config.js";
import { capabilityResourceService } from "./capability-resource.js";
import { entitlementService, EntitlementScopeError } from "./entitlement.js";
import { agentCapabilityService, EntitlementError, ResourceNotFoundError } from "./agent-capabilities.js";
import {
  resourceRegistrationService,
  RegistrationNotFoundError,
  RegistrationConflictError,
  InvalidResourceError,
  RegistrationStateError,
  StoreCorruptedError,
} from "./resource-registration.js";
import { ctxFromReq, DEFAULT_ORG_ID, isPrivilegedReq, isAdminReq, checkUserMutation, type RequestContext, type Role } from "./request-context.js";
import { getRuntimeSettings, saveRuntimeSettings, type RuntimeSettings } from "./runtime-settings.js";
import { getPromptSettings, savePromptSettings, type PromptSettings } from "./prompt-settings.js";
import { computeConfigVersion } from "./capability-version.js";
import { getDiagnostics } from "./capability-diagnostics.js";
// S2 (resilience plan): server-owned governed runtime recovery injected into
// Session — re-runs the full governance chain on every rebuild.
import { createGovernedRecovery } from "./runtime-recovery.js";
import { rebuildRateLimiter } from "./rebuild-rate-limiter.js";
import { eventStore } from "./event-store.js";
// Agent OS M3 (plan §7): runId execution audit — admin-only run detail router.
import { createAdminRunRoutes } from "./admin-run-routes.js";
import { createAdminConnectorRoutes } from "./admin-connector-routes.js";
import { createInternalConnectorMcpRoutes } from "./connector-mcp.js";
import { handleOAuthCallback } from "./connector-feishu-oauth.js";
import { revokeConnectorTokensForRuntime } from "./connector-capability-token.js";
import { buildProfileUpdateAudit } from "./agent-profile-audit.js";
import * as userMemoryService from "./user-memory-service.js";
import { authorizeMemoryAccess } from "./user-memory-admin.js";
import { agentProfileStore } from "./agent-profile-store.js";
import { orgService } from "./org-service.js";
import {
  assertOrgActive,
  isOrgActive,
  assertNotLastOrgAdmin,
  provisionOrg,
  transitionOrgStatus,
  writeGovernanceAudit,
  OrgNotActiveError,
  LastOrgAdminError,
  type OrgAction,
} from "./org-governance.js";
// R5c: org→TEAM-namespace mapping + member-sync lifecycle hooks + controlled
// Hub navigation. Additive — wired AROUND the existing primitives, never
// modifying provisionOrg/transitionOrgStatus/register/migrate/setUserStatus.
import {
  onOrgCreated, onOrgFrozen, onOrgActivated, onUserOrgMove,
  dispatchUserHook, tryHook,
} from "./org-namespace-lifecycle.js";
import { buildHubLaunchResponse } from "./hub-navigation.js";
import { createSkillsHubCatalogRouter } from "./skills-hub-catalog.js";
import { createMySkillsRoutes } from "./user-skill-routes.js";
import { createAdminUserSkillRoutes } from "./admin-user-skill-routes.js";
import { memberSyncService } from "./skillhub-member-sync.js";
import {
  runMemberSyncPass, backfillOrgMappings, reconcileMemberSync, startMemberSyncWorker,
} from "./skillhub-member-runner.js";
// R5d-1: background Skill sync closure — periodic non-overlapping worker +
// admin immediate-sync route + namespace-level sync status. Mirrors the
// member-sync runner (shared lock lives in the worker module). Safety no-op
// when SKILLHUB_URL/TOKEN absent; never breaks chat or existing skills.
import {
  runSkillSyncCycle, startSkillSyncWorker,
} from "./skillhub-sync-worker.js";
import {
  listStatusForScope, getStatusForScope,
} from "./skillhub-sync-status.js";
// M5 (quota + audit closure): enforcement service + audit query/export/retention.
import {
  getQuota,
  setQuota,
  assertQuota,
  assertStorageQuota,
  releaseReservation,
  QuotaExceededError,
} from "./quota-service.js";
import {
  queryGovernanceAudit,
  exportGovernanceAudit,
  purgeOldAudit,
} from "./governance-audit-service.js";
// M1 (model management): platform Model Catalog + org model policy service.
// M2 adds the per-Chat/Agent override resolution (§3.2 precedence).
import {
  ensureModelCatalogSeeded,
  listModels,
  createModel,
  updateModel,
  deleteModel,
  getOrgModelPolicy,
  setOrgModelPolicy,
  orgsUsingModelAsDefault,
  auditModelChange,
  getChatModelSelection,
  setChatModelOverride,
  setAgentModelOverride,
  importModel,
  importModelDefinition,
  type ImportStatus,
  type ModelDefinitionInput,
} from "./model-catalog.js";
// M5 (provider import): server-side whitelist connectors. No arbitrary URL;
// credentials only from process.env; never persisted/returned/audited.
import { listProviders, getProvider, listProviderModels } from "./provider-connectors.js";
// M3 (token dashboard): read-only aggregation over the existing result-event
// stream. No price/billing fields (plan §8.2 "本阶段不记录价格").
import { queryTokenUsage, getOrgTokenBudget, getChatUsageStats, getChatLastCompact } from "./token-usage-service.js";
// M4 (Auto Compact): platform/org compaction policy + pure decision helpers.
import {
  getPlatformCompaction,
  getOrgCompactPolicy,
  setOrgCompactPolicy,
  getEffectiveCompaction,
  getCompactionCaps,
  PLATFORM_MAX_THRESHOLD_TOKENS,
  PLATFORM_MIN_THRESHOLD_TOKENS,
  PLATFORM_MAX_KEEP_RECENT_TURNS,
  PLATFORM_MIN_KEEP_RECENT_TURNS,
} from "./compact-policy.js";
import type { Request, Response, NextFunction } from "express";
// M6-fix: pre-start detection for the SDK native CLI (local runtime only).
import { checkSdkCli, sdkCliCheckApplies } from "./sdk-cli-check.js";

// Runtime mode: "local" (in-process), "docker" (container per chat), or
// "local-sandbox" (MicroVM per agent — M3-S2 wiring; availability-gated and
// fail-closed, see local-sandbox-runtime.ts).
const RUNTIME_MODE = process.env.RUNTIME_MODE || "local";
assertKnownRuntimeMode(RUNTIME_MODE); // unknown mode → refuse to boot (fail closed)
console.log(`[server] Runtime mode: ${RUNTIME_MODE}`);

// M3 closure — no-orphan backstop for the MicroVM runtime: sandboxes named
// eaos-microvm-* left by a previously killed/crashed host process are
// reaped at boot (the limiter holds nothing yet). Failures are logged, not
// fatal — the per-runtime availability gate remains the hard fail-closed path.
if (RUNTIME_MODE === "local-sandbox" && process.env.MSB_PATH) {
  const reap = reapOrphanMicrovmSandboxes(process.env.MSB_PATH, []);
  if (reap.ok) {
    if (reap.reaped.length > 0) console.log(`[server] local-sandbox: reaped ${reap.reaped.length} orphan sandbox(es): ${reap.reaped.join(", ")}`);
  } else {
    console.warn(`[server] local-sandbox: orphan sweep skipped — ${reap.reason}`);
  }
}

// M6-fix (evt_20260819125001): fail fast when the LOCAL runtime cannot spawn
// the SDK native CLI (optional platform package missing — e.g. an install ran
// with --omit=optional). Without this gate the server boots, login/WS work,
// and only the FIRST chat message dies with the cryptic SDK error. Applies
// ONLY to `local`: docker runs the CLI inside the image, and local-sandbox
// runs the engine in the Guest (M3-S2 R1 — its availability gate diagnoses
// Guest engine assets itself).
if (sdkCliCheckApplies(RUNTIME_MODE)) {
  const sdkCli = checkSdkCli();
  if (!sdkCli.ok) {
    console.error(`[server] FATAL — ${sdkCli.message}`);
    process.exit(1);
  }
  console.log(`[server] SDK CLI OK — ${sdkCli.path}`);
}

// P0-1: refuse to boot with the weak built-in JWT secret (throws → process exits)
assertJwtSecret();

// Ensure admin account exists on startup
ensureAdminExists();
// P0-1: flag a pre-existing default admin (legacy DB) that still uses the default password
markLegacyDefaultAdminForChange();
// M5: run the 180-day governance-audit retention sweep at boot (design §7).
// Best-effort; a failure here must not block server start.
try { purgeOldAudit(180); } catch (e) { console.warn("[server] audit purge at boot failed:", (e as Error).message); }
// M1: one-time Model Catalog seed from the global runtime-settings model list
// (compat read). Best-effort — a failure must not block server start.
try { ensureModelCatalogSeeded(); } catch (e) { console.warn("[server] model catalog seed at boot failed:", (e as Error).message); }

// Auth middleware - extracts userId from JWT
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const payload = verifyToken(authHeader.slice(7));
    (req as any).userId = payload.userId;
    (req as any).userRole = payload.role;
    (req as any).orgId = payload.orgId ?? DEFAULT_ORG_ID;
    // M2 (user lifecycle): re-validate the JWT against the CURRENT DB state
    // on every protected request. A disabled user, a rotated token_version
    // (after reset / migrate), or a stale org claim (after migrate) is
    // rejected here — not trusted for the rest of the request. This is the
    // "or equivalent minimal mechanism" the M2 design requires; it closes the
    // "old JWT keeps working after disable/reset/migrate" hole without active
    // session revocation. admin is NOT exempt (a disabled admin's JWT must
    // also fail). MUST_CHANGE_ALLOWED paths (me/change-password) still need
    // the gate below because an active but must-change user can rotate.
    const tokenCheck = verifyUserTokenCurrent(payload);
    if (!tokenCheck.ok) {
      return res.status(401).json({ error: tokenCheck.reason, code: tokenCheck.code });
    }
    // P0-1: a user who must change password may only hit the allowlisted
    // endpoints (me + change-password) until they rotate it.
    if (getMustChangePassword(payload.userId) && !isMustChangeAllowed(req.path)) {
      return res
        .status(403)
        .json({ error: "Password change required", code: "MUST_CHANGE_PASSWORD" });
    }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;

// Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve static files from client directory
app.use("/client", express.static(path.join(__dirname, "../client")));

// Task 1 (P0.1): production UI hosting. When `npm run build` has emitted
// dist/index.html, the SPA routes serve the BUILT bundle (Vite is dev-only);
// when it hasn't, they keep serving the dev source entry so `npm run dev`
// works without a build. /api, /ws, /embed and the Widget assets below are
// unaffected — the SPA only owns `/` plus the late catch-all near the end of
// the route table.
const DIST_DIR = path.join(__dirname, "../dist");
const DIST_INDEX_HTML = path.join(DIST_DIR, "index.html");
const HAS_BUILT_UI = existsSync(DIST_INDEX_HTML);
if (HAS_BUILT_UI) {
  // Whole dist/ (covers /assets + root files). Widget-only /assets mount is
  // kept below for the not-built case; static mounts don't conflict.
  app.use(express.static(DIST_DIR));
}
const serveSpaIndex = (_req: express.Request, res: express.Response) => {
  res.sendFile(HAS_BUILT_UI ? DIST_INDEX_HTML : path.join(__dirname, "../client/index.html"));
};

// Serve index.html at root
app.get("/", serveSpaIndex);

// Platform Widget SDK — embeddable iframe page + browser SDK.
// The iframe reads ?widgetToken=... from the URL and connects to
// /api/apps/:appId/ws with it (no AppKey ever reaches the browser). The
// agentId/pageSessionId are read from the token payload; the server
// re-verifies ownership on WS subscribe.
app.use(express.static(path.join(__dirname, "../public")));
// v0.1: serve the built React widget when present (`npm run build` emits
// dist/widget.html + dist/assets/*). Scoped to /assets so the main app's
// source-serving routes are untouched. When not built (dev without a build),
// the embed route falls back to the v0 vanilla iframe below.
// (DIST_DIR hoisted to the Task 1 hosting block above.)
const DIST_WIDGET_HTML = path.join(DIST_DIR, "widget.html");
app.use("/assets", express.static(path.join(DIST_DIR, "assets")));
app.get("/embed/apps/:appId/widget", (req, res) => {
  if (existsSync(DIST_WIDGET_HTML)) {
    res.sendFile(DIST_WIDGET_HTML);
  } else {
    res.sendFile(path.join(__dirname, "../public/embed/widget.html"));
  }
});

// Session management — keyed by "userId:chatId" for multi-tenancy safety
const sessions: Map<string, Session> = new Map();

function sessionKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

// Inject the in-memory Session closer into the copilot service (avoids a
// server↔copilot-service circular import). Copilot reset closes + drops the
// Session orchestrator for the agent (same agentId) without touching volumes.
setCopilotSessionCloser((userId, chatId) => {
  const key = sessionKey(userId, chatId);
  const session = sessions.get(key);
  if (session) {
    session.close();
    sessions.delete(key);
  }
});

// File-upload notices buffered before a Session exists (keyed by sessionKey).
// Drained into the Session when it is first created, so an upload never
// triggers an agent response on its own.
const pendingFileNotices: Map<string, string[]> = new Map();

// Lifecycle hooks bridging Session → ContainerManager (Docker mode only)
const dockerLifecycleHooks: ContainerLifecycleHooks = {
  onSubscriberCountChange: (userId, chatId, count) =>
    containerManager.updateSubscriberCount(userId, chatId, count),
  onAgentBusyChange: (userId, chatId, busy) =>
    containerManager.updateAgentBusy(userId, chatId, busy),
  onPendingApprovalChange: (userId, chatId, pending) =>
    containerManager.updatePendingApproval(userId, chatId, pending),
};

// M5-S4 A: local-sandbox lifecycle controller — Host-led idle reclaim.
// Only instantiated for local-sandbox mode (Docker uses ContainerManager).
// closeRuntime/deleteSession/markStopped callbacks wire to the sessions Map +
// agent_sessions table; the controller releases the limiter slot on reclaim.
let localSandboxLifecycle: LocalSandboxLifecycleController | null = null;
if (RUNTIME_MODE === "local-sandbox") {
  const idleStopMs = (() => {
    const raw = Number(process.env.LOCAL_SANDBOX_IDLE_STOP_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 300_000; // default 5 min
  })();
  localSandboxLifecycle = createLocalSandboxLifecycleController({
    idleStopMs,
    scanIntervalMs: 30_000,
    limiter: sharedSandboxLimiter(),
    // M5-S4 R2 fix: closeRuntime captures userId BEFORE deleting the sessions
    // Map entry, then does the FULL reclaim (close + delete + markStopped) in
    // the right order. The controller's separate deleteSession/markStopped
    // callbacks are no-ops (closeRuntime already did everything) — this
    // avoids the bug where markStopped scanned the sessions Map AFTER
    // closeRuntime had already deleted the entry, leaving agent_sessions
    // stuck at `running`.
    closeRuntime: async (chatId, cleanupReason) => {
      let resolvedUserId: string | null = null;
      for (const [key, session] of sessions) {
        if (key.endsWith(`:${chatId}`)) {
          resolvedUserId = key.slice(0, -(`:${chatId}`).length);
          try { await session.close(); } catch (e) {
            console.warn(`[lifecycle] session.close('${chatId}') failed: ${(e as Error).message}`);
          }
          sessions.delete(key);
          break;
        }
      }
      // Mark the agent_session row stopped (best-effort). Resolved from the
      // captured userId — NOT a second scan of the sessions Map (which is
      // already deleted). Falls back to a DB chatId scan if the userId was
      // not captured (e.g. session was already gone — still mark the row).
      try {
        if (resolvedUserId) {
          const rec = eventStore.getSessionByChat(resolvedUserId, chatId);
          if (rec) {
            eventStore.updateStatus(rec.id, "stopped");
            eventStore.updateCleanupReason(rec.id, cleanupReason ?? "idle_timeout");
          }
        }
      } catch (e) {
        console.warn(`[lifecycle] markStopped('${chatId}') failed: ${(e as Error).message}`);
      }
    },
    // No-op — closeRuntime already deleted the sessions Map entry + marked
    // the agent_session row. Kept as no-ops so the controller's scan() order
    // (closeRuntime → release → deleteSession → markStopped) doesn't double-
    // delete or double-scan.
    deleteSession: () => {},
    markStopped: () => {},
  });
}

const localSandboxLifecycleHooks: ContainerLifecycleHooks | undefined = localSandboxLifecycle
  ? {
      onSubscriberCountChange: (_userId, chatId, count) =>
        localSandboxLifecycle!.setSubscriberCount(chatId, count),
      onAgentBusyChange: (_userId, chatId, busy) => {
        localSandboxLifecycle!.setBusy(chatId, busy);
        if (busy) localSandboxLifecycle!.touch(chatId, "agent_busy");
      },
      onPendingApprovalChange: (_userId, chatId, pending) =>
        localSandboxLifecycle!.setPendingApproval(chatId, pending),
    }
  : undefined;

// Env override: ALLOWED_TOOLS overrides ONLY the auto-approve list (allowedTools)
// — never the exposure list (tools). Applying it to `tools` too would strip the
// "Skill" tool (exposed via bundle.sdkOptions.tools when skills are activated)
// and collapse the approval split (tools == allowedTools). Applies to new
// runtimes only (no hot reload).
const envAllowedToolsOverride = process.env.ALLOWED_TOOLS
  ? process.env.ALLOWED_TOOLS.split(",").map((t) => t.trim())
  : null;

// Resolve default bundle for startup logging
const defaultBundle = capabilityProvider.resolve({ runtimeType: RUNTIME_MODE as any });
const dockerToolConfig = {
  tools: defaultBundle.sdkOptions.tools,
  allowedTools: envAllowedToolsOverride ?? defaultBundle.sdkOptions.allowedTools,
};
console.log(`[server] Docker tool config: tools=${JSON.stringify(dockerToolConfig.tools)}, allowedTools=${JSON.stringify(dockerToolConfig.allowedTools)}`);

function getOrCreateSession(chatId: string, userId: string, userRole: "admin" | "user" = "user", appId?: string, orgId: string = DEFAULT_ORG_ID): Session {
  const key = sessionKey(userId, chatId);
  let session = sessions.get(key);
  if (!session) {
    // M1 status gate (touchpoint: runtime 新建 + cold resume). Enforced ONLY on
    // the new-session path: this is where a NEW runtime (local AgentSession or
    // Docker container via cold resume) is materialized. An already-live WS
    // session whose org is suspended mid-connection is the accepted M1 residual
    // (reconnect is rejected by the WS-connect guard); proactively tearing down
    // live sessions is M2 (token invalidation). admin is exempt (cross-org
    // super-user must be able to inspect/recover a suspended department).
    if (userRole !== "admin") {
      try {
        assertOrgActive(orgId);
      } catch (e) {
        if (e instanceof OrgNotActiveError) {
          throw e; // callers (WS message handler) catch and render ws error
        }
        throw e;
      }
      // M5 quota gate (touchpoint: start runtime). Runs AFTER the status gate.
      // Exclude THIS chat's own persisted session — a warm reconnect / cold
      // resume of an already-active runtime does NOT acquire a new slot, so it
      // must not be double-counted against maxConcurrentRuntimes (codex fix #2).
      // A fresh start (no existing row) has nothing to exclude. admin exempt.
      assertQuota(orgId, "concurrentRuntimes", {
        excludeChatId: chatId,
        audit: { actorUserId: userId, actorRole: userRole },
      });
    }
    // Plan Task 2: provision the user's MEMORY.md (host file = single source of
    // truth for local confinement + docker bind mount). Idempotent.
    try {
      userMemoryService.ensureMemory(userId);
    } catch (err) {
      console.warn(`[server] user memory provisioning failed for ${userId}:`, (err as Error).message);
    }
    if (RUNTIME_MODE === "docker") {
      const ctx: RequestContext = { userId, role: userRole, orgId };
      // Phase 6 (A1): appId is resolved internally by capabilityProvider.resolve()
      // and computeConfigVersion() from the DB (agents.app_id). No need to pass
      // it explicitly — the DB is the source of truth.
      // Resolve full CapabilityBundle per chat session (deny-default, MP3).
      const bundle = capabilityProvider.resolve({
        userId,
        chatId,
        role: userRole,
        runtimeType: "docker",
        orgId, // Phase 7.3: entitlement org-scope must resolve against the owner's real org
      });
      // configVersion (MP4c): snapshot the control-plane inputs so warmResume can
      // detect drift and resolved_snapshot records what this runtime was built from.
      const configVersion = computeConfigVersion(ctx, chatId);
      const runtimePromise = containerManager.ensureRuntime(userId, chatId, {
        tools: bundle.sdkOptions.tools,
        allowedTools: envAllowedToolsOverride ?? bundle.sdkOptions.allowedTools,
        capabilityBundle: bundle,
        configVersion,
      });
      // S2 (resilience plan): governed recovery — Session invokes this on the
      // next user message after a runtime death. Same governance semantics as
      // the creation above (org active, quota with excludeChatId, fresh
      // resolve + configVersion, ALLOWED_TOOLS override) + rebuild flood
      // control. Session never calls ensureRuntime directly.
      const recovery = createGovernedRecovery(
        { userId, chatId, role: userRole, orgId },
        {
          assertOrgActive,
          assertQuota,
          resolve: (resolveCtx) => capabilityProvider.resolve(resolveCtx),
          computeConfigVersion,
          ensureRuntime: (uid, cid, opts) => containerManager.ensureRuntime(uid, cid, opts),
          rateLimiter: rebuildRateLimiter,
          allowedToolsOverride: envAllowedToolsOverride,
        },
        "docker"
      );
      session = new Session(chatId, runtimePromise, dockerLifecycleHooks, userId, {
        // Agent OS M3 (plan §7): role + orgId flow into the Session so it can
        // mint runId + freeze the run-start identity snapshot at sendMessage.
        role: userRole,
        orgId,
        recovery,
        // M8g: control-plane drift probe for capability hot reload — the same
        // computeConfigVersion that built this runtime's baseline above.
        configVersionProbe: () => computeConfigVersion({ userId, role: userRole, orgId }, chatId),
      });
    } else if (RUNTIME_MODE === "local-sandbox") {
      // M3-S2: explicit local-sandbox (MicroVM per agent) branch. Consumes the
      // docker-shaped capability bundle (container-path mounts — skills ro,
      // user memory rw). Availability is gated EAGERLY here: msb config +
      // pinned-runtime probe + guest-engine assets + credential proxy; any
      // miss throws MicrosandboxUnavailableError with every reason (rendered
      // by the WS handler). There is NO fallback to the plain local runtime.
      // R1: (a) ALLOWED_TOOLS narrowing applied BEFORE policy compilation
      // (same semantics as local/docker — replaces allowedTools, never tools);
      // (b) the runtime is wrapped in the platform-event adapter so the
      // EXISTING Session (SDK-shape consumer) drives assistant text, tool
      // metadata, approvals, run finalization and busy release unchanged.
      const bundle = capabilityProvider.resolve({
        userId,
        chatId,
        role: userRole,
        runtimeType: "docker", // container-shaped mounts (local-sandbox is a container-class runtime)
        orgId,
      });
      const sandboxBundle = applyAllowedToolsNarrowing(bundle, envAllowedToolsOverride);
      const sandboxFactory = createLocalSandboxRuntimeFactory({
        chatId,
        bundle: sandboxBundle,
        workspaceHostDir: fileWorkspaceService.getHostDir(chatId),
      });
      session = new Session(chatId, (opts) =>
        withPlatformEventAdapter(sandboxFactory({ ...opts, capabilityBundle: sandboxBundle })),
        localSandboxLifecycleHooks,
        userId,
        { role: userRole, orgId },
      );
      // M5-S4 A: register the new session with the lifecycle controller
      // so it is tracked for idle reclaim. touch() seeds lastActivityAt.
      if (localSandboxLifecycle) {
        localSandboxLifecycle.touch(chatId, "session_created");
        localSandboxLifecycle.registerSlot(chatId, `chat:${chatId}`);
      }
    } else {
      // Phase B: local also resolves capabilities via the control plane (profile +
      // entitled skills), so workbench config takes effect in local mode too.
      // runtimeType:"local" makes resolve() emit HOST-path plugins, no mounts, no MCP.
      const bundle = capabilityProvider.resolve({
        userId,
        chatId,
        role: userRole,
        runtimeType: "local",
        orgId, // Phase 7.3: entitlement org-scope must resolve against the owner's real org
      });
      session = new Session(chatId, (opts) =>
        createLocalRuntime({
          ...opts,
          // ALLOWED_TOOLS overrides only allowedTools, NEVER tools (feat contract —
          // keeps Skill exposed). tools always comes from the resolved bundle. Matches docker.
          tools: bundle.sdkOptions.tools,
          allowedTools: envAllowedToolsOverride ?? bundle.sdkOptions.allowedTools,
          capabilityBundle: bundle,
        }),
        undefined,
        userId,
        // Agent OS M3 (plan §7): role + orgId for runId minting (local path).
        // S2: governed recovery parity for local mode — org status gate +
        // fresh resolve + rate limiter (a dead local SDK stream rebuilds the
        // same way a dead container does).
        {
          role: userRole,
          orgId,
          recovery: createGovernedRecovery(
            { userId, chatId, role: userRole, orgId },
            {
              assertOrgActive,
              assertQuota,
              resolve: (resolveCtx) => capabilityProvider.resolve(resolveCtx),
              computeConfigVersion,
              ensureRuntime: () => {
                throw new Error("local mode has no container to ensure");
              },
              rateLimiter: rebuildRateLimiter,
              allowedToolsOverride: envAllowedToolsOverride,
            },
            "local"
          ),
          // M8g: control-plane drift probe for capability hot reload (local
          // mode). Same inputs the recovery fn uses — identical semantics.
          configVersionProbe: () => computeConfigVersion({ userId, role: userRole, orgId }, chatId),
        }
      );
    }
    sessions.set(key, session);

    // Drain any file notices buffered before this session existed
    const buffered = pendingFileNotices.get(key);
    if (buffered && buffered.length > 0) {
      for (const notice of buffered) session.noteUploadedFile(notice);
      pendingFileNotices.delete(key);
    }
  }
  session.setUserId(userId);
  return session;
}

/**
 * Phase 6 (A1): Shared delete cleanup — close in-memory session, stop/remove
 * Docker runtime + volumes, then delete the chat/agent from DB.
 * Used by both legacy DELETE /api/chats/:id and app-scoped DELETE /api/apps/:appId/agents/:agentId.
 */
async function deleteAgentCleanup(userId: string, chatId: string): Promise<void> {
  const key = sessionKey(userId, chatId);
  const session = sessions.get(key);
  if (session) {
    session.close();
    sessions.delete(key);
  }
  // Docker mode: stop container + remove volume + clean DB records
  if (RUNTIME_MODE === "docker") {
    await containerManager.deleteChat(userId, chatId);
  }
  const deleted = chatStore.deleteChat(chatId);
  if (deleted) {
    // M6a fix: the production delete path (legacy /api/chats, /api/agents and
    // app-scoped deletes all funnel here) bypasses AgentService.deleteChat, so
    // activation keys + idempotency ledger rows must be cleaned HERE too —
    // otherwise agent-capabilities.json keeps orphan keys outliving agents.
    try {
      agentCapabilityService.deleteAgentActivation(chatId);
    } catch (err) {
      console.warn(`[deleteAgentCleanup] activation cleanup failed for ${chatId}:`, err);
    }
    try {
      db.prepare(`DELETE FROM agent_builder_requests WHERE agent_id = ?`).run(chatId);
    } catch (err) {
      console.warn(`[deleteAgentCleanup] idempotency ledger cleanup failed for ${chatId}:`, err);
    }
  }
}

// P0-3: liveness + DB reachability for deploy probes / orchestration. Public, no auth.
app.get("/health", (_req, res) => {
  let dbOk = false;
  try {
    db.prepare("SELECT 1").get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? "ok" : "degraded", db: dbOk ? "ok" : "fail" });
});

// Auth routes (no middleware)
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    const result = await login(username, password);
    // M1 status gate (touchpoint: 登录签发 JWT). A user whose org is not
    // `active` (provisioning / suspended / archived) may not sign in. Rendered
    // as 403 (distinct from the 401 invalid-credentials path) so the client can
    // surface "部门已停用" rather than a misleading bad-password message.
    try {
      assertOrgActive(result.user.orgId);
    } catch (e) {
      if (e instanceof OrgNotActiveError) {
        return res.status(403).json({ error: e.message, code: "org_not_active" });
      }
      throw e;
    }
    res.json(result);
  } catch (err: any) {
    // P0-2: only the known "Invalid credentials" message reaches the client;
    // unexpected errors are logged and returned as a generic 500 (no leak).
    if (err?.message === "Invalid credentials") {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    console.error("[AUTH] login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// M1 (org governance): public self-registration is CLOSED. Users must be
// created by an admin/org_admin via POST /api/admin/users (or the provision
// transaction's first org_admin). The public endpoint is retained ONLY as a
// controlled deployment-bootstrap escape hatch: it is gated behind
// ALLOW_PUBLIC_REGISTER=1 (off by default). Existing admin/org_admin user
// creation is unaffected. This closes the hole where anyone could mint a
// default-org user and bypass the "users must be created by an admin" rule.
const ALLOW_PUBLIC_REGISTER = process.env.ALLOW_PUBLIC_REGISTER === "1";

app.post("/api/auth/register", async (req, res) => {
  if (!ALLOW_PUBLIC_REGISTER) {
    return res.status(403).json({
      error: "Public registration is disabled. Ask an administrator to create your account.",
      code: "register_disabled",
    });
  }
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    const user = await register(username, password, displayName);
    res.status(201).json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ userId: (req as any).userId, role: (req as any).userRole });
});

// P0-1: change password. Behind authMiddleware; the must-change gate allows this
// path so a forced-first-change user can rotate and unlock. Verifies old password,
// enforces strength, clears must_change_password.
app.post("/api/auth/change-password", authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body ?? {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: "Old and new password required" });
    }
    await changePassword((req as any).userId, oldPassword, newPassword);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Resource routes (chatId === agentId compatibility bridge) ─────────────
// `/api/chats` and `/api/agents` are TRUE ALIASES: one handler factory mounted
// twice with a different store handle. `/api/chats` stays on the legacy
// `chatStore` (behavior byte-for-byte unchanged); `/api/agents` is the Phase 1
// Agent product surface backed by `agentService`. Storage, sessions, containers,
// volumes, and WS all still key off chatId internally — only the HTTP surface
// gains the Agent name. See docs/05-migration/current-chatapp-to-agent-platform-
// migration.md §Phase 1.

// Minimal store shape both ChatStore and AgentService satisfy (AgentService is
// a transparent wrapper, agentId === chatId), so the two are interchangeable
// for routing.
interface ResourceStore {
  getAllChats(userId: string): unknown[];
  createChat(userId: string, title?: string, orgId?: string): unknown;
  getChat(id: string): { userId?: string; orgId?: string } | undefined;
  verifyChatOwnership(id: string, userId: string, orgId?: string): boolean;
  deleteChat(id: string): boolean;
  getMessages(id: string): unknown[];
}

function createResourceRoutes(store: ResourceStore) {
  const router = express.Router();

  // REST API: Get all chats (filtered by user)
  router.get("/", (req, res) => {
    const userId = (req as any).userId;
    const chats = store.getAllChats(userId);
    res.json(chats);
  });

  // REST API: Create new chat
  router.post("/", (req, res) => {
    const userId = (req as any).userId;
    // M1 status gate (touchpoint: 资源创建 — legacy chat + agent). A non-admin
    // operator of a non-active org may not create new chats/agents. orgId is the
    // server-trusted JWT claim (authMiddleware), NEVER a client-sent value. The
    // allowed M1 residual is an already-open WS session only — new resources for
    // a suspended department are refused at the creation entry. admin exempt.
    if ((req as any).userRole !== "admin") {
      try {
        assertOrgActive((req as any).orgId);
      } catch (e) {
        if (e instanceof OrgNotActiveError) {
          return res.status(403).json({ error: e.message, code: "org_not_active" });
        }
        throw e;
      }
    }
    // M5 quota gate (touchpoint: create Agent). Runs AFTER the status gate.
    // admin is exempt from the org-quota ceiling (cross-org super-user) so an
    // enterprise admin can always create a recovery agent in a full department.
    // On denial: 429 + metadata-only quota.exceeded audit (written by assertQuota).
    if ((req as any).userRole !== "admin") {
      try {
        assertQuota((req as any).orgId, "agents", {
          audit: {
            actorUserId: userId,
            actorRole: (req as any).userRole,
          },
        });
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return res.status(429).json({ error: e.message, code: "quota_exceeded", dimension: e.dimension });
        }
        throw e;
      }
    }
    const chat = store.createChat(userId, req.body?.title, (req as any).orgId);
    res.status(201).json(chat);
  });

  // REST API: Get single chat
  router.get("/:id", (req, res) => {
    const userId = (req as any).userId;
    const chat = store.getChat(req.params.id);
    if (!chat || chat.userId !== userId || (chat as any).orgId !== (req as any).orgId) {
      return res.status(404).json({ error: "Chat not found" });
    }
    res.json(chat);
  });

  // REST API: Delete chat
  router.delete("/:id", async (req, res) => {
    const userId = (req as any).userId;
    const chatId = req.params.id;
    if (!store.verifyChatOwnership(chatId, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    await deleteAgentCleanup(userId, chatId);
    res.json({ success: true });
  });

  // REST API: Get chat messages
  router.get("/:id/messages", (req, res) => {
    const userId = (req as any).userId;
    if (!store.verifyChatOwnership(req.params.id, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    const messages = store.getMessages(req.params.id);
    res.json(messages);
  });

  // REST API: Get runtime status for a chat
  // Non-admin users get product-level fields only; admin gets full runtime detail.
  router.get("/:id/runtime", (req, res) => {
    const userId = (req as any).userId;
    const userRole = (req as any).userRole;
    const chatId = req.params.id;
    if (!store.verifyChatOwnership(chatId, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    const full = containerManager.getRuntimeStatus(userId, chatId);
    if (userRole === "admin") {
      return res.json(full);
    }
    // Strip internal fields for non-admin
    const { containerId, hostPort, claudeSessionId, workspaceVolume, claudeHomeVolume, workspaceBytes, claudeHomeBytes, subscriberCount, ...userVisible } = full as any;
    res.json(userVisible);
  });

  // REST API: Stop the agent runtime for a chat (does NOT delete the chat)
  router.post("/:id/runtime/stop", async (req, res) => {
    const userId = (req as any).userId;
    const chatId = req.params.id;
    if (!store.verifyChatOwnership(chatId, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    // Abort in-memory session (stops SDK processing)
    const key = sessionKey(userId, chatId);
    const session = sessions.get(key);
    if (session) session.stop();
    // Remove session so next message triggers fresh getOrCreateSession → cold resume
    sessions.delete(key);
    // Docker mode: stop container (preserves volumes for cold resume)
    if (RUNTIME_MODE === "docker") {
      await containerManager.stopRuntime(userId, chatId, "user_request");
    }
    // M5-S2: local-sandbox — release the sandbox + concurrency slot eagerly
    // on REST stop. Same rationale as the WS stop handler: Session.stop()
    // aborts in-flight work but does NOT call rt.close(); without this the
    // sandbox stays booted and the chat's limiter slot stays held, blocking
    // cold recovery (the next message would hit "already holds a slot").
    if (RUNTIME_MODE === "local-sandbox" && session) {
      try { session.close(); } catch (err) {
        console.error(`[server] REST stop: failed to close local-sandbox runtime for ${chatId}:`, err);
      }
    }
    res.json({ success: true });
  });

  // ─── File Workspace API ──────────────────────────────────────

  // Upload a file to /workspace/input
  router.post("/:id/files/input", async (req, res) => {
    const userId = (req as any).userId;
    const chatId = req.params.id;
    if (!store.verifyChatOwnership(chatId, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    // M1 status gate (touchpoint: 文件上传). A non-admin operator of a
    // non-active org may not upload files. Rendered as 403.
    if ((req as any).userRole !== "admin") {
      try {
        assertOrgActive((req as any).orgId);
      } catch (e) {
        if (e instanceof OrgNotActiveError) {
          return res.status(403).json({ error: e.message, code: "org_not_active" });
        }
        throw e;
      }
    }
    try {
      // Accept JSON body: { filename, content (base64), mimeType? }
      const { filename, content, mimeType } = req.body;
      if (!filename || !content) {
        return res.status(400).json({ error: "filename and content (base64) required" });
      }
      const buf = Buffer.from(content, "base64");
      // M5 storage quota — transactional + overwrite-aware + concurrent-safe.
      // assertStorageQuota runs the limit check + registry UPSERT in ONE
      // better-sqlite3 transaction (single writer → serialized), so two
      // concurrent uploads cannot both pass. Overwrite returns delta =
      // new - old (not a full add). Covers input + agent output (registerOutput
      // writes the same workspace_files table). admin path passes enforce=false
      // (still registers for accounting; cross-org super-user is exempt from the
      // ceiling). On denial (non-admin, over limit): 413 + metadata-only audit.
      const isAdmin = (req as any).userRole === "admin";
      let record;
      try {
        record = assertStorageQuota(
          (req as any).orgId,
          chatId,
          filename,
          buf.length,
          userId,
          mimeType ?? null,
          {
            enforce: !isAdmin,
            audit: { actorUserId: userId, actorRole: (req as any).userRole },
          }
        );
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return res.status(413).json({ error: e.message, code: "quota_exceeded", dimension: e.dimension });
        }
        throw e;
      }
      // Reservation committed — now the non-atomic fs/volume write. If it
      // fails, release the reservation so a phantom row doesn't permanently
      // consume quota. releaseReservation deletes by the exact reservation id
      // (record.id, a per-call random token). The UPSERT refreshes `id` on
      // conflict, so a concurrent overwrite between our reserve and this failed
      // write would have set a new id on the row — our stale id won't match and
      // the newer overwrite is preserved (including the same-byte-size case).
      try {
        await fileWorkspaceService.writeInputFile(chatId, filename, buf);
      } catch (writeErr) {
        releaseReservation(record.id);
        throw writeErr;
      }

      // Buffer a file notice WITHOUT triggering an agent response.
      // The notice is attached to the user's NEXT message so the agent only
      // responds when the user actually asks something.
      const sizeKB = (record.sizeBytes / 1024).toFixed(1);
      const notice =
        `[系统通知] 用户已上传文件: ${record.filename} (${sizeKB} KB, ${record.mimeType || "unknown"})\n` +
        `文件路径: ${record.path}\n` +
        `如果用户接下来的问题涉及该文件，请直接读取上述路径。`;
      const key = sessionKey(userId, chatId);
      const existingSession = sessions.get(key);
      if (existingSession) {
        existingSession.noteUploadedFile(notice);
      } else {
        // No session yet (e.g. upload before first message) — buffer at server level
        const list = pendingFileNotices.get(key) ?? [];
        list.push(notice);
        pendingFileNotices.set(key, list);
      }

      res.status(201).json(record);
    } catch (err) {
      console.error("[server] File upload error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // List files for a chat
  router.get("/:id/files", (req, res) => {
    const userId = (req as any).userId;
    const chatId = req.params.id;
    if (!store.verifyChatOwnership(chatId, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    const files = fileWorkspaceService.listFiles(userId, chatId);
    res.json(files);
  });

  // Download a specific file
  router.get("/:id/files/:fileId/download", async (req, res) => {
    const userId = (req as any).userId;
    const chatId = req.params.id;
    const fileId = req.params.fileId;
    if (!store.verifyChatOwnership(chatId, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    const handle = await fileWorkspaceService.getDownload(userId, chatId, fileId);
    if (!handle) {
      return res.status(404).json({ error: "File not found" });
    }
    res.download(handle.absolutePath, handle.filename);
  });

  // Scan /workspace/output for new agent-generated files and register them
  router.post("/:id/files/scan-output", async (req, res) => {
    const userId = (req as any).userId;
    const chatId = req.params.id;
    if (!store.verifyChatOwnership(chatId, userId, (req as any).orgId)) {
      return res.status(404).json({ error: "Chat not found" });
    }
    try {
      const newFiles = await fileWorkspaceService.scanOutputFiles(userId, chatId);
      res.json({ scanned: newFiles.length, files: newFiles });
    } catch (err) {
      res.status(500).json({ error: "Scan failed" });
    }
  });

  return router;
}

// Protected routes - all require auth. Mount the shared factory under the legacy
// path (chatStore, unchanged) and the Agent-first path (agentService, alias).
app.use("/api/skills", createSkillsHubCatalogRouter(authMiddleware));
// M7b: user-side skill submission (/api/my-skills — POST /submit is a raw
// application/zip upload; reads are submitter-scoped) + admin review queue
// (/api/admin/user-skills — approve/reject are admin-only, org_admin read-only).
app.use("/api/my-skills", authMiddleware, createMySkillsRoutes());
app.use("/api/admin/user-skills", authMiddleware, createAdminUserSkillRoutes());
app.use("/api/chats", authMiddleware, createResourceRoutes(chatStore));
// ─── Agent Capability Activation API (migration Phase 2c) ───
// Registered BEFORE the /api/agents resource mount so these specific paths are
// matched ahead of the factory's GET /:id (defensive ordering). Owner or admin:
// enable/disable entitled capability resources on an Agent.

// All callers must reference an EXISTING Agent; ownership required unless admin.
// (Existence check applies to everyone, closing the "admin writes activation for
// an arbitrary id" hole.)
function requireAgentAccess(ctx: RequestContext, agentId: string): boolean {
  const agent = agentService.getChat(agentId);
  if (!agent) return false;
  if (ctx.role === "admin") return true; // super-user, cross-org
  // Phase 7.2: org_admin manages every agent in their own org.
  if (ctx.role === "org_admin") return agent.orgId === ctx.orgId;
  // Regular user: must own the agent AND sit in its org.
  return agent.userId === ctx.userId && agent.orgId === ctx.orgId;
}

// List capability resources enabled/entitled on an Agent
app.get("/api/agents/:agentId/capabilities", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  const agentId = req.params.agentId; // === chatId compatibility bridge
  if (!requireAgentAccess(ctx, agentId)) {
    return res.status(404).json({ error: "Agent not found" });
  }
  res.json({ capabilities: agentCapabilityService.listAgentCapabilities(ctx, agentId) });
});

// Enable/disable resources on an Agent (enable gated by resource validity + entitlement)
app.put("/api/agents/:agentId/capabilities", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  const agentId = req.params.agentId;
  if (!requireAgentAccess(ctx, agentId)) {
    return res.status(404).json({ error: "Agent not found" });
  }
  const resources = req.body?.resources;
  if (!Array.isArray(resources)) {
    return res.status(400).json({ error: "resources must be an array" });
  }
  for (const op of resources) {
    if (typeof op?.resourceId !== "string" || !op.resourceId || typeof op.enabled !== "boolean") {
      return res.status(400).json({ error: "Invalid resource entry: { resourceId: string, enabled: boolean }" });
    }
  }
  try {
    const capabilities = agentCapabilityService.updateAgentCapabilities(ctx, agentId, { resources });
    // M2a: capability activation is a governance mutation (one leg of the
    // resolve intersection) — audit it metadata-only. Resource ids and enabled
    // flags only; never a capability token or credential.
    writeGovernanceAudit({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: ctx.orgId,
      action: "agent.capabilities.update",
      objectType: "agent",
      objectId: agentId,
      result: "success",
      reasonSummary: resources
        .map((op: { resourceId: string; enabled: boolean }) => `${op.resourceId}:${op.enabled}`)
        .join(",")
        .slice(0, 500),
    });
    res.json({ capabilities });
  } catch (err) {
    if (err instanceof EntitlementError) {
      writeGovernanceAudit({
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        orgId: ctx.orgId,
        action: "agent.capabilities.update",
        objectType: "agent",
        objectId: agentId,
        result: "denied",
        reasonSummary: "entitlement gate",
      });
      return res.status(403).json({ error: err.message, resourceId: err.resourceId });
    }
    if (err instanceof ResourceNotFoundError) {
      return res.status(400).json({ error: err.message, resourceId: err.resourceId });
    }
    console.error("[server] updateAgentCapabilities error:", err);
    return res.status(500).json({ error: "Failed to update capabilities" });
  }
});

// Phase 5 (MP5b) + M7a: per-Agent profile/starter edits — extracted into
// agent-edit-routes.ts (route-testable). Same inline ownership rule (owner /
// org_admin same org / admin), strict field allowlist (unknown keys ignored —
// the client can never set raw tools/plugins/mcpServers/host paths), and the
// MP5c redacted audit on the OWNER's timeline. M7a extends the whitelist with
// name (live chats.title rename), welcomeMessage and quickPrompts (M6a stored
// shape). Changes apply on the NEXT runtime (stop/rebuild) and are surfaced as
// drift by MP4c diagnostics.
app.use("/api/agents", authMiddleware, createAgentEditRoutes());

app.use("/api/agents", authMiddleware, createResourceRoutes(agentService));

// M6a: governed expert-creation journey (templates + capability-bound create).
app.use("/api/agent-builder", authMiddleware, createAgentBuilderRoutes());

// M6b: unified security posture center (read model + one narrow profile-tools write).
app.use("/api/admin/security-posture", authMiddleware, createSecurityPostureRoutes());

// Minimal copilot model: one FIXED agent per user (app_id='copilot'). GET returns
// the user's copilot agent (creates it on first use). Reset restarts the SAME
// agent's conversation while preserving its workspace + .claude volumes and
// returns the SAME agent.id. See agent-service.getOrCreateCopilotAgent +
// copilot-service.resetCopilotAgent.
app.get("/api/copilot/agent", authMiddleware, async (req, res) => {
  const userId = (req as any).userId as string;
  try {
    // Serialized per user against reset inside the service (round-3 finding 1):
    // concurrent opens must not create duplicate `app_id='copilot'` agents.
    const agent = await getOrOpenCopilotAgent(userId);
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/copilot/reset", authMiddleware, async (req, res) => {
  const userId = (req as any).userId as string;
  try {
    const agent = await resetCopilotAgent(userId);
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Admin: Agent Profiles (Phase 5 MP5d, Phase 7.2 org-scopable) ────────
// Reusable prompt templates; multiple Agents share one via agents.profile_id.
// admin (cross-org) OR org_admin (own-org only). resolve() precedence:
// per-Agent override > profile > platform.
function profileAccessible(req: Request, profile: { orgId?: string } | undefined | null): boolean {
  if (!profile) return false;
  return isAdminReq(req) || profile.orgId === (req as any).orgId;
}

app.get("/api/admin/agent-profiles", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const profiles = isAdminReq(req)
    ? agentProfileStore.list()
    : agentProfileStore.listByOrg((req as any).orgId);
  res.json({ profiles });
});

app.post("/api/admin/agent-profiles", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  // org_admin creates in their own org; admin may specify orgId (validated).
  const orgId = isAdminReq(req)
    ? (typeof req.body?.orgId === "string" ? req.body.orgId : "default-org")
    : (req as any).orgId;
  try {
    const profile = agentProfileStore.create({
      name: req.body?.name,
      description: req.body?.description ?? null,
      systemPrompt: req.body?.systemPrompt ?? null,
      appendSystemPrompt: req.body?.appendSystemPrompt ?? null,
      toolsConfig: req.body?.toolsConfig ?? null,
      orgId,
    });
    res.status(201).json({ profile });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/agent-profiles/:id", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const profile = agentProfileStore.get(req.params.id);
  if (!profileAccessible(req, profile)) return res.status(404).json({ error: "Profile not found" });
  res.json({ profile });
});

app.patch("/api/admin/agent-profiles/:id", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const existing = agentProfileStore.get(req.params.id);
  if (!profileAccessible(req, existing)) return res.status(404).json({ error: "Profile not found" });
  const body = req.body ?? {};
  const fields: { name?: string; description?: string | null; systemPrompt?: string | null; appendSystemPrompt?: string | null; toolsConfig?: any } = {};
  if ("name" in body) fields.name = String(body.name ?? "");
  if ("description" in body) fields.description = body.description == null ? null : String(body.description);
  if ("systemPrompt" in body) fields.systemPrompt = body.systemPrompt == null ? null : String(body.systemPrompt);
  if ("appendSystemPrompt" in body) fields.appendSystemPrompt = body.appendSystemPrompt == null ? null : String(body.appendSystemPrompt);
  if ("toolsConfig" in body) fields.toolsConfig = body.toolsConfig == null ? null : body.toolsConfig;
  try {
    const profile = agentProfileStore.update(req.params.id, fields);
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json({ profile });
  } catch (err: any) {
    if (/too long|Unsupported tool|allowedTools|disallowedTools|overlap/i.test(err.message)) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: "Failed to update profile" });
  }
});

app.delete("/api/admin/agent-profiles/:id", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const existing = agentProfileStore.get(req.params.id);
  if (!profileAccessible(req, existing)) return res.status(404).json({ error: "Profile not found" });
  const deleted = agentProfileStore.deleteProfile(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Profile not found" });
  res.json({ success: true });
});

// ─── Admin: all Agents (Phase 5 MP5f) ──────────────────────────────
// Lists every Agent (NOT owner-scoped) with the per-Agent prompt overrides folded
// in, for the admin profile-assignment / per-Agent prompt console. This is the
// control-plane surface for binding a reusable Profile to an Agent and setting a
// per-Agent prompt; edits go through PATCH /api/agents/:agentId (owner or admin,
// which re-validates + writes the agent_profile_updated audit). resolve()
// precedence remains: per-Agent override > profile > platform default.
app.get("/api/admin/agents", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const agents = agentService.listAllAgents();
  // Phase 7.2: org_admin sees own-org agents only; admin sees all (cross-org).
  const scoped = isAdminReq(req) ? agents : agents.filter((a) => a.orgId === (req as any).orgId);
  res.json({ agents: scoped });
});

// ─── Admin API ──────────────────────────────────────────────

// REST API: Admin — get current tool configuration (read-only)
app.get("/api/admin/tool-config", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  res.json({
    runtimeMode: RUNTIME_MODE,
    defaultProfile: capabilityProvider.getDefaultProfile(),
    profiles: capabilityProvider.listProfiles(),
    activeToolConfig: RUNTIME_MODE === "docker" ? dockerToolConfig : null,
  });
});

// REST API: Admin — built-in tool catalog (for frontend multi-select)
app.get("/api/admin/tool-catalog", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  res.json({ catalog: TOOL_CATALOG });
});

// Admin: list all active agent runtimes
app.get("/api/admin/containers", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  if (RUNTIME_MODE !== "docker") {
    return res.json({ runtimes: [], mode: RUNTIME_MODE });
  }
  const sdkInitByChatId = new Map<string, ReturnType<Session["getSDKInitSnapshot"]>>();
  for (const session of sessions.values()) {
    sdkInitByChatId.set(session.chatId, session.getSDKInitSnapshot());
  }
  res.json({ runtimes: containerManager.getAllRuntimes(sdkInitByChatId), mode: RUNTIME_MODE });
});

// Admin: capability diagnostics for an Agent (MP4c). configured / resolved /
// mounted / discovered + drift diffs + stale flag + audit timeline. (chatId === agentId.)
// Owner-scoped: agent_events are keyed by the runtime OWNER's userId+chatId, and
// entitlement/configVersion must reflect the owner's view — NOT the admin's (which
// would bypass entitlement). Resolve the owner from the chat and build ctx as them.
app.get("/api/admin/agents/:agentId/diagnostics", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  const agentId = req.params.agentId;
  const chat = chatStore.getChat(agentId);
  if (!chat) return res.status(404).json({ error: "Agent not found" });
  const owner = getUserById(chat.userId);
  const ctx: RequestContext = {
    userId: chat.userId,
    role: owner?.role ?? "user",
    orgId: owner?.orgId ?? DEFAULT_ORG_ID,
  };
  res.json(getDiagnostics(ctx, agentId));
});

// Admin: stop a specific agent runtime by chatId
app.post("/api/admin/containers/:chatId/stop", authMiddleware, async (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  const chatId = req.params.chatId;
  try {
    // S2 (resilience plan): invalidate every in-memory Session caching this
    // chat's runtime. stop() bumps the recovery epoch (an in-flight governed
    // recovery must not install a zombie after the admin stop) and aborts the
    // runtime so the cached reference is marked dead. The session STAYS in
    // the map — the next user message triggers governed recovery.
    for (const [key, session] of sessions) {
      if (key.endsWith(`:${chatId}`)) {
        try { session.stop(); } catch (err) {
          console.warn(`[server] admin stop: session.stop(${chatId}) failed:`, (err as Error).message);
        }
      }
    }
    const result = await containerManager.stopByChatId(chatId);
    if (result.status === "not_found") {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Admin: get current runtime policy
app.get("/api/admin/runtime/policy", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  res.json(RUNTIME_MODE === "docker" ? containerManager.getPolicy() : { mode: RUNTIME_MODE, message: "Policy only applies to docker mode" });
});

// M5-S3: local-sandbox lifecycle metrics snapshot (boot/recovery/stop timing,
// status, failure category + redacted message, resource policy envelope). Admin-only.
// Never carries prompt/subject/credential/tool payload — the collector never
// receives them.
app.get("/api/admin/runtime/metrics", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  if (RUNTIME_MODE !== "local-sandbox") {
    return res.json({ mode: RUNTIME_MODE, events: [], message: "Metrics apply to local-sandbox only" });
  }
  res.json({ mode: RUNTIME_MODE, events: sharedMicrosandboxMetrics().snapshot() });
});

// M5-S4 D: local-sandbox lifecycle status — redacted per-chat state for admin.
// Returns: starting | running | busy | stopped | crashed (inferred from
// lastActivityAt + isAgentBusy + heartbeat state). No host path, sandbox
// name, credentials, or raw errors are exposed (only redacted timestamps +
// cleanup reason + restore mode).
app.get("/api/admin/runtime/local-sandbox/status", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  if (RUNTIME_MODE !== "local-sandbox" || !localSandboxLifecycle) {
    return res.json({ mode: RUNTIME_MODE, chats: [], message: "Lifecycle status applies to local-sandbox only" });
  }
  const snap = localSandboxLifecycle.snapshot().map((s) => ({
    chatId: s.chatId,
    status: s.consecutiveHeartbeatFailures >= 3
      ? "crashed"
      : s.isAgentBusy
        ? "busy"
        : "running",
    lastActivityAt: new Date(s.lastActivityAt).toISOString(),
    lastHeartbeatAt: new Date(s.lastHeartbeatAt).toISOString(),
    consecutiveHeartbeatFailures: s.consecutiveHeartbeatFailures,
    subscriberCount: s.subscriberCount,
    hasPendingApproval: s.hasPendingApproval,
    hasPendingA2UI: s.hasPendingA2UI,
    restoreMode: "history_replay",
  }));
  res.json({ mode: RUNTIME_MODE, chats: snap });
});

// Admin: get current runtime settings (file-backed, editable)
app.get("/api/admin/runtime/settings", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  res.json({ settings: getRuntimeSettings(true), mode: RUNTIME_MODE });
});

// Admin: update runtime settings (partial allowed; validated + clamped server-side)
app.put("/api/admin/runtime/settings", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  const patch = (req.body ?? {}) as Partial<RuntimeSettings>;
  try {
    const settings = saveRuntimeSettings(patch);
    res.json({ settings });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Admin: get platform-default prompt settings (file-backed, editable) — Phase 2e.
// GET force-reloads so an admin always sees fresh disk state (even hand-edited).
app.get("/api/admin/prompt-settings", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  res.json({ settings: getPromptSettings(true) });
});

// Admin: update platform-default prompt settings (partial; sanitized + length-
// bounded server-side; oversized systemPrompt rejected → 400). New runtimes only.
app.put("/api/admin/prompt-settings", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  const patch = (req.body ?? {}) as Partial<PromptSettings>;
  try {
    const settings = savePromptSettings(patch);
    res.json({ settings });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Skill / MCP catalog (shared platform resource pool) ─────
// Phase 7.4 (multitenancy, fix evt_..._fix_org_scoped_resource_reads): the
// catalog (data/skills.json, data/mcp.json, data/hook-plugins.json) is a SHARED
// platform pool — no org_id lives on catalog records (constraint: no per-org
// registries). Org-scoping is an OVERLAY delivered by entitlement (P7-3).
// Management READ model MUST be org-scoped (NOT the raw global pool):
//   - READ (GET skills/mcp/capabilities): open to isPrivilegedReq, BUT org_admin
//     sees ONLY own-org authorized resources (entitlement canConfigure). admin
//     sees the full global pool. The raw catalog must NOT leak to org_admin —
//     "what skills exist platform-wide" is admin-only knowledge; an org_admin
//     sees only what their org is authorized to use.
//   - WRITE (global enable/disable + install/import): ADMIN-ONLY. These mutate
//     platform-wide state (shared `enabled` flag, skills//mcp/ dirs). An
//     org_admin "enables a skill for my org" via the entitlement route (P7-3,
//     own-org allow) — that is the org-scoped enable, NOT this global toggle.
//   - install/import (/apis, /plugins in admin-app-routes.ts): admin-only since
//     P7-2 (router.use isAdminReq) — unchanged.

// Privileged: list skills. admin = full shared catalog; org_admin = own-org
// authorized only (entitlement overlay). Raw global pool does NOT leak.
app.get("/api/admin/skills", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) {
    return res.status(403).json({ error: "Privileged only" });
  }
  const ctx = ctxFromReq(req);
  const skills =
    ctx.role === "admin"
      ? getAllSkills()
      : getAllSkills().filter((s) => entitlementService.canConfigure(ctx, s.name));
  res.json({ skills });
});

// Admin-only: enable a skill GLOBALLY (writes data/skills.json; new runtimes).
// org-scoped enable is via entitlement (P7-3), NOT this platform-wide toggle.
app.post("/api/admin/skills/:name/enable", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "skill.enable", objectType: "skill", objectId: req.params.name, result: "denied", reasonSummary: "admin only (global toggle)" });
    return res.status(403).json({ error: "Admin only (global platform toggle)" });
  }
  const skill = setSkillEnabled(req.params.name, true);
  if (!skill) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "skill.enable", objectType: "skill", objectId: req.params.name, result: "failure", reasonSummary: "skill not found" });
    return res.status(404).json({ error: "Skill not found" });
  }
  writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "skill.enable", objectType: "skill", objectId: req.params.name, result: "success", reasonSummary: "global enable" });
  res.json({ skill });
});

// Admin-only: disable a skill GLOBALLY (writes data/skills.json; new runtimes).
app.post("/api/admin/skills/:name/disable", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "skill.disable", objectType: "skill", objectId: req.params.name, result: "denied", reasonSummary: "admin only (global toggle)" });
    return res.status(403).json({ error: "Admin only (global platform toggle)" });
  }
  const skill = setSkillEnabled(req.params.name, false);
  if (!skill) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "skill.disable", objectType: "skill", objectId: req.params.name, result: "failure", reasonSummary: "skill not found" });
    return res.status(404).json({ error: "Skill not found" });
  }
  writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "skill.disable", objectType: "skill", objectId: req.params.name, result: "success", reasonSummary: "global disable" });
  res.json({ skill });
});

// Admin-only (M3a): local skill ZIP import into quarantine (registered
// enabled:false — import success ≠ usable; enable still flows through the
// guards above). Mounted as POST /api/admin/skills/import-zip.
app.use("/api/admin/skills", authMiddleware, createAdminSkillImportRoutes());

// Privileged: list MCP servers. admin = full shared catalog; org_admin =
// own-org authorized only (entitlement overlay). Raw global pool does NOT leak.
app.get("/api/admin/mcp", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) {
    return res.status(403).json({ error: "Privileged only" });
  }
  const ctx = ctxFromReq(req);
  const mcpServers =
    ctx.role === "admin"
      ? getAllMcpServers()
      : getAllMcpServers().filter((m) => entitlementService.canConfigure(ctx, m.name));
  res.json({ mcpServers });
});

// Admin-only: enable an MCP server GLOBALLY (writes data/mcp.json; new runtimes).
// org-scoped enable is via entitlement (P7-3), NOT this platform-wide toggle.
app.post("/api/admin/mcp/:name/enable", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "mcp.enable", objectType: "mcp", objectId: req.params.name, result: "denied", reasonSummary: "admin only (global toggle)" });
    return res.status(403).json({ error: "Admin only (global platform toggle)" });
  }
  const mcp = setMcpServerEnabled(req.params.name, true);
  if (!mcp) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "mcp.enable", objectType: "mcp", objectId: req.params.name, result: "failure", reasonSummary: "mcp not found" });
    return res.status(404).json({ error: "MCP server not found" });
  }
  writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "mcp.enable", objectType: "mcp", objectId: req.params.name, result: "success", reasonSummary: "global enable" });
  res.json({ mcp });
});

// Admin-only: disable an MCP server GLOBALLY (writes data/mcp.json; new runtimes).
app.post("/api/admin/mcp/:name/disable", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "mcp.disable", objectType: "mcp", objectId: req.params.name, result: "denied", reasonSummary: "admin only (global toggle)" });
    return res.status(403).json({ error: "Admin only (global platform toggle)" });
  }
  const mcp = setMcpServerEnabled(req.params.name, false);
  if (!mcp) {
    writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "mcp.disable", objectType: "mcp", objectId: req.params.name, result: "failure", reasonSummary: "mcp not found" });
    return res.status(404).json({ error: "MCP server not found" });
  }
  writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "mcp.disable", objectType: "mcp", objectId: req.params.name, result: "success", reasonSummary: "global disable" });
  res.json({ mcp });
});

// ─── Capability Resource & Entitlement Admin API ────────────
// Control-plane northbound surface (migration Phase 2a/2b). Privileged-only
// (admin or org_admin). These declare intent (resource pool + who may
// configure); runtime resolution is MP3. Phase 7.3: org_admin operates on
// own-org entries only — listEntriesForCtx filters the READ path and
// setEntitlements guards the WRITE path (EntitlementScopeError → 403).

// Privileged: list capability resources (unified resource-pool view).
// Phase 7.4 fix: org-scoped — admin sees the full shared pool, org_admin sees
// ONLY own-org authorized resources. listResourcesForCtx applies the entitlement
// overlay so the raw global pool (incl. other orgs' skills/mcp/hook-plugins)
// does NOT leak to org_admin.
app.get("/api/admin/capabilities", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) {
    return res.status(403).json({ error: "Privileged only" });
  }
  const ctx = ctxFromReq(req);
  res.json({ resources: capabilityResourceService.listResourcesForCtx(ctx) });
});

// Privileged: list entitlement entries for a resource (org_admin sees own-org only)
app.get("/api/admin/capabilities/:resourceId/entitlements", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) {
    return res.status(403).json({ error: "Privileged only" });
  }
  const ctx = ctxFromReq(req);
  res.json({ entries: entitlementService.listEntriesForCtx(ctx, req.params.resourceId) });
});

// Privileged: replace entitlement entries for a resource (PUT semantics)
app.put("/api/admin/capabilities/:resourceId/entitlements", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) {
    return res.status(403).json({ error: "Privileged only" });
  }
  const ctx = ctxFromReq(req);
  const incoming = req.body?.entries;
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "entries must be an array" });
  }
  for (const e of incoming) {
    if (
      (e.scopeType !== "org" && e.scopeType !== "user") ||
      (e.effect !== "allow" && e.effect !== "deny") ||
      typeof e.scopeId !== "string" ||
      !e.scopeId
    ) {
      return res.status(400).json({ error: "Invalid entitlement entry" });
    }
  }
  let entries;
  try {
    entries = entitlementService.setEntitlements(ctx, req.params.resourceId, incoming);
  } catch (err) {
    // Phase 7.3: non-admin tried to write outside their org → tenant-boundary guard.
    if (err instanceof EntitlementScopeError) {
      writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "entitlement.replace", objectType: "capability_resource", objectId: req.params.resourceId, result: "denied", reasonSummary: "entitlement scope violation" });
      return res.status(403).json({ error: err.message });
    }
    throw err;
  }
  // R2: governance_audit_log row (metadata-only: scopes/effects, no payload).
  // (Replaces the prior eventStore.appendEvent("system"/"admin") call, which
  //  500'd on the agent_events chat_id/agent_session_id FK — governance actions
  //  aren't tied to a chat session, so governance_audit_log is the correct sink.)
  writeGovernanceAudit({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "entitlement.replace", objectType: "capability_resource", objectId: req.params.resourceId, result: "success", reasonSummary: `${entries.length} entries` });
  res.json({ entries });
});

// Phase 7.5: org-aggregate entitlement read. admin = every entry across all
// resources; org_admin = own-org org-scope entries only (the org-authorized
// resource set). Backs the "my org's capabilities" view. Read-only.
app.get("/api/admin/entitlements", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) {
    return res.status(403).json({ error: "Privileged only" });
  }
  const ctx = ctxFromReq(req);
  res.json({ entries: entitlementService.listAllEntriesForCtx(ctx) });
});

// ─── M4: Resource Registration (department governance) Admin API ────────
// Control-plane northbound surface for department-origin resource governance.
// org_admin submits a DRAFT for its OWN org only (owner org forced from JWT,
// never from request body); admin reviews + publishes/rejects/disables, then
// distributes/revokes per org via the existing entitlement layer. Drafts are
// visible to admin + the submitting org only; never resolvable (the resolve
// gate is in agent-capabilities.resolveEnabledResourceIdsForApp). Every write
// goes to metadata-only governance_audit_log.

// Privileged: list registrations (admin = all; org_admin = own-org drafts only)
app.get("/api/admin/resource-registrations", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Privileged only" });
  const ctx = ctxFromReq(req);
  try {
    res.json({ registrations: resourceRegistrationService.listForCtx(ctx) });
  } catch (err: any) {
    if (err instanceof StoreCorruptedError) return res.status(503).json({ error: err.message, code: "store_corrupted" });
    throw err;
  }
});

// Privileged: submit a draft. owner org = JWT org (org_admin) or null/enterprise
// (admin). Body NEVER carries owner org — it is derived from the trusted ctx.
app.post("/api/admin/resource-registrations", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Privileged only" });
  const ctx = ctxFromReq(req);
  const { resourceType, resourceName, description } = req.body ?? {};
  try {
    const reg = resourceRegistrationService.submitDraft(ctx, { resourceType, resourceName, description });
    res.status(201).json({ registration: reg });
  } catch (err: any) {
    if (err instanceof RegistrationConflictError) return res.status(409).json({ error: err.message });
    if (err instanceof InvalidResourceError) return res.status(400).json({ error: err.message });
    if (err instanceof StoreCorruptedError) return res.status(503).json({ error: err.message, code: "store_corrupted" });
    res.status(400).json({ error: err.message });
  }
});

// Admin review actions: publish / reject / disable
app.post("/api/admin/resource-registrations/:id/publish", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const ctx = ctxFromReq(req);
  try {
    const reg = resourceRegistrationService.publish(ctx, req.params.id);
    res.json({ registration: reg });
  } catch (err: any) {
    if (err instanceof RegistrationNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof RegistrationStateError) return res.status(409).json({ error: err.message });
    if (err instanceof StoreCorruptedError) return res.status(503).json({ error: err.message, code: "store_corrupted" });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/resource-registrations/:id/reject", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const ctx = ctxFromReq(req);
  const { reason } = req.body ?? {};
  try {
    const reg = resourceRegistrationService.reject(ctx, req.params.id, reason);
    res.json({ registration: reg });
  } catch (err: any) {
    if (err instanceof RegistrationNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof RegistrationStateError) return res.status(409).json({ error: err.message });
    if (err instanceof StoreCorruptedError) return res.status(503).json({ error: err.message, code: "store_corrupted" });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/resource-registrations/:id/disable", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const ctx = ctxFromReq(req);
  try {
    const reg = resourceRegistrationService.disable(ctx, req.params.id);
    res.json({ registration: reg });
  } catch (err: any) {
    if (err instanceof RegistrationNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof RegistrationStateError) return res.status(409).json({ error: err.message });
    if (err instanceof StoreCorruptedError) return res.status(503).json({ error: err.message, code: "store_corrupted" });
    res.status(400).json({ error: err.message });
  }
});

// Admin: distribute / revoke per-org access (writes entitlement rows)
app.post("/api/admin/resource-registrations/:id/distribute", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const ctx = ctxFromReq(req);
  const { orgId } = req.body ?? {};
  try {
    const reg = resourceRegistrationService.distribute(ctx, req.params.id, orgId);
    res.json({ registration: reg });
  } catch (err: any) {
    if (err instanceof RegistrationNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof RegistrationStateError) return res.status(409).json({ error: err.message });
    if (err instanceof OrgNotActiveError) return res.status(403).json({ error: err.message, code: "org_not_active" });
    if (err instanceof StoreCorruptedError) return res.status(503).json({ error: err.message, code: "store_corrupted" });
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/admin/resource-registrations/:id/revoke", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const ctx = ctxFromReq(req);
  const { orgId } = req.body ?? {};
  try {
    const reg = resourceRegistrationService.revoke(ctx, req.params.id, orgId);
    res.json({ registration: reg });
  } catch (err: any) {
    if (err instanceof RegistrationNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof StoreCorruptedError) return res.status(503).json({ error: err.message, code: "store_corrupted" });
    res.status(400).json({ error: err.message });
  }
});

// ─── Phase 6 (A1): App-scoped routes + Admin application management ──────
// App-scoped REST routes (dual-identity auth: X-App-Key + JWT)
// NOTE: the runtime-tokens mint route below MUST be registered before this
// app.use, otherwise createAppRoutes()' `router.use("/apps/:appId",
// appAuthMiddleware)` would gate it on a platform user JWT — but the runtime
// token is minted by the app BFF with its AppKey + an opaque subject only.
app.post("/api/apps/:appId/runtime-tokens", appKeyOnlyAuthMiddleware, (req, res) => {
  const keyApp = (req as any).keyApp as { appId: string; orgId: string };
  const body = req.body || {};
  const subject = body.subject;
  if (typeof subject !== "string" || subject.length === 0) {
    res.status(400).json({ error: "subject is required", code: "subject_required" });
    return;
  }
  // org_id comes ONLY from the verified app key (applications.org_id via
  // verifyAppKeyWithOrg). getOrCreateAppPrincipal cross-checks this against
  // the authoritative app record and rejects a mismatch; the subject is never
  // trusted to carry org.
  let principal;
  try {
    principal = getOrCreateAppPrincipal(keyApp.appId, subject, keyApp.orgId);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  // A disabled principal cannot mint a fresh token (revocation).
  if (principal.status !== "active") {
    res.status(403).json({ error: "Principal is disabled", code: "principal_disabled" });
    return;
  }
  // Optional agent binding: if the caller passes an agentId it must already
  // belong to this app (agents.app_id). Owner_user_id === principalId is
  // enforced at WS subscribe (verifyAppAgentAccess); mint-time only checks app
  // membership. Agent CREATION for app principals is P0.3 — this route does
  // not auto-create one.
  let agentId: string | undefined;
  if (typeof body.agentId === "string" && body.agentId) {
    if (applicationService.getAppIdForAgent(body.agentId) !== keyApp.appId) {
      res.status(403).json({ error: "Agent not found or not in this application", code: "agent_not_in_app" });
      return;
    }
    agentId = body.agentId;
  }
  const pageSessionId =
    typeof body.pageSessionId === "string" && body.pageSessionId
      ? body.pageSessionId
      : `ps_${randomUUID()}`;
  const origin = typeof body.origin === "string" ? body.origin : undefined;
  // The token carries the OPAQUE principalId, never the raw subject. The
  // browser may hold this token; the AppKey never leaves the BFF. The minting
  // AppKey's prefix is bound into the token (gap 2): a later key rotation
  // invalidates runtime tokens minted under the rotated-away key.
  const mintingAppKey = req.headers["x-app-key"] as string;
  const token = signRuntimeToken({
    appId: keyApp.appId,
    principalId: principal.principalId,
    agentId,
    pageSessionId,
    origin,
    apiKeyPrefix: mintingAppKey.slice(0, 16),
  });
  res.status(201).json({
    token,
    expiresIn: RUNTIME_TOKEN_TTL_SECONDS,
    principalId: principal.principalId,
    pageSessionId,
    agentId,
  });
});

app.use("/api", createAppRoutes());

// ─── Admin: Usage aggregation (UI-2) ───────────────────────────
app.get("/api/admin/usage", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") return res.status(403).json({ error: "Admin only" });
  const groupBy = (req.query.groupBy as string) || "day";
  const items = groupBy === "agent" ? eventStore.getUsageByChat() : eventStore.getUsageByDay();
  const totalCost = items.reduce((s: number, i: any) => s + (i.cost ?? 0), 0);
  const totalDuration = items.reduce((s: number, i: any) => s + (i.duration ?? 0), 0);
  const totalTurns = items.reduce((s: number, i: any) => s + (i.turns ?? 0), 0);
  res.json({ totalCost, totalDuration, totalTurns, items });
});

// ─── Admin: User management (UI-3, Phase 7.2 org-scopable + promotion guard) ─
// admin (cross-org) OR org_admin (own-org only). Iron laws for org_admin:
//   - can only create/manage plain `user` accounts (NOT admin/org_admin);
//   - cannot touch (promote/demote/delete) admin or org_admin accounts;
//   - cannot operate across orgs (cross-org target hidden as 404).
const VALID_ROLES = new Set<string>(["admin", "org_admin", "user"]);

app.get("/api/admin/users", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const users = listAllUsers();
  // Phase 7.2: org_admin sees own-org users only; admin sees all.
  const scoped = isAdminReq(req) ? users : users.filter((u) => u.orgId === (req as any).orgId);
  res.json({ users: scoped });
});

app.post("/api/admin/users", authMiddleware, async (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const { username, password, displayName } = req.body ?? {};
  let { role } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  if (role && !VALID_ROLES.has(role)) return res.status(400).json({ error: "invalid role" });
  const effectiveRole: Role = (role || "user") as Role;
  const actorRole: Role = isAdminReq(req) ? "admin" : "org_admin";
  // org_admin creates in their own org; admin may specify orgId (else default-org).
  // orgId is NEVER taken from the body for org_admin (server-trusted JWT claim).
  const orgId = actorRole === "admin"
    ? (typeof req.body?.orgId === "string" && req.body.orgId ? req.body.orgId : "default-org")
    : (req as any).orgId;
  // M2: the target org must exist AND be active (design §2 "创建时必须绑定有效且
  // active 的 org"). No admin exemption — a suspended org can't accept new users
  // (they couldn't sign in anyway); admin reactivates the org first. Catches the
  // "create user in a suspended/nonexistent dept" hole.
  try {
    assertOrgActive(orgId);
  } catch (e) {
    if (e instanceof OrgNotActiveError) {
      return res.status(403).json({ error: e.message, code: "org_not_active" });
    }
    throw e;
  }
  // Promotion guard (pure policy). For a create the "current" role is user and
  // the target org is the org the account will live in.
  const denial = checkUserMutation({
    actorRole, actorOrg: (req as any).orgId, targetOrg: orgId,
    targetCurrentRole: "user", desiredRole: effectiveRole,
  });
  if (denial === "not found") return res.status(403).json({ error: "org_admin can only create plain users" });
  if (denial) return res.status(403).json({ error: denial });
  try {
    // M2: admin/org_admin-created users get a TEMP password → force first-login
    // change (design §2). The public bootstrap register path keeps 0.
    const user = await register(username, password, displayName, orgId, 1);
    if (effectiveRole !== "user") updateUserRole(user.id, effectiveRole);
    writeGovernanceAudit({
      actorUserId: (req as any).userId,
      actorRole,
      orgId,
      action: "user.create",
      objectType: "user",
      objectId: user.id,
      reasonSummary: `role=${effectiveRole}`,
    });
    // R5c: enqueue a Hub member-sync task for the new user (best-effort).
    tryHook(() => dispatchUserHook(user.id, "user_create"));
    res.json({ user: { ...user, role: effectiveRole } });
  } catch (e: any) {
    res.status(400).json({ error: e.message || "Registration failed" });
  }
});

app.patch("/api/admin/users/:id", authMiddleware, async (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const { role, password, status, orgId } = req.body ?? {};
  const existing = getUserById(req.params.id);
  if (!existing) return res.status(404).json({ error: "User not found" });
  const actorRole: Role = isAdminReq(req) ? "admin" : "org_admin";
  const actorOrg: string = (req as any).orgId;

  // M2: cross-department migration (orgId). Admin ONLY — org_admin cannot
  // migrate (even within own org; migration changes org, which only the
  // enterprise admin may do). Target org must exist + be active. If migrating
  // an org_admin OUT, the source org must retain ≥1 active org_admin.
  if (orgId !== undefined) {
    if (actorRole !== "admin") {
      return res.status(403).json({ error: "Only an enterprise admin may migrate users across departments" });
    }
    const newOrg = typeof orgId === "string" ? orgId.trim() : "";
    if (!newOrg) return res.status(400).json({ error: "Target orgId required" });
    if (newOrg === existing.orgId) return res.status(400).json({ error: "User already belongs to that org" });
    try {
      assertOrgActive(newOrg);
    } catch (e) {
      if (e instanceof OrgNotActiveError) {
        return res.status(403).json({ error: e.message, code: "org_not_active" });
      }
      throw e;
    }
    // Source-org last-org_admin guard (migrating an org_admin out = removing
    // an effective org_admin from the source dept).
    if (existing.role === "org_admin") {
      try {
        assertNotLastOrgAdmin(existing.orgId, existing.id, existing.role);
      } catch (e) {
        if (e instanceof LastOrgAdminError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    migrateUserOrg(existing.id, newOrg); // bumps token_version → old JWT dead
    writeGovernanceAudit({
      actorUserId: (req as any).userId,
      actorRole,
      orgId: newOrg,
      action: "user.migrate",
      objectType: "user",
      objectId: existing.id,
      fromOrgId: existing.orgId,
      toOrgId: newOrg,
      reasonSummary: `migrated ${existing.role}`,
    });
    // R5c: enqueue a member-sync task under the DESTINATION org's namespace,
    // carrying the SOURCE namespace (existing.orgId is the pre-migration org)
    // so the adapter can remove stale source membership. onUserOrgMove reads the
    // post-migration token_version + role internally.
    tryHook(() => onUserOrgMove({ fromOrgId: existing.orgId, toOrgId: newOrg, userId: existing.id }));
    return res.json({ user: { ...existing, orgId: newOrg } });
  }

  // M2: password reset. checkUserMutation enforces org_admin cannot reset a
  // privileged account; admin may reset anyone. The new password must still
  // pass strength policy. resetPasswordByAdmin sets must_change=1 + bumps
  // token_version (old JWTs die immediately; user logs in with the new temp
  // password and is forced to change it).
  if (password !== undefined) {
    const denial = checkUserMutation({
      actorRole, actorOrg, targetOrg: existing.orgId,
      targetCurrentRole: existing.role, desiredRole: existing.role,
    });
    if (denial === "not found") return res.status(404).json({ error: "User not found" });
    if (denial) return res.status(403).json({ error: denial });
    try {
      await adminResetPassword(existing.id, String(password));
    } catch (e: any) {
      return res.status(400).json({ error: e.message || "Password reset failed" });
    }
    writeGovernanceAudit({
      actorUserId: (req as any).userId,
      actorRole,
      orgId: existing.orgId,
      action: "user.password_reset",
      objectType: "user",
      objectId: existing.id,
    });
    return res.json({ ok: true });
  }

  // M2: status (disable / restore). checkUserMutation: org_admin cannot touch
  // a privileged account. Self-disable is refused. Disabling the last active
  // org_admin of a dept is refused. Disabling bumps token_version so the old
  // JWT dies at the version check too (not only the status check). Restore
  // needs no bump (the disabled user's tokens already failed; they re-login).
  if (status !== undefined) {
    if (!USER_STATUSES.has(status)) return res.status(400).json({ error: "invalid status" });
    const newStatus = status as UserStatus;
    if (existing.id === (req as any).userId) {
      return res.status(400).json({ error: "Cannot change your own status" });
    }
    const denial = checkUserMutation({
      actorRole, actorOrg, targetOrg: existing.orgId,
      targetCurrentRole: existing.role, desiredRole: existing.role,
    });
    if (denial === "not found") return res.status(404).json({ error: "User not found" });
    if (denial) return res.status(403).json({ error: denial });
    if (newStatus === existing.status) {
      return res.json({ user: existing });
    }
    if (newStatus === "disabled" && existing.role === "org_admin") {
      try {
        assertNotLastOrgAdmin(existing.orgId, existing.id, existing.role);
      } catch (e) {
        if (e instanceof LastOrgAdminError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    setUserStatus(existing.id, newStatus);
    if (newStatus === "disabled") {
      // Bump token_version so a disabled-then-restored user's OLD JWT stays
      // dead: after restore, status=active but tv=N+1, while the pre-disable
      // JWT carries vN → version mismatch → re-login required (M2 invariant:
      // "active 恢复后需重新登录"). The disabled user's tokens are already
      // blocked by the status check; this bump covers the post-restore window.
      bumpUserTokenVersion(existing.id);
    }
    writeGovernanceAudit({
      actorUserId: (req as any).userId,
      actorRole,
      orgId: existing.orgId,
      action: newStatus === "disabled" ? "user.disable" : "user.restore",
      objectType: "user",
      objectId: existing.id,
      reasonSummary: `${existing.status} → ${newStatus}`,
    });
    // R5c: enqueue a member-sync task for the suspend/restore (best-effort).
    tryHook(() => dispatchUserHook(existing.id, newStatus === "disabled" ? "user_suspend" : "user_restore"));
    return res.json({ user: { ...existing, status: newStatus } });
  }

  // Existing role-change path (unchanged semantics).
  if (role !== undefined) {
    if (!VALID_ROLES.has(role)) return res.status(400).json({ error: "invalid role" });
    const denial = checkUserMutation({
      actorRole, actorOrg, targetOrg: existing.orgId,
      targetCurrentRole: existing.role, desiredRole: role as Role,
    });
    if (denial === "not found") return res.status(404).json({ error: "User not found" });
    if (denial) return res.status(403).json({ error: denial });
    // Last-admin protection: cannot demote the last remaining admin.
    if (existing.role === "admin" && role !== "admin" && countAdmins() <= 1) {
      return res.status(400).json({ error: "Cannot demote the last admin" });
    }
    // M1 last-org_admin protection: cannot demote the last effective org_admin of
    // a department (would leave it unmanageable). Applies when demoting an
    // org_admin to a non-org_admin role. Admin (cross-org) is still bound — a
    // department must always retain at least one org_admin.
    if (existing.role === "org_admin" && role !== "org_admin") {
      try {
        assertNotLastOrgAdmin(existing.orgId, existing.id, existing.role);
      } catch (e) {
        if (e instanceof LastOrgAdminError) return res.status(400).json({ error: e.message });
        throw e;
      }
    }
    // M2 fix (review evt_20260811085308): atomic role change + token_version
    // bump in ONE SQL UPDATE — no window where role is changed but the old
    // token_version still validates the prior role's JWT. A demoted admin's
    // old JWT fails verifyUserTokenCurrent at the next REST/WS entry. Applies
    // to promotions too (no lingering stale lower-role JWT).
    updateUserRoleAndBumpTokenVersion(req.params.id, role as Role);
    writeGovernanceAudit({
      actorUserId: (req as any).userId,
      actorRole,
      orgId: existing.orgId,
      action: "user.role_change",
      objectType: "user",
      objectId: existing.id,
      reasonSummary: `${existing.role} → ${role}`,
    });
    // R5c: enqueue a member-sync task for the role change (best-effort).
    tryHook(() => dispatchUserHook(req.params.id, "role_change"));
    return res.json({ user: { ...existing, role } });
  }

  return res.status(400).json({ error: "No supported field (role | password | status | orgId)" });
});

app.delete("/api/admin/users/:id", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  if (req.params.id === (req as any).userId) return res.status(400).json({ error: "Cannot delete yourself" });
  const existing = getUserById(req.params.id);
  if (!existing) return res.status(404).json({ error: "User not found" });
  const denial = checkUserMutation({
    actorRole: isAdminReq(req) ? "admin" : "org_admin",
    actorOrg: (req as any).orgId,
    targetOrg: existing.orgId,
    targetCurrentRole: existing.role,
    // For delete, "desiredRole" = the current role (no change); the guard then
    // only enforces org + "cannot touch a privileged account".
    desiredRole: existing.role,
  });
  if (denial === "not found") return res.status(404).json({ error: "User not found" });
  if (denial) return res.status(403).json({ error: denial });
  // Last-admin protection: cannot delete the last remaining admin.
  if (existing.role === "admin" && countAdmins() <= 1) {
    return res.status(400).json({ error: "Cannot delete the last admin" });
  }
  // M1 last-org_admin protection: cannot delete the last effective org_admin of
  // a department.
  try {
    assertNotLastOrgAdmin(existing.orgId, existing.id, existing.role);
  } catch (e) {
    if (e instanceof LastOrgAdminError) return res.status(400).json({ error: e.message });
    throw e;
  }
  const deleted = deleteUser(req.params.id);
  if (!deleted) return res.status(404).json({ error: "User not found" });
  writeGovernanceAudit({
    actorUserId: (req as any).userId,
    actorRole: (isAdminReq(req) ? "admin" : "org_admin") as Role,
    orgId: existing.orgId,
    action: "user.delete",
    objectType: "user",
    objectId: existing.id,
  });
  res.json({ deleted: true });
});

// ─── Admin: User memory (MEMORY.md) ───────────────────────────────
// Enterprise admin can read the body, clear/recreate the doc, and configure the
// (global) quota. No enable/disable switch. Audit records METADATA ONLY — never
// the document body. org_admin = own-org users only; cross-org hidden as 404.
app.get("/api/admin/users/:userId/memory", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const target = getUserById(req.params.userId);
  if (!target) return res.status(404).json({ error: "User not found" });
  const denial = authorizeMemoryAccess({
    actorRole: isAdminReq(req) ? "admin" : "org_admin",
    actorOrg: (req as any).orgId,
    targetOrg: target.orgId,
  });
  if (denial === "not found") return res.status(404).json({ error: "User not found" });
  if (denial) return res.status(403).json({ error: denial });
  // Enterprise admin may view the body (plan §Required Outcome). Ensure provisioned.
  userMemoryService.ensureMemory(target.id);
  res.json({
    userId: target.id,
    body: userMemoryService.read(target.id),
    bytes: userMemoryService.getSizeBytes(target.id),
    quotaBytes: userMemoryService.getQuotaBytes(),
  });
});

app.delete("/api/admin/users/:userId/memory", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const target = getUserById(req.params.userId);
  if (!target) return res.status(404).json({ error: "User not found" });
  const denial = authorizeMemoryAccess({
    actorRole: isAdminReq(req) ? "admin" : "org_admin",
    actorOrg: (req as any).orgId,
    targetOrg: target.orgId,
  });
  if (denial === "not found") return res.status(404).json({ error: "User not found" });
  if (denial) return res.status(403).json({ error: denial });
  userMemoryService.clear(target.id);
  // Audit: metadata only — never the document body. Route is admin-only, so
  // actorRole is always "admin" (gate above guarantees it).
  eventStore.appendEvent(target.id, "system", "admin", "user_memory_cleared", {
    targetUserId: target.id,
    actorRole: "admin",
    actorOrg: (req as any).orgId,
  });
  res.json({ cleared: true, bytes: userMemoryService.getSizeBytes(target.id) });
});

// Quota is a single global platform setting → admin-only (like runtime-settings).
app.get("/api/admin/user-memory/quota", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  res.json({ quotaBytes: userMemoryService.getQuotaBytes() });
});

app.put("/api/admin/user-memory/quota", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const { quotaBytes } = req.body ?? {};
  try {
    const next = userMemoryService.setQuotaBytes(quotaBytes);
    eventStore.appendEvent((req as any).userId, "system", "admin", "user_memory_quota_changed", {
      quotaBytes: next,
      actorRole: "admin",
    });
    res.json({ quotaBytes: next });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Admin: Audit log (UI-3) ───────────────────────────────────
app.get("/api/admin/audit", authMiddleware, (req, res) => {
  if ((req as any).userRole !== "admin") return res.status(403).json({ error: "Admin only" });
  const limit = Math.min(500, parseInt(req.query.limit as string) || 100);
  const events = eventStore.getAuditEvents(limit);
  res.json({
    events: events.map((e) => ({
      id: e.id,
      sequence: e.sequence,
      eventType: e.eventType,
      chatId: e.chatId,
      createdAt: e.createdAt,
      payload: (() => { try { return JSON.parse(e.payloadJson); } catch { return { parseError: true }; } })(),
    })),
    hasMore: events.length >= limit,
  });
});

// ─── Agent OS M3 (plan §7): runId execution audit ─────────────────────────
// admin-only run detail router (see admin-run-routes.ts). Mounted with
// authMiddleware ONLY — NOT the shared privileged (admin|org_admin) gate —
// so the router's own isAdminReq guard returns the M3-required existence-
// hidden 404 for user/org_admin. (The privileged gate would 403 an ordinary
// user here, disclosing that the route exists.) same-org admin → 200;
// cross-org / nonexistent / non-admin → 404.
app.use("/api/admin", authMiddleware, createAdminRunRoutes());
// ─── Octop absorption M1a: connector catalog/instance router ────────────
// Admin-only (guard inside the router: org_admin/user → 403 + denied audit).
// Credential PUT is write-only — responses carry secret-free instance views.
// Enable only marks eligibility; agent visibility is M2 resolve()+entitlement.
app.use("/api/admin/connectors", authMiddleware, createAdminConnectorRoutes());
// ─── Octop absorption M1b: internal connector MCP (streamable HTTP) ──────
// NO authMiddleware — the per-request authority is the short-lived
// internal-mcp capability token (independent audience), verified + fully
// revalidated (instance state / configVersion / authorization intersection)
// inside connector-mcp.ts on EVERY call.
app.use("/api/mcp/connectors", createInternalConnectorMcpRoutes());
// ─── Octop absorption M2b: Feishu OAuth callback (browser redirect) ─────
// NO authMiddleware BY DESIGN: the callback trusts ONLY the one-time OAuth
// state record (bound to instance + actor + PKCE verifier + redirect URI +
// short expiry, consumed atomically before the code exchange) — never
// browser-provided identity or token claims. Redirects the admin browser to
// the connectors page with a success/error flag; no token material in URLs.
app.get("/api/connectors/oauth/feishu/callback", async (req, res) => {
  const outcome = await handleOAuthCallback(req);
  const flag = outcome.ok ? "success" : "error";
  // Fix round #2: a state that was NEVER valid writes no audit row — an
  // unauthenticated attacker replaying random states must not be able to
  // inflate the audit table. Only state-backed failures are audited.
  if (!outcome.ok && outcome.auditable) {
    writeGovernanceAudit({
      actorUserId: null,
      actorRole: null,
      orgId: "default-org",
      action: "connector.oauth.callback",
      objectType: "connector_instance",
      result: "denied",
      reasonSummary: outcome.error.slice(0, 200),
    });
  }
  res.redirect(`/admin/connectors?oauth=${flag}`);
});
// ─── Admin: Organization management (Phase 7.2) ────────────────────────
// admin: list/create/rename orgs (cross-org). org_admin: read own org only.
// No delete in 7.2 (referential safety: users/chats/agents reference org_id).
app.get("/api/admin/orgs", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  // M3: enterprise overview carries per-org user + active-org_admin counts.
  // admin sees the whole enterprise; org_admin sees only their own dept row.
  // Counts are derived server-side — the client never parses orgId to scope.
  const summary = isAdminReq(req)
    ? orgService.listSummary()
    : ([] as ReturnType<typeof orgService.listSummary>).concat(
        orgService.listSummaryForOrg((req as any).orgId) ?? []
      );
  res.json({ orgs: summary });
});

// M3: department detail — org + its users + its org_admins. admin may open any
// department; org_admin may open ONLY their own dept (a foreign :id yields 404,
// not 403, so existence of other depts is not leaked). No writes here — every
// status/reset/migrate write already goes through PATCH /api/admin/users/:id
// with metadata-only governance audit. Users come from listUsersInOrg (server-
// scoped by org_id; never trust a client orgId).
app.get("/api/admin/orgs/:id/detail", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const targetId = req.params.id;
  // org_admin: own dept only. Deny cross-dept reads (return 404 to avoid
  // leaking that another org id exists).
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    return res.status(404).json({ error: "Organization not found" });
  }
  const org = orgService.get(targetId);
  if (!org) return res.status(404).json({ error: "Organization not found" });
  const users = listUsersInOrg(targetId);
  const orgAdmins = users.filter((u) => u.role === "org_admin");
  res.json({ org, users, orgAdmins });
});

// M1 (org governance): provision = the atomic department-open transaction. In
// ONE request: create org (provisioning → active) + first org_admin
// (must_change_password=1) + default quota row + governance audit. Any failure
// rolls back the whole transaction (no half-configured loginable department).
// admin-only (writes shared org + creates a privileged user).
app.post("/api/admin/orgs", authMiddleware, async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const { id, name, adminUsername, adminPassword, adminDisplayName } = req.body ?? {};
  try {
    const result = await provisionOrg({
      id,
      name,
      firstAdminUsername: adminUsername,
      firstAdminPassword: adminPassword,
      firstAdminDisplayName: adminDisplayName,
      actorUserId: (req as any).userId,
      actorRole: "admin",
    });
    // R5c: persist the org→TEAM-namespace mapping (best-effort, nonrollback —
    // provisionOrg already committed; a mapping failure must not fail the
    // HTTP response).
    tryHook(() => onOrgCreated(result.org.id));
    res.status(201).json({ org: result.org, adminUserId: result.adminUserId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/admin/orgs/:id", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const { name } = req.body ?? {};
  try {
    const org = orgService.updateName(req.params.id, name);
    if (!org) return res.status(404).json({ error: "Org not found" });
    res.json({ org });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// M1: status transitions — admin suspends / reactivates a department. Only
// `active ↔ suspended` is exposed (provisioning→active is the provision txn's
// job; archived is reserved with no M1 entry point). Illegal jumps are rejected
// by transitionOrgStatus against the legal-transition graph. admin-only.
app.post("/api/admin/orgs/:id/:action(suspend|activate)", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  try {
    const org = transitionOrgStatus({
      orgId: req.params.id,
      action: req.params.action as OrgAction,
      actorUserId: (req as any).userId,
      actorRole: "admin",
    });
    // R5c: freeze/unfreeze the TEAM-namespace mapping to match (best-effort,
    // nonrollback — transitionOrgStatus already committed).
    tryHook(() => (req.params.action === "suspend" ? onOrgFrozen(req.params.id) : onOrgActivated(req.params.id)));
    res.json({ org });
  } catch (err: any) {
    // Illegal transition / not found → 400; keep the message categorical.
    res.status(400).json({ error: err.message });
  }
});

// R5c: controlled Skill Hub navigation. 铁律 — the platform NEVER sends a
// service token, the platform orgId, or the user's role to the browser. The
// response carries only a Hub URL (admin: bare base; org_admin/user: own team
// namespace deep-link — a Hub-side identifier, NOT the platform orgId). The
// browser authenticates to the Hub via the Hub's OWN session. Any authenticated
// user may launch; the Hub enforces what they can see/do. 503 if Hub base
// unconfigured (never hand the browser a guessed URL).
app.get("/api/hub/launch", authMiddleware, (req, res) => {
  try {
    const launch = buildHubLaunchResponse(ctxFromReq(req), { hubBaseUrl: process.env.SKILLHUB_URL ?? "" });
    res.json(launch);
  } catch {
    res.status(503).json({ error: "Skill Hub not configured" });
  }
});

// R5c: Hub member-sync admin surface. Closes codex review #2/#5 — the member-
// sync state machine is now reachable in production, with authenticated scoped
// query + safe replay (exhausted-state check + cross-org deny) + admin-triggered
// reconcile/backfill. org_admin sees own-org tasks only; admin sees all.
// metadata-only: errors are categorical strings; never raw Hub body/token.

// Scoped query: list pending or exhausted member-sync tasks. ?state=exhausted
// switches the list; default pending. admin = all; org_admin = own org only.
app.get("/api/admin/hub/member-tasks", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const ctx = ctxFromReq(req);
  const scope = {
    requesterRole: ctx.role,
    requesterOrgId: ctx.orgId,
    orgId: typeof req.query.orgId === "string" ? req.query.orgId : undefined,
  };
  const tasks = req.query.state === "exhausted"
    ? memberSyncService.listExhausted(scope)
    : memberSyncService.listPending(scope);
  res.json({ tasks });
});

// Safe replay: admin only (org_admin may NOT replay — cross-org deny is the
// default; even own-org replay is admin-only to prevent an org_admin from
// force-retrying a task). 404 = not found / cross-org denied; 409 = not
// exhausted (only exhausted tasks are replayable).
app.post("/api/admin/hub/member-tasks/:id/replay", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const ctx = ctxFromReq(req);
  const result = memberSyncService.replay(req.params.id, {
    requesterRole: ctx.role,
    requesterOrgId: ctx.orgId,
  });
  if (result.reason === "not_found" || result.reason === "cross_org_denied") {
    return res.status(404).json({ error: "Task not found" });
  }
  if (result.reason === "not_exhausted") {
    return res.status(409).json({ error: "Only exhausted tasks can be replayed" });
  }
  res.json({ task: result.task });
});

// Admin-triggered member-sync pass (operator reconcile after Hub outage or
// mapping backfill). Returns the before/after counts. Never throws —
// best-effort, nonrollback.
app.post("/api/admin/hub/member-sync/run", authMiddleware, async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  try {
    const result = await runMemberSyncPass();
    res.json(result);
  } catch {
    res.status(500).json({ error: "member-sync pass failed" });
  }
});

// Backfill org→namespace mappings for existing orgs missing one (missed
// onOrgCreated hooks). admin only (touches shared mapping table). Idempotent.
app.post("/api/admin/hub/mappings/backfill", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  try {
    const created = backfillOrgMappings();
    res.json({ created });
  } catch {
    res.status(500).json({ error: "mapping backfill failed" });
  }
});

// Durable reconcile for missed user hooks: re-enqueue every user's current
// desired state for one org (body.orgId) or all active orgs. Idempotency
// dedupes — only users whose hook was missed get a NEW task. admin only.
app.post("/api/admin/hub/member-tasks/reconcile", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  try {
    const orgId = typeof req.body?.orgId === "string" ? req.body.orgId : undefined;
    const enqueued = reconcileMemberSync(orgId);
    res.json({ enqueued });
  } catch {
    res.status(500).json({ error: "reconcile failed" });
  }
});

// R5d-1: background Skill sync closure. admin-only immediate sync that shares
// the worker's mutual-exclusion lock (a periodic tick + this route cannot
// overlap). Returns metadata ONLY: imported/skipped/errors counts + disabled
// (Hub unconfigured) + busy (another cycle in flight) + target count. Never
// raw Hub bodies/tokens. org_admin/user → 403 (the platform skill:read token
// is ops-only; business users never touch it).
app.post("/api/admin/hub/sync/run", authMiddleware, async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  try {
    const result = await runSkillSyncCycle();
    res.json(result);
  } catch {
    res.status(500).json({ error: "skill sync cycle failed" });
  }
});

// R5d-1 §3: namespace-level sync status. admin → all namespaces; org_admin →
// own-org only (cross-dept ABSENT, no existence leak — 404-style deny). Plain
// user → 403. metadata-only: categorical errorCategory, never raw body/token.
app.get("/api/admin/hub/sync/status", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin or org_admin only" });
  const ctx = ctxFromReq(req);
  const scope = { requesterRole: ctx.role, requesterOrgId: ctx.orgId };
  const namespaces = listStatusForScope(scope);
  res.json({ namespaces });
});

app.get("/api/admin/hub/sync/status/:namespace", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin or org_admin only" });
  const ctx = ctxFromReq(req);
  const scope = { requesterRole: ctx.role, requesterOrgId: ctx.orgId };
  const status = getStatusForScope(req.params.namespace, scope);
  if (!status) return res.status(404).json({ error: "Namespace status not found" });
  res.json({ status });
});
// org_admin scoping: cross-dept reads return 404 (no existence leak), matching
// the M3 /orgs/:id/detail pattern. orgId is the server-trusted JWT claim only;
// the :id param is a TARGET, never a trusted identity.

// Quota READ — admin (any org) OR org_admin (own org only). Returns the resolved
// quota (NULL → platform default) + a current-usage snapshot for the UI.
app.get("/api/admin/orgs/:id/quota", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const targetId = req.params.id;
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    return res.status(404).json({ error: "Organization not found" });
  }
  try {
    const quota = getQuota(targetId);
    if (!quota) return res.status(404).json({ error: "Organization not found" });
    res.json({ quota });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Quota UPDATE — admin only (enterprise control; an org_admin cannot raise its
// own ceiling — that would defeat the governance model). Writes a metadata-only
// `quota.update` audit row. NULL columns not in the patch keep their semantics.
app.put("/api/admin/orgs/:id/quota", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const { maxAgents, maxConcurrentRuntimes, maxStorageMb, maxTurnsPerRuntime, maxTokensMonthly, tokenAlertThresholdPct } = req.body ?? {};
  const patch = { maxAgents, maxConcurrentRuntimes, maxStorageMb, maxTurnsPerRuntime, maxTokensMonthly, tokenAlertThresholdPct };
  // Strip undefineds so absent fields keep their current value.
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
    if (patch[k] === undefined) delete patch[k];
  }
  try {
    const quota = setQuota(req.params.id, patch);
    writeGovernanceAudit({
      actorUserId: (req as any).userId,
      actorRole: "admin",
      orgId: req.params.id,
      action: "quota.update",
      objectType: "quota",
      objectId: req.params.id,
      result: "success",
      reasonSummary: `maxAgents=${quota.maxAgents} maxConcurrentRuntimes=${quota.maxConcurrentRuntimes} maxStorageMb=${quota.maxStorageMb} maxTurnsPerRuntime=${quota.maxTurnsPerRuntime} maxTokensMonthly=${quota.maxTokensMonthly} tokenAlertThresholdPct=${quota.tokenAlertThresholdPct}`,
    });
    res.json({ quota });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── M1: Model management (docs/开发计划/model-and-token-management-plan.md §7) ──────
// Catalog writes are ADMIN-ONLY (shared platform pool — same 铁律 as skills:
// touching it affects every org). org_admin gets a VIEW of its own-org
// effective models only; the raw catalog must NOT leak (deny-default overlay).
// M1 scope: NO /import, NO /providers (M5), NO chat-level selection (M2).

// Privileged: list catalog. admin = full pool; org_admin = own-org effective
// models (platform-enabled ∩ org-entitled) + effective default, view-only.
app.get("/api/admin/models", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Privileged only" });
  if (isAdminReq(req)) {
    return res.json({ models: listModels(), scope: "platform" });
  }
  const policy = getOrgModelPolicy((req as any).orgId);
  const byId = new Map(listModels().map((m) => [m.id, m]));
  const visible = policy.effective.models
    .map((m) => byId.get(m.id))
    .filter((m): m is NonNullable<typeof m> => !!m);
  return res.json({ models: visible, scope: "org", effectiveDefault: policy.effective.defaultAlias, defaultSource: policy.effective.defaultSource });
});

// Admin-only: create a catalog entry (manual import form; provider NAME only —
// credentials never enter this API).
app.post("/api/admin/models", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.create", result: "denied", reasonSummary: "admin only" });
    return res.status(403).json({ error: "Admin only" });
  }
  try {
    const model = createModel(req.body ?? {});
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.create", objectId: model.id, reasonSummary: `alias=${model.alias} provider=${model.provider} enabled=${model.enabled}` });
    res.status(201).json({ model });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Admin-only: edit/toggle a catalog entry. Disabling a model that is some
// org's default cascades a NULL-out of those defaults (plan §10 invariant).
app.put("/api/admin/models/:id", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.update", objectId: req.params.id, result: "denied", reasonSummary: "admin only" });
    return res.status(403).json({ error: "Admin only" });
  }
  try {
    const affected = orgsUsingModelAsDefault(req.params.id);
    const model = updateModel(req.params.id, req.body ?? {});
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.update", objectId: model.id, reasonSummary: `alias=${model.alias} enabled=${model.enabled}${!model.enabled && affected.length ? ` clearedDefaults=${affected.length}` : ""}` });
    res.json({ model, clearedOrgDefaults: !model.enabled ? affected : [] });
  } catch (err: any) {
    res.status(err.message === "Model not found" ? 404 : 400).json({ error: err.message });
  }
});

// Admin-only: delete a catalog entry. Entitlements cascade via FK; org
// defaults NULL out via FK ON DELETE SET NULL (same §10 invariant).
app.delete("/api/admin/models/:id", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.delete", objectId: req.params.id, result: "denied", reasonSummary: "admin only" });
    return res.status(403).json({ error: "Admin only" });
  }
  try {
    const affected = orgsUsingModelAsDefault(req.params.id);
    deleteModel(req.params.id);
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.delete", objectId: req.params.id, reasonSummary: `deleted; clearedDefaults=${affected.length}` });
    res.json({ ok: true, clearedOrgDefaults: affected });
  } catch (err: any) {
    res.status(err.message === "Model not found" ? 404 : 400).json({ error: err.message });
  }
});

// ─── M5: Provider model import (plan §6.2, §9-M5) ──────────────
// All three routes ADMIN-ONLY (import writes the shared catalog → affects every
// org). 铁律: no arbitrary URL — the :id is validated against the connector
// whitelist (hardcoded base URLs). Credentials come ONLY from process.env; they
// never enter the request, the DB, the response, or the audit payload. Import
// touches model_catalog ONLY — never org entitlements / org policy / Chat or
// Agent overrides (event M5-3).
app.get("/api/admin/models/providers", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  res.json({ providers: listProviders() });
});

app.post("/api/admin/models/providers/:id/preview", authMiddleware, async (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.import", objectId: req.params.id, result: "denied", reasonSummary: "admin only" });
    return res.status(403).json({ error: "Admin only" });
  }
  const providerId = req.params.id;
  if (!getProvider(providerId)) {
    return res.status(404).json({ error: "Unknown provider" });
  }
  const result = await listProviderModels(providerId);
  const statusToHttp: Record<string, number> = {
    ok: 200, not_configured: 409, timeout: 504, auth_failed: 401, unavailable: 502, error: 400,
  };
  const http = statusToHttp[result.status] ?? 400;
  // Audit: provider name + status + count — NO credentials, NO model payloads.
  auditModelChange({
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId: ctx.orgId,
    action: "model.import",
    objectId: providerId,
    result: result.status === "ok" ? "success" : "failure",
    reasonSummary: `preview status=${result.status} count=${result.models.length}${result.message ? ` msg=${result.message.slice(0, 80)}` : ""}`,
  });
  res.status(http).json(result);
});

app.post("/api/admin/models/import", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.import", result: "denied", reasonSummary: "admin only" });
    return res.status(403).json({ error: "Admin only" });
  }
  const { provider, models } = req.body ?? {};
  if (typeof provider !== "string" || !getProvider(provider)) {
    return res.status(400).json({ error: "Unknown or missing provider" });
  }
  if (!Array.isArray(models)) {
    return res.status(400).json({ error: "models must be an array" });
  }
  // Cap the batch to bound a single admin request.
  if (models.length > 100) {
    return res.status(400).json({ error: "models batch too large (max 100)" });
  }
  const results = models.map((m): { alias: string; status: ImportStatus; modelId?: string; error?: string } => {
    if (!m || typeof m !== "object") return { alias: "", status: "invalid", error: "entry must be an object" };
    const alias = typeof (m as any).alias === "string" ? (m as any).alias : "";
    const modelId = typeof (m as any).modelId === "string" ? (m as any).modelId : null;
    const contextWindowTokens =
      typeof (m as any).contextWindowTokens === "number" ? (m as any).contextWindowTokens : null;
    const description = typeof (m as any).description === "string" ? (m as any).description : null;
    return importModel({ alias, provider, modelId, contextWindowTokens, description });
  });
  const summary = {
    imported: results.filter((r) => r.status === "imported").length,
    updated: results.filter((r) => r.status === "updated").length,
    conflict: results.filter((r) => r.status === "conflict").length,
    invalid: results.filter((r) => r.status === "invalid").length,
  };
  auditModelChange({
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId: ctx.orgId,
    action: "model.import",
    objectId: provider,
    reasonSummary: `import provider=${provider} imported=${summary.imported} updated=${summary.updated} conflict=${summary.conflict} invalid=${summary.invalid}`,
  });
  res.status(200).json({ provider, results, summary });
});

// M6 (Anthropic-only model definitions, plan §6.2 minimal): paste-JSON import.
// Accepts a single object or an array (max 100). Writes model_catalog ONLY —
// no .env rewrite, no org authorization, no Chat/Agent model switch. Plaintext
// apiKey is rejected at the model layer; baseUrl stays directory metadata (the
// runtime keeps using the single deployed ANTHROPIC_BASE_URL).
app.post("/api/admin/models/import-json", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isAdminReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model.import_definition", result: "denied", reasonSummary: "admin only" });
    return res.status(403).json({ error: "Admin only" });
  }
  const body = req.body ?? {};
  // Accept: [ ...defs ] | { models: [ ...defs ] } | { ...single def }.
  // A body carrying a `models` KEY that is not an array is a shape error (400),
  // not a single def — keeps the wrapper unambiguous.
  const models: unknown[] | null = Array.isArray(body)
    ? body
    : "models" in body
      ? Array.isArray(body.models) ? body.models : null
      : typeof body === "object" && body !== null ? [body] : null;
  if (!models) {
    return res.status(400).json({ error: "body must be a model object or { models: [...] }" });
  }
  if (models.length === 0) {
    return res.status(400).json({ error: "models array is empty" });
  }
  if (models.length > 100) {
    return res.status(400).json({ error: "models batch too large (max 100)" });
  }
  const results: Array<{ alias: string; status: ImportStatus; modelId?: string; error?: string }> = models.map((m) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return { alias: "", status: "invalid", error: "entry must be an object" };
    }
    return importModelDefinition(m as ModelDefinitionInput);
  });
  const summary = {
    imported: results.filter((r) => r.status === "imported").length,
    updated: results.filter((r) => r.status === "updated").length,
    conflict: results.filter((r) => r.status === "conflict").length,
    invalid: results.filter((r) => r.status === "invalid").length,
  };
  auditModelChange({
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId: ctx.orgId,
    action: "model.import_definition",
    objectId: "model_catalog",
    reasonSummary: `import-json imported=${summary.imported} updated=${summary.updated} conflict=${summary.conflict} invalid=${summary.invalid}`,
  });
  res.status(200).json({ results, summary });
});

// Org model policy — admin (any org) OR org_admin (OWN org only; a foreign
// :id yields 404, not 403, so other orgs' existence is not leaked — same
// pattern as /orgs/:id/detail). org_admin MAY edit its own org policy
// (authorize models + set default) but never the platform catalog.
app.get("/api/admin/orgs/:id/model-policy", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Privileged only" });
  const targetId = req.params.id;
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    return res.status(404).json({ error: "Organization not found" });
  }
  res.json({ policy: getOrgModelPolicy(targetId) });
});

app.put("/api/admin/orgs/:id/model-policy", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isPrivilegedReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model_policy.update", objectId: req.params.id, result: "denied", reasonSummary: "privileged only" });
    return res.status(403).json({ error: "Privileged only" });
  }
  const targetId = req.params.id;
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "model_policy.update", objectId: targetId, result: "denied", reasonSummary: "cross-org denied" });
    return res.status(404).json({ error: "Organization not found" });
  }
  try {
    const { defaultModelId, models } = req.body ?? {};
    const policy = setOrgModelPolicy(targetId, { defaultModelId, models });
    auditModelChange({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: targetId,
      action: "model_policy.update",
      objectId: targetId,
      reasonSummary: `entitled=${policy.effective.models.length} defaultSource=${policy.effective.defaultSource}${policy.defaultAlias ? ` default=${policy.defaultAlias}` : ""}`,
    });
    res.json({ policy });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── M2: Chat/Agent model selection (plan §7) ──────────────
// GET returns { override, overrideSource, effective: {alias, source}, available }
// — everything the header selector needs (current effective model + its source
// + the org-selectable list). PUT {modelAlias: string|null} is validated
// SERVER-SIDE against 平台启用 ∩ 组织授权 — the frontend can never inject an
// arbitrary model string. NO hot-switch: a change flips configVersion and is
// surfaced as drift/rebuild hint by the existing MP4c/R1 machinery; the running
// runtime and the conversation history are untouched.

// Access rule = the PATCH /api/agents/:agentId rule (chatId === agentId):
// owner, org_admin of the agent's org, or admin (cross-org). 404 otherwise —
// no existence leak.
function canSelectModel(ctx: RequestContext, chatId: string): boolean {
  const agent = agentService.getChat(chatId);
  if (!agent) return false;
  if (ctx.role === "admin") return true;
  if (ctx.role === "org_admin") return agent.orgId === ctx.orgId;
  return agent.userId === ctx.userId && agent.orgId === ctx.orgId;
}

app.get("/api/chats/:chatId/model", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  const chatId = req.params.chatId;
  if (!canSelectModel(ctx, chatId)) {
    return res.status(404).json({ error: "Chat not found" });
  }
  const sel = getChatModelSelection(chatId);
  if (!sel) return res.status(404).json({ error: "Chat not found" });
  res.json(sel);
});

app.put("/api/chats/:chatId/model", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  const chatId = req.params.chatId;
  if (!canSelectModel(ctx, chatId)) {
    return res.status(404).json({ error: "Chat not found" });
  }
  const { modelAlias } = req.body ?? {};
  if (modelAlias != null && typeof modelAlias !== "string") {
    return res.status(400).json({ error: "modelAlias must be a string or null" });
  }
  const orgId = agentService.getChat(chatId)!.orgId ?? ctx.orgId;
  const cvBefore = computeConfigVersion(ctx, chatId);
  try {
    setChatModelOverride(chatId, modelAlias ?? null);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  const cvAfter = computeConfigVersion(ctx, chatId);
  auditModelChange({
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId,
    action: "model_override.update",
    objectId: chatId,
    reasonSummary: `chat-level → ${modelAlias ?? "(cleared)"}; configVersion ${cvBefore}→${cvAfter}`,
  });
  res.json({
    ...getChatModelSelection(chatId)!,
    configVersion: cvAfter,
    configChanged: cvBefore !== cvAfter,
    // Selector hint: applies to the NEXT runtime (stop/rebuild), never hot.
    appliesTo: "next_runtime",
  });
});

// Agent-level default (the middle precedence level). Same guard; writes
// agents.model_override so a Chat-level choice still wins over it.
app.get("/api/agents/:agentId/model", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  const agentId = req.params.agentId; // === chatId compatibility bridge
  if (!canSelectModel(ctx, agentId)) {
    return res.status(404).json({ error: "Agent not found" });
  }
  const sel = getChatModelSelection(agentId);
  if (!sel) return res.status(404).json({ error: "Agent not found" });
  res.json(sel);
});

app.put("/api/agents/:agentId/model", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  const agentId = req.params.agentId;
  if (!canSelectModel(ctx, agentId)) {
    return res.status(404).json({ error: "Agent not found" });
  }
  const { modelAlias } = req.body ?? {};
  if (modelAlias != null && typeof modelAlias !== "string") {
    return res.status(400).json({ error: "modelAlias must be a string or null" });
  }
  const orgId = agentService.getChat(agentId)!.orgId ?? ctx.orgId;
  const cvBefore = computeConfigVersion(ctx, agentId);
  try {
    setAgentModelOverride(agentId, modelAlias ?? null);
  } catch (err: any) {
    return res.status(err.message === "Agent not found" ? 404 : 400).json({ error: err.message });
  }
  const cvAfter = computeConfigVersion(ctx, agentId);
  auditModelChange({
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    orgId,
    action: "model_override.update",
    objectId: agentId,
    reasonSummary: `agent-level → ${modelAlias ?? "(cleared)"}; configVersion ${cvBefore}→${cvAfter}`,
  });
  res.json({
    ...getChatModelSelection(agentId)!,
    configVersion: cvAfter,
    configChanged: cvBefore !== cvAfter,
    appliesTo: "next_runtime",
  });
});

// ─── M4: Chat context visibility (plan §4.2) ──────────────
// GET /api/chats/:chatId/context — read-only companion to the model selector:
// current effective model + context estimate (last result's input-side tokens)
// + cumulative usage + last compact + the effective Auto Compact policy.
// Same guard as the model selector (owner / own-org org_admin / admin; 404 —
// no existence leak). The chip only DISPLAYS; it never mutates policy.
app.get("/api/chats/:chatId/context", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  const chatId = req.params.chatId;
  if (!canSelectModel(ctx, chatId)) {
    return res.status(404).json({ error: "Chat not found" });
  }
  const chat = agentService.getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  const orgId = chat.orgId ?? ctx.orgId;
  const stats = getChatUsageStats(orgId, chatId);
  res.json({
    chatId,
    model: getChatModelSelection(chatId),
    context: {
      estimateTokens: stats.lastResultEstimateTokens,
      autoCompact: getEffectiveCompaction(orgId),
    },
    usage: stats.usage,
    lastCompact: getChatLastCompact(orgId, chatId),
  });
});

// ─── M3: org token usage dashboard (plan §7 org_admin Token 明细) ──
// GET /api/admin/orgs/:id/token-usage?from=&to=&groupBy=day|user|agent|chat
//     &userId=&chatId=&limit=&offset=
// Read-only aggregation of result-event token usage (4 provider dims, no
// prices). Org isolation is SERVER-SIDE from the JWT claim: org_admin hitting
// a foreign :id gets 404 (no existence leak), plain user 403 — the :id param
// can never widen scope. Budget card = current UTC month (quota-service).
app.get("/api/admin/orgs/:id/token-usage", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) {
    return res.status(403).json({ error: "Privileged only" });
  }
  const targetId = req.params.id;
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    return res.status(404).json({ error: "Organization not found" });
  }
  const groupBy = req.query.groupBy as string | undefined;
  if (groupBy !== undefined && !["day", "user", "agent", "chat"].includes(groupBy)) {
    return res.status(400).json({ error: "groupBy must be one of day|user|agent|chat" });
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  try {
    const usage = queryTokenUsage({
      orgId: targetId,
      from: str(req.query.from),
      to: str(req.query.to),
      groupBy: (groupBy ?? "day") as "day" | "user" | "agent" | "chat",
      userId: str(req.query.userId),
      chatId: str(req.query.chatId),
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json({ usage, budget: getOrgTokenBudget(targetId) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── M4: org Auto Compact policy (plan §4.3 phase 1) ──────────────
// Org overlay over the platform default (runtime-settings contextCompaction).
// admin (any org) OR org_admin (OWN org; foreign :id → 404, no existence leak
// — same pattern as model-policy). Org numerics are clamped to the CURRENT
// platform ceilings at write AND read (组织值受平台上限约束); enabled is
// narrow-only (an org can turn OFF platform-on compaction, never ON).
app.get("/api/admin/orgs/:id/compact-policy", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Privileged only" });
  const targetId = req.params.id;
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    return res.status(404).json({ error: "Organization not found" });
  }
  const { policy, caps } = getOrgCompactPolicy(targetId);
  res.json({
    policy: policy ?? getPlatformCompaction(),
    source: policy ? "org" : "platform",
    platform: getPlatformCompaction(),
    caps,
  });
});

app.put("/api/admin/orgs/:id/compact-policy", authMiddleware, (req, res) => {
  const ctx = ctxFromReq(req);
  if (!isPrivilegedReq(req)) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "compact_policy.update", objectId: req.params.id, result: "denied", reasonSummary: "privileged only" });
    return res.status(403).json({ error: "Privileged only" });
  }
  const targetId = req.params.id;
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    auditModelChange({ actorUserId: ctx.userId, actorRole: ctx.role, orgId: ctx.orgId, action: "compact_policy.update", objectId: targetId, result: "denied", reasonSummary: "cross-org denied" });
    return res.status(404).json({ error: "Organization not found" });
  }
  const { enabled, thresholdTokens, keepRecentTurns } = req.body ?? {};
  if (enabled != null && typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  if (thresholdTokens != null && typeof thresholdTokens !== "number") {
    return res.status(400).json({ error: "thresholdTokens must be a number" });
  }
  if (keepRecentTurns != null && typeof keepRecentTurns !== "number") {
    return res.status(400).json({ error: "keepRecentTurns must be a number" });
  }
  try {
    const { policy, stored, clamped } = setOrgCompactPolicy(targetId, { enabled, thresholdTokens, keepRecentTurns });
    auditModelChange({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      orgId: targetId,
      action: "compact_policy.update",
      objectId: targetId,
      reasonSummary: `enabled=${stored.enabled} threshold=${stored.thresholdTokens} keep=${stored.keepRecentTurns}${clamped.length ? ` clamped=[${clamped.join(",")}]` : ""}`,
    });
    res.json({ policy, stored, clamped, caps: getCompactionCaps() });
  } catch (err: any) {
    res.status(err.message === "Organization not found" ? 404 : 400).json({ error: err.message });
  }
});

// Per-org usage summary — admin (any org) OR org_admin (own org only). Returns
// agent count, active runtime count, and storage bytes (the same numbers the
// quota gate checks against). Read-only; no audit.
app.get("/api/admin/orgs/:id/usage", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  const targetId = req.params.id;
  if (!isAdminReq(req) && targetId !== (req as any).orgId) {
    return res.status(404).json({ error: "Organization not found" });
  }
  try {
    const quota = getQuota(targetId);
    if (!quota) return res.status(404).json({ error: "Organization not found" });
    res.json({ usage: quota.usage, limits: {
      maxAgents: quota.maxAgents,
      maxConcurrentRuntimes: quota.maxConcurrentRuntimes,
      maxStorageMb: quota.maxStorageMb,
      maxTurnsPerRuntime: quota.maxTurnsPerRuntime,
      maxTokensMonthly: quota.maxTokensMonthly,
      tokenAlertThresholdPct: quota.tokenAlertThresholdPct,
    }, tokenStatus: quota.tokenStatus });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Governance audit QUERY — admin (unscoped, all orgs) OR org_admin (own-org only,
// enforced by server-side orgId filter — the client never scopes). Paginated +
// filterable by action/result/date. Reads governance_audit_log (metadata-only),
// NOT agent_events (a separate sink surfaced by the existing /api/admin/audit).
app.get("/api/admin/governance-audit", authMiddleware, (req, res) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  // org_admin is force-scoped to its own org; admin may pass an explicit orgId
  // query param OR omit it for the enterprise-wide view.
  let orgId: string | null = null;
  if (!isAdminReq(req)) {
    orgId = (req as any).orgId;
  } else if (typeof req.query.orgId === "string" && req.query.orgId) {
    orgId = req.query.orgId;
  }
  try {
    const result = queryGovernanceAudit({
      orgId,
      action: (typeof req.query.action === "string" && req.query.action) || null,
      result: (["success", "failure", "denied"].includes(req.query.result as string) ? (req.query.result as any) : null),
      from: (typeof req.query.from === "string" && req.query.from) || null,
      to: (typeof req.query.to === "string" && req.query.to) || null,
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Governance audit EXPORT — admin only (org_admin export is out of v1 scope;
// the existing query route already gives org_admin its own-org view). Emits
// the SAME metadata-only columns as the query (never body/payload). CSV or JSON.
app.get("/api/admin/governance-audit/export", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const format = req.query.format === "json" ? "json" : "csv";
  const orgId = (typeof req.query.orgId === "string" && req.query.orgId) || null;
  try {
    const out = exportGovernanceAudit(format, {
      orgId,
      action: (typeof req.query.action === "string" && req.query.action) || null,
      result: (["success", "failure", "denied"].includes(req.query.result as string) ? (req.query.result as any) : null),
      from: (typeof req.query.from === "string" && req.query.from) || null,
      to: (typeof req.query.to === "string" && req.query.to) || null,
    });
    res.setHeader("Content-Type", out.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.body);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Governance audit PURGE — admin only. Triggers the 180-day retention sweep
// (design §7) on demand. Default days=180; clamped to [1, 3650]. Returns the
// number of rows deleted; writes one `audit.purge` metadata row.
app.post("/api/admin/governance-audit/purge", authMiddleware, (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only" });
  const days = Math.max(1, Math.min(3650, parseInt(req.body?.days as string) || 180));
  try {
    const deleted = purgeOldAudit(days);
    writeGovernanceAudit({
      actorUserId: (req as any).userId,
      actorRole: "admin",
      orgId: (req as any).orgId ?? "default-org",
      action: "audit.purge",
      objectType: "audit_log",
      objectId: null,
      result: "success",
      reasonSummary: `purged ${deleted} rows older than ${days} days`,
    });
    res.json({ deleted, days });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Wire shared delete cleanup handler (avoids circular dep — server.ts owns sessions/containerManager)
setDeleteAgentCleanup(deleteAgentCleanup);
// Admin application management. Phase 7.2: applications CRUD is org-scopable
// (admin OR org_admin); apis/plugins stay admin-only (they write the global mcp/
// filesystem) and are re-gated inside the router. authMiddleware already applied.
app.use("/api/admin", authMiddleware, (req, res, next) => {
  if (!isPrivilegedReq(req)) return res.status(403).json({ error: "Admin only" });
  next();
}, createAdminAppRoutes());

// SPA catch-all (integrated-walkthrough P2) — see server/spa-fallback.ts.
app.get("*", createSpaCatchAll(serveSpaIndex));

// Create HTTP server
const server = createServer(app);

// WebSocket server — Phase 6 (A1): noServer mode for path-based routing.
// Legacy WS:  /ws?token=...
// App-scoped: /api/apps/:appId/ws?token=...&appKey=...
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Route: /ws → legacy WS (token only)
  // Route: /api/apps/:appId/ws → app-scoped WS (token + appKey)
  // Reject any other /api/apps/* path to prevent undocumented legacy WS aliases.
  if (pathname === "/ws" || /^\/api\/apps\/[^/]+\/ws$/.test(pathname)) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WSClient, req) => {
  const url = new URL(req.url || "", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const token = url.searchParams.get("token");
  const appKey = url.searchParams.get("appKey");

  // Phase 6 (A1): determine if this is an app-scoped connection by URL path.
  // App-scoped path: /api/apps/:appId/ws — extract appId from path for consistency check.
  const appScopedMatch = pathname.match(/^\/api\/apps\/([^/]+)\/ws$/);
  const urlAppId = appScopedMatch ? decodeURIComponent(appScopedMatch[1]) : null;

  let userId: string;
  let userRole: "admin" | "user";
  let wsAppId: string | undefined;
  let userOrgId: string = DEFAULT_ORG_ID;

  const widgetToken = url.searchParams.get("widgetToken");

  if (urlAppId && widgetToken) {
    // Widget WS (platform Widget SDK): short-lived widgetToken, no AppKey in
    // the browser. Resolves into the SAME {userId, role, appId} principal as
    // the app-scoped path — the downstream message handler is unchanged, so
    // there is no third auth/ownership branch (Codex review P1-b).
    const wp = verifyWidgetToken(widgetToken);
    if (!wp || wp.appId !== urlAppId) {
      ws.close(4001, "Invalid or mismatched widget token");
      return;
    }
    userId = wp.userId;
    userRole = wp.role;
    wsAppId = wp.appId;
    // Phase 7: widget tokens don't yet carry an orgId claim; resolve the
    // operator's org from the user record (trusted source). Debt: bake orgId
    // into WidgetTokenPayload in 7.2 so this path needs no DB lookup.
    const widgetOwner = getUserById(wp.userId);
    // M2 (user lifecycle): widget tokens are short-lived (≤30m) and carry no
    // token_version, so this path does a status-only check — a disabled user
    // cannot open a widget WS session. (New widget tokens can't be minted for a
    // disabled user either, since appAuthMiddleware rejects them at the BFF.)
    if (!widgetOwner || widgetOwner.status !== "active") {
      ws.close(4001, "Account is disabled or not found");
      return;
    }
    userOrgId = widgetOwner.orgId ?? DEFAULT_ORG_ID;
    // Scope the token to its minted agent (Codex review P1): a widget token
    // must only address wp.agentId, not any other agent the user owns. The
    // message handler enforces message.chatId === widgetAgentId.
    (ws as any).widgetAgentId = wp.agentId;
    // W4: bind the token's pageSessionId too — it is authoritative for the
    // per-turn audit. A client-sent pageSessionId that differs is ignored in
    // the chat handler.
    (ws as any).widgetPageSessionId = wp.pageSessionId;
    console.log(`WebSocket widget client connected (user: ${userId.slice(0, 8)}..., app: ${wsAppId.slice(0, 8)}...)`);
  } else if (urlAppId) {
    // App-scoped WS: dual-identity auth (token + appKey), single call
    const appAuth = verifyWSAppAuth(url);
    if (!appAuth) {
      ws.close(4001, "Dual authentication required (token + appKey)");
      return;
    }
    // appId consistency: URL path appId must match key-resolved appId
    if (urlAppId !== appAuth.ctx.appId) {
      ws.close(4003, "App key does not match the requested application");
      return;
    }
    userId = appAuth.userId;
    userRole = appAuth.userRole;
    wsAppId = appAuth.ctx.appId;
    userOrgId = appAuth.ctx.orgId;
    // P0.2: a path-B Runtime Token (app principal) may bind a specific agent
    // (verifyAppRuntimeToken returned widgetAgentId). Scope the socket to that
    // agent exactly like the widget-token path — the message handler enforces
    // message.chatId === widgetAgentId.
    if (appAuth.widgetAgentId) {
      (ws as any).widgetAgentId = appAuth.widgetAgentId;
    }
    console.log(`WebSocket app-scoped client connected (user: ${userId.slice(0, 8)}..., app: ${wsAppId.slice(0, 8)}...) — ${redactWsAuthQuery(req.url || "")}`);
  } else {
    // Legacy WS: token-only auth
    if (!token) {
      ws.close(4001, "Authentication required");
      return;
    }
    try {
      const payload = verifyToken(token);
      // M2 (user lifecycle): re-validate against the CURRENT DB state on every
      // connect + reconnect (this is the warm/cold-resume gate — a disabled or
      // token_version-stale user is refused here, not trusted for the session).
      const tokenCheck = verifyUserTokenCurrent(payload);
      if (!tokenCheck.ok) {
        ws.close(4001, tokenCheck.reason);
        return;
      }
      userId = payload.userId;
      userRole = payload.role === "admin" ? "admin" : "user";
      userOrgId = payload.orgId ?? DEFAULT_ORG_ID;
    } catch {
      ws.close(4001, "Invalid token");
      return;
    }
    console.log(`WebSocket client connected (user: ${userId.slice(0, 8)}...)`);
  }

  // P0-1: a user who must change password cannot open a chat session until rotated.
  if (getMustChangePassword(userId)) {
    ws.close(4003, "Password change required");
    return;
  }

  // M1 status gate (touchpoint: WS 建连 + warm/cold resume reconnect). Checks
  // the operator's org status on every connection + reconnect — this is what
  // closes the "suspended org user reconnects" window. Covers all three auth
  // branches above (legacy token / app-scoped dual-auth / widget token) since
  // userOrgId is resolved in each. admin is exempt (cross-org recovery).
  if (userRole !== "admin") {
    try {
      assertOrgActive(userOrgId);
    } catch (e) {
      if (e instanceof OrgNotActiveError) {
        ws.close(4003, e.message);
        return;
      }
      throw e;
    }
  }

  (ws as any).userId = userId;
  (ws as any).wsAppId = wsAppId;
  (ws as any).orgId = userOrgId;
  ws.isAlive = true;

  ws.send(JSON.stringify({ type: "connected", message: "Connected to chat server" }));

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    try {
      const message: IncomingWSMessage = JSON.parse(data.toString());

      // Widget-token agent scoping (Codex review P1): a widget WS is bound to
      // exactly one agent. Reject any message targeting a different agent
      // BEFORE the ownership/app checks below. Non-widget sockets have no
      // widgetAgentId and skip this guard.
      const widgetAgentId = (ws as any).widgetAgentId as string | undefined;
      const msgChatId = (message as { chatId?: string }).chatId;
      if (widgetAgentId && msgChatId && msgChatId !== widgetAgentId) {
        ws.send(JSON.stringify({ type: "error", error: "Widget token is bound to a different agent" }));
        return;
      }

      switch (message.type) {
        case "subscribe": {
          if (!chatStore.verifyChatOwnership(message.chatId, userId, userOrgId)) {
            ws.send(JSON.stringify({ type: "error", error: "Chat not found or access denied" }));
            break;
          }
          // Phase 6 (A1): app-scoped WS must verify agent belongs to this app
          if (wsAppId && !verifyAppAgentAccess(message.chatId, userId, wsAppId, userOrgId)) {
            ws.send(JSON.stringify({ type: "error", error: "Agent not found in this application" }));
            break;
          }
          const session = getOrCreateSession(message.chatId, userId, userRole, wsAppId, userOrgId);
          session.subscribe(ws);
          console.log(`Client subscribed to chat ${message.chatId}`);

          // Send existing messages. S1: getMessages already decodes persisted
          // [agent_error] rows into role:"system" + isError:true form, so a
          // refresh restores the red banner with zero client parsing.
          const messages = chatStore.getMessages(message.chatId);
          ws.send(JSON.stringify({
            type: "history",
            messages,
            chatId: message.chatId,
          }));
          break;
        }

        case "chat": {
          if (!chatStore.verifyChatOwnership(message.chatId, userId, userOrgId)) {
            ws.send(JSON.stringify({ type: "error", error: "Chat not found or access denied" }));
            break;
          }
          // Phase 6 (A1): app-scoped WS must verify agent belongs to this app
          if (wsAppId && !verifyAppAgentAccess(message.chatId, userId, wsAppId, userOrgId)) {
            ws.send(JSON.stringify({ type: "error", error: "Agent not found in this application" }));
            break;
          }
          const session = getOrCreateSession(message.chatId, userId, userRole, wsAppId, userOrgId);
          session.subscribe(ws);
          // Widget W4: bound per-turn page context. The token-bound pageSessionId
          // (set at WS auth) is authoritative; a client-sent mismatch is ignored.
          // On validation failure the context is dropped for this turn (warning
          // sent) but the typed user text still goes through (contract §4).
          const effectivePageSessionId =
            ((ws as any).widgetPageSessionId as string | undefined) ?? message.pageSessionId;
          let turnContext: TurnContext | undefined;
          if (message.pageContext != null || effectivePageSessionId) {
            const bound = boundPageContext(message.pageContext);
            if (!bound.ok) {
              ws.send(JSON.stringify({ type: "error", error: `pageContext ignored: ${bound.warning}` }));
            } else if (bound.value) {
              turnContext = { pageContext: bound.value, pageSessionId: effectivePageSessionId };
            }
          }
          session.sendMessage(message.content, turnContext);
          break;
        }

        case "approval_response": {
          if (!chatStore.verifyChatOwnership(message.chatId, userId, userOrgId)) break;
          // Phase 6 (A1): app-scoped WS must verify agent belongs to this app
          if (wsAppId && !verifyAppAgentAccess(message.chatId, userId, wsAppId, userOrgId)) {
            ws.send(JSON.stringify({ type: "error", error: "Agent not found in this application" }));
            break;
          }
          const session = sessions.get(sessionKey(userId, message.chatId));
          if (session) {
            session.handleApprovalResponse({
              id: message.id,
              approved: message.approved,
              message: message.message,
              alwaysAllow: message.alwaysAllow,
            });
          }
          break;
        }

        case "a2ui_submit": {
          if (!chatStore.verifyChatOwnership(message.chatId, userId, userOrgId)) break;
          // Phase 6 (A1): app-scoped WS must verify agent belongs to this app
          if (wsAppId && !verifyAppAgentAccess(message.chatId, userId, wsAppId, userOrgId)) {
            ws.send(JSON.stringify({ type: "error", error: "Agent not found in this application" }));
            break;
          }
          const session = sessions.get(sessionKey(userId, message.chatId));
          if (session) {
            session.handleA2UISubmit({
              blockId: message.blockId,
              actionId: message.actionId,
              actionLabel: message.actionLabel,
              values: message.values || {},
            });
          } else {
            ws.send(JSON.stringify({
              type: "error",
              error: "Session not active; send a chat message first.",
              chatId: message.chatId,
            }));
          }
          break;
        }

        case "stop": {
          if (!chatStore.verifyChatOwnership(message.chatId, userId, userOrgId)) break;
          // Phase 6 (A1): app-scoped WS must verify agent belongs to this app
          if (wsAppId && !verifyAppAgentAccess(message.chatId, userId, wsAppId, userOrgId)) {
            ws.send(JSON.stringify({ type: "error", error: "Agent not found in this application" }));
            break;
          }
          const stopKey = sessionKey(userId, message.chatId);
          const session = sessions.get(stopKey);
          if (session) {
            session.stop();
          }
          // Remove session so next message triggers fresh getOrCreateSession → cold resume
          sessions.delete(stopKey);
          // Docker mode: also stop the container (preserves volumes for cold resume)
          if (RUNTIME_MODE === "docker") {
            containerManager.stopRuntime(userId, message.chatId, "user_request").catch((err) =>
              console.error(`[server] Failed to stop Docker runtime for ${message.chatId}:`, err)
            );
          }
          // M5-S2: local-sandbox — release the sandbox + concurrency slot
          // eagerly on user-stop. Session.stop() aborts in-flight work but
          // does NOT call rt.close(); without this the sandbox stays booted
          // and the chat's slot stays held until idle/exiting the process.
          // close() is idempotent and safe to call after stop().
          if (RUNTIME_MODE === "local-sandbox" && session) {
            try { session.close(); } catch (err) {
              console.error(`[server] Failed to close local-sandbox runtime for ${message.chatId}:`, err);
            }
          }
          break;
        }

        default:
          console.warn("Unknown message type:", (message as any).type);
      }
    } catch (error) {
      // M1: surface org-status rejection verbatim instead of the generic
      // "Invalid message format" (defense-in-depth — the connect-time guard
      // already rejects non-active orgs, but getOrCreateSession re-checks on
      // the cold/new-runtime path).
      if (error instanceof OrgNotActiveError) {
        ws.send(JSON.stringify({ type: "error", error: error.message, code: "org_not_active" }));
      } else {
        console.error("Error handling WebSocket message:", error);
        ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
      }
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
    // Unsubscribe from all sessions
    for (const session of sessions.values()) {
      session.unsubscribe(ws);
    }
  });
});

// Heartbeat to detect dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    const client = ws as WSClient;
    if (client.isAlive === false) {
      return client.terminate();
    }
    client.isAlive = false;
    client.ping();
  });
}, 30000);

wss.on("close", () => {
  clearInterval(heartbeat);
});

// Start server
// P0-2: surface listen-time errors (e.g. EADDRINUSE) as a clean [FATAL] line.
server.on("error", (err: NodeJS.ErrnoException) => {
  const code = err.code ? ` [${err.code}]` : "";
  console.error(`[FATAL] Server error${code}: ${err.message}`);
  process.exit(1);
});
// Task 1 (P0.1): bind address is configurable for production (HOST=127.0.0.1
// in prod.env — only Nginx faces the outside). Default 0.0.0.0 preserves the
// historical dev behavior. No secrets in the boot log — host/port only.
const HOST = process.env.HOST || "0.0.0.0";
server.listen(Number(PORT), HOST, async () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint available at ws://${HOST}:${PORT}/ws`);
  console.log(`Visit http://localhost:${PORT} to view the chat interface`);

  // Docker mode: reconcile orphaned containers and start lifecycle loops
  if (RUNTIME_MODE === "docker") {
    await containerManager.reconcile();
    containerManager.startHealthChecks();
    containerManager.startIdleDetection();
  }

  // R5c round-3: bounded non-overlapping periodic member-sync worker. Backfill
  // any missing org→namespace mappings first, then start the worker (retries
  // pending tasks on a schedule with persisted backoff — a Hub outage →
  // recovery converges automatically WITHOUT admin replay). The worker timer
  // is unref'd (never blocks shutdown) + overlap-guarded. runMemberSyncPass is
  // also exposed via POST /api/admin/hub/member-sync/run for operator triggers.
  // Nonrollback: only mutates the task table; no-op when Hub unconfigured.
  setImmediate(() => {
    try { backfillOrgMappings(); } catch { /* best-effort, audited in helper */ }
    runMemberSyncPass().catch(() => { /* best-effort, audited via task last_error */ });
    startMemberSyncWorker();
  });

  // R5d-1: bounded non-overlapping periodic Skill sync worker. Safety no-op
  // when SKILLHUB_URL/TOKEN absent (hubConfigured gate inside the runner); Hub
  // failures are caught + classified + audited (skillhub.namespace_failed) and
  // never break chat / boot / existing skills. Shares its lock with
  // POST /api/admin/hub/sync/run. Timer is unref'd (never blocks shutdown).
  setImmediate(() => {
    startSkillSyncWorker();
  });
});

// Graceful shutdown
async function shutdownAllLocalSandbox(): Promise<void> {
  // M5-S2: close every local-sandbox session so MicroVM sandboxes are removed
  // and concurrency slots released. Session.close() is safe to call on
  // already-stopped/stopped sessions (rt.close() is idempotent, limiter
  // release is releaseOnce-guarded). Pending approval/A2UI are rejected by
  // Session.stop() which is called first, or by close() itself via the
  // Session's own cleanup path — we do not introduce a second waiter store.
  if (RUNTIME_MODE !== "local-sandbox") return;
  const toClose: Array<{ key: string; s: Session }> = [];
  for (const [key, s] of sessions) toClose.push({ key, s });
  await Promise.all(
    toClose.map(async ({ key, s }) => {
      try {
        s.stop();
        await s.close();
      } catch (err) {
        console.error(`[server] shutdown: failed to close local-sandbox session ${key}:`, err);
      }
    }),
  );
}

process.on("SIGTERM", async () => {
  console.log("[server] SIGTERM received, shutting down");
  if (RUNTIME_MODE === "docker") {
    await containerManager.shutdownAll("server_shutdown");
  } else if (RUNTIME_MODE === "local-sandbox") {
    await shutdownAllLocalSandbox();
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[server] SIGINT received, shutting down");
  if (RUNTIME_MODE === "docker") {
    await containerManager.shutdownAll("server_shutdown");
  } else if (RUNTIME_MODE === "local-sandbox") {
    await shutdownAllLocalSandbox();
  }
  process.exit(0);
});
