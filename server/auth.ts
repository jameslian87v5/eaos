import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import db from "./database.js";
import { DEFAULT_ORG_ID, type Role } from "./request-context.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const SALT_ROUNDS = 10;

// P0-1 (brand-launch): the built-in default JWT secret is weak. Running with it
// silently lets anyone forge user JWTs, so the platform must fail loudly at boot
// unless the operator either sets a real JWT_SECRET or explicitly acknowledges
// dev mode via ALLOW_DEV_JWT_SECRET=1. Values captured at module load.
const WEAK_JWT_SECRET_DEFAULT = "dev-secret-change-in-production";
const IS_DEV_JWT_SECRET_ALLOWED = process.env.ALLOW_DEV_JWT_SECRET === "1";

export function assertJwtSecret(): void {
  const usingDefault =
    !process.env.JWT_SECRET || JWT_SECRET === WEAK_JWT_SECRET_DEFAULT;
  if (usingDefault && !IS_DEV_JWT_SECRET_ALLOWED) {
    throw new Error(
      "[AUTH] FATAL: JWT_SECRET is not set (using the built-in weak default). " +
        "Set JWT_SECRET to a strong random value, or set ALLOW_DEV_JWT_SECRET=1 for local dev only."
    );
  }
  if (usingDefault && IS_DEV_JWT_SECRET_ALLOWED) {
    console.warn(
      "[AUTH] WARNING: running with the weak default JWT_SECRET (ALLOW_DEV_JWT_SECRET=1). Not safe for production."
    );
  }
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  orgId: string; // Phase 7: users.org_id (tenant key)
  status: UserStatus; // M2: active | disabled
}

export interface TokenPayload {
  userId: string;
  username: string;
  role: string;
  orgId: string; // Phase 7: baked at login from users.org_id — the trusted org source
  // M2: token version. Baked at login from users.token_version. Any disable /
  // reset / migrate bumps the DB value, so an old JWT (smaller version) fails
  // the version check at authMiddleware / WS connect. Absent on pre-M2 JWTs →
  // treated as 1 by verifyUserTokenCurrent (matches the backfilled DB default).
  tokenVersion?: number;
}

// M2 (user lifecycle): the two legal user-status values. App-layer-enforced
// (SQLite ADD COLUMN restricts CHECK; see database.ts). `active` = may auth;
// `disabled` = admin/org_admin suspended the account — all old JWTs are dead
// (status check + token_version bump) and the user must be restored + re-login.
export type UserStatus = "active" | "disabled";
export const USER_STATUSES: ReadonlySet<UserStatus> = new Set(["active", "disabled"]);

