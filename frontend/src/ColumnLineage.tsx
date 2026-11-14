import { Check, ChevronRight, Filter, Loader2 } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { moveMenuFocus } from "./ActionMenu";
import { withQuery } from "./api";
import { countLabel, useT } from "./i18n";
import type { LineageTarget, TableLineage } from "./lineageGraph";
import {
  ComponentHeading,
  componentPaths,
  Resource,
  StepDot,
  type LineageMap,
} from "./LineageSteps";
import { displayNodeName } from "./nodeNames";
import { useApiResource } from "./useApiResource";
import { useLoadedWorktree } from "./worktree";

type Reference = { id: string; node: string; port: string; column: string };
type Status = "complete" | "incomplete" | "needs_run" | "python";
type Kind = "computed" | "carried" | "source";
type Origin = Reference & { kind: Kind; status: Status };
type Column = {
  id: string;
  name: string;
  type: string;
  kind: Kind;
  status: Status;
  origin: Origin;
};
type Step = Reference & {
  type: string;
  kind: Kind;
  status: Status;
  expression: string | null;
  inputs: Reference[];
  selection: { kind: string; expression: string; inputs: Reference[] }[];
  tables: { node: string; port: string }[];
  description: string;
  run_nodes: string[];
};
export type ColumnOrigins = {
  outputs: {
    port: string;
    columns: Column[];
    status: Status;
    run_nodes: string[];
    tables: { node: string; port: string }[];
  }[];
  root?: string | null;
  steps?: Step[];
  complete?: boolean;
};

export function useColumnOrigins(target: LineageTarget) {
  const { id, environment, snapshot, statuses } = useLoadedWorktree();
  return useApiResource<ColumnOrigins>(
    withQuery(`/worktrees/${id}/lineage/columns`, {
      node: target.node,
      port: target.port,
      column: target.column,
      environment,
    }),
    {
      refresh: JSON.stringify([
        snapshot.revision,
        statuses.nodes?.[target.node]?.outputs,
      ]),
    },
  );
}

/** Where a column of the output comes from, in a few words. */
function ColumnOrigin({ column }: { column: Column }) {
  const t = useT();
  const { snapshot } = useLoadedWorktree();
  const name = (node: string) =>
    displayNodeName(snapshot.node_names?.[node]?.slice(-1), node, t);
  return (
    <span className="muted small">
      {column.status !== "complete"
        ? t(
            column.status === "python"
              ? "lineageColumnPython"
              : "lineageColumnIncomplete",
          )
        : column.kind === "computed"
          ? t("lineageComputedHere")
          : column.origin.kind === "source"
            ? t("lineageCarriedFrom").replace(
                "{source}",
                `${name(column.origin.node)} · ${column.origin.column}`,
              )
            : t("lineageComputedIn").replace(
                "{node}",
                name(column.origin.node),
              )}
    </span>
  );
}

