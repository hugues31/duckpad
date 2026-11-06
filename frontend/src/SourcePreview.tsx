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

export function SampleTable({ data }: { data: SourceSample }) {
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
                <td key={j}>
                  {value === null
                    ? "NULL"
                    : typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!data.rows.length && <p>{t("sourceEmpty")}</p>}
    </div>
  );
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
  const key = params ? JSON.stringify([worktree, params]) : null;
  const file = useResource(key, (signal) =>
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
  return (
    <section className="source-preview" aria-label={t("sourcePreview")}>
      <h4>{t("sourcePreview")}</h4>
      <p className="muted">{t("sourcePreviewHint")}</p>
      {result.pending && <p role="status">{t("sourcePreviewLoading")}</p>}
      {result.error && (
        <p className="notice error" role="alert">
          {result.error}
        </p>
      )}
      {result.data && <SampleTable data={result.data} />}
      {csv && (result.data || Object.keys(types).length > 0) && (
        <table className="source-types">
          <caption>{t("sourceColumnTypes")}</caption>
          <thead>
            <tr>
              <th>{t("column")}</th>
              <th>{t("dataType")}</th>
            </tr>
          </thead>
          <tbody>
            {(
              result.data?.detected_columns ||
              result.data?.columns ||
              Object.keys(types).map((name) => ({ name, type: "VARCHAR" }))
            ).map((column) => (
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