// Prepared statements
const stmts = {
  findByUsername: db.prepare(
    `SELECT id, username, password_hash, display_name, role, must_change_password, org_id AS orgId, status, token_version AS tokenVersion FROM users WHERE username = ?`
  ),
  findById: db.prepare(
    `SELECT id, username, display_name as displayName, role, org_id AS orgId, status FROM users WHERE id = ?`
  ),
  insertUser: db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, must_change_password, org_id, status, token_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  countUsers: db.prepare(`SELECT COUNT(*) as count FROM users`),
  setMustChangePassword: db.prepare(
    `UPDATE users SET must_change_password = ? WHERE id = ?`
  ),
  findAuthById: db.prepare(
    `SELECT id, password_hash, must_change_password FROM users WHERE id = ?`
  ),
  updatePassword: db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ),
  // M2: auth-state lookup for the protected-entry token check (one DB hit).
  // Returns everything authMiddleware / WS connect need to validate a JWT
  // against the CURRENT DB state (status + token_version + org + role +
  // must-change). Null when the user row is gone (deleted) → caller rejects.
  getAuthStateById: db.prepare(
    `SELECT id, status, token_version AS tokenVersion, org_id AS orgId, role, must_change_password AS mustChangePassword FROM users WHERE id = ?`
  ),
  // M2: bump token_version — invalidates all old JWTs for this user. Used by
  // disable / reset / migrate. Single UPDATE; no row count needed (caller
  // already verified the user exists).
  bumpTokenVersion: db.prepare(
    `UPDATE users SET token_version = token_version + 1 WHERE id = ?`
  ),
  // M2: set status (active|disabled). Caller validates the value (USER_STATUSES)
  // and last-admin guards before calling.
  setStatus: db.prepare(`UPDATE users SET status = ? WHERE id = ?`),
  // M2: admin password reset — new hash + force first-change + bump token
  // version in one UPDATE. The bump kills the user's existing sessions; the
  // must_change=1 gate forces a rotation on next login.
  resetPasswordByAdmin: db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?`
  ),
  // M2: cross-dept migration (admin only) — new org + bump token version. The
  // bump forces re-login so the new JWT carries the new orgId claim; the old
  // org-scoped JWT is dead.
  migrateUserOrg: db.prepare(
    `UPDATE users SET org_id = ?, token_version = token_version + 1 WHERE id = ?`
  ),
};

// Create initial admin account if no users exist
export function ensureAdminExists() {
  const { count } = stmts.countUsers.get() as { count: number };
  if (count === 0) {
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
    const hash = bcrypt.hashSync(adminPassword, SALT_ROUNDS);
    stmts.insertUser.run(
      uuidv4(),
      adminUsername,
      hash,
      "Administrator",
      "admin",
      1, // must_change_password: seeded default password must be changed on first login
      DEFAULT_ORG_ID,
      "active", // M2: status
      1, // M2: token_version
      new Date().toISOString()
    );
    console.log(`[AUTH] Created admin user: ${adminUsername}`);
  }
}

// P0-1: legacy-DB backfill. An admin created BEFORE this migration got
// must_change_password=0 from the ALTER default, so it would slip past the
// forced-first-change rule while still using the default password. Flip it to 1
// ONLY when it still matches the default admin username + the (env or built-in)
// default password — an admin who already changed password (bcrypt compare
// fails) is left alone. Idempotent and boot-safe: re-runs no-op once flipped,
// and never re-flips after a real password change.
export function markLegacyDefaultAdminForChange(): void {
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const row = stmts.findByUsername.get(adminUsername) as
    | { id: string; password_hash: string; must_change_password: number }
    | undefined;
  if (!row || row.must_change_password === 1) return;
  if (bcrypt.compareSync(adminPassword, row.password_hash)) {
    stmts.setMustChangePassword.run(1, row.id);
    console.log(
      `[AUTH] Flagged existing default admin "${adminUsername}" for first-login password change`
    );
  }
}

// ─── P0-1: password change + must-change gate (brand-launch) ──────────────
// A user with must_change_password=1 may ONLY call the endpoints below until
// they change their password. Enforced in authMiddleware (HTTP) and the WS
// connect handler. Kept in auth.ts (not server.ts) so it is unit-testable
// without booting the server.
export const MUST_CHANGE_ALLOWED_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/change-password",
]);

export function isMustChangeAllowed(path: string): boolean {
  return MUST_CHANGE_ALLOWED_PATHS.has(path);
}

export function getMustChangePassword(userId: string): boolean {
  const row = stmts.findAuthById.get(userId) as
    | { must_change_password: number }
    | undefined;
  return !!row && row.must_change_password === 1;
}

export const PASSWORD_MIN_LENGTH = 8;

// Minimal enterprise strength policy. Returns an error message, or null when OK:
// length, a letter+digit mix, not equal to the old password, and not the
// well-known default. Intentionally simple — expand later if a real policy lands.
export function validatePasswordStrength(
  newPassword: string,
  oldPassword?: string
): string | null {
  if (!newPassword || newPassword.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return "Password must contain both letters and digits";
  }
  if (oldPassword && newPassword === oldPassword) {
    return "New password must differ from the old password";
  }
  if (newPassword === "admin123") {
    return "New password must not be the default password";
  }
  return null;
}

// Verify the old password, enforce strength on the new one, then persist the
// new hash and clear must_change_password in one UPDATE. Throws on any failure.
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string
): Promise<void> {
  const row = stmts.findAuthById.get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row) {
    throw new Error("User not found");
  }
  const valid = await bcrypt.compare(oldPassword, row.password_hash);
  if (!valid) {
    throw new Error("Invalid credentials");
  }
  const strengthError = validatePasswordStrength(newPassword, oldPassword);
  if (strengthError) {
    throw new Error(strengthError);
  }
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  stmts.updatePassword.run(hash, userId);
}

export async function register(
  username: string,
  password: string,
  displayName?: string,
  orgId: string = DEFAULT_ORG_ID,
  // M2: admin/org_admin-created users get a temporary password → force
  // first-login change (design §2 "普通用户：首次登录必须改密"). The public
  // bootstrap register path keeps the default 0 (operator-chosen password).
  mustChangePassword: 0 | 1 = 0
): Promise<UserInfo> {
  const existing = stmts.findByUsername.get(username);
  if (existing) {
    throw new Error("Username already exists");
  }

  const id = uuidv4();
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  stmts.insertUser.run(
    id,
    username,
    hash,
    displayName || username,
    "user",
    mustChangePassword,
    orgId,
    "active", // M2: status
    1, // M2: token_version
    new Date().toISOString()
  );

  return { id, username, displayName: displayName || username, role: "user", orgId, status: "active" };
}

// M1 (org governance): low-level user-row insert. Exposed so the provision
// transaction (server/org-governance.ts) can create the first org_admin inside
// a synchronous better-sqlite3 transaction with a PRE-COMPUTED bcrypt hash
// (hashing must happen outside the txn — it is async). register() above is the
// public "self/admin create plain user" path; this is the governance-internal
// primitive that also takes role + must_change_password.
export function insertUserRow(args: {
  id: string;
  username: string;
  passwordHash: string;
  displayName: string;
  role: Role;
  mustChangePassword: 0 | 1;
  orgId: string;
  createdAt: string;
}): void {
  // M2: provisioned first-org_admin starts active with token_version=1.
  stmts.insertUser.run(
    args.id,
    args.username,
    args.passwordHash,
    args.displayName,
    args.role,
    args.mustChangePassword,
    args.orgId,
    "active",
    1,
    args.createdAt
  );
}

export async function login(
  username: string,
  password: string
): Promise<{ user: UserInfo; token: string; mustChangePassword: boolean }> {
  const row = stmts.findByUsername.get(username) as any;
  if (!row) {
    throw new Error("Invalid credentials");
  }

  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) {
    throw new Error("Invalid credentials");
  }

  // M2: a disabled user may not sign in (defense-in-depth — the protected-entry
  // check would also reject them, but failing at login gives a clear message
  // and never mints a JWT for a disabled account).
  if (row.status && row.status !== "active") {
    throw new Error("Account is disabled");
  }

  const user: UserInfo = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    orgId: row.orgId ?? DEFAULT_ORG_ID,
    status: (row.status as UserStatus) ?? "active",
  };

  // M2: bake the current token_version into the JWT. disable / reset / migrate
  // bump the DB value, so this JWT fails the version check at protected entries.
  const tokenVersion = row.tokenVersion ?? 1;

  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role, orgId: user.orgId, tokenVersion } as TokenPayload,
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions
  );

  return { user, token, mustChangePassword: !!row.must_change_password };
}

export function verifyToken(token: string): TokenPayload {
  const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
  // Token-type separation: a widget token (kind:"widget") is browser-held,
  // short-lived, and scoped to one agent. It must NEVER be accepted as a
  // full user-session JWT — doing so would let a leaked widget token act as
  // a 7-day full-access credential. Widget tokens authenticate only via
  // verifyWidgetToken() at the widget WS path.
  if ((payload as Record<string, unknown>).kind === "widget") {
    throw new Error("Widget token cannot be used as a user token");
  }
  return payload as unknown as TokenPayload;
}

// ─── Widget token (Phase 6 — platform Widget SDK) ────────────
// Short-lived browser token for the embeddable iframe widget. The browser
// receives ONLY this token; the AppKey never reaches the browser (the
// application's BFF mints it at POST /api/apps/:appId/widget-tokens using
// its AppKey + a user/service JWT). On WS connect it resolves into the
// SAME {appId, userId, role} principal the app-scoped path produces, so the
// downstream message handler is unchanged — no third auth branch.
export interface WidgetTokenPayload {
  kind: "widget";
  appId: string;
  userId: string;
  role: "admin" | "user";
  agentId?: string;
  pageSessionId: string;
  origin?: string;
  // P0.2 (Agent OS §4): execution-identity decoupling. When principalType ===
  // "app", `userId`/`principalId` is the OPAQUE app_principals.id (not a
  // platform users.id) and the token carries NO raw subject — the server
  // resolves the subject via resolvePrincipal when needed for audit. The field
  // defaults to "platform" so legacy widget tokens (minted from appAuthMiddleware
  // + a platform user JWT) parse unchanged and keep their existing platform-user
  // semantics at the WS boundary.
  principalType?: "platform" | "app";
  principalId?: string; // explicit opaque id; for the app path == app_principals.id
  // P0.2 (codex review gap 2): the AppKey prefix that minted this token. The
  // prefix is non-secret (it is the applications.api_key_prefix lookup key) but
  // it CHANGES on key rotation, so binding + re-checking it invalidates runtime
  // tokens minted under a rotated-away key. Absent on pre-fix tokens → treated
  // as "no prefix bound" (fail-open only for legacy, which path B never mints).
  apiKeyPrefix?: string;
}

const WIDGET_TOKEN_EXPIRES_IN = process.env.WIDGET_TOKEN_EXPIRES_IN || "30m";
// P0.2: app-scoped Runtime Token (external app subject) shares the widget token
// shape but may carry a separate lifetime. Kept short — these are operator
// credentials handed to an app backend / browser, never long-lived sessions.
const RUNTIME_TOKEN_EXPIRES_IN = process.env.RUNTIME_TOKEN_EXPIRES_IN || "30m";

export function signWidgetToken(input: Omit<WidgetTokenPayload, "kind">): string {
  return jwt.sign(
    { kind: "widget", ...input } as WidgetTokenPayload,
    JWT_SECRET,
    { expiresIn: WIDGET_TOKEN_EXPIRES_IN } as jwt.SignOptions
  );
}

export function verifyWidgetToken(token: string): WidgetTokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    if ((payload as Record<string, unknown>).kind !== "widget") return null;
    return payload as unknown as WidgetTokenPayload;
  } catch {
    return null;
  }
}

// ─── P0.2: app-scoped Runtime Token (Agent OS §4) ────────────
// The application's BFF mints this at POST /api/apps/:appId/runtime-tokens
// using ONLY its AppKey + an opaque subject (no platform user JWT required).
// The returned token is a `kind:"widget"` token with `principalType:"app"`: it
// flows through the SAME widget token verify path, but the WS boundary reads
// `principalId` (an app_principals.id) instead of a platform users.id. The raw
// subject is NEVER embedded — the server resolves it via resolvePrincipal for
// audit. Callers MUST pass the principalId returned by getOrCreateAppPrincipal
// (which cross-checks the trusted app org).
export interface RuntimeTokenInput {
  appId: string;
  principalId: string; // app_principals.id (opaque data-plane key)
  agentId?: string;
  pageSessionId: string;
  origin?: string;
  apiKeyPrefix?: string; // P0.2 gap 2: bind the minting AppKey prefix for rotation-revoke
}

export function signRuntimeToken(input: RuntimeTokenInput): string {
  return jwt.sign(
    {
      kind: "widget",
      appId: input.appId,
      // The data plane keys on `userId`; for an app principal the opaque
      // principalId IS that key. Set both so legacy WS code that reads
      // wp.userId gets the principalId without a new branch.
      userId: input.principalId,
      role: "user" as const, // app principals carry no platform role
      agentId: input.agentId,
      pageSessionId: input.pageSessionId,
      origin: input.origin,
      principalType: "app" as const,
      principalId: input.principalId,
      apiKeyPrefix: input.apiKeyPrefix,
    } as WidgetTokenPayload,
    JWT_SECRET,
    { expiresIn: RUNTIME_TOKEN_EXPIRES_IN } as jwt.SignOptions
  );
}

export const RUNTIME_TOKEN_TTL_SECONDS = 1800;

export function getUserById(id: string): UserInfo | undefined {
  return stmts.findById.get(id) as UserInfo | undefined;
}

export function listAllUsers(): Array<UserInfo & { createdAt: string }> {
  return db.prepare(
    `SELECT id, username, display_name as displayName, role, org_id AS orgId, status, created_at as createdAt FROM users ORDER BY created_at ASC`
  ).all() as Array<UserInfo & { createdAt: string }>;
}

// M3: org-scoped user listing for the department-detail view. Same shape as
// listAllUsers but filtered server-side by org_id — the org_admin detail view
// never receives users outside its own dept (and admin gets any dept's users).
export function listUsersInOrg(orgId: string): Array<UserInfo & { createdAt: string }> {
  return db.prepare(
    `SELECT id, username, display_name as displayName, role, org_id AS orgId, status, created_at as createdAt FROM users WHERE org_id = ? ORDER BY created_at ASC`
  ).all(orgId) as Array<UserInfo & { createdAt: string }>;
}

export function updateUserRole(id: string, role: Role): void {
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
}

// M2 fix (review evt_20260811085308): atomic role change + token_version
// bump in ONE SQL UPDATE. Replaces the two-step updateUserRole() +
// bumpUserTokenVersion() so there is no window — however small — where the
// role is already changed but the old token_version still validates the prior
// role's JWT. better-sqlite3 runs each prepared statement as a single atomic
// transaction, so this UPDATE either commits both columns or neither. The
// net effect on token_version is +1 (exactly once), so a demoted admin's old
// JWT fails verifyUserTokenCurrent on the very next REST/WS entry.
export function updateUserRoleAndBumpTokenVersion(id: string, role: Role): void {
  db.prepare(`UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?`).run(role, id);
}

export function deleteUser(id: string): boolean {
  const result = db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  return result.changes > 0;
}

// M2 fix (review evt_20260811084601): last-admin protection counts ACTIVE
// admins only. A disabled admin (status='disabled') no longer counts, which
// closes the lockout sequence "A disables B, then A self-demotes": after B is
// disabled, countAdmins() returns 1 (A), so A's self-demote is refused by the
// `<= 1` guard in PATCH/DELETE. Without the status filter, the disabled B would
// inflate the count and let A demote itself → 0 active admins → lockout.
export function countAdmins(): number {
  return (
    db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND status = 'active'`).get() as { count: number }
  ).count;
}