/** The columns of the traced output, listed under the breadcrumb level which names one. */
export function ColumnMenu({
  target,
  anchor,
  onChoose,
  onClose,
}: {
  target: LineageTarget;
  anchor: RefObject<HTMLButtonElement | null>;
  onChoose: (port: string, column: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  const { data, error } = useColumnOrigins({
    node: target.node,
    port: target.port,
    direction: target.direction,
  });
  const columns = data?.outputs.flatMap((output) =>
    output.columns.map((column) => ({ port: output.port, column })),
  );
  const chosen = (port: string, column: Column) =>
    column.name === target.column && (!target.port || port === target.port);
  // One item stays in the tab order: the list scrolls, and keys must reach it.
  const start = (
    columns?.find((item) => chosen(item.port, item.column)) || columns?.[0]
  )?.column.id;
  const loaded = !!data;
  useEffect(() => {
    (
      menu.current?.querySelector<HTMLElement>('button[tabindex="0"]') ||
      menu.current
    )?.focus();
  }, [loaded]);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const outside = (event: Event) => {
      const element = event.target as Node;
      if (
        !menu.current?.contains(element) &&
        !anchor.current?.contains(element)
      )
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchor]);
  return (
    <div
      ref={menu}
      className="lineage-column-menu"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // The panel closes on Escape: this one only closes the list.
          event.preventDefault();
          event.stopPropagation();
          anchor.current?.focus();
          onClose();
        } else if (event.key === "Tab") onClose();
        moveMenuFocus(event, [
          ...menu.current!.querySelectorAll<HTMLElement>("button"),
        ]);
      }}
    >
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <div role="status">
          <Loader2 className="spin" size={16} />
          {t("loading")}
        </div>
      )}
      {data?.outputs.map((output) => (
        <div key={output.port}>
          {data.outputs.length > 1 && (
            <div className="lineage-column-menu-port" aria-hidden="true">
              {output.port}
            </div>
          )}
          <Limit
            status={output.status}
            nodes={output.run_nodes}
            tables={output.tables}
          />
          {!!output.columns.length && (
            <div
              role="menu"
              aria-label={
                data.outputs.length > 1
                  ? `${t("lineageChooseColumn")}: ${output.port}`
                  : t("lineageChooseColumn")
              }
            >
              {output.columns.map((column) => (
                <button
                  className="lineage-column-link"
                  role="menuitemradio"
                  aria-checked={chosen(output.port, column)}
                  tabIndex={column.id === start ? 0 : -1}
                  key={column.id}
                  onClick={() => {
                    anchor.current?.focus();
                    onChoose(output.port, column.name);
                  }}
                >
                  <strong>{column.name}</strong>
                  <ColumnOrigin column={column} />
                  {chosen(output.port, column) && (
                    <Check size={13} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ColumnList({
  target,
  onChange,
}: {
  target: LineageTarget;
  onChange: (target: LineageTarget) => void;
}) {
  const t = useT();
  const { data, error } = useColumnOrigins(target);
  return (
    <section className="lineage-columns" aria-label={t("columns")}>
      <h3>{t("columns")}</h3>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <Loader2 className="spin" size={16} />}
      {data?.outputs.map((output) => (
        <div key={output.port}>
          {data.outputs.length > 1 && <h4>{output.port}</h4>}
          <Limit
            status={output.status}
            nodes={output.run_nodes}
            tables={output.tables}
          />
          <div className="lineage-column-list">
            {output.columns.map((column) => (
              <button
                className="lineage-column-link"
                key={column.id}
                onClick={() =>
                  onChange({
                    node: target.node,
                    port: output.port,
                    column: column.name,
                    direction: target.direction,
                  })
                }
              >
                <strong>{column.name}</strong>
                <ColumnOrigin column={column} />
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function Limit({
  status,
  nodes,
  tables = [],
}: {
  status: Status;
  nodes: string[];
  tables?: { node: string; port: string }[];
}) {
  const t = useT();
  const { snapshot } = useLoadedWorktree();
  if (status === "complete") return null;
  return (
    <p className="notice warning" role="status">
      {t(
        status === "python"
          ? "lineageColumnPython"
          : status === "needs_run"
            ? "lineageColumnRun"
            : "lineageColumnIncomplete",
      ).replace(
        "{nodes}",
        nodes
          .map((node) => displayNodeName(snapshot.node_names?.[node], node, t))
          .join(", "),
      )}
      {!!tables.length && (
        <span>
          {" "}
          {t("inputs")}:{" "}
          {tables
            .map(
              (table) =>
                `${displayNodeName(snapshot.node_names?.[table.node], table.node, t)} · ${table.port}`,
            )
            .join(", ")}
        </span>
      )}
    </p>
  );
}

export function ColumnLineage({
  target,
  tables,
  onMap,
  onHover,
  onOpen,
}: {
  target: LineageTarget;
  tables: TableLineage;
  onMap: (map: LineageMap | null) => void;
  onHover: (node: string | null) => void;
  onOpen: (node: string) => void;
}) {
  const t = useT();
  const { snapshot } = useLoadedWorktree();
  const { data, error } = useColumnOrigins(target);
  const name = (node: string) =>
    displayNodeName(snapshot.node_names?.[node]?.slice(-1), node, t);
  const steps = data?.steps || [];
  const map = useMemo(() => {
    const result: LineageMap = {};
    for (const step of data?.steps || []) {
      const label = `${step.kind === "computed" && step.status === "complete" ? "ƒ " : ""}${step.column}`;
      result[step.node] = {
        value: result[step.node]
          ? `${result[step.node].value}, ${label}`
          : label,
      };
    }
    return result;
  }, [data]);
  useEffect(() => {
    onMap(error ? null : map);
    return () => onMap(null);
  }, [map, error, onMap]);
  const entries = new Map(steps.map((step) => [step.id, step]));
  const seen = new Map<string, string>();
  const anchor = (id: string) => `column-${encodeURIComponent(id)}`;
  const depth = (id: string, ancestors = new Set<string>()): number => {
    if (ancestors.has(id) || ancestors.size > 3) return 0;
    const step = entries.get(id);
    return step
      ? 1 +
          Math.max(
            0,
            ...step.inputs.map((input) =>
              depth(input.id, new Set([...ancestors, id])),
            ),
          )
      : 0;
  };
  const sources = (id: string, visited = new Set<string>()): string[] => {
    if (visited.has(id)) return [];
    visited.add(id);
    const step = entries.get(id);
    if (!step) return [];
    return step.kind === "source"
      ? [`${name(step.node)} · ${step.column}`]
      : step.inputs.flatMap((input) => sources(input.id, visited));
  };
  const render = (id: string, previous: string[] = []): React.ReactNode => {
    const step = entries.get(id);
    if (!step) return null;
    if (seen.has(id))
      return (
        <a className="lineage-reference" href={`#${anchor(seen.get(id)!)}`}>
          {name(step.node)} · {step.column} ↗
        </a>
      );
    const group = steps.filter((item) => item.node === step.node);
    group.forEach((item) => seen.set(item.id, id));
    const children = [
      ...new Map(
        group
          .flatMap((item) => item.inputs)
          .filter((input) => input.node !== step.node)
          .map((input) => [input.id, input]),
      ).values(),
    ];
    const components = componentPaths(step.node);
    return (
      <div className="lineage-chain" key={id}>
        {components
          .filter((c) => !previous.includes(c))
          .map((c) => (
            <ComponentHeading key={c} node={c} onOpen={onOpen} />
          ))}
        <article
          id={anchor(id)}
          className={`lineage-step ${step.kind === "source" ? "is-source" : "calculation"} ${group.every((item) => item.kind === "carried") ? "unchanged" : ""} ${components.length ? "in-component" : ""}`}
          onMouseEnter={() => onHover(step.node)}
          onMouseLeave={() => onHover(null)}
        >
          <StepDot
            kind={
              step.kind === "source"
                ? "source"
                : group.every((item) => item.kind === "carried")
                  ? "carried"
                  : "computed"
            }
          />
          <header>
            <button
              className="text-button"
              onFocus={() => onHover(step.node)}
              onBlur={() => onHover(null)}
              onClick={() => onOpen(step.node)}
            >
              {name(step.node)}
            </button>
          </header>
          {group.map((item) => (
            <div key={item.id} className="lineage-column-item">
              <Limit status={item.status} nodes={item.run_nodes} />
              {item.status === "python" && (
                <p className="muted small">
                  {t("inputs")}:{" "}
                  {item.tables
                    .map((table) => `${name(table.node)} · ${table.port}`)
                    .join(", ")}
                </p>
              )}
              <div className="lineage-column-expression">
                <strong>{item.column}</strong>
                {item.kind === "source" ? (
                  <>
                    {" "}
                    <code className="type">{item.type}</code>
                  </>
                ) : item.kind === "carried" ? (
                  <span className="lineage-unchanged-label">
                    {" "}
                    {item.inputs[0]?.column === item.column
                      ? t("lineageUnchanged")
                      : `← ${item.inputs[0]?.column}`}
                  </span>
                ) : (
                  item.expression && (
                    <>
                      {" "}
                      <span className="equals">=</span>{" "}
                      <code>{item.expression}</code>
                    </>
                  )
                )}
              </div>
              {item.kind === "source" && (
                <>
                  <p className="lineage-source-location">
                    <Resource node={item.node} tables={tables} />
                  </p>
                  {item.description && (
                    <p className="lineage-column-description">
                      {item.description}
                    </p>
                  )}
                </>
              )}
              {!!item.inputs.length && item.kind === "computed" && (
                <p className="lineage-column-inputs">
                  {item.inputs
                    .map((input) => `${name(input.node)} · ${input.column}`)
                    .join(" + ")}
                </p>
              )}
              {item.selection.map((selection, index) => (
                <details className="lineage-column-condition" key={index}>
                  <summary>
                    <Filter size={11} aria-hidden="true" />
                    <code>{selection.expression}</code>
                  </summary>
                  <span className="muted small">
                    {t("lineageRowsDependOn")}:{" "}
                    {selection.inputs
                      .map((input) => `${name(input.node)} · ${input.column}`)
                      .join(", ") || "—"}
                  </span>
                </details>
              ))}
            </div>
          ))}
        </article>
        {children.slice(1).map((child) => (
          <details
            className="lineage-branch"
            key={child.id}
            open={depth(child.id) <= 3}
          >
            <summary>
              <strong>{child.column}</strong>
              <span className="muted">
                {name(child.node)} ← {sources(child.id).join(", ")}
              </span>
            </summary>
            {render(child.id, components)}
          </details>
        ))}
        {children[0] && render(children[0].id, components)}
      </div>
    );
  };
  const origins = [
    ...new Set(
      steps
        .filter((s) => s.kind === "source")
        .map((s) => `${name(s.node)} · ${s.column}`),
    ),
  ];
  const count = (kind: Kind) =>
    new Set(steps.filter((s) => s.kind === kind).map((s) => s.node)).size;
  const summary = (
    [
      [count("computed"), "lineageCalculationOne", "lineageCalculations"],
      [count("carried"), "lineageCarrierOne", "lineageCarriers"],
    ] as const
  )
    .filter(([value]) => value > 0)
    .map(([value, one, many]) => countLabel(t, value, one, many));
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <div role="status">
          <Loader2 className="spin" size={16} />
          {t("loading")}
        </div>
      )}
      {data && (
        <>
          {data.complete === false && (
            <p className="notice warning">{t("lineageColumnIncomplete")}</p>
          )}
          {!!origins.length && !!summary.length && (
            <p className="lineage-column-summary">
              {t("lineageColumnSummary")
                .replace("{column}", target.column || "")
                .replace("{sources}", origins.join(", "))
                .replace("{details}", summary.join(", "))}
            </p>
          )}
          {data.root ? (
            <div className="lineage-path">{render(data.root)}</div>
          ) : (
            data.outputs.map((output) => (
              <Limit
                key={output.port}
                status={output.status}
                nodes={output.run_nodes}
                tables={output.tables}
              />
            ))
          )}
          <p className="lineage-hint">
            {t("lineageColumnPickValue").replace(
              "{column}",
              target.column || "",
            )}
          </p>
        </>
      )}
    </>
  );
}
