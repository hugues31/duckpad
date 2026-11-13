import { ArrowUpRight, Boxes, Database, GitBranch } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, withQuery } from "./api";
import { formatValue } from "./graph";
import { countLabel, useT } from "./i18n";
import {
  cellId,
  type Cell,
  type ContributingRows,
  type Entry,
  type Explanation,
  type Input,
  type LineageGraph,
  type Operand,
  type Query,
  type TableLineage,
} from "./lineageGraph";
import { nodeLocation } from "./nodeCode";
import { worktreeUrl } from "./navigation";
import { displayNodeName } from "./nodeNames";
import type { PartitionPage } from "./partitions";
import { useLoadedWorktree } from "./worktree";

export type LineageMap = Record<
  string,
  {
    value?: unknown;
    state?:
      | "kept"
      | "discarded"
      | "grouped"
      | "duplicated"
      | "written"
      | "unreached"
      | "unknown";
  }
>;
// Formulas stay SQL: a fixed decimal point, and small numbers keep their digits.
const ROUNDED = new Intl.NumberFormat("en", {
  maximumFractionDigits: 6,
  useGrouping: false,
});
export const roundedValue = (value: unknown) =>
  typeof value !== "number" || !Number.isFinite(value)
    ? formatValue(value)
    : value !== 0 && Math.abs(value) < 1e-4
      ? value.toPrecision(3)
      : ROUNDED.format(value);
const roundedExpression = (expression: string) =>
  expression
    .split(/('(?:[^']|'')*')/)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/-?\b\d+\.\d{7,}(?:e[+-]?\d+)?/gi, (number) =>
            roundedValue(Number(number)),
          ),
    )
    .join("");
export function Value({ value }: { value: unknown }) {
  return <span title={formatValue(value)}>{roundedValue(value)}</span>;
}
const anchor = (id: string) => `lineage-${encodeURIComponent(id)}`;

export const componentPaths = (node: string) => {
  const path = node.split("::").slice(0, -1);
  return path.map((_, index) => path.slice(0, index + 1).join("::"));
};
export function ComponentHeading({
  node,
  onOpen,
}: {
  node: string;
  onOpen: (node: string) => void;
}) {
  const t = useT();
  const { snapshot } = useLoadedWorktree();
  const location = snapshot.bundle && nodeLocation(snapshot.bundle, node);
  const definition =
    snapshot.bundle?.components[location?.node.component || ""];
  return (
    <div className="lineage-component">
      <Boxes size={14} />
      <strong>
        {displayNodeName(snapshot.node_names?.[node]?.slice(-1), node, t)}
      </strong>
      <small>{definition?.name}</small>
      <button className="text-button" onClick={() => onOpen(node)}>
        {t("lineageOpenCanvas")} ↗
      </button>
    </div>
  );
}

