/**
 * app-auth.ts — Phase 6 (A1) dual-identity authentication middleware.
 *
 * Two independent principals:
 *   1. App principal  — REST: X-App-Key header; WS: ?appKey= query param
 *   2. User principal — REST: Authorization: Bearer; WS: ?token= query param
 *
 * Both MUST be present and valid. Neither can substitute for the other.
 * The app key resolves to an appId (via applicationService.verifyAppKey);
 * this appId is checked against the URL :appId for consistency.
 *
 * Codex review decisions:
 *   - appId equality check in middleware (proves caller owns the app key)
 *   - handler re-checks agents.app_id (proves resource belongs to that app)
 *   - WS ?appKey= is MVP debt — redact in logs, document as temporary
 *
 * See docs/02-architecture/platform-application-layer-architecture.md
 */

import type { Request, Response, NextFunction } from "express";
import { verifyToken, verifyUserTokenCurrent, verifyWidgetToken, type WidgetTokenPayload } from "./auth.js";
import { applicationService } from "./application-service.js";
import { applicationAccessGrantsService } from "./application-access.js";
import { resolvePrincipal } from "./app-principal.js";
import { DEFAULT_ORG_ID, type RequestContext } from "./request-context.js";

// ─── Types ───────────────────────────────────────────────────

/**
 * Extended RequestContext with the DB-verified appId from app key.
 * The appId comes from verifyAppKey (not from URL params), so it is
 * authoritative — callers can trust it without re-checking.
 */
export interface AppRequestContext extends RequestContext {
  appId: string;
}

// ─── REST middleware ─────────────────────────────────────────

/**
 * Dual-identity auth middleware for app-scoped REST routes.
 * Extracts Authorization: Bearer (required) + optional X-App-Key, validates,
 * checks appId consistency with URL :appId.
 *
 * Three operator-principal paths:
 *   A. S2S  appKey + platform user JWT  — principalType platform (AppKey required)
 *   B1. S2S appKey + Runtime Token       — principalType app (AppKey required)
 *   B2. Token-only Runtime Token         — principalType app, NO AppKey (browser)
 * B2 is the M1 browser boundary: the Runtime Token alone proves the Application
 * (re-read by appId) + the principal; the browser never holds an AppKey.
 *
 * Sets req.appId (from token/key, not URL), req.userId (opaque principalId on
 * B1/B2), req.userRole, req.orgId. On path B with a bound agent, req.widgetAgentId.
 */
