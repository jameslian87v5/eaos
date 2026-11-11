/**
 * A2UI v2 — zod schema for the `show_ui` tool input + result types.
 *
 * Pure (only depends on `zod`), so `capability-provider` and other modules can
 * reference the constants/types without pulling the Claude Agent SDK into their
 * import graph. The SDK MCP tool definition lives in `a2ui-tool.ts`.
 *
 * Design notes:
 *   - The tool input is a FLAT raw shape (type/title/description/fields/items/
 *     actions/timeoutSec), not a top-level discriminated union. SDK
 *     `SdkMcpToolDefinition.inputSchema` is a zod *raw shape* (a flat object of
 *     fields), which cannot express a top-level `oneOf`/discriminated union.
 *     Flat args are also friendlier to GLM's tool-calling than deeply-nested
 *     JSON-schema unions.
 *   - Per-type discrimination (form must have fields+actions, etc.) is enforced
 *     in `parseShowUiArgs` via `zA2UIBlock`, AFTER the flat shape is received.
 *   - `timeoutSec` is extracted and never becomes part of the persisted block.
 *   - Payload caps (Codex review R1): field/action/item counts, string
 *     length, options, metadata — to bound chatStore/WS/React load when the
 *     model (or a replayed legacy message) emits oversized blocks.
 */

import { z } from "zod";
import type { A2UIBlock, A2UIField, A2UIAction, A2UICardItem, A2UIFormItem } from "./a2ui-types.js";

// ─── Limits (Codex review R1) ──────────────────────────────────
export const A2UI_LIMITS = {
  maxFields: 50,
  maxActions: 10,
  maxItems: 100,
  maxOptions: 200,
  maxStringLen: 2000,
  maxDescriptionLen: 4000,
  maxTitleLen: 200,
  maxMetadataKeys: 50,
  maxIdLen: 100,
} as const;

const strCap = (max: number) => z.string().max(max);
const idStr = strCap(A2UI_LIMITS.maxIdLen).min(1);

const zOption = z.object({
  label: strCap(A2UI_LIMITS.maxStringLen).min(1),
  value: strCap(A2UI_LIMITS.maxStringLen).min(1),
});

const zAction = z.object({
  id: idStr,
  label: strCap(A2UI_LIMITS.maxStringLen).min(1),
  style: z.enum(["primary", "secondary", "danger"]).optional(),
});

const zField = z.object({
  id: idStr,
  // Canonical v2 types ONLY (Codex S1 review): the tool schema is the contract
  // the renderer understands; alias tolerance belongs to the legacy prose
  // parser (a2ui-parser.ts), not here. A misspelled type must fail loudly so
  // the model self-corrects via the isError feedback.
  type: z.enum(["text", "textarea", "select", "multi-select", "number", "boolean", "date"]),
  label: strCap(A2UI_LIMITS.maxStringLen).min(1),
  description: strCap(A2UI_LIMITS.maxDescriptionLen).optional(),
  placeholder: strCap(A2UI_LIMITS.maxStringLen).optional(),
  options: z.array(zOption).max(A2UI_LIMITS.maxOptions).optional(),
  required: z.boolean().optional(),
  default: z.union([
    strCap(A2UI_LIMITS.maxStringLen),
    z.number(),
    z.boolean(),
    z.array(strCap(A2UI_LIMITS.maxStringLen)).max(A2UI_LIMITS.maxOptions),
  ]).optional(),
  // Codex S2 edge review: a choice field without options is meaningless — the
  // validator can then enforce membership UNCONDITIONALLY (no "no options →
  // anything goes" hole). Schema-validated blocks always have ≥1 option.
}).superRefine((f, ctx) => {
  if (f.type === "select" || f.type === "multi-select") {
    if (!f.options || f.options.length === 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "choice 字段必须提供非空 options" });
    }
  }
});

const zCardItem = z.object({
  title: strCap(A2UI_LIMITS.maxStringLen).min(1),
  subtitle: strCap(A2UI_LIMITS.maxStringLen).optional(),
  description: strCap(A2UI_LIMITS.maxDescriptionLen).optional(),
  metadata: z.record(z.string(), strCap(A2UI_LIMITS.maxStringLen))
    .refine((r) => Object.keys(r).length <= A2UI_LIMITS.maxMetadataKeys)
    .optional(),
});

const zFormItem = z.object({
  key: strCap(A2UI_LIMITS.maxIdLen).min(1),
  label: strCap(A2UI_LIMITS.maxStringLen).min(1),
  value: strCap(A2UI_LIMITS.maxStringLen),
});

// ─── Block union (for post-flat re-validation) ─────────────────
export const zA2UIBlock = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("form"),
    title: strCap(A2UI_LIMITS.maxTitleLen).min(1),
    description: strCap(A2UI_LIMITS.maxDescriptionLen).optional(),
    fields: z.array(zField).min(1).max(A2UI_LIMITS.maxFields),
    actions: z.array(zAction).min(1).max(A2UI_LIMITS.maxActions),
  }),
  z.object({
    type: z.literal("confirm"),
    title: strCap(A2UI_LIMITS.maxTitleLen).min(1),
    description: strCap(A2UI_LIMITS.maxDescriptionLen).optional(),
    actions: z.array(zAction).min(1).max(A2UI_LIMITS.maxActions),
  }),
  z.object({
    type: z.literal("card"),
    title: strCap(A2UI_LIMITS.maxTitleLen).min(1),
    description: strCap(A2UI_LIMITS.maxDescriptionLen).optional(),
    items: z.array(zCardItem).max(A2UI_LIMITS.maxItems).optional(),
    // Required (Codex S1 review): a tool-backed card blocks until an action is
    // picked — with zero actions the only exit is the timeout.
    actions: z.array(zAction).min(1).max(A2UI_LIMITS.maxActions),
  }),
  z.object({
    type: z.literal("list"),
    title: strCap(A2UI_LIMITS.maxTitleLen).min(1),
    description: strCap(A2UI_LIMITS.maxDescriptionLen).optional(),
    items: z.array(zFormItem).min(1).max(A2UI_LIMITS.maxItems),
    actions: z.array(zAction).min(1).max(A2UI_LIMITS.maxActions),
  }),
]);

