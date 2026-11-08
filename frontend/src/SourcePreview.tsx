import { api, send } from "./api";
import { useResource, useApiResource } from "./useApiResource";
import { useT } from "./i18n";
import Select from "./Select";
import type { Column, Json } from "./types";

export interface SourceSample {
  columns: Column[];
  rows: Json[][];
  settings?: { delimiter?: string; header?: boolean };
  detected_columns?: Column[];
  /** Why the type overrides could not be read; the detected columns stay listed. */
  error?: string;
}

export const previewFile = (
  worktree: string,
  params: Record<string, Json>,
  signal?: AbortSignal,
) =>
  api<SourceSample>(`/worktrees/${worktree}/source-preview`, {
    ...send(params),
    signal,
  });

const TYPES = [
  "VARCHAR",
  "BOOLEAN",
  "BIGINT",
  "DOUBLE",
  "DECIMAL(18,2)",
  "DATE",
  "TIMESTAMP",
  "TIME",
];

function SampleTable({ data }: { data: SourceSample }) {
  const t = useT();
  return (
    <div
      className="source-sample"
      tabIndex={0}
      role="region"
      aria-label={t("sourcePreview")}
    >
      <table>
        <thead>
          <tr>
            {data.columns.map((column) => (
              <th key={column.name}>
                {column.name}
                <small>{column.type}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>
              {row.map((value, j) => (
                <SampleCell key={j} value={value} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!data.rows.length && <p>{t("sourceEmpty")}</p>}
    </div>
  );
}

function SampleCell({ value }: { value: Json }) {
  const text =
    value === null
      ? "NULL"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return <td title={text}>{text}</td>;
}

export default function SourcePreview({
  worktree,
  params,
  csv,
  tableUrl,
  onTypes,
}: {
  worktree: string;
  params: Record<string, Json> | null;
  csv?: boolean;
  tableUrl?: string | null;
  onTypes: (types: Record<string, Json>) => void;
}) {
  const t = useT();
  const key = params ? JSON.stringify([worktree, params.file]) : null;
  // Changed options reload the same file and keep its sample meanwhile.
  const file = useResource(
    key,
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }).then(() => previewFile(worktree, params!, signal)),
    { refresh: JSON.stringify(params) },
  );
  const table = useApiResource<SourceSample>(tableUrl || null);
  const result = tableUrl ? table : file;
  const types =
    params?.types &&
    typeof params.types === "object" &&
    !Array.isArray(params.types)
      ? params.types
      : {};
  if (!key && !tableUrl) return null;
  const error = result.error || result.data?.error;
  const detected = csv ? result.data?.detected_columns : undefined;
  return (
    <section className="source-preview" aria-label={t("sourcePreview")}>
      <h4>{t("sourcePreview")}</h4>
      <p className="muted">{t("sourcePreviewHint")}</p>
      {result.pending && <p role="status">{t("sourcePreviewLoading")}</p>}
      {error && (
        <pre className="notice error source-error" role="alert">
          {error}
        </pre>
      )}
      {result.data && !result.data.error && <SampleTable data={result.data} />}
      {detected && (
        <table className="source-types">
          <caption>{t("sourceColumnTypes")}</caption>
          <thead>
            <tr>
              <th>{t("column")}</th>
              <th>{t("dataType")}</th>
            </tr>
          </thead>
          <tbody>
            {detected.map((column) => (
              <tr key={column.name}>
                <td>{column.name}</td>
                <td>
                  <Select
                    aria-label={`${t("dataType")}: ${column.name}`}
                    value={String(types[column.name] || "")}
                    onChange={(e) => {
                      const next = { ...types };
                      if (e.target.value) next[column.name] = e.target.value;
                      else delete next[column.name];
                      onTypes(next);
                    }}
                  >
                    <option value="">
                      {t("sourceDetectedType").replace("{type}", column.type)}
                    </option>
                    {[
                      ...new Set([
                        ...TYPES,
                        column.type,
                        ...(types[column.name]
                          ? [String(types[column.name])]
                          : []),
                      ]),
                    ].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
