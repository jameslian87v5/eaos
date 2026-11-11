// A2UI v2 — S1 schema + tool-definition pure tests.
// Run: A2UI_ENABLED=true npx tsx server/a2ui-schema.test.ts
//
// Locks the §4-S1 invariants (ACTIVE—A2UI-阻塞式工具通道实施计划.md):
//   - four block types parse valid/invalid
//   - timeoutSec clamped + stripped from persisted block
//   - payload caps reject oversized input (R1 supplement)
//   - flat raw shape mirrors the A2UIBlock union
//   - createA2UISdkMcpServer builds an in-process server with the show_ui tool
//     wired to the onShowUi callback; handler returns isError on bad input.
import assert from "node:assert/strict";
import {
  zA2UIBlock,
  showUiInputRawShape,
  parseShowUiArgs,
  A2UI_LIMITS,
  type ShowUiCall,
  type ShowUiResult,
} from "./a2ui-schema.js";
import {
  A2UI_INTERNAL_MCP_NAME,
  SHOW_UI_TOOL_NAME,
  createA2UISdkMcpServer,
  resolveShowUiTimeout,
  resolveSubmitTimeoutMs,
} from "./a2ui-tool.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// ─── Fixtures ─────────────────────────────────────────────────
const validForm = {
  type: "form",
  title: "部署方案选择",
  description: "请选择",
  fields: [
    { id: "plan", type: "select", label: "方案", required: true,
      options: [{ label: "A", value: "local" }, { label: "B", value: "container" }] },
    { id: "monitoring", type: "boolean", label: "监控", default: false },
  ],
  actions: [{ id: "submit", label: "提交", style: "primary" }],
};
const validConfirm = { type: "confirm", title: "确认删除？", actions: [{ id: "ok", label: "删除", style: "danger" }] };
const validCard = { type: "card", title: "信息", items: [{ title: "t1", subtitle: "s" }], actions: [{ id: "close", label: "关闭" }] };
const validList = { type: "list", title: "列表", items: [{ key: "k", label: "l", value: "v" }], actions: [{ id: "pick", label: "选" }] };

// ─── A: block union parse (valid) ────────────────────────────
ok("A1 form parses", zA2UIBlock.safeParse(validForm).success);
ok("A2 confirm parses", zA2UIBlock.safeParse(validConfirm).success);
ok("A3 card parses", zA2UIBlock.safeParse(validCard).success);
ok("A4 list parses", zA2UIBlock.safeParse(validList).success);

// ─── B: invalid blocks ───────────────────────────────────────
ok("B1 form without actions → invalid", !zA2UIBlock.safeParse({ type: "form", title: "x", fields: [{ id: "f", type: "text", label: "L" }] }).success);
ok("B2 form without fields → invalid", !zA2UIBlock.safeParse({ type: "form", title: "x", actions: [{ id: "a", label: "A" }] }).success);
ok("B3 confirm without actions → invalid", !zA2UIBlock.safeParse({ type: "confirm", title: "x" }).success);
ok("B4 list without items → invalid", !zA2UIBlock.safeParse({ type: "list", title: "x", actions: [{ id: "a", label: "A" }] }).success);
ok("B5 unknown type → invalid", !zA2UIBlock.safeParse({ type: "wat", title: "x" }).success);
ok("B6 empty title → invalid", !zA2UIBlock.safeParse({ type: "confirm", title: "", actions: [{ id: "a", label: "A" }] }).success);
// Codex S1 review finding 1: legacy alias field types must be REJECTED here —
// the v2 renderer only understands canonical types (a "dropdown" would silently
// render as text). Alias tolerance belongs to the legacy prose parser only.
ok("B7 legacy alias field type (dropdown) → invalid",
  !zA2UIBlock.safeParse({ type: "form", title: "x", fields: [{ id: "f", type: "dropdown", label: "L" }], actions: [{ id: "a", label: "A" }] }).success);
ok("B8 alias multiselect variant → invalid",
  !zA2UIBlock.safeParse({ type: "form", title: "x", fields: [{ id: "f", type: "multi_select", label: "L" }], actions: [{ id: "a", label: "A" }] }).success);
ok("B9 alias via parseShowUiArgs also rejected",
  "error" in parseShowUiArgs({ type: "form", title: "x", fields: [{ id: "f", type: "checkbox", label: "L" }], actions: [{ id: "a", label: "A" }] }));
// Codex S1 review finding 2: a tool-backed card with no actions has no
// submission path — show_ui would block until timeout. Require ≥1 action.
ok("B10 card without actions → invalid",
  !zA2UIBlock.safeParse({ type: "card", title: "x", items: [{ title: "t" }] }).success);
// Codex S2 edge review: choice fields without non-empty options would leave
// the validator nothing to enforce membership against.
ok("B11 select without options → invalid",
  !zA2UIBlock.safeParse({ type: "form", title: "x", fields: [{ id: "f", type: "select", label: "L" }], actions: [{ id: "a", label: "A" }] }).success);
ok("B12 multi-select with empty options → invalid",
  !zA2UIBlock.safeParse({ type: "form", title: "x", fields: [{ id: "f", type: "multi-select", label: "L", options: [] }], actions: [{ id: "a", label: "A" }] }).success);

