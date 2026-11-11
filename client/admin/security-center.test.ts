// Octop absorption M6b — security center client pure-function tests.
//
// Coverage (plan Task 2):
//   - tool tri-state mapping: profile → draft (one state per tool),
//     with overlap-normalization priority (mutual exclusion by construction);
//   - buildToolsConfigPayload: inverse mapping stays mutually exclusive,
//     unknown tools (not in the profile's tools set) are dropped;
//   - platform default is read-only — payload builder refuses (null);
//   - Bash tighten: one click moves Bash allowed → approval only;
//   - drafts are per-profile (no cross-profile merge, org data stays scoped);
//   - dirty detection: unchanged draft is not dirty.
import assert from "node:assert/strict";
import {
  POSTURE_TABS,
  TAB_LABELS,
  deriveToolDraft,
  setToolState,
  tightenBashToApproval,
  buildToolsConfigPayload,
  draftIsDirty,
  type ProfileToolView,
} from "./security-center.js";

// ─── Fixtures ────────────────────────────────────────────────

const baseProfile: ProfileToolView = {
  profileId: "p-1",
  name: "工作区默认",
  orgId: "default-org",
  editable: true,
  inheritsPlatformDefault: false,
  tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
  allowedTools: ["Read", "Grep", "Glob"],
  disallowedTools: ["Edit"],
  approvalRequired: ["Write", "Bash"],
};

const platformDefault: ProfileToolView = {
  profileId: "platform-default",
  name: "default-sandbox",
  orgId: "-",
  editable: false,
  inheritsPlatformDefault: false,
  tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
  allowedTools: ["Read", "Grep", "Glob"],
  disallowedTools: [],
  approvalRequired: ["Write", "Edit", "Bash"],
};

// ─── Tabs are fixed at six ───────────────────────────────────

assert.equal(POSTURE_TABS.length, 6);
assert.deepEqual([...POSTURE_TABS], ["toolApproval", "fileAccess", "sensitiveInfo", "commandProtection", "skillScan", "audit"]);
assert.deepEqual([...Object.values(TAB_LABELS)], ["工具审批", "文件访问", "敏感信息", "命令防护", "技能扫描", "审计日志"]);
console.log("✓ six fixed tabs with labels");

// ─── Tri-state mapping + mutual exclusion by construction ────

{
  const draft = deriveToolDraft(baseProfile);
  assert.equal(draft.states["Read"], "allowed");
  assert.equal(draft.states["Edit"], "disallowed");
  assert.equal(draft.states["Bash"], "approval");
  // Overlap normalization: a (defensive) profile with Bash in BOTH allowed and
  // disallowed must map to ONE state (disallowed wins) so the payload can
  // never re-emit an overlapping config.
  const overlapping: ProfileToolView = {
    ...baseProfile,
    allowedTools: ["Read", "Bash"],
    disallowedTools: ["Bash"],
  };
  const fixed = deriveToolDraft(overlapping);
  assert.equal(fixed.states["Bash"], "disallowed");
  const payload = buildToolsConfigPayload(overlapping, fixed);
  assert.ok(payload);
  assert.ok(!payload.toolsConfig.allowedTools.includes("Bash"));
  assert.ok(payload.toolsConfig.disallowedTools.includes("Bash"));
  console.log("✓ tri-state mapping + overlap normalization (mutual exclusion)");
}

// ─── Payload: inverse mapping, unknown tools dropped ─────────

{
  const draft = deriveToolDraft(baseProfile);
  const payload = buildToolsConfigPayload(baseProfile, draft);
  assert.ok(payload);
  assert.deepEqual([...payload.toolsConfig.tools].sort(), ["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
  assert.deepEqual([...payload.toolsConfig.allowedTools].sort(), ["Glob", "Grep", "Read"]);
  assert.deepEqual([...payload.toolsConfig.disallowedTools], ["Edit"]);
  assert.deepEqual(payload, { toolsConfig: payload.toolsConfig }, "payload has EXACTLY one key: toolsConfig");

  // Unknown tool in draft state → dropped (never submitted to the server).
  const polluted = setToolState(draft, "NuclearLaunch", "allowed");
  const payload2 = buildToolsConfigPayload(baseProfile, polluted);
  assert.ok(payload2);
  assert.ok(!payload2.toolsConfig.allowedTools.includes("NuclearLaunch"));
  assert.ok(!payload2.toolsConfig.tools.includes("NuclearLaunch"));
  console.log("✓ payload inverse mapping; unknown tools dropped");
}

// ─── Platform default read-only ──────────────────────────────

{
  const draft = deriveToolDraft(platformDefault);
  assert.equal(buildToolsConfigPayload(platformDefault, draft), null, "platform default must never produce a write payload");
  console.log("✓ platform default: no write payload (read-only)");
}

// ─── Bash tighten shortcut ───────────────────────────────────

{
  const bashAllowed: ProfileToolView = {
    ...baseProfile,
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
  };
  const draft = deriveToolDraft(bashAllowed);
  assert.equal(draft.states["Bash"], "allowed");
  const tightened = tightenBashToApproval(draft);
  assert.equal(tightened.states["Bash"], "approval");
  const payload = buildToolsConfigPayload(bashAllowed, tightened);
  assert.ok(payload);
  assert.ok(!payload.toolsConfig.allowedTools.includes("Bash"));
  assert.ok(!payload.toolsConfig.disallowedTools.includes("Bash"), "tighten = approval, NOT disable");
  assert.ok(payload.toolsConfig.tools.includes("Bash"));
  // Tighten on a profile where Bash is already approval/disallowed is a no-op.
  const noChange = tightenBashToApproval(deriveToolDraft(baseProfile));
  assert.equal(noChange.states["Bash"], "approval");
  const disallowedBash: ProfileToolView = { ...baseProfile, disallowedTools: ["Edit", "Bash"] };
  assert.equal(tightenBashToApproval(deriveToolDraft(disallowedBash)).states["Bash"], "disallowed");
  console.log("✓ Bash tighten: allowed → approval only (never disables, never bypasses)");
}

// ─── Per-profile isolation (no cross-profile/org merge) ──────

{
  const other: ProfileToolView = { ...baseProfile, profileId: "p-2", orgId: "org-b", allowedTools: ["Read", "Bash"] };
  const d1 = deriveToolDraft(baseProfile);
  const d2 = deriveToolDraft(other);
  const d1Edited = setToolState(d1, "Write", "disallowed");
  assert.equal(d2.states["Write"], "approval", "editing profile 1 must not touch profile 2's draft");
  assert.equal(d1Edited.states["Write"], "disallowed");
  assert.equal(d1.states["Write"], "approval", "setToolState returns a new draft (no in-place mutation)");
  console.log("✓ drafts are per-profile; setToolState is immutable");
}

// ─── Dirty detection ─────────────────────────────────────────

{
  const draft = deriveToolDraft(baseProfile);
  assert.equal(draftIsDirty(baseProfile, draft), false, "fresh draft mirrors the profile (not dirty)");
  const edited = setToolState(draft, "Write", "disallowed");
  assert.equal(draftIsDirty(baseProfile, edited), true);
  // Round-trip: a draft whose payload equals the profile is not dirty.
  const same = setToolState(setToolState(draft, "Write", "disallowed"), "Write", "approval");
  assert.equal(draftIsDirty(baseProfile, same), false);
  console.log("✓ dirty detection (round-trip stable)");

  const fresh = deriveToolDraft(platformDefault);
  assert.equal(draftIsDirty(platformDefault, fresh), false);
}

console.log("\nsecurity-center pure functions: all assertions passed.");
