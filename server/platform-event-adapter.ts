/**
 * platform-event-adapter.ts — M3-S2 R1: Session consumption of
 * PlatformRuntimeEvent.
 *
 * Session.handleSDKMessage speaks the SDK message shape (assistant / user /
 * approval_request / a2ui_request / result / system) — that contract is what
 * Local and Docker feed it today, and it must NOT change (raw Claude paths
 * preserved). The local-sandbox MicrosandboxAgentRuntime instead yields the
 * platform-neutral PlatformRuntimeEvent. This adapter is the small step the
 * M3 plan prescribes: translate platform events into the SDK shapes the
 * EXISTING Session behavior already handles — no Session refactor, no second
 * orchestration path.
 *
 * Mapping (one platform event → 0..n SDK-shaped messages):
 *   assistant_text            → assistant (string content)          → broadcastAssistantText
 *   tool_requested            → assistant (tool_use block)          → tool_use record + broadcast
 *   tool_result               → user (tool_result block)            → tool_result record + broadcast
 *   approval_request          → approval_request (docker-IPC shape) → approval flow + handleApprovalResponse
 *   a2ui_request              → a2ui_request (identical shape)      → A2UI v2 core + forwardA2UiResult
 *   turn_completed            → result (success, usage/cost/duration) → run finalization + busy release
 *   turn_failed               → result (error, category+message)    → failed run + busy release
 *   runtime_error             → result (error)                      → surfaced failure + busy release
 *   context_compacted         → system compact_boundary             → compact notice + gate release
 *   runtime_ready/session_updated/workspace_changed → internal
 *   lifecycle (not consumed by Session today; workspace_changed output
 *   scanning is docker-gated — local-sandbox parity is a later wiring
 *   decision, not silently enabled here).
 *
 * Unknown future event types map to NOTHING (forward-compatible no-op) —
 * never a crash, never a guessed shape.
 */

import type { PlatformRuntimeEvent } from "./platform-runtime-protocol.js";
import type { AgentRuntime, RuntimeEvent } from "./agent-runtime.js";

/** SDK message shapes consumed by Session.handleSDKMessage (structural — no SDK import). */
type SdkMessage = RuntimeEvent;

function resultError(message: string): SdkMessage {
  return { type: "result", subtype: "error_during_execution", result: message };
}

/** Map one platform event into 0..n SDK-shaped messages. */
export function platformEventToSdkMessages(event: PlatformRuntimeEvent): SdkMessage[] {
  switch (event.type) {
    case "assistant_text":
      return [{ type: "assistant", message: { content: event.text } }];

    case "tool_requested":
      return [{
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: event.toolCallId,
            name: event.toolName,
            input: event.input ?? {},
          }],
        },
      }];

    case "tool_result":
      return [{
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: event.toolCallId,
            content: event.output === undefined ? "" : typeof event.output === "string" ? event.output : JSON.stringify(event.output),
            is_error: !event.success,
          }],
        },
      }];

    case "approval_request":
      // Same shape as the docker IPC approval_request — Session's existing
      // branch (sessionAllowedTools auto-approve, broadcast, pending map) and
      // its handleApprovalResponse routing (→ approval_result command keyed by
      // requestId) drive unchanged.
      return [{
        type: "approval_request",
        id: event.requestId,
        toolName: event.toolName,
        toolInput: event.input,
        toolUseId: event.toolCallId,
      }];

    case "a2ui_request":
      // Identical field shape — Session revalidates the block at the host
      // boundary and routes the terminal result via forwardA2UiResult.
      return [{ type: "a2ui_request", requestId: event.requestId, block: event.block, ...(event.timeoutSec !== undefined ? { timeoutSec: event.timeoutSec } : {}) }];

    case "turn_completed":
      return [{
        type: "result",
        subtype: "success",
        result: "",
        ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
        ...(event.costUsd !== undefined ? { total_cost_usd: event.costUsd } : {}),
        // Platform TokenUsage is camelCase; the SDK result shape Session's
        // extractTokenUsage reads is snake_case (input_tokens etc.) — translate.
        ...(event.usage !== undefined ? {
          usage: {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
            ...(event.usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: event.usage.cacheReadTokens } : {}),
            ...(event.usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: event.usage.cacheWriteTokens } : {}),
          },
        } : {}),
      }];

    case "turn_failed":
      return [resultError(`turn failed (${event.category}): ${event.message}`)];

    case "runtime_error":
      return [resultError(`runtime error (${event.category}): ${event.message}`)];

    case "context_compacted":
      return [{
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          pre_tokens: event.preTokens ?? null,
          post_tokens: event.postTokens ?? null,
          trigger: event.trigger ?? null,
        },
      }];

    default:
      // runtime_ready / session_updated / workspace_changed / future types.
      return [];
  }
}

/**
 * Wrap a platform-event runtime so the EXISTING Session (SDK-shape consumer)
 * drives it unchanged: every method delegates; getEventStream yields the
 * translated messages. Local/Docker runtimes never pass through here.
 */
export function withPlatformEventAdapter(rt: AgentRuntime): AgentRuntime {
  return {
    sendMessage: (content: string) => rt.sendMessage(content),
    getEventStream: async function* (): AsyncIterable<RuntimeEvent> {
      for await (const evt of rt.getEventStream()) {
        for (const msg of platformEventToSdkMessages(evt as PlatformRuntimeEvent)) {
          yield msg;
        }
      }
    },
    ...(rt.handleApprovalResponse ? { handleApprovalResponse: (response: Parameters<NonNullable<AgentRuntime["handleApprovalResponse"]>>[0]) => rt.handleApprovalResponse!(response) } : {}),
    ...(rt.forwardA2UiResult ? { forwardA2UiResult: (...args: Parameters<NonNullable<AgentRuntime["forwardA2UiResult"]>>) => rt.forwardA2UiResult!(...args) } : {}),
    abort: () => rt.abort(),
    close: () => void rt.close(),
    getStatus: () => rt.getStatus(),
  };
}
