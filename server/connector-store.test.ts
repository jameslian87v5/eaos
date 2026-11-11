// Octop absorption M1a (codex evt_20261020041142) — connector contract tests.
//
// Focused proof for the M1a boundary (ACTIVE—Octop优势吸收整体计划.md §3-M1):
//   - catalog is code-defined + immutable (internal-rest entry present);
//   - instance state machine: draft → ready → enabled; disabled enterable
//     from ready/enabled; enable-from-draft rejected (no credentials);
//   - credential isolation: AES-256-GCM at rest, key in platform_secrets,
//     views carry credentialsPresent only — no plaintext, no ciphertext,
//     not in API responses, not in governance audits;
//   - write-only credential PUT: values never echoed;
//   - route gate: org_admin/user → 403 + denied metadata audit; admin → 200;
//   - unknown instance → 404; invalid transitions → 400.
//
// NOT tested here (out of M1a): internal MCP call path, capability token,
// resolve() injection, SSRF guards (M1b); admin UI (M1c); Docker acceptance
// (M1d).
//
// Run: npx tsx server/connector-store.test.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import express from "express";
import type { Request, Response, NextFunction } from "express";

// ─── Env before imports ──────────────────────────────────────
const TMP_DB = "/tmp/test-m1a-connectors.db";
process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = "m1a-connector-store-test-secret";
process.env.ALLOW_DEV_JWT_SECRET = "1";
rmSync(TMP_DB, { force: true });
rmSync(`${TMP_DB}-wal`, { force: true });
rmSync(`${TMP_DB}-shm`, { force: true });

const db = (await import("./database.js")).default;
const store = await import("./connector-store.js");
const { createAdminConnectorRoutes } = await import("./admin-connector-routes.js");

const SECRET_PLAINTEXT = "m1a-super-secret-token-9f3a";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

function mustThrow(name: string, fn: () => unknown, needle = "") {
  let threw = false;
  let msg = "";
  try {
    fn();
  } catch (err: any) {
    threw = true;
    msg = String(err?.message ?? err);
  }
  ok(name, threw && (!needle || msg.includes(needle)), `msg=${msg}`);
}

// ─── A: service layer ─────────────────────────────────────────

// A1. Catalog: code-defined, immutable shape, internal-rest present.
{
  const catalog = store.listCatalog();
  ok("A1 catalog lists internal-rest", catalog.some((c) => c.kind === "internal-rest"));
  const entry = store.getCatalogEntry("internal-rest");
  ok("A1 catalog entry shape", !!entry && entry.mcpMode === "internal" && entry.allowedTools.length > 0);
  ok("A1 unknown kind resolves undefined", store.getCatalogEntry("nope-x") === undefined);
}

// A2. Create instance: draft; validation counter-examples.
{
  const inst = store.createInstance({
    catalogKind: "internal-rest",
    name: "intranet-api",
    baseUrl: "https://api.internal.example.com/v1",
  });
  ok("A2 create → draft", inst.status === "draft" && inst.credentialsPresent === false);
  mustThrow("A2 unknown kind", () =>
    store.createInstance({ catalogKind: "nope", name: "x", baseUrl: "https://a.b" }));
  mustThrow("A2 bad scheme", () =>
    store.createInstance({ catalogKind: "internal-rest", name: "x", baseUrl: "ftp://a.b" }));
  mustThrow("A2 no host", () =>
    store.createInstance({ catalogKind: "internal-rest", name: "x", baseUrl: "https://" }));
  mustThrow("A2 userinfo", () =>
    store.createInstance({
      catalogKind: "internal-rest",
      name: "x",
      baseUrl: "https://user:pass@a.b",
    }));
  mustThrow("A2 empty name", () =>
    store.createInstance({ catalogKind: "internal-rest", name: "  ", baseUrl: "https://a.b" }));
  mustThrow("A2 duplicate name", () =>
    store.createInstance({
      catalogKind: "internal-rest",
      name: "intranet-api",
      baseUrl: "https://a.b",
    }));
}

// A3. State machine counter-example: enable from draft is forbidden.
{
  const inst = store.listInstances().find((i) => i.name === "intranet-api")!;
  mustThrow("A3 enable draft rejected", () => store.enableInstance(inst.id), "凭证");
}