/** Phase 7.2: resolve a user's org_id (trusted source) by id. */
export function getUserOrgId(id: string): string | undefined {
  const row = db.prepare(`SELECT org_id AS orgId FROM users WHERE id = ?`).get(id) as { orgId: string } | undefined;
  return row?.orgId;
}

// ─── M2 (user lifecycle): auth-state + token-version primitives ──────────
// These are the "or equivalent minimal mechanism" the M2 design calls for:
// every protected entry (authMiddleware, WS connect, app-scoped WS, widget WS)
// re-validates the JWT against the CURRENT DB state, so disable / reset /
// migrate take effect on the very next request — not just the next login.

export interface UserAuthState {
  status: UserStatus;
  tokenVersion: number;
  orgId: string;
  role: Role;
  mustChangePassword: boolean;
}

/**
 * Read the current auth-relevant state of a user (one DB hit). Returns null
 * when the user row is gone (deleted) — callers treat that as "reject the
 * token". This is the single source of truth the protected-entry check uses.
 */
export function getUserAuthState(userId: string): UserAuthState | null {
  const row = stmts.getAuthStateById.get(userId) as
    | { status: string; tokenVersion: number; orgId: string; role: string; mustChangePassword: number }
    | undefined;
  if (!row) return null;
  const role: Role = row.role === "admin" ? "admin" : row.role === "org_admin" ? "org_admin" : "user";
  return {
    status: (row.status === "disabled" ? "disabled" : "active") as UserStatus,
    tokenVersion: row.tokenVersion ?? 1,
    orgId: row.orgId ?? DEFAULT_ORG_ID,
    role,
    mustChangePassword: !!row.mustChangePassword,
  };
}

