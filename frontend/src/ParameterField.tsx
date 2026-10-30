import Select from "./Select";
import ColumnPreparation from "./ColumnPreparation";
import ParameterInput from "./ParameterInput";
import { useId, useState } from "react";
import { FileUp } from "lucide-react";
import { uploadFile } from "./api";
import { useT } from "./i18n";
import type { Column, Json, Parameter, Snapshot } from "./types";

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
  parameter: Parameter;
  /** The value set on the node, or else the declared default. */
  value: Json | undefined;
  /** Receives undefined to fall back on the default. */
  onChange: (value: Json | undefined) => void;
  onBlur?: () => void;
  connections: Snapshot["connections"];
  schemas?: string[];
  columns?: Column[];
  worktree?: string;
}) {
  const t = useT();
  const columnList = useId();
  const [uploadError, setUploadError] = useState("");
  const name = parameter.name;
  const type = parameter.type || "text";
  const base = type.split(/[<(]/)[0];
  const text = value == null ? "" : String(value);
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
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          {!text && <option value="">{t("notConnected")}</option>}
          {text && !connections.some((c) => c.id === text) && (
            <option value={text} disabled>
              {text} · {t("unavailableConnection")}
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
          value={text}
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
            typeof value === "object" ? JSON.stringify(value, null, 2) : text
          }
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      ) : (
        <input
          type="text"
          value={text}
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
