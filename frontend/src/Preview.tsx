import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Loader2,
  Play,
  Search,
  X,
} from "lucide-react";
import { api, formatValue, type Json } from "./types";
import { useT } from "./i18n";

export default function Preview({
  readOnly = false,
  worktree,
  environment,
  node,
  ports,
  version,
  active,
  hidden,
  onClose,
  onRun,
  onExplain,
  onData,
}: {
  readOnly?: boolean;
  worktree: string;
  environment: string;
  node: string;
  ports: string[];
  version: string;
  active: boolean;
  hidden: boolean;
  onClose: () => void;
  onRun: () => void;
  onExplain: (cell: Json) => void;
  onData: (data: Json | null) => void;
}) {
  const t = useT();
  const [port, setPort] = useState(ports[0] || "result");
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("");
  const [descending, setDescending] = useState(false);
  const [filterColumn, setFilterColumn] = useState("");
  const [filter, setFilter] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    setPort(ports[0] || "result");
    setOffset(0);
    setFilter("");
    setSort("");
  }, [node, environment, ports.join("|")]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(filter);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [filter]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      environment,
      port,
      limit: String(limit),
      offset: String(offset),
      descending: String(descending),
      filters: JSON.stringify(
        filterColumn && debounced ? { [filterColumn]: debounced } : {},
      ),
    });
    if (sort) params.set("sort", sort);
    api(`/worktrees/${worktree}/preview/${encodeURIComponent(node)}?${params}`)
      .then((result) => {
        if (live) {
          setData(result);
          onData(result);
          setFilterColumn((old) =>
            old && result.columns.some((c: Json) => c.name === old)
              ? old
              : result.columns[0]?.name || "",
          );
        }
      })
      .catch((e) => {
        if (live) {
          setData(null);
          onData(null);
          if (e.status !== 404) setError(e.message);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [
    worktree,
    environment,
    node,
    port,
    version,
    limit,
    offset,
    sort,
    descending,
    filterColumn,
    debounced,
  ]);
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
            <select
              aria-label={t("output")}
              value={port}
              onChange={(e) => {
                setPort(e.target.value);
                setOffset(0);
              }}
            >
              {ports.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
          {data && (
            <span className={`badge ${data.status}`}>{t(data.status)}</span>
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
            <div className="search compact">
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
            <select
              aria-label={t("filterColumn")}
              value={filterColumn}
              onChange={(e) => setFilterColumn(e.target.value)}
            >
              {data.columns.map((c: Json) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
            <span className="spacer" />
            <select
              aria-label={t("rowLimit")}
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setOffset(0);
              }}
            >
              {[25, 100, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n} {t("rows")}
                </option>
              ))}
            </select>
          </div>
          {data.error && <div className="inline-error">{data.error}</div>}
          <div className="data-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="row-number">#</th>
                  {data.columns.map((column: Json) => (
                    <th key={column.name}>
                      <button
                        onClick={() => {
                          setSort(column.name);
                          setDescending(
                            sort === column.name ? !descending : false,
                          );
                        }}
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
                {data.rows.map((row: Json) => (
                  <tr key={row.id}>
                    <td className="row-number">{row.id + 1}</td>
                    {row.values.map((value: any, i: number) => (
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
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="icon"
                disabled={offset + limit >= data.filtered_count}
                title={t("next")}
                onClick={() => setOffset(offset + limit)}
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
