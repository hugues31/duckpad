import { useId, useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { baseType, typeArgument } from "./parameterType";
import Select from "./Select";
import type { Column, Json } from "./types";
import {
  ExpressionInput,
  type ExpressionVariables,
} from "./VariableExpression";

export const GUIDED_TYPES = [
  "conditions",
  "join_keys",
  "joined_columns",
  "group_columns",
  "measures",
  "ordering",
  "columns",
];
type Row = Record<string, Json>;
const numeric =
  /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|BIGNUM|FLOAT|DOUBLE|DECIMAL\b)/i;
const initial = (kind: string): Json =>
  kind === "conditions"
    ? { mode: "and", conditions: [] }
    : kind === "joined_columns"
      ? "all"
      : [];
const record = (value: Json): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Forms belong to public parameter types, including on user-authored templates. */
export default function GuidedParameter({
  type,
  name,
  value,
  schemas,
  worktree,
  expressionVariables,
  onChange,
  onBlur,
}: {
  type: string;
  name: string;
  value: Json | undefined;
  schemas: Record<string, Column[]>;
  worktree?: string;
  expressionVariables?: ExpressionVariables;
  onChange: (value: Json) => void;
  onBlur?: () => void;
}) {
  const t = useT();
  const sqlId = useId();
  const kind = baseType(type);
  const ports = (typeArgument(type) || "").split(",").map((p) => p.trim());
  const columns = schemas[ports[0]] || [];
  const current = value ?? initial(kind);
  const advanced =
    typeof current === "string" &&
    !(kind === "joined_columns" && ["all", "left"].includes(current));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const choose = (
    label: string,
    selected: Json | undefined,
    change: (v: string) => void,
    choices = columns,
    all = false,
  ) => (
    <label className="field">
      <span>{label}</span>
      <Select
        aria-label={label}
        value={String(selected ?? "")}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">{t("chooseColumn")}</option>
        {all && <option value="*">{t("allRows")}</option>}
        {!!selected &&
          selected !== "*" &&
          !choices.some((c) => c.name === selected) && (
            <option>{String(selected)}</option>
          )}
        {choices.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {c.type}
          </option>
        ))}
      </Select>
    </label>
  );
  const condition = (
    data: Json,
    change: (v: Json) => void,
    depth = 0,
  ): React.ReactNode => {
    if (!record(data)) return <p role="alert">{t("invalidGuidedSettings")}</p>;
    if (Array.isArray(data.conditions)) {
      const children = data.conditions;
      const update = (i: number, v: Json) =>
        change({
          ...data,
          conditions: children.map((c, n) => (n === i ? v : c)),
        });
      return (
        <fieldset className="preparation-row">
          <legend>{t("conditionGroup")}</legend>
          <Select
            aria-label={t("matchConditions")}
            value={String(data.mode || "and")}
            onChange={(e) => change({ ...data, mode: e.target.value })}
          >
            <option value="and">{t("allConditions")}</option>
            <option value="or">{t("anyCondition")}</option>
          </Select>
          {children.map((c, i) => (
            <div key={i}>
              {condition(c, (v) => update(i, v), depth + 1)}
              <button
                type="button"
                className="text-button danger"
                onClick={() =>
                  change({
                    ...data,
                    conditions: children.filter((_, n) => n !== i),
                  })
                }
              >
                {t("remove")}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              change({
                ...data,
                conditions: [
                  ...children,
                  { column: columns[0]?.name || "", operator: "=", value: "" },
                ],
              })
            }
          >
            {t("addCondition")}
          </button>
          {depth < 5 && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                change({
                  ...data,
                  conditions: [...children, { mode: "or", conditions: [] }],
                })
              }
            >
              {t("addConditionGroup")}
            </button>
          )}
        </fieldset>
      );
    }
    const type = columns.find((c) => c.name === data.column)?.type || "";
    return (
      <div className="measure-form">
        {choose(t("column"), data.column, (column) =>
          change({ ...data, column }),
        )}
        <label className="field">
          <span>{t("operator")}</span>
          <Select
            aria-label={t("operator")}
            value={String(data.operator || "=")}
            onChange={(e) => change({ ...data, operator: e.target.value })}
          >
            {[
              "=",
              "!=",
              ">",
              ">=",
              "<",
              "<=",
              "LIKE",
              "IS NULL",
              "IS NOT NULL",
            ].map((op) => (
              <option
                key={op}
                disabled={op === "LIKE" && !!type && type !== "VARCHAR"}
              >
                {op}
              </option>
            ))}
          </Select>
        </label>
        {!String(data.operator).includes("NULL") && (
          <label className="field">
            <span>{t("value")}</span>
            <input
              value={String(data.value ?? "")}
              onChange={(e) => change({ ...data, value: e.target.value })}
            />
          </label>
        )}
      </div>
    );
  };
  const settingRows = Array.isArray(current) ? current : [];
  const update = (i: number, patch: Row) =>
    onChange(
      settingRows.map((row, n) =>
        n === i && record(row) ? { ...row, ...patch } : row,
      ),
    );
  const newRow = (): Row =>
    kind === "join_keys"
      ? {
          left: columns[0]?.name || "",
          right: schemas[ports[1]]?.[0]?.name || "",
        }
      : kind === "ordering"
        ? { column: columns[0]?.name || "", direction: "asc", nulls: "last" }
        : {
            function: "COUNT",
            column: "*",
            alias: `count_${settingRows.length + 1}`,
          };
  return (
    <section
      className="query-builder column-preparation"
      aria-label={name.replaceAll("_", " ")}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onBlur?.();
      }}
    >
      <h4>{name.replaceAll("_", " ")}</h4>
      {!columns.length && <p className="muted small">{t("schemaHint")}</p>}
      {kind === "joined_columns" && (
        <p className="muted small">{t("joinColumnsHint")}</p>
      )}
      {kind === "join_keys" && (
        <p className="muted small">{t("joinRowsHint")}</p>
      )}
      {kind === "conditions" && !advanced && (
        <p className="muted small">{t("emptyConditionsHint")}</p>
      )}
      {advanced ? (
        <div className="field">
          <label htmlFor={sqlId}>
            {name.replaceAll("_", " ")} · {t("advancedSql")}
          </label>
          {expressionVariables ? (
            <ExpressionInput
              id={sqlId}
              value={current as string}
              variables={expressionVariables}
              onChange={onChange}
              onBlur={onBlur}
            />
          ) : (
            <textarea
              id={sqlId}
              className="code-input"
              value={current as string}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      ) : kind === "conditions" ? (
        condition(current, onChange)
      ) : kind === "joined_columns" ? (
        <Select
          aria-label={t("joinOutputColumns")}
          value={String(current)}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="all">{t("bothInputs")}</option>
          <option value="left">{t("leftInputOnly")}</option>
        </Select>
      ) : kind === "columns" || kind === "group_columns" ? (
        <>
          <label className="field">
            <span>{t(kind === "group_columns" ? "groupBy" : "columns")}</span>
            <Select
              multiple
              value={settingRows.map(String)}
              onChange={(e) =>
                onChange(Array.from(e.target.selectedOptions, (o) => o.value))
              }
            >
              {[
                ...new Set([
                  ...columns.map((c) => c.name),
                  ...settingRows.map(String),
                ]),
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </label>
          {kind === "group_columns" && (
            <p className="muted small">{t("noGroupsHint")}</p>
          )}
        </>
      ) : (
        <>
          {settingRows.map((row, i) =>
            !record(row) ? (
              <p role="alert" key={i}>
                {t("invalidGuidedSettings")}
              </p>
            ) : (
              <fieldset className="preparation-row" key={i}>
                <legend>{i + 1}</legend>
                {kind === "join_keys" ? (
                  <>
                    {choose(t("leftKey"), row.left, (left) =>
                      update(i, { left }),
                    )}
                    {choose(
                      t("rightKey"),
                      row.right,
                      (right) => update(i, { right }),
                      schemas[ports[1]] || [],
                    )}
                  </>
                ) : kind === "ordering" ? (
                  <>
                    {choose(t("column"), row.column, (column) =>
                      update(i, { column }),
                    )}
                    <label className="field">
                      <span>{t("sortDirection")}</span>
                      <Select
                        value={String(row.direction || "asc")}
                        onChange={(e) =>
                          update(i, { direction: e.target.value })
                        }
                      >
                        <option value="asc">ASC</option>
                        <option value="desc">DESC</option>
                      </Select>
                    </label>
                    <label className="field">
                      <span>{t("nullPlacement")}</span>
                      <Select
                        value={String(row.nulls || "last")}
                        onChange={(e) => update(i, { nulls: e.target.value })}
                      >
                        <option value="first">{t("nullsFirst")}</option>
                        <option value="last">{t("nullsLast")}</option>
                      </Select>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>{t("function")}</span>
                      <Select
                        value={String(row.function || "COUNT")}
                        onChange={(e) =>
                          update(i, {
                            function: e.target.value,
                            column: e.target.value === "COUNT" ? "*" : "",
                          })
                        }
                      >
                        {[
                          "COUNT",
                          "COUNT DISTINCT",
                          "SUM",
                          "AVG",
                          "MIN",
                          "MAX",
                        ].map((fn) => (
                          <option key={fn}>{fn}</option>
                        ))}
                      </Select>
                    </label>
                    {choose(
                      t("column"),
                      row.column,
                      (column) => update(i, { column }),
                      ["SUM", "AVG"].includes(String(row.function))
                        ? columns.filter((c) => numeric.test(c.type))
                        : columns,
                      row.function === "COUNT",
                    )}
                    <label className="field">
                      <span>{t("alias")}</span>
                      <input
                        value={String(row.alias || "")}
                        onChange={(e) => update(i, { alias: e.target.value })}
                      />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  className="text-button danger"
                  onClick={() =>
                    onChange(settingRows.filter((_, n) => n !== i))
                  }
                >
                  {t("remove")}
                </button>
              </fieldset>
            ),
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => onChange([...settingRows, newRow()])}
          >
            {t(
              kind === "join_keys"
                ? "addKeyPair"
                : kind === "ordering"
                  ? "addSortColumn"
                  : "addMeasure",
            )}
          </button>
        </>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="text-button"
        disabled={pending || (!advanced && !worktree)}
        onClick={async () => {
          setError("");
          if (advanced) {
            onChange(initial(kind));
            return;
          }
          if (Array.isArray(current) && current.length === 0) {
            onChange("");
            return;
          }
          setPending(true);
          try {
            const result = await api<{ sql: string }>(
              `/worktrees/${worktree}/parameter-sql`,
              send({ type, value: current, schemas }),
            );
            onChange(result.sql);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setPending(false);
          }
        }}
      >
        {t(advanced ? "resetGuidedForm" : "advancedSql")}
      </button>
    </section>
  );
}
