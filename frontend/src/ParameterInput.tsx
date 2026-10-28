import { useState } from "react";
import { useT } from "./i18n";

/** Keep incomplete input intact until it can be committed as a parameter value. */
export default function ParameterInput({
  kind,
  secret = false,
  value,
  onChange,
  onBlur,
}: {
  kind: "number" | "list";
  secret?: boolean;
  value: any;
  onChange: (value: any) => void;
  onBlur?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type={secret ? "password" : "text"}
      inputMode={kind === "number" ? "decimal" : undefined}
      value={draft ?? (Array.isArray(value) ? value.join(", ") : (value ?? ""))}
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
