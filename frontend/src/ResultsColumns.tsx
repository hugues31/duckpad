import { useRef, useState } from "react";
import {
  BarChart3,
  CircleCheck,
  GitCompareArrows,
  Loader2,
  Pencil,
} from "lucide-react";
import { api, withQuery } from "./api";
import { useT } from "./i18n";
import { clock, seconds, type ResultsTarget } from "./ResultsPanel";
import type {
  ColumnStatistics,
  Dataset,
  Documentation,
  ResultStatistics,
  Snapshot,
} from "./types";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

/**
 * The columns of a dataset with their type and description, shown at once, and
 * statistics of the whole result computed only when asked.
 */
export default function ResultsColumns({
  snapshot,
  environment,
  target,
  dataset,
  canEdit,
  onSaveDocumentation,
  onColumn,
}: {
  snapshot: Snapshot;
  environment: string;
  target: ResultsTarget;
  dataset?: Dataset;
  canEdit: boolean;
  onSaveDocumentation: (
    change: (documentation: Documentation) => void,
  ) => Promise<unknown>;
  onColumn: (column: string) => void;
}) {
  const t = useT();
  const worktree = snapshot.worktree.id;
  const key = `${target.node}:${target.port}`;
  const documentation = snapshot.bundle?.documentation;
  const descriptions = documentation?.columns?.[key] || {};
  const endpoint = withQuery(
    `/worktrees/${worktree}/statistics/${encodeURIComponent(target.node)}`,
    { environment, port: target.port },
  );
  const loaded = useApiResource<ResultStatistics>(dataset ? endpoint : null, {
    refresh: dataset?.id,
  });
  const compute = useAsyncAction();
  const controller = useRef<AbortController | null>(null);
  const info = loaded.data?.dataset === dataset?.id ? loaded.data : null;
  const statistics = info?.statistics;
  const columns =
    dataset?.columns ||
    // Without a result, documented columns are all the tab can list.
    Object.keys(descriptions).map((name) => ({ name, type: "" }));
  const schema = info?.schema;
  const changes = schema
    ? schema.added.length + schema.removed.length + schema.retyped.length
    : 0;
  return (
    <div className="results-columns">
      <div className="results-toolbar">
        <DatasetDescription
          key={key}
          value={documentation?.datasets?.[key] || ""}
          canEdit={canEdit}
          onSave={(text) =>
            onSaveDocumentation((value) => {
              if (text) (value.datasets ??= {})[key] = text;
              else delete value.datasets?.[key];
            })
          }
        />
        <span className="spacer" />
        {schema && (
          <span
            className={`schema-chip ${changes ? "changed" : ""}`}
            title={
              changes
                ? [
                    ...schema.added.map((name) => `+ ${name}`),
                    ...schema.removed.map((name) => `− ${name}`),
                    ...schema.retyped.map(
                      (item) => `${item.name}: ${item.before} → ${item.after}`,
                    ),
                  ].join("\n")
                : undefined
            }
          >
            {changes ? (
              <GitCompareArrows size={12} aria-hidden="true" />
            ) : (
              <CircleCheck size={12} aria-hidden="true" />
            )}
            {changes
              ? t("schemaChanges")
                  .replace("{added}", String(schema.added.length))
                  .replace("{removed}", String(schema.removed.length))
                  .replace("{retyped}", String(schema.retyped.length))
              : t("sameColumns")}
          </span>
        )}
        {statistics ? (
          <span className="muted small statistics-note">
            <BarChart3 size={12} aria-hidden="true" />
            {t("statisticsComputed")
              .replace("{count}", statistics.count.toLocaleString())
              .replace("{time}", clock(statistics.computed))
              .replace("{duration}", seconds(statistics.duration))}
          </span>
        ) : compute.pending ? (
          <>
            <span className="muted small">
              <Loader2 size={12} className="spin" aria-hidden="true" />{" "}
              {t("computingStatistics")}
            </span>
            <button
              className="button secondary small"
              onClick={() => {
                controller.current?.abort();
                void api(endpoint, { method: "DELETE" }).catch(() => undefined);
              }}
            >
              {t("cancel")}
            </button>
          </>
        ) : (
          dataset && (
            <button
              className="button secondary small"
              title={t("computeStatisticsHint")}
              onClick={() =>
                compute.run(async () => {
                  controller.current = new AbortController();
                  try {
                    const result = await api<ResultStatistics>(endpoint, {
                      method: "POST",
                      signal: controller.current.signal,
                    });
                    loaded.setData(result);
                  } catch (error) {
                    if ((error as Error).name === "AbortError") return;
                    throw error;
                  }
                })
              }
            >
              <BarChart3 size={13} aria-hidden="true" />
              {t("computeStatistics")}
            </button>
          )
        )}
      </div>
      {(compute.error || loaded.error) && (
        <div className="inline-error" role="alert">
          {compute.error || loaded.error}
        </div>
      )}
      {!dataset && (
        <p className="muted small results-note">{t("columnsWithoutResult")}</p>
      )}
      <div className="data-scroll">
        <table className="columns-table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t("column")}</th>
              <th>{t("columnType")}</th>
              {statistics && (
                <>
                  <th className="number">{t("nulls")}</th>
                  <th className="number">{t("distinct")}</th>
                  <th>{t("range")}</th>
                  <th>{t("distribution")}</th>
                </>
              )}
              <th>{t("description")}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column, index) => (
              <tr key={column.name}>
                <td className="muted">{index + 1}</td>
                <td>
                  {dataset ? (
                    <button
                      className="column-name"
                      title={t("showColumn")}
                      onClick={() => onColumn(column.name)}
                    >
                      {column.name}
                    </button>
                  ) : (
                    <strong>{column.name}</strong>
                  )}
                </td>
                <td>
                  <code className="column-type">{column.type}</code>
                </td>
                {statistics && (
                  <StatisticCells value={statistics.columns[column.name]} />
                )}
                <td className="description-cell">
                  <ColumnDescription
                    key={`${key}:${column.name}`}
                    value={descriptions[column.name] || ""}
                    canEdit={canEdit}
                    label={column.name}
                    onSave={(text) =>
                      onSaveDocumentation((value) => {
                        const entries = ((value.columns ??= {})[key] ??= {});
                        if (text) entries[column.name] = text;
                        else delete entries[column.name];
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatisticCells({ value }: { value?: ColumnStatistics }) {
  const t = useT();
  if (!value)
    return (
      <>
        <td />
        <td />
        <td />
        <td />
      </>
    );
  const peak = Math.max(1, ...(value.histogram || []));
  return (
    <>
      <td className="number">
        {value.nulls === null ? "" : `${value.nulls} %`}
      </td>
      <td className="number">{value.distinct.toLocaleString()}</td>
      <td className="range">
        {value.min !== undefined ? `${value.min} … ${value.max}` : ""}
      </td>
      <td>
        {/* Numbers and dates keep their distribution; unique text has no top values. */}
        {value.histogram ? (
          <span className="histogram" aria-label={t("distribution")}>
            {value.histogram.map((count, index) => (
              <span
                key={index}
                style={{ height: `${Math.max(8, (count / peak) * 100)}%` }}
                title={String(count)}
              />
            ))}
          </span>
        ) : value.unique ? (
          <span className="muted">{t("uniqueValues")}</span>
        ) : (
          <span className="top-values">
            {(value.top || []).map((item) => (
              <span key={item.value} className="top-value">
                {item.value} <strong>{item.rows.toLocaleString()}</strong>
              </span>
            ))}
          </span>
        )}
      </td>
    </>
  );
}

function DatasetDescription({
  value,
  canEdit,
  onSave,
}: {
  value: string;
  canEdit: boolean;
  onSave: (text: string) => Promise<unknown>;
}) {
  const t = useT();
  return (
    <div className="dataset-description">
      <span className="muted small">{t("datasetLabel")}</span>
      <InlineText
        value={value}
        canEdit={canEdit}
        label={t("datasetDocs")}
        placeholder={t("addDatasetDescription")}
        onSave={onSave}
      />
    </div>
  );
}

function ColumnDescription({
  value,
  label,
  canEdit,
  onSave,
}: {
  value: string;
  label: string;
  canEdit: boolean;
  onSave: (text: string) => Promise<unknown>;
}) {
  const t = useT();
  return (
    <InlineText
      value={value}
      canEdit={canEdit}
      label={`${t("columnDocs")}: ${label}`}
      placeholder={t("addDescription")}
      onSave={onSave}
    />
  );
}

/** Text shown at once and edited in place with the pencil, saved in documentation.json. */
function InlineText({
  value,
  label,
  placeholder,
  canEdit,
  onSave,
}: {
  value: string;
  label: string;
  placeholder: string;
  canEdit: boolean;
  onSave: (text: string) => Promise<unknown>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const { pending, error, run } = useAsyncAction();
  if (draft !== null)
    return (
      <form
        className="inline-text editing"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await run(() => onSave(draft.trim()))) setDraft(null);
        }}
      >
        <textarea
          autoFocus
          aria-label={label}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button className="button primary small" disabled={pending}>
          {pending ? t("saving") : t("save")}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => setDraft(null)}
        >
          {t("cancel")}
        </button>
        {error && <span className="notice error small">{error}</span>}
      </form>
    );
  return (
    <span className="inline-text">
      <span className={value ? "" : "muted"}>
        {value || (canEdit ? placeholder : "")}
      </span>
      {canEdit && (
        <button
          className="icon"
          title={`${t("edit")}: ${label}`}
          aria-label={`${t("edit")}: ${label}`}
          onClick={() => setDraft(value)}
        >
          <Pencil size={12} />
        </button>
      )}
    </span>
  );
}
