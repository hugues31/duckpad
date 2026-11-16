import { useId, useState } from "react";
import { useT } from "./i18n";
import { listInputError, listItemType, parseListInput } from "./listInput";
import { numberBoundsError, type NumberLimits } from "./numberBounds";
import { baseType } from "./parameterType";
import type { Json } from "./types";

/** Keep incomplete input intact until it can be committed as a parameter value. */
export default function ParameterInput({
  type,
  id,
  label,
  placeholder,
  secret = false,
  disabled = false,
  value,
  onChange,
  onBlur,
  commitOnChange = false,
  limits = {},
}: {
  /** Full parameter type, including the list item type. */
  type: string;
  id?: string;
  /** An accessible name, when no label element names the input. */
  label?: string;
  placeholder?: string;
  secret?: boolean;
  disabled?: boolean;
  value: Json | undefined;
  /** Receives typed values, retaining invalid text for form validation. */
  onChange: (value: Json | undefined) => void;
  onBlur?: () => void;
  /** Let form validation see incomplete values while preserving their input text. */
  commitOnChange?: boolean;
  /** The type and bounds a Python number parameter declares. */
  limits?: NumberLimits;
}) {
  const t = useT();
  const descriptionId = useId();
  const errorId = useId();
  const kind = baseType(type);
  const itemType = listItemType(type);
  const integer = limits.python_type === "int";
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (text: string) =>
    kind === "list"
      ? parseListInput(type, text)
      : text.trim() === ""
        ? undefined
        : Number.isFinite(Number(text))
          ? Number(text)
          : text;
  const listError =
    kind === "list"
      ? listInputError(type, draft === null ? value : parse(draft), t)
      : "";
  const example =
    itemType === "number"
      ? "1, 2.5, -3"
      : itemType === "boolean"
        ? "true, false"
        : itemType === "column"
          ? "customer_id, amount"
          : "London, Paris";
  const input = (
    <input
      id={id}
      aria-label={label}
      placeholder={placeholder ?? (kind === "list" ? example : undefined)}
      aria-invalid={listError ? true : undefined}
      aria-describedby={
        kind === "list"
          ? `${descriptionId}${listError ? ` ${errorId}` : ""}`
          : undefined
      }
      disabled={disabled}
      type={secret ? "password" : "text"}
      inputMode={
        kind === "number" ? (integer ? "numeric" : "decimal") : undefined
      }
      value={
        draft ?? (Array.isArray(value) ? value.join(", ") : String(value ?? ""))
      }
      onChange={(e) => {
        e.currentTarget.setCustomValidity(
          kind === "list" ? listInputError(type, parse(e.target.value), t) : "",
        );
        setDraft(e.target.value);
        if (commitOnChange) onChange(parse(e.target.value));
      }}
      onBlur={(e) => {
        if (draft !== null) {
          const parsed = parse(draft);
          const invalid =
            kind === "list"
              ? listError
              : typeof parsed === "string"
                ? t("invalidNumber")
                : typeof parsed === "number"
                  ? numberBoundsError(parsed, limits, t)
                  : "";
          if (invalid) {
            e.currentTarget.setCustomValidity(invalid);
            // Lists explain the error inline without taking focus back on blur.
            if (kind !== "list") e.currentTarget.reportValidity();
            return;
          }
          onChange(parsed);
          setDraft(null);
        }
        onBlur?.();
      }}
    />
  );
  return kind === "list" ? (
    <div className="parameter-list-input">
      {input}
      <small id={descriptionId} className="muted">
        {t("listInputHint").replace("{example}", example)}
      </small>
      {listError && (
        <small id={errorId} className="parameter-list-error" role="alert">
          {listError}
        </small>
      )}
    </div>
  ) : (
    input
  );
}