export function appAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Operator token required (Authorization: Bearer)" });
    return;
  }
  const bearer = authHeader.slice(7);
  const appKey = req.headers["x-app-key"] as string | undefined;
  const urlAppId = req.params.appId;

  // Disambiguate the operator principal: platform user JWT (verifyToken) vs app
  // Runtime Token (verifyWidgetToken). verifyToken refuses widget tokens, so a
  // path-B token surfaces as a throw → fall through to the widget verify path.
  let platformPayload: { userId: string; role: string; orgId?: string; tokenVersion?: number } | null = null;
  let appToken: WidgetTokenPayload | null = null;
  try {
    platformPayload = verifyToken(bearer);
  } catch {
    appToken = verifyWidgetToken(bearer);
  }

  if (platformPayload) {
    // ─── Path A: S2S appKey + platform user JWT (AppKey required) ───
    if (!appKey) {
      res.status(401).json({ error: "App key required (X-App-Key header)" });
      return;
    }
    const keyApp = applicationService.verifyAppKeyWithOrg(appKey);
    if (!keyApp) {
      res.status(401).json({ error: "Invalid or disabled app key" });
      return;
    }
    if (urlAppId && urlAppId !== keyApp.appId) {
      res.status(403).json({ error: "App key does not match the requested application" });
      return;
    }
    const userId = platformPayload.userId;
    const userRole: "admin" | "user" = platformPayload.role === "admin" ? "admin" : "user";
    const orgId = platformPayload.orgId ?? DEFAULT_ORG_ID;
    if (keyApp.orgId !== orgId) {
      res.status(403).json({ error: "App key does not belong to the user's organization" });
      return;
    }
    const tokenCheck = verifyUserTokenCurrent({ userId, tokenVersion: platformPayload.tokenVersion, orgId });
    if (!tokenCheck.ok) {
      res.status(401).json({ error: tokenCheck.reason, code: tokenCheck.code });
      return;
    }
    // Agent OS M2: EVERY app-scoped platform-JWT principal (incl. admin) needs
    // an application_access_grant to enter an Application. Deny by default (no
    // grant → 403). Admin recovery belongs on /api/admin/*, not the Application
    // execution path — so admin is NOT exempt here (codex review r1 #1). This
    // gate is path-A ONLY: path B (app-principal Runtime Token) is authorized
    // by the signed token and never creates a platform user grant.
    if (!applicationAccessGrantsService.hasAccess(keyApp.appId, userId, orgId)) {
      res.status(403).json({ error: "No application access grant for this principal", code: "NO_ACCESS_GRANT" });
      return;
    }
    (req as any).userId = userId;
    (req as any).userRole = userRole;
    (req as any).orgId = orgId;
    (req as any).appId = keyApp.appId;
    next();
    return;
  }

  if (appToken && appToken.principalType === "app") {
    // ─── Path B: app-scoped Runtime Token ────────────────────────
    let r: { userId: string; role: "admin" | "user"; orgId: string; appId: string; widgetAgentId?: string } | null;
    if (appKey) {
      // B1 S2S: verify the app key, then reuse the shared deny-default chain.
      const keyApp = applicationService.verifyAppKeyWithOrg(appKey);
      if (!keyApp) {
        res.status(401).json({ error: "Invalid or disabled app key" });
        return;
      }
      if (urlAppId && urlAppId !== keyApp.appId) {
        res.status(403).json({ error: "App key does not match the requested application" });
        return;
      }
      r = validateRuntimeTokenPayload(appToken, keyApp, appKey.slice(0, 16));
    } else {
      // B2 Token-only: the token proves app + principal; no plaintext AppKey.
      r = validateRuntimeTokenTokenOnly(appToken, urlAppId);
    }
    if (!r) {
      res.status(401).json({ error: "Invalid or expired runtime token" });
      return;
    }
    (req as any).userId = r.userId; // opaque principalId
    (req as any).userRole = r.role;
    (req as any).orgId = r.orgId;
    (req as any).appId = r.appId;
    if (r.widgetAgentId) (req as any).widgetAgentId = r.widgetAgentId;
    next();
    return;
  }

  res.status(401).json({ error: "Invalid or expired operator token" });
}

/**
 * P0.2 (Agent OS §4): app-key-only auth middleware for the Runtime Token mint
 * endpoint (POST /api/apps/:appId/runtime-tokens). The application's BFF calls
 * this route with its AppKey + an opaque subject — NO platform user JWT. The
 * AppKey alone proves the application principal; the subject (resolved via
 * getOrCreateAppPrincipal inside the handler) is the operator principal.
 *
 * Sets req.keyApp = {appId, orgId} (the DB-verified app identity) and
 * req.appId. The handler is the single place that translates appKey+subject
 * into a signed Runtime Token; it never trusts a client-supplied orgId.
 */
export function appKeyOnlyAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const appKey = req.headers["x-app-key"] as string | undefined;
  if (!appKey) {
    res.status(401).json({ error: "App key required (X-App-Key header)" });
    return;
  }
  const keyApp = applicationService.verifyAppKeyWithOrg(appKey);
  if (!keyApp) {
    res.status(401).json({ error: "Invalid or disabled app key" });
    return;
  }
  const urlAppId = req.params.appId;
  if (urlAppId && urlAppId !== keyApp.appId) {
    res.status(403).json({ error: "App key does not match the requested application" });
    return;
  }
  (req as any).keyApp = keyApp;
  (req as any).appId = keyApp.appId;
  next();
}

