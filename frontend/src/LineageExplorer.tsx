import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Maximize,
  Search,
  X,
} from "lucide-react";
import type { ReactFlowInstance, Viewport } from "@xyflow/react";
import { api, ApiError, formatValue, send } from "./types";
import { useT } from "./i18n";
import LineageGraph, { type CardNode } from "./LineageGraph";
import {
  ancestry,
  cellKey,
  investigationCoverage,
  stageExplanation,
  type CellRef,
  type InvestigationStep,
  type LineageStage,
  type RecordPage,
  type StageView,
} from "./lineageModel";
import "./lineage.css";

const defaultView = (): StageView => ({ limit: 25, offsets: {} });
export default function LineageExplorer({
  worktree,
  environment,
  root,
  targetName,
  targetPort,
  open,
  onClose,
}: {
  worktree: string;
  environment: string;
  root: CellRef;
  targetName?: string;
  targetPort?: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [steps, setSteps] = useState<InvestigationStep[]>([
    { id: "target", cell: root, depth: 0 },
  ]);
  const [selected, setSelected] = useState("target");
  const [views, setViews] = useState<Record<string, StageView>>({});
  const [mode, setMode] = useState("graph");
  const [tab, setTab] = useState("graph");
  const [search, setSearch] = useState("");
  const [isolated, setIsolated] = useState(false);
  const [components, setComponents] = useState(false);
  const [projections, setProjections] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({
    x: 520,
    y: 50,
    zoom: 0.8,
  });
  const graph = useRef<ReactFlowInstance<CardNode> | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const [tableHeight, setTableHeight] = useState(270);
  const [error, setError] = useState("");
  const [interrupted, setInterrupted] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [loadingStage, setLoadingStage] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [page, setPage] = useState<{ key: string; value: RecordPage } | null>(
    null,
  );
  const pending = useRef(new Map<string, AbortController>());
  const stages = useRef(new Map<string, LineageStage>());
  const pages = useRef(new Map<string, RecordPage>());
  const fitted = useRef(false);
  const current = steps.find((s) => s.id === selected)!;
  const stage = current.stage;
  const target = steps[0].stage;
  const view = views[selected] || defaultView();
  const role =
    stage?.roles.find((r) => r.id === view.role) ||
    stage?.roles.find((r) => r.kind === "value") ||
    stage?.roles[0];
  const offsetKey = JSON.stringify([role?.id, view.group]);
  const offset = view.offsets[offsetKey] || 0;
  const pageKey = JSON.stringify([
    worktree,
    environment,
    cellKey(root),
    selected,
    role?.id,
    view.group,
    offset,
    view.limit,
  ]);
  const records = page?.key === pageKey ? page.value : null;
  const blocked = interrupted || cancelled;
  const path = ancestry(steps, selected);

  const stop = useCallback(
    (id: string) => {
      const controller = pending.current.get(id);
      if (!controller) return;
      controller.abort();
      pending.current.delete(id);
      void api(
        `/worktrees/${worktree}/lineage/cancel`,
        send({ environment, request_id: id }),
      ).catch(() => {});
    },
    [worktree, environment],
  );
  const stopAll = useCallback(
    () => [...pending.current.keys()].forEach(stop),
    [stop],
  );
  const request = useCallback(
    <T,>(route: string, body: object) => {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      pending.current.set(id, controller);
      const promise = api<T>(`/worktrees/${worktree}/lineage/${route}`, {
        ...send({ environment, root, ...body, request_id: id }),
        signal: controller.signal,
      }).finally(() => pending.current.delete(id));
      return { promise, cancel: () => stop(id) };
    },
    [worktree, environment, root, stop],
  );
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof ApiError && e.status === 409) {
        setInterrupted(true);
        stopAll();
        stages.current.clear();
        pages.current.clear();
      } else if (e instanceof ApiError && e.status === 408)
        setError(t("lineageBudgetTimeout"));
      else setError(e instanceof Error ? e.message : t("lineageRequestError"));
    },
    [stopAll, t],
  );

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else {
      dialog.current?.close();
      stopAll();
    }
  }, [open, stopAll]);
  useEffect(() => () => stopAll(), [stopAll]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const verify = async () => {
      try {
        const state = await api<{ valid: boolean }>(
          `/worktrees/${worktree}/generations/${root.dataset}?environment=${encodeURIComponent(environment)}`,
          { signal: controller.signal },
        );
        if (live && !state.valid) {
          setInterrupted(true);
          stopAll();
          stages.current.clear();
          pages.current.clear();
        }
      } catch {
        /* Auth/network failures are displayed by the investigation request. */
      }
    };
    void verify();
    const timer = setInterval(verify, 500);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [worktree, environment, root, stopAll]);

  useEffect(() => {
    if (!open || blocked || stage) return;
    let live = true;
    setError("");
    setLoadingStage(true);
    const cached = stages.current.get(cellKey(current.cell));
    const apply = (value: LineageStage) => {
      if (!live) return;
      stages.current.set(cellKey(current.cell), value);
      setSteps((old) =>
        old.map((s) => (s.id === selected ? { ...s, stage: value } : s)),
      );
    };
    if (cached) {
      apply(cached);
      setLoadingStage(false);
      return;
    }
    const active = request<LineageStage>("stage", { cell: current.cell });
    void active.promise
      .then(apply)
      .catch((e) => {
        if (live) fail(e);
      })
      .finally(() => {
        if (live) setLoadingStage(false);
      });
    return () => {
      live = false;
      active.cancel();
      setLoadingStage(false);
    };
  }, [open, blocked, selected, current.cell, stage, epoch, request, fail]);

  useEffect(() => {
    if (!open || blocked || !stage || !role || !role.occurrences) return;
    let live = true;
    setLoadingRecords(true);
    setError("");
    const cached = pages.current.get(pageKey);
    if (cached) {
      setPage({ key: pageKey, value: cached });
      setLoadingRecords(false);
      return;
    }
    const active = request<RecordPage>("records", {
      cell: current.cell,
      role: role.id,
      offset,
      limit: view.limit,
      group: view.group,
    });
    void active.promise
      .then((value) => {
        if (!live) return;
        pages.current.set(pageKey, value);
        if (pages.current.size > 120)
          pages.current.delete(pages.current.keys().next().value!);
        setPage({ key: pageKey, value });
      })
      .catch((e) => {
        if (live) fail(e);
      })
      .finally(() => {
        if (live) setLoadingRecords(false);
      });
    return () => {
      live = false;
      active.cancel();
      setLoadingRecords(false);
    };
  }, [
    open,
    blocked,
    stage,
    role,
    pageKey,
    current.cell,
    offset,
    view.limit,
    view.group,
    epoch,
    request,
    fail,
  ]);

  useEffect(() => {
    if (open && target && !fitted.current && mode === "graph") {
      const timer = setTimeout(() => {
        graph.current?.fitView({ padding: 0.2, maxZoom: 0.85 });
        fitted.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open, target, mode]);

  const select = useCallback((id: string, role?: string) => {
    setSelected(id);
    setError("");
    if (role)
      setViews((old) => ({
        ...old,
        [id]: {
          ...(old[id] || defaultView()),
          role,
          group: old[id]?.role === role ? old[id]?.group : undefined,
        },
      }));
  }, []);
  const changeView = (changes: Partial<StageView>) =>
    setViews((old) => ({ ...old, [selected]: { ...view, ...changes } }));
  const changePage = (offset: number) =>
    changeView({ offsets: { ...view.offsets, [offsetKey]: offset } });
  const follow = (cell: CellRef) => {
    if (blocked || !role) return;
    const id = selected + "/" + role.id + "/" + cellKey(cell);
    if (!steps.some((s) => s.id === id)) {
      if (steps.length >= 64) {
        setError(t("lineageStageBudget"));
        return;
      }
      setSteps((old) => [
        ...old,
        { id, cell, parent: selected, via: role.id, depth: current.depth + 1 },
      ]);
    }
    select(id);
    setTab("inspector");
  };
  const resize = (e: PointerEvent, direction: "width" | "height") => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = e.clientX,
      y = e.clientY,
      width = inspectorWidth,
      height = tableHeight;
    const element = e.currentTarget;
    const move = (event: globalThis.PointerEvent) => {
      if (direction === "width")
        setInspectorWidth(
          Math.max(260, Math.min(600, width + x - event.clientX)),
        );
      else
        setTableHeight(
          Math.max(150, Math.min(550, height + y - event.clientY)),
        );
    };
    const end = () => {
      element.removeEventListener("pointermove", move as EventListener);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move as EventListener);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  };
  const coverage = investigationCoverage(steps);
  const retry = () => {
    setCancelled(false);
    setError("");
    setEpoch((value) => value + 1);
  };
  const targetLabel = targetName || target?.label || root.column;
  const searchResults = search.trim()
    ? steps
        .flatMap((step) => [
          {
            step: step.id,
            role: undefined as string | undefined,
            label: `${step.stage?.path.join(" › ") || step.cell.column} · ${step.cell.column} · #${step.cell.row}`,
          },
          ...(step.stage?.roles || []).map((r) => ({
            step: step.id,
            role: r.id,
            label: `${r.path.join(" › ")} · ${r.display_alias} · ${r.column} · ${t("dependency_" + r.kind)}`,
          })),
        ])
        .filter((item) =>
          item.label.toLowerCase().includes(search.trim().toLowerCase()),
        )
        .slice(0, 30)
    : [];

  return createPortal(
    <dialog
      ref={dialog}
      className="lineage-workspace"
      aria-label={t("exploreLineage")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="lineage-workspace-header">
        <div className="row gap">
          <GitBranch size={20} />
          <strong>{t("exploreLineage")}</strong>
          <span className="badge">{environment}</span>
        </div>
        <button
          className="icon"
          aria-label={t("closeExplorer")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="lineage-target" data-testid="lineage-target">
        <div>
          <span className="eyebrow">{t("originalTarget")}</span>
          <h2>
            {targetLabel}
            <span>
              {" "}
              / {targetPort || target?.port} / {root.column}
            </span>
          </h2>
          <p>
            {target?.path.join(" › ")} · {t("stableRow")} #{root.row}
          </p>
        </div>
        <strong className="lineage-target-value">
          {target ? formatValue(target.value) : "…"}
        </strong>
        <details className="lineage-metadata">
          <summary>{t("executionMetadata")}</summary>
          <dl>
            <dt>{t("execution")}</dt>
            <dd>{root.execution}</dd>
            <dt>{t("generation")}</dt>
            <dd>{root.dataset}</dd>
            <dt>{t("environment")}</dt>
            <dd>{environment}</dd>
            <dt>{t("project")}</dt>
            <dd>{target?.project}</dd>
            <dt>{t("worktree")}</dt>
            <dd>{worktree}</dd>
            <dt>{t("technicalNode")}</dt>
            <dd>{target?.node}</dd>
          </dl>
        </details>
      </div>
      <div className={`lineage-coverage ${coverage}`} role="status">
        <strong>
          {t("investigationCoverage")}:{" "}
          {t(interrupted ? "lineageInterrupted" : coverage)}
        </strong>
        <span>
          {steps.filter((s) => s.stage).length} / 64 {t("lineageSteps")} ·{" "}
          {t("lineageBudgetHint")}
        </span>
      </div>
      <nav className="lineage-breadcrumbs" aria-label={t("lineagePath")}>
        <button
          className="button secondary small"
          disabled={selected === "target" || interrupted}
          onClick={() => select("target")}
        >
          <ArrowLeft size={14} />
          {t("backToTarget")}
        </button>
        {path.map((s) => (
          <button
            key={s.id}
            disabled={interrupted}
            aria-current={s.id === selected ? "step" : undefined}
            onClick={() => select(s.id)}
          >
            {s.stage?.label || s.cell.column} · {s.cell.column} · #{s.cell.row}
          </button>
        ))}
      </nav>
      {(loadingStage || loadingRecords) && (
        <div className="lineage-progress" role="status">
          <progress max={2} value={loadingStage ? 0 : 1} />
          <span>{t(loadingStage ? "discoveringStep" : "loadingRecords")}</span>
          <button
            className="text-button"
            onClick={() => {
              stopAll();
              setCancelled(true);
            }}
          >
            {t("cancelInvestigation")}
          </button>
        </div>
      )}
      {interrupted ? (
        <div className="notice warning">{t("lineageInterrupted")}</div>
      ) : (
        (error || cancelled) && (
          <div className="notice warning" role="alert">
            {cancelled ? t("investigationCancelled") : error}
            <button className="button secondary small" onClick={retry}>
              {t("lineageRetry")}
            </button>
          </div>
        )
      )}
      <div
        className="lineage-mobile-tabs"
        role="tablist"
        aria-label={t("explorerPanels")}
      >
        {["graph", "inspector", "records"].map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {t("explorer_" + name)}
          </button>
        ))}
      </div>
      <div
        className="lineage-layout"
        data-tab={tab}
        style={
          {
            "--inspector-width": `${inspectorWidth}px`,
            "--records-height": `${tableHeight}px`,
          } as CSSProperties
        }
      >
        <section
          className="lineage-map-pane"
          aria-label={t("contributionGraph")}
        >
          <div className="lineage-toolbar">
            <div className="segmented" aria-label={t("presentation")}>
              {["graph", "path"].map((name) => (
                <button
                  key={name}
                  aria-pressed={mode === name}
                  onClick={() => setMode(name)}
                >
                  {t("presentation_" + name)}
                </button>
              ))}
            </div>
            <div className="search compact">
              <Search size={13} />
              <input
                aria-label={t("searchSteps")}
                placeholder={t("searchSteps")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
              className="icon"
              aria-label={t("fitToView")}
              onClick={() =>
                graph.current?.fitView({ padding: 0.2, maxZoom: 1 })
              }
            >
              <Maximize size={16} />
            </button>
            <label>
              <input
                type="checkbox"
                checked={isolated}
                onChange={(e) => setIsolated(e.target.checked)}
              />
              {t("isolatePath")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={components}
                onChange={(e) => setComponents(e.target.checked)}
              />
              {t("collapseComponents")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={projections}
                onChange={(e) => setProjections(e.target.checked)}
              />
              {t("collapseProjections")}
            </label>
          </div>
          {search.trim() && (
            <div
              className="lineage-search-results"
              aria-label={t("searchResults")}
            >
              {searchResults.length ? (
                searchResults.map((item) => (
                  <button
                    key={item.step + item.role}
                    disabled={blocked}
                    onClick={() => {
                      select(item.step, item.role);
                      const node = graph.current?.getNode(
                        item.role ? item.step + ":" + item.role : item.step,
                      );
                      if (node)
                        void graph.current?.setCenter(
                          node.position.x + 125,
                          node.position.y + 50,
                          { zoom: 0.85 },
                        );
                    }}
                  >
                    {item.label}
                  </button>
                ))
              ) : (
                <span>{t("noMatches")}</span>
              )}
            </div>
          )}
          <div className="lineage-legend">
            {["value", "condition", "existence"].map((kind) => (
              <span className={`dependency-${kind}`} key={kind}>
                {t("dependency_" + kind)}
              </span>
            ))}
            <span>{t("graphKeyboardHint")}</span>
          </div>
          <div className="lineage-map-content" inert={blocked}>
            <div className="lineage-graph-container" hidden={mode !== "graph"}>
              <LineageGraph
                steps={steps}
                selected={selected}
                role={view.role}
                onSelect={select}
                search={search}
                isolated={isolated}
                components={components}
                projections={projections}
                viewport={viewport}
                onViewport={setViewport}
                instance={graph}
              />
            </div>
            {mode === "path" && (
              <ol
                className="lineage-detailed-path"
                aria-label={t("detailedPath")}
              >
                {(isolated ? path : steps)
                  .filter(
                    (s) =>
                      !search ||
                      `${s.stage?.label} ${s.cell.column} ${s.stage?.path.join(" ")}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                  )
                  .map((s) => (
                    <li key={s.id}>
                      <button
                        className={s.id === selected ? "selected" : ""}
                        aria-current={s.id === selected ? "step" : undefined}
                        onClick={() => select(s.id)}
                      >
                        <strong>{s.stage?.label || s.cell.column}</strong>
                        <span>
                          {s.stage?.path.join(" › ")} · {s.stage?.port} ·{" "}
                          {s.cell.column} · #{s.cell.row}
                        </span>
                        <small>{t(investigationCoverage(steps, s.id))}</small>
                      </button>
                      <div>
                        {s.stage?.roles.map((r) => (
                          <button
                            key={r.id}
                            className={`lineage-path-role dependency-${r.kind}`}
                            aria-pressed={
                              s.id === selected && role?.id === r.id
                            }
                            onClick={() => select(s.id, r.id)}
                          >
                            {t("dependency_" + r.kind)} · {r.display_alias} ·{" "}
                            {r.column} · {r.occurrences} · {t(r.coverage)}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
              </ol>
            )}
          </div>
        </section>
        <div
          className="lineage-resizer vertical"
          role="separator"
          aria-label={t("resizeInspector")}
          aria-orientation="vertical"
          aria-valuemin={260}
          aria-valuemax={600}
          aria-valuenow={inspectorWidth}
          tabIndex={0}
          onPointerDown={(e) => resize(e, "width")}
          onKeyDown={(e) => {
            if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
              e.preventDefault();
              setInspectorWidth((v) =>
                Math.max(
                  260,
                  Math.min(600, v + (e.key === "ArrowLeft" ? 20 : -20)),
                ),
              );
            }
          }}
        />
        <section
          className="lineage-step-inspector"
          aria-label={t("stepInspector")}
        >
          <span className="eyebrow">{t("inspectedStep")}</span>
          {stage && !interrupted ? (
            <>
              <h3>{stage.label}</h3>
              <p className="muted small">
                {stage.path.join(" › ")} · {stage.port} · #{stage.cell.row}
              </p>
              <div className="lineage-step-value">
                <span>{stage.cell.column}</span>
                <strong>{formatValue(stage.value)}</strong>
              </div>
              <p className="lineage-explanation">
                {stageExplanation(stage, t)}
              </p>
              <p className="lineage-status">
                {t(stage.coverage.step)} ·{" "}
                {t(investigationCoverage(steps, selected))}
              </p>
              {stage.coverage.warnings.map((w) => (
                <p className="notice warning" key={w}>
                  {w}
                </p>
              ))}
              <h4>{t("expression")}</h4>
              <pre className="expression">{stage.expression}</pre>
              {stage.evidence.calculations && (
                <details open>
                  <summary>{t("calculationSteps")}</summary>
                  <dl className="lineage-calculations">
                    {stage.evidence.calculations.map((e, i) => (
                      <div key={i}>
                        <dt>
                          <code>{e.expression}</code>
                        </dt>
                        <dd>{formatValue(e.value)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
              {stage.evidence.examined_rows !== undefined && (
                <dl className="lineage-counts">
                  <dt>{t("examinedRows")}</dt>
                  <dd>{stage.evidence.examined_rows}</dd>
                  <dt>{t("retainedRows")}</dt>
                  <dd>{stage.evidence.retained_rows}</dd>
                  <dt>{t("excludedRows")}</dt>
                  <dd>
                    {stage.evidence.examined_rows -
                      (stage.evidence.retained_rows ?? 0)}
                  </dd>
                </dl>
              )}
              {stage.evidence.join_pairs && (
                <details open>
                  <summary>
                    {t("joinPairs")} · {stage.evidence.join_pairs.total}
                  </summary>
                  <p className="muted small">{t("joinPairsHint")}</p>
                  <div className="lineage-records-scroll">
                    <table className="data-table lineage-records-table">
                      <thead>
                        <tr>
                          {stage.evidence.join_pairs.aliases.map((alias) => (
                            <th key={alias}>{alias}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {stage.evidence.join_pairs.rows.map((pair, i) => (
                          <tr key={i}>
                            {pair.map((row, j) => (
                              <td key={j}>
                                {row === null
                                  ? t("no_matching_row")
                                  : `#${row}`}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {stage.evidence.join_pairs.total >
                    stage.evidence.join_pairs.limit && (
                    <p className="notice warning">{t("joinPairsBounded")}</p>
                  )}
                </details>
              )}
              {stage.evidence.frame && (
                <details open>
                  <summary>{t("windowContext")}</summary>
                  <pre className="expression">
                    {stage.evidence.partition?.join(", ")}
                    {"\n"}
                    {stage.evidence.order}
                    {"\n"}
                    {stage.evidence.frame}
                  </pre>
                </details>
              )}
              {role && (
                <div className={`lineage-role-summary dependency-${role.kind}`}>
                  <h4>{t("dependency_" + role.kind)}</h4>
                  <p>{t("reason_" + role.kind)}</p>
                  <p>
                    {role.label} · {role.display_alias} · {role.port} ·{" "}
                    {role.column}
                  </p>
                  <strong>
                    {role.occurrences} {t("sourceOccurrences")} ·{" "}
                    {role.participations} {t("participations")}
                  </strong>
                  <p>{t(role.coverage)}</p>
                  <button
                    className="text-button lineage-mobile-only"
                    onClick={() => setTab("records")}
                  >
                    {t("explorer_records")}
                  </button>
                </div>
              )}
              {stage.evidence.record && (
                <details open>
                  <summary>{t("completeRecord")}</summary>
                  <dl>
                    {stage.evidence.record.columns.map((c, i) => (
                      <div key={c.name}>
                        <dt>
                          {c.name} <small>{c.type}</small>
                        </dt>
                        <dd>{formatValue(stage.evidence.record!.values[i])}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
              <details>
                <summary>{t("showSql")}</summary>
                <pre className="expression">{stage.sql}</pre>
              </details>
            </>
          ) : (
            <p>{t(interrupted ? "lineageInterrupted" : "loading")}</p>
          )}
        </section>
        <div
          className="lineage-resizer horizontal"
          role="separator"
          aria-label={t("resizeRecords")}
          aria-orientation="horizontal"
          aria-valuemin={150}
          aria-valuemax={550}
          aria-valuenow={tableHeight}
          tabIndex={0}
          onPointerDown={(e) => resize(e, "height")}
          onKeyDown={(e) => {
            if (["ArrowUp", "ArrowDown"].includes(e.key)) {
              e.preventDefault();
              setTableHeight((v) =>
                Math.max(
                  150,
                  Math.min(550, v + (e.key === "ArrowUp" ? 20 : -20)),
                ),
              );
            }
          }}
        />
        <section
          className="lineage-records-pane"
          aria-label={t("contributingRecords")}
        >
          <div className="lineage-records-toolbar">
            <strong>{t("contributingRecords")}</strong>
            {stage && (
              <select
                aria-label={t("contributionRole")}
                value={role?.id || ""}
                disabled={blocked}
                onChange={(e) =>
                  changeView({ role: e.target.value, group: undefined })
                }
              >
                {stage.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {t("dependency_" + r.kind)} · {r.display_alias} · {r.column}{" "}
                    ({r.occurrences})
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label={t("contributorPageSize")}
              value={view.limit}
              disabled={blocked}
              onChange={(e) =>
                changeView({ limit: Number(e.target.value), offsets: {} })
              }
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} {t("rows")}
                </option>
              ))}
            </select>
          </div>
          {view.group !== undefined && (
            <button
              className="text-button"
              disabled={blocked}
              onClick={() => changeView({ group: undefined })}
            >
              <ArrowLeft size={14} />
              {t("allValueGroups")} · {view.group}
            </button>
          )}
          {role && (
            <p className="lineage-records-caption">
              {role.path.join(" › ")} · {role.port} · {t("followedColumn")}:{" "}
              <strong>{role.column}</strong> · {t("reason_" + role.kind)}
            </p>
          )}
          <div className="lineage-records-scroll" aria-busy={loadingRecords}>
            {blocked ? (
              <p className="empty-small">
                {t(
                  interrupted ? "lineageInterrupted" : "investigationCancelled",
                )}
              </p>
            ) : loadingRecords ? (
              <p className="empty-small">{t("loadingRecords")}</p>
            ) : records ? (
              <table className="data-table lineage-records-table">
                <thead>
                  <tr>
                    <th>
                      {records.groups.length
                        ? t("valueGroups")
                        : t("stableRow")}
                    </th>
                    {records.groups.length ? (
                      <th>{t("inputRows")}</th>
                    ) : (
                      <>
                        <th>{t("participations")}</th>
                        {records.columns.map((c) => (
                          <th
                            className={
                              c.name === role?.column ? "followed-column" : ""
                            }
                            key={c.name}
                          >
                            {c.name}
                            <small>{c.type}</small>
                          </th>
                        ))}
                      </>
                    )}
                    <th>{t("inspect")}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.groups.map((g) => (
                    <tr key={g.key}>
                      <td>{formatValue(g.value)}</td>
                      <td>{g.rows}</td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => changeView({ group: g.key })}
                        >
                          {t("inspectOccurrences")}
                          <ArrowUpRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {records.records.map((r) => (
                    <tr key={cellKey(r.cell)}>
                      <td>#{r.cell.row}</td>
                      <td>{r.participations}</td>
                      {r.values.map((v, i) => (
                        <td
                          className={
                            records.columns[i].name === role?.column
                              ? "followed-column"
                              : ""
                          }
                          key={i}
                        >
                          {formatValue(v)}
                        </td>
                      ))}
                      <td>
                        <button
                          className="text-button"
                          aria-label={`${t("inspectRow")} #${r.cell.row}`}
                          onClick={() => follow(r.cell)}
                        >
                          {t("inspect")}
                          <ArrowUpRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="empty-small">
                {t(
                  role
                    ? role.coverage
                    : stage?.kind === "source"
                      ? "sourceValue"
                      : "chooseContribution",
                )}
              </p>
            )}
          </div>
          <div className="lineage-records-pager">
            <span>
              {records
                ? `${Math.min(offset + 1, records.total)}–${Math.min(offset + view.limit, records.total)} / ${records.total}`
                : role?.occurrences || 0}
            </span>
            <button
              className="button secondary small"
              disabled={blocked || !offset || loadingRecords}
              onClick={() => changePage(Math.max(0, offset - view.limit))}
            >
              <ChevronLeft size={14} />
              {t("previous")}
            </button>
            <button
              className="button secondary small"
              disabled={
                blocked ||
                !records ||
                offset + view.limit >= records.total ||
                loadingRecords
              }
              onClick={() => changePage(offset + view.limit)}
            >
              {t("next")}
              <ChevronRight size={14} />
            </button>
          </div>
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