// ─── Tool input raw shape (SDK inputSchema) ────────────────────
// Flat; `items` accepts card OR form items (discriminated after parse).
export const showUiInputRawShape = {
  type: z.enum(["form", "confirm", "card", "list"]),
  title: strCap(A2UI_LIMITS.maxTitleLen).min(1),
  description: strCap(A2UI_LIMITS.maxDescriptionLen).optional(),
  fields: z.array(zField).max(A2UI_LIMITS.maxFields).optional(),
  items: z.array(z.union([zCardItem, zFormItem])).max(A2UI_LIMITS.maxItems).optional(),
  actions: z.array(zAction).max(A2UI_LIMITS.maxActions).optional(),
  // Per-call timeout override (seconds). Clamped against the env default by the
  // tool layer; never persisted as part of the block.
  timeoutSec: z.number().int().min(1).max(3600).optional(),
};

export type ShowUiInput = {
  type: "form" | "confirm" | "card" | "list";
  title: string;
  description?: string;
  fields?: A2UIField[];
  items?: A2UICardItem[] | A2UIFormItem[];
  actions?: A2UIAction[];
  timeoutSec?: number;
};

// ─── Tool result payload (serialized as CallToolResult text) ──
export type ShowUiResult =
  | {
      status: "submitted";
      blockId: string;
      actionId: string;
      actionLabel?: string;
      values: Record<string, string | number | boolean | string[]>;
      submittedAt: string;
    }
  | { status: "timeout"; blockId: string; message: string }
  | { status: "cancelled"; blockId: string; message: string }
  | { status: "invalid_block"; blockId?: string; error: string };

export type ShowUiCall = { block: A2UIBlock; timeoutSec?: number };

export function parseShowUiArgs(
  args: unknown
): { block: A2UIBlock; timeoutSec?: number } | { error: string } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { error: "show_ui input must be an object" };
  }
  const { timeoutSec, ...blockCandidate } = args as Record<string, unknown>;
  const result = zA2UIBlock.safeParse(blockCandidate);
  if (!result.success) {
    return { error: `block validation failed: ${result.error.message}` };
  }
  return {
    block: result.data as A2UIBlock,
    timeoutSec: typeof timeoutSec === "number" ? timeoutSec : undefined,
  };
}

/**
 * Validate a WS submit payload against the pending block's declared fields
 * (Codex S2 review #2): required present, per-type shape, select/multi-select
 * values ∈ declared options. Unknown keys are dropped (values ⊆ declared
 * fields). Non-form blocks carry no fields → only the action matters.
 * An invalid submit does NOT consume the pending card — the caller keeps it
 * live so the user (or a fixed client payload) can resubmit.
 */
export function validateShowUiValues(
  block: A2UIBlock,
  values: Record<string, unknown>
):
  | { ok: true; values: Record<string, string | number | boolean | string[]> }
  | { ok: false; error: string } {
  if (block.type !== "form") {
    return { ok: true, values: {} };
  }
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const f of block.fields) {
    const raw = values[f.id];
    // Absent = undefined/null/blank string/EMPTY ARRAY (Codex S2 edge review:
    // a required multi-select with [] is a non-answer).
    const present =
      raw !== undefined &&
      raw !== null &&
      !(typeof raw === "string" && raw.trim() === "") &&
      !(Array.isArray(raw) && raw.length === 0);
    if (f.required && !present) {
      return { ok: false, error: `缺少必填字段 "${f.id}"` };
    }
    if (!present) continue;
    const bad = (why: string) => ({ ok: false as const, error: `字段 "${f.id}" ${why}` });
    switch (f.type) {
      case "text":
      case "textarea":
      case "date":
        if (typeof raw !== "string") return bad("类型应为字符串");
        if (raw.length > A2UI_LIMITS.maxStringLen) return bad("超出长度上限");
        out[f.id] = raw;
        break;
      case "number":
        if (typeof raw !== "number" || !Number.isFinite(raw)) return bad("类型应为数字");
        out[f.id] = raw;
        break;
      case "boolean":
        if (typeof raw !== "boolean") return bad("类型应为布尔");
        out[f.id] = raw;
        break;
      case "select": {
        if (typeof raw !== "string") return bad("类型应为字符串");
        // Unconditional membership (schema guarantees choice fields carry
        // non-empty options; a hand-built block without them rejects all).
        const allowed = new Set((f.options ?? []).map((o) => o.value));
        if (!allowed.has(raw)) return bad("提交了选项之外的值");
        out[f.id] = raw;
        break;
      }
      case "multi-select": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
          return bad("类型应为字符串数组");
        }
        // Codex S2 final review: cap submitted-array length — 201 duplicates
        // of a legal value would otherwise pass membership and land in the
        // tool_result payload unbounded.
        if (raw.length > A2UI_LIMITS.maxOptions) {
          return bad(`提交值数量超过上限 (${A2UI_LIMITS.maxOptions})`);
        }
        const allowed = new Set((f.options ?? []).map((o) => o.value));
        if (raw.some((x) => !allowed.has(x))) {
          return bad("提交了选项之外的值");
        }
        out[f.id] = raw;
        break;
      }
      default:
        return bad(`类型不支持: ${(f as { type: string }).type}`);
    }
  }
  return { ok: true, values: out };
}
