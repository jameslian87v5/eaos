import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type NextFunction, type Request, type Response } from "express";

const { createSkillsHubCatalogRouter } = await import("./skills-hub-catalog.js");

function auth(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization !== "Bearer valid") {
    res.status(401).json({ error: "No token provided" });
    return;
  }
  next();
}

async function withServer(
  config: Parameters<typeof createSkillsHubCatalogRouter>[1],
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use("/api/skills", createSkillsHubCatalogRouter(auth, config));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function hubResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

await test("unauthenticated request is rejected", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/skills/hub-catalog`);
    assert.equal(res.status, 401);
  });
});

await test("missing config and Hub failure degrade to an empty offline catalog", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/skills/hub-catalog`, {
      headers: { authorization: "Bearer valid" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hubOnline: false, items: [] });
  });

  await withServer({
    baseUrl: "https://hub.internal",
    token: "secret",
    fetchImpl: async () => { throw new Error("network down"); },
    timeoutMs: 20,
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/skills/hub-catalog`, {
      headers: { authorization: "Bearer valid" },
    });
    assert.deepEqual(await res.json(), { hubOnline: false, items: [] });
  });

  await withServer({
    baseUrl: "https://hub.internal",
    token: "secret",
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }),
    timeoutMs: 20,
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/skills/hub-catalog`, {
      headers: { authorization: "Bearer valid" },
    });
    assert.deepEqual(await res.json(), { hubOnline: false, items: [] });
  });
});

await test("credentials and Hub URL never appear in success or malicious error responses", async () => {
  const token = "catalog-secret-token";
  const hubUrl = "https://private-hub.example";
  await withServer({
    baseUrl: hubUrl,
    token,
    fetchImpl: async () => hubResponse({
      code: 500,
      msg: `echo ${token} from ${hubUrl}`,
      data: null,
    }),
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/skills/hub-catalog`, {
      headers: { authorization: "Bearer valid" },
    });
    const raw = await res.text();
    assert.equal(res.status, 200);
    assert(!raw.includes(token));
    assert(!raw.includes(hubUrl));
    assert.deepEqual(JSON.parse(raw), { hubOnline: false, items: [] });
  });

  await withServer({
    baseUrl: hubUrl,
    token,
    fetchImpl: async () => hubResponse({
      code: 0,
      msg: "ok",
      data: {
        items: [{
          slug: "echo",
          summary: `echo ${token} from ${hubUrl}`,
          namespace: "global",
        }],
      },
    }),
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/skills/hub-catalog`, {
      headers: { authorization: "Bearer valid" },
    });
    const raw = await res.text();
    assert(!raw.includes(token));
    assert(!raw.includes(hubUrl));
  });
});

await test("published Hub payload maps to the minimal catalog contract", async () => {
  let requestedUrl = "";
  let authorization = "";
  await withServer({
    baseUrl: "https://hub.example/",
    token: "read-token",
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return hubResponse({
        code: 0,
        msg: "ok",
        data: {
          items: [{
            slug: "claim-checker",
            displayName: "Claim Checker",
            summary: "Checks claims against sources.",
            namespace: "global",
            updatedAt: "2026-09-01T10:00:00Z",
            latestVersion: "1.2.0",
          }],
        },
      });
    },
  }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/skills/hub-catalog`, {
      headers: { authorization: "Bearer valid" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      hubOnline: true,
      items: [{
        name: "Claim Checker",
        description: "Checks claims against sources.",
        namespace: "global",
        updatedAt: "2026-09-01T10:00:00Z",
        version: "1.2.0",
      }],
    });
  });
  assert.match(requestedUrl, /\/api\/cli\/v1\/skills\/search\?limit=/);
  assert.equal(authorization, "Bearer read-token");
});

console.log(`\nskills-hub-catalog.test: ${passed} passed, 0 failed`);
