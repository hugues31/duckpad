import {
  Background,
  Controls,
  ReactFlow,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import {
  ArrowLeft,
  ArrowRight,
  Database,
  GitBranch,
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
import { api, send, withQuery } from "./api";
import { CalculationCard, CardNode } from "./CalculationCard";
import { CalculationDetails } from "./CalculationDetails";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import {
  arrangeLineage,
  buildLineageGraph,
  cellId,
  pythonCardHeight,
  requestId,
  type Cell,
  type Explanation,
  type Query,
} from "./lineageGraph";
import { trapFocus } from "./modals";
import type { PartitionPage } from "./partitions";
import { isFinal, usePolling } from "./usePolling";
import { useOptionalWorktree } from "./worktree";

type Props = {
  worktree: string;
  environment: string;
  cell: Cell;
  onClose: () => void;
};
type Graph = Awaited<ReturnType<typeof buildLineageGraph>>;
const nodeTypes = { lineage: CalculationCard };

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