/**
 * The cross-cutting M2 token-validity check. Verifies the JWT payload against
 * the CURRENT DB state: user must exist, be `active`, carry the matching
 * token_version, and (defense-in-depth against stale org claim after migrate)
 * the JWT's orgId must equal the DB org_id. Returns ok=true or a {code,reason}
 * denial. Callers: authMiddleware (REST), WS connect (legacy + app-scoped).
 * Widget tokens carry no tokenVersion (they are short-lived, browser-held and
 * scoped to one agent) — the widget path uses a status-only check instead.
 */
export function verifyUserTokenCurrent(payload: {
  userId: string;
  tokenVersion?: number;
  orgId?: string;
}): { ok: true } | { ok: false; code: string; reason: string } {
  const st = getUserAuthState(payload.userId);
  if (!st) return { ok: false, code: "token_user_not_found", reason: "User not found" };
  if (st.status !== "active") return { ok: false, code: "token_user_disabled", reason: "Account is disabled" };
  // A pre-M2 JWT has no tokenVersion claim — treat as 1 (the backfilled DB
  // default). After disable/reset/migrate bumps the DB value, this check
  // diverges and the JWT is rejected, forcing re-login.
  const jwtTv = payload.tokenVersion ?? 1;
  if (jwtTv !== st.tokenVersion) return { ok: false, code: "token_version_mismatch", reason: "Token invalidated" };
  // Stale-org check: after a migrate the DB org_id changed; an old JWT still
  // carries the previous org claim. Reject so the user re-authenticates and
  // picks up the new org (token_version bump already covers this, but the
  // explicit check makes the invariant "don't trust old org claim" direct).
  if (payload.orgId && payload.orgId !== st.orgId) return { ok: false, code: "token_org_mismatch", reason: "Organization changed" };
  return { ok: true };
}

