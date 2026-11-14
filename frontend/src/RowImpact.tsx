import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  CircleCheck,
  FileOutput,
  Group,
  Loader2,
  Split,
  X,
} from "lucide-react";
import { api, send, withQuery } from "./api";
import { formatValue } from "./graph";
import { countLabel, useT } from "./i18n";
import {
  ComponentHeading,
  componentPaths,
  type LineageMap,
} from "./LineageSteps";
import type { LineageTarget } from "./lineageGraph";
import { displayNodeName } from "./nodeNames";
import { useResource } from "./useApiResource";
import { usePolling } from "./usePolling";
import { useLoadedWorktree } from "./worktree";

type State =
  | "kept"
  | "discarded"
  | "grouped"
  | "duplicated"
  | "written"
  | "unreached"
  | "unknown";
type Reason = {
  kind: string;
  condition: string;
  evaluated: string;
  result: boolean | null;
  missing_node?: string;
  missing_port?: string;
};
export type RowImpactStep = {
  id: string;
  node: string;
  name: string;
  port?: string;
  state: State;
  children: string[];
  row?: number;
  total?: number;
  offset?: number;
  next_offset?: number | null;
  columns?: string[];
  rows?: { row: number; values: unknown[] }[];
  other_rows?: number;
  group?: { expression: string; value: unknown }[];
  reason?: Reason;
  conditions?: (Reason | null)[];
  warning?: string;
  destinations?: string[];
};
export type RowImpactResult = {
  node: string;
  roots: string[];
  steps: RowImpactStep[];
  stops: string[];
  reached: string[];
  complete: boolean;
  execution?: string;
  commit?: string;
  verdict: string;
};
const labels = {
  kept: "rowImpactKept",
  discarded: "rowImpactDiscarded",
  grouped: "rowImpactGrouped",
  duplicated: "rowImpactDuplicated",
  written: "rowImpactWritten",
  unreached: "rowImpactUnreached",
  unknown: "rowImpactUnknown",
} as const;
const marks = {
  kept: <Check />,
  discarded: <X />,
  grouped: <Group />,
  duplicated: <Split />,
  written: <FileOutput />,
  unreached: null,
  unknown: null,
} as const;
const anchor = (id: string) => `row-impact-${encodeURIComponent(id)}`;

