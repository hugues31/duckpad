import type { VariableValue } from "./types";
import type {
  PartitionContext,
  PartitionEntry,
  PartitionLaunchOptions,
} from "./partitions";

type Origin = { partition: PartitionEntry; run: string; row: number };

export type Cell = {
  dataset: string;
  row: number;
  column: string;
  node?: string;
  port?: string;
  partition_context?: PartitionContext;
  origin?: Origin;
};
export type Input = Cell & { value: unknown; source?: boolean };
export type Query = Cell & {
  offset?: number;
  operand?: string;
  page_size?: number;
  group?: string;
  context?: boolean;
};
export type Operand = {
  id: string;
  formula: string;
  value: unknown;
  aggregate: boolean;
  operation: string;
  total: number;
  contributions: Input[];
};
export type Explanation = Input & {
  offset?: number;
  execution?: string;
  commit?: string;
  operands?: Operand[];
  first_inputs?: Input[];
  input_order?: { dataset: string; column: string }[];
  parents?: {
    dataset: string;
    node: string;
    port: string;
    run: string;
    count: number;
    columns: { name: string; type: string }[];
    rows: { row: number; values: unknown[] }[];
  }[];
  partition_groups?: { partition: PartitionEntry; run: string; rows: number }[];
  replay?: {
    node: string;
    partitions: NonNullable<PartitionLaunchOptions["partitions"]>;
  };
  variables?: Record<string, VariableValue>;
  environment?: string;
  kind?: string;
  expression?: string;
  calculation?: {
    operation: string;
    formula: string;
    evaluated?: string;
    selection?: string[];
    selection_evaluated?: string[];
    passthrough: boolean;
  };
  complete: boolean;
  warnings: string[];
  total: number;
  page_size: number;
  contributions: Input[];
  context_total: number;
  groups?: { key: string; value: unknown; rows: number }[];
  group?: unknown;
};

export type TableLineage = {
  node: string;
  seeds: string[];
  nodes: Record<
    string,
    {
      id: string;
      source: boolean;
      export: boolean;
      resource: Record<string, unknown>;
      variables: { name: string; node?: string }[];
      error?: string;
    }
  >;
  edges: { source: string; target: string; variable?: string }[];
};
export type LineageTarget = {
  node: string;
  port?: string;
  direction: "origin" | "impact";
  cell?: Cell;
};
export type ContributingRows = { query: Query; input: Input };
export type Entry = {
  id: string;
  query: Query;
  result: Explanation;
  children: { id: string; input: Input; deferred: boolean }[];
};
export type LineageGraph = {
  root: string;
  original: Explanation;
  entries: Entry[];
};
export const cellId = (cell: Cell) =>
  JSON.stringify([cell.dataset, cell.row, cell.column]);
export const requestId = (query: Query) =>
  JSON.stringify([
    cellId(query),
    query.offset || 0,
    query.group,
    query.operand,
    query.page_size,
    !!query.context,
    query.partition_context,
  ]);

/** Follow one row per input, keeping transport steps and loading long side branches on demand. */
export async function buildLineageGraph(
  cell: Cell,
  choices: Record<string, Input>,
  opened: Set<string>,
  read: (query: Query) => Promise<Explanation>,
  tables: TableLineage,
): Promise<LineageGraph> {
  const entries = new Map<string, Entry>();
  const depth = (node: string, seen = new Set<string>()): number => {
    if (seen.has(node)) return 0;
    if (seen.size >= 3) return 1;
    const next = new Set([...seen, node]);
    return (
      1 +
      Math.max(
        0,
        ...tables.edges
          .filter((e) => e.target === node && !e.variable)
          .map((e) => depth(e.source, next)),
      )
    );
  };
  const original = await read(cell);
  const visit = async (
    input: Input,
    ancestors: Set<string>,
  ): Promise<string> => {
    const id = cellId(input);
    if (ancestors.has(id)) throw new Error("Circular lineage reference");
    if (entries.has(id)) return id;
    const query: Query = {
      dataset: input.dataset,
      row: input.row,
      column: input.column,
      partition_context: input.partition_context,
    };
    const result: Explanation = input.source
      ? {
          ...input,
          kind: "source",
          complete: true,
          warnings: [],
          total: 0,
          contributions: [],
          context_total: 0,
          page_size: 5,
        }
      : await read(query);
    const entry: Entry = { id, query, result, children: [] };
    entries.set(id, entry);
    if (
      !result.complete ||
      result.kind === "source" ||
      result.kind === "python"
    )
      return id;
    // Scalar operands identify the selected row; a window's other rows are explored on click.
    const operands = result.operands;
    const scalar =
      operands?.filter((p) => !p.aggregate).flatMap((p) => p.contributions) ||
      [];
    const firstGroup = result.groups?.[0];
    const contributions =
      firstGroup && !choices[id]
        ? (await read({ ...query, group: firstGroup.key })).contributions
        : result.contributions;
    const inputs = choices[id]
      ? [choices[id]]
      : scalar.length
        ? scalar
        : operands?.[0]?.contributions ||
          (firstGroup ? contributions : result.first_inputs || contributions);
    const groups = new Map<string, Input>();
    const ordered = [...inputs].sort((a, b) => {
      const order = (item: Input) =>
        result.input_order?.findIndex(
          (c) => c.dataset === item.dataset && c.column === item.column,
        ) ?? 0;
      return order(a) - order(b);
    });
    for (const item of ordered) {
      const key = JSON.stringify([item.dataset, item.column]);
      if (!groups.has(key)) groups.set(key, item);
    }
    for (const [index, item] of [...groups.values()].entries()) {
      const child = cellId(item);
      const deferred =
        index > 0 &&
        !item.source &&
        depth(item.node || "") > 3 &&
        !opened.has(child);
      entry.children.push({ id: child, input: item, deferred });
      if (!deferred) await visit(item, new Set([...ancestors, id]));
    }
    return id;
  };
  const root = await visit(original, new Set());
  return { root, original, entries: [...entries.values()] };
}

export function readLineageTarget(
  params: URLSearchParams,
): LineageTarget | null {
  const node = params.get("lineage");
  if (!node) return null;
  const dataset = params.get("dataset"),
    column = params.get("column"),
    row = Number(params.get("row"));
  let partition_context: Cell["partition_context"];
  try {
    partition_context =
      JSON.parse(params.get("partition") || "null") || undefined;
  } catch {
    /* Ignore malformed optional context. */
  }
  const cell =
    dataset &&
    column &&
    params.has("row") &&
    Number.isSafeInteger(row) &&
    row >= 0
      ? {
          dataset,
          column,
          row,
          node,
          port: params.get("output") || undefined,
          partition_context,
        }
      : undefined;
  return {
    node,
    port: params.get("output") || undefined,
    direction:
      !cell && params.get("direction") === "impact" ? "impact" : "origin",
    cell,
  };
}

export function writeLineageTarget(
  params: URLSearchParams,
  target: LineageTarget | null,
) {
  const next = new URLSearchParams(params);
  for (const key of [
    "lineage",
    "output",
    "direction",
    "dataset",
    "column",
    "row",
    "partition",
  ])
    next.delete(key);
  if (target) {
    next.set("lineage", target.node);
    next.set("node", target.node);
    if (target.port) next.set("output", target.port);
    if (target.direction === "impact") next.set("direction", "impact");
    if (target.cell) {
      next.set("dataset", target.cell.dataset);
      next.set("column", target.cell.column);
      next.set("row", String(target.cell.row));
      if (target.cell.partition_context)
        next.set("partition", JSON.stringify(target.cell.partition_context));
    }
  }
  return next;
}