/**
 * Build an AppRequestContext from an authed Express request.
 * appId comes from the middleware (verifyAppKey result), not from URL.
 */
export function appCtxFromReq(req: Request): AppRequestContext {
  return {
    userId: (req as any).userId,
    role: (req as any).userRole === "admin" ? "admin" : "user",
    orgId: (req as any).orgId ?? DEFAULT_ORG_ID,
    appId: (req as any).appId,
  };
}

// ─── WS auth helper ──────────────────────────────────────────

/**
 * Auth for WebSocket connections. Extracts ?token= (required) + optional
 * ?appKey=, validates, and returns the resolved principal.
 *
 * Three operator-principal paths (matching appAuthMiddleware):
 *   A.  S2S  appKey + platform user JWT
 *   B1. S2S  appKey + Runtime Token
 *   B2. Token-only Runtime Token (no appKey) — the M1 browser boundary.
 *
 * WS ?appKey= (when present) is MVP debt — callers MUST redact it from logs.
 * The Token-only path carries NO appKey in the URL, so browser-facing WS URLs
 * contain no AppKey.
 *
 * @returns AppRequestContext + userId (opaque data-plane key) if valid, else
 *   null (caller closes WS with 4001). `widgetAgentId` is set when a path-B
 *   token binds a specific agent (the message handler enforces
 *   message.chatId === widgetAgentId).
 */
export function verifyWSAppAuth(
  url: URL
): { ctx: AppRequestContext; userId: string; userRole: "admin" | "user"; widgetAgentId?: string } | null {
  const token = url.searchParams.get("token");
  if (!token) return null;
  const appKey = url.searchParams.get("appKey");
  const urlAppId = extractAppIdFromWsPath(url.pathname);

  // Disambiguate the operator principal: platform user JWT vs app Runtime
  // Token. verifyToken refuses widget tokens → a path-B token throws and
  // falls through to the widget verify path.
  let platformPayload: { userId: string; role: string; orgId?: string; tokenVersion?: number } | null = null;
  let appToken: WidgetTokenPayload | null = null;
  try {
    platformPayload = verifyToken(token);
  } catch {
    appToken = verifyWidgetToken(token);
  }

  if (platformPayload) {
    // ─── Path A: S2S appKey + platform user JWT (AppKey required) ───
    if (!appKey) return null;
    const keyApp = applicationService.verifyAppKeyWithOrg(appKey);
    if (!keyApp) return null;
    const userId = platformPayload.userId;
    const userRole: "admin" | "user" = platformPayload.role === "admin" ? "admin" : "user";
    const orgId = platformPayload.orgId ?? DEFAULT_ORG_ID;
    if (keyApp.orgId !== orgId) return null;
    const tokenCheck = verifyUserTokenCurrent({ userId, tokenVersion: platformPayload.tokenVersion, orgId });
    if (!tokenCheck.ok) return null;
    // Agent OS M2: platform-JWT app-scoped WS needs an access grant too
    // (same gate as REST path A; admin NOT exempt — codex review r1 #1).
    // Path B (app-principal Runtime Token) untouched.
    if (!applicationAccessGrantsService.hasAccess(keyApp.appId, userId, orgId)) {
      return null;
    }
    return {
      ctx: { userId, role: userRole, orgId, appId: keyApp.appId },
      userId,
      userRole,
    };
  }

  if (appToken && appToken.principalType === "app") {
    // ─── Path B: app-scoped Runtime Token ────────────────────────
    let r: { userId: string; role: "admin" | "user"; orgId: string; appId: string; widgetAgentId?: string } | null;
    if (appKey) {
      // B1 S2S: verify the app key, then reuse the shared deny-default chain.
      const keyApp = applicationService.verifyAppKeyWithOrg(appKey);
      if (!keyApp) return null;
      r = validateRuntimeTokenPayload(appToken, keyApp, appKey.slice(0, 16));
    } else {
      // B2 Token-only: the token proves app + principal; no plaintext AppKey.
      // Route appId consistency is enforced inside validateRuntimeTokenTokenOnly.
      r = validateRuntimeTokenTokenOnly(appToken, urlAppId ?? undefined);
    }
    if (!r) return null;
    return {
      ctx: { userId: r.userId, role: r.role, orgId: r.orgId, appId: r.appId },
      userId: r.userId,
      userRole: r.role,
      widgetAgentId: r.widgetAgentId,
    };
  }

  return null;
}

