#!/usr/bin/env node
// m2a-audit-check.mjs — one-shot real-server verification that agent
// capability activation (PUT /api/agents/:agentId/capabilities) now leaves a
// metadata-only governance audit row, and that no credential ever lands in
// governance_audit_log.
//
// Run from the worktree root: node scripts/m2a-audit-check.mjs
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = Number(process.env.PORT || 3912);
const DB = "/tmp/m2a-audit-check.db";
rmSync(DB, { force: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
rmSync("/tmp/m2a-audit-check-ent.json", { force: true });

const env = {
  ...process.env, PORT: String(PORT), DB_PATH: DB, RUNTIME_MODE: "local",
  ALLOW_DEV_JWT_SECRET: "1", ENTITLEMENTS_FILE: "/tmp/m2a-audit-check-ent.json",
};
const child = spawn("npx", ["tsx", "server/server.ts"], { env, stdio: "ignore", detached: true });
child.unref();

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { const r = await fetch(base + "/"); if (r.status < 500) break; } catch {}
}

const j = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let r = await j("POST", "/api/auth/login", null, { username: "admin", password: "admin123" });
if (r.body?.mustChangePassword) {
  await j("POST", "/api/auth/change-password", r.body.token, { oldPassword: "admin123", newPassword: "m2a-audit-pw-1" });
  r = await j("POST", "/api/auth/login", null, { username: "admin", password: "m2a-audit-pw-1" });
}
const token = r.body.token;
console.log("login:", r.status, "role:", r.body.user?.role);

r = await j("POST", "/api/admin/connectors/instances", token, {
  catalogKind: "internal-rest", name: "m2a-audit-probe", baseUrl: "http://127.0.0.1:1",
});
const instanceId = r.body.instance?.id;
console.log("connector create:", r.status, Boolean(instanceId));
await j("PUT", `/api/admin/connectors/instances/${instanceId}/credentials`, token, { values: { apiToken: "m2a-audit-secret-xyz" } });
await j("POST", `/api/admin/connectors/instances/${instanceId}/enable`, token, {});
r = await j("PUT", `/api/admin/capabilities/connector:${instanceId}/entitlements`, token, {
  entries: [{ scopeType: "org", scopeId: "default-org", effect: "allow" }],
});
console.log("entitlement put:", r.status);

r = await j("POST", "/api/chats", token, { title: "m2a audit chat" });
const chatId = r.body.chat?.id ?? r.body.id;
console.log("chat create:", r.status, Boolean(chatId));
r = await j("PUT", `/api/agents/${chatId}/capabilities`, token, {
  resources: [{ resourceId: `connector:${instanceId}`, enabled: true }],
});
console.log("activation put:", r.status);

const out = execSync(
  `sqlite3 ${DB} "SELECT action, actor_role, org_id, object_id, result, reason_summary FROM governance_audit_log WHERE action IN ('agent.capabilities.update','entitlement.replace','connector.credentials.write') ORDER BY rowid"`,
  { encoding: "utf8" }
);
console.log("audit rows:\n" + out);
const all = execSync(`sqlite3 ${DB} "SELECT reason_summary FROM governance_audit_log"`, { encoding: "utf8" });
console.log("credential leaked into audit rows:", all.includes("m2a-audit-secret-xyz"));

try { process.kill(-child.pid, "SIGTERM"); } catch {}
rmSync(DB, { force: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });
rmSync("/tmp/m2a-audit-check-ent.json", { force: true });
process.exit(0);
