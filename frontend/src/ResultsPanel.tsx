import {
  ChartColumn,
  Clock,
  Columns3,
  Eye,
  GitCommitHorizontal,
  Loader2,
  Play,
  ScrollText,
  ShieldCheck,
  Table2,
  X,
} from "lucide-react";
import { useState } from "react";
import { withQuery } from "./api";
import { DatasetPicker } from "./DatasetPicker";
import type { PreviewState } from "./draftPreview";
import DraftPreviewView from "./DraftPreviewView";
import ExecutionError from "./ExecutionError";
import { WarningBadge, warningCount } from "./ExecutionMessages";
import { nodeInterface, outputSource, type NodeInterface } from "./graph";
import { nodeLabel, useT } from "./i18n";
import type { Cell } from "./lineageGraph";
import { localDefinitions, nodeCode, nodeLocation } from "./nodeCode";
import { displayNodeName } from "./nodeNames";
import { PartitionStrip } from "./PartitionControls";
import { partitionMessage, type PartitionPage } from "./partitions";
import type { FailingRows } from "./results";
import ResultsChart from "./ResultsChart";
import ResultsColumns from "./ResultsColumns";
import ResultsData from "./ResultsData";
import ResultsLog from "./ResultsLog";
import ResultsTests, { declaredTests } from "./ResultsTests";
import { loadSample, sampleFits, sampleKey, storeSample } from "./samples";
import type {
  Documentation,
  FlowEdge,
  FlowNode,
  PreviewPage,
  Run,
  Snapshot,
  Statuses,
} from "./types";
import { useApiResource } from "./useApiResource";
import { useOptionalWorktree, usePartitionQuery } from "./worktree";

import {
  RESULT_TABS,
  TAB_LABELS,
  clock,
  computing,
  outputKey,
  seconds,
  type ResultsTab,
  type ResultsTarget,
  type RunState,
  type SaveProject,
} from "./results";

/**
 * What a node produced in the environment selected in the top bar: its rows,
 * columns, tests and the log of the run behind them. The inspector describes
 * the node; this panel only shows outcomes.
 */