export function TableSteps({
  tables,
  direction,
  onMap,
  onHover,
  onOpen,
}: {
  tables: TableLineage;
  direction: "origin" | "impact";
  onMap: (map: LineageMap | null) => void;
  onHover: (node: string | null) => void;
  onOpen: (node: string) => void;
}) {
  const t = useT();
  const { snapshot, statuses } = useLoadedWorktree();
  const name = (node: string) =>
    displayNodeName(snapshot.node_names?.[node]?.slice(-1), node, t);
  useEffect(() => {
    onMap(Object.fromEntries(Object.keys(tables.nodes).map((id) => [id, {}])));
    return () => onMap(null);
  }, [tables, onMap]);
  const seen = new Set<string>();
  const tree = (id: string, previous: string[] = []): React.ReactNode => {
    if (seen.has(id))
      return (
        <a key={id} className="lineage-reference" href={`#${anchor(id)}`}>
          {name(id)} ↗
        </a>
      );
    seen.add(id);
    const components = componentPaths(id);
    const item = tables.nodes[id];
    const children = tables.edges
      .filter((e) =>
        direction === "origin" ? e.target === id : e.source === id,
      )
      .map((e) => (direction === "origin" ? e.source : e.target));
    return (
      <div
        key={id}
        className="lineage-table-step"
        id={anchor(id)}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
      >
        {components
          .filter((c) => !previous.includes(c))
          .map((component) => (
            <ComponentHeading
              key={component}
              node={component}
              onOpen={onOpen}
            />
          ))}
        <button
          className="text-button"
          onFocus={() => onHover(id)}
          onBlur={() => onHover(null)}
          onClick={() => onOpen(id)}
        >
          {name(id)}
        </button>
        {item?.error && <p className="notice warning">{item.error}</p>}
        {!!item?.variables.length && (
          <p className="muted small">
            {t("variables")}:{" "}
            {item.variables
              .map((v) => `${v.name}${v.node ? ` ← ${name(v.node)}` : ""}`)
              .join(", ")}
          </p>
        )}
        {children.map((child) => tree(child, components))}
      </div>
    );
  };
  const endpoints = Object.values(tables.nodes).filter((n) =>
    direction === "origin" ? n.source : n.export,
  );
  return (
    <>
      <h3>{t(direction === "origin" ? "lineageSources" : "lineageExports")}</h3>
      <div className="lineage-sources">
        {endpoints.map((item) => {
          const count = Object.values(
            statuses.nodes?.[item.id]?.outputs || {},
          )[0]?.count;
          return (
            <div
              key={item.id}
              onMouseEnter={() => onHover(item.id)}
              onMouseLeave={() => onHover(null)}
            >
              <Database size={14} />
              <strong>{name(item.id)}</strong>
              <Resource node={item.id} tables={tables} />
              {count !== undefined && (
                <small>
                  {count} {t("rows")}
                </small>
              )}
            </div>
          );
        })}
        {!endpoints.length && (
          <p className="muted">{t("lineageNoEndpoints")}</p>
        )}
      </div>
      <h3>
        {t(direction === "origin" ? "lineageUpstream" : "lineageDownstream")}
      </h3>
      {tables.seeds.map((seed) => (seen.has(seed) ? null : tree(seed)))}
    </>
  );
}

function useResource(node: string, tables: TableLineage) {
  const { snapshot } = useLoadedWorktree();
  return Object.entries(tables.nodes[node]?.resource || {})
    .map(([key, value]) => {
      if (value === null || value === undefined || value === "") return null;
      if (key === "connection")
        return (
          snapshot.connections.find((c) => c.id === value)?.name ||
          String(value)
        );
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    })
    .filter(Boolean)
    .join(" · ");
}

export function Resource({
  node,
  tables,
}: {
  node: string;
  tables: TableLineage;
}) {
  return <span className="muted small">{useResource(node, tables)}</span>;
}

