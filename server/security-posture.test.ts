// Octop absorption M6b — unified security posture center tests.
//
// Coverage (plan Task 1):
//   - GET posture (service + route): six fixed sections with truthful
//     enforced/configurable/partial/not_implemented statuses;
//   - admin sees all DB profiles + read-only platformDefault; org_admin sees
//     own-org profiles ONLY (cross-org profile never in posture; query/body
//     orgId forging ignored — ctx is the only authority);
//   - user role gets 403 (route) / forbidden (service);
//   - tool tri-state derivation: approval = tools − allowedTools −
//     disallowedTools; platform default read-only;
//   - commandProtection reflects the REAL difference: local Bash hard-deny,
//     docker Bash profile-dependent; riskyProfiles only lists editable
//     profiles whose effective allowedTools includes Bash;
//   - skillScan aggregates the M3 registry (counts + supply-chain manifest
//     fields) — no filesystem scanning, no paths in output;
//   - sensitiveInfo declares existing coverage truthfully and marks chat
//     content DLP not_implemented;
//   - response JSON contains no host absolute paths / secrets / payloads;
//   - PATCH profile tools: the ONE narrow write — success writes
//     metadata-only governance audit; cross-org / platform default / extra
//     body fields / invalid tri-state all rejected with ZERO partial write.
//
// Run: DB_PATH=/tmp/m6b-security.db ENTITLEMENTS_FILE=/tmp/m6b-entitlements.json AGENT_CAPABILITIES_FILE=/tmp/m6b-agent-capabilities.json npx tsx server/security-posture.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import express from "express";

const DB_PATH = process.env.DB_PATH ?? "/tmp/m6b-security.db";
const ENT_FILE = process.env.ENTITLEMENTS_FILE ?? "/tmp/m6b-entitlements.json";
const ACT_FILE = process.env.AGENT_CAPABILITIES_FILE ?? "/tmp/m6b-agent-capabilities.json";
for (const f of [DB_PATH, ENT_FILE, ACT_FILE]) {
  try { rmSync(f, { recursive: true, force: true }); } catch {}
}
mkdirSync("/tmp", { recursive: true });
writeFileSync(ENT_FILE, JSON.stringify({ version: 1, entries: [] }, null, 2));

const db = (await import("./database.js")).default;
const { agentProfileStore } = await import("./agent-profile-store.js");
const { getAllSkills } = await import("./skill-config.js");
const {
  buildSecurityPosture,
  updateProfileTools,
  SecurityPostureError,
} = await import("./security-posture.js");
const { createSecurityPostureRoutes } = await import("./security-posture-routes.js");
import type { RequestContext } from "./request-context.js";
const { DEFAULT_ORG_ID } = await import("./request-context.js");

const ORG = DEFAULT_ORG_ID;
const ORG_B = "m6b-org-b";
const ADMIN = "m6b-admin";
const ORG_ADMIN = "m6b-orgadmin";
const ORG_ADMIN_B = "m6b-orgadmin-b";
const USER = "m6b-user";

