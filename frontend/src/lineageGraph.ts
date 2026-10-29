import type { Node, Edge } from "@xyflow/react";

export type Cell = {
  dataset: string;
  row: number;
  column: string;
  node?: string;
  port?: string;
};
export type Input = Cell & { value: unknown; source?: boolean };
export type Query = Cell & {
  offset?: number;
  group?: string;
  context?: boolean;
};
export type Explanation = Input & {
  kind?: string;
  expression?: string;
  calculation?: {
    operation: string;
    formula: string;
    evaluated?: string;
    selection?: string[];
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
export type Entry = {
  id: string;
  query: Query;
  result: Explanation;
  hidden: Explanation[];
  deferred?: boolean;
  group?: { parent: string; key: string; rows: number };
};
export const cellId = (cell: Cell) =>
  JSON.stringify([cell.dataset, cell.row, cell.column]);
export const requestId = (query: Query) =>
  JSON.stringify([
    cellId(query),
    query.offset || 0,
    query.group,
    !!query.context,
  ]);

const sourceResult = (cell: Input): Explanation => ({
  ...cell,
  kind: "source",
  complete: true,
  warnings: [],
  total: 0,
  contributions: [],
  context_total: 0,
  page_size: 5,
});

/** Build the visible dependency DAG; identity projections remain available as selection details. */
export async function buildLineageGraph(
  cell: Cell,
  pages: Record<string, Partial<Query>>,
  read: (query: Query) => Promise<Explanation>,
  budget: number,
) {
  const entries = new Map<string, Entry>();
  const edges = new Map<string, Edge>();
  let remaining = budget;
  const original = await read(cell);
  const visit = async (
    input: Input,
    ancestors: Set<string>,
  ): Promise<string> => {
    let current = input;
    const hidden: Explanation[] = [];
    const visited = new Set(ancestors);
    while (true) {
      const id = cellId(current);
      if (visited.has(id))
        throw new Error("A circular lineage reference cannot be displayed.");
      visited.add(id);
      const existing = entries.get(id);
      if (existing) {
        existing.hidden = [
          ...new Map(
            [...existing.hidden, ...hidden].map((item) => [cellId(item), item]),
          ).values(),
        ];
        return id;
      }
      const query: Query = {
        dataset: current.dataset,
        row: current.row,
        column: current.column,
        ...pages[id],
      };
      const deferred = !current.source && remaining-- <= 0;
      const result =
        current.source || deferred ? sourceResult(current) : await read(query);
      if (
        !deferred &&
        result.complete &&
        result.calculation?.passthrough &&
        result.total === 1 &&
        result.contributions.length === 1
      ) {
        hidden.push(result);
        current = result.contributions[0];
        continue;
      }
      const entry: Entry = { id, query, result, hidden, deferred };
      entries.set(id, entry);
      const connect = (source: string) => {
        const edgeId = JSON.stringify([source, id]);
        edges.set(edgeId, {
          id: edgeId,
          source,
          target: id,
          type: "smoothstep",
          markerEnd: { type: "arrowclosed" as const },
          selectable: false,
        });
      };
      if (!deferred && result.complete && result.kind !== "source") {
        if (result.groups) {
          for (const group of result.groups) {
            const groupId = JSON.stringify([id, "group", group.key]);
            entries.set(groupId, {
              id: groupId,
              query,
              hidden: [],
              result: {
                ...sourceResult({ ...result, value: group.value }),
                kind: "group",
              },
              group: { parent: id, key: group.key, rows: group.rows },
            });
            connect(groupId);
          }
        } else {
          // Sequential traversal bounds backend work and shares already-resolved source cells.
          for (const contribution of result.contributions)
            connect(await visit(contribution, visited));
        }
      }
      return id;
    }
  };
  const root = await visit(original, new Set());
  return {
    original,
    root,
    entries: [...entries.values()],
    edges: [...edges.values()],
  };
}

/** Lay out sources on the left and their calculations on the right, preserving shared inputs. */
export function arrangeLineage<T extends Node>(nodes: T[], edges: Edge[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ranks = new Map<string, number>();
  const rank = (id: string): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    ranks.set(id, 0);
    const parents = edges.filter((edge) => edge.target === id);
    const value = parents.length
      ? Math.max(...parents.map((edge) => rank(edge.source))) + 1
      : 0;
    ranks.set(id, value);
    return value;
  };
  for (const node of nodes) rank(node.id);
  const layers = new Map<number, T[]>();
  for (const node of nodes)
    layers.set(ranks.get(node.id)!, [
      ...(layers.get(ranks.get(node.id)!) || []),
      node,
    ]);
  const height = (node: T) => node.height || 140;
  const totals = [...layers.values()].map((layer) =>
    layer.reduce((total, node) => total + height(node) + 24, -24),
  );
  const fullHeight = Math.max(...totals, 0);
  for (const [level, layer] of layers) {
    const total = layer.reduce((sum, node) => sum + height(node) + 24, -24);
    let y = (fullHeight - total) / 2;
    for (const node of layer) {
      byId.set(node.id, { ...node, position: { x: level * 430, y } });
      y += height(node) + 24;
    }
  }
  return nodes.map((node) => byId.get(node.id)!);
}
