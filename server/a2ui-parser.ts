/**
 * A2UI block parser.
 *
 * Splits assistant text on <a2ui-json>...</a2ui-json> tags. Each segment is
 * either plain markdown text or a parsed+validated A2UI block. On parse or
 * validation failure, the raw tag content is kept as plain text (graceful
 * degradation — never throw).
 *
 * Mirrors the official A2UI SDK parser pattern:
 *   - regex match for open/close tags
 *   - strip markdown fences
 *   - tolerant JSON parse (trailing commas, smart quotes)
 *   - schema-validate the parsed object
 */

import type { A2UIBlock, A2UIField, A2UIFieldType, A2UIAction, A2UIValidationResult } from "./a2ui-types.js";

export const A2UI_OPEN_TAG = "<a2ui-json>";
export const A2UI_CLOSE_TAG = "</a2ui-json>";

const A2UI_BLOCK_RE = new RegExp(
  `${escapeRe(A2UI_OPEN_TAG)}(.*?)${escapeRe(A2UI_CLOSE_TAG)}`,
  "gs"
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type A2UISegment =
  | { kind: "text"; text: string }
  | { kind: "a2ui"; block: A2UIBlock; raw: string };

/**
 * Split assistant text into ordered segments of markdown + a2ui blocks.
 * Invalid a2ui content degrades to a text segment containing the raw tag body
 * so the user still sees something useful.
 */
export function splitA2UISegments(text: string): A2UISegment[] {
  if (!text || !text.includes(A2UI_OPEN_TAG)) {
    return [{ kind: "text", text }];
  }

  const segments: A2UISegment[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  A2UI_BLOCK_RE.lastIndex = 0;
  while ((match = A2UI_BLOCK_RE.exec(text)) !== null) {
    const [whole, body] = match;
    const start = match.index;
    const end = start + whole.length;

    if (start > lastEnd) {
      const leading = text.slice(lastEnd, start);
      if (leading.trim()) segments.push({ kind: "text", text: leading });
    }

    const result = parseA2UIBlock(body);
    if (result.ok && result.block) {
      segments.push({ kind: "a2ui", block: result.block, raw: body.trim() });
    } else {
      // P0.3: silent-fail. Don't dump raw JSON into the chat — it's noise the
      // user can't act on. Show a minimal notice instead.
      segments.push({
        kind: "text",
        text: "_（一段交互卡片格式不合法，已隐藏）_",
      });
    }

    lastEnd = end;
  }

  if (lastEnd < text.length) {
    const trailing = text.slice(lastEnd);
    if (trailing.trim()) segments.push({ kind: "text", text: trailing });
  }

  return segments;
}

/**
 * Returns true if any complete <a2ui-json>...</a2ui-json> block exists.
 * Used to short-circuit parsing when the flag is off.
 */
export function hasCompleteA2UIBlock(text: string): boolean {
  return text.includes(A2UI_OPEN_TAG) && text.includes(A2UI_CLOSE_TAG);
}

/**
 * If any <a2ui-json> block in the text fails to parse, return its raw body
 * (so the caller can feed it back to the model for regeneration).
 * Returns null if all blocks parse successfully (or no blocks exist).
 */
export function extractFailedA2UIRaw(text: string): string | null {
  if (!hasCompleteA2UIBlock(text)) return null;
  let m: RegExpExecArray | null;
  A2UI_BLOCK_RE.lastIndex = 0;
  while ((m = A2UI_BLOCK_RE.exec(text)) !== null) {
    const result = parseA2UIBlock(m[1]);
    if (!result.ok) {
      return m[1].trim();
    }
  }
  return null;
}

/** Parse and validate a single a2ui block body. */
export function parseA2UIBlock(raw: string): A2UIValidationResult {
  const cleaned = stripMarkdownFences(raw).trim();
  if (!cleaned) return { ok: false, error: "块内容为空" };

  const tolerant = tolerantJsonString(cleaned);
  let data: unknown;
  try {
    data = JSON.parse(tolerant);
  } catch {
    // Strict parse failed — try the heavier repair pass (handles unescaped
    // inner quotes, the most common LLM mistake in label/description text).
    try {
      data = JSON.parse(repairInnerQuotes(tolerant));
    } catch (err) {
      return { ok: false, error: `JSON 解析失败：${(err as Error).message}` };
    }
  }

  return validateA2UIBlock(data);
}

function stripMarkdownFences(s: string): string {
  let out = s.trim();
  if (out.startsWith("```json")) out = out.slice("```json".length);
  else if (out.startsWith("```")) out = out.slice("```".length);
  if (out.endsWith("```")) out = out.slice(0, -"```".length);
  return out.trim();
}

/**
 * Tolerant JSON preprocessor.
 *
 *   - Strip trailing commas before } or ] (common LLM mistake).
 *
 * NOTE: we intentionally do NOT normalize smart quotes (“” → "). If the
 * model wraps a string value with ASCII quotes but uses smart quotes
 * inside the value for emphasis (e.g. {"label": "感到“成就感”"}),
 * converting inner smart quotes to ASCII would corrupt the JSON by
 * introducing unescaped quote characters. JSON.parse handles ASCII
 * structural quotes correctly on its own; leave string contents alone.
 */
function tolerantJsonString(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Best-effort repair for unescaped double quotes inside string values.
 *
 * Pattern: the model emits {"k": "v"inner"v2", ...} where "inner" was
 * meant to be quoted text inside the value. We rewrite inner ASCII
 * double quotes that are clearly inside a value (sandwiched between
 * non-structural chars) into Chinese quotes 「」 so JSON.parse succeeds.
 *
 * Heuristic, not perfect. Only runs if strict parse fails.
 */
function repairInnerQuotes(s: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") {
      if (!inString) {
        inString = true;
        out += ch;
        continue;
      }
      // In a string and hit a `"`. Peek ahead: if the next non-space char
      // is `,`, `:`, `}`, or `]`, this is the real closing quote.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const nextCh = s[j];
      if (nextCh === "," || nextCh === ":" || nextCh === "}" || nextCh === "]") {
        inString = false;
        out += ch;
      } else {
        // Inner quote — replace to keep JSON valid.
        out += "「";
      }
    } else {
      out += ch;
    }
  }
  return out;
}

const ALLOWED_FIELD_TYPES: A2UIFieldType[] = [
  "text",
  "textarea",
  "select",
  "multi-select",
  "number",
  "boolean",
  "date",
];

/** Common aliases the model emits — normalized to our canonical types. */
const FIELD_TYPE_ALIASES: Record<string, A2UIFieldType> = {
  // multi-select variants (model often drops the hyphen or uses checkbox/radio synonyms)
  multiselect: "multi-select",
  multi_select: "multi-select",
  multi: "multi-select",
  checkbox: "multi-select",
  checkboxes: "multi-select",
  checkbox_group: "multi-select",
  tags: "multi-select",
  tag_input: "multi-select",
  // select variants
  radio: "select",
  dropdown: "select",
  select_one: "select",
  single_select: "select",
  choice: "select",
  // text variants
  email: "text",
  tel: "text",
  phone: "text",
  url: "text",
  website: "text",
  password: "text",
  string: "text",
  input: "text",
  short_text: "text",
  // textarea variants
  paragraph: "textarea",
  long_text: "textarea",
  longtext: "textarea",
  multiline: "textarea",
  multi_line: "textarea",
  // number variants
  integer: "number",
  int: "number",
  float: "number",
  decimal: "number",
  number_input: "number",
  // date variants
  date_time: "date",
  datetime: "date",
  datetime_local: "date",
  time: "date",
};

function normalizeFieldType(raw: string): A2UIFieldType | null {
  if (ALLOWED_FIELD_TYPES.includes(raw as A2UIFieldType)) {
    return raw as A2UIFieldType;
  }
  const aliased = FIELD_TYPE_ALIASES[raw.toLowerCase()];
  return aliased ?? null;
}

const ALLOWED_ACTION_STYLES = ["primary", "secondary", "danger"] as const;

function validateA2UIBlock(data: unknown): A2UIValidationResult {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "块必须是对象" };
  }
  const obj = data as Record<string, unknown>;
  const type = obj.type;

  switch (type) {
    case "form":
      return validateForm(obj);
    case "confirm":
      return validateConfirm(obj);
    case "card":
      return validateCard(obj);
    case "list":
      return validateList(obj);
    default:
      return { ok: false, error: `未知块类型：${String(type)}` };
  }
}