export function LineageSteps({
  graph,
  tables,
  read,
  pending,
  onChoose,
  onExpand,
  onHover,
  onOpen,
  onRows,
  onParent,
}: {
  graph: LineageGraph;
  tables: TableLineage;
  read: (query: Query) => Promise<Explanation>;
  pending: boolean;
  onChoose: (id: string, input: Input) => void;
  onExpand: (id: string) => void;
  onHover: (node: string | null) => void;
  onOpen: (node: string) => void;
  onRows: (rows: ContributingRows) => void;
  onParent: (cell: Cell) => void;
}) {
  const t = useT();
  const { snapshot } = useLoadedWorktree();
  const entries = new Map(graph.entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const anchors = new Map<string, string>();
  const sources = (node: string) => {
    const pending = [node],
      visited = new Set<string>(),
      names: string[] = [];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (tables.nodes[id]?.source)
        names.push(
          displayNodeName(snapshot.node_names?.[id]?.slice(-1), id, t),
        );
      else
        pending.push(
          ...tables.edges
            .filter((e) => e.target === id && !e.variable)
            .map((e) => e.source),
        );
    }
    return names.join(", ");
  };
  const render = (id: string, previous: string[] = []): React.ReactNode => {
    const entry = entries.get(id);
    if (!entry) return null;
    const node = entry.result.node || "";
    const name = displayNodeName(
      snapshot.node_names?.[node]?.slice(-1),
      node,
      t,
    );
    if (seen.has(id))
      return (
        <a
          className="lineage-reference"
          href={`#${anchor(anchors.get(id) || id)}`}
        >
          {name} · {entry.result.column} ↗
        </a>
      );
    const sameNode = graph.entries.filter(
      (other) => other.result.node === entry.result.node,
    );
    sameNode.forEach((other) => {
      seen.add(other.id);
      anchors.set(other.id, id);
    });
    // Steps inside the same node (CTEs) are shown above, not as inputs.
    const children = [
      ...new Map(
        sameNode
          .flatMap((other) => other.children)
          .filter((child) => entries.get(child.id)?.result.node !== node)
          .map((child) => [child.id, child]),
      ).values(),
    ];
    const components = componentPaths(node);
    return (
      <div key={id} className="lineage-chain">
        {components
          .filter((c) => !previous.includes(c))
          .map((component) => (
            <ComponentHeading
              key={component}
              node={component}
              onOpen={onOpen}
            />
          ))}
        <article
          id={anchor(id)}
          className={`lineage-step ${entry.result.kind === "source" ? "is-source" : "calculation"} ${entry.result.calculation?.passthrough ? "unchanged" : ""} ${id === graph.root ? "root" : ""}`}
          onMouseEnter={() => onHover(node)}
          onMouseLeave={() => onHover(null)}
        >
          <header>
            <GitBranch size={13} />
            <button
              className="text-button"
              onFocus={() => onHover(node)}
              onBlur={() => onHover(null)}
              onClick={() => onOpen(node)}
            >
              {name}
            </button>
            <span className="muted small">
              {entry.result.calculation?.passthrough
                ? t("lineageUnchanged")
                : ""}
            </span>
          </header>
          {sameNode.map((part) => (
            <StepDetails
              key={part.id}
              entry={part}
              tables={tables}
              read={read}
              pending={pending}
              onChoose={(input) => onChoose(part.id, input)}
              onRows={onRows}
              onParent={onParent}
            />
          ))}
        </article>
        {children.slice(1).map((child) => (
          <details
            className="lineage-branch"
            key={child.id}
            open={!child.deferred}
            onToggle={(event) => {
              if (event.currentTarget.open && child.deferred)
                onExpand(child.id);
            }}
          >
            <summary>
              {child.input.column} = <Value value={child.input.value} /> ·{" "}
              {displayNodeName(
                snapshot.node_names?.[child.input.node || ""]?.slice(-1),
                child.input.node || "",
                t,
              )}
              {child.deferred && ` ← ${sources(child.input.node || "")}`}
            </summary>
            {!child.deferred && render(child.id, components)}
          </details>
        ))}
        {children[0] && render(children[0].id, components)}
      </div>
    );
  };
  return <div className="lineage-path">{render(graph.root)}</div>;
}

