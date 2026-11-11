import { useState } from "react";
import type { A2UIBlock, A2UIField } from "../a2ui-parser";

type FieldValue = string | number | boolean | string[];

interface Props {
  blockId: string;
  block: A2UIBlock;
  chatId: string;
  resolved?: boolean;
  resolutionLabel?: string;
  onSubmit: (payload: {
    blockId: string;
    actionId: string;
    actionLabel: string;
    values: Record<string, FieldValue>;
  }) => void;
}

function defaultValue(field: A2UIField): FieldValue {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean": return false;
    case "number": return 0;
    case "multi-select": return [];
    default: return "";
  }
}

// ─── A2UI v2 (S4): render-time defense against malformed legacy blocks ───
// History can contain <a2ui-json> blocks that PARSED (legacy prose parser is
// deliberately tolerant) but violate the shape at render time — null items,
// non-object entries, missing ids. Every array the card renders is filtered
// to well-formed entries; malformed ones are skipped, never thrown.

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

function safeFields(block: A2UIBlock): A2UIField[] {
  if (block.type !== "form") return [];
  return ((block.fields as unknown[] | undefined) ?? []).filter(
    (f): f is A2UIField =>
      isObj(f) && typeof f.id === "string" && typeof f.type === "string" && typeof f.label === "string"
  );
}

function safeActions(block: A2UIBlock): Array<{ id: string; label: string; style?: string }> {
  return ((block.actions as unknown[] | undefined) ?? []).filter(
    (a): a is { id: string; label: string; style?: string } =>
      isObj(a) && typeof a.id === "string" && typeof a.label === "string"
  );
}

function safeListItems(block: A2UIBlock): Array<{ key?: string; label?: string; value?: string }> {
  if (block.type !== "list") return [];
  return ((block.items as unknown[] | undefined) ?? []).filter(isObj);
}

function safeCardItems(block: A2UIBlock): Array<{ title?: string; subtitle?: string; description?: string }> {
  if (block.type !== "card") return [];
  return ((block.items as unknown[] | undefined) ?? []).filter(isObj);
}

export function A2UIBlockCard({ blockId, block, resolved, resolutionLabel, onSubmit }: Props) {
  const fields = safeFields(block);
  const actions = safeActions(block);
  const listItems = safeListItems(block);
  const cardItems = safeCardItems(block);

  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {};
    for (const f of fields) init[f.id] = defaultValue(f);
    return init;
  });

  const setField = (id: string, v: FieldValue) =>
    setValues((prev) => ({ ...prev, [id]: v }));

  const requiredMissing =
    fields.some((f) => f.required && isEmpty(values[f.id]));

  const handleSubmit = (actionId: string, actionLabel: string) => {
    if (requiredMissing) return;
    onSubmit({ blockId, actionId, actionLabel, values });
  };

  const actionButtons = (actions: { id: string; label: string; style?: string }[]) =>
    actions.map((a) => {
      const colors =
        a.style === "primary"
          ? "bg-blue-600 hover:bg-blue-700 text-white"
          : a.style === "danger"
            ? "bg-red-600 hover:bg-red-700 text-white"
            : "bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300";
      const disabled = resolved || (a.style === "primary" && requiredMissing);
      return (
        <button
          key={a.id}
          disabled={disabled}
          onClick={() => handleSubmit(a.id, a.label)}
          className={`px-3 py-1.5 rounded text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${colors}`}
        >
          {a.label}
        </button>
      );
    });

  return (
    <div className="my-3 border border-blue-200 bg-blue-50/50 rounded-lg overflow-hidden shadow-sm">
      <div className="px-4 py-2 bg-blue-100/60 border-b border-blue-200">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-blue-700 uppercase tracking-wide">A2UI · {block.type}</span>
          {resolved && (
            <span className="ml-auto text-xs text-gray-500 italic">
              {resolutionLabel || "已处理"}
            </span>
          )}
        </div>
        <h3 className="text-base font-semibold text-gray-900 mt-1">{block.title}</h3>
        {block.description && (
          <p className="text-sm text-gray-600 mt-0.5">{block.description}</p>
        )}
      </div>

      <div className="p-4 space-y-3">
        {block.type === "form" &&
          fields.map((f) => (
            <FieldInput
              key={f.id}
              field={f}
              value={values[f.id]}
              disabled={!!resolved}
              onChange={(v) => setField(f.id, v)}
            />
          ))}

        {block.type === "list" && (
          <ul className="space-y-1.5">
            {listItems.map((item, idx) => (
              <li key={`${String(item.key ?? "")}-${idx}`} className="text-sm">
                <div className="font-medium text-gray-800">{String(item.label ?? "")}</div>
                {item.value != null && item.value !== "" && (
                  <div className="text-gray-600">{String(item.value)}</div>
                )}
              </li>
            ))}
          </ul>
        )}

        {block.type === "card" && cardItems.length > 0 && (
          <div className="space-y-2">
            {cardItems.map((item, idx) => (
              <div key={idx} className="border border-gray-200 rounded p-2 bg-white">
                <div className="font-medium text-sm text-gray-800">{String(item.title ?? "")}</div>
                {item.subtitle != null && <div className="text-xs text-gray-500">{String(item.subtitle)}</div>}
                {item.description != null && (
                  <div className="text-sm text-gray-700 mt-1">{String(item.description)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {actions.length > 0 && (
        <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 flex gap-2 justify-end">
          {actionButtons(actions)}
        </div>
      )}
    </div>
  );
}

function isEmpty(v: FieldValue): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return false;
  if (typeof v === "boolean") return false;
  return true;
}

function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: A2UIField;
  value: FieldValue;
  disabled: boolean;
  onChange: (v: FieldValue) => void;
}) {
  const label = (
    <label className="block text-sm font-medium text-gray-700 mb-1">
      {field.label}
      {field.required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );

  const description = field.description && (
    <p className="text-xs text-gray-500 mb-1">{field.description}</p>
  );

  const inputClass =
    "w-full px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-gray-100 disabled:cursor-not-allowed";

  if (field.type === "boolean") {
    return (
      <div>
        {label}
        {description}
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            className="rounded"
          />
          <span className="text-gray-600">{field.placeholder || "是/否"}</span>
        </label>
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div>
        {label}
        {description}
        <textarea
          value={String(value)}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} min-h-[80px] font-mono`}
        />
      </div>
    );
  }

  if (field.type === "select" || field.type === "multi-select") {
    const options = field.options || [];
    if (field.type === "multi-select") {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div>
          {label}
          {description}
          <div className="space-y-1">
            {options.map((opt) => {
              const checked = selected.includes(opt.value);
              return (
                <label key={opt.value} className="inline-flex items-center gap-2 text-sm mr-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selected, opt.value]
                        : selected.filter((v) => v !== opt.value);
                      onChange(next);
                    }}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      );
    }
    return (
      <div>
        {label}
        {description}
        <select
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          <option value="">— 请选择 —</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div>
        {label}
        {description}
        <input
          type="number"
          value={typeof value === "number" ? value : Number(value) || 0}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={(e) => onChange(Number(e.target.value))}
          className={inputClass}
        />
      </div>
    );
  }

  // text | date
  return (
    <div>
      {label}
      {description}
      <input
        type={field.type === "date" ? "date" : "text"}
        value={String(value)}
        disabled={disabled}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
    </div>
  );
}
