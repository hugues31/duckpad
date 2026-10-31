import { useState } from "react";
import {
  Clock,
  Columns3,
  GitCommitHorizontal,
  Loader2,
  Play,
  ScrollText,
  ShieldCheck,
  Table2,
  X,
} from "lucide-react";
import { WarningBadge, warningCount } from "./ExecutionMessages";
import type { NodeInterface } from "./graph";
import { useT } from "./i18n";
import type { Cell } from "./lineageGraph";
import ResultsColumns from "./ResultsColumns";
import ResultsData, { type FailingRows } from "./ResultsData";
import ResultsLog from "./ResultsLog";
import ResultsTests, { declaredTests } from "./ResultsTests";
import Select from "./Select";
import { loadSample, sampleFits, sampleKey, storeSample } from "./samples";
import type {
  Documentation,
  FlowEdge,
  FlowNode,
  Run,
  Snapshot,
  Statuses,
} from "./types";
import { useApiResource } from "./useApiResource";

export const RESULT_TABS = ["data", "columns", "tests", "log"] as const;
export type ResultsTab = (typeof RESULT_TABS)[number];
const TAB_LABELS = {
  data: "results_data",
  columns: "results_columns",
  tests: "results_tests",
  log: "results_log",
} as const;

/** A dataset the panel can show: an output of the node, or one of its inputs. */
export interface ResultsTarget {
  /** The expanded ID of the node holding the dataset. */
  node: string;
  port: string;
  /** For an input of the inspected node, the input port it is connected to. */
  input?: string;
}

/** Whether an edit to the project files comes from the results panel. */
export type SaveProject = (
  change: (bundle: NonNullable<Snapshot["bundle"]>) => void,
) => Promise<unknown>;