export function RowImpact({
  target,
  onMap,
  onHover,
  onOpen,
  onText,
}: {
  target: LineageTarget;
  onMap: (map: LineageMap | null) => void;
  onHover: (node: string | null) => void;
  onOpen: (node: string) => void;
  onText: (text: string) => void;
}) {
  const t = useT();
  const { id, environment, snapshot, statuses, starting } = useLoadedWorktree();
  const cell = target.cell!;
  const [originalRevision] = useState(snapshot.revision);
  const [interrupted, setInterrupted] = useState(false);
  const invalid =
    interrupted ||
    !!statuses.active ||
    starting ||
    snapshot.revision !== originalRevision;
  if (invalid && !interrupted) setInterrupted(true);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const key = JSON.stringify([
    id,
    environment,
    cell.dataset,
    cell.row,
    choices,
    offsets,
  ]);
  const { data, error, pending } = useResource<RowImpactResult>(
    invalid ? null : key,
    (signal) =>
      api(`/worktrees/${id}/lineage/row-impact`, {
        ...send({
          environment,
          dataset: cell.dataset,
          row: cell.row,
          choices,
          offsets,
        }),
        signal,
      }),
  );
  usePolling(
    useCallback(
      async (signal: AbortSignal) => {
        const result = await api<{ valid: boolean }>(
          withQuery(`/worktrees/${id}/generations/${cell.dataset}`, {
            environment,
          }),
          { signal },
        );
        if (!signal.aborted && !result.valid) setInterrupted(true);
      },
      [id, environment, cell.dataset],
    ),
    { interval: 2000, enabled: !invalid && !error },
  );
  const name = (node: string) =>
    displayNodeName(snapshot.node_names?.[node]?.slice(-1), node, t);
  const byId = new Map(data?.steps.map((s) => [s.id, s]));
  const reason = (r: Reason) =>
    r.kind === "join" && r.missing_node
      ? t("rowImpactMissingJoin")
          .replace("{input}", `${name(r.missing_node)} · ${r.missing_port}`)
          .replace("{key}", r.evaluated)
      : t(r.kind === "having" ? "rowImpactHaving" : "rowImpactFalse")
          .replace("{condition}", r.evaluated)
          .replace("{result}", r.result === null ? "NULL" : "false");
  const reaches = (ids: string[]) =>
    ids.length
      ? [
          t("rowImpactReaches").replace(
            "{nodes}",
            [...new Set(ids.map((id) => name(byId.get(id)!.node)))].join(", "),
          ),
        ]
      : [];
  // A row written to an export leads with the outputs it reaches; side-branch filters follow.
  const written = !!data?.reached.some(
    (id) => byId.get(id)?.state === "written",
  );
  const verdict = data
    ? [
        ...(written ? reaches(data.reached) : []),
        ...data.stops.map((id) => {
          const s = byId.get(id)!;
          return t("rowImpactStops")
            .replace(
              "{node}",
              displayNodeName(snapshot.node_names?.[s.node], s.node, t),
            )
            .replace("{reason}", s.reason ? reason(s.reason) : "");
        }),
        ...(written ? [] : reaches(data.reached)),
        ...new Set(
          data.steps
            .filter((s) => s.state === "unknown")
            .map((s) => `${name(s.node)}: ${t("rowImpactUnknown")}.`),
        ),
        ...(!data.roots.length ? [t("rowImpactNoConsumers")] : []),
      ].join(" ")
    : "";
  const map = useMemo(() => {
    if (!data || invalid || error) return null;
    const result: LineageMap = {
      [data.node]: { value: t("rowImpactKept"), state: "kept" },
    };
    const priority = {
      unreached: 0,
      unknown: 1,
      kept: 2,
      grouped: 2,
      duplicated: 2,
      written: 2,
      discarded: 3,
    };
    for (const step of data.steps) {
      const previous = result[step.node]?.state;
      if (!previous || priority[step.state] > priority[previous])
        result[step.node] = {
          state: step.state,
          value: `${step.state === "discarded" ? "× " : ""}${t(labels[step.state])}`,
        };
    }
    return result;
  }, [data, invalid, error, t]);
  useEffect(() => {
    onMap(map);
    return () => onMap(null);
  }, [map, onMap]);
  useEffect(() => {
    onText(
      data && !invalid
        ? [
            `Run: ${data.execution || ""}\nCommit: ${data.commit || ""}\nEnvironment: ${environment}`,
            verdict,
            ...data.steps.map((s) =>
              [
                s.name,
                t(labels[s.state]),
                s.reason?.condition,
                s.reason?.evaluated,
                s.warning,
                s.destinations?.join(", "),
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ].join("\n\n")
        : "",
    );
  }, [data, invalid, environment, verdict, onText, t]);
  if (invalid)
    return (
      <div className="notice warning" role="alert">
        {t("lineageInterrupted")}
      </div>
    );
  if (error)
    return (
      <div className="notice error" role="alert">
        {error}
      </div>
    );
  if (!data)
    return (
      <div role="status">
        <Loader2 size={16} className="spin" />
        {t("lineageLoading")}
      </div>
    );
  const seen = new Set<string>();
  /** Where a path leads when each node keeps its first consumer. */
  const end = (id: string): string => {
    const step = byId.get(id)!;
    return step.children.length
      ? end(step.children[0])
      : [name(step.node), step.port].filter(Boolean).join(" · ");
  };
  const depth = (id: string): number =>
    1 + Math.max(0, ...byId.get(id)!.children.map(depth));
  const pathSummary = (id: string) => {
    let current: RowImpactStep | undefined = byId.get(id);
    let count = 0;
    while (current) {
      if (current.state === "unreached") return t("rowImpactUnreached");
      if (current.state === "discarded")
        return count
          ? countLabel(
              t,
              count,
              "rowImpactStopsAfterOne",
              "rowImpactStopsAfter",
            )
          : t("rowImpactDiscarded");
      if (current.state === "unknown") return t("rowImpactUnknown");
      count += 1;
      current = byId.get(current.children[0]);
    }
    return t("rowImpactReached");
  };
  const render = (id: string, previous: string[] = []): React.ReactNode => {
    const step = byId.get(id)!;
    if (seen.has(id))
      return (
        <a className="lineage-reference" href={`#${anchor(id)}`}>
          {name(step.node)} ↗
        </a>
      );
    seen.add(id);
    const components = componentPaths(step.node);
    // The first consumer continues the path; the others branch off under this step.
    // The path is read first, so a node reached twice stays on it.
    const [next, ...others] = step.children;
    const rest = next === undefined ? null : render(next, components);
    return (
      <Fragment key={id}>
        {components
          .filter((c) => !previous.includes(c))
          .map((c) => (
            <ComponentHeading key={c} node={c} onOpen={onOpen} />
          ))}
        <article
          id={anchor(id)}
          className={`lineage-step row-impact-step row-impact-${step.state}`}
          onMouseEnter={() => onHover(step.node)}
          onMouseLeave={() => onHover(null)}
        >
          <span className="lineage-dot" aria-hidden="true">
            {marks[step.state]}
          </span>
          <header>
            <button
              className="text-button"
              onClick={() => onOpen(step.node)}
              onFocus={() => onHover(step.node)}
              onBlur={() => onHover(null)}
            >
              {name(step.node)}
            </button>
            <span className="row-impact-state">
              {step.state === "discarded" ? "× " : ""}
              {t(labels[step.state])}
            </span>
            {step.row !== undefined && (
              <small>
                {t("lineageRow")} {step.row + 1}
              </small>
            )}
            {step.port && <span className="row-impact-port">{step.port}</span>}
          </header>
          {step.reason && (
            <div className="row-impact-reason">
              <code>{step.reason.condition}</code>
              <p>{reason(step.reason)}</p>
            </div>
          )}
          {step.conditions
            ?.filter((r) => r !== null)
            .map((r, i) => (
              <span className="row-impact-detail" key={i}>
                <code>{r!.condition}</code>
                <code className="evaluated">
                  <ArrowRight size={10} aria-hidden="true" />
                  {r!.evaluated}
                </code>
              </span>
            ))}
          {step.other_rows !== undefined && (
            <p>
              {countLabel(
                t,
                step.other_rows,
                "rowImpactOtherRow",
                "rowImpactOtherRows",
              )}
            </p>
          )}
          {step.group?.map((g) => (
            <span className="row-impact-detail" key={g.expression}>
              <code>
                {g.expression} = {formatValue(g.value)}
              </code>
            </span>
          ))}
          {step.destinations?.map((d) => (
            <span className="row-impact-detail" key={d}>
              <code>{d}</code>
            </span>
          ))}
          {step.warning && step.state === "unknown" && (
            <p className="notice warning">{step.warning}</p>
          )}
          {(step.total || 0) > 1 && (
            <div className="row-impact-rows">
              <p>
                {t("rowImpactChoose").replace("{count}", String(step.total))}
              </p>
              {step.rows?.map((r) => (
                <button
                  key={r.row}
                  className="lineage-value"
                  disabled={pending}
                  aria-pressed={step.row === r.row}
                  onClick={() => setChoices((c) => ({ ...c, [id]: r.row }))}
                >
                  {t("lineageRow")} {r.row + 1} ·{" "}
                  {r.values
                    .map((v, i) => `${step.columns?.[i]} = ${formatValue(v)}`)
                    .join(" · ")}
                </button>
              ))}
              <div className="row-impact-pages">
                {!!step.offset && (
                  <button
                    className="text-button"
                    disabled={pending}
                    onClick={() =>
                      setOffsets((c) => ({
                        ...c,
                        [id]: Math.max(0, step.offset! - 5),
                      }))
                    }
                  >
                    {t("previous")}
                  </button>
                )}
                {step.next_offset != null && (
                  <button
                    className="text-button"
                    disabled={pending}
                    onClick={() =>
                      setOffsets((c) => ({ ...c, [id]: step.next_offset! }))
                    }
                  >
                    {t("lineageMore").replace(
                      "{count}",
                      String(step.total! - step.next_offset),
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
        </article>
        {others.map((child) => (
          <details
            className="lineage-branch"
            key={child}
            // What the row never reaches, or cannot be followed into, stays one line.
            open={
              depth(child) <= 3 &&
              !["unreached", "unknown"].includes(byId.get(child)!.state)
            }
          >
            <summary>
              <span>
                {t("rowImpactTowards").replace("{nodes}", end(child))}
              </span>
              <span className="muted">{pathSummary(child)}</span>
            </summary>
            {render(child, components)}
          </details>
        ))}
        {rest}
      </Fragment>
    );
  };
  const stops = !!data.stops.length && !written;
  return (
    <div className="row-impact">
      <p className={`row-impact-verdict ${stops ? "stops" : ""}`}>
        {stops ? <CircleAlert size={15} /> : <CircleCheck size={15} />}
        <span>{verdict}</span>
      </p>
      {pending && <span role="status">{t("lineageLoading")}</span>}
      {data.roots.map((root) => (
        <section key={root}>
          <h3>
            {t("rowImpactTowards").replace("{nodes}", end(root))}
            <small>{pathSummary(root)}</small>
          </h3>
          {render(root)}
        </section>
      ))}
    </div>
  );
}
