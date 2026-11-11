/**
 * A2UI simplified schema types.
 *
 * This is a JiuwenSwarm-style minimal variant of A2UI, not the full v0.9
 * surface/component/dataModel protocol. The agent emits a single JSON object
 * inside <a2ui-json>...</a2ui-json> tags; the host parses and the frontend
 * renders it as a native React card. User submissions are converted back into
 * a structured user-message turn for the next agent iteration.
 *
 * Supported block types cover the article's described UX:
 *   - form:     collect structured input (text/select/multi-select/number/boolean)
 *   - confirm:  gate an action behind a single button (parallel to approval)
 *   - card:     rich content display with optional actions
 *   - list:     selectable list of items
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
  | {
      type: "form";
      title: string;
      description?: string;
      fields: A2UIField[];
      actions: A2UIAction[];
    }
  | {
      type: "confirm";
      title: string;
      description?: string;
      actions: A2UIAction[];
    }
  | {
      type: "card";
      title: string;
      description?: string;
      items?: A2UICardItem[];
      actions?: A2UIAction[];
    }
  | {
      type: "list";
      title: string;
      description?: string;
      items: A2UIFormItem[];
      actions: A2UIAction[];
    };

export interface A2UIValidationResult {
  ok: boolean;
  block?: A2UIBlock;
  error?: string;
}

/** User submission payload — travels back from frontend to server. */
export interface A2UISubmission {
  blockId: string;
  action: A2UIAction;
  values: Record<string, string | number | boolean | string[]>;
}
