// Run: npx tsx client/admin/plugins-ui.test.ts
// M6 residual UI closure (evt_20261023054637): pure helpers of the
// /admin/plugins page. Pins the status hierarchy (error-first), the
// enable-toggle eligibility rules (governance: user-submitted packages must
// only be enabled via the /admin/user-skills approve flow), filtering,
// counts, and import-warning surfacing.
import assert from "node:assert/strict";
import {
  pluginStatusMeta,
  pluginTypeMeta,
  isUserSubmitted,
  canToggleEnabled,
  toggleDisabledReason,
  toggleEndpoint,
  filterPlugins,
  pluginCounts,
  importWarnings,
  buildLedgerMap,
  submissionStatusFor,
  submissionStatusMeta,
  countPendingReview,
  type InstalledPlugin,
} from "./plugins-ui.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

const skill = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  name: "demo-skill",
  type: "skill",
  version: "1.0.0",
  description: "a demo skill",
  enabled: true,
  valid: true,
  path: "plugins/demo-skill",
  ...over,
});

// ─── status hierarchy: error outranks enabled ──────────────────
ok("valid + enabled → 已启用/green", pluginStatusMeta(skill()).label === "已启用" && pluginStatusMeta(skill()).tone === "green");
ok("invalid but enabled → 无效/red (error-first)", pluginStatusMeta(skill({ valid: false, error: "manifest missing" })).label === "无效" && pluginStatusMeta(skill({ valid: false })).tone === "red");
ok("valid but disabled → 已停用/gray", pluginStatusMeta(skill({ enabled: false })).label === "已停用" && pluginStatusMeta(skill({ enabled: false })).tone === "gray");

// ─── type metadata ─────────────────────────────────────────────
ok("skill type badge", pluginTypeMeta(skill()).label === "skill" && pluginTypeMeta(skill()).tone === "blue");
const hook = skill({ name: "demo-hook", type: "hook-plugin" as const });
ok("hook-plugin type badge", pluginTypeMeta(hook).label === "hook-plugin" && pluginTypeMeta(hook).tone === "purple");

// ─── user-submitted detection + governance guard (provenance-based) ──
const quarantined = skill({
  name: "user-sub-1",
  path: "skills/quarantine/user-sub-1",
  enabled: false,
  submittedBy: "user-uuid-1",
  submissionId: "m7b-1",
});
ok("submittedBy provenance detected as user-submitted", isUserSubmitted(quarantined));
ok("admin M3 ZIP under skills/quarantine (no submitter) is NOT user-submitted", !isUserSubmitted(skill({ name: "admin-zip", path: "skills/quarantine/admin-zip", enabled: false })));
ok("regular plugin path is not user-submitted", !isUserSubmitted(skill()));
ok("approved user-submitted row (still has submitter) stays user-submitted", isUserSubmitted(skill({ name: "user-sub-2", path: "plugins/user-sub-2", submittedBy: "user-uuid-2" })));
ok("empty submittedBy treated as absent (legacy rows)", !isUserSubmitted(skill({ submittedBy: "" })));
ok("user-submitted rows can NEVER use the global toggle (M7b approve flow owns enable)", !canToggleEnabled(quarantined));
ok("user-submitted toggle reason points to the review page", (toggleDisabledReason(quarantined) ?? "").includes("用户技能审核"));
ok("admin M3 ZIP quarantined row IS toggle-eligible when valid (fix-round P1)", canToggleEnabled(skill({ name: "admin-zip", path: "skills/quarantine/admin-zip", enabled: false })));
ok("invalid admin M3 ZIP row still not toggle-eligible", !canToggleEnabled(skill({ name: "admin-zip", path: "skills/quarantine/admin-zip", valid: false })));

// ─── toggle eligibility ────────────────────────────────────────
ok("valid skill row can toggle", canToggleEnabled(skill()));
ok("invalid skill row cannot toggle", !canToggleEnabled(skill({ valid: false })));
ok("hook-plugin row cannot toggle (no route)", !canToggleEnabled(hook));
ok("hook-plugin toggle reason explains re-import", (toggleDisabledReason(hook) ?? "").includes("hook-plugin"));
ok("invalid row toggle reason mentions validation", (toggleDisabledReason(skill({ valid: false })) ?? "").includes("校验"));
ok("valid skill toggle reason is null", toggleDisabledReason(skill()) === null);

// ─── toggle endpoint shape ─────────────────────────────────────
ok("enable endpoint", toggleEndpoint(skill(), true) === "/api/admin/skills/demo-skill/enable");
ok("disable endpoint", toggleEndpoint(skill(), false) === "/api/admin/skills/demo-skill/disable");
ok("name is URL-encoded", toggleEndpoint(skill({ name: "a b" }), true) === "/api/admin/skills/a%20b/enable");

