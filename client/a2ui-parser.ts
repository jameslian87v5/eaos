/**
 * Client-side mirror of server/a2ui-parser.ts.
 *
 * Used to split persisted assistant messages (which store raw <a2ui-json>
 * tags) into renderable segments on history replay. Keep in sync with the
 * server parser; both must accept the same model output.
 */

export type A2UIFieldType = "text" | "textarea" | "select" | "multi-select" | "number" | "boolean" | "date";

export interface A2UIField {
  id: string;
  type: A2UIFieldType;
  label: string;
  description?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
  required?: boolean;
  default?: string | number | boolean | string[];
}

export interface A2UIAction {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
}

export interface A2UIFormItem {
  key: string;
  label: string;
  value: string;
}

export interface A2UICardItem {
  title: string;
  subtitle?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export type A2UIBlock =
  | { type: "form"; title: string; description?: string; fields: A2UIField[]; actions: A2UIAction[] }
  | { type: "confirm"; title: string; description?: string; actions: A2UIAction[] }
  | { type: "card"; title: string; description?: string; items?: A2UICardItem[]; actions?: A2UIAction[] }
  | { type: "list"; title: string; description?: string; items: A2UIFormItem[]; actions: A2UIAction[] };

export type A2UISegment =
  | { kind: "text"; text: string }
  | { kind: "a2ui"; block: A2UIBlock };

const OPEN = "<a2ui-json>";
const CLOSE = "</a2ui-json>";
const BLOCK_RE = new RegExp(`${escapeRe(OPEN)}(.*?)${escapeRe(CLOSE)}`, "gs");

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasA2UIBlock(text: string): boolean {
  return text.includes(OPEN) && text.includes(CLOSE);
}

export function splitA2UISegments(text: string): A2UISegment[] {
  if (!text || !hasA2UIBlock(text)) {
    return [{ kind: "text", text }];
  }

  const out: A2UISegment[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > lastEnd) {
      const leading = text.slice(lastEnd, start);
      if (leading.trim()) out.push({ kind: "text", text: leading });
    }
    const block = parseBlock(m[1]);
    if (block) {
      out.push({ kind: "a2ui", block });
    } else {
      // P0.3 client-side: silent-fail with a minimal notice, no raw JSON dump
      out.push({
        kind: "text",
        text: "_（一段历史交互卡片格式不合法，已隐藏）_",
      });
    }
    lastEnd = end;
  }
  if (lastEnd < text.length) {
    const trailing = text.slice(lastEnd);
    if (trailing.trim()) out.push({ kind: "text", text: trailing });
  }
  return out;
}

function parseBlock(raw: string): A2UIBlock | null {
  const cleaned = stripFences(raw).trim();
  if (!cleaned) return null;
  let data: unknown;
  try {
    data = JSON.parse(tolerant(cleaned));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  return validate(data as Record<string, unknown>);
}

function stripFences(s: string): string {
  let out = s.trim();
  if (out.startsWith("```json")) out = out.slice("```json".length);
  else if (out.startsWith("```")) out = out.slice("```".length);
  if (out.endsWith("```")) out = out.slice(0, -"```".length);
  return out.trim();
}

function tolerant(s: string): string {
  return s
    .replace(/[“”„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/,(\s*[}\]])/g, "$1");
}

const FIELD_TYPES: A2UIFieldType[] = ["text", "textarea", "select", "multi-select", "number", "boolean", "date"];
const ACTION_STYLES = ["primary", "secondary", "danger"];

const FIELD_TYPE_ALIASES: Record<string, A2UIFieldType> = {
  multiselect: "multi-select",
  multi_select: "multi-select",
  multi: "multi-select",
  checkbox: "multi-select",
  checkboxes: "multi-select",
  checkbox_group: "multi-select",
  tags: "multi-select",
  tag_input: "multi-select",
  radio: "select",
  dropdown: "select",
  select_one: "select",
  single_select: "select",
  choice: "select",
  email: "text",
  tel: "text",
  phone: "text",
  url: "text",
  website: "text",
  password: "text",
  string: "text",
  input: "text",
  short_text: "text",
  paragraph: "textarea",
  long_text: "textarea",
  longtext: "textarea",
  multiline: "textarea",
  multi_line: "textarea",
  integer: "number",
  int: "number",
  float: "number",
  decimal: "number",
  number_input: "number",
  date_time: "date",
  datetime: "date",
  datetime_local: "date",
  time: "date",
};

function normalizeFieldType(raw: string): A2UIFieldType | null {
  if (FIELD_TYPES.includes(raw as A2UIFieldType)) return raw as A2UIFieldType;
  return FIELD_TYPE_ALIASES[raw.toLowerCase()] ?? null;
}

function validate(obj: Record<string, unknown>): A2UIBlock | null {
  const type = obj.type;
  const title = typeof obj.title === "string" ? obj.title : "";
  if (!title) return null;
  const description = typeof obj.description === "string" ? obj.description : undefined;
  const actions = Array.isArray(obj.actions) ? validateActions(obj.actions) : null;

  if (type === "form") {
    if (!Array.isArray(obj.fields) || obj.fields.length === 0) return null;
    if (!actions || actions.length === 0) return null;
    const fields = (obj.fields as Record<string, unknown>[])
      .map(validateField)
      .filter((f): f is A2UIField => f !== null);
    if (fields.length === 0) return null;
    return { type: "form", title, description, fields, actions };
  }
  if (type === "confirm") {
    if (!actions || actions.length === 0) return null;
    return { type: "confirm", title, description, actions };
  }
  if (type === "card") {
    const items = Array.isArray(obj.items) ? (obj.items as A2UICardItem[]) : undefined;
    return { type: "card", title, description, items, actions: actions || undefined };
  }
  if (type === "list") {
    if (!Array.isArray(obj.items) || obj.items.length === 0) return null;
    if (!actions || actions.length === 0) return null;
    return { type: "list", title, description, items: obj.items as A2UIFormItem[], actions };
  }
  return null;
}

function validateField(raw: Record<string, unknown>): A2UIField | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.label !== "string" || !raw.label) return null;
  if (typeof raw.type !== "string") return null;
  const normalized = normalizeFieldType(raw.type);
  if (!normalized) return null;
  const f: A2UIField = { id: raw.id, type: normalized, label: raw.label };
  if (typeof raw.description === "string") f.description = raw.description;
  if (typeof raw.placeholder === "string") f.placeholder = raw.placeholder;
  if (typeof raw.required === "boolean") f.required = raw.required;
  if (raw.default !== undefined) f.default = raw.default as any;
  if (Array.isArray(raw.options)) {
    f.options = (raw.options as any[]).filter(
      (o) => o && typeof o.label === "string" && typeof o.value === "string"
    );
  }
  return f;
}

function validateActions(raw: unknown[]): A2UIAction[] | null {
  const out: A2UIAction[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || !a.id) return null;
    if (typeof a.label !== "string" || !a.label) return null;
    const action: A2UIAction = { id: a.id, label: a.label };
    if (typeof a.style === "string" && ACTION_STYLES.includes(a.style)) {
      action.style = a.style as A2UIAction["style"];
    }
    out.push(action);
  }
  return out;
}
