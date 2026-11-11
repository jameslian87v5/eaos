/**
 * widget-token.test.ts — focused tests for the platform Widget SDK token.
 *
 * Covers:
 *   - sign/verify roundtrip preserves all claims
 *   - token-type separation: a widget token cannot be replayed as a user JWT
 *     (verifyToken rejects kind:"widget")
 *   - a user JWT cannot be used as a widget token (no kind:"widget")
 *   - tampered / wrong-secret / expired tokens are rejected
 *
 * Run: npm run test:widget-token
 *
 * NOTE: auth.js imports database.js, which opens the SQLite DB at import
 * time. We point DB_PATH at a temp file before the dynamic import. Expiry is
 * exercised by setting WIDGET_TOKEN_EXPIRES_IN=1s at import time.
 */
import { existsSync, rmSync } from "fs";
import jwt from "jsonwebtoken";

// ── env must be set before importing auth.js ──────────────────────────
const DB_PATH = `/tmp/widget-token-test-${process.pid}.db`;
if (existsSync(DB_PATH)) rmSync(DB_PATH);
process.env.DB_PATH = DB_PATH;
process.env.WIDGET_TOKEN_EXPIRES_IN = "1s"; // short, for the expiry case
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

const { signWidgetToken, verifyWidgetToken, verifyToken } = await import("./auth.js");

// ── tiny test runner ──────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseInput = {
  appId: "app-xyz",
  userId: "user-1",
  role: "user" as const,
  agentId: "agent-9",
  pageSessionId: "ps_abc",
  origin: "https://biz.example.internal",
};

console.log("widget-token tests");

// 1. roundtrip
{
  const token = signWidgetToken(baseInput);
  const payload = verifyWidgetToken(token);
  ok("roundtrip returns payload", payload !== null);
  ok("kind is widget", payload?.kind === "widget");
  ok("appId preserved", payload?.appId === baseInput.appId);
  ok("userId preserved", payload?.userId === baseInput.userId);
  ok("role preserved", payload?.role === baseInput.role);
  ok("agentId preserved", payload?.agentId === baseInput.agentId);
  ok("pageSessionId preserved", payload?.pageSessionId === baseInput.pageSessionId);
  ok("origin preserved", payload?.origin === baseInput.origin);
}

// 2. token-type separation: widget token must NOT work as a user JWT
{
  const token = signWidgetToken(baseInput);
  let threw = false;
  try { verifyToken(token); } catch { threw = true; }
  ok("verifyToken rejects widget token (no privilege escalation)", threw);
}

// 3. a user JWT (no kind) must NOT verify as a widget token
{
  const userJwt = jwt.sign(
    { userId: "user-1", username: "u", role: "user" },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  ok("verifyWidgetToken rejects a user JWT", verifyWidgetToken(userJwt) === null);
}

// 4. tampered token
{
  const token = signWidgetToken(baseInput);
  const tampered = token.slice(0, -4) + (token.endsWith("A") ? "B" : "A") + token.slice(-3);
  ok("verifyWidgetToken rejects a tampered token", verifyWidgetToken(tampered) === null);
}

// 5. wrong secret
{
  const wrong = jwt.sign({ kind: "widget", ...baseInput }, "not-the-real-secret", { expiresIn: "1s" });
  ok("verifyWidgetToken rejects a wrong-secret token", verifyWidgetToken(wrong) === null);
}

// 6. expiry (WIDGET_TOKEN_EXPIRES_IN=1s at import)
{
  const token = signWidgetToken(baseInput);
  ok("fresh token verifies before expiry", verifyWidgetToken(token) !== null);
  await sleep(1200);
  ok("verifyWidgetToken rejects an expired token", verifyWidgetToken(token) === null);
}

// cleanup
rmSync(DB_PATH, { force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