function validateForm(obj: Record<string, unknown>): A2UIValidationResult {
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    return { ok: false, error: "form.title 必须是非空字符串" };
  }
  if (!Array.isArray(obj.fields) || obj.fields.length === 0) {
    return { ok: false, error: "form.fields 必须是非空数组" };
  }
  if (!Array.isArray(obj.actions) || obj.actions.length === 0) {
    return { ok: false, error: "form.actions 必须是非空数组" };
  }

  const fields: A2UIField[] = [];
  for (let i = 0; i < obj.fields.length; i++) {
    const f = validateField(obj.fields[i] as Record<string, unknown>, i);
    if (!f) return { ok: false, error: `fields[${i}] 校验失败` };
    fields.push(f);
  }

  const actions = validateActions(obj.actions);
  if (!actions) return { ok: false, error: "actions 校验失败" };

  return {
    ok: true,
    block: {
      type: "form",
      title: obj.title,
      description: optionalString(obj.description),
      fields,
      actions,
    },
  };
}

function validateConfirm(obj: Record<string, unknown>): A2UIValidationResult {
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    return { ok: false, error: "confirm.title 必须是非空字符串" };
  }
  if (!Array.isArray(obj.actions) || obj.actions.length === 0) {
    return { ok: false, error: "confirm.actions 必须是非空数组" };
  }
  const actions = validateActions(obj.actions);
  if (!actions) return { ok: false, error: "actions 校验失败" };
  return {
    ok: true,
    block: {
      type: "confirm",
      title: obj.title,
      description: optionalString(obj.description),
      actions,
    },
  };
}

