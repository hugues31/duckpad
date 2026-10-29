import Select from "./Select";
import ColumnPreparation from "./ColumnPreparation";
import ParameterInput from "./ParameterInput";
import { useId, useState } from "react";
import { FileUp } from "lucide-react";
import { uploadFile } from "./api";
import { useT } from "./i18n";
import type { Json } from "./types";

export default function ParameterField({
  parameter,
  value,
  onChange,
  onBlur,
  connections,
  schemas,
  columns,
  worktree,
}: {
  parameter: Json;
  value: any;
  onChange: (value: any) => void;
  onBlur?: () => void;
  connections: Json[];
  schemas?: string[];
  columns?: Json[];
  worktree?: string;
}) {
  const t = useT();
  const columnList = useId();
  const [uploadError, setUploadError] = useState("");
  const name = parameter.name;
  const type = parameter.type || "text";
  const base = type.split(/[<(]/)[0];
  if (base === "secret") return null;
  if (["column_selection", "value_cleaning"].includes(base))
    return (
      <ColumnPreparation
        kind={base}
        value={value}
        columns={columns || []}
        onChange={onChange}
        onBlur={onBlur}
      />
    );
  return (
    <label className="field">
      <span>
        {name.replaceAll("_", " ")}
        <small>{base}</small>
      </span>
      {base === "boolean" ? (
        <Select
          value={String(value ?? false)}
          onChange={(e) => onChange(e.target.value === "true")}
          onBlur={onBlur}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : base === "connection" ? (
        <Select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          {!value && <option value="">{t("notConnected")}</option>}
          {value && !connections.some((c) => c.id === value) && (
            <option value={value} disabled>
              {value} · {t("unavailableConnection")}
            </option>
          )}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      ) : base === "choice" || base === "keyword" ? (
        <Select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          {(type.match(/\((.*)\)/)?.[1] || "").split("|").map((x: string) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
      ) : base === "list" || base === "number" ? (
        <ParameterInput
          kind={base}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
        />
      ) : base === "expressions" ||
        base === "expression" ||
        base === "schema" ? (
        <textarea
          rows={3}
          className="code-input"
          value={
            typeof value === "object"
              ? JSON.stringify(value, null, 2)
              : (value ?? "")
          }
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      ) : (
        <input
          type="text"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          list={base === "column" && schemas ? columnList : undefined}
        />
      )}
      {base === "file" && worktree && (
        <span className="file-upload">
          <FileUp size={13} />
          {t("upload")}
          <input
            type="file"
            accept=".csv,.parquet,.tsv,.xlsx"
            aria-label={t("upload")}
            onChange={async (e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              setUploadError("");
              try {
                onChange(await uploadFile(file, worktree));
                // An upload is a complete edit: commit it like a blur.
                onBlur?.();
              } catch (error) {
                setUploadError((error as Error).message);
              } finally {
                // Allow choosing the same file again.
                input.value = "";
              }
            }}
          />
        </span>
      )}
      {uploadError && <span className="notice error">{uploadError}</span>}
      {base === "column" && schemas && (
        <datalist id={columnList}>
          {schemas.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}