/**
 * P0.2 path-B core validation: a `kind:"widget" principalType:"app"` token
 * bound to an opaque app subject. Shared by the WS path (verifyWSAppAuth) and
 * the REST path (appAuthMiddleware) so the deny-default chain is identical
 * everywhere a Runtime Token is accepted.
 *
 * Every step must pass; an unknown / disabled / mis-scoped principal is
 * rejected (never misread as a platform user). On success the returned
 * `userId` is the opaque principalId the data plane keys on; no getUserById.
 *
 * Steps:
 *  1. AppKey already verified by the caller (status / prefix / hash / active).
 *  2. Scope: token.appId === keyApp.appId (cross-app claim reject).
 *  3. exp: already enforced by verifyWidgetToken (jwt.verify).
 *  4. Principal status: resolvePrincipal(principalId) must be an ACTIVE app
 *     principal (unknown → null → reject; disabled → reject). ALSO
 *     principal.appId === keyApp.appId (gap 1): the token's principalId must
 *     actually belong to this app — without this a same-org token could LIE
 *     about its appId claim while carrying another app's principalId (cross-app
 *     subject swap within one org).
 *  5. Agent binding: if the token binds an agentId, it must belong to this app
 *     (getAppIdForAgent === appId). Owner_user_id === principalId is enforced
 *     later (WS: verifyAppAgentAccess; REST: the handler's owner filter).
 *  6. org consistency: principal.orgId (sourced from the verified app at mint)
 *     must equal the current key-resolved org (guards org drift / forgery).
 *  7. AppKey prefix bind (gap 2): token.apiKeyPrefix must equal the presented
 *     key's prefix (strict — absent on an app token = forged/legacy → reject).
 *     Rejects runtime tokens minted under a rotated-away AppKey.
 */
export function validateRuntimeTokenPayload(
  wp: WidgetTokenPayload,
  keyApp: { appId: string; orgId: string },
  presentedPrefix: string
): { userId: string; role: "admin" | "user"; orgId: string; appId: string; widgetAgentId?: string } | null {
  // 2. Scope (token claim).
  if (wp.appId !== keyApp.appId) return null;

  // 4. Principal status + (gap 1) the principal actually belongs to this app.
  const principalId = wp.principalId ?? wp.userId;
  const principal = resolvePrincipal(principalId);
  if (!principal || principal.kind !== "app") return null;
  if (principal.status !== "active") return null;
  if (principal.appId !== keyApp.appId) return null; // gap 1: cross-app principalId swap

  // 6. org consistency.
  if (principal.orgId !== keyApp.orgId) return null;

  // 5. Agent binding.
  let widgetAgentId: string | undefined;
  if (wp.agentId) {
    if (applicationService.getAppIdForAgent(wp.agentId) !== keyApp.appId) return null;
    widgetAgentId = wp.agentId;
  }

  // 7. AppKey prefix bind (gap 2). Strict: an app token always carries a
  // bound prefix (minted by this platform); absent = forged/legacy → reject.
  if (!wp.apiKeyPrefix || wp.apiKeyPrefix !== presentedPrefix) return null;

  return {
    userId: principalId, // opaque; downstream keys on it like a platform userId
    role: wp.role === "admin" ? "admin" : "user",
    orgId: principal.orgId,
    appId: keyApp.appId,
    widgetAgentId,
  };
}