function validateCard(obj: Record<string, unknown>): A2UIValidationResult {
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    return { ok: false, error: "card.title 必须是非空字符串" };
  }
  const actions = Array.isArray(obj.actions) ? validateActions(obj.actions) : [];
  if (Array.isArray(obj.actions) && !actions) {
    return { ok: false, error: "actions 校验失败" };
  }
  return {
    ok: true,
    block: {
      type: "card",
      title: obj.title,
      description: optionalString(obj.description),
      items: Array.isArray(obj.items) ? (obj.items as any[]) : undefined,
      actions: actions || undefined,
    },
  };
}

function validateList(obj: Record<string, unknown>): A2UIValidationResult {
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    return { ok: false, error: "list.title 必须是非空字符串" };
  }
  if (!Array.isArray(obj.items) || obj.items.length === 0) {
    return { ok: false, error: "list.items 必须是非空数组" };
  }
  if (!Array.isArray(obj.actions) || obj.actions.length === 0) {
    return { ok: false, error: "list.actions 必须是非空数组" };
  }
  const actions = validateActions(obj.actions);
  if (!actions) return { ok: false, error: "actions 校验失败" };
  return {
    ok: true,
    block: {
      type: "list",
      title: obj.title,
      description: optionalString(obj.description),
      items: obj.items as any[],
      actions,
    },
  };
}

function validateField(raw: Record<string, unknown>, _idx: number): A2UIField | null {
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (typeof raw.label !== "string" || !raw.label.trim()) return null;
  if (typeof raw.type !== "string") return null;
  const normalized = normalizeFieldType(raw.type);
  if (!normalized) return null;
  const field: A2UIField = {
    id: raw.id,
    type: normalized,
    label: raw.label,
  };
  if (typeof raw.description === "string") field.description = raw.description;
  if (typeof raw.placeholder === "string") field.placeholder = raw.placeholder;
  if (typeof raw.required === "boolean") field.required = raw.required;
  if (raw.default !== undefined) field.default = raw.default as any;
  if (Array.isArray(raw.options)) {
    field.options = (raw.options as any[]).filter(
      (o) => o && typeof o.label === "string" && typeof o.value === "string"
    );
  }
  return field;
}

function validateActions(raw: unknown[]): A2UIAction[] | null {
  const actions: A2UIAction[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || !a.id.trim()) return null;
    if (typeof a.label !== "string" || !a.label.trim()) return null;
    const action: A2UIAction = { id: a.id, label: a.label };
    if (
      typeof a.style === "string" &&
      (ALLOWED_ACTION_STYLES as readonly string[]).includes(a.style)
    ) {
      action.style = a.style as A2UIAction["style"];
    }
    actions.push(action);
  }
  return actions;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
