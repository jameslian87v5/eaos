/**
 * A2UI v2 — the in-process `show_ui` MCP tool.
 *
 * `createSdkMcpServer` registers a tool that runs in the SAME process as the
 * SDK query (local runtime) — its handler can `await` a Promise that resolves
 * only when the user submits the rendered card (or the timeout fires), so the
 * submitted values come back as a `tool_result` IN THE SAME SDK TURN.
 *
 * This is the only module besides `ai-client.ts` that imports the Claude Agent
 * SDK. Docker builds its own instance in-container (agent-entry.ts, S3) sharing
 * `a2ui-schema.ts` for validation — the instance cannot be serialized.
 *
 * Lifecycle (owned by Session, see session.ts S2):
 *   handler → onShowUi(call) → Promise<ShowUiResult>
 *   Session.awaitShowUiSubmit: persist synthetic message + broadcast a2ui_block
 *     + register pending(blockId, resolve, timer) + idle-protect
 *   WS a2ui_submit → resolve submitted; timeout/stop/close → cancelled
 *
 * The SDK has TWO timeout walls that would otherwise kill a long-blocking call:
 *   - CLAUDE_CODE_STREAM_CLOSE_TIMEOUT (default 60s) — set in ai-client/agent-entry
 *   - MCP_TOOL_TIMEOUT (per-call hard limit) — set in ai-client/agent-entry
 * Both must exceed A2UI_SUBMIT_TIMEOUT_MS + buffer. Those env are set by the
 * runtime wiring (S2/S3), not here.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  showUiInputRawShape,
  parseShowUiArgs,
  type ShowUiCall,
  type ShowUiResult,
} from "./a2ui-schema.js";

/** MCP tool name as the SDK surfaces it to the model: mcp__<server>__<tool>. */
export const A2UI_INTERNAL_MCP_NAME = "a2ui";
export const SHOW_UI_TOOL_NAME = `mcp__${A2UI_INTERNAL_MCP_NAME}__show_ui`;

/** Default submit deadline (ms). Override via env; clamped to [1s, 1h]. */
export function resolveSubmitTimeoutMs(): number {
  const raw = Number(process.env.A2UI_SUBMIT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < 1000) return 900_000; // 15 min
  return Math.min(Math.max(raw, 1000), 3_600_000); // cap at 1h
}

/** Clamp a per-call override against the env default (never longer than env). */
export function resolveShowUiTimeout(perCallSec?: number): number {
  const envMs = resolveSubmitTimeoutMs();
  if (typeof perCallSec !== "number" || !Number.isFinite(perCallSec)) return envMs;
  return Math.min(Math.max(perCallSec * 1000, 1000), envMs);
}

export const SHOW_UI_TOOL_DESCRIPTION = `弹出一个交互卡片给用户填写/选择/确认，阻塞等待用户提交。

何时调用：
- 用户要你"生成表单/让我选择/让我填写/收集字段"——收集多个结构化字段
- 用户要在多个明确选项间点选（而非用文字回复 1/2/3）
- 动作前确认（"确认删除/执行"）

阻塞语义（务必牢记）：
- 调用后工具不会立即返回，会等待用户在卡片上提交（或超时，默认 15 分钟）
- 提交的值会作为本工具的返回值回到同一轮对话——你拿到结构化结果后直接继续推进，不要重复询问
- 不要在调用本工具的同时又在回复正文里输出 <a2ui-json> 标签——二选一，用工具
- "show_ui" 不是文件格式、不是配置文件、不是 YAML——不要用 Write/Bash 创建任何 .a2ui 文件

块类型：form（字段收集）/ confirm（单按钮确认）/ card（信息展示+可选动作）/ list（可点选列表）。
可选 timeoutSec：本次调用最长等待秒数（1–3600，不超过全局上限）。

返回 JSON：成功 {status:"submitted", actionId, values, ...}；超时 {status:"timeout"}；取消 {status:"cancelled"}。据返回值决定下一步。`;

/** Factory: build the in-process MCP server, wiring the handler to Session. */
export function createA2UISdkMcpServer(
  onShowUi: (call: ShowUiCall) => Promise<ShowUiResult>
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: A2UI_INTERNAL_MCP_NAME,
    alwaysLoad: true, // tool stays in the prompt; never deferred behind tool search
    tools: [
      {
        name: "show_ui",
        description: SHOW_UI_TOOL_DESCRIPTION,
        inputSchema: showUiInputRawShape,
        handler: async (args): Promise<CallToolResult> => {
          const parsed = parseShowUiArgs(args);
          if ("error" in parsed) {
            const err: ShowUiResult = { status: "invalid_block", error: parsed.error };
            return { content: [{ type: "text", text: JSON.stringify(err) }], isError: true };
          }
          const result = await onShowUi({ block: parsed.block, timeoutSec: parsed.timeoutSec });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      },
    ],
  });
}