function StepDetails({
  entry,
  tables,
  read,
  pending,
  onChoose,
  onRows,
  onParent,
}: {
  entry: Entry;
  tables: TableLineage;
  read: (query: Query) => Promise<Explanation>;
  pending: boolean;
  onChoose: (input: Input) => void;
  onRows: (rows: ContributingRows) => void;
  onParent: (cell: Cell) => void;
}) {
  const t = useT();
  const worktree = useLoadedWorktree();
  const navigate = useNavigate();
  const { result } = entry;
  const resource = useResource(result.node || "", tables);
  const [page, setPage] = useState(result);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const replay = async () => {
    if (!result.replay) return;
    setBusy(true);
    try {
      const value = result.replay,
        key = value.partitions.keys![0];
      let cursor: string | undefined;
      do {
        const page = await api<PartitionPage>(
          withQuery(`/worktrees/${worktree.id}/partitions`, {
            environment: worktree.environment,
            node: value.node,
            search: String(key.value),
            cursor,
          }),
        );
        const found = page.entries.find(
          (e) => e.key.type === key.type && e.key.value === key.value,
        );
        if (found) {
          worktree.selectPartition(found);
          // The run interrupts this exploration: show the node it recomputes.
          navigate(
            worktreeUrl(worktree.id, "flow", worktree.environment, {
              node: value.node,
            }),
          );
          await worktree.run(value.node, { partitions: value.partitions });
          return;
        }
        cursor = page.next_cursor || undefined;
      } while (cursor);
      throw new Error(t("partitionReplayMissing"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {result.kind === "python" && <p>{t("pythonOpaque")}</p>}
      <div className="lineage-formula">
        <code>
          {result.column}
          {result.calculation &&
            !result.calculation.passthrough &&
            ` = ${result.calculation.formula}`}
        </code>
        {(!result.calculation || result.calculation.passthrough) && (
          <>
            {" "}
            ={" "}
            <strong>
              <Value value={result.value} />
            </strong>
          </>
        )}
      </div>
      {result.calculation && !result.calculation.passthrough && (
        <div
          className="lineage-equation"
          title={`${result.calculation.evaluated || result.calculation.formula} = ${formatValue(result.value)}`}
        >
          <code>
            {roundedExpression(
              result.calculation.evaluated || result.calculation.formula,
            )}
          </code>{" "}
          ={" "}
          <strong>
            <Value value={result.value} />
          </strong>
        </div>
      )}
      {!!result.calculation?.selection?.length && (
        <p className="lineage-selection">
          {result.calculation.selection.join(" · ")}
          {!!result.calculation.selection_evaluated?.length && (
            <> → {result.calculation.selection_evaluated.join(" · ")}</>
          )}
        </p>
      )}
      {result.kind === "source" && (
        <p className="lineage-source-location muted small">
          {[resource, `${t("lineageRow")} ${result.row + 1}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {!result.complete && (
        <div className="notice warning">
          <strong>{t("partial")}</strong>
          {result.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      {result.operands?.map(
        (operand) =>
          operand.aggregate && (
            <Contributions
              key={operand.id}
              query={{ ...entry.query, operand: operand.id }}
              initial={operand}
              label={operand.formula}
              read={read}
              onChoose={onChoose}
              onRows={onRows}
              disabled={pending}
              followed={entry.children[0]?.input}
            />
          ),
      )}
      {!result.operands &&
        result.complete &&
        (result.kind === "aggregate" ||
          result.kind === "window" ||
          result.groups) && (
          <Contributions
            query={entry.query}
            initial={result}
            read={read}
            onChoose={onChoose}
            onRows={onRows}
            disabled={pending}
            followed={entry.children[0]?.input}
          />
        )}
      {!!result.parents?.length && (
        <div className="lineage-parents">
          <p>{t("pythonCapturedParents")}</p>
          <p>{t("pythonParentHint")}</p>
          {page.parents?.map((parent) => (
            <details key={parent.dataset} open>
              <summary>
                {displayNodeName(
                  worktree.snapshot.node_names?.[parent.node],
                  parent.node,
                  t,
                )}{" "}
                · {parent.port}
              </summary>
              <table>
                <thead>
                  <tr>
                    {parent.columns.map((c) => (
                      <th key={c.name}>{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parent.rows.map((row) => (
                    <tr key={row.row}>
                      {row.values.map((value, index) => (
                        <td key={index}>
                          <button
                            className="text-button"
                            aria-label={t("pythonParentCell")
                              .replace("{column}", parent.columns[index].name)
                              .replace("{row}", String(row.row + 1))}
                            onClick={() =>
                              onParent({
                                dataset: parent.dataset,
                                node: parent.node,
                                port: parent.port,
                                row: row.row,
                                column: parent.columns[index].name,
                              })
                            }
                          >
                            <Value value={value} />
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
          {Math.max(...(page.parents || []).map((p) => p.count), 0) >
            (page.offset || 0) + page.page_size && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void read({
                  ...entry.query,
                  offset: (page.offset || 0) + page.page_size,
                })
                  .then(setPage)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              {t("next")}
            </button>
          )}
        </div>
      )}
      {result.origin && (
        <p>
          {t("partitionOrigin")}: {String(result.origin.partition.key.value)} ·{" "}
          {t("partitionProducingRun")}: {result.origin.run}
        </p>
      )}
      {!!result.partition_groups?.length && (
        <p>
          {t("partitionContributors")}:{" "}
          {result.partition_groups
            .map((g) => `${String(g.partition.key.value)} (${g.rows})`)
            .join(", ")}
        </p>
      )}
      {result.replay && (
        <div>
          <p>
            {t("partitionOriginUnavailable").replace(
              "{key}",
              String(result.origin?.partition.key.value),
            )}
          </p>
          {worktree.canEdit && (
            <button
              className="text-button"
              disabled={busy || !!worktree.statuses.active || worktree.starting}
              onClick={() => void replay()}
            >
              {t("partitionRunToExplain")}
            </button>
          )}
          <p>{t("partitionReplayHint")}</p>
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

function Contributions({
  query,
  initial,
  label,
  read,
  onChoose,
  onRows,
  disabled,
  followed,
}: {
  followed?: Input;
  query: Query;
  initial: Explanation | Operand;
  label?: string;
  read: (query: Query) => Promise<Explanation>;
  onChoose: (input: Input) => void;
  onRows: (rows: ContributingRows) => void;
  disabled: boolean;
}) {
  const t = useT();
  const [page, setPage] = useState(initial);
  const [items, setItems] = useState(initial.contributions);
  const [expanded, setExpanded] = useState(false);
  const [group, setGroup] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (offset: number, nextGroup = group) => {
    setBusy(true);
    setError("");
    try {
      const result = await read({
        ...query,
        offset,
        page_size: 100,
        group: nextGroup,
      });
      setPage(result);
      setItems((current) =>
        offset ? [...current, ...result.contributions] : result.contributions,
      );
      setGroup(nextGroup);
      setExpanded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const groups = "groups" in page ? page.groups : undefined;
  const operation =
    "operation" in initial ? initial.operation : initial.calculation?.operation;
  return (
    <div className="lineage-contributions">
      {label && (
        <div>
          <code>{label}</code> ={" "}
          <strong>
            <Value value={initial.value} />
          </strong>
        </div>
      )}
      {group !== undefined && (
        <button
          className="text-button"
          disabled={busy || disabled}
          onClick={() => {
            setGroup(undefined);
            setPage(initial);
            setItems(initial.contributions);
            setExpanded(false);
          }}
        >
          {t("lineageAllGroups")}
        </button>
      )}
      {groups ? (
        <>
          {groups.map((g) => (
            <button
              key={g.key}
              className="text-button"
              disabled={busy || disabled}
              onClick={() => void load(0, g.key)}
            >
              {t("lineageShowRows")}: <Value value={g.value} /> ({g.rows})
            </button>
          ))}
          {groups.length < page.total && (
            <button
              className="text-button"
              disabled={busy || disabled}
              onClick={() =>
                void load(
                  ("offset" in page ? Number(page.offset) : 0) + groups.length,
                )
              }
            >
              {t("next")}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="lineage-values">
            {items.slice(0, expanded ? undefined : 5).map((input, index) => (
              <Fragment key={cellId(input)}>
                {index > 0 && operation === "sum" && <span>+</span>}
                <button
                  className="lineage-value"
                  aria-pressed={
                    !!followed && cellId(followed) === cellId(input)
                  }
                  title={`${input.column}: ${formatValue(input.value)}`}
                  disabled={disabled}
                  onClick={() => onChoose(input)}
                >
                  <Value value={input.value} />
                </button>
              </Fragment>
            ))}
            {!expanded && page.total > 5 && (
              <span className="muted">
                {t("lineageMore").replace("{count}", String(page.total - 5))}
              </span>
            )}
            {operation === "sum" && (
              <strong>
                = <Value value={initial.value} />
              </strong>
            )}
          </div>
          <div className="row gap">
            {page.total > 5 && (
              <button
                className="text-button"
                disabled={busy || disabled}
                onClick={() => {
                  if (expanded) setExpanded(false);
                  else if (items.length > 5 || items.length >= page.total)
                    setExpanded(true);
                  else void load(items.length);
                }}
              >
                {t(
                  expanded ? "lineageHideValues" : "lineageShowValues",
                ).replace("{count}", String(page.total))}
              </button>
            )}
            <small className="muted">{t("lineageChooseValue")}</small>
          </div>
          {expanded && items.length < page.total && (
            <button
              className="text-button"
              disabled={busy || disabled}
              onClick={() => void load(items.length)}
            >
              {t("next")} · {items.length} / {page.total}
            </button>
          )}
          {[...new Map(items.map((item) => [item.dataset, item])).values()].map(
            (input) => (
              <button
                className="text-button"
                key={input.dataset}
                disabled={disabled}
                onClick={() => onRows({ query: { ...query, group }, input })}
              >
                <ArrowUpRight size={13} />
                {countLabel(t, page.total, "lineageOpenRow", "lineageOpenRows")}
              </button>
            ),
          )}
        </>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