/** The time of an ISO date, as the panel shows run times. */
export const clock = (value: string) => new Date(value).toLocaleTimeString();
export const seconds = (value: number) =>
  value < 10 ? `${value.toFixed(1)} s` : `${Math.round(value)} s`;

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
  onEditCode: () => void;
}) {
  const t = useT();
  const ports = signature.outputs;
  const exportNode = signature.kind === "export";
  const tabs = RESULT_TABS.filter(
    (key) => !exportNode || key === "tests" || key === "log",
  );
  const shown = tabs.includes(tab) ? tab : tabs[tabs.length - 1];
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
  const result = statuses.nodes[fullNode];
  const targetResult = statuses.nodes[target.node];
  const dataset = targetResult?.outputs?.[target.port];
  const running =
    !!statuses.active?.nodes?.[fullNode] &&
    ["pending", "running"].includes(statuses.active.nodes[fullNode].status);
  // The run that produced the displayed rows, for the header.
  const generation = useApiResource<Run>(
    dataset ? `/runs/${encodeURIComponent(dataset.run)}` : null,
  );
  const run = generation.data?.id === dataset?.run ? generation.data : null;
  const state = run?.nodes?.[target.node];
  const inputs = graphEdges
    .filter((edge) => edge.target === node.id)
    .map((edge) => {
      const source = graphNodes.find((n) => n.id === edge.source);
      return {
        node: prefix + edge.source,
        port: edge.sourceHandle,
        input: edge.targetHandle,
        label: source?.label || edge.source,
      };
    });
  const tests = declaredTests(signature);
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
    const columns = statuses.nodes[next.node]?.outputs?.[next.port]?.columns;
    if (
      !columns ||
      !sampleFits(
        shownSample.sample,
        columns.map((c) => c.name),
      )
    )
      setShownSample({ environment, ...loadSample(storage(next)) });
  };
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
          {!exportNode && (ports.length > 1 || inputs.length > 0) && (
            <DatasetPicker
              target={target}
              ports={ports.map((port) => ({
                port,
                count: result?.outputs?.[port]?.count,
              }))}
              inputs={inputs.map((input) => ({
                ...input,
                count: statuses.nodes[input.node]?.outputs?.[input.port]?.count,
              }))}
              fullNode={fullNode}
              onSelect={showDataset}
            />
          )}
          {!exportNode && ports.length === 1 && !inputs.length && (
            <span className="results-port">{ports[0]}</span>
          )}
          {running ? (
            <span className="badge running">
              <Loader2 size={11} className="spin" aria-hidden="true" />
              {t("running")}
            </span>
          ) : (
            dataset && (
              <span className={`badge ${dataset.status}`}>
                {t(dataset.status)}
              </span>
            )
          )}
          {result?.error && dataset && (
            <span className="results-failure" title={result.error}>
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
            title={t("runNode")}
            aria-label={t("runNode")}
            disabled={readOnly || !!statuses.active}
            onClick={onRun}
          >
            <Play size={15} />
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
      <div className="tabs results-tabs" role="tablist">
        {tabs.map((key) => {
          const Icon = {
            data: Table2,
            columns: Columns3,
            tests: ShieldCheck,
            log: ScrollText,
          }[key];
          return (
            <button
              key={key}
              role="tab"
              className={shown === key ? "active" : ""}
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
      {shown === "data" ? (
        <ResultsData
          key={`${target.node}:${target.port}:${environment}`}
          snapshot={snapshot}
          environment={environment}
          target={target}
          dataset={dataset}
          canEdit={!readOnly}
          active={!!statuses.active}
          sample={shownSample.sample}
          view={shownSample.view}
          failing={failing}
          tests={tests}
          onSample={(sample, view) => {
            setShownSample({ environment, sample, view });
            storeSample(storage(target), sample, view);
          }}
          onFailing={setFailing}
          onRun={onRun}
          onExplain={onExplain}
          onSave={onSave}
          onAddFilter={(condition) => onAddFilter(target.port, condition)}
          onEditCode={onEditCode}
          inspected={{ node, parent, fullNode }}
        />
      ) : shown === "columns" ? (
        <ResultsColumns
          key={`${target.node}:${target.port}:${environment}`}
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
          onShowRows={(test, count) => {
            setTarget({
              node: fullNode,
              port: target.input ? ports[0] : target.port,
            });
            setFailing({ test, count });
            onTab("data");
          }}
          onEditCode={onEditCode}
        />
      ) : (
        <ResultsLog
          snapshot={snapshot}
          environment={environment}
          fullNode={fullNode}
          exportNode={exportNode}
          download={
            signature.kind !== "component" && !!signature.definition?.download
          }
          result={result}
          inputs={inputs}
          statuses={statuses}
          onTests={() => onTab("tests")}
        />
      )}
    </section>
  );
}

function DatasetPicker({
  target,
  ports,
  inputs,
  fullNode,
  onSelect,
}: {
  target: ResultsTarget;
  ports: { port: string; count?: number }[];
  inputs: {
    node: string;
    port: string;
    input: string;
    label: string;
    count?: number;
  }[];
  fullNode: string;
  onSelect: (target: ResultsTarget) => void;
}) {
  const t = useT();
  const count = (value?: number) =>
    value === undefined
      ? ""
      : ` · ${value.toLocaleString()} ${t(value === 1 ? "row" : "rows")}`;
  return (
    <Select
      className="dataset-select"
      aria-label={t("output")}
      title={inputs.length ? t("inputsToCompareHint") : undefined}
      value={target.input ? `input:${target.input}` : target.port}
      onChange={(event) => {
        const value = event.target.value;
        const input = inputs.find((item) => `input:${item.input}` === value);
        onSelect(
          input
            ? { node: input.node, port: input.port, input: input.input }
            : { node: fullNode, port: value },
        );
      }}
    >
      <optgroup label={t("nodeOutputs")}>
        {ports.map((item) => (
          <option key={item.port} value={item.port}>
            {item.port}
            {count(item.count)}
          </option>
        ))}
      </optgroup>
      {inputs.length > 0 && (
        <optgroup label={t("inputsToCompare")}>
          {inputs.map((item) => (
            <option key={item.input} value={`input:${item.input}`}>
              {item.input} ← {item.label} · {item.port}
              {count(item.count)}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}
