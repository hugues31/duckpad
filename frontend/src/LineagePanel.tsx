import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Database,
  GitBranch,
  Loader2,
  Pause,
  Play,
  X,
} from "lucide-react";
import { api, send, withQuery } from "./api";
import { formatValue } from "./graph";
import type { Json } from "./types";
import { useT } from "./i18n";
import "./lineage.css";

type Cell = { dataset: string; row: number; column: string; node?: string };
type Input = Cell & {
  value: unknown;
  source: boolean;
  port: string;
  node: string;
};
type Query = Cell & { offset?: number; group?: string; context?: boolean };
type Explanation = Cell & {
  value: unknown;
  kind?: string;
  expression?: string;
  complete: boolean;
  warnings: string[];
  total: number;
  page_size: number;
  contributions: Input[];
  context_total: number;
  groups?: { key: string; value: unknown; rows: number }[];
};
type Step = {
  query: Query;
  result: Explanation;
  page: Explanation;
  context: boolean;
};
type Request = {
  prefix: Step[];
  query: Query;
  replace?: Step;
  context: boolean;
};
type Props = {
  worktree: string;
  environment: string;
  cell: Json;
  onClose: () => void;
};

const identity = (cell: Cell) =>
  JSON.stringify([cell.dataset, cell.row, cell.column]);
const operationKeys: Record<string, string> = {
  source: "lineageSource",
  projection: "lineageCalculation",
  aggregate: "lineageAggregate",
  distinct_groups: "lineageDistinct",
  distinct: "lineageDistinct",
  filter: "lineageFilter",
  join: "lineageJoin",
  window: "lineageWindow",
  union: "lineageUnion",
  intersect: "lineageIntersect",
  except: "lineageExcept",
};

// A new cell is a new exploration, including when the previous one was interrupted.
export default function LineagePanel(props: Props) {
  return (
    <LineageJourney
      key={JSON.stringify([
        props.worktree,
        props.environment,
        identity(props.cell as Cell),
      ])}
      {...props}
    />
  );
}

