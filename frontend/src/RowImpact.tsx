import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, send, withQuery } from "./api";
import { formatValue } from "./graph";
import { useT } from "./i18n";
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
  const verdict = data
    ? [
        ...data.stops.map((id) => {
          const s = byId.get(id)!;
          return t("rowImpactStops")
            .replace(
              "{node}",
              displayNodeName(snapshot.node_names?.[s.node], s.node, t),
            )
            .replace("{reason}", s.reason ? reason(s.reason) : "");
        }),
        ...(data.reached.length
          ? [
              t("rowImpactReaches").replace(
                "{nodes}",
                [
                  ...new Set(
                    data.reached.map((id) => name(byId.get(id)!.node)),
                  ),
                ].join(", "),
              ),
            ]
          : []),
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
  const destinations = (id: string): string[] => {
    const step = byId.get(id)!;
    return step.children.length
      ? step.children.flatMap(destinations)
      : [name(step.node)];
  };
  const depth = (id: string): number =>
    1 + Math.max(0, ...byId.get(id)!.children.map(depth));
  const pathSummary = (id: string) => {
    let current: RowImpactStep | undefined = byId.get(id);
    let count = 0;
    while (current) {
      if (current.state === "discarded")
        return t(
          count === 1 ? "rowImpactStopsAfterOne" : "rowImpactStopsAfter",
        ).replace("{count}", String(count));
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
          </header>
          {step.port && <small className="muted">{step.port}</small>}
          {step.reason && (
            <div className="row-impact-reason">
              <code>{step.reason.condition}</code>
              <p>{reason(step.reason)}</p>
            </div>
          )}
          {step.conditions
            ?.filter((r) => r !== null)
            .map((r, i) => (
              <p className="small" key={i}>
                <code>{r!.condition}</code>
                <br />
                <code>{r!.evaluated}</code>
              </p>
            ))}
          {step.other_rows !== undefined && (
            <p>
              {t("rowImpactOtherRows").replace(
                "{count}",
                String(step.other_rows),
              )}
            </p>
          )}
          {step.group?.map((g) => (
            <code key={g.expression}>
              {g.expression} = {formatValue(g.value)}{" "}
            </code>
          ))}
          {step.destinations?.map((d) => (
            <code key={d}>{d}</code>
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
        {step.children.map((child, i) =>
          i === 0 ? (
            render(child, components)
          ) : (
            <details
              className="lineage-branch"
              key={child}
              open={depth(child) <= 3}
            >
              <summary>
                {t("rowImpactTowards").replace(
                  "{nodes}",
                  [...new Set(destinations(child))].join(", "),
                )}
              </summary>
              {render(child, components)}
            </details>
          ),
        )}
      </Fragment>
    );
  };
  return (
    <div className="row-impact">
      <p className={`notice ${data.stops.length ? "error" : ""}`}>{verdict}</p>
      {pending && <span role="status">{t("lineageLoading")}</span>}
      {data.roots.map((root) => (
        <section key={root}>
          <h3>
            {t("rowImpactTowards").replace(
              "{nodes}",
              [...new Set(destinations(root))].join(", "),
            )}
          </h3>
          <p className="small muted">{pathSummary(root)}</p>
          {render(root)}
        </section>
      ))}
    </div>
  );
}
