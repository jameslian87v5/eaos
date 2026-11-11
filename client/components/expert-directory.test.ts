// Run: npx tsx client/components/expert-directory.test.ts
// M7a: pure helpers of the My Experts directory + edit drawer. UX-level only —
// the server re-validates every edit; these tests pin the client derive/dirty/
// whitelist/diff behavior so the drawer never sends fields the server owns.
import assert from "node:assert/strict";
import {
  deriveExpertDraft,
  isDraftDirty,
  validateExpertDraft,
  buildEditPayload,
  addQuickPrompt,
  updateQuickPrompt,
  removeQuickPrompt,
  buildCapabilityDiff,
  templateDisplayName,
  type ExpertRow,
  type QuickPrompt,
  type CapabilityState,
  type CapabilityOption,
} from "./expert-directory.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const AGENT: ExpertRow = {
  id: "agent-1",
  title: "翻译助手",
  description: "中英互译",
  templateId: "blank",
  welcomeMessage: "你好",
  quickPrompts: [{ title: "翻译这句", prompt: "请翻译" }],
  updatedAt: "2026-10-22T00:00:00Z",
};

// ─── derive / dirty ───────────────────────────────────────────

{
  const draft = deriveExpertDraft(AGENT);
  ok("draft derives from the server row", draft.name === "翻译助手" && draft.welcomeMessage === "你好" && draft.quickPrompts.length === 1);
  ok("derived draft is not dirty", !isDraftDirty(AGENT, draft));

  const nullStarter: ExpertRow = { id: "agent-2", title: "空专家" };
  const draft2 = deriveExpertDraft(nullStarter);
  ok("null starter derives an empty draft", draft2.welcomeMessage === "" && draft2.quickPrompts.length === 0);
  ok("empty draft on null-starter row is not dirty", !isDraftDirty(nullStarter, draft2));

  ok("name change is dirty", isDraftDirty(AGENT, { ...draft, name: "改名" }));
  ok("welcome change is dirty", isDraftDirty(AGENT, { ...draft, welcomeMessage: "新欢迎" }));
  ok("welcome clear is dirty", isDraftDirty(AGENT, { ...draft, welcomeMessage: "" }));
  ok("quickPrompt content change is dirty", isDraftDirty(AGENT, { ...draft, quickPrompts: [{ title: "翻译这句", prompt: "别的" }] }));
  ok("quickPrompt added is dirty", isDraftDirty(AGENT, { ...draft, quickPrompts: [...draft.quickPrompts, { title: "b", prompt: "p" }] }));
  ok("whitespace-only edits are NOT dirty", !isDraftDirty(AGENT, { ...draft, name: ` ${draft.name} ` }));
  ok("trimmed quickPrompt text equal is NOT dirty", !isDraftDirty(AGENT, { ...draft, quickPrompts: [{ title: " 翻译这句 ", prompt: " 请翻译 " }] }));
}

// ─── validation ───────────────────────────────────────────────

