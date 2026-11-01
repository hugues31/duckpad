import Select from "./Select";
import ColumnPreparation from "./ColumnPreparation";
import ParameterInput from "./ParameterInput";
import { useId, useState, type ReactNode } from "react";
import { FileUp } from "lucide-react";
import { uploadFile } from "./api";
import { useT } from "./i18n";
import type { Column, Json, Parameter, Snapshot } from "./types";
import {
  ExpressionInput,
  ExpressionValues,
  type ExpressionVariables,
} from "./VariableExpression";

export default function ParameterField({
  parameter,
  value,
  onChange,
  onBlur,
  connections,
  schemas,
  columns,
  worktree,
  variable,
  expressionVariables,
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
  /** The variable button shown next to the name, and the bound variable replacing the input. */
  variable?: { control: ReactNode; bound: ReactNode };
  /** The variables an expression can reference; only root flow expressions can. */
  expressionVariables?: ExpressionVariables;
}) {
  const t = useT();
  const columnList = useId();
  const id = useId();
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
    <div className="field">
      <span>
        <label htmlFor={id}>{name.replaceAll("_", " ")}</label>
        {variable?.control}
        <small>{base}</small>
      </span>
      {variable?.bound ? (
        variable.bound
      ) : base === "boolean" ? (
        <Select
          id={id}
          value={String(value ?? false)}
          onChange={(e) => onChange(e.target.value === "true")}
          onBlur={onBlur}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : base === "connection" ? (
        <Select
          id={id}
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
          id={id}
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
          id={id}
          kind={base}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
        />
      ) : (base === "expressions" || base === "expression") &&
        expressionVariables &&
        (value == null || typeof value !== "object") ? (
        <ExpressionInput
          id={id}
          value={text}
          variables={expressionVariables}
          onChange={onChange}
          onBlur={onBlur}
        />
      ) : base === "expressions" ||
        base === "expression" ||
        base === "schema" ? (
        <textarea
          id={id}
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
          id={id}
          type="text"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          list={base === "column" && schemas ? columnList : undefined}
        />
      )}
      {base === "file" && worktree && !variable?.bound && (
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
      {(base === "expressions" || base === "expression") &&
        expressionVariables && (
          <ExpressionValues value={text} variables={expressionVariables} />
        )}
      {uploadError && <span className="notice error">{uploadError}</span>}
      {base === "column" && schemas && (
        <datalist id={columnList}>
          {schemas.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