/** M2: invalidate all outstanding JWTs for a user (disable / reset / migrate). */
export function bumpUserTokenVersion(userId: string): void {
  stmts.bumpTokenVersion.run(userId);
}

/**
 * M2: set a user's status (active|disabled). Caller validates the value and
 * runs the last-active-org_admin guard BEFORE calling. Does NOT bump
 * token_version (the status check itself rejects disabled users); the bump is
 * the caller's job when it also needs to kill currently-valid tokens of an
 * active user being disabled (so the disabled user's old JWTs die at the
 * version check too, not only the status check).
 */
export function setUserStatus(userId: string, status: UserStatus): void {
  stmts.setStatus.run(status, userId);
}

/**
 * M2: admin password reset — new hash (pre-computed outside any txn), force
 * first-login change, and bump token_version in one UPDATE. The bump kills the
 * user's existing sessions immediately. Caller hashes the new password and
 * validates strength + checkUserMutation before calling.
 */
export function resetPasswordByAdmin(userId: string, newPasswordHash: string): void {
  stmts.resetPasswordByAdmin.run(newPasswordHash, userId);
}

/**
 * M2: cross-dept migration (admin only) — new org + bump token_version. The
 * bump forces re-login so the new JWT carries the new orgId; the old
 * org-scoped JWT is dead. Caller verifies the target org exists + is active,
 * runs the source-org last-org_admin guard (if migrating an org_admin out),
 * and that the actor is admin.
 */
export function migrateUserOrg(userId: string, newOrgId: string): void {
  stmts.migrateUserOrg.run(newOrgId, userId);
}

/**
 * M2: admin/org_admin password reset (high-level). Validates strength on the
 * new plaintext password, hashes it, then hands off to resetPasswordByAdmin
 * (which sets must_change=1 + bumps token_version in one UPDATE). Throws an
 * Error with a user-facing message on weakness. Caller is responsible for the
 * checkUserMutation privilege guard (org_admin cannot reset a privileged
 * account) before calling.
 */
export async function adminResetPassword(userId: string, newPassword: string): Promise<void> {
  const strengthErr = validatePasswordStrength(newPassword);
  if (strengthErr) throw new Error(strengthErr);
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  resetPasswordByAdmin(userId, hash);
}
