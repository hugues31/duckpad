import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  Database,
  GitBranch,
  Layers,
  Loader2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { PythonIcon } from "./AddIcon";
import { api, send, withQuery } from "./api";
import { formatValue } from "./graph";
import { useT, useTranslateValue } from "./i18n";
import {
  arrangeLineage,
  buildLineageGraph,
  cellId,
  pythonCardHeight,
  requestId,
  type Cell,
  type Entry,
  type Explanation,
  type Query,
} from "./lineageGraph";
import { trapFocus } from "./modals";
import { displayNodeName } from "./nodeNames";
import Pager from "./Pager";
import type { PartitionPage } from "./partitions";
import { useResource } from "./useApiResource";
import { isFinal, usePolling } from "./usePolling";
import { VariableValues } from "./VariableFields";
import { useOptionalWorktree } from "./worktree";

type Props = {
  worktree: string;
  environment: string;
  cell: Cell;
  onClose: () => void;
};
type Graph = Awaited<ReturnType<typeof buildLineageGraph>>;
type CardData = {
  entry: Entry;
  root: boolean;
  disabled: boolean;
  select: (id: string) => void;
  page: (id: string, values: Partial<Query>) => void;
  expand: () => void;
  parent: (cell: Cell) => void;
  /** Whether this card lists the captured parents of its Python result. */
  parents: boolean;
  replay?: (value: NonNullable<Explanation["replay"]>) => void;
};
type CardNode = Node<CardData, "lineage">;
const nodeTypes = { lineage: CalculationCard };
const operationKeys = {
  sum: "lineageSum",
  avg: "lineageAverage",
  min: "lineageMinimum",
  max: "lineageMaximum",
  count: "lineageCount",
  count_distinct: "lineageDistinctCount",
} as const;
const isExplained = (
  operation: string,
): operation is keyof typeof operationKeys =>
  Object.hasOwn(operationKeys, operation);