function LineageJourney({ worktree, environment, cell, onClose }: Props) {
  const t = useT();
  const [steps, setSteps] = useState<Step[]>([]);
  const [active, setActive] = useState(0);
  const [request, setRequest] = useState<Request>({
    prefix: [],
    query: cell as Cell,
    context: false,
  });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [interrupted, setInterrupted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const activeCard = useRef<HTMLLIElement | null>(null);
  const timelineBody = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const abort = new AbortController();
    const verify = async () => {
      try {
        const state = await api(
          withQuery(`/worktrees/${worktree}/generations/${cell.dataset}`, {
            environment,
          }),
          { signal: abort.signal },
        );
        if (live && !state.valid) {
          stopped.current = true;
          controller.current?.abort();
          setInterrupted(true);
          setPlaying(false);
          setPending(false);
          return;
        }
      } catch {
        // Retry transient failures while this exploration is open.
      }
      if (live) timer = window.setTimeout(verify, 500);
    };
    void verify();
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [worktree, environment, cell.dataset]);

  useEffect(() => {
    if (stopped.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    setError("");
    const load = async () => {
      let path = request.prefix;
      let query = request.query;
      const seen = new Set(path.map((step) => identity(step.query)));
      try {
        // Follow only unambiguous inputs. Branches always remain the user's choice.
        for (let count = 0; count < 20; count++) {
          const result = await api<Explanation>(
            `/worktrees/${worktree}/lineage`,
            {
              ...send({ ...query, environment }),
              signal: abort.signal,
            },
          );
          if (abort.signal.aborted || stopped.current) return;
          const step: Step = {
            query,
            result: result.complete
              ? (request.replace?.result ?? result)
              : result,
            page: result,
            context: request.context,
          };
          path = [...path, step];
          setSteps(path);
          setActive(path.length - 1);
          seen.add(identity(query));
          const input = result.contributions[0];
          if (
            request.replace ||
            !result.complete ||
            result.kind === "source" ||
            result.total !== 1 ||
            !input ||
            result.groups ||
            seen.has(identity(input))
          )
            break;
          query = {
            dataset: input.dataset,
            row: input.row,
            column: input.column,
            node: input.node,
          };
        }
      } catch (e) {
        if (!abort.signal.aborted && !stopped.current)
          setError((e as Error).message);
      } finally {
        if (!abort.signal.aborted && !stopped.current) setPending(false);
      }
    };
    void load();
    return () => abort.abort();
  }, [worktree, environment, request]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (active > 0) setActive(active - 1);
      else setPlaying(false);
    }, 1800);
    return () => clearTimeout(timer);
  }, [playing, active]);

  useEffect(() => {
    const body = timelineBody.current;
    const card = activeCard.current;
    if (!body || !card || pending) return;
    // Scroll only the timeline; scrollIntoView can also move the fixed inspector header.
    const top =
      card.getBoundingClientRect().top -
      body.getBoundingClientRect().top +
      body.scrollTop;
    const visibleHeight =
      card.offsetHeight <= body.clientHeight
        ? card.offsetHeight
        : card.querySelector("button")!.offsetHeight;
    const bottom = top + visibleHeight;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (bottom > body.scrollTop + body.clientHeight)
      body.scrollTop = bottom - body.clientHeight;
  }, [playing, active, pending]);

  const root = steps[0]?.result;
  const selected = steps[active];
  const disabled = pending || interrupted;
  const select = (index: number) => {
    setPlaying(false);
    setActive(index);
  };
  const follow = (input: Input) => {
    setPlaying(false);
    setPending(true);
    const prefix = steps.slice(0, active + 1);
    setSteps(prefix);
    setRequest({
      prefix,
      query: {
        dataset: input.dataset,
        row: input.row,
        column: input.column,
        node: input.node,
      },
      context: selected.context || !!selected.query.context,
    });
  };
  const changePage = (values: Partial<Query>) => {
    setPlaying(false);
    setPending(true);
    const prefix = steps.slice(0, active);
    setRequest({
      prefix,
      query: { ...selected.query, ...values },
      replace: selected,
      context: selected.context,
    });
  };
  const operation = (result: Explanation) =>
    t(
      !result.complete
        ? "partial"
        : operationKeys[result.kind || ""] || "lineageCalculation",
    );

  return (
    <aside className="inspector lineage-panel" aria-label={t("lineage")}>
      <div className="inspector-title">
        <span className="row gap">
          <GitBranch size={18} />
          {t("lineage")}
        </span>
        <button
          className="icon"
          title={t("close")}
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="lineage-overview">
        <p className="lineage-intro">{t("lineageIntro")}</p>
        {root && (
          <div className="value-card lineage-result">
            <span className="eyebrow">{t("lineageSelectedValue")}</span>
            <strong>{formatValue(root.value)}</strong>
            <span>
              {root.column}{" "}
              <span className="muted">
                · {t("lineageRow")} {root.row + 1}
              </span>
            </span>
          </div>
        )}
        {!interrupted && steps.length > 1 && (
          <div className="lineage-playback">
            <button
              className="button secondary small"
              disabled={disabled || !!error}
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  if (active === 0) setActive(steps.length - 1);
                  setPlaying(true);
                }
              }}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {t(playing ? "lineagePause" : "lineagePlay")}
            </button>
            <span className="muted small" role="status">
              {t("lineageStep")} {steps.length - active} / {steps.length}
            </span>
            <p>{t("lineagePlaybackHint")}</p>
          </div>
        )}
      </div>
      <div className="lineage-body" ref={timelineBody}>
        {interrupted ? (
          <div className="notice warning" role="alert">
            {t("lineageInterrupted")}
          </div>
        ) : (
          <>
            <ol
              className={`lineage-timeline ${playing ? "is-playing" : ""}`}
              aria-label={t("lineageTimeline")}
            >
              {steps.map((step, index) => {
                const result = step.result;
                const page = step.page;
                const expanded = active === index;
                const source = result.kind === "source";
                const context = !!step.query.context;
                const offset = step.query.offset || 0;
                const location =
                  step.query.node ||
                  (source ? result.contributions[0]?.node : undefined);
                return (
                  <li
                    key={identity(step.query) + index}
                    ref={expanded ? activeCard : undefined}
                    className={`lineage-step ${expanded ? "is-active" : ""} ${source ? "is-source" : ""}`}
                  >
                    <button
                      className="lineage-step-heading"
                      disabled={disabled}
                      aria-expanded={expanded}
                      aria-current={expanded ? "step" : undefined}
                      onClick={() => select(index)}
                    >
                      <span className="lineage-marker">
                        {source ? <Database size={13} /> : index + 1}
                      </span>
                      <span className="lineage-step-label">
                        <span className="lineage-operation">
                          {operation(result)}
                        </span>
                        <strong>{result.column}</strong>
                      </span>
                      <span
                        className="lineage-step-value"
                        title={formatValue(result.value)}
                      >
                        {formatValue(result.value)}
                      </span>
                    </button>
                    {expanded && (
                      <div className="lineage-step-detail">
                        <p className="lineage-location">
                          {location && `${location.split("::").at(-1)} · `}
                          {t("lineageRow")} {result.row + 1}
                        </p>
                        {step.context && (
                          <p className="notice warning">
                            {t("lineageContextPath")}
                          </p>
                        )}
                        {result.warnings.map((warning) => (
                          <p className="notice warning" key={warning}>
                            <AlertTriangle size={14} /> {warning}
                          </p>
                        ))}
                        {source ? (
                          <p className="lineage-source-note">
                            <Database size={15} />
                            {t("lineageSourceHint")}
                          </p>
                        ) : (
                          <>
                            <p className="lineage-explanation">
                              {t(
                                !result.complete
                                  ? "lineageLimitedHint"
                                  : operationKeys[result.kind || ""]
                                    ? `${operationKeys[result.kind!]}Hint`
                                    : "lineageCalculationHint",
                              )}
                            </p>
                            {result.expression && (
                              <details className="lineage-formula">
                                <summary>{t("lineageFormula")}</summary>
                                <pre className="expression">
                                  {result.expression}
                                </pre>
                              </details>
                            )}
                            {!!result.context_total && (
                              <button
                                className="text-button lineage-context-toggle"
                                disabled={disabled}
                                onClick={() =>
                                  changePage({
                                    context: !context,
                                    group: undefined,
                                    offset: 0,
                                  })
                                }
                              >
                                {t(
                                  context
                                    ? "showContributors"
                                    : "lineageShowContext",
                                )}{" "}
                                <span>({result.context_total})</span>
                              </button>
                            )}
                            {context && (
                              <p className="notice warning">
                                {t("lineageContextHint")}
                              </p>
                            )}
                            {step.query.group !== undefined && (
                              <button
                                className="text-button small"
                                disabled={disabled}
                                onClick={() =>
                                  changePage({ group: undefined, offset: 0 })
                                }
                              >
                                <ChevronLeft size={14} />
                                {t("lineageAllGroups")}
                              </button>
                            )}
                            {page.total > 0 && (
                              <div className="lineage-input-heading">
                                <strong>
                                  {page.total.toLocaleString()}{" "}
                                  {t(
                                    context
                                      ? "lineageContextValues"
                                      : page.groups
                                        ? "valueGroups"
                                        : "contributions",
                                  )}
                                </strong>
                                <p>
                                  {t(
                                    page.groups
                                      ? "lineageChooseGroup"
                                      : "lineageChooseInput",
                                  )}
                                </p>
                              </div>
                            )}
                            {page.groups?.map((group) => (
                              <button
                                key={group.key}
                                className="contribution"
                                disabled={disabled}
                                onClick={() =>
                                  changePage({ group: group.key, offset: 0 })
                                }
                              >
                                <span className="contribution-value">
                                  {formatValue(group.value)}
                                </span>
                                <span>
                                  {group.rows} {t("inputRows")}
                                </span>
                                <ChevronRight size={14} />
                              </button>
                            ))}
                            {page.contributions.map((input, i) => (
                              <button
                                key={identity(input) + i}
                                className="contribution"
                                disabled={disabled}
                                onClick={() => follow(input)}
                              >
                                <span
                                  className="contribution-value"
                                  title={formatValue(input.value)}
                                >
                                  {formatValue(input.value)}
                                </span>
                                <span>
                                  <strong>{input.column}</strong>
                                  <small>
                                    {input.node.split("::").at(-1)} ·{" "}
                                    {t("lineageRow")} {input.row + 1}
                                  </small>
                                </span>
                                <ChevronRight size={14} />
                              </button>
                            ))}
                            {page.total > page.page_size && (
                              <div className="row spread pager">
                                <button
                                  className="button secondary small"
                                  disabled={disabled || !offset}
                                  onClick={() =>
                                    changePage({
                                      offset: Math.max(
                                        0,
                                        offset - page.page_size,
                                      ),
                                    })
                                  }
                                >
                                  <ChevronLeft size={14} />
                                  {t("previous")}
                                </button>
                                <span className="muted small">
                                  {Math.min(
                                    offset + page.page_size,
                                    page.total,
                                  )}{" "}
                                  / {page.total}
                                </span>
                                <button
                                  className="button secondary small"
                                  disabled={
                                    disabled ||
                                    offset + page.page_size >= page.total
                                  }
                                  onClick={() =>
                                    changePage({
                                      offset: offset + page.page_size,
                                    })
                                  }
                                >
                                  {t("next")}
                                  <ChevronRight size={14} />
                                </button>
                              </div>
                            )}
                            {page.complete && page.total === 0 && (
                              <p className="muted small">
                                {t(
                                  context
                                    ? "lineageNoContext"
                                    : "lineageNoInputs",
                                )}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {index < steps.length - 1 && (
                      <span className="lineage-connector" aria-hidden="true">
                        <ArrowUp size={12} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            {pending && (
              <div className="lineage-loading" role="status">
                <Loader2 className="spin" size={16} />
                {t("lineageLoading")}
              </div>
            )}
            {error && (
              <div className="notice error" role="alert">
                {error}
                <button
                  className="text-button"
                  onClick={() => setRequest({ ...request })}
                >
                  {t("retry")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