/**
 * M1 (Agent OS §5): Token-only validation — the Runtime Token proves BOTH the
 * Application and the execution principal, so the browser path needs NO
 * plaintext AppKey. The Application is re-read from the DB by `wp.appId`
 * (applicationService.getApplication), and the token's bound `apiKeyPrefix` is
 * compared against the Application's CURRENT `api_key_prefix`. Key rotation
 * overwrites that column, so tokens minted under a rotated-away key are
 * rejected — without the server ever seeing the AppKey.
 *
 * Same deny-default shape as the S2S path (validateRuntimeTokenPayload); the
 * only difference is the trusted source of {appId, orgId, prefix}: here it is
 * the current Application record (looked up by appId), there it is the
 * verified AppKey. `urlAppId` (when known) enforces route consistency — a token
 * for app X cannot be used on a URL scoped to app Y.
 *
 * Steps:
 *  1. Route consistency: wp.appId === urlAppId (when the caller passes it).
 *  2. Application exists + active (disabled app → reject).
 *  3. Credential prefix bind (strict): wp.apiKeyPrefix === app.apiKeyPrefix.
 *  4. exp: already enforced by verifyWidgetToken (jwt.verify).
 *  5. Principal active + kind app + principal.appId === wp.appId (gap 1).
 *  6. org consistency: principal.orgId === app.orgId.
 *  7. Agent binding (optional): getAppIdForAgent === wp.appId.
 */
export function validateRuntimeTokenTokenOnly(
  wp: WidgetTokenPayload,
  urlAppId?: string
): { userId: string; role: "admin" | "user"; orgId: string; appId: string; widgetAgentId?: string } | null {
  // 1. Route consistency.
  if (urlAppId && wp.appId !== urlAppId) return null;

  // 2. Re-read the current Application record by appId (no plaintext key).
  const app = applicationService.getApplication(wp.appId);
  if (!app || app.status !== "active") return null;

  // 3. Credential prefix bind (strict). An app token minted by this platform
  // always carries apiKeyPrefix; absent = forged/legacy → reject. A mismatch
  // means the token was minted under a rotated-away AppKey → reject.
  const currentPrefix = app.apiKeyPrefix;
  if (!wp.apiKeyPrefix || !currentPrefix || wp.apiKeyPrefix !== currentPrefix) return null;

  // 5. Principal status + (gap 1) the principal actually belongs to this app.
  const principalId = wp.principalId ?? wp.userId;
  const principal = resolvePrincipal(principalId);
  if (!principal || principal.kind !== "app") return null;
  if (principal.status !== "active") return null;
  if (principal.appId !== wp.appId) return null;

  // 6. org consistency (principal.orgId was sourced from the verified app at
  // mint; re-check against the current Application record).
  if (principal.orgId !== app.orgId) return null;

  // 7. Agent binding.
  let widgetAgentId: string | undefined;
  if (wp.agentId) {
    if (applicationService.getAppIdForAgent(wp.agentId) !== wp.appId) return null;
    widgetAgentId = wp.agentId;
  }

  return {
    userId: principalId,
    role: wp.role === "admin" ? "admin" : "user",
    orgId: principal.orgId,
    appId: wp.appId,
    widgetAgentId,
  };
}

/** Extract the appId from a WS path `/api/apps/:appId/ws` (or null). */
function extractAppIdFromWsPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/apps\/([^/]+)\/ws$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Redact every credential-bearing query param from a WS connection URL before
 * it touches a log line. The app-scoped WS URL carries `token` (a platform
 * Runtime Token or User JWT) and optionally `appKey`; the widget path carries
 * `widgetToken`. None of these values may ever appear in logs — mask them all
 * regardless of order, and never echo the raw query back.
 */
export function redactWsAuthQuery(urlStr: string): string {
  return urlStr.replace(/([?&])(token|appKey|widgetToken)=[^&]*/gi, "$1$2=REDACTED");
}