// A4. Credential write: validation + draft→ready + encryption at rest.
{
  const inst = store.listInstances().find((i) => i.name === "intranet-api")!;
  mustThrow("A4 unknown field rejected", () =>
    store.writeCredentials(inst.id, { apiToken: "x", extra: "y" }));
  mustThrow("A4 missing required rejected", () => store.writeCredentials(inst.id, {}));
  const { view } = store.writeCredentials(inst.id, { apiToken: SECRET_PLAINTEXT });
  ok("A4 draft → ready", view.status === "ready");
  ok("A4 credentialsPresent true", view.credentialsPresent === true);
  ok("A4 configVersion bumped", view.configVersion >= 2);

  const raw = db
    .prepare("SELECT credentials_ciphertext AS ct FROM connector_instances WHERE id = ?")
    .get(inst.id) as { ct: string };
  ok("A4 ciphertext stored", !!raw.ct && raw.ct.includes("|"));
  ok("A4 ciphertext != plaintext", !raw.ct.includes(SECRET_PLAINTEXT));
  const roundtrip = store.decryptCredentialsForHost(inst.id);
  ok("A4 host-side decrypt roundtrip", roundtrip?.apiToken === SECRET_PLAINTEXT);
}

// A5. Full lifecycle: ready → enabled → disabled → enabled.
{
  const inst = store.listInstances().find((i) => i.name === "intranet-api")!;
  ok("A5 enable from ready", store.enableInstance(inst.id).status === "enabled");
  mustThrow("A5 double enable rejected", () => store.enableInstance(inst.id));
  ok("A5 disable from enabled", store.disableInstance(inst.id).status === "disabled");
  ok("A5 re-enable from disabled", store.enableInstance(inst.id).status === "enabled");
  ok("A5 disable again", store.disableInstance(inst.id).status === "disabled");
  mustThrow("A5 double disable rejected", () => store.disableInstance(inst.id));
}

// A6. Credential rotation on enabled instance keeps status; version bumps.
{
  const inst = store.listInstances().find((i) => i.name === "intranet-api")!;
  store.enableInstance(inst.id); // A5 ended in disabled — bring back to enabled
  const before = inst.configVersion;
  const { view } = store.writeCredentials(inst.id, { apiToken: "rotated-token-2" });
  ok("A6 rotation keeps enabled", view.status === "enabled");
  ok("A6 version bumped", view.configVersion === before + 1);
  ok("A6 new value decrypts", store.decryptCredentialsForHost(inst.id)?.apiToken === "rotated-token-2");
}

// A7. Views are secret-free by construction.
{
  for (const view of store.listInstances()) {
    const serialized = JSON.stringify(view);
    ok(
      `A7 view ${view.name} secret-free`,
      !serialized.includes("ciphertext") &&
        !serialized.includes(SECRET_PLAINTEXT) &&
        !serialized.includes("rotated-token-2")
    );
  }
}

// A8. Key management: exactly one platform_secrets row; key not derivable
// from any API-visible surface (spot: raw value is base64 random 32B).
{
  const rows = db.prepare("SELECT name, value FROM platform_secrets").all() as {
    name: string;
    value: string;
  }[];
  ok("A8 single secret row", rows.length === 1 && rows[0].name === "connector_credentials_aes_key");
  ok("A8 key is 32 bytes", Buffer.from(rows[0].value, "base64").length === 32);
}

// ─── B: HTTP layer (stub identity, real router, port 0) ────────

