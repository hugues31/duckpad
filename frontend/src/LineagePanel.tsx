import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Database,
  GitBranch,
  Layers,
  Loader2,
  X,
} from "lucide-react";
import { api, send, withQuery } from "./api";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import { useResource } from "./useApiResource";
import { isFinal, usePolling } from "./usePolling";
import {
  arrangeLineage,
  buildLineageGraph,
  cellId,
  requestId,
  type Cell,
  type Entry,
  type Explanation,
  type Query,
} from "./lineageGraph";
import { trapFocus } from "./modals";
import "./lineage.css";

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
  const offset = query.offset || 0;
  return (
    <article
      className={`lineage-card ${source ? "is-source" : "calculation"} ${data.root ? "root" : ""}`}
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
      {source ? (
        <div className="lineage-source-location">
          {result.node?.split("::").at(-1)} · {t("lineageRow")} {result.row + 1}
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
          {!result.complete ? (
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
            <div className="lineage-page nodrag">
              <button
                className="icon"
                aria-label={t("previous")}
                disabled={disabled || offset === 0}
                onClick={() =>
                  data.page(entry.id, {
                    offset: Math.max(0, offset - result.page_size),
                  })
                }
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                {offset + 1}–{Math.min(offset + result.page_size, result.total)}{" "}
                / {result.total}{" "}
                {t(result.groups ? "valueGroups" : "contributions")}
              </span>
              <button
                className="icon"
                aria-label={t("next")}
                disabled={disabled || offset + result.page_size >= result.total}
                onClick={() =>
                  data.page(entry.id, { offset: offset + result.page_size })
                }
              >
                <ChevronRight size={14} />
              </button>
            </div>
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
    <LineageDialog
      key={JSON.stringify([
        props.worktree,
        props.environment,
        cellId(props.cell),
      ])}
      {...props}
    />
  );
}

function LineageDialog({ worktree, environment, cell, onClose }: Props) {
  const t = useT();
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
    { interval: 500, enabled: !error },
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

  const nodes = useMemo(
    () =>
      arrangeLineage<CardNode>(
        (graph?.entries || []).map((entry) => ({
          id: entry.id,
          type: "lineage",
          position: { x: 0, y: 0 },
          width: 330,
          style: { pointerEvents: "auto" },
          height:
            entry.result.kind === "source" || entry.group || entry.deferred
              ? 132
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
          },
        })),
        graph?.edges || [],
      ),
    [graph, pending],
  );
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
        <div>
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
        {entry.result.node} · {entry.result.port} · {t("lineageRow")}{" "}
        {entry.result.row + 1}
      </p>
      {entry.result.expression && (
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
                    {step.node?.split("::").at(-1)} · {step.column}
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
                <div className="lineage-page">
                  <button
                    className="icon"
                    aria-label={t("previous")}
                    disabled={!offset}
                    onClick={() =>
                      setOffset(Math.max(0, offset - page.page_size))
                    }
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>
                    {offset + 1}–{Math.min(offset + page.page_size, page.total)}{" "}
                    / {page.total}
                  </span>
                  <button
                    className="icon"
                    aria-label={t("next")}
                    disabled={offset + page.page_size >= page.total}
                    onClick={() => setOffset(offset + page.page_size)}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </aside>
  );
}
