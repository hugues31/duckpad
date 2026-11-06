import Select from "./Select";
import { useState } from "react";
import { useT } from "./i18n";
import type { Column, Json, VariablesSummary } from "./types";
import {
  expressionReference,
  formatVariableValue,
  usableInExpressions,
} from "./variables";

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const numericType =
  /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|BIGNUM|FLOAT|DOUBLE|DECIMAL(?:\(\d+,\s*\d+\))?)$/i;
const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
/** Formats a fixed value from the input column's type, not from its spelling. */
const literal = (value: string, type = "") => {
  if (numericType.test(type) && number.test(value)) return value;
  if (type === "BOOLEAN" && /^(true|false)$/i.test(value))
    return value.toUpperCase();
  // Text, other types and unknown schemas keep the user's value as a string.
  // Null checks use the explicit IS NULL / IS NOT NULL operators.
  return "'" + value.replaceAll("'", "''") + "'";
};

interface Measure {
  function: string;
  column: string;
  alias: string;
}

const validMeasure = (m: Measure) =>
  !!m.column && !!m.alias && (m.column !== "*" || m.function === "COUNT");

const measureSql = (m: Measure) =>
  `${m.function === "COUNT DISTINCT" ? "COUNT" : m.function}(${m.function === "COUNT DISTINCT" ? "DISTINCT " : ""}${m.column === "*" ? "*" : quote(m.column)}) AS ${quote(m.alias)}`;

/**
 * Optional form helpers for the expression parameters shown below them.
 * Each complete change of the form rewrites those parameters directly.
 */
