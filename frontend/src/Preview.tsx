import Select from "./Select";
import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Loader2,
  Play,
  Search,
  X,
} from "lucide-react";
import { api, ApiError, withQuery } from "./api";
import { formatValue } from "./graph";
import type { Cell } from "./lineageGraph";
import type { PreviewPage, Snapshot } from "./types";
import { useT } from "./i18n";
import { useResource } from "./useApiResource";
import { useStaleVariables } from "./VariableFields";

export interface PreviewQuery {
  port: string;
  limit: number;
  offset: number;
  sort: string;
  descending: boolean;
  filterColumn: string;
  /** The applied filter text. */
  filter: string;
}

const initialQuery = (port: string, limit: number): PreviewQuery => ({
  port,
  limit,
  offset: 0,
  sort: "",
  descending: false,
  filterColumn: "",
  filter: "",
});

/**
 * The rows of a node, loaded once for the data preview and the Inspector.
 * The query restarts from the first output port when the node, its outputs or
 * the environment change; the row limit is kept.
 */
export function useNodePreview({
  worktree,
  environment,
  node,
  ports,
  version,
}: {
  worktree: string;
  environment: string;
  /** The node to preview, or null when it has no output. */
  node: string | null;
  ports: string[];
  /** Changes whenever results may have changed. */
  version: string;
}) {
  const owner = JSON.stringify([worktree, environment, node, ports]);
  const firstPort = ports[0] || "result";
  const [state, setState] = useState(() => ({
    owner,
    query: initialQuery(firstPort, 100),
  }));
  const query =
    state.owner === owner
      ? state.query
      : initialQuery(firstPort, state.query.limit);
  const path =
    node === null
      ? null
      : withQuery(
          `/worktrees/${worktree}/preview/${encodeURIComponent(node)}`,
          {
            environment,
            port: query.port,
            limit: query.limit,
            offset: query.offset,
            descending: query.descending,
            filters: JSON.stringify(
              query.filterColumn && query.filter
                ? { [query.filterColumn]: query.filter }
                : {},
            ),
            sort: query.sort || undefined,
          },
        );
  // The current page stays visible while another page, order or filter loads.
  const { data, error, pending } = useResource(
    node === null ? null : `${worktree}:${node}`,
    async (signal) => {
      try {
        return await api<PreviewPage>(path!, { signal });
      } catch (e) {
        // A node without a result yet has nothing to preview.
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    { refresh: `${path}:${version}` },
  );
  // Merge into the latest query: a delayed filter must not undo other changes.
  const update = useCallback(
    (change: Partial<PreviewQuery>) =>
      setState((current) => ({
        owner,
        query: {
          ...(current.owner === owner
            ? current.query
            : initialQuery(firstPort, current.query.limit)),
          ...change,
        },
      })),
    [owner, firstPort],
  );
  // Filter the first column until another existing one is chosen.
  const columns = data?.columns || [];
  if (columns.length && !columns.some((c) => c.name === query.filterColumn))
    update({ filterColumn: columns[0].name });
  return { data, error, pending, query, update };
}
export type NodePreview = ReturnType<typeof useNodePreview>;

/** The rows of the selected node, loaded by `useNodePreview`. */
export default function Preview({
  readOnly = false,
  snapshot,
  environment,
  preview: { data, error, pending: loading, query, update },
  ports,
  active,
  hidden,
  onClose,
  onRun,
  onExplain,
}: {
  readOnly?: boolean;
  snapshot: Snapshot;
  environment: string;
  preview: NodePreview;
  ports: string[];
  active: boolean;
  hidden: boolean;
  onClose: () => void;
  onRun: () => void;
  onExplain: (cell: Cell) => void;
}) {
  const t = useT();
  const { port, limit, offset, sort, descending, filterColumn } = query;
  const [filter, setFilter] = useState(query.filter);
  const staleVariables = useStaleVariables(snapshot, environment, data);
  useEffect(() => {
    if (filter === query.filter) return;
    const timer = setTimeout(() => update({ filter, offset: 0 }), 250);
    return () => clearTimeout(timer);
  }, [filter, query.filter, update]);
  return (
    <section
      className="preview-panel"
      id="data-preview"
      aria-label={t("preview")}
      hidden={hidden}
    >
      <div className="preview-header">
        <div className="row gap">
          <Database size={15} />
          <strong>{t("preview")}</strong>
          {ports.length > 1 && (
            <Select
              aria-label={t("output")}
              value={port}
              onChange={(e) => update({ port: e.target.value, offset: 0 })}
            >
              {ports.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          )}
          {data && (
            <span className={`badge ${data.status}`}>{t(data.status)}</span>
          )}
          {!!staleVariables.length && (
            <span className="stale-reason">{staleVariables.join(" ")}</span>
          )}
          {loading && <Loader2 size={14} className="spin" />}
        </div>
        <div className="row gap">
          {data && (
            <span className="muted small">
              {data.count.toLocaleString()} {t("rows")} · {data.columns.length}{" "}
              {t("columns")}
            </span>
          )}
          <button className="icon" title={t("hidePreview")} onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      {data ? (
        <>
          <div className="preview-tools">
            <div className="search">
              <Search size={13} />
              <input
                aria-label={t("filterRows")}
                placeholder={t("filterRows")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {filter && (
                <button
                  className="icon"
                  title={t("clear")}
                  onClick={() => setFilter("")}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <Select
              aria-label={t("filterColumn")}
              value={filterColumn}
              onChange={(e) => update({ filterColumn: e.target.value })}
            >
              {data.columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </Select>
            <span className="spacer" />
            <Select
              aria-label={t("rowLimit")}
              value={limit}
              onChange={(e) =>
                update({ limit: Number(e.target.value), offset: 0 })
              }
            >
              {[25, 100, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n} {t("rows")}
                </option>
              ))}
            </Select>
          </div>
          {data.error && <div className="inline-error">{data.error}</div>}
          <div className="data-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="row-number">#</th>
                  {data.columns.map((column) => (
                    <th key={column.name}>
                      <button
                        onClick={() =>
                          update({
                            sort: column.name,
                            descending:
                              sort === column.name ? !descending : false,
                          })
                        }
                      >
                        <span>
                          {column.name}
                          {sort === column.name
                            ? descending
                              ? " ↓"
                              : " ↑"
                            : ""}
                        </span>
                        <small>{column.type}</small>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="row-number">{row.id + 1}</td>
                    {row.values.map((value, i) => (
                      <td key={i}>
                        <button
                          className={`cell ${value === null ? "null" : ""}`}
                          disabled={data.status !== "valid" || active}
                          title={
                            data.status === "valid"
                              ? t("explain")
                              : t("staleHint")
                          }
                          aria-label={`${t("explain")}: ${data.columns[i].name}, ${t("rows")} ${row.id + 1}, ${formatValue(value)}`}
                          onClick={() =>
                            onExplain({
                              dataset: data.id,
                              row: row.id,
                              column: data.columns[i].name,
                            })
                          }
                        >
                          {formatValue(value)}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.rows.length && (
              <p className="empty-small">{t("noMatches")}</p>
            )}
          </div>
          <div className="preview-footer">
            <span title={data.created}>
              {data.status === "stale" ? t("staleHint") : t("snapshotHint")}
            </span>
            <div className="row">
              <span>
                {offset + 1}–{Math.min(offset + limit, data.filtered_count)} /{" "}
                {data.filtered_count}
              </span>
              <button
                className="icon"
                disabled={!offset}
                title={t("previous")}
                onClick={() => update({ offset: Math.max(0, offset - limit) })}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="icon"
                disabled={offset + limit >= data.filtered_count}
                title={t("next")}
                onClick={() => update({ offset: offset + limit })}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="preview-empty">
          <Database size={25} />
          <div>
            <strong>{error || t("noResult")}</strong>
            <p>{t(readOnly ? "readerNoResult" : "noResultHint")}</p>
          </div>
          <button
            className="button secondary small"
            disabled={readOnly || active}
            onClick={onRun}
          >
            <Play size={13} />
            {t("runNode")}
          </button>
        </div>
      )}
    </section>
  );
}
