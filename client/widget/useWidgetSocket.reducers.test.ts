// A2UI v2 (S4) — widget reducer idempotency regression (pure node, no React).
// Run: npx tsx client/widget/useWidgetSocket.reducers.test.ts
//
// Locks the S4 review fix: add_a2ui is idempotent by blockId — after a refresh
// the client receives history (rendered as historical cards) and THEN the host's
// deferred live-replay of the SAME blockId; the card must NOT duplicate, and the
// existing entry is re-armed (resolved=false, historical=false). Also: a SECOND
// blockId still appends.
import assert from "node:assert/strict";

// The reducer + action/item types live in a .ts that imports React only for
// types; import just the reducer function dynamically to avoid pulling the
// bundler graph. The module is side-effect free at import (no React calls).
const mod = await import("./useWidgetSocket.js");

// The reducer export name is `reducer`; confirm defensively.
const reducer: unknown = (mod as { reducer?: unknown }).reducer;
if (typeof reducer !== "function") {
  console.error("FAIL: reducer export not found");
  process.exit(1);
}
const r = reducer as (
  state: any,
  action: any
) => any;

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const empty = { items: [], approvals: [], status: "idle", busy: false };
const block = { type: "confirm", title: "t", actions: [{ id: "ok", label: "OK" }] };
const block2 = { type: "confirm", title: "t2", actions: [{ id: "ok", label: "OK" }] };

// R1: first add_a2ui appends a live (non-historical) card.
const s1 = r(empty, { type: "add_a2ui", blockId: "tool-1", block });
const a2uiItems1 = s1.items.filter((it: any) => it.kind === "a2ui");
ok("R1 first add appends one a2ui item", a2uiItems1.length === 1, JSON.stringify(a2uiItems1));
ok("R2 first add is live (resolved=false, historical=false)",
  a2uiItems1[0].resolved === false && a2uiItems1[0].historical === false);

// R3: add_a2ui with the SAME blockId (deferred live-replay after history)
// does NOT duplicate — re-arms the existing entry.
const s2 = r(s1, { type: "add_a2ui", blockId: "tool-1", block });
const a2uiItems2 = s2.items.filter((it: any) => it.kind === "a2ui");
ok("R3 same blockId → no duplicate", a2uiItems2.length === 1, JSON.stringify(a2uiItems2));
ok("R4 re-arm preserves block + clears resolved",
  a2uiItems2[0].blockId === "tool-1" && a2uiItems2[0].resolved === false && a2uiItems2[0].historical === false);

// R5: simulate a refresh — set_history replaces items with a HISTORICAL card
// (resolved=true, historical=true) for the SAME live blockId (the host now
// appends `<!--a2ui-id:<id>-->`), THEN a deferred live-replay add_a2ui
// arrives. The historical entry is re-armed in place (no duplicate).
const s3 = r(s2, {
  type: "set_history",
  messages: [{
    role: "assistant",
    content: `<a2ui-json>${JSON.stringify(block)}</a2ui-json>\n<!--a2ui-id:tool-1-->`,
  }],
});
const histItems = s3.items.filter((it: any) => it.kind === "a2ui");
ok("R5 history renders the block historical+resolved with the live blockId",
  histItems.length === 1 && histItems[0].historical === true && histItems[0].resolved === true
    && histItems[0].blockId === "tool-1",
  JSON.stringify(histItems));
const s4 = r(s3, { type: "add_a2ui", blockId: "tool-1", block });
const finalItems = s4.items.filter((it: any) => it.kind === "a2ui");
ok("R6 live-replay after history → re-arms historical entry, no dup",
  finalItems.length === 1 && finalItems[0].resolved === false && finalItems[0].historical === false,
  JSON.stringify(finalItems));

// R7: a DIFFERENT blockId still appends.
const s5 = r(s4, { type: "add_a2ui", blockId: "tool-2", block: block2 });
ok("R7 second distinct blockId appends", s5.items.filter((it: any) => it.kind === "a2ui").length === 2);

// R8: resolve_a2ui marks the matching card resolved (blockId="tool-1" now
// survives the history round-trip, so the resolve targets it correctly).
const s6 = r(s5, { type: "resolve_a2ui", blockId: "tool-1" });
const resolvedCard = s6.items.find((it: any) => it.kind === "a2ui" && it.blockId === "tool-1");
ok("R8 resolve_a2ui marks resolved", resolvedCard && resolvedCard.resolved === true);

// R9: a set_history WITHOUT the a2ui-id comment (old/legacy persisted
// messages) falls back to an inert client-side id; the card still renders
// historical+resolved and is never confused with a live tool- id.
const s7 = r(empty, {
  type: "set_history",
  messages: [{ role: "assistant", content: `<a2ui-json>${JSON.stringify(block)}</a2ui-json>` }],
});
const legacyItems = s7.items.filter((it: any) => it.kind === "a2ui");
ok("R9 legacy persisted message (no id comment) → inert client-side id",
  legacyItems.length === 1 && legacyItems[0].historical === true && legacyItems[0].resolved === true
    && !String(legacyItems[0].blockId).startsWith("tool-"),
  JSON.stringify(legacyItems));

// R10 (S4 final): the a2ui-id marker MUST NOT leak as an assistant text
// item. After set_history the only items are: the leading real text (if
// any) and the card — never the marker text or an empty bubble.
const s8 = r(empty, {
  type: "set_history",
  messages: [{
    role: "assistant",
    content: `请选择\n<a2ui-json>${JSON.stringify(block)}</a2ui-json>\n<!--a2ui-id:tool-x-->`,
  }],
});
const s8Items = s8.items;
ok("R10a only one assistant text item (the real text, not the marker)",
  s8Items.filter((it: any) => it.kind === "assistant").length === 1 &&
  s8Items.filter((it: any) => it.kind === "assistant")[0].text.trim() === "请选择",
  JSON.stringify(s8Items));
ok("R10b one a2ui card with the live blockId",
  s8Items.filter((it: any) => it.kind === "a2ui").length === 1 &&
  s8Items.filter((it: any) => it.kind === "a2ui")[0].blockId === "tool-x");
ok("R10c no item carries the marker text",
  !s8Items.some((it: any) => typeof it.text === "string" && it.text.includes("a2ui-id")));

console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
