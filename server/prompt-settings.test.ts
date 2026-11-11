// Run: npm run test:prompt-settings
// Hermetic: PROMPT_SETTINGS_FILE → temp file (set by the npm script).
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getPromptSettings,
  savePromptSettings,
  defaultPromptSettings,
} from "./prompt-settings.js";
import { capabilityProvider } from "./capability-provider.js";

const FILE = process.env.PROMPT_SETTINGS_FILE!;
if (fs.existsSync(FILE)) fs.unlinkSync(FILE);

// 1. Absent file → defaults (behavior unchanged from the old hard-coded constants).
const d = getPromptSettings(true);
assert.equal(d.systemPrompt, defaultPromptSettings.systemPrompt, "absent file → default systemPrompt");
assert.equal(d.appendBase, defaultPromptSettings.appendBase, "absent file → default appendBase");
// getPromptSettings() returns a defensive copy each call, so compare by value.
assert.deepEqual(getPromptSettings(), d, "cached read is stable");

// 2. Save persists + reloads (forceReload picks up disk state).
savePromptSettings({ systemPrompt: "CUSTOM_PERSONA\n" });
assert.equal(
  getPromptSettings(true).systemPrompt,
  "CUSTOM_PERSONA\n",
  "saved systemPrompt persisted + reloaded"
);
// appendBase untouched by partial patch.
assert.equal(
  getPromptSettings(true).appendBase,
  defaultPromptSettings.appendBase,
  "partial patch leaves appendBase at default"
);

// 3. Sanitize: C0 control chars (except \t\n\r) stripped on save.
savePromptSettings({ systemPrompt: "a\x00b\x07c\td\ne" });
assert.equal(
  getPromptSettings(true).systemPrompt,
  "abc\td\ne",
  "control chars stripped (tab/newline kept)"
);

// 4. Length bound: oversized systemPrompt rejected at save.
assert.throws(
  () => savePromptSettings({ systemPrompt: "x".repeat(9000) }), // > default maxSystemPromptChars(8000)
  /systemPrompt too long/i,
  "oversized systemPrompt rejected"
);

// 5. maxSystemPromptChars knob is clamped to its own bound (256..50000).
savePromptSettings({ maxSystemPromptChars: 10 });
assert.equal(
  getPromptSettings(true).maxSystemPromptChars,
  256,
  "maxSystemPromptChars clamped to min 256"
);

// Reset to defaults before the integration check — steps 2-5 mutated the cache,
// so resolve() below must read the platform DEFAULTS, not the last saved value.
if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
getPromptSettings(true);

// 6. Integration: capability-provider.resolve() composes from prompt-settings
//    (Phase 2e wiring). A no-agentId resolve yields the platform systemPrompt.
//    startsWith (not ===) so it holds whether or not A2UI is enabled in this env.
const bundle = capabilityProvider.resolve({ runtimeType: "docker" });
assert.ok(
  bundle.sdkOptions.systemPrompt!.startsWith(defaultPromptSettings.systemPrompt),
  "resolve() composes systemPrompt from prompt-settings defaults"
);
assert.ok(
  bundle.sdkOptions.appendSystemPrompt!.includes(defaultPromptSettings.appendBase.slice(0, 20)),
  "resolve() composes appendSystemPrompt from prompt-settings appendBase"
);

// 7. Regression guard: the default systemPrompt/appendBase are byte-identical to
//    the pre-Phase-2e hard-coded constants (so behavior is unchanged until edited).
assert.equal(
  defaultPromptSettings.systemPrompt,
  "你是企业内部 AI Agent，运行在隔离的 Docker workspace 中。" +
    "你可以帮助用户分析文件、编辑内容、生成结果，并在需要时使用工具完成任务。\n\n",
  "default systemPrompt unchanged from pre-2e constant"
);
assert.equal(
  defaultPromptSettings.appendBase,
  "重要：你运行在 Docker 容器中，当前工作目录（cwd）是 /workspace。\n" +
    "所有文件操作必须基于 /workspace 目录。不要猜测或编造其他路径。\n" +
    "如果你不确定目录内容，请先执行 `pwd` 和 `ls /workspace`。\n" +
    "用户上传文件位于 /workspace/input。\n" +
    "生成文件请保存到 /workspace/output。\n" +
    "运行时依赖应安装在 /workspace 内，例如 node_modules、.venv、.cache。\n" +
    "如需写文件、编辑文件或执行 Bash，系统可能要求用户确认。",
  "default appendBase unchanged from pre-2e constant"
);

// Cleanup (guard: the mid-test reset in step 6 may already have removed it).
if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
console.log("prompt-settings tests passed");
