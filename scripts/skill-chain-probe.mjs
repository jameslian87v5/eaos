/**
 * Deterministic probe of capabilityProvider.resolve() against the real
 * control-plane data (data/skills.json, entitlements.json, agent-capabilities.json).
 * Proves the "Skill" tool injection + entitlement gating logic WITHOUT the LLM API.
 *
 * Usage: npx tsx scripts/skill-chain-probe.mjs
 */
import { capabilityProvider } from "../server/capability-provider.js";

function summarize(label, ctx) {
  const b = capabilityProvider.resolve(ctx);
  const o = b.sdkOptions;
  console.log(`\n=== ${label} ===`);
  console.log(`  ctx:        ${JSON.stringify(ctx)}`);
  console.log(`  tools:      ${JSON.stringify(o.tools)}`);
  console.log(`  hasSkill:   ${o.tools?.includes("Skill")}`);
  console.log(`  skills:     ${JSON.stringify(o.skills)}`);
  console.log(`  plugins:    ${JSON.stringify(o.plugins?.map((p) => p.path))}`);
  console.log(`  mounts:     ${JSON.stringify(b.mounts.map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ":ro" : ""}`))}`);
}

// Real agent ids from data/agent-capabilities.json
const CONFIGURED_EMPTY = "85424175-25bd-4fa5-aa17-7de1ffa7de3b"; // []
const HELLO_ENABLED    = "93c538f3-b6c5-4085-892b-a4e130058a0f"; // ["hello-skill"]
// Entitled user for hello-skill (from data/entitlements.json)
const ENTITLED_USER    = "tester";
const RANDOM_USER      = "nobody-unentitled";

// 1. Startup/default: no chatId → legacy all-enabled fallback
summarize("1. default (no agent, legacy fallback)", { runtimeType: "docker" });

// 2. Configured-empty agent → activation-gated → 0 skills → no "Skill" tool
summarize("2. configured-empty agent (user)", {
  userId: ENTITLED_USER, chatId: CONFIGURED_EMPTY, role: "user", runtimeType: "docker",
});

// 3. hello-skill enabled + owner entitled → 1 skill → "Skill" exposed
summarize("3. hello-skill enabled, ENTITLED user", {
  userId: ENTITLED_USER, chatId: HELLO_ENABLED, role: "user", runtimeType: "docker",
});

// 4. hello-skill enabled but owner NOT entitled → revocation backstop → 0 skills
summarize("4. hello-skill enabled, UNENTITLED user (backstop)", {
  userId: RANDOM_USER, chatId: HELLO_ENABLED, role: "user", runtimeType: "docker",
});

// 5. same as 4 but admin → admin-bypass → 1 skill
summarize("5. hello-skill enabled, UNENTITLED but ADMIN (bypass)", {
  userId: RANDOM_USER, chatId: HELLO_ENABLED, role: "admin", runtimeType: "docker",
});

console.log("\n--- done ---");
