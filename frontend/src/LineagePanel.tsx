import {
  ArrowLeft,
  ChevronRight,
  Columns3,
  Copy,
  GitBranch,
  Hash,
  Loader2,
  Table2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, send, withQuery } from "./api";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import {
  buildLineageGraph,
  cellId,
  requestId,
  type ContributingRows,
  type Explanation,
  type Input,
  type LineageGraph,
  type LineageTarget,
  type Query,
  type TableLineage,
} from "./lineageGraph";
import { displayNodeName } from "./nodeNames";
import { useApiResource } from "./useApiResource";
import { isFinal, usePolling } from "./usePolling";
import { useLoadedWorktree } from "./worktree";
import {
  LineageSteps,
  TableSteps,
  roundedValue,
  type LineageMap,
} from "./LineageSteps";
import { ColumnLineage, ColumnList } from "./ColumnLineage";
import { ColumnImpact } from "./ColumnImpact";
import { RowImpact } from "./RowImpact";

export default function LineagePanel({
  target,
  onChange,
  onClose,
  onMap,
  onHover,
  onOpen,
  onRows,
}: {
  target: LineageTarget;
  onChange: (target: LineageTarget) => void;
  onClose: () => void;
  onMap: (map: LineageMap | null) => void;
  onHover: (node: string | null) => void;
  onOpen: (node: string) => void;
  onRows: (rows: ContributingRows) => void;
}) {
  const t = useT();
  const panel = useRef<HTMLElement>(null);
  // Opening from the inspector's actions unmounts the focused button.
  useEffect(() => {
    if (document.activeElement === document.body)
      panel.current?.querySelector<HTMLElement>("h2")?.focus();
  }, []);
  const { id: worktree, snapshot, environment } = useLoadedWorktree();
  const { data: tables, error } = useApiResource<TableLineage>(
    withQuery(`/worktrees/${worktree}/lineage/tables`, {
      node: target.node,
      port: target.port,
      direction: target.direction,
      environment,
    }),
    { refresh: snapshot.revision },
  );
  // Python parent cells followed from this panel; another cell hides the way back.
  const [parents, setParents] = useState<
    { from: LineageTarget; to: LineageTarget }[]
  >([]);
  const parent = parents.at(-1);
  const back =
    parent?.to.cell &&
    target.cell &&
    cellId(parent.to.cell) === cellId(target.cell)
      ? parent.from
      : undefined;
  // The explained value, once its trace is read: the last level names it.
  const [explained, setExplained] = useState<{
    cell: string;
    value: unknown;
  } | null>(null);
  const value =
    target.cell && explained?.cell === cellId(target.cell)
      ? explained.value
      : undefined;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const explanation = useRef("");
  const name = displayNodeName(
    snapshot.node_names?.[target.node],
    target.node,
    t,
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(explanation.current);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <aside
      ref={panel}
      className="inspector lineage-panel"
      id="node-inspector"
      aria-label={t("lineage")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="lineage-header">
        {back && (
          <button
            className="icon"
            title={t("lineageBackToPython")}
            aria-label={t("lineageBackToPython")}
            onClick={() => {
              onChange(back);
              setParents((current) => current.slice(0, -1));
            }}
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <h2 tabIndex={-1}>
          <span className="kind-icon">
            <GitBranch size={16} />
          </span>
          {t("lineage")}
        </h2>
        <div
          className="lineage-direction"
          role="group"
          aria-label={t("lineageDirection")}
        >
          {(["origin", "impact"] as const).map((direction) => (
            <button
              key={direction}
              className={target.direction === direction ? "active" : ""}
              aria-pressed={target.direction === direction}
              onClick={() => onChange({ ...target, direction })}
            >
              {t(direction === "origin" ? "lineageOrigin" : "lineageImpact")}
            </button>
          ))}
        </div>
        {target.cell && (
          <button
            className="icon"
            title={t(copied ? "lineageCopied" : "lineageCopy")}
            aria-label={t(copied ? "lineageCopied" : "lineageCopy")}
            onClick={() => void copy()}
          >
            <Copy size={15} />
          </button>
        )}
        <button
          className="icon"
          title={t("close")}
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <nav className="lineage-breadcrumb" aria-label={t("lineageLevels")}>
        <button
          className="lineage-crumb"
          aria-current={!target.cell && !target.column ? "page" : undefined}
          onClick={() =>
            onChange({ ...target, cell: undefined, column: undefined })
          }
        >
          <Table2 size={13} />
          {name}
          {target.port ? ` · ${target.port}` : ""}
        </button>
        <ChevronRight size={13} aria-hidden="true" />
        <button
          className={`lineage-crumb ${target.cell || target.column ? "" : "placeholder"}`}
          disabled={!target.cell && !target.column}
          aria-current={target.column && !target.cell ? "page" : undefined}
          onClick={() =>
            onChange({
              ...target,
              cell: undefined,
              column: target.cell?.column || target.column,
              direction: "origin",
            })
          }
        >
          <Columns3 size={13} />
          {target.cell?.column || target.column || t("columns")}
        </button>
        <ChevronRight size={13} aria-hidden="true" />
        <span
          className={`lineage-crumb ${target.cell ? "" : "placeholder"}`}
          aria-current={target.cell ? "page" : undefined}
          title={value === undefined ? undefined : formatValue(value)}
        >
          <Hash size={12} />
          {target.cell
            ? `${t("lineageRow")} ${target.cell.row + 1}${value === undefined ? "" : ` = ${roundedValue(value)}`}`
            : t("lineagePickValue")}
        </span>
      </nav>
      <div className="lineage-body">
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!tables && !error && (
          <div role="status">
            <Loader2 className="spin" size={18} />
            {t("loading")}
          </div>
        )}
        {tables &&
          (target.cell && target.direction === "impact" ? (
            <RowImpact
              key={JSON.stringify([worktree, environment, cellId(target.cell)])}
              target={target}
              onMap={onMap}
              onHover={onHover}
              onOpen={onOpen}
              onText={(text) => {
                explanation.current = text;
              }}
            />
          ) : target.cell ? (
            <ValueLineage
              key={JSON.stringify([worktree, environment, cellId(target.cell)])}
              target={target}
              tables={tables}
              onMap={onMap}
              onHover={onHover}
              onOpen={onOpen}
              onRows={onRows}
              onChange={(next) => {
                setParents((current) => [
                  ...(back ? current : []),
                  { from: target, to: next },
                ]);
                onChange(next);
              }}
              onText={(text) => {
                explanation.current = text;
              }}
              onValue={(value) =>
                setExplained({ cell: cellId(target.cell!), value })
              }
            />
          ) : target.column && target.direction === "impact" ? (
            <ColumnImpact
              key={JSON.stringify([
                worktree,
                environment,
                target.node,
                target.port,
                target.column,
              ])}
              target={target}
              onMap={onMap}
              onHover={onHover}
              onOpen={onOpen}
              onChange={onChange}
            />
          ) : target.column ? (
            <ColumnLineage
              target={target}
              tables={tables}
              onMap={onMap}
              onHover={onHover}
              onOpen={onOpen}
            />
          ) : (
            <>
              <TableSteps
                tables={tables}
                direction={target.direction}
                onMap={onMap}
                onHover={onHover}
                onOpen={onOpen}
              />
              <ColumnList target={target} onChange={onChange} />
            </>
          ))}
      </div>
    </aside>
  );
}

function ValueLineage({
  target,
  tables,
  onMap,
  onHover,
  onOpen,
  onRows,
  onChange,
  onText,
  onValue,
}: {
  target: LineageTarget;
  tables: TableLineage;
  onMap: (map: LineageMap | null) => void;
  onHover: (node: string | null) => void;
  onOpen: (node: string) => void;
  onRows: (rows: ContributingRows) => void;
  onChange: (target: LineageTarget) => void;
  onText: (text: string) => void;
  onValue: (value: unknown) => void;
}) {
  const t = useT();
  const {
    id: worktree,
    environment,
    snapshot,
    statuses,
    starting,
  } = useLoadedWorktree();
  const cell = target.cell!;
  const cache = useRef(new Map<string, Explanation>());
  const stopped = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [graph, setGraph] = useState<LineageGraph | null>(null);
  const [choices, setChoices] = useState<Record<string, Input>>({});
  const [opened, setOpened] = useState(new Set<string>());
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [interrupted, setInterrupted] = useState(false);
  const interrupt = useCallback(() => {
    stopped.current = true;
    controller.current?.abort();
    setInterrupted(true);
    setPending(false);
    onMap(null);
  }, [onMap]);
  useEffect(() => {
    // The run is external state: cancel requests before any stale response can render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (statuses.active || starting) interrupt();
  }, [statuses.active, starting, interrupt]);
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
          if (!signal.aborted && !result.valid) {
            interrupt();
            return false;
          }
        } catch (e) {
          if (!signal.aborted && isFinal(e)) setError((e as Error).message);
          throw e;
        }
      },
      [worktree, environment, cell.dataset, interrupt],
    ),
    { interval: 2000, enabled: !error && !interrupted },
  );
  const read = useCallback(
    async (query: Query, signal?: AbortSignal) => {
      const key = requestId(query),
        cached = cache.current.get(key);
      if (cached) return cached;
      const result = await api<Explanation>(`/worktrees/${worktree}/lineage`, {
        ...send({ ...query, environment }),
        signal,
      });
      if (signal?.aborted || stopped.current)
        throw new DOMException("Aborted", "AbortError");
      cache.current.set(key, result);
      return result;
    },
    [worktree, environment],
  );
  useEffect(() => {
    if (stopped.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setError("");
    void buildLineageGraph(
      cell,
      choices,
      opened,
      (query) => read(query, abort.signal),
      tables,
    )
      .then((result) => {
        if (!abort.signal.aborted) setGraph(result);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setGraph(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setPending(false);
      });
    return () => abort.abort();
  }, [cell, tables, choices, opened, revision, read]);
  const map = useMemo(() => {
    const result: LineageMap = {};
    for (const entry of graph?.entries || []) {
      const node = entry.result.node;
      if (node) result[node] ??= { value: entry.result.value };
      for (const child of entry.children) {
        if (child.input.node)
          result[child.input.node] ??= { value: child.input.value };
        if (child.deferred && child.input.node) {
          const pending = [child.input.node],
            visited = new Set<string>();
          while (pending.length) {
            const node = pending.pop()!;
            if (visited.has(node)) continue;
            visited.add(node);
            result[node] ??= {};
            pending.push(
              ...tables.edges
                .filter((e) => e.target === node && !e.variable)
                .map((e) => e.source),
            );
          }
        }
      }
    }
    return result;
  }, [graph, tables]);
  useEffect(() => {
    onMap(interrupted || error ? null : map);
    return () => onMap(null);
  }, [map, interrupted, error, onMap]);
  const text = graph
    ? [
        `Run: ${graph.original.execution || ""}\nCommit: ${graph.original.commit || ""}\nEnvironment: ${environment}`,
        ...graph.entries.map(({ result }) =>
          [
            displayNodeName(
              snapshot.node_names?.[result.node || ""],
              result.node || "",
              t,
            ),
            `${result.column} = ${result.calculation?.formula || result.expression || formatValue(result.value)}`,
            `${result.calculation?.evaluated || ""} = ${formatValue(result.value)}`,
            ...(result.operands || []).map(
              (p) => `${p.formula} = ${formatValue(p.value)} (${p.total})`,
            ),
            ...(result.calculation?.selection || []),
            ...(result.calculation?.selection_evaluated || []),
            ...result.warnings,
          ].join("\n"),
        ),
      ].join("\n\n")
    : "";
  useEffect(() => {
    onText(text);
  }, [text, onText]);
  const original = graph?.original;
  const announce = useEffectEvent(onValue);
  useEffect(() => {
    if (original) announce(original.value);
  }, [original]);
  if (interrupted)
    return (
      <div className="notice warning" role="alert">
        {t("lineageInterrupted")}
      </div>
    );
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError("");
              setRevision((v) => v + 1);
            }}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {pending && (
        <div className="lineage-loading" role="status">
          <Loader2 className="spin" size={16} />
          {t("lineageLoading")}
        </div>
      )}
      {graph && !error && (
        <LineageSteps
          graph={graph}
          tables={tables}
          read={read}
          pending={pending}
          onChoose={(id, input) =>
            setChoices((current) => ({ ...current, [id]: input }))
          }
          onExpand={(id) => setOpened((current) => new Set([...current, id]))}
          onHover={onHover}
          onOpen={onOpen}
          onRows={onRows}
          onParent={(cell) =>
            onChange({ ...target, node: cell.node || target.node, cell })
          }
        />
      )}
    </>
  );
}