function startApp(stubRole: string, stubOrgId = "default-org"): {
  base: string;
  close: () => void;
} {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).userId = "actor-" + stubRole;
    (req as any).userRole = stubRole;
    (req as any).orgId = stubOrgId;
    next();
  });
  app.use("/api/admin/connectors", createAdminConnectorRoutes());
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/admin/connectors`,
    close: () => server.close(),
  };
}

async function jsonFetch(
  base: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

{
  const admin = startApp("admin");
  const orgAdmin = startApp("org_admin");
  const user = startApp("user");

  try {
    // B1. admin reads catalog + instances.
    const cat = await jsonFetch(admin.base, "GET", "/catalog");
    ok("B1 admin GET catalog 200", cat.status === 200 && cat.text.includes("internal-rest"));
    const list0 = await jsonFetch(admin.base, "GET", "/instances");
    ok("B1 admin GET instances 200", list0.status === 200);

    // B2. non-admin is denied on every mutating route (403, no state change).
    const deniedPost = await jsonFetch(orgAdmin.base, "POST", "/instances", {
      catalogKind: "internal-rest",
      name: "evil",
      baseUrl: "https://evil.example.com",
    });
    ok("B2 org_admin POST 403", deniedPost.status === 403);
    const firstId = store.listInstances()[0].id;
    const deniedCred = await jsonFetch(user.base, "PUT", `/instances/${firstId}/credentials`, {
      values: { apiToken: "nope" },
    });
    ok("B2 user PUT credentials 403", deniedCred.status === 403);
    const deniedEnable = await jsonFetch(orgAdmin.base, "POST", `/instances/${firstId}/enable`);
    ok("B2 org_admin enable 403", deniedEnable.status === 403);
    ok("B2 no 'evil' instance created", !store.listInstances().some((i) => i.name === "evil"));

    // B3. denied audits are metadata-only.
    const deniedAudits = db
      .prepare(
        "SELECT * FROM governance_audit_log WHERE result = 'denied' AND action LIKE 'connector%'"
      )
      .all() as any[];
    ok("B3 denied audits written", deniedAudits.length >= 3);
    const allDenied = JSON.stringify(deniedAudits);
    ok("B3 audits carry no credential", !allDenied.includes("nope") && !allDenied.includes(SECRET_PLAINTEXT));

    // B4. admin creates + writes credentials: response never echoes values.
    const created = await jsonFetch(admin.base, "POST", "/instances", {
      catalogKind: "internal-rest",
      name: "http-instance",
      baseUrl: "http://10.0.0.5:8080/api",
    });
    ok("B4 POST 201 draft", created.status === 201 && created.text.includes("draft"));
    const id2 = (JSON.parse(created.text) as { instance: { id: string } }).instance.id;
    const cred = await jsonFetch(admin.base, "PUT", `/instances/${id2}/credentials`, {
      values: { apiToken: "http-instance-secret-77" },
    });
    const credBody = JSON.parse(cred.text);
    ok("B4 PUT credentials 200 ready", cred.status === 200 && credBody.instance.status === "ready");
    ok(
      "B4 response echoes nothing",
      !cred.text.includes("http-instance-secret-77") && !cred.text.includes("ciphertext")
    );

    // B5. enable via HTTP + full-list secret sweep.
    const enabled = await jsonFetch(admin.base, "POST", `/instances/${id2}/enable`);
    ok("B5 enable 200", enabled.status === 200 && JSON.parse(enabled.text).instance.status === "enabled");
    const list1 = await jsonFetch(admin.base, "GET", "/instances");
    ok(
      "B5 instance list secret-free",
      !list1.text.includes("http-instance-secret-77") &&
        !list1.text.includes(SECRET_PLAINTEXT) &&
        !list1.text.includes("ciphertext")
    );

    // B6. unknown instance → 404; invalid transition → 400.
    const notFound = await jsonFetch(admin.base, "POST", "/instances/does-not-exist/enable");
    ok("B6 unknown id 404", notFound.status === 404);
    const draftAgain = await jsonFetch(admin.base, "POST", "/instances", {
      catalogKind: "internal-rest",
      name: "still-draft",
      baseUrl: "https://a.example.com",
    });
    const draftId = (JSON.parse(draftAgain.text) as { instance: { id: string } }).instance.id;
    const earlyEnable = await jsonFetch(admin.base, "POST", `/instances/${draftId}/enable`);
    ok("B6 enable draft 400", earlyEnable.status === 400);

    // B7. audit rows for successful ops are metadata-only.
    const audits = db
      .prepare("SELECT * FROM governance_audit_log WHERE action LIKE 'connector%'")
      .all() as any[];
    const auditDump = JSON.stringify(audits);
    ok("B7 success audits exist", audits.length >= 6);
    ok(
      "B7 audits metadata-only",
      !auditDump.includes(SECRET_PLAINTEXT) &&
        !auditDump.includes("http-instance-secret-77") &&
        !auditDump.includes("rotated-token-2")
    );
  } finally {
    admin.close();
    orgAdmin.close();
    user.close();
  }
}

console.log(`\nM1a connector-store tests: ${pass} passed`);
process.exit(0);
