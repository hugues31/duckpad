import { Database } from "lucide-react";
import { useState } from "react";
import DataGrid from "./DataGrid";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import type { Cell } from "./lineageGraph";
import NoResult from "./NoResult";
import Pager from "./Pager";
import { partitionMessage } from "./partitions";
import {
  outputKey,
  type FailingRows,
  type ResultsTarget,
  type RunState,
  type SaveProject,
} from "./results";
import ResultsToolbar from "./ResultsToolbar";
import { CreateTestModal, SaveViewModal } from "./SampleModals";
import {
  ALL_ROWS,
  normalizedSample,
  outputViews,
  sameSample,
  saveView,
  type Sample,
} from "./samples";
import type { Dataset, FlowNode, Snapshot } from "./types";
import { PAGE_SIZE, useResultsPage } from "./useResultsPage";

/**
 * The rows of a dataset: a sample chosen by the user (first or random rows, a
 * filter and a sort) or shared as a view, or the failing rows of a test.
 */
export default function ResultsData({
  snapshot,
  environment,
  target,
  dataset,
  run,
  sample,
  view,
  failing,
  tests,
  inspected,
  onSample,
  onFailing,
  onExplain,
  onSave,
  onAddFilter,
  onEditCode,
}: {
  snapshot: Snapshot;
  environment: string;
  target: ResultsTarget;
  dataset?: Dataset;
  run: RunState;
  sample: Sample;
  view?: string;
  failing: FailingRows | null;
  tests: string[];
  inspected: { node: FlowNode; parent?: string; fullNode: string };
  onSample: (sample: Sample, view?: string) => void;
  onFailing: (failing: FailingRows | null) => void;
  onExplain: (cell: Cell) => void;
  onSave: SaveProject;
  onAddFilter: (condition: string) => Promise<unknown>;
  onEditCode: () => void;
}) {
  const t = useT();
  const {
    partition,
    worktree,
    offset,
    setOffset,
    search,
    setSearch,
    query,
    data,
    error,
    pending,
    page,
    rows,
    staleVariables,
    columns,
    total,
  } = useResultsPage(
    snapshot,
    environment,
    target,
    dataset,
    failing,
    inspected.fullNode,
    sample,
  );
  const [dialog, setDialog] = useState<"view" | "test" | null>(null);
  const views = outputViews(snapshot.bundle?.views, outputKey(target));
  const order = sample.order || [];
  const sortBy = (column: string) => {
    const current =
      order.length === 1 && order[0][0] === column ? order[0][1] : null;
    change({
      ...sample,
      order: [[column, current === "asc" ? "desc" : "asc"]],
    });
  };
  const change = (next: Sample, name?: string) => {
    setOffset(0);
    onSample(normalizedSample(next), name);
  };
  const errorText = (message: string) =>
    partitionMessage(t, message, partition.partition_mode === "all");
  if (!dataset && !page && !failing)
    return (
      <NoResult
        icon={Database}
        error={error}
        all={partition.partition_mode === "all"}
        run={run}
      />
    );
  return (
    <div className="results-data">
      <ResultsToolbar
        failing={failing}
        onClearFailing={() => {
          setOffset(0);
          onFailing(null);
        }}
        worktree={worktree}
        environment={environment}
        target={target}
        columns={columns}
        sample={sample}
        canEdit={run.canEdit}
        inspected={inspected}
        change={change}
        onDialog={setDialog}
        onAddFilter={onAddFilter}
        views={views}
        view={view}
        onSave={onSave}
        search={search}
        onSearch={setSearch}
        pending={pending}
      />
      {(error || (!run.failureShown && page?.error)) && (
        <div className="inline-error" role="alert">
          {errorText(error || page?.error || "")}
          {error && !failing && !sameSample(sample, ALL_ROWS) && (
            <button className="text-button" onClick={() => change(ALL_ROWS)}>
              {t("resetSample")}
            </button>
          )}
        </div>
      )}
      {!!staleVariables.length && (
        <div className="stale-reason">{staleVariables.join(" ")}</div>
      )}
      <DataGrid
        columns={columns}
        rows={(page || rows)?.rows || []}
        offset={offset}
        header={(column) => {
          const sorted = order.find(([name]) => name === column.name)?.[1];
          return (
            <button disabled={!!failing} onClick={() => sortBy(column.name)}>
              <span>
                {column.name}
                {sorted ? (sorted === "desc" ? " ↓" : " ↑") : ""}
              </span>
              <small>{column.type}</small>
            </button>
          );
        }}
        cell={(value, column, row) =>
          page ? (
            <button
              className={`cell ${value === null ? "null" : ""}`}
              disabled={page.status !== "valid" || run.active}
              title={page.status === "valid" ? t("explain") : t("staleHint")}
              aria-label={`${t("explain")}: ${column.name}, ${t("rows")} ${row.id + 1}, ${formatValue(value)}`}
              onClick={() =>
                onExplain({
                  dataset: page.id,
                  row: row.id,
                  column: column.name,
                  partition_context: page.partition_context,
                })
              }
            >
              {formatValue(value)}
            </button>
          ) : (
            <span className={`cell-text ${value === null ? "null" : ""}`}>
              {formatValue(value)}
            </span>
          )
        }
      >
        {data && !data.rows.length && !pending && (
          <p className="empty-small">{t("noMatches")}</p>
        )}
      </DataGrid>
      <div className="preview-footer">
        <span title={page?.created}>
          {failing
            ? t("failingRowsHint")
            : page && (sample.filter || query)
              ? t("sampleMatches")
                  .replace(
                    "{matched}",
                    (page.matched_count ?? total).toLocaleString(),
                  )
                  .replace("{count}", page.count.toLocaleString())
              : page?.status === "stale"
                ? t("staleHint")
                : t("snapshotHint")}
        </span>
        <Pager
          offset={offset}
          total={total}
          pageSize={PAGE_SIZE}
          onOffset={setOffset}
        />
      </div>
      {dialog === "view" && (
        <SaveViewModal
          views={views}
          sample={sample}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            await onSave((bundle) =>
              saveView(bundle, outputKey(target), name, sample, t),
            );
            onSample(sample, name);
          }}
        />
      )}
      {dialog === "test" && (
        <CreateTestModal
          snapshot={snapshot}
          node={inspected.node}
          parent={inspected.parent}
          port={target.port}
          filter={sample.filter || ""}
          tests={tests}
          onClose={() => setDialog(null)}
          onSave={onSave}
          onEditCode={onEditCode}
        />
      )}
    </div>
  );
}
