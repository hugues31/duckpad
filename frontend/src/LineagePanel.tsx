import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  GitBranch,
  Loader2,
  X,
} from "lucide-react";
import { api, send, withQuery } from "./api";
import { formatValue } from "./graph";
import type { Json } from "./types";
import { useT } from "./i18n";
const GENERATION_CHECK_INTERVAL = 500;

export default function LineagePanel({
  worktree,
  environment,
  cell,
  onClose,
}: {
  worktree: string;
  environment: string;
  cell: Json;
  onClose: () => void;
}) {
  const t = useT();
  const [history, setHistory] = useState<Json[]>([cell]);
  const [result, setResult] = useState<Json | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const interrupted = useRef(false);
  useEffect(() => setHistory([cell]), [cell]);
  // Watch the explained result generation; a recalculation interrupts this view for good.
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    interrupted.current = false;
    const verify = async () => {
      try {
        const state = await api(
          withQuery(`/worktrees/${worktree}/generations/${cell.dataset}`, {
            environment,
          }),
        );
        if (live && !state.valid) {
          interrupted.current = true;
          serial.current++;
          clearInterval(timer);
          setResult(null);
          setPending(false);
          setError(t("lineageInterrupted"));
        }
      } catch {
        // Transient failures are retried by the next check.
      }
    };
    void verify();
    timer = window.setInterval(verify, GENERATION_CHECK_INTERVAL);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [worktree, environment, cell, t]);
  const current = history[history.length - 1];
  // Responses belong to an explicit result generation; never replay on refresh.
  useEffect(() => {
    if (interrupted.current) return;
    const id = ++serial.current;
    setPending(true);
    setError("");
    api(`/worktrees/${worktree}/lineage`, send({ ...current, environment }))
      .then((r) => {
        if (serial.current === id) setResult(r);
      })
      .catch((e) => {
        if (serial.current === id) {
          setError(e.message);
          setResult(null);
        }
      })
      .finally(() => {
        if (serial.current === id) setPending(false);
      });
    return () => {
      serial.current++;
    };
  }, [worktree, environment, current]);
  const change = (values: Json) =>
    setHistory([...history.slice(0, -1), { ...current, ...values }]);
  const navigate = (contribution: Json) =>
    setHistory([
      ...history,
      {
        dataset: contribution.dataset,
        row: contribution.row,
        column: contribution.column,
      },
    ]);
  return (
    <aside className="inspector lineage-panel">
      <div className="inspector-title">
        <span className="row gap">
          <GitBranch size={18} />
          {t("lineage")}
        </span>
        <button className="icon" title={t("close")} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="lineage-body">
        {history.length > 1 && !interrupted.current && (
          <button
            className="text-button"
            onClick={() => setHistory(history.slice(0, -1))}
          >
            <ArrowLeft size={14} />
            {t("back")}
          </button>
        )}
        {pending ? (
          <div className="empty-small">
            <Loader2 className="spin" size={24} />
            <p>{t("loading")}</p>
          </div>
        ) : error ? (
          <div className="notice error">{error}</div>
        ) : (
          result && (
            <>
              <div className="value-card">
                <span className="eyebrow">{result.column}</span>
                <strong>{formatValue(result.value)}</strong>
                <span className="muted small">
                  {t("rows")} {result.row + 1} · {result.execution.slice(0, 12)}
                </span>
              </div>
              <div
                className={`lineage-quality ${result.complete ? "complete" : "partial"}`}
              >
                <CheckCircle2 size={14} />
                {t(result.complete ? "complete" : "partial")}
              </div>
              {result.warnings?.map((w: string) => (
                <p key={w} className="notice warning">
                  {w}
                </p>
              ))}
              <h4>{t("columnLineage")}</h4>
              <pre className="expression">{result.expression}</pre>
              {result.kind === "source" ? (
                <div className="source-card">
                  <Database size={22} />
                  <div>
                    <strong>{t("sourceValue")}</strong>
                    <p>
                      {result.contributions[0]?.node} ·{" "}
                      {result.contributions[0]?.port}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="row spread">
                    <h4>
                      {result.total.toLocaleString()}{" "}
                      {t(
                        result.kind === "distinct_groups"
                          ? "valueGroups"
                          : "contributions",
                      )}
                    </h4>
                    {result.context_total > 0 && (
                      <button
                        className="text-button small"
                        onClick={() =>
                          change({
                            context: !current.context,
                            offset: 0,
                            group: undefined,
                          })
                        }
                      >
                        {t(
                          current.context ? "showContributors" : "showContext",
                        )}
                      </button>
                    )}
                  </div>
                  {result.groups?.map((group: Json) => (
                    <button
                      key={group.key}
                      className="contribution"
                      onClick={() =>
                        setHistory([
                          ...history,
                          { ...current, group: group.key, offset: 0 },
                        ])
                      }
                    >
                      <span className="contribution-value">
                        {formatValue(group.value)}
                      </span>
                      <span>
                        {group.rows} {t("inputRows")}
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                  {result.contributions?.map((item: Json, i: number) => (
                    <button
                      key={i}
                      className="contribution"
                      onClick={() => navigate(item)}
                    >
                      <span className="contribution-value">
                        {formatValue(item.value)}
                      </span>
                      <span>
                        <strong>{item.column}</strong>
                        <small>
                          {item.node.split("::").at(-1)} · #{item.row + 1}
                        </small>
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                  <div className="row spread pager">
                    <button
                      className="button secondary small"
                      disabled={!current.offset}
                      onClick={() =>
                        change({
                          offset: Math.max(
                            0,
                            (current.offset || 0) - result.page_size,
                          ),
                        })
                      }
                    >
                      <ChevronLeft size={14} />
                      {t("previous")}
                    </button>
                    <span className="muted small">
                      {Math.min(
                        (current.offset || 0) + result.page_size,
                        result.total,
                      )}{" "}
                      / {result.total}
                    </span>
                    <button
                      className="button secondary small"
                      disabled={
                        (current.offset || 0) + result.page_size >= result.total
                      }
                      onClick={() =>
                        change({
                          offset: (current.offset || 0) + result.page_size,
                        })
                      }
                    >
                      {t("next")}
                      <ChevronRight size={14} />
                    </button>
                  </div>
                  {!!result.context?.length && (
                    <details className="context-details">
                      <summary>
                        {t("selectionContext")} · {result.context_total}
                      </summary>
                      {result.context.map((item: Json, i: number) => (
                        <button
                          key={i}
                          className="contribution"
                          onClick={() => navigate(item)}
                        >
                          <span>{formatValue(item.value)}</span>
                          <span>
                            {item.column}
                            <small>#{item.row + 1}</small>
                          </span>
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                    </details>
                  )}
                  {!!result.tables?.length && (
                    <details className="context-details">
                      <summary>{t("tableLineage")}</summary>
                      {result.tables.map((table: Json) => (
                        <div className="table-reference" key={table.dataset}>
                          <Database size={14} />
                          <span>
                            {table.node}
                            <small>
                              {table.port} · {table.columns.length}{" "}
                              {t("columns")}
                            </small>
                          </span>
                        </div>
                      ))}
                    </details>
                  )}
                </>
              )}
            </>
          )
        )}
      </div>
    </aside>
  );
}
