import Select from "./Select";
import SourceFileField from "./SourceFileField";
import ColumnPreparation from "./ColumnPreparation";
import ParameterInput from "./ParameterInput";
import { useId, type ReactNode } from "react";
import { useT } from "./i18n";
import { numberBounds } from "./numberBounds";
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
  location,
  projectFile,
  csv,
  schemas,
  columns,
  objects,
  worktree,
  variable,
  expressionVariables,
}: {
  parameter: Parameter;
  /** The value set on the node, or else the declared default. */
  value: Json | undefined;
  /** Receives undefined to fall back on the default. */
  onChange: (value: Json | undefined, settings?: Record<string, Json>) => void;
  onBlur?: () => void;
  connections: Snapshot["connections"];
  /**
   * A connection that file or destination parameters resolve against; empty
   * selects project files. It lists file storage connections only.
   */
  location?: boolean;
  projectFile?: boolean;
  csv?: boolean;
  schemas?: string[];
  columns?: Column[];
  /** Schema or table names listed from the database connection, for name parameters. */
  objects?: {
    names: string[];
    pending: boolean;
    error: string;
    /** Every name is listed, so the field is a select. */
    complete: boolean;
  };
  worktree?: string;
  /** The variable button shown next to the name, and the bound variable replacing the input. */
  variable?: { control: ReactNode; bound: ReactNode };
  /** The variables an expression can reference; only root flow expressions can. */
  expressionVariables?: ExpressionVariables;
}) {
  const t = useT();
  const columnList = useId();
  const objectList = useId();
  const id = useId();
  const name = parameter.name;
  const type = parameter.type || "text";
  const base = type.split(/[<(]/)[0];
  const text = value == null ? "" : String(value);
  // A location lists file storage; other connection parameters reach databases.
  const choices = connections.filter(
    (c) => (c.family === "storage") === !!location,
  );
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
        <label htmlFor={id}>
          {location && name === "connection"
            ? t("location")
            : parameter.label || name.replaceAll("_", " ")}
        </label>
        {variable?.control}
        <small>
          {parameter.python_type === "int" || parameter.python_type === "float"
            ? parameter.python_type
            : base}
          {numberBounds(parameter)
            .map((bound) => ` · ${bound}`)
            .join("")}
        </small>
      </span>
      {variable?.bound ? (
        variable.bound
      ) : base === "file" && projectFile && worktree ? (
        <SourceFileField
          id={id}
          worktree={worktree}
          value={text}
          onChange={onChange}
          onBlur={onBlur}
          csv={csv}
          expressionVariables={expressionVariables}
        />
      ) : objects?.complete ? (
        <Select
          id={id}
          value={text}
          disabled={objects.pending}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          <option value="">{t("chooseSourceObject")}</option>
          {text && !objects.names.includes(text) && (
            <option value={text}>{text}</option>
          )}
          {objects.names.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </Select>
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
          {location ? (
            <option value="">{t("projectFiles")}</option>
          ) : (
            !text && <option value="">{t("notConnected")}</option>
          )}
          {text && !choices.some((c) => c.id === text) && (
            <option value={text} disabled>
              {text} · {t("unavailableConnection")}
            </option>
          )}
          {choices.map((c) => (
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
          limits={parameter}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          commitOnChange
        />
      ) : ["expressions", "expression", "file", "destination"].includes(base) &&
        expressionVariables &&
        (value == null || typeof value !== "object") ? (
        <ExpressionInput
          id={id}
          value={text}
          variables={expressionVariables}
          onChange={onChange}
          onBlur={onBlur}
          singleLine={base === "file" || base === "destination"}
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
          list={
            base === "column" && schemas
              ? columnList
              : objects
                ? objectList
                : undefined
          }
        />
      )}
      {objects && !variable?.bound && (
        <>
          {!objects.complete && (
            <datalist id={objectList}>
              {objects.names.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
          {objects.pending ? (
            <small className="muted">{t("listingDatabaseObjects")}</small>
          ) : (
            objects.error && (
              <small className="muted">
                {t("databaseObjectsError").replace("{error}", objects.error)}
              </small>
            )
          )}
        </>
      )}
      {["expressions", "expression", "file", "destination"].includes(base) &&
        expressionVariables && (
          <ExpressionValues value={text} variables={expressionVariables} />
        )}
      {parameter.description && (
        <small className="muted">{parameter.description}</small>
      )}
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
