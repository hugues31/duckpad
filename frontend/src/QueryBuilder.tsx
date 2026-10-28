import Select from "./Select";
import { useState } from "react";
import { useT } from "./i18n";
import type { Json } from "./types";

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const literal = (value: string) => {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  if (/^(true|false|null)$/i.test(value)) return value.toUpperCase();
  return "'" + value.replaceAll("'", "''") + "'";
};

/** Optional form helpers write the same expression parameters as the SQL form. */
export default function QueryBuilder({
  kind,
  schemas,
  onApply,
}: {
  kind: string;
  schemas: Record<string, string[]>;
  onApply: (parameters: Json) => void;
}) {
  const t = useT();
  const [column, setColumn] = useState("");
  const [right, setRight] = useState("");
  const [operator, setOperator] = useState("=");
  const [value, setValue] = useState("");
  const [groups, setGroups] = useState<string[]>([]);
  const [measures, setMeasures] = useState([
    { function: "SUM", column: "", alias: "total" },
  ]);
  const columns = schemas.source || schemas.left || [];
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
  if (!["filter", "aggregate", "join"].includes(kind)) return null;
  return (
    <details className="query-builder" open>
      <summary>{t("guidedConfiguration")}</summary>
      {!columns.length && <p className="muted small">{t("schemaHint")}</p>}
      {kind === "filter" && (
        <>
          {choose(t("column"), column, setColumn, columns)}
          <label className="field">
            <span>{t("operator")}</span>
            <Select
              aria-label={t("operator")}
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
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
          {!operator.includes("NULL") && (
            <label className="field">
              <span>{t("value")}</span>
              <input value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
          )}
          <button
            className="button secondary full"
            disabled={!column}
            onClick={() =>
              onApply({
                condition: `${quote(column)} ${operator}${operator.includes("NULL") ? "" : " " + literal(value)}`,
              })
            }
          >
            {t("applyExpression")}
          </button>
        </>
      )}
      {kind === "join" && (
        <>
          {choose(t("leftKey"), column, setColumn, schemas.left || [])}
          {choose(t("rightKey"), right, setRight, schemas.right || [])}
          <button
            className="button secondary full"
            disabled={!column || !right}
            onClick={() =>
              onApply({ condition: `l.${quote(column)} = r.${quote(right)}` })
            }
          >
            {t("applyExpression")}
          </button>
        </>
      )}
      {kind === "aggregate" && (
        <>
          <label className="field">
            <span>{t("groupBy")}</span>
            <Select
              multiple
              value={groups}
              onChange={(e) =>
                setGroups(
                  Array.from(
                    e.target.selectedOptions,
                    (option) => option.value,
                  ),
                )
              }
            >
              {columns.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
          </label>
          {measures.map((measure, index) => (
            <div className="measure-form" key={index}>
              <label className="field">
                <span>{t("function")}</span>
                <Select
                  value={measure.function}
                  onChange={(e) =>
                    setMeasures(
                      measures.map((m, i) =>
                        i === index ? { ...m, function: e.target.value } : m,
                      ),
                    )
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
                (v) =>
                  setMeasures(
                    measures.map((m, i) =>
                      i === index ? { ...m, column: v } : m,
                    ),
                  ),
                ["*", ...columns],
              )}
              <label className="field">
                <span>{t("alias")}</span>
                <input
                  value={measure.alias}
                  onChange={(e) =>
                    setMeasures(
                      measures.map((m, i) =>
                        i === index ? { ...m, alias: e.target.value } : m,
                      ),
                    )
                  }
                />
              </label>
              {measures.length > 1 && (
                <button
                  className="text-button danger"
                  onClick={() =>
                    setMeasures(measures.filter((_, i) => i !== index))
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
              setMeasures([
                ...measures,
                { function: "COUNT", column: "*", alias: "count" },
              ])
            }
          >
            {t("addMeasure")}
          </button>
          <button
            className="button secondary full"
            disabled={
              !groups.length ||
              measures.some(
                (m) =>
                  !m.column ||
                  !m.alias ||
                  (m.column === "*" && m.function !== "COUNT"),
              )
            }
            onClick={() =>
              onApply({
                groups: groups.map(quote).join(", "),
                measures: measures
                  .map(
                    (m) =>
                      `${m.function === "COUNT DISTINCT" ? "COUNT" : m.function}(${m.function === "COUNT DISTINCT" ? "DISTINCT " : ""}${m.column === "*" ? "*" : quote(m.column)}) AS ${quote(m.alias)}`,
                  )
                  .join(", "),
              })
            }
          >
            {t("applyExpression")}
          </button>
        </>
      )}
      <p className="muted small">{t("advancedExpressionHint")}</p>
    </details>
  );
}
