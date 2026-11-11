/**
 * SDK hook precedence experiment (Codex review evt_20260630034307, step 2).
 *
 * Question 1 (precedence): if a platform INLINE PreToolUse hook returns `deny`
 *   while a PLUGIN PreToolUse hook returns `allow`, does the tool still get
 *   blocked? (We need deny-wins for Route A guards to be safe.)
 *
 * Question 2 (updatedInput): if the plugin hook rewrites `tool_input.command`,
 *   does the platform inline hook (and the actual execution) see the original
 *   or the mutated input?
 *
 * Run modes (env EXP_MODE):
 *   deny    → inline hook returns deny. Expect: Bash NOT executed (no marker in result).
 *   observe → inline hook returns allow and logs the command it received.
 *             Expect to learn whether it sees `echo PRECEDENCE_TEST_MARKER`
 *             (original) or `echo PLUGIN_MUTATED_MARKER` (plugin-mutated).
 *
 * Usage:
 *   EXP_MODE=deny    npx tsx scripts/precedence-exp/run.ts
 *   EXP_MODE=observe npx tsx scripts/precedence-exp/run.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, "plugin");
const MODE = (process.env.EXP_MODE || "deny").toLowerCase();
const MODEL = process.env.AGENT_MODEL || "haiku";

const log = (...a: any[]) => console.log("[exp]", ...a);

let inlineHookCalled = 0;
let inlineSawCommand: string | undefined;
const toolUses: Array<{ name: string; input: any }> = [];
const toolResults: string[] = [];
let permissionDenied = false;

async function main() {
  log(`mode=${MODE} model=${MODEL} plugin=${PLUGIN_PATH}`);

  const iterator = query({
    prompt:
      "Use the Bash tool to run exactly this command: echo PRECEDENCE_TEST_MARKER. " +
      "Do not run any other command. After it runs, reply done.",
    options: {
      maxTurns: 3,
      model: MODEL,
      tools: ["Bash"],
      // Force every Bash call through the hook decision (no auto-allow).
      allowedTools: [],
      permissionMode: "default",
      plugins: [{ type: "local", path: PLUGIN_PATH }],
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input: any) => {
                inlineHookCalled++;
                inlineSawCommand = input?.tool_input?.command;
                log(
                  `INLINE PreToolUse fired: tool=${input?.tool_name} command=${JSON.stringify(
                    inlineSawCommand
                  )}`
                );
                if (MODE === "deny") {
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason: "platform inline guard deny",
                    },
                  };
                }
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "allow" as const,
                    permissionDecisionReason: "observe mode allow",
                  },
                };
              },
            ],
          },
        ],
      } as any,
    },
  })[Symbol.asyncIterator]();

  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    const v: any = value;
    if (v?.type === "assistant" && Array.isArray(v.message?.content)) {
      for (const block of v.message.content) {
        if (block.type === "tool_use") {
          toolUses.push({ name: block.name, input: block.input });
          log(`tool_use: ${block.name} input=${JSON.stringify(block.input)}`);
        }
      }
    }
    if (v?.type === "user" && Array.isArray(v.message?.content)) {
      for (const block of v.message.content) {
        if (block.type === "tool_result") {
          const text =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
          toolResults.push(text);
          if (/permission|denied|not allowed/i.test(text)) permissionDenied = true;
          log(`tool_result: ${text.slice(0, 200)}`);
        }
      }
    }
    if (v?.type === "result") {
      log(`result subtype=${v.subtype}`);
    }
  }

  const joinedResults = toolResults.join("\n");
  const executedOriginal = joinedResults.includes("PRECEDENCE_TEST_MARKER");
  const executedMutated = joinedResults.includes("PLUGIN_MUTATED_MARKER");

  console.log("\n================ VERDICT ================");
  console.log(`mode:                 ${MODE}`);
  console.log(`inline hook called:   ${inlineHookCalled}x`);
  console.log(`inline saw command:   ${JSON.stringify(inlineSawCommand)}`);
  console.log(`tool_use count:       ${toolUses.length}`);
  console.log(`bash executed (orig): ${executedOriginal}`);
  console.log(`bash executed (mutd): ${executedMutated}`);
  console.log(`permission denied:    ${permissionDenied}`);
  if (MODE === "deny") {
    if (!executedOriginal && !executedMutated) {
      console.log("=> DENY WINS ✅  platform inline deny blocked the tool despite plugin allow");
    } else {
      console.log("=> DENY LOST ❌  tool executed even though inline hook denied — Route A guard UNSAFE");
    }
  } else {
    console.log(
      executedMutated
        ? "=> MUTATION APPLIED: plugin updatedInput changed the executed command"
        : executedOriginal
        ? "=> MUTATION IGNORED: original command executed"
        : "=> inconclusive (no marker found)"
    );
    console.log(
      "   (compare 'inline saw command' to know if platform guard sees pre- or post-mutation input)"
    );
  }
  console.log("========================================\n");
}

main().catch((e) => {
  console.error("[exp] FAILED:", e);
  process.exit(1);
});
