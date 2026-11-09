import { ChartColumn, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { withQuery } from "./api";
import { renderChart } from "./chartEmbed";
import {
  CHART_ROW_LIMIT,
  CHARTS_FILE,
  chartDiagnostics,
  outputCharts,
  unknownFields,
  type Chart,
} from "./charts";
import { AddChart, ChartSelector } from "./ChartActions";
import { chartRows } from "./chartValues";
import { useT, useTranslateValue } from "./i18n";
import { codeFileUrl } from "./navigation";
import NoResult, { EmptyState } from "./NoResult";
import { partitionMessage } from "./partitions";
import {
  outputKey,
  type ResultsTarget,
  type RunState,
  type SaveProject,
} from "./results";
import type { Dataset, Diagnostic, PreviewPage, Snapshot } from "./types";
import { useResource } from "./useApiResource";
import { useChartAppearance } from "./useChartAppearance";
import { fetchPreview } from "./useResultsPage";
import { useStaleVariables } from "./VariableFields";
import { usePartitionQuery } from "./worktree";

/**
 * The charts of the shown dataset, declared in charts.json for the output
 * that stores its rows. Nothing renders while charts.json has diagnostics:
 * an invalid file can reach this browser through a branch, a pull or an import.
 */
export default function ResultsChart({
  snapshot,
  environment,
  target,
  stored,
  dataset,
  onSave,
  run,
}: {
  snapshot: Snapshot;
  environment: string;
  target: ResultsTarget;
  /** The output storing the shown rows, which charts.json keys charts by. */
  stored: { node: string; port: string };
  dataset?: Dataset;
  onSave: SaveProject;
  run: RunState;
}) {
  const t = useT();
  const problems = chartDiagnostics(snapshot.diagnostics);
  const output = outputKey(stored);
  const charts = outputCharts(snapshot.bundle?.charts, output);
  const [selected, setSelected] = useState("");
  const chart = charts.find((item) => item.name === selected) || charts.at(0);
  if (problems.length)
    return (
      <ChartDiagnostics
        problems={problems}
        worktree={snapshot.worktree.id}
        environment={environment}
      />
    );
  if (!chart)
    return (
      <EmptyState
        icon={ChartColumn}
        title={t("chartNone")}
        hint={t("chartNoneHint")}
      >
        {run.canEdit && (
          <AddChart
            worktree={snapshot.worktree.id}
            environment={environment}
            output={output}
            columns={dataset?.columns || []}
            onSave={onSave}
          />
        )}
      </EmptyState>
    );
  return (
    <>
      {charts.length > 1 && (
        <ChartSelector
          charts={charts}
          selected={chart.name}
          onSelect={setSelected}
        />
      )}
      <ChartView
        snapshot={snapshot}
        environment={environment}
        target={target}
        dataset={dataset}
        chart={chart}
        run={run}
      />
    </>
  );
}

function ChartView({
  snapshot,
  environment,
  target,
  dataset,
  chart,
  run,
}: {
  snapshot: Snapshot;
  environment: string;
  target: ResultsTarget;
  dataset?: Dataset;
  chart: Chart;
  run: RunState;
}) {
  const t = useT();
  const translate = useTranslateValue();
  const partition = usePartitionQuery(target.node, target.port);
  // The whole output, never the sample of the Data tab.
  const path = withQuery(
    `/worktrees/${snapshot.worktree.id}/preview/${encodeURIComponent(target.node)}`,
    { environment, port: target.port, limit: CHART_ROW_LIMIT, ...partition },
  );
  const preview = useResource<PreviewPage | null>(
    path,
    (signal) => fetchPreview(path, signal),
    { refresh: `${dataset?.id}:${dataset?.status}` },
  );
  const page = preview.data;
  const staleVariables = useStaleVariables(snapshot, environment, page);
  // Only a whole output is drawn: a truncated series would look complete.
  const count = page ? (page.matched_count ?? page.filtered_count) : 0;
  const tooMany = count > CHART_ROW_LIMIT;
  const rows = useMemo(
    () => (page && !tooMany ? chartRows(page.columns, page.rows) : null),
    [page, tooMany],
  );
  const spec = JSON.stringify(chart.spec);
  // Vega-Lite draws fields missing from the result as empty marks, silently.
  const missing = page
    ? unknownFields(chart.spec, page.columns).join(", ")
    : "";
  const appearance = useChartAppearance();
  const element = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<{ spec: string; message: string }>();
  useEffect(() => {
    if (!rows || missing || !element.current) return;
    let disposed = false;
    let finalize = () => {};
    renderChart(element.current, JSON.parse(spec), rows, appearance).then(
      (result) => {
        if (disposed) result.finalize();
        else finalize = () => result.finalize();
      },
      (error: unknown) => {
        if (!disposed)
          setFailure({
            spec,
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      disposed = true;
      finalize();
    };
  }, [rows, missing, spec, appearance]);
  const all = partition.partition_mode === "all";
  if (!dataset && !page)
    return (
      <NoResult icon={ChartColumn} error={preview.error} all={all} run={run} />
    );
  const error =
    preview.error ||
    (!run.failureShown && page?.error) ||
    (missing && t("chartUnknownFields").replace("{fields}", missing)) ||
    // A refused load rejects with a translation key.
    (failure?.spec === spec ? translate(failure.message) : "");
  return (
    <div className="results-chart">
      {error && (
        <div className="inline-error" role="alert">
          {partitionMessage(t, error, all)}
        </div>
      )}
      {!!staleVariables.length && (
        <div className="stale-reason">{staleVariables.join(" ")}</div>
      )}
      {!page && !error && (
        <p className="muted small" role="status">
          <Loader2 size={13} className="spin" aria-hidden="true" />{" "}
          {t("chartLoading")}
        </p>
      )}
      {tooMany ? (
        <EmptyState
          icon={ChartColumn}
          role="status"
          title={t("chartTooManyRows")
            .replace("{count}", count.toLocaleString())
            .replace("{limit}", CHART_ROW_LIMIT.toLocaleString())}
          hint={t("chartTooManyRowsHint")}
        />
      ) : (
        // Vega sets its own role and label on the element it draws into.
        // The padding sits outside .chart-view, whose whole width Vega fills.
        <div role="figure" aria-label={chart.name} className="chart-figure">
          <div ref={element} className="chart-view" />
        </div>
      )}
      {page?.status === "stale" && (
        <p className="muted small">{t("staleHint")}</p>
      )}
    </div>
  );
}

/** Why charts.json renders no chart, with a link to correct it in Code. */
function ChartDiagnostics({
  problems,
  worktree,
  environment,
}: {
  problems: Diagnostic[];
  worktree: string;
  environment: string;
}) {
  const t = useT();
  return (
    <div className="chart-invalid" role="alert">
      <strong>{t("chartInvalidFile")}</strong>
      <ul>
        {problems.map((problem, index) => (
          <li key={index}>{problem.message}</li>
        ))}
      </ul>
      <p>
        <Link to={codeFileUrl(worktree, CHARTS_FILE, environment)}>
          {t("chartOpenFile")}
        </Link>
      </p>
    </div>
  );
}