export default function ResultsPanel({
  readOnly,
  user,
  snapshot,
  environment,
  node,
  fullNode,
  parent,
  prefix,
  signature,
  label,
  graphNodes,
  graphEdges,
  statuses,
  tab,
  hidden,
  onTab,
  onClose,
  onRun,
  onExplain,
  onSave,
  onSaveDocumentation,
  onAddFilter,
  onEditCode,
  preview,
  onRunAncestors,
}: {
  readOnly: boolean;
  user: string;
  snapshot: Snapshot;
  environment: string;
  node: FlowNode;
  fullNode: string;
  parent?: string;
  prefix: string;
  signature: NodeInterface;
  label: string;
  graphNodes: FlowNode[];
  graphEdges: FlowEdge[];
  statuses: Statuses;
  tab: ResultsTab;
  hidden: boolean;
  onTab: (tab: ResultsTab) => void;
  onClose: () => void;
  onRun: () => void;
  onExplain: (cell: Cell) => void;
  onSave: SaveProject;
  onSaveDocumentation: (
    change: (documentation: Documentation) => void,
  ) => Promise<unknown>;
  onAddFilter: (port: string, condition: string) => Promise<unknown>;
  onEditCode: (line?: number, fullNode?: string) => void;
  /** The preview of this node computed from samples of its inputs, if any. */
  preview: PreviewState | null;
  onRunAncestors: () => void;
}) {
  const t = useT();
  const ports = signature.outputs;
  const exportNode = signature.kind === "export";
  const tabs: ResultsTab[] = [
    ...(preview ? (["preview"] as const) : []),
    ...RESULT_TABS.filter(
      (key) => ports.length > 0 || key === "tests" || key === "log",
    ),
  ];
  const shown = tabs.includes(tab)
    ? tab
    : tab === "preview" && tabs.includes("data")
      ? "data"
      : tabs[tabs.length - 1];
  const [target, setTarget] = useState<ResultsTarget>({
    node: fullNode,
    port: ports[0] || "result",
  });
  const [failing, setFailing] = useState<FailingRows | null>(null);
  const storage = (next: ResultsTarget) =>
    sampleKey(user, snapshot.worktree.project, next.node, next.port);
  // The sample travels between outputs and inputs, to compare the same rows before and after.
  const [shownSample, setShownSample] = useState(() => ({
    environment,
    ...loadSample(storage(target)),
  }));
  // The environment selected in the top bar keeps the sample but forgets failing rows.
  if (shownSample.environment !== environment) {
    setShownSample({ ...shownSample, environment });
    setFailing(null);
  }
  // A component instance stores no rows: its outputs are those of nodes inside it.
  const stored = (item: { node: string; port: string }) =>
    snapshot.bundle
      ? outputSource(snapshot.bundle, item.node, item.port)
      : item;
  const datasetOf = (item: { node: string; port: string }) => {
    const source = stored(item);
    return statuses.nodes[source.node]?.outputs?.[source.port];
  };
  // The node whose run the panel tells: this node, or the one computing the shown output.
  const producer = stored({
    node: fullNode,
    port: target.input ? ports[0] || "result" : target.port,
  }).node;
  const worktree = useOptionalWorktree();
  const collector =
    snapshot.partitions?.[environment]?.nodes[producer]?.collect.length;
  const baseResult = statuses.nodes[producer];
  const sourceLocation =
    snapshot.bundle && nodeLocation(snapshot.bundle, producer);
  // A blocked collector waits for keys: retry those that failed rather than every key.
  const blocked = collector ? baseResult?.error || undefined : undefined;
  const failedKeys = useApiResource<PartitionPage>(
    blocked
      ? withQuery(`/worktrees/${snapshot.worktree.id}/partitions`, {
          environment,
          status: "failed",
          limit: 1,
        })
      : null,
    { refresh: JSON.stringify([statuses.active?.id, blocked]) },
  );
  const retryFailed = !!failedKeys.data?.entries.length;
  const runLabel = t(
    !collector ? "runNode" : retryFailed ? "partitionRunFailed" : "run",
  );
  const runResult =
    collector && worktree
      ? () => {
          void worktree.run(
            undefined,
            retryFailed ? { partitions: { mode: "failed" } } : undefined,
          );
        }
      : onRun;
  const partition = usePartitionQuery(target.node, target.port);
  const partitionPreview = useApiResource<PreviewPage>(
    partition.manifest
      ? withQuery(
          `/worktrees/${snapshot.worktree.id}/preview/${encodeURIComponent(target.node)}`,
          { environment, port: target.port, limit: 1, ...partition },
        )
      : null,
    { refresh: JSON.stringify(statuses) },
  );
  const dataset = partition.manifest
    ? partitionPreview.data || undefined
    : datasetOf(target);
  const result = partition.manifest
    ? {
        outputs: dataset ? { [target.port]: dataset } : {},
        results: partitionPreview.data?.results || [],
        error: partitionPreview.data?.error || null,
        result_run: dataset?.run,
      }
    : baseResult;
  // The node's own last execution failed; blocked, canceled and per-key states keep their own views.
  const failure =
    !target.input &&
    !partition.manifest &&
    baseResult?.error &&
    baseResult.execution_status === "failed"
      ? baseResult
      : null;
  // A preview lacking some partitions is incomplete, as the banner below details.
  const datasetStatus = dataset?.incomplete ? "incomplete" : dataset?.status;
  const running = computing(statuses, fullNode);
  // The run that produced the displayed rows, for the header.
  const generation = useApiResource<Run>(
    dataset ? `/runs/${encodeURIComponent(dataset.run)}` : null,
  );
  const run = generation.data?.id === dataset?.run ? generation.data : null;
  const state = run?.nodes?.[stored(target).node];
  const local = localDefinitions(snapshot, parent);
  const inputs = graphEdges
    .filter((edge) => edge.target === node.id)
    .map((edge) => {
      const source = graphNodes.find((n) => n.id === edge.source);
      return {
        node: prefix + edge.source,
        port: edge.sourceHandle,
        input: edge.targetHandle,
        // The name shown on the canvas, as in the Inspector's input choices.
        label: source
          ? nodeLabel(
              source,
              nodeInterface(
                source,
                snapshot.parsed_templates,
                snapshot.bundle?.components,
                local,
              ),
              t,
            )
          : edge.source,
      };
    });
  const tests = declaredTests(signature, result?.results);
  const testResults = (result?.results || []).filter(
    (item) => item.origin.kind === "test",
  );
  const messages = (result?.results || []).filter(
    (item) => item.origin.kind !== "test",
  );
  const columns = dataset?.columns || [];
  const failed = testResults.filter((item) => item.status !== "ok").length;
  const showDataset = (next: ResultsTarget) => {
    setFailing(null);
    setTarget(next);
    const columns = datasetOf(next)?.columns;
    if (
      !columns ||
      !sampleFits(
        shownSample.sample,
        columns.map((c) => c.name),
        dataset?.columns.map((c) => c.name),
      )
    )
      setShownSample({ environment, ...loadSample(storage(next)) });
  };
  // The node's last run error, above the rows or the chart.
  const failureCard = failure && (
    <ExecutionError
      failure={failure}
      node={producer}
      environment={environment}
      currentSource={
        snapshot.bundle && sourceLocation
          ? nodeCode(
              snapshot.bundle,
              sourceLocation.node,
              sourceLocation.parent,
            )
          : ""
      }
      onEditCode={(line) => onEditCode(line, producer)}
      onLog={() => onTab("log")}
    />
  );
  // How the Data and Chart tabs run the node and explain a missing result.
  const runState: RunState = {
    canEdit: !readOnly,
    active: !!statuses.active,
    starting: worktree?.starting,
    onRun: runResult,
    runLabel,
    reason: target.input ? undefined : blocked,
    failureShown: !!failure,
  };
  // The tabs of the shown dataset start over on another output, environment or partition.
  const datasetKey = `${outputKey(target)}:${environment}:${JSON.stringify(partition)}`;
  return (
    <section
      className="preview-panel results-panel"
      id="data-preview"
      aria-label={t("results")}
      hidden={hidden}
    >
      <header className="preview-header results-header">
        <div className="results-identity">
          <Table2 size={15} aria-hidden="true" />
          <strong title={label}>{label}</strong>
          {ports.length > 0 && (ports.length > 1 || inputs.length > 0) && (
            <DatasetPicker
              target={target}
              ports={ports.map((port) => ({
                port,
                count: datasetOf({ node: fullNode, port })?.count,
              }))}
              inputs={inputs.map((input) => ({
                ...input,
                count: datasetOf(input)?.count,
              }))}
              fullNode={fullNode}
              onSelect={showDataset}
            />
          )}
          {ports.length === 1 && !inputs.length && (
            <span className="results-port">{ports[0]}</span>
          )}
          {running ? (
            <span className="badge running">
              <Loader2 size={11} className="spin" aria-hidden="true" />
              {t("running")}
            </span>
          ) : (
            datasetStatus && (
              <span className={`badge ${datasetStatus}`}>
                {t(datasetStatus)}
              </span>
            )
          )}
          {result?.error && dataset && (
            <span
              className="results-failure"
              title={partitionMessage(t, result.error)}
            >
              {t("lastRunFailed")}
            </span>
          )}
          {dataset && (
            <span className="results-run muted">
              <Clock size={12} aria-hidden="true" />
              {t("runAt").replace(
                "{time}",
                clock(state?.finished || dataset.created),
              )}
              {state?.duration !== undefined && ` · ${seconds(state.duration)}`}
              {run && (
                <>
                  {" · "}
                  <GitCommitHorizontal size={12} aria-hidden="true" />
                  <code>{run.commit.slice(0, 7)}</code>
                </>
              )}
            </span>
          )}
        </div>
        <div className="results-actions">
          {dataset && (
            <span className="muted small">
              {dataset.count.toLocaleString()} {t("rows")} · {columns.length}{" "}
              {t("columns")}
            </span>
          )}
          <button
            className="icon"
            title={runLabel}
            aria-label={runLabel}
            disabled={readOnly || worktree?.starting || !!statuses.active}
            aria-busy={worktree?.starting}
            onClick={runResult}
          >
            {worktree?.starting ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Play size={15} />
            )}
          </button>
          <button
            className="icon"
            title={t("hidePreview")}
            aria-label={t("hidePreview")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <PartitionStrip node={stored(target).node} port={target.port} />
      {dataset?.incomplete && (
        <div className="notice warning" role="status">
          {t("partitionIncomplete")
            .replace("{available}", String(dataset.incomplete.available))
            .replace("{total}", String(dataset.incomplete.total))}
        </div>
      )}
      <div className="tabs results-tabs" role="tablist">
        {tabs.map((key) => {
          const Icon = {
            preview: Eye,
            data: Table2,
            chart: ChartColumn,
            columns: Columns3,
            tests: ShieldCheck,
            log: ScrollText,
          }[key];
          return (
            <button
              key={key}
              role="tab"
              className={`${shown === key ? "active" : ""} ${key === "preview" ? "draft-tab" : ""}`}
              aria-selected={shown === key}
              onClick={() => onTab(key)}
            >
              <Icon size={14} aria-hidden="true" />
              {t(TAB_LABELS[key])}
              {key === "columns" && dataset && (
                <span className="tab-count">{columns.length}</span>
              )}
              {key === "tests" && failed > 0 && <WarningBadge count={failed} />}
              {key === "log" && <WarningBadge count={warningCount(messages)} />}
            </button>
          );
        })}
      </div>
      {shown === "preview" && preview ? (
        <DraftPreviewView
          key={preview.result ? "computed" : "pending"}
          preview={preview}
          canRun={!readOnly && !statuses.active && !worktree?.starting}
          running={!!statuses.active || !!worktree?.starting}
          inputName={(id) => displayNodeName(snapshot.node_names?.[id], id, t)}
          onRunAncestors={onRunAncestors}
        />
      ) : shown === "data" ? (
        <>
          {failureCard}
          {(!failure || dataset) && (
            <ResultsData
              key={datasetKey}
              snapshot={snapshot}
              environment={environment}
              target={target}
              dataset={dataset}
              run={runState}
              sample={shownSample.sample}
              view={shownSample.view}
              failing={failing}
              tests={tests}
              onSample={(sample, view) => {
                setShownSample({ environment, sample, view });
                storeSample(storage(target), sample, view);
              }}
              onFailing={setFailing}
              onExplain={onExplain}
              onSave={onSave}
              onAddFilter={(condition) => onAddFilter(target.port, condition)}
              onEditCode={() => onEditCode()}
              inspected={{ node, parent, fullNode }}
            />
          )}
        </>
      ) : shown === "chart" ? (
        <>
          {failureCard}
          {(!failure || dataset) && (
            <ResultsChart
              key={datasetKey}
              snapshot={snapshot}
              environment={environment}
              target={target}
              stored={stored(target)}
              dataset={dataset}
              run={runState}
              onSave={onSave}
            />
          )}
        </>
      ) : shown === "columns" ? (
        <ResultsColumns
          key={datasetKey}
          snapshot={snapshot}
          environment={environment}
          target={target}
          dataset={dataset}
          canEdit={!readOnly && !target.input}
          onSaveDocumentation={onSaveDocumentation}
          onColumn={(column) => {
            onTab("data");
            requestAnimationFrame(() =>
              document
                .querySelector(
                  `.results-panel th[data-column="${CSS.escape(column)}"]`,
                )
                ?.scrollIntoView({ inline: "center", block: "nearest" }),
            );
          }}
        />
      ) : shown === "tests" ? (
        <ResultsTests
          snapshot={snapshot}
          environment={environment}
          node={node}
          parent={parent}
          fullNode={fullNode}
          tests={tests}
          result={result}
          refresh={JSON.stringify([statuses.active?.id, result])}
          canShowRows={!!dataset && dataset.status === "valid" && !exportNode}
          readOnly={readOnly}
          onShowRows={(test, count, output) => {
            showDataset({
              node: fullNode,
              // Failing rows come from the output the test checks.
              port:
                output && ports.includes(output)
                  ? output
                  : target.input
                    ? ports[0]
                    : target.port,
            });
            setFailing({ test, count });
            onTab("data");
          }}
          onEditCode={() => onEditCode()}
        />
      ) : (
        <ResultsLog
          snapshot={snapshot}
          environment={environment}
          fullNode={producer}
          exportNode={exportNode}
          download={
            signature.kind !== "component" && !!signature.definition?.download
          }
          readOnly={readOnly}
          result={result}
          inputs={inputs.map((input) => ({ ...input, ...stored(input) }))}
          statuses={statuses}
          onTests={() => onTab("tests")}
        />
      )}
    </section>
  );
}
