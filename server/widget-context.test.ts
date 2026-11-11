/**
 * Tests for the W4 page-context guardrail (server/widget-context.ts).
 * Pure module — no DB/runtime. Run: npm run test:widget-context
 */
import {
  boundPageContext,
  wrapRuntimeInput,
  contextSummary,
  PAGE_CONTEXT_DEFAULTS,
} from "./widget-context.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}
function eq<T>(name: string, got: T, want: T) {
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

console.log("widget-context tests");

// --- boundPageContext -----------------------------------------------------

eq("null context is ok (no-op)", boundPageContext(null).ok, true);
eq("null context value is null", boundPageContext(null).value, null);
eq("undefined context is ok", boundPageContext(undefined).ok, true);
eq("empty object is ok (no-op)", boundPageContext({}).value, null);

const good = { page: { route: "/p/1" }, selection: { id: "P1" } };
const bg = boundPageContext(good);
ok("valid object passes", bg.ok && bg.value !== null);
eq("valid object value preserved (deep)", JSON.stringify(bg.value), JSON.stringify(good));

ok("array rejected (must be object)", !boundPageContext([1, 2, 3]).ok);
ok("string rejected", !boundPageContext("hi").ok);
ok("number rejected", !boundPageContext(42).ok);

ok(
  "too many top-level keys rejected",
  !boundPageContext(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))).ok
);
eq(
  "maxKeys option honored",
  boundPageContext({ a: 1, b: 2 }, { maxKeys: 1 }).ok,
  false
);
eq(
  "within maxKeys option passes",
  boundPageContext({ a: 1, b: 2 }, { maxKeys: 2 }).ok,
  true
);

const bigVal = "x".repeat(PAGE_CONTEXT_DEFAULTS.maxBytes + 10);
ok("oversized context rejected", !boundPageContext({ blob: bigVal }).ok);
const smallEnough = "x".repeat(100);
ok("undersized context passes", boundPageContext({ blob: smallEnough }).ok);

// depth: root(0) → a(1) → b(2) → c(3, object) → d(4) exceeds maxDepth 3
const tooDeep = { a: { b: { c: { d: "x" } } } };
ok("too-deep nesting rejected", !boundPageContext(tooDeep).ok);
const ok3 = { view: { filters: { region: "华东" } } }; // root→view→filters = depth 2 object, values primitive
ok("3-level example passes", boundPageContext(ok3).ok);

const cyclic: Record<string, unknown> = { a: 1 };
cyclic.self = cyclic;
ok("cyclic context rejected", !boundPageContext(cyclic).ok);

// validation failure carries a warning string
ok("rejection carries warning", typeof boundPageContext([1]).warning === "string");

// --- plain-JSON boundary (Codex review evt_20260712083705) ----------------
// The guard must enforce plain JSON regardless of how input arrives.
ok("function value rejected", !boundPageContext({ fn: () => 1 }).ok);
ok("Date value rejected", !boundPageContext({ d: new Date() }).ok);
ok("top-level Date rejected", !boundPageContext(new Date()).ok);
ok("nested Buffer rejected", !boundPageContext({ b: Buffer.from("x") }).ok);
ok("ArrayBuffer rejected", !boundPageContext({ b: new ArrayBuffer(4) }).ok);
ok("typed array (Uint8Array) rejected", !boundPageContext({ b: new Uint8Array(2) }).ok);
ok("bigint value rejected", !boundPageContext({ n: BigInt(5) }).ok);
ok("symbol value rejected", !boundPageContext({ s: Symbol("x") }).ok);
ok("undefined value rejected", !boundPageContext({ u: undefined }).ok);
class Thing { x = 1 }
ok("class instance rejected (non-plain object)", !boundPageContext({ o: new Thing() }).ok);
// Decision: nested arrays ARE allowed (JSON arrays); children + depth validated.
ok("nested array of primitives allowed", boundPageContext({ ids: [1, 2, 3] }).ok);
ok("nested array with function rejected", !boundPageContext({ ids: [1, () => 2] }).ok);
ok("nested array with Date rejected", !boundPageContext({ ids: [new Date()] }).ok);
ok("array of plain objects allowed (list shape, within depth 3)", boundPageContext({ items: [{ id: "P1" }, { id: "P2" }] }).ok);

// --- wrapRuntimeInput -----------------------------------------------------

const wrapped = wrapRuntimeInput("查一下这个商品", { selection: { id: "P1" } });
ok("wrapped includes <page-context> block", wrapped.includes("<page-context>"));
ok("wrapped includes <user-message> block", wrapped.includes("<user-message>"));
ok("wrapped includes typed user text", wrapped.includes("查一下这个商品"));
ok("wrapped includes context json", wrapped.includes('"selection"'));
ok("wrapped is not the raw user text", wrapped !== "查一下这个商品");

// --- contextSummary (audit, no payload) -----------------------------------

const sum = contextSummary({ selection: { id: "P1" }, secret: "s3cret" }, "ps_abc");
eq("summary has pageSessionId", sum.pageSessionId, "ps_abc");
ok("summary hash is 64 hex (sha256)", /^[0-9a-f]{64}$/.test(sum.contextHash));
ok("summary has contextLen number", typeof sum.contextLen === "number" && sum.contextLen > 0);
eq("summary keys are top-level only", JSON.stringify(sum.keys), JSON.stringify(["selection", "secret"]));
const sumJson = JSON.stringify(sum);
ok("summary does NOT leak payload value", !sumJson.includes("s3cret"));

const sum2 = contextSummary({ selection: { id: "P1" }, secret: "s3cret" }, "ps_abc");
eq("same context → same hash", sum2.contextHash, sum.contextHash);
const sum3 = contextSummary({ selection: { id: "P2" } });
ok("different context → different hash", sum3.contextHash !== sum.contextHash);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
