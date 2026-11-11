/**
 * m8a-fail-closed.test.ts — M8a (plan §9): ai-client.ts 未授权工具空放行改 deny.
 *
 * The PreToolUse hook previously fell through with `{}` (auto-allow) for any
 * tool NOT in allowedTools whenever no approval handler was configured — an
 * approval-gated tool ran silently. Now the fall-through denies, with the
 * single documented Skill exemption (capability-layer injection; invoking it
 * only loads instructions; see decideUnapprovedTool in ai-client.ts).
 *
 * Run: npx tsx server/m8a-fail-closed.test.ts
 */
import assert from "node:assert/strict";
import { decideUnapprovedTool } from "./ai-client.js";

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// F1: the documented exemption — Skill (in `tools`, never in allowedTools by
// design, SDK 0.2.133+) stays auto-allowed so skill-enabled runtimes work
// with approval disabled (M8g browser acceptance path).
ok(
  "F1 Skill → allow (capability-layer exemption)",
  decideUnapprovedTool("Skill").decision === "allow"
);

// F2: approval-gated profile tools deny when no handler is wired.
for (const tool of ["Write", "Edit", "Bash", "mcp__platform-web-tools__web_fetch"]) {
  const d = decideUnapprovedTool(tool);
  ok(
    `F2 approval-gated tool "${tool}" → deny`,
    d.decision === "deny" && d.reason.includes(tool) && d.reason.includes("fail-closed"),
    JSON.stringify(d)
  );
}

// F3: unknown/never-authorized tools (the actual hole) deny.
for (const tool of ["TodoWrite", "Task", "WebSearch", "mcp__rogue__exfiltrate", "SkillFetch"]) {
  ok(
    `F3 unknown tool "${tool}" → deny`,
    decideUnapprovedTool(tool).decision === "deny"
  );
}

// F4: exact-name matching only — no prefix/substring/suffix riding.
for (const fake of ["Skill ", "skill", "MySkill", "Skill_"]) {
  ok(
    `F4 lookalike "${fake}" → deny (exact match only)`,
    decideUnapprovedTool(fake).decision === "deny"
  );
}

console.log(`\nM8a fail-closed: ${pass} assertions passed.`);