for (const [id, role, org] of [
  [ADMIN, "admin", ORG],
  [ORG_ADMIN, "org_admin", ORG],
  [ORG_ADMIN_B, "org_admin", ORG_B],
  [USER, "user", ORG],
] as const) {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, org_id, status) VALUES (?, ?, 'x', ?, ?, 'active')`
  ).run(id, id, role, org);
}

const adminCtx: RequestContext = { userId: ADMIN, role: "admin", orgId: ORG };
const orgAdminCtx: RequestContext = { userId: ORG_ADMIN, role: "org_admin", orgId: ORG };
const orgAdminBCtx: RequestContext = { userId: ORG_ADMIN_B, role: "org_admin", orgId: ORG_B };
const userCtx: RequestContext = { userId: USER, role: "user", orgId: ORG };

// ─── Fixtures ────────────────────────────────────────────────

const pRisky = agentProfileStore.create({
  name: "m6b-bash-auto",
  orgId: ORG,
  toolsConfig: { tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"], allowedTools: ["Read", "Grep", "Glob", "Bash"], disallowedTools: [] },
});
const pPlain = agentProfileStore.create({ name: "m6b-inherits-default", orgId: ORG });
const pOtherOrg = agentProfileStore.create({
  name: "m6b-org-b-profile",
  orgId: ORG_B,
  toolsConfig: { tools: ["Read", "Grep", "Glob", "Write"], allowedTools: ["Read", "Grep", "Glob"], disallowedTools: [] },
});

// M3 registry fixtures (registry rows only — posture never touches the FS).
// The REAL data/skills.json (if present) is snapshotted and restored on exit
// so this test never destroys the seed other tests (skill-config) rely on.
mkdirSync("data", { recursive: true });
const skillsBackup = fs.existsSync("data/skills.json") ? fs.readFileSync("data/skills.json", "utf8") : null;
process.on("exit", () => {
  try {
    if (skillsBackup !== null) writeFileSync("data/skills.json", skillsBackup);
    else rmSync("data/skills.json", { force: true });
  } catch {}
});
writeFileSync("data/skills.json", JSON.stringify([
  { name: "m6b-local-skill", type: "plugin", enabled: true, path: "skills/m6b-local-skill" },
  { name: "m6b-quarantined-pkg", type: "plugin", enabled: false, path: "skills/quarantine/m6b-quarantined-pkg", sourceKind: "zip", sha256: "abc123", importedAt: "2026-10-22T00:00:00.000Z", copyPolicy: "snapshot", hasScripts: true },
  { name: "m6b-disabled-skill", type: "plugin", enabled: false, path: "skills/m6b-disabled-skill" },
], null, 2));

// P1-1 fixture: org-scope entitlements — ORG is entitled to exactly ONE skill.
// ORG_B has none. Unentitled global skills must never surface to org_admin.
writeFileSync(ENT_FILE, JSON.stringify({
  version: 1,
  entries: [
    { resourceId: "m6b-local-skill", scopeType: "org", scopeId: ORG, effect: "allow", grantedBy: ADMIN, grantedAt: "2026-10-22T00:00:00.000Z" },
  ],
}, null, 2));

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

async function expectCode(name: string, fn: () => unknown, code: string): Promise<void> {
  let threw = false;
  let got = "";
  try {
    fn();
  } catch (err) {
    threw = true;
    got = err instanceof SecurityPostureError ? err.code : "(not SecurityPostureError)";
  }
  ok(name, threw && got === code, `threw=${threw} code=${got} (want ${code})`);
}

function auditRows(action: string): Array<{ result: string; reason_summary: string | null }> {
  return db.prepare(`SELECT result, reason_summary FROM governance_audit_log WHERE action = ?`).all(action) as Array<{ result: string; reason_summary: string | null }>;
}

function profileRaw(id: string): string | null {
  const row = db.prepare(`SELECT tools_config FROM agent_profiles WHERE id = ?`).get(id) as { tools_config: string | null };
  return row.tools_config;
}

// ─── Section 1: posture read model — role scoping ───────────

{
  const posture = buildSecurityPosture(adminCtx);
  ok("admin posture: six fixed sections present",
    ["toolApproval", "fileAccess", "sensitiveInfo", "commandProtection", "skillScan", "audit"].every((k) => k in posture));
  ok("admin posture: sees ALL DB profiles across orgs",
    posture.toolApproval.profiles.map((p: { profileId: string }) => p.profileId).includes(pOtherOrg.id));
  ok("admin posture: platformDefault is read-only",
    posture.toolApproval.platformDefault.editable === false &&
    posture.toolApproval.platformDefault.name === "default-sandbox");
}

{
  const posture = buildSecurityPosture(orgAdminCtx);
  const ids = posture.toolApproval.profiles.map((p: { profileId: string }) => p.profileId);
  ok("org_admin posture: own-org profiles only", ids.includes(pRisky.id) && ids.includes(pPlain.id));
  ok("org_admin posture: cross-org profile NEVER appears", !ids.includes(pOtherOrg.id));
  ok("org_admin posture: every listed profile is editable (DB profile)", posture.toolApproval.profiles.every((p: { editable: boolean }) => p.editable === true));
  const risky = posture.commandProtection.riskyProfiles.map((p: { profileId: string }) => p.profileId);
  ok("org_admin posture: riskyProfiles = Bash-auto-allowed own-org profiles only",
    risky.includes(pRisky.id) && !risky.includes(pOtherOrg.id));
}

// Tool tri-state derivation.
{
  const posture = buildSecurityPosture(adminCtx);
  const risky = posture.toolApproval.profiles.find((p: { profileId: string }) => p.profileId === pRisky.id)!;
  ok("tri-state: approvalRequired = tools − allowed − disallowed",
    JSON.stringify([...risky.approvalRequired].sort()) === JSON.stringify(["Edit", "Write"]));
  const plain = posture.toolApproval.profiles.find((p: { profileId: string }) => p.profileId === pPlain.id)!;
  ok("tri-state: profile without toolsConfig inherits platform default",
    plain.inheritsPlatformDefault === true &&
    JSON.stringify(plain.allowedTools) === JSON.stringify(posture.toolApproval.platformDefault.allowedTools));
  ok("platformDefault: Bash requires approval (not auto-allowed)",
    posture.toolApproval.platformDefault.approvalRequired.includes("Bash") &&
    !posture.toolApproval.platformDefault.allowedTools.includes("Bash"));
}

// ─── Section 2: command protection truth ────────────────────

{
  const posture = buildSecurityPosture(adminCtx);
  ok("commandProtection: local runtime Bash is hard-denied (enforced, not configurable)",
    posture.commandProtection.localBash.status === "enforced" &&
    posture.commandProtection.localBash.policy === "hard-deny");
  ok("commandProtection: docker runtime Bash is profile-dependent (configurable)",
    posture.commandProtection.dockerBash.status === "configurable" &&
    posture.commandProtection.dockerBash.policy === "profile-approval-gate");
  ok("commandProtection: tightening to approval is supported; bypass is not offered",
    posture.commandProtection.tighten.supported === true &&
    posture.commandProtection.tighten.action === "move-bash-from-allowed-to-approval");
}

// ─── Section 3: skill scan (M3 registry aggregation) ─────────

{
  const posture = buildSecurityPosture(adminCtx);
  const counts = posture.skillScan.counts;
  ok("skillScan: counts aggregate the registry",
    counts.total === 3 && counts.enabled === 1 && counts.disabled === 2 &&
    counts.quarantined === 1 && counts.withScripts === 1,
    JSON.stringify(counts));
  const pkg = posture.skillScan.packages.find((p: { name: string }) => p.name === "m6b-quarantined-pkg")!;
  ok("skillScan: supply-chain manifest fields exposed (sha256/hasScripts/copyPolicy)",
    pkg.sha256 === "abc123" && pkg.hasScripts === true && pkg.copyPolicy === "snapshot");
  ok("skillScan: quarantine stays fail-closed (no off/warn/block fake modes)",
    posture.skillScan.mode === "fail-closed-import-quarantine");
}

// ─── Section 3b: org_admin skillScan is entitlement-scoped (P1-1) ──

{
  const posture = buildSecurityPosture(orgAdminCtx);
  const names = posture.skillScan.packages.map((p: { name: string }) => p.name);
  ok("skillScan (org_admin): sees ONLY entitled skills",
    names.length === 1 && names[0] === "m6b-local-skill", JSON.stringify(names));
  ok("skillScan (org_admin): unentitled global skills never appear (names/hashes/manifest)",
    !names.includes("m6b-quarantined-pkg") && !names.includes("m6b-disabled-skill"));
  ok("skillScan (org_admin): counts follow the scoped view",
    posture.skillScan.counts.total === 1 && posture.skillScan.counts.enabled === 1);
  const postureB = buildSecurityPosture(orgAdminBCtx);
  ok("skillScan (org-B org_admin): zero entitled skills (cross-org allow never grants)",
    postureB.skillScan.packages.length === 0 && postureB.skillScan.counts.total === 0,
    JSON.stringify(postureB.skillScan.packages));
  ok("skillScan (admin): full catalog regardless of entitlements",
    buildSecurityPosture(adminCtx).skillScan.counts.total === 3);
  const serialized = JSON.stringify(posture);
  ok("skillScan (org_admin): unentitled manifest data (sha256/copyPolicy) absent from response",
    !serialized.includes("abc123") && !serialized.includes("snapshot"));
}

// ─── Section 4: sensitive info truthfulness ──────────────────

{
  const posture = buildSecurityPosture(adminCtx);
  const cov = posture.sensitiveInfo.coverage as Array<{ area: string; status: string }>;
  const byArea = Object.fromEntries(cov.map((c) => [c.area, c.status]));
  ok("sensitiveInfo: existing coverage declared enforced",
    byArea["governance-audit"] === "enforced" && byArea["run-summary"] === "enforced" && byArea["connector-credentials"] === "enforced");
  ok("sensitiveInfo: chat content DLP is honestly not_implemented",
    byArea["chat-content-dlp"] === "not_implemented" && posture.sensitiveInfo.status === "partial");
}

// ─── Section 5: no host paths / secrets / payloads ───────────

{
  const posture = buildSecurityPosture(orgAdminCtx);
  const serialized = JSON.stringify(posture);
  ok("posture JSON: no host absolute path", !serialized.includes("/Users/") && !serialized.includes(process.cwd()));
  ok("posture JSON: no absolutePath / token / secret fields",
    !serialized.includes("absolutePath") && !serialized.toLowerCase().includes("token") && !serialized.toLowerCase().includes("secret"));
  ok("fileAccess: symbolic boundaries only (no volume names)",
    JSON.stringify(posture.fileAccess).includes("workspace") && !JSON.stringify(posture.fileAccess).includes("agent-workspace-"));
}

// ─── Section 6: service role guard ───────────────────────────

await expectCode("user role: buildSecurityPosture forbidden", () => buildSecurityPosture(userCtx), "forbidden");
await expectCode("user role: updateProfileTools forbidden", () =>
  updateProfileTools(userCtx, pRisky.id, { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] }), "forbidden");

// ─── Section 7: narrow write — updateProfileTools ────────────

{
  const before = profileRaw(pRisky.id);
  const updated = updateProfileTools(orgAdminCtx, pRisky.id, {
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
    allowedTools: ["Read", "Grep", "Glob"],
    disallowedTools: [],
  });
  ok("update: profile toolsConfig written",
    profileRaw(pRisky.id) !== before && !JSON.parse(profileRaw(pRisky.id)!).allowedTools.includes("Bash"));
  ok("update: returned view derives approvalRequired (Bash tightened)",
    updated.approvalRequired.includes("Bash") && !updated.allowedTools.includes("Bash"));
  const audits = auditRows("security.profile_tools.update");
  ok("update: metadata-only governance audit written (success)",
    audits.length === 1 && audits[0].result === "success" && audits[0].reason_summary !== null,
    JSON.stringify(audits));
  ok("update: audit summary is categorical (no tool payload)",
    /^tools=\d+ allowed=\d+ disallowed=\d+$/.test(audits[0].reason_summary!));

  // admin (super-user) may update a cross-org profile.
  updateProfileTools(adminCtx, pOtherOrg.id, {
    tools: ["Read", "Grep", "Glob", "Write"],
    allowedTools: ["Read", "Grep"],
    disallowedTools: [],
  });
  ok("update: admin may edit any org's profile", !JSON.parse(profileRaw(pOtherOrg.id)!).allowedTools.includes("Write"));

  // P1-2: smuggled inner fields are normalized away — the store row keeps
  // EXACTLY the three declared keys even if a caller bypasses the route layer.
  updateProfileTools(orgAdminCtx, pRisky.id, {
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    disallowedTools: [],
    ...( { secret: "smuggled", note: "extra" } as object),
  } as never);
  ok("update: smuggled inner fields never persist (row keeps exactly 3 keys)",
    JSON.stringify(Object.keys(JSON.parse(profileRaw(pRisky.id)!) as Record<string, unknown>).sort()) ===
    JSON.stringify(["allowedTools", "disallowedTools", "tools"]));
}

{
  const before = profileRaw(pPlain.id);
  await expectCode("update: org_admin cross-org profile rejected", () =>
    updateProfileTools(orgAdminCtx, pOtherOrg.id, { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] }), "cross_org");
  await expectCode("update: platform default is read-only", () =>
    updateProfileTools(orgAdminCtx, "platform-default", { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] }), "platform_default_readonly");
  await expectCode("update: Bash in BOTH allowed+disallowed rejected", () =>
    updateProfileTools(orgAdminCtx, pPlain.id, {
      tools: ["Read", "Bash"], allowedTools: ["Bash"], disallowedTools: ["Bash"],
    }), "invalid_tools_config");
  await expectCode("update: unknown tool rejected", () =>
    updateProfileTools(orgAdminCtx, pPlain.id, {
      tools: ["Read", "NuclearLaunch"], allowedTools: ["Read"], disallowedTools: [],
    }), "invalid_tools_config");
  await expectCode("update: allowedTools ⊄ tools rejected", () =>
    updateProfileTools(orgAdminCtx, pPlain.id, {
      tools: ["Read"], allowedTools: ["Read", "Bash"], disallowedTools: [],
    }), "invalid_tools_config");
  await expectCode("update: unknown profile rejected", () =>
    updateProfileTools(orgAdminCtx, "no-such-profile", { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] }), "not_found");
  ok("update: all rejections leave ZERO partial write (row untouched)", profileRaw(pPlain.id) === before);
  const deniedAudits = auditRows("security.profile_tools.update").filter((a) => a.result !== "success");
  ok("update: denials audited too (metadata-only)", deniedAudits.length >= 6);
}

// ─── Section 8: route contract ───────────────────────────────

{
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const who = String(req.headers["x-test-actor"] ?? "");
    const orgId = String(req.headers["x-test-org"] ?? ORG);
    if (who === "user") Object.assign(req, { userId: USER, userRole: "user", orgId });
    else if (who === "orgadmin") Object.assign(req, { userId: ORG_ADMIN, userRole: "org_admin", orgId });
    else if (who === "orgadmin-b") Object.assign(req, { userId: ORG_ADMIN_B, userRole: "org_admin", orgId: ORG_B });
    else if (who === "admin") Object.assign(req, { userId: ADMIN, userRole: "admin", orgId });
    else if (who === "anon") { /* no identity */ }
    next();
  });
  app.use("/api/admin/security-posture", createSecurityPostureRoutes());
  const server = app.listen(0);
  const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const userRes = await fetch(`${BASE}/api/admin/security-posture`, { headers: { "x-test-actor": "user" } });
  ok("route: user GET → 403", userRes.status === 403);

  const anonRes = await fetch(`${BASE}/api/admin/security-posture`, { headers: { "x-test-actor": "anon" } });
  ok("route: unauthenticated GET → 403 (no identity degrades to user)", anonRes.status === 403);

  // orgId forging via query string must be ignored — ctx is the only authority.
  const forged = await fetch(`${BASE}/api/admin/security-posture?orgId=${ORG_B}`, { headers: { "x-test-actor": "orgadmin" } });
  const forgedBody = await forged.json();
  ok("route: org_admin GET 200; query-string orgId forging ignored",
    forged.status === 200 && !forgedBody.toolApproval.profiles.some((p: { profileId: string }) => p.profileId === pOtherOrg.id));
  ok("route: org_admin GET skillScan is entitlement-scoped (P1-1)",
    forgedBody.skillScan.packages.length === 1 && forgedBody.skillScan.packages[0].name === "m6b-local-skill",
    JSON.stringify(forgedBody.skillScan.packages.map((p: { name: string }) => p.name)));

  const adminRes = await fetch(`${BASE}/api/admin/security-posture`, { headers: { "x-test-actor": "admin" } });
  const adminBody = await adminRes.json();
  ok("route: admin GET 200 with cross-org profile",
    adminRes.status === 200 && adminBody.toolApproval.profiles.some((p: { profileId: string }) => p.profileId === pOtherOrg.id));
  ok("route: GET body carries stable section statuses",
    adminBody.commandProtection.localBash.status === "enforced" && adminBody.sensitiveInfo.status === "partial");
  ok("route: GET body has no host paths",
    !JSON.stringify(adminBody).includes("/Users/") && !JSON.stringify(adminBody).includes("absolutePath"));

  const before = profileRaw(pPlain.id);
  const patchOk = await fetch(`${BASE}/api/admin/security-posture/profiles/${pPlain.id}/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": "orgadmin" },
    body: JSON.stringify({ toolsConfig: { tools: ["Read", "Grep"], allowedTools: ["Read"], disallowedTools: [] } }),
  });
  const patchOkBody = await patchOk.json();
  ok("route: PATCH success 200 + derived approval in response",
    patchOk.status === 200 && JSON.stringify(patchOkBody.approvalRequired) === JSON.stringify(["Grep"]));
  ok("route: PATCH success persisted (row changed)", profileRaw(pPlain.id) !== before);
  ok("route: PATCH success persisted EXACTLY the three declared fields (P1-2)",
    JSON.stringify(Object.keys(JSON.parse(profileRaw(pPlain.id)!) as Record<string, unknown>).sort()) ===
    JSON.stringify(["allowedTools", "disallowedTools", "tools"]));

  // Extra body fields — orgId/name/prompt must be rejected, not silently used.
  const beforeRisky = profileRaw(pRisky.id);
  const extraRes = await fetch(`${BASE}/api/admin/security-posture/profiles/${pRisky.id}/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": "orgadmin" },
    body: JSON.stringify({ toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] }, name: "hijack", orgId: ORG_B }),
  });
  ok("route: PATCH extra fields (name/orgId) → 400 unexpected_fields", extraRes.status === 400 && (await extraRes.json()).code === "unexpected_fields");

  // P1-2: extra keys INSIDE toolsConfig must be rejected before the service
  // call — never persisted by the store's verbatim serialization.
  const innerExtraRes = await fetch(`${BASE}/api/admin/security-posture/profiles/${pRisky.id}/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": "orgadmin" },
    body: JSON.stringify({ toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [], secret: "smuggled", note: "extra" } }),
  });
  ok("route: PATCH inner extra fields (secret/note) → 400 unexpected_fields",
    innerExtraRes.status === 400 && (await innerExtraRes.json()).code === "unexpected_fields");

  const badRes = await fetch(`${BASE}/api/admin/security-posture/profiles/${pRisky.id}/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": "orgadmin" },
    body: JSON.stringify({ toolsConfig: { tools: ["Bash"], allowedTools: ["Bash"], disallowedTools: ["Bash"] } }),
  });
  ok("route: PATCH invalid tri-state → 400 invalid_tools_config", badRes.status === 400 && (await badRes.json()).code === "invalid_tools_config");

  const pdRes = await fetch(`${BASE}/api/admin/security-posture/profiles/platform-default/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": "admin" },
    body: JSON.stringify({ toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] } }),
  });
  ok("route: PATCH platform-default → 403 (even for admin)", pdRes.status === 403);

  const crossRes = await fetch(`${BASE}/api/admin/security-posture/profiles/${pRisky.id}/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": "orgadmin-b" },
    body: JSON.stringify({ toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] } }),
  });
  ok("route: PATCH cross-org (org-B admin on org-A profile) → 404 without existence leak",
    crossRes.status === 404);

  const userPatch = await fetch(`${BASE}/api/admin/security-posture/profiles/${pRisky.id}/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-test-actor": "user" },
    body: JSON.stringify({ toolsConfig: { tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] } }),
  });
  ok("route: PATCH by user → 403", userPatch.status === 403);

  ok("route: all PATCH rejections left the profile row untouched", profileRaw(pRisky.id) === beforeRisky);

  // Local Bash deny must not be relaxable through the only write path: the
  // posture surface has exactly one write route (grep-style contract check).
  const routes = (createSecurityPostureRoutes() as any).stack.map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  ok("route: surface is exactly GET / + PATCH /profiles/:profileId/tools (no other writes)",
    routes.length === 2 && routes.includes("GET /") && routes.includes("PATCH /profiles/:profileId/tools"),
    routes.join(", "));

  server.close();
}

console.log(`\nAll ${pass} assertions passed.`);