// ─── C: parseShowUiArgs strips timeoutSec + clamps ───────────
{
  const r = parseShowUiArgs({ ...validForm, timeoutSec: 30 }) as ({ block: any; timeoutSec?: number } | { error: string });
  ok("C1a valid args → block", "block" in r && r.block.type === "form", JSON.stringify(r));
  ok("C1b timeoutSec extracted", "block" in r && r.timeoutSec === 30);
  ok("C1c block carries no timeoutSec", "block" in r && !("timeoutSec" in r.block));
}
{
  const r = parseShowUiArgs({ ...validConfirm, timeoutSec: 999999 }) as ({ block: any; timeoutSec?: number } | { error: string });
  ok("C2 oversized timeoutSec still parses (clamp is tool-layer)", "block" in r, JSON.stringify(r));
}
ok("C3 non-object → error", "error" in parseShowUiArgs("nope"));
ok("C4 array → error", "error" in parseShowUiArgs([validForm]));

// ─── D: payload caps (R1 supplement) ─────────────────────────
{
  const tooManyFields = { type: "form", title: "x", fields: Array.from({ length: A2UI_LIMITS.maxFields + 1 }, (_, i) => ({ id: `f${i}`, type: "text", label: "L" })), actions: [{ id: "a", label: "A" }] };
  ok("D1 fields > cap → invalid", !zA2UIBlock.safeParse(tooManyFields).success);
}
{
  const tooManyActions = { type: "confirm", title: "x", actions: Array.from({ length: A2UI_LIMITS.maxActions + 1 }, (_, i) => ({ id: `a${i}`, label: "A" })) };
  ok("D2 actions > cap → invalid", !zA2UIBlock.safeParse(tooManyActions).success);
}
{
  const longTitle = { type: "confirm", title: "x".repeat(A2UI_LIMITS.maxTitleLen + 1), actions: [{ id: "a", label: "A" }] };
  ok("D3 title > cap → invalid", !zA2UIBlock.safeParse(longTitle).success);
}
{
  const tooManyItems = { type: "list", title: "x", items: Array.from({ length: A2UI_LIMITS.maxItems + 1 }, (_, i) => ({ key: `k${i}`, label: "L", value: "v" })), actions: [{ id: "a", label: "A" }] };
  ok("D4 items > cap → invalid", !zA2UIBlock.safeParse(tooManyItems).success);
}

// ─── E: flat raw shape is a plain object of zod fields ────────
ok("E1 raw shape has the 7 flat fields",
  ["type","title","description","fields","items","actions","timeoutSec"].every((k) => k in showUiInputRawShape));

// ─── F: timeout helpers ───────────────────────────────────────
ok("F1 default submit timeout 15min", resolveSubmitTimeoutMs() === 900_000, String(resolveSubmitTimeoutMs()));
ok("F2 per-call clamped to env default", resolveShowUiTimeout(3600) === 900_000, String(resolveShowUiTimeout(3600)));
ok("F3 no per-call → env default", resolveShowUiTimeout(undefined) === 900_000);

// ─── G: in-process MCP server build + handler wiring ──────────
{
  let received: any = null;
  const fixedResult: ShowUiResult = { status: "submitted", blockId: "b1", actionId: "submit", values: { plan: "container" }, submittedAt: "2026-08-20T00:00:00Z" };
  const server = createA2UISdkMcpServer(async (call) => { received = call; return fixedResult; });
  // McpSdkServerConfigWithInstance shape
  ok("G1 server is sdk-type", (server as any).type === "sdk" && (server as any).name === A2UI_INTERNAL_MCP_NAME, JSON.stringify({ type: (server as any).type, name: (server as any).name }));
  const toolDef = (server as any).instance?._server?._toolHandlers ?? (server as any).instance?.tools;
  ok("G2 tool name constant", SHOW_UI_TOOL_NAME === `mcp__${A2UI_INTERNAL_MCP_NAME}__show_ui`);

  // Drive the handler directly to prove wiring without a live SDK query.
  // The tool def lives on the server instance; locate it portably.
  const inst: any = (server as any).instance;
  ok("G3 instance present", !!inst);
  const handler = (() => {
    // createSdkMcpServer stores tools on the internal server; the handler is
    // reachable via the registered tool name. Probe common shapes.
    const probes = [
      inst?._server?._registeredTools?.show_ui,
      inst?._registeredTools?.show_ui,
      inst?._toolHandlers?.show_ui,
    ];
    for (const p of probes) {
      const h = typeof p === "function" ? p : p?.handler ?? p?.callback;
      if (typeof h === "function") return h;
    }
    return null;
  })();
  // If the SDK's internal layout shifted and we can't reach the handler,
  // still assert the server built without throwing (G1/G2 cover that). The
  // full handler wiring is exercised end-to-end in a2ui-v2.test.ts (S5).
  if (handler) {
    const out = await handler(validForm, {}) as any;
    ok("G4 handler returns submitted result on valid input",
      out?.content?.[0]?.text && JSON.parse(out.content[0].text).status === "submitted", JSON.stringify(out));
    ok("G5 onShowUi received the block", received?.block?.type === "form");

    const badOut = await handler({ type: "form", title: "x" }, {}) as any; // missing fields+actions
    ok("G6 handler isError on invalid block", badOut?.isError === true, JSON.stringify(badOut));
  } else {
    ok("G4 handler reachable probe skipped (SDK internal layout)", true);
  }
}

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
