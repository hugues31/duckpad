import { useState } from "react";
import { useT } from "./i18n";
import type { Json } from "./types";

/** Keep incomplete input intact until it can be committed as a parameter value. */
export default function ParameterInput({
  kind,
  secret = false,
  disabled = false,
  value,
  onChange,
  onBlur,
}: {
  kind: "number" | "list";
  secret?: boolean;
  disabled?: boolean;
  value: Json | undefined;
  /** Receives a number, a list of strings, or undefined for an empty number. */
  onChange: (value: number | string[] | undefined) => void;
  onBlur?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      disabled={disabled}
      type={secret ? "password" : "text"}
      inputMode={kind === "number" ? "decimal" : undefined}
      value={
        draft ?? (Array.isArray(value) ? value.join(", ") : String(value ?? ""))
      }
      onChange={(e) => {
        e.currentTarget.setCustomValidity("");
        setDraft(e.target.value);
      }}
      onBlur={(e) => {
        if (draft !== null) {
          const parsed =
            kind === "list"
              ? draft.split(",").map((item) => item.trim())
              : draft.trim() === ""
                ? undefined
                : Number(draft);
          if (typeof parsed === "number" && !Number.isFinite(parsed)) {
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
