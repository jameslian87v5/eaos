// Run: npx tsx client/components/agent-builder.test.ts
// M6a: pure helpers of the expert-creation drawer. UX-level only — the server
// contract re-validates everything; these tests pin the client merge/filter
// behavior (template defaults, quick-prompt normalization, payload whitelist,
// unselectable capability filtering).
import assert from "node:assert/strict";
import {
  initDraftFromTemplate,
  normalizeQuickPrompts,
  validateDraft,
  buildCreatePayload,
  type BuilderTemplate,
  type QuickPrompt,
} from "./agent-builder.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const TEMPLATE: BuilderTemplate = {
  id: "doc-analysis",
  name: "文档分析",
  description: "阅读、总结、提炼文档要点与数据",
  systemPrompt: "你是文档分析专家",
  welcomeMessage: "把文档发给我",
  quickPrompts: [
    { title: "总结文档要点", prompt: "请总结要点" },
    { title: "提取关键数据", prompt: "请提取数据" },
  ],
  icon: "FileText",
  color: "blue",
};

// ─── initDraftFromTemplate ────────────────────────────────────

{
  const draft = initDraftFromTemplate(TEMPLATE);
  ok("draft seeds template preset fields", draft.templateId === "doc-analysis" &&
    draft.description === TEMPLATE.description &&
    draft.systemPrompt === TEMPLATE.systemPrompt &&
    draft.welcomeMessage === TEMPLATE.welcomeMessage);
  ok("draft name starts empty (user types identity in step 2)", draft.name === "");
  ok("draft quickPrompts is a copy, not the template array",
    draft.quickPrompts !== TEMPLATE.quickPrompts &&
    draft.quickPrompts[0] !== TEMPLATE.quickPrompts[0]);
  draft.quickPrompts[0].title = "mutated";
  ok("mutating the draft does not corrupt the template", TEMPLATE.quickPrompts[0].title === "总结文档要点");
}

// ─── normalizeQuickPrompts ────────────────────────────────────

{
  const raw: QuickPrompt[] = [
    { title: "  ", prompt: "" },           // fully empty → dropped
    { title: " t ", prompt: " p " },       // trimmed
    { title: "", prompt: "x" },            // half empty → KEPT (validation flags it)
  ];
  const out = normalizeQuickPrompts(raw);
  ok("fully-empty rows dropped, others trimmed", out.length === 2 &&
    out[0].title === "t" && out[0].prompt === "p");
  ok("half-empty row survives normalization (validateDraft reports it)",
    out[1].title === "" && out[1].prompt === "x");
}

// ─── validateDraft ────────────────────────────────────────────

{
  const draft = initDraftFromTemplate(TEMPLATE);
  ok("empty name rejected", validateDraft(draft) !== null);
  draft.name = "文档专家";
  ok("valid draft passes", validateDraft(draft) === null);
  draft.name = "x".repeat(65);
  ok("over-long name rejected", validateDraft(draft) !== null);
  draft.name = "ok";
  draft.description = "d".repeat(201);
  ok("over-long description rejected", validateDraft(draft) !== null);
  draft.description = "ok";
  draft.welcomeMessage = "w".repeat(501);
  ok("over-long welcome rejected", validateDraft(draft) !== null);
  draft.welcomeMessage = "ok";
  draft.quickPrompts = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, prompt: "p" }));
  ok("too many quick prompts rejected", validateDraft(draft) !== null);
  draft.quickPrompts = [{ title: "a", prompt: " " }];
  ok("half-empty quick prompt rejected", validateDraft(draft) !== null);
  draft.quickPrompts = [{ title: "t".repeat(51), prompt: "p" }];
  ok("over-long quick title rejected", validateDraft(draft) !== null);
}

// ─── buildCreatePayload ───────────────────────────────────────

{
  const draft = initDraftFromTemplate(TEMPLATE);
  draft.name = "  我的文档专家  ";
  draft.quickPrompts = [
    { title: " 总结 ", prompt: " 请总结 " },
    { title: "", prompt: "" }, // dropped
  ];
  const payload = buildCreatePayload(
    draft,
    ["hello-skill", "another-skill"], // server-provided selectable set
    ["hello-skill", "ghost-skill"]    // user selection incl. a non-selectable id
  );
  ok("payload is a strict whitelist (no extra keys)",
    JSON.stringify(Object.keys(payload).sort()) ===
      JSON.stringify(["capabilityIds", "description", "name", "quickPrompts", "systemPrompt", "templateId", "welcomeMessage"].sort()));
  ok("name trimmed", payload.name === "我的文档专家");
  ok("quick prompts normalized in payload", payload.quickPrompts.length === 1 &&
    payload.quickPrompts[0].title === "总结" && payload.quickPrompts[0].prompt === "请总结");
  ok("unselectable capability ids filtered out of the payload",
    payload.capabilityIds.length === 1 && payload.capabilityIds[0] === "hello-skill");
  ok("template preset text carried through", payload.systemPrompt === "你是文档分析专家");
  ok("payload without clientRequestId has no such key", !("clientRequestId" in payload));
  const withId = buildCreatePayload(draft, ["hello-skill"], ["hello-skill"], "req-id-12345678");
  ok("clientRequestId carried into the payload (server idempotency)",
    withId.clientRequestId === "req-id-12345678");
}

console.log(`\nAll ${pass} assertions passed.`);
process.exit(0);
