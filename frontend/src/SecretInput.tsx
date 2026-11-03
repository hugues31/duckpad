import Select from "./Select";
import { useT } from "./i18n";
import type { Json } from "./types";

/** A secret the server reads at each run instead of a stored value. */
export type SecretReference = { from: "env" | "file"; name: string };

export const isReference = (
  value: Json | undefined,
): value is SecretReference =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A secret connection parameter: a stored value, an environment variable or a secret file. */
export default function SecretInput({
  label,
  hint,
  disabled,
  value,
  saved,
  onChange,
}: {
  label: string;
  hint?: string;
  disabled: boolean;
  value: Json | undefined;
  /** The saved value, restored when switching back to a stored value. */
  saved: Json | undefined;
  onChange: (value: Json) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="secret-input">
        <Select
          aria-label={t("secretSource").replace("{name}", label)}
          disabled={disabled}
          value={isReference(value) ? value.from : "value"}
          onChange={(event) => {
            const from = event.target.value;
            if (from === "env" || from === "file")
              onChange({ from, name: from === "env" ? "DUCKPAD_SECRET_" : "" });
            else onChange(isReference(saved) ? "" : (saved ?? ""));
          }}
        >
          <option value="value">{t("secretStoredValue")}</option>
          <option value="env">{t("secretEnvironmentVariable")}</option>
          <option value="file">{t("secretFile")}</option>
        </Select>
        {isReference(value) ? (
          <input
            aria-label={label}
            aria-describedby={hint}
            disabled={disabled}
            spellCheck={false}
            placeholder={
              value.from === "env"
                ? "DUCKPAD_SECRET_…"
                : t("secretFilePlaceholder")
            }
            value={value.name}
            onChange={(event) =>
              onChange({ from: value.from, name: event.target.value })
            }
          />
        ) : (
          <input
            aria-label={label}
            aria-describedby={hint}
            disabled={disabled}
            type="password"
            value={String(value ?? "")}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </div>
      {isReference(value) && (
        <small className="muted">
          {t(
            value.from === "env"
              ? "secretEnvironmentVariableHint"
              : "secretFileHint",
          )}
        </small>
      )}
    </>
  );
}
