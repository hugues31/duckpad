import { useT } from "./i18n";
import Select from "./Select";
import type { Column } from "./types";

const types = [
  "VARCHAR",
  "BOOLEAN",
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "FLOAT",
  "DOUBLE",
  "DECIMAL(18,2)",
  "DATE",
  "TIMESTAMP",
  "TIMESTAMPTZ",
];

/** The setting of one column; the "in" checks tell enabled options apart. */
type PreparationRow = {
  source?: string;
  /** The output name of a selected column. */
  name?: string;
  type?: string;
  trim?: boolean;
  date_format?: string;
  replacement?: string;
};

/** Structured template parameters are the form state, including after a reload. */
export default function ColumnPreparation({
  kind,
  value,
  columns,
  onChange,
  onBlur,
}: {
  kind: string;
  value: unknown;
  columns: Column[];
  onChange: (value: PreparationRow[]) => void;
  onBlur?: () => void;
}) {
  const t = useT();
  const selecting = kind === "column_selection";
  // Project files may hold anything: rows that are not objects are reported.
  const rows: PreparationRow[] = Array.isArray(value) ? value : [];
  const malformed =
    !Array.isArray(value) ||
    rows.some((row) => !row || typeof row !== "object" || Array.isArray(row));
  const update = (index: number, patch: PreparationRow) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const removeSetting = (index: number, name: "date_format" | "replacement") =>
    onChange(
      rows.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row };
        delete next[name];
        return next;
      }),
    );
  const move = (index: number, delta: number) => {
    const next = [...rows];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return (
    <section
      className="query-builder column-preparation"
      aria-label={t(selecting ? "select_columns" : "clean_values")}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onBlur?.();
      }}
    >
      <p className="muted small">
        {t(selecting ? "selectColumnsHint" : "cleanValuesHint")}
      </p>
      {!columns.length && <p className="notice">{t("schemaHint")}</p>}
      {malformed ? (
        <p role="alert" className="notice error">
          {t("invalidColumnSettings")}
        </p>
      ) : (
        rows.map((row, index) => {
          const source = columns.find((column) => column.name === row.source);
          const name = row.name ?? row.source ?? "";
          const duplicate =
            selecting &&
            rows.some(
              (other, i) =>
                i !== index &&
                String(other.name ?? other.source ?? "").replace(
                  /[A-Z]/g,
                  (c) => c.toLowerCase(),
                ) === String(name).replace(/[A-Z]/g, (c) => c.toLowerCase()),
            );
          const missing = columns.length > 0 && !source;
          const invalidName =
            selecting &&
            (typeof name !== "string" ||
              !name.trim() ||
              // eslint-disable-next-line no-control-regex -- names exclude control characters
              /[\x00-\x1f]/.test(name));
          const textOperation = Boolean(row.trim || "date_format" in row);
          return (
            <fieldset className="preparation-row" key={index}>
              <legend>
                {t("column")} {index + 1}
              </legend>
              <label className="field">
                <span>{t("sourceColumn")}</span>
                <Select
                  aria-label={t("sourceColumn")}
                  value={row.source || ""}
                  onChange={(e) => update(index, { source: e.target.value })}
                >
                  <option value="">{t("chooseColumn")}</option>
                  {row.source && !source && (
                    <option value={row.source}>{row.source}</option>
                  )}
                  {columns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name} · {column.type}
                    </option>
                  ))}
                </Select>
              </label>
              {missing && (
                <p role="alert" className="notice error">
                  {t("missingSourceColumn")}
                </p>
              )}
              {selecting ? (
                <>
                  <label className="field">
                    <span>{t("outputName")}</span>
                    <input
                      value={name}
                      onChange={(e) => update(index, { name: e.target.value })}
                      aria-invalid={invalidName || duplicate}
                    />
                  </label>
                  {invalidName && (
                    <p role="alert" className="notice error">
                      {t("invalidOutputName")}
                    </p>
                  )}
                  {duplicate && (
                    <p role="alert" className="notice error">
                      {t("duplicateOutputName")}
                    </p>
                  )}
                  <label className="field">
                    <span>{t("outputType")}</span>
                    <Select
                      aria-label={t("outputType")}
                      value={row.type || ""}
                      onChange={(e) => update(index, { type: e.target.value })}
                    >
                      <option value="">{t("keepSourceType")}</option>
                      {row.type && !types.includes(row.type) && (
                        <option>{row.type}</option>
                      )}
                      {types.map((type) => (
                        <option key={type}>{type}</option>
                      ))}
                    </Select>
                  </label>
                  <div className="preparation-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      {t("moveColumnUp")}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      {t("moveColumnDown")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="preparation-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(row.trim)}
                      onChange={(e) =>
                        update(index, { trim: e.target.checked })
                      }
                    />
                    {t("trimText")}
                  </label>
                  <label className="preparation-toggle">
                    <input
                      type="checkbox"
                      checked={"date_format" in row}
                      onChange={(e) =>
                        e.target.checked
                          ? update(index, { date_format: "%d/%m/%Y" })
                          : removeSetting(index, "date_format")
                      }
                    />
                    {t("parseDate")}
                  </label>
                  {"date_format" in row && (
                    <label className="field">
                      <span>{t("dateFormat")}</span>
                      <input
                        aria-label={t("dateFormat")}
                        value={row.date_format}
                        placeholder="%d/%m/%Y"
                        onChange={(e) =>
                          update(index, { date_format: e.target.value })
                        }
                      />
                      <small>{t("dateFormatHint")}</small>
                    </label>
                  )}
                  {textOperation && source && source.type !== "VARCHAR" && (
                    <p role="alert" className="notice error">
                      {t("textOperationTypeHint")}
                    </p>
                  )}
                  <label className="preparation-toggle">
                    <input
                      type="checkbox"
                      checked={"replacement" in row}
                      onChange={(e) =>
                        e.target.checked
                          ? update(index, { replacement: "" })
                          : removeSetting(index, "replacement")
                      }
                    />
                    {t("replaceNulls")}
                  </label>
                  {"replacement" in row && (
                    <label className="field">
                      <span>{t("replacementValue")}</span>
                      <input
                        aria-label={t("replacementValue")}
                        value={row.replacement}
                        onChange={(e) =>
                          update(index, { replacement: e.target.value })
                        }
                      />
                      <small>{t("replacementTypeHint")}</small>
                    </label>
                  )}
                </>
              )}
              <button
                type="button"
                className="text-button danger"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                {t(selecting ? "dropColumn" : "removeCleaning")}
              </button>
            </fieldset>
          );
        })
      )}
      <div className="preparation-actions">
        <button
          type="button"
          className="button secondary"
          disabled={malformed || !columns.length}
          onClick={() => {
            const next =
              columns.find(
                (column) => !rows.some((row) => row.source === column.name),
              ) || columns[0];
            onChange([...rows, { source: next.name }]);
          }}
        >
          {t("addColumn")}
        </button>
        {selecting && (
          <button
            type="button"
            className="text-button"
            disabled={malformed || !columns.length}
            onClick={() =>
              onChange([
                ...rows,
                ...columns
                  .filter(
                    (column) => !rows.some((row) => row.source === column.name),
                  )
                  .map((column) => ({ source: column.name })),
              ])
            }
          >
            {t("useAllColumns")}
          </button>
        )}
      </div>
      {!selecting && !rows.length && (
        <p className="muted small">{t("noCleaning")}</p>
      )}
      {selecting && !rows.length && (
        <p role="alert" className="notice">
          {t("chooseOutputColumns")}
        </p>
      )}
    </section>
  );
}
