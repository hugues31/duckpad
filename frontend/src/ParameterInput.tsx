import { useState } from "react";
import { useT } from "./i18n";
import { numberBoundsError, type NumberLimits } from "./numberBounds";
import type { Json } from "./types";

/** A number field that keeps incomplete input intact until it can be committed. */
export default function ParameterInput({
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
  id?: string;
  /** An accessible name, when no label element names the input. */
  label?: string;
  placeholder?: string;
  secret?: boolean;
  disabled?: boolean;
  value: Json | undefined;
  /** Receives the parsed value, or incomplete numeric text when commitOnChange is enabled. */
  onChange: (value: number | string | undefined) => void;
  onBlur?: () => void;
  /** Let form validation see incomplete values while preserving their input text. */
  commitOnChange?: boolean;
  /** The type and bounds a Python number parameter declares. */
  limits?: NumberLimits;
}) {
  const t = useT();
  const integer = limits.python_type === "int";
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (text: string) =>
    text.trim() === ""
      ? undefined
      : Number.isFinite(Number(text))
        ? Number(text)
        : text;
  return (
    <input
      id={id}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      type={secret ? "password" : "text"}
      inputMode={integer ? "numeric" : "decimal"}
      value={draft ?? String(value ?? "")}
      onChange={(e) => {
        e.currentTarget.setCustomValidity("");
        setDraft(e.target.value);
        if (commitOnChange) onChange(parse(e.target.value));
      }}
      onBlur={(e) => {
        if (draft !== null) {
          const parsed = parse(draft);
          const invalid =
            typeof parsed === "string"
              ? t("invalidNumber")
              : typeof parsed === "number"
                ? numberBoundsError(parsed, limits, t)
                : "";
          if (invalid) {
            e.currentTarget.setCustomValidity(invalid);
            e.currentTarget.reportValidity();
            return;
          }
          onChange(parsed);
          setDraft(null);
        }
        onBlur?.();
      }}
    />
  );
}