// ─── filtering + counts ────────────────────────────────────────
const list = [skill(), skill({ name: "s2", enabled: false }), hook, quarantined, skill({ name: "bad", valid: false })];
ok("filter all keeps everything", filterPlugins(list, "all").length === 5);
ok("filter skill", filterPlugins(list, "skill").length === 4 && filterPlugins(list, "skill").every((p) => p.type === "skill"));
ok("filter hook-plugin", filterPlugins(list, "hook-plugin").length === 1 && filterPlugins(list, "hook-plugin")[0].name === "demo-hook");
const counts = pluginCounts(list);
ok("counts aggregate correctly", counts.total === 5 && counts.skill === 4 && counts.hookPlugin === 1 && counts.enabled === 3 && counts.invalid === 1);

// ─── M7b submission status via ledger (fix 2) ──────────────────
const ledger = buildLedgerMap([
  { id: "m7b-1", status: "approved" },
  { id: "m7b-2", status: "pending_review" },
  { id: "m7b-3", status: "rejected" },
  { id: "m7b-4", status: "quarantined" },
  { id: "m7b-bad" },
  { status: "approved" },
]);
ok("ledger map skips malformed records", ledger.size === 4);

const pendingRow = skill({ name: "p-row", submittedBy: "u1", submissionId: "m7b-2", enabled: false });
const approvedRow = skill({ name: "a-row", submittedBy: "u2", submissionId: "m7b-1", enabled: true });
const rejectedRow = skill({ name: "r-row", submittedBy: "u3", submissionId: "m7b-3", enabled: false });
const quarantinedRow = skill({ name: "q-row", submittedBy: "u4", submissionId: "m7b-4", enabled: false });
const ledgerMissRow = skill({ name: "m-row", submittedBy: "u5", submissionId: "m7b-gone", enabled: false });

ok("pending_review maps from ledger", submissionStatusFor(pendingRow, ledger) === "pending_review");
ok("approved maps from ledger (registry row only carries provenance)", submissionStatusFor(approvedRow, ledger) === "approved");
ok("rejected maps from ledger", submissionStatusFor(rejectedRow, ledger) === "rejected");
ok("quarantined maps from ledger", submissionStatusFor(quarantinedRow, ledger) === "quarantined");
ok("ledger miss → unknown (fail-soft, NOT pending)", submissionStatusFor(ledgerMissRow, ledger) === "unknown");
ok("non-user-submitted row is not pending", submissionStatusFor(skill(), ledger) === "unknown");
ok("empty ledger → every provenance row unknown", submissionStatusFor(approvedRow, new Map()) === "unknown");

ok("pending label", submissionStatusMeta("pending_review").label === "用户提交待审");
ok("approved label", submissionStatusMeta("approved").label === "用户提交已通过" && submissionStatusMeta("approved").tone === "green");
ok("rejected label", submissionStatusMeta("rejected").label === "用户提交已拒绝" && submissionStatusMeta("rejected").tone === "red");
ok("quarantined label", submissionStatusMeta("quarantined").label === "用户提交已隔离");
ok("unknown label is neutral", submissionStatusMeta("unknown").label === "用户提交" && submissionStatusMeta("unknown").tone === "gray");

// Count ONLY pending_review — approved/rejected rows are resolved, not pending.
const reviewList = [skill(), pendingRow, approvedRow, rejectedRow, quarantinedRow, ledgerMissRow];
ok("countPendingReview counts only pending_review", countPendingReview(reviewList, ledger) === 1, `got ${countPendingReview(reviewList, ledger)}`);
ok("countPendingReview with empty ledger → 0 (fail-soft)", countPendingReview(reviewList, new Map()) === 0);

// The governance guard is status-independent: approved rows keep no global toggle.
ok("approved user-submitted row STILL cannot use the global toggle", !canToggleEnabled(approvedRow));
ok("rejected user-submitted row cannot use the global toggle", !canToggleEnabled(rejectedRow));

// ─── import warnings surfacing ─────────────────────────────────
ok("warnings array surfaced", importWarnings({ warnings: ["scripts/ found", "no LICENSE"] }).length === 2);
ok("missing warnings → empty", importWarnings({ resourceId: "x" }).length === 0);
ok("null result → empty", importWarnings(null).length === 0);
ok("non-string entries filtered", importWarnings({ warnings: ["ok", 42 as unknown as string] }).length === 1);

console.log(`\nAll ${pass} assertions passed.`);
