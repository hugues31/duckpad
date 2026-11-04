import { useState } from "react";
import { useT } from "./i18n";
import type { Json } from "./types";

/** Keep incomplete input intact until it can be committed as a parameter value. */
export default function ParameterInput({
  kind,
  id,
  label,
  placeholder,
  secret = false,
  disabled = false,
  value,
  onChange,
  onBlur,
  commitOnChange = false,
}: {
  kind: "number" | "list";
  id?: string;
  /** An accessible name, when no label element names the input. */
  label?: string;
  placeholder?: string;
  secret?: boolean;
  disabled?: boolean;
  value: Json | undefined;
  /** Receives the parsed value, or incomplete numeric text when commitOnChange is enabled. */
  onChange: (value: number | string | string[] | undefined) => void;
  onBlur?: () => void;
  /** Let form validation see incomplete values while preserving their input text. */
  commitOnChange?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (text: string) =>
    kind === "list"
      ? text.split(",").map((item) => item.trim())
      : text.trim() === ""
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
      inputMode={kind === "number" ? "decimal" : undefined}
      value={
        draft ?? (Array.isArray(value) ? value.join(", ") : String(value ?? ""))
      }
      onChange={(e) => {
        e.currentTarget.setCustomValidity("");
        setDraft(e.target.value);
        if (commitOnChange) onChange(parse(e.target.value));
      }}
      onBlur={(e) => {
        if (draft !== null) {
          const parsed = parse(draft);
          if (kind === "number" && typeof parsed === "string") {
            e.currentTarget.setCustomValidity(t("invalidNumber"));
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