export default function QueryBuilder({
  kind,
  parameters,
  schemas,
  variables,
  environment,
  onChange,
}: {
  kind: string;
  parameters?: string[];
  schemas: Record<string, Column[]>;
  /** The variables a filter value can reference; only root flow nodes can. */
  variables?: VariablesSummary | null;
  environment?: string;
  onChange: (parameters: Record<string, Json>) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState({
    column: "",
    operator: "=",
    value: "",
    variable: "",
  });
  const [join, setJoin] = useState({ left: "", right: "" });
  const [aggregate, setAggregate] = useState<{
    groups: string[];
    measures: Measure[];
  }>({
    groups: [],
    measures: [{ function: "SUM", column: "", alias: "total" }],
  });
  const usable = Object.entries(variables?.declarations || {}).filter(
    ([, declared]) => usableInExpressions(declared.type),
  );
  // A variable deleted or retyped since it was chosen is no longer offered.
  const usableVariable = (name: string) =>
    usable.some(([usableName]) => usableName === name) ? name : "";
  const variable = usableVariable(filter.variable);
  const names = (columns: Column[] = []) => columns.map(({ name }) => name);
  const inputColumns = schemas.source || schemas.left || [];
  const columns = names(inputColumns);
  const changeFilter = (change: Partial<typeof filter>) => {
    const next = { ...filter, ...change };
    setFilter(next);
    if (!next.column) return;
    const chosen = usableVariable(next.variable);
    const operand = next.operator.includes("NULL")
      ? ""
      : " " +
        (chosen
          ? expressionReference(chosen)
          : literal(
              next.value,
              inputColumns.find((input) => input.name === next.column)?.type,
            ));
    onChange({
      condition: `${quote(next.column)} ${next.operator}${operand}`,
    });
  };
  const changeJoin = (change: Partial<typeof join>) => {
    const next = { ...join, ...change };
    setJoin(next);
    if (next.left && next.right)
      onChange({ condition: `l.${quote(next.left)} = r.${quote(next.right)}` });
  };
  const changeAggregate = (change: Partial<typeof aggregate>) => {
    const next = { ...aggregate, ...change };
    setAggregate(next);
    if (next.groups.length && next.measures.every(validMeasure))
      onChange({
        groups: next.groups.map(quote).join(", "),
        measures: next.measures.map(measureSql).join(", "),
      });
  };
  const changeMeasure = (index: number, change: Partial<Measure>) =>
    changeAggregate({
      measures: aggregate.measures.map((m, i) =>
        i === index ? { ...m, ...change } : m,
      ),
    });
  const choose = (
    label: string,
    selected: string,
    change: (v: string) => void,
    names: string[],
  ) => (
    <label className="field">
      <span>{label}</span>
      <Select
        aria-label={label}
        value={selected}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">{t("chooseColumn")}</option>
        {names.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </Select>
    </label>
  );
  const required: Record<string, string[]> = {
    filter: ["condition"],
    join: ["condition"],
    aggregate: ["groups", "measures"],
  };
  if (
    !required[kind] ||
    (parameters && !required[kind].every((name) => parameters.includes(name)))
  )
    return null;
  return (
    <details className="query-builder" open>
      <summary>{t("guidedConfiguration")}</summary>
      {!columns.length && <p className="muted small">{t("schemaHint")}</p>}
      {kind === "filter" && (
        <>
          {choose(
            t("column"),
            filter.column,
            (column) => changeFilter({ column }),
            columns,
          )}
          <label className="field">
            <span>{t("operator")}</span>
            <Select
              aria-label={t("operator")}
              value={filter.operator}
              onChange={(e) => changeFilter({ operator: e.target.value })}
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
                <option key={op}>{op}</option>
              ))}
            </Select>
          </label>
          {!filter.operator.includes("NULL") && (
            <div className="field">
              <span>{t("value")}</span>
              <div className="filter-value">
                {!!usable.length && (
                  <Select
                    aria-label={t("filterValueSource")}
                    value={variable}
                    onChange={(e) => changeFilter({ variable: e.target.value })}
                  >
                    <option value="">{t("fixedValue")}</option>
                    <optgroup label={t("variables")}>
                      {usable.map(([name, declared]) => (
                        <option key={name} value={name}>
                          {name} ·{" "}
                          {declared.values[environment || ""]?.error
                            ? t("noVariableValue")
                            : formatVariableValue(
                                declared.values[environment || ""]?.value,
                              )}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                )}
                {!variable && (
                  <input
                    aria-label={t("value")}
                    value={filter.value}
                    onChange={(e) => changeFilter({ value: e.target.value })}
                  />
                )}
              </div>
            </div>
          )}
        </>
      )}
      {kind === "join" && (
        <>
          {choose(
            t("leftKey"),
            join.left,
            (left) => changeJoin({ left }),
            names(schemas.left),
          )}
          {choose(
            t("rightKey"),
            join.right,
            (right) => changeJoin({ right }),
            names(schemas.right),
          )}
        </>
      )}
      {kind === "aggregate" && (
        <>
          <label className="field">
            <span>{t("groupBy")}</span>
            <Select
              multiple
              value={aggregate.groups}
              onChange={(e) =>
                changeAggregate({
                  groups: Array.from(
                    e.target.selectedOptions,
                    (option) => option.value,
                  ),
                })
              }
            >
              {columns.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
          </label>
          {aggregate.measures.map((measure, index) => (
            <div className="measure-form" key={index}>
              <label className="field">
                <span>{t("function")}</span>
                <Select
                  value={measure.function}
                  onChange={(e) =>
                    changeMeasure(index, { function: e.target.value })
                  }
                >
                  {["SUM", "AVG", "MIN", "MAX", "COUNT", "COUNT DISTINCT"].map(
                    (fn) => (
                      <option key={fn}>{fn}</option>
                    ),
                  )}
                </Select>
              </label>
              {choose(
                t("column"),
                measure.column,
                (column) => changeMeasure(index, { column }),
                ["*", ...columns],
              )}
              <label className="field">
                <span>{t("alias")}</span>
                <input
                  value={measure.alias}
                  onChange={(e) =>
                    changeMeasure(index, { alias: e.target.value })
                  }
                />
              </label>
              {aggregate.measures.length > 1 && (
                <button
                  className="text-button danger"
                  onClick={() =>
                    changeAggregate({
                      measures: aggregate.measures.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  {t("remove")}
                </button>
              )}
            </div>
          ))}
          <button
            className="text-button"
            onClick={() =>
              changeAggregate({
                measures: [
                  ...aggregate.measures,
                  { function: "COUNT", column: "*", alias: "count" },
                ],
              })
            }
          >
            {t("addMeasure")}
          </button>
        </>
      )}
      <p className="muted small">{t("advancedExpressionHint")}</p>
    </details>
  );
}