{
  const draft = deriveExpertDraft(AGENT);
  ok("valid draft passes", validateExpertDraft(draft) === null);
  ok("blank name rejected", validateExpertDraft({ ...draft, name: "   " }) !== null);
  ok("over-length name rejected", validateExpertDraft({ ...draft, name: "x".repeat(65) }) !== null);
  ok("over-length welcome rejected (1000)", validateExpertDraft({ ...draft, welcomeMessage: "x".repeat(1001) }) !== null);
  ok("7 quick prompts rejected", validateExpertDraft({ ...draft, quickPrompts: Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}` })) }) !== null);
  ok("half-filled quick prompt rejected", validateExpertDraft({ ...draft, quickPrompts: [{ title: "t", prompt: "" }] }) !== null);
  ok("over-length quick title rejected", validateExpertDraft({ ...draft, quickPrompts: [{ title: "x".repeat(51), prompt: "p" }] }) !== null);
  ok("over-length quick prompt rejected", validateExpertDraft({ ...draft, quickPrompts: [{ title: "t", prompt: "x".repeat(501) }] }) !== null);
}

// ─── payload whitelist ────────────────────────────────────────

{
  const draft: ExpertRow = AGENT;
  const payload = buildEditPayload(deriveExpertDraft(draft));
  const keys = Object.keys(payload).sort();
  ok("payload is exactly the three editable fields", JSON.stringify(keys) === JSON.stringify(["name", "quickPrompts", "welcomeMessage"]), `keys=${keys.join(",")}`);
  ok(
    "payload carries no control-plane keys",
    !("ownerUserId" in payload) && !("orgId" in payload) && !("status" in payload) && !("templateId" in payload) && !("appId" in payload)
  );
  ok("payload values are trimmed", payload.name === "翻译助手");
  ok("empty quickPrompts serializes as [] (clear)", JSON.stringify(buildEditPayload({ ...deriveExpertDraft(draft), quickPrompts: [] }).quickPrompts) === "[]");
  // Even a hostile caller cannot smuggle extra keys through the builder.
  const smuggle = buildEditPayload({ name: "n", welcomeMessage: "", quickPrompts: [] } as never);
  ok("hostile input yields the same 3-key shape", Object.keys(smuggle).length === 3);
}

// ─── quick prompt list editing ────────────────────────────────

{
  const base: QuickPrompt[] = [{ title: "a", prompt: "b" }];
  ok("add appends an empty pair", addQuickPrompt(base).length === 2 && addQuickPrompt(base)[1].title === "");
  ok("update patches only index i", JSON.stringify(updateQuickPrompt(base, 0, { title: "z" })) === JSON.stringify([{ title: "z", prompt: "b" }]));
  ok("remove drops index i", removeQuickPrompt([...base, { title: "c", prompt: "d" }], 0).length === 1);
  ok("list helpers do not mutate input", base[0].title === "a" && base.length === 1);
}

// ─── capability diff ──────────────────────────────────────────

{
  const options: CapabilityOption[] = [
    { resourceId: "skill-a", type: "skill", name: "A" },
    { resourceId: "skill-b", type: "skill", name: "B" },
  ];
  const current: CapabilityState[] = [
    { resourceId: "skill-a", name: "A", enabled: true },
    { resourceId: "skill-b", name: "B", enabled: false },
  ];

  ok(
    "no-op selection sends an empty diff",
    buildCapabilityDiff(current, ["skill-a"], options).resources.length === 0
  );
  ok(
    "flip emits only the changed entry",
    JSON.stringify(buildCapabilityDiff(current, ["skill-a", "skill-b"], options).resources) ===
      JSON.stringify([{ resourceId: "skill-b", enabled: true }])
  );
  ok(
    "disable emits enabled:false",
    JSON.stringify(buildCapabilityDiff(current, [], options).resources) ===
      JSON.stringify([{ resourceId: "skill-a", enabled: false }])
  );
  ok(
    "newly checked option (not in current) is enabled",
    buildCapabilityDiff([], ["skill-a"], options).resources.length === 1 &&
      buildCapabilityDiff([], ["skill-a"], options).resources[0].enabled === true
  );
  ok(
    "stale/non-option ids can never ride into the diff",
    JSON.stringify(buildCapabilityDiff(current, ["skill-a", "ghost-id"], options).resources) === "[]"
  );
}

// ─── template display name ────────────────────────────────────

{
  const templates = [
    { id: "blank", name: "空白助手" },
    { id: "doc-analysis", name: "文档分析" },
  ];
  ok("templateId maps to its display name", templateDisplayName("blank", templates) === "空白助手");
  ok("unknown templateId falls back", templateDisplayName("ghost", templates) === "自定义");
  ok("null templateId falls back", templateDisplayName(null, templates) === "自定义");
}

console.log(`\nAll ${pass} assertions passed.`);
