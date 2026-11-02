import { useState } from "react";
import { withQuery } from "./api";
import { useT, useTranslateValue } from "./i18n";
import type { PartitionPage } from "./partitions";
import type { Run } from "./types";
import Select from "./Select";
import { useApiResource } from "./useApiResource";
import { useOptionalWorktree } from "./worktree";

/** Run pages read that run's immutable attempts, independently of current previews. */
export function PartitionHistory({ run }: { run: Run }) {
  const t = useT();
  const translate = useTranslateValue();
  const worktree = useOptionalWorktree();
  const [node, setNode] = useState(
    Object.keys(run.nodes).find((key) => run.nodes[key].partitioned) || "",
  );
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const loaded = useApiResource<PartitionPage>(
    run.partitions?.manifest
      ? withQuery(`/worktrees/${run.worktree}/partitions`, {
          environment: run.environment,
          run: run.id,
          node,
          search,
          cursor,
        })
      : null,
  );
  if (!run.partitions) return null;
  return (
    <section className="partition-strip" aria-label={t("partitions")}>
      <h4>{t("partitions")}</h4>
      <p>
        {run.partitions.completed}/{run.partitions.selected} ·{" "}
        {run.partitions.failed} {t("failed")} · {run.partitions.not_started}{" "}
        {t("partitionNotStarted")}
      </p>
      <div className="row gap">
        <input
          aria-label={t("partitionSearch")}
          placeholder={t("partitionSearch")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setCursor(undefined);
          }}
        />
        <Select
          aria-label={t("node")}
          value={node}
          onChange={(e) => {
            setNode(e.target.value);
            setCursor(undefined);
          }}
        >
          {Object.keys(run.nodes)
            .filter((key) => run.nodes[key].partitioned)
            .map((key) => (
              <option key={key} value={key}>
                {run.nodes[key].label || key}
              </option>
            ))}
        </Select>
        {worktree?.canEdit &&
          worktree.id === run.worktree &&
          worktree.environment === run.environment && (
            <button
              className="button secondary small"
              disabled={!!worktree.statuses.active || worktree.starting}
              onClick={() =>
                worktree.run(run.scope === "project" ? undefined : run.scope, {
                  partitions: { mode: "failed" },
                })
              }
            >
              {t("partitionRunFailed")}
            </button>
          )}
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t("partition")}</th>
            <th>{t("partitionState")}</th>
            <th>{t("rows")}</th>
            <th>{t("partitionDuration")}</th>
            <th>{t("results_log")}</th>
          </tr>
        </thead>
        <tbody>
          {loaded.data?.entries.map((entry) => {
            const state = entry.nodes[node];
            return (
              <tr key={entry.partition_id}>
                <td>{String(entry.key.value)}</td>
                <td>
                  {translate(state?.status || "not_started")}
                  {state?.skipped && ` · ${t("partitionSkipped")}`}
                </td>
                <td>{state?.rows ?? "—"}</td>
                <td>
                  {state?.duration == null
                    ? "—"
                    : `${state.duration.toFixed(2)} s`}
                </td>
                <td>
                  {state?.error || (
                    <details>
                      <summary>{t("executedSqlTitle")}</summary>
                      {state?.attempt?.statements?.map((statement, index) => (
                        <pre key={index}>{statement.sql}</pre>
                      ))}
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {loaded.error && (
        <p className="notice error" role="alert">
          {loaded.error}
        </p>
      )}
      {cursor && (
        <button
          className="button secondary small"
          onClick={() => setCursor(undefined)}
        >
          {t("partitionFirstPage")}
        </button>
      )}
      {loaded.data?.next_cursor && (
        <button
          className="button secondary small"
          onClick={() => setCursor(loaded.data!.next_cursor!)}
        >
          {t("partitionNextPage")}
        </button>
      )}
    </section>
  );
}
