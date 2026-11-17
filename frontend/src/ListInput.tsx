import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import {
  listInputError,
  listItemText,
  listItemType,
  parseListInput,
  validListItem,
} from "./listValues";
import type { Json } from "./types";

/** The values around the text field, which sits before `items[at]`. */
type Edit = { items: Json[]; at: number; draft: string };

const examples: Record<string, string> = {
  number: "1, 2.5, -3",
  boolean: "true, false",
  column: "customer_id, amount",
  text: "London, Paris",
};

/**
 * A list edited as separate values. A comma or Enter turns the typed text into
 * a value, clicking a value edits it in place, and Backspace takes the previous
 * one back into the text. Every change reports the whole list, typed text
 * included, so autosave and form validation see what the field shows.
 */
export default function ListInput({
  type,
  id,
  label,
  placeholder,
  disabled = false,
  value,
  onChange,
  onBlur,
  suggestions = [],
}: {
  /** The full list type, such as `list<number>`. */
  type: string;
  id?: string;
  /** An accessible name, when no label element names the input. */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  value: Json | undefined;
  /** Receives typed values; invalid items stay text so validation rejects them. */
  onChange: (value: Json[]) => void;
  /** Called when the focus leaves a valid list. */
  onBlur?: () => void;
  /** Values offered while typing, such as the input column names. */
  suggestions?: string[];
}) {
  const t = useT();
  const hintId = useId();
  const errorId = useId();
  const suggestionsId = useId();
  const input = useRef<HTMLInputElement>(null);
  const selectDraft = useRef(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const itemType = listItemType(type) ?? "text";
  const saved: Json[] = Array.isArray(value)
    ? value
    : value == null
      ? []
      : [value];
  const { items, at, draft } = edit ?? {
    items: saved,
    at: saved.length,
    draft: "",
  };
  const merge = (next: Edit) => [
    ...next.items.slice(0, next.at),
    ...parseListInput(type, next.draft),
    ...next.items.slice(next.at),
  ];
  // Every value, the typed text included.
  const list = merge({ items, at, draft });
  const error = listInputError(type, list, t);
  const offered = suggestions.filter((name) => !list.includes(name));

  // Native form validation sees the same error as the message below the field.
  useEffect(() => input.current?.setCustomValidity(error), [error]);
  useLayoutEffect(() => {
    if (!selectDraft.current) return;
    selectDraft.current = false;
    input.current?.select();
  });

  const change = (next: Edit) => {
    setEdit(next);
    onChange(merge(next));
  };
  /** The position in `list` of the value shown at `index`. */
  const position = (index: number) =>
    index < at ? index : index + parseListInput(type, draft).length;
  const focus = () => input.current?.focus();

  const typeText = (text: string, commit = false) => {
    const parts = text.split(",");
    const rest = commit ? "" : parts.pop()!.trimStart();
    const added = parseListInput(type, commit ? text : parts.join(","));
    change({
      items: [...items.slice(0, at), ...added, ...items.slice(at)],
      at: at + added.length,
      draft: rest,
    });
  };

  const chip = (item: Json, index: number) => {
    const text = listItemText(item);
    const valid = validListItem(type, item);
    // A boolean value switches on click; other values open for editing.
    const toggles = itemType === "boolean" && valid;
    return (
      <span
        key={index}
        className={`list-chip${valid ? "" : " invalid"}`}
        style={{ order: index < at ? index : index + 1 }}
      >
        <button
          type="button"
          className="list-chip-value"
          tabIndex={-1}
          disabled={disabled}
          title={t(toggles ? "switchListValue" : "editListValue")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const i = position(index);
            if (toggles)
              change({
                items: list.map((x, j) => (j === i ? !x : x)),
                at: list.length,
                draft: "",
              });
            else {
              selectDraft.current = true;
              change({
                items: list.filter((_, j) => j !== i),
                at: i,
                draft: text,
              });
            }
            focus();
          }}
        >
          {text}
        </button>
        <button
          type="button"
          className="list-chip-remove"
          tabIndex={-1}
          disabled={disabled}
          aria-label={t("removeListValue").replace("{item}", text)}
          title={t("removeListValue").replace("{item}", text)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const rest = list.filter((_, j) => j !== position(index));
            change({ items: rest, at: rest.length, draft: "" });
            focus();
          }}
        >
          <X size={12} aria-hidden />
        </button>
      </span>
    );
  };

  return (
    <div className="list-field">
      <div
        className={`list-input${error ? " invalid" : ""}${disabled ? " disabled" : ""}`}
        onMouseDown={(e) => {
          // The blank space of the field focuses its text field, at the end.
          if (e.target !== e.currentTarget || disabled) return;
          e.preventDefault();
          if (at < items.length || draft) {
            change({ items: list, at: list.length, draft: "" });
          }
          focus();
        }}
      >
        {items.map(chip)}
        <input
          ref={input}
          id={id}
          className={`list-input-text${at < items.length ? " inline" : ""}`}
          // The text field stays on the line of the values while its text fits.
          style={
            at < items.length
              ? { order: at, width: `${draft.length + 2}ch` }
              : { order: at, minWidth: `${draft ? draft.length + 2 : 1}ch` }
          }
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          placeholder={
            items.length ? undefined : (placeholder ?? examples[itemType])
          }
          disabled={disabled}
          type="text"
          list={offered.length ? suggestionsId : undefined}
          value={draft}
          onChange={(e) => {
            const event = e.nativeEvent as InputEvent;
            // Choosing a suggested column adds it at once.
            typeText(
              e.target.value,
              event.inputType === "insertReplacementText" &&
                suggestions.includes(e.target.value.trim()),
            );
          }}
          onPaste={(e) => {
            // Lines and cells copied from a spreadsheet become values.
            const pasted = e.clipboardData.getData("text");
            if (!/[\n\t]/.test(pasted)) return;
            e.preventDefault();
            const field = e.currentTarget;
            typeText(
              draft.slice(0, field.selectionStart ?? draft.length) +
                pasted.replace(/[\r\n\t]+/g, ",") +
                draft.slice(field.selectionEnd ?? draft.length),
            );
          }}
          onKeyDown={(e) => {
            const field = e.currentTarget;
            const start =
              field.selectionStart === 0 && field.selectionEnd === 0;
            const end = field.selectionStart === draft.length;
            if (e.key === "Enter" && draft.trim()) {
              // Keep forms from submitting while a value is being typed.
              e.preventDefault();
              change({ items: list, at: list.length, draft: "" });
            } else if (e.key === "Backspace" && !draft && at > 0) {
              e.preventDefault();
              change({
                items: items.filter((_, i) => i !== at - 1),
                at: at - 1,
                draft: listItemText(items[at - 1]),
              });
            } else if (e.key === "Delete" && !draft && at < items.length) {
              e.preventDefault();
              change({ items: items.filter((_, i) => i !== at), at, draft });
            } else if (e.key === "ArrowLeft" && start && at > 0) {
              e.preventDefault();
              change({ items: list, at: at - 1, draft: "" });
            } else if (e.key === "ArrowRight" && end && at < items.length) {
              e.preventDefault();
              change({
                items: list,
                at: position(at) + 1,
                draft: "",
              });
            }
          }}
          onBlur={() => {
            if (edit) {
              setEdit(null);
              onChange(list);
            }
            if (!error) onBlur?.();
          }}
        />
        {offered.length > 0 && (
          <datalist id={suggestionsId}>
            {offered.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
      </div>
      <span id={hintId} hidden>
        {t("listInputHint")}
      </span>
      {error && (
        <small id={errorId} className="list-input-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