function CalculationCard({ data }: NodeProps<CardNode>) {
  const t = useT();
  const translate = useTranslateValue();
  const names = useOptionalWorktree()?.snapshot?.node_names;
  const { entry, disabled } = data;
  const { result, query, group } = entry;
  const source = result.kind === "source" && !entry.deferred;
  const operation = result.calculation?.operation || "expression";
  let formula =
    result.calculation?.evaluated ||
    result.calculation?.formula ||
    result.expression;
  if (
    (operation === "sum" || operation === "avg") &&
    result.total > 0 &&
    result.total === result.contributions.length &&
    result.contributions.every(
      (input) =>
        typeof input.value === "number" && Number.isFinite(input.value),
    ) &&
    !query.offset &&
    query.group === undefined
  ) {
    const values = result.contributions
      .map((input) => formatValue(input.value))
      .join(" + ");
    formula = operation === "sum" ? values : `(${values}) / ${result.total}`;
  }
  // The card header names the opaque Python operation; it has no formula.
  const python = result.kind === "python";
  if (python) formula = undefined;
  const offset = query.offset || 0;
  // Parent results page together; the longest one sets the page count.
  const parentRows = Math.max(
    0,
    ...(result.parents || []).map((parent) => parent.count),
  );
  return (
    <article
      className={`lineage-card ${source ? "is-source" : "calculation"} ${python ? "python" : ""} ${data.root ? "root" : ""}`}
      aria-label={`${result.column}: ${formatValue(result.value)}`}
    >
      {!source && !group && (
        <Handle type="target" position={Position.Left} isConnectable={false} />
      )}
      {!data.root && (
        <Handle type="source" position={Position.Right} isConnectable={false} />
      )}
      <div className="lineage-card-kind">
        {source ? (
          <Database size={14} />
        ) : group ? (
          <Layers size={14} />
        ) : python ? (
          <PythonIcon size={14} />
        ) : (
          <GitBranch size={14} />
        )}
        {t(
          entry.deferred
            ? "lineageEarlierValue"
            : source
              ? "lineageSource"
              : group
                ? "lineageValueGroup"
                : python
                  ? "pythonOpaque"
                  : !result.complete
                    ? "partial"
                    : isExplained(operation)
                      ? operationKeys[operation]
                      : "lineageCalculation",
        )}
        {data.root && <span>{t("lineageSelectedValue")}</span>}
      </div>
      <div className="lineage-card-value">
        <strong>{result.column}</strong>
        <span>=</span>
        <b title={formatValue(result.value)}>{formatValue(result.value)}</b>
      </div>
      {result.origin && (
        <p className="lineage-source-location">
          {t("partitionOrigin")}: {String(result.origin.partition.key.value)} ·{" "}
          {translate(result.origin.partition.key.type)}
          <br />
          {t("partitionProducingRun")}: <code>{result.origin.run}</code>
        </p>
      )}
      {!!result.partition_groups?.length && (
        <p className="lineage-source-location">
          {t("partitionContributors")}:{" "}
          {result.partition_groups
            .map(
              (group) => `${String(group.partition.key.value)} (${group.rows})`,
            )
            .join(", ")}
        </p>
      )}
      {result.replay && (
        <div className="partition-lineage-replay">
          <p>
            {t("partitionOriginUnavailable").replace(
              "{key}",
              String(result.origin?.partition.key.value),
            )}
          </p>
          {data.replay && (
            <button
              className="button secondary small nodrag"
              disabled={disabled}
              onClick={() => data.replay!(result.replay!)}
            >
              {t("partitionRunToExplain")}
            </button>
          )}
          <p>{t("partitionReplayHint")}</p>
        </div>
      )}
      {python && (
        <p className="lineage-source-location">
          {displayNodeName(names?.[result.node || ""], result.node || "", t)} ·{" "}
          {t("lineageRow")} {result.row + 1}
        </p>
      )}
      {python && data.parents && !!result.parents?.length && (
        <>
          <p className="lineage-card-reason">{t("pythonParentHint")}</p>
          <div className="lineage-parents nodrag nowheel">
            <p className="muted small">{t("pythonCapturedParents")}</p>
            {result.parents?.map((parent) => (
              <details key={parent.dataset} open>
                <summary>
                  {displayNodeName(names?.[parent.node], parent.node, t)} ·{" "}
                  {parent.port}
                </summary>
                <table>
                  <thead>
                    <tr>
                      {parent.columns.map((column) => (
                        <th key={column.name}>{column.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parent.rows.map((row) => (
                      <tr key={row.row}>
                        {row.values.map((value, index) => (
                          <td key={parent.columns[index].name}>
                            <button
                              className="button secondary small"
                              aria-label={t("pythonParentCell")
                                .replace("{column}", parent.columns[index].name)
                                .replace("{row}", String(row.row + 1))}
                              disabled={disabled}
                              onClick={() =>
                                data.parent({
                                  dataset: parent.dataset,
                                  row: row.row,
                                  column: parent.columns[index].name,
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
              </details>
            ))}
          </div>
          {parentRows > result.page_size && (
            <Pager
              className="lineage-page nodrag"
              between
              offset={offset}
              total={parentRows}
              pageSize={result.page_size}
              onOffset={(offset) => data.page(entry.id, { offset })}
              disabled={disabled}
            />
          )}
        </>
      )}
      {source ? (
        <div className="lineage-source-location" title={result.node}>
          {displayNodeName(names?.[result.node || ""], result.node || "", t)} ·{" "}
          {t("lineageRow")} {result.row + 1}
        </div>
      ) : entry.deferred ? (
        <button
          className="text-button nodrag"
          disabled={disabled}
          onClick={data.expand}
        >
          {t("lineageExpand")}
        </button>
      ) : group ? (
        <button
          className="text-button nodrag"
          disabled={disabled}
          onClick={() =>
            data.page(group.parent, { group: group.key, offset: 0 })
          }
        >
          {t("lineageShowRows")} · {group.rows}
          <ArrowRight size={13} />
        </button>
      ) : (
        <>
          {formula && (
            <div
              className="lineage-equation"
              title={`${formula} = ${formatValue(result.value)}`}
            >
              {formula} = <strong>{formatValue(result.value)}</strong>
            </div>
          )}
          {!!result.calculation?.selection?.length && (
            <p className="lineage-card-condition">
              {result.calculation.selection.join(" · ")}
            </p>
          )}
          {python ? null : !result.complete ? (
            <p className="lineage-card-warning">
              <AlertTriangle size={14} />
              {t("lineageLimitedHint")}
            </p>
          ) : (
            <p className="lineage-card-reason">
              {query.group !== undefined ? (
                <>
                  {t("lineageRowsFor")}{" "}
                  <strong>{formatValue(result.group)}</strong>
                </>
              ) : result.total === 0 ? (
                t("lineageNoInputs")
              ) : isExplained(operation) ? (
                <>
                  {t(`${operationKeys[operation]}Reason`).replace(
                    "{count}",
                    String(
                      operation === "count" || operation === "count_distinct"
                        ? result.value
                        : result.total,
                    ),
                  )}
                </>
              ) : result.total ? (
                t("lineageInputsReason")
              ) : (
                t("lineageNoInputs")
              )}
            </p>
          )}
          {query.group !== undefined && (
            <button
              className="text-button nodrag"
              disabled={disabled}
              onClick={() =>
                data.page(entry.id, { group: undefined, offset: 0 })
              }
            >
              <ChevronLeft size={12} />
              {t("lineageAllGroups")}
            </button>
          )}
          {result.total > result.page_size && (
            <Pager
              className="lineage-page nodrag"
              between
              offset={offset}
              total={result.total}
              pageSize={result.page_size}
              onOffset={(offset) => data.page(entry.id, { offset })}
              disabled={disabled}
              count={
                <>
                  {result.total}{" "}
                  {t(result.groups ? "valueGroups" : "contributions")}
                </>
              }
            />
          )}
        </>
      )}
      {!group && !entry.deferred && (
        <button
          className="lineage-details-button nodrag"
          disabled={disabled}
          onClick={() => data.select(entry.id)}
        >
          {t(source ? "lineageSourceDetails" : "lineageCalculationDetails")}
        </button>
      )}
    </article>
  );
}

function FitGraph({ version }: { version: Graph }) {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    const frame = requestAnimationFrame(
      () => void fitView({ padding: 0.16, maxZoom: 1, duration: 0 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [fitView, version, width, height]);
  return null;
}

export default function LineagePanel(props: Props) {
  return (
    <LineageExplorer
      key={JSON.stringify([
        props.worktree,
        props.environment,
        cellId(props.cell),
      ])}
      {...props}
    />
  );
}

function LineageExplorer(props: Props) {
  const [parents, setParents] = useState<Cell[]>([]);
  const cell = parents.at(-1) || props.cell;
  const onParent = useCallback(
    (parent: Cell) => setParents((current) => [...current, parent]),
    [],
  );
  return (
    <LineageDialog
      {...props}
      key={cellId(cell)}
      cell={cell}
      onParent={onParent}
      onBack={
        parents.length
          ? () => setParents((current) => current.slice(0, -1))
          : undefined
      }
      onClose={props.onClose}
    />
  );
}

function LineageDialog({
  worktree,
  environment,
  cell,
  onClose,
  onParent,
  onBack,
}: Props & { onParent: (cell: Cell) => void; onBack?: () => void }) {
  const t = useT();
  const currentWorktree = useOptionalWorktree();
  const navigate = useNavigate();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const stopped = useRef(false);
  const cache = useRef(new Map<string, Explanation>());
  const controller = useRef<AbortController | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [pages, setPages] = useState<Record<string, Partial<Query>>>({});
  const [budget, setBudget] = useState(60);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [interrupted, setInterrupted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const replay = useCallback(
    async (value: NonNullable<Explanation["replay"]>) => {
      if (
        !currentWorktree?.canEdit ||
        currentWorktree.id !== worktree ||
        currentWorktree.environment !== environment
      )
        return;
      setPending(true);
      try {
        const key = value.partitions.keys![0];
        let cursor: string | undefined;
        do {
          const page = await api<PartitionPage>(
            withQuery(`/worktrees/${worktree}/partitions`, {
              environment,
              node: value.node,
              search: String(key.value),
              cursor,
            }),
          );
          const entry = page.entries.find(
            (entry) =>
              entry.key.type === key.type && entry.key.value === key.value,
          );
          if (entry) {
            currentWorktree.selectPartition(entry);
            onClose();
            navigate(
              `/worktrees/${worktree}/flow?${new URLSearchParams({ environment, node: value.node })}`,
            );
            await currentWorktree.run(value.node, {
              partitions: value.partitions,
            });
            return;
          }
          cursor = page.next_cursor || undefined;
        } while (cursor);
        throw new Error(t("partitionReplayMissing"));
      } catch (error) {
        setError((error as Error).message);
        setPending(false);
      }
    },
    [currentWorktree, environment, navigate, onClose, t, worktree],
  );

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      opener?.focus({ preventScroll: true });
    };
  }, []);

  // Stop exploring once the explained result is recalculated or edited.
  // Verification pauses while an error is shown, until the user retries.
  usePolling(
    useCallback(
      async (signal: AbortSignal) => {
        try {
          const result = await api<{ valid: boolean }>(
            withQuery(`/worktrees/${worktree}/generations/${cell.dataset}`, {
              environment,
            }),
            { signal },
          );
          if (signal.aborted || result.valid) return;
          stopped.current = true;
          controller.current?.abort();
          setInterrupted(true);
          setPending(false);
          return false;
        } catch (e) {
          // Temporary failures are retried; a final one stops verification.
          if (!signal.aborted && isFinal(e)) setError((e as Error).message);
          throw e;
        }
      },
      [worktree, environment, cell.dataset],
    ),
    { interval: 2000, enabled: !error },
  );

  useEffect(() => {
    if (stopped.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setError("");
    const read = async (query: Query) => {
      if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const key = requestId(query);
      const saved = cache.current.get(key);
      if (saved) return saved;
      const result = await api<Explanation>(`/worktrees/${worktree}/lineage`, {
        ...send({ ...query, environment }),
        signal: abort.signal,
      });
      if (abort.signal.aborted || stopped.current)
        throw new DOMException("Aborted", "AbortError");
      cache.current.set(key, result);
      return result;
    };
    void buildLineageGraph(cell, pages, read, budget, t)
      .then((result) => {
        if (!abort.signal.aborted && !stopped.current) setGraph(result);
      })
      .catch((e) => {
        if (!abort.signal.aborted && !stopped.current) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted && !stopped.current) setPending(false);
      });
    return () => abort.abort();
  }, [worktree, environment, cell, pages, budget, revision, t]);

  const nodes = useMemo(() => {
    // The cells of one Python result share its captured parents: its first card lists them.
    const listed = new Set<string>();
    return arrangeLineage<CardNode>(
      (graph?.entries || []).map((entry) => {
        const parents =
          entry.result.kind === "python" && !listed.has(entry.result.dataset);
        if (parents) listed.add(entry.result.dataset);
        return {
          id: entry.id,
          type: "lineage",
          position: { x: 0, y: 0 },
          width: 330,
          style: { pointerEvents: "auto" },
          height:
            entry.result.kind === "python"
              ? pythonCardHeight(entry.result, parents)
              : entry.result.kind === "source" || entry.group || entry.deferred
                ? entry.result.origin
                  ? 210
                  : 132
                : entry.result.replay
                  ? 410
                  : entry.result.origin || entry.result.partition_groups?.length
                    ? 330
                    : 260,
          data: {
            entry,
            root: graph?.root === entry.id,
            disabled: pending,
            select: setSelected,
            page: (id, values) => {
              setPending(true);
              setPages((current) => ({
                ...current,
                [id]: { ...current[id], ...values },
              }));
            },
            expand: () => setBudget((value) => value + 60),
            parent: onParent,
            parents,
            replay:
              currentWorktree?.canEdit &&
              !currentWorktree.statuses.active &&
              !currentWorktree.starting
                ? replay
                : undefined,
          },
        };
      }),
      graph?.edges || [],
    );
  }, [graph, pending, currentWorktree, replay, onParent]);
  const active = graph?.entries.find((entry) => entry.id === selected);

  return createPortal(
    <dialog
      ref={dialog}
      className="lineage-dialog"
      aria-labelledby={titleId}
      onKeyDown={(event) => trapFocus(event, event.currentTarget)}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header className="lineage-header">
        {onBack && (
          <button className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            {t("lineageBackToPython")}
          </button>
        )}
        <div className="lineage-title">
          <h2 id={titleId}>{t("lineageDialogTitle")}</h2>
          <div className="lineage-selected">
            {cell.column}
            {graph && (
              <>
                {" "}
                = <strong>{formatValue(graph.original.value)}</strong>
              </>
            )}
            <span>
              {" "}
              · {t("lineageRow")} {cell.row + 1}
            </span>
          </div>
        </div>
        <button
          className="icon"
          aria-label={t("close")}
          title={t("close")}
          onClick={onClose}
          autoFocus
        >
          <X size={20} />
        </button>
      </header>
      {interrupted ? (
        <div className="notice warning lineage-message" role="alert">
          {t("lineageInterrupted")}
        </div>
      ) : (
        <>
          <div className="lineage-legend">
            <span>
              <Database size={14} />
              {t("lineageSource")}
            </span>
            <ArrowRight size={16} />
            <span>
              <GitBranch size={14} />
              {t("lineageCalculations")}
            </span>
            <ArrowRight size={16} />
            <span>{t("lineageSelectedValue")}</span>
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button
                className="text-button"
                onClick={() => setRevision((value) => value + 1)}
              >
                {t("retry")}
              </button>
            </div>
          )}
          <div className="lineage-workspace">
            <div className="lineage-graph" aria-label={t("lineageGraph")}>
              {graph && (
                <ReactFlow
                  nodes={nodes}
                  edges={graph.edges}
                  nodeTypes={nodeTypes}
                  nodesDraggable={false}
                  nodesFocusable={false}
                  edgesFocusable={false}
                  ariaLabelConfig={{
                    "controls.ariaLabel": t("canvasControls"),
                    "controls.zoomIn.ariaLabel": t("zoomIn"),
                    "controls.zoomOut.ariaLabel": t("zoomOut"),
                    "controls.fitView.ariaLabel": t("fitView"),
                  }}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  minZoom={0.15}
                  maxZoom={1.6}
                  fitView
                  fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={22} size={1} />
                  <Controls showInteractive={false} />
                  <FitGraph version={graph} />
                </ReactFlow>
              )}
              {pending && (
                <div className="lineage-loading" role="status">
                  <Loader2 className="spin" size={18} />
                  {t("lineageLoading")}
                </div>
              )}
            </div>
            {active && (
              <CalculationDetails
                key={active.id}
                entry={active}
                worktree={worktree}
                environment={environment}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        </>
      )}
    </dialog>,
    document.body,
  );
}

function CalculationDetails({
  entry,
  worktree,
  environment,
  onClose,
}: {
  entry: Entry;
  worktree: string;
  environment: string;
  onClose: () => void;
}) {
  const t = useT();
  const names = useOptionalWorktree()?.snapshot?.node_names;
  const selections = [entry.result, ...entry.hidden].filter(
    (step) => step.context_total > 0,
  );
  const [selection, setSelection] = useState(0);
  const [offset, setOffset] = useState(0);
  const current = selections[selection];
  const {
    data: page,
    error,
    pending,
  } = useResource(
    current
      ? JSON.stringify([
          worktree,
          environment,
          current.dataset,
          current.row,
          current.column,
          offset,
        ])
      : null,
    (signal) =>
      api<Explanation>(`/worktrees/${worktree}/lineage`, {
        ...send({
          dataset: current!.dataset,
          row: current!.row,
          column: current!.column,
          environment,
          context: true,
          partition_context: current!.partition_context,
          offset,
        }),
        signal,
      }),
  );
  return (
    <aside
      className="lineage-details"
      aria-label={t("lineageCalculationDetails")}
    >
      <div className="row spread">
        <h3>{entry.result.column}</h3>
        <button
          className="icon"
          aria-label={t("lineageCloseDetails")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <p>
        {displayNodeName(
          names?.[entry.result.node || ""],
          entry.result.node || "",
          t,
        )}{" "}
        · {entry.result.port} · {t("lineageRow")} {entry.result.row + 1}
      </p>
      {entry.result.variables &&
        Object.keys(entry.result.variables).length > 0 && (
          <VariableValues
            variables={entry.result.variables}
            environment={entry.result.environment || ""}
          />
        )}
      {entry.result.expression && entry.result.kind !== "python" && (
        <pre className="expression">{entry.result.expression}</pre>
      )}
      {entry.result.warnings.map((warning) => (
        <p className="notice warning" key={warning}>
          {warning}
        </p>
      ))}
      {!!selections.length && (
        <>
          <h4>{t("lineageSelection")}</h4>
          <p>{t("lineageContextHint")}</p>
          {selections.length > 1 && (
            <label>
              {t("lineageSelectionStep")}
              <select
                value={selection}
                onChange={(event) => {
                  setSelection(Number(event.target.value));
                  setOffset(0);
                }}
              >
                {selections.map((step, index) => (
                  <option key={cellId(step)} value={index}>
                    {displayNodeName(
                      names?.[step.node || ""],
                      step.node || "",
                      t,
                    )}{" "}
                    · {step.column}
                  </option>
                ))}
              </select>
            </label>
          )}
          {current?.calculation?.selection?.map((condition) => (
            <pre className="expression" key={condition}>
              {condition}
            </pre>
          ))}
          {pending && <p role="status">{t("loading")}</p>}
          {error && <p role="alert">{error}</p>}
          {page && (
            <>
              <table>
                <thead>
                  <tr>
                    <th>{t("lineageInput")}</th>
                    <th>{t("lineageValue")}</th>
                    <th>{t("lineageRow")}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.contributions.map((item) => (
                    <tr key={cellId(item)}>
                      <td>{item.column}</td>
                      <td>{formatValue(item.value)}</td>
                      <td>{item.row + 1}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {page.total > page.page_size && (
                <Pager
                  className="lineage-page"
                  between
                  offset={offset}
                  total={page.total}
                  pageSize={page.page_size}
                  onOffset={setOffset}
                />
              )}
            </>
          )}
        </>
      )}
    </aside>
  );
}
