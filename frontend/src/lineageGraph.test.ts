import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import {
  arrangeLineage,
  buildLineageGraph,
  cellId,
  requestId,
  type Cell,
  type Explanation,
  type Input,
  type Query,
} from "./lineageGraph";

const t = (key: string) => `translated:${key}`;

const at = (dataset: string, row: number, column: string): Cell => ({
  dataset,
  row,
  column,
});

/** A contribution as the backend lists it; `source` marks source datasets. */
const input = (cell: Cell, value: unknown, source = false): Input => ({
  ...cell,
  node: cell.dataset,
  port: "output",
  value,
  source,
});

/** A complete explanation of a calculated cell. */
const explained = (
  cell: Input,
  contributions: Input[],
  details: Partial<Explanation> = {},
): Explanation => ({
  ...cell,
  kind: "aggregate",
  expression: "sum(amount)",
  calculation: { operation: "sum", formula: "sum(amount)", passthrough: false },
  complete: true,
  warnings: [],
  total: contributions.length,
  page_size: 5,
  contributions,
  context_total: 0,
  ...details,
});

/** The explanation of a cell that copies a single upstream cell unchanged. */
const projection = (cell: Input, upstream: Input) =>
  explained(cell, [upstream], {
    kind: "projection",
    expression: upstream.column,
    calculation: {
      operation: "expression",
      formula: upstream.column,
      passthrough: true,
    },
  });

/** A lineage endpoint answering with the given explanations, keyed by cell. */
function backend(...explanations: Explanation[]) {
  const byCell = new Map(explanations.map((item) => [cellId(item), item]));
  return vi.fn(async (query: Query) => {
    const found = byCell.get(cellId(query));
    if (!found) throw new Error(`unexpected read of ${cellId(query)}`);
    return found;
  });
}

type LineageGraph = Awaited<ReturnType<typeof buildLineageGraph>>;

const entry = (graph: LineageGraph, cell: Cell) =>
  graph.entries.find((item) => item.id === cellId(cell));

const links = (graph: LineageGraph) =>
  graph.edges.map((edge) => [edge.source, edge.target]);

const readCells = (read: ReturnType<typeof backend>) =>
  read.mock.calls.map(([query]) => cellId(query));

// orders is a source dataset; totals sums the amounts of each customer.
const order0 = input(at("orders", 0, "amount"), 10, true);
const order1 = input(at("orders", 1, "amount"), 20, true);
const total = input(at("totals", 0, "total"), 30);
const totalExplanation = explained(total, [order0, order1]);

describe("cell identifiers", () => {
  it("identifies a cell by dataset, row and column only", () => {
    expect(cellId(order0)).toBe(cellId(at("orders", 0, "amount")));
    expect(cellId(order0)).not.toBe(cellId(order1));
    expect(cellId(at("orders", 0, "amount"))).not.toBe(
      cellId(at("orders", 0, "price")),
    );
    expect(cellId(at("orders", 0, "amount"))).not.toBe(
      cellId(at("totals", 0, "amount")),
    );
  });

  it("distinguishes the pages, groups and context of a request", () => {
    const cell = at("totals", 0, "total");
    expect(requestId({ ...cell, offset: 0, context: false })).toBe(
      requestId(cell),
    );
    const variants = [
      requestId(cell),
      requestId({ ...cell, offset: 5 }),
      requestId({ ...cell, group: '"north"' }),
      requestId({ ...cell, context: true }),
      requestId(at("totals", 1, "total")),
    ];
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe("buildLineageGraph", () => {
  it("links a calculated cell to the source cells it reads", async () => {
    const read = backend(totalExplanation);
    const graph = await buildLineageGraph(total, {}, read, 60, t);

    expect(graph.original).toBe(totalExplanation);
    expect(graph.root).toBe(cellId(total));
    expect(graph.entries.map((item) => item.id)).toEqual([
      cellId(total),
      cellId(order0),
      cellId(order1),
    ]);
    expect(entry(graph, total)?.result).toBe(totalExplanation);
    expect(entry(graph, order0)?.result).toMatchObject({
      kind: "source",
      value: 10,
      complete: true,
    });
    expect(links(graph)).toEqual([
      [cellId(order0), cellId(total)],
      [cellId(order1), cellId(total)],
    ]);
    // Source cells are already explained by their contribution.
    expect(readCells(read)).not.toContain(cellId(order0));
    expect(readCells(read)).not.toContain(cellId(order1));
  });

  it("hides identity projections behind the cell they copy", async () => {
    const report = input(at("report", 0, "total"), 30);
    const reportExplanation = projection(report, total);
    const read = backend(reportExplanation, totalExplanation);
    const graph = await buildLineageGraph(report, {}, read, 60, t);

    expect(graph.original).toBe(reportExplanation);
    expect(graph.root).toBe(cellId(total));
    expect(entry(graph, report)).toBeUndefined();
    expect(entry(graph, total)?.hidden).toEqual([reportExplanation]);
    expect(links(graph)).toEqual([
      [cellId(order0), cellId(total)],
      [cellId(order1), cellId(total)],
    ]);
  });

  it("shares an input used by several calculations", async () => {
    const quantity = input(at("orders", 0, "quantity"), 3, true);
    const price = input(at("orders", 0, "price"), 5, true);
    const unitCost = input(at("orders", 0, "unit_cost"), 2, true);
    const revenue = input(at("revenue", 0, "total"), 15);
    const cost = input(at("cost", 0, "total"), 6);
    const margin = input(at("margin", 0, "margin"), 9);
    const read = backend(
      explained(margin, [revenue, cost], {
        kind: "projection",
        calculation: {
          operation: "expression",
          formula: "revenue - cost",
          passthrough: false,
        },
      }),
      explained(revenue, [price, quantity]),
      explained(cost, [quantity, unitCost]),
    );
    const graph = await buildLineageGraph(margin, {}, read, 60, t);

    expect(graph.entries.map((item) => item.id).sort()).toEqual(
      [margin, revenue, cost, quantity, price, unitCost].map(cellId).sort(),
    );
    expect(links(graph)).toEqual(
      expect.arrayContaining([
        [cellId(quantity), cellId(revenue)],
        [cellId(quantity), cellId(cost)],
        [cellId(revenue), cellId(margin)],
        [cellId(cost), cellId(margin)],
      ]),
    );
    expect(graph.edges).toHaveLength(6);
  });

  it("merges the identity projections that reach the same cell", async () => {
    const left = input(at("left", 0, "total"), 30);
    const right = input(at("right", 0, "total"), 30);
    const difference = input(at("difference", 0, "delta"), 0);
    const leftExplanation = projection(left, total);
    const rightExplanation = projection(right, total);
    const read = backend(
      explained(difference, [left, right], { kind: "join" }),
      leftExplanation,
      rightExplanation,
      totalExplanation,
    );
    const graph = await buildLineageGraph(difference, {}, read, 60, t);

    expect(entry(graph, left)).toBeUndefined();
    expect(entry(graph, right)).toBeUndefined();
    expect(entry(graph, total)?.hidden).toEqual([
      leftExplanation,
      rightExplanation,
    ]);
    expect(links(graph)).toEqual([
      [cellId(order0), cellId(total)],
      [cellId(order1), cellId(total)],
      [cellId(total), cellId(difference)],
    ]);
  });

  it("rejects a circular reference", async () => {
    const first = input(at("first", 0, "value"), 1);
    const second = input(at("second", 0, "value"), 1);
    const read = backend(
      explained(first, [second]),
      explained(second, [first]),
    );
    await expect(buildLineageGraph(first, {}, read, 60, t)).rejects.toThrow(
      "translated:lineageCircularReference",
    );
  });

  it("defers calculated cells beyond the read budget", async () => {
    const north = input(at("regions", 0, "total"), 10);
    const south = input(at("regions", 1, "total"), 20);
    const country = input(at("country", 0, "total"), 30);
    const read = backend(
      explained(country, [north, south]),
      explained(north, [order0]),
      explained(south, [order1]),
    );
    const graph = await buildLineageGraph(country, {}, read, 2, t);

    expect(entry(graph, north)?.deferred).toBeFalsy();
    expect(entry(graph, south)).toMatchObject({
      deferred: true,
      result: { kind: "source", value: 20 },
    });
    expect(readCells(read)).not.toContain(cellId(south));
    expect(entry(graph, order1)).toBeUndefined();
    expect(links(graph)).toEqual([
      [cellId(order0), cellId(north)],
      [cellId(north), cellId(country)],
      [cellId(south), cellId(country)],
    ]);
  });

  it("requests the selected page of a cell's contributions", async () => {
    const read = backend(totalExplanation);
    const graph = await buildLineageGraph(
      total,
      { [cellId(total)]: { offset: 5 } },
      read,
      60,
      t,
    );
    expect(read).toHaveBeenCalledWith({
      ...at("totals", 0, "total"),
      offset: 5,
    });
    expect(entry(graph, total)?.query).toEqual({
      ...at("totals", 0, "total"),
      offset: 5,
    });
  });

  it("shows the distinct values of a cell as groups", async () => {
    const regions = input(at("regions", 0, "count"), 2);
    const groups = [
      { key: '"north"', value: "north", rows: 3 },
      { key: '"south"', value: "south", rows: 1 },
    ];
    const explanation = explained(regions, [], {
      kind: "distinct_groups",
      total: 2,
      groups,
    });
    const graph = await buildLineageGraph(
      regions,
      {},
      backend(explanation),
      60,
      t,
    );

    const grouped = graph.entries.filter((item) => item.group);
    expect(grouped.map((item) => item.group)).toEqual(
      groups.map(({ key, rows }) => ({ parent: cellId(regions), key, rows })),
    );
    expect(grouped.map((item) => item.result)).toEqual([
      expect.objectContaining({ kind: "group", value: "north" }),
      expect.objectContaining({ kind: "group", value: "south" }),
    ]);
    expect(links(graph)).toEqual(
      grouped.map((item) => [item.id, cellId(regions)]),
    );
  });

  it("stops at an explanation that is incomplete", async () => {
    const explanation = explained(total, [], {
      complete: false,
      warnings: ["This SQL step could not be explained"],
      total: 0,
    });
    const graph = await buildLineageGraph(
      total,
      {},
      backend(explanation),
      60,
      t,
    );
    expect(graph.entries).toEqual([
      expect.objectContaining({ id: cellId(total), result: explanation }),
    ]);
    expect(graph.edges).toEqual([]);
  });

  it("shows a cell of a source dataset alone", async () => {
    // The backend answers for the selected cell, which is not a contribution.
    const selected = input(at("orders", 0, "amount"), 10);
    const explanation = explained(selected, [order0], {
      kind: "source",
      expression: "amount",
      calculation: undefined,
    });
    const graph = await buildLineageGraph(
      at("orders", 0, "amount"),
      {},
      backend(explanation),
      60,
      t,
    );
    expect(graph.root).toBe(cellId(order0));
    expect(graph.entries.map((item) => item.id)).toEqual([cellId(order0)]);
    expect(graph.edges).toEqual([]);
  });
});

describe("arrangeLineage", () => {
  const card = (id: string, height?: number): Node => ({
    id,
    position: { x: 0, y: 0 },
    data: { label: id },
    ...(height === undefined ? {} : { height }),
  });
  const link = (source: string, target: string): Edge => ({
    id: `${source}->${target}`,
    source,
    target,
  });
  const positions = (nodes: Node[]) =>
    Object.fromEntries(nodes.map((node) => [node.id, node.position]));

  it("places each calculation one column right of its furthest input", () => {
    const nodes = [card("result"), card("middle"), card("source")];
    const arranged = arrangeLineage(nodes, [
      link("source", "middle"),
      link("middle", "result"),
      link("source", "result"),
    ]);
    expect(arranged.map((node) => node.position.x)).toEqual([860, 430, 0]);
  });

  it("centers each column vertically, 24 pixels apart", () => {
    const arranged = arrangeLineage(
      [card("result", 100), card("first", 100), card("second", 100)],
      [link("first", "result"), link("second", "result")],
    );
    expect(positions(arranged)).toEqual({
      first: { x: 0, y: 0 },
      second: { x: 0, y: 124 },
      result: { x: 430, y: 62 },
    });
  });

  it("assumes 140 pixels for nodes of unknown height", () => {
    const arranged = arrangeLineage(
      [card("result", 40), card("first"), card("second")],
      [link("first", "result"), link("second", "result")],
    );
    expect(positions(arranged)).toEqual({
      first: { x: 0, y: 0 },
      second: { x: 0, y: 164 },
      result: { x: 430, y: 132 },
    });
  });

  it("keeps the node order and data without changing the input nodes", () => {
    const nodes = [card("result"), card("source")];
    const arranged = arrangeLineage(nodes, [link("source", "result")]);
    expect(arranged.map((node) => [node.id, node.data])).toEqual([
      ["result", { label: "result" }],
      ["source", { label: "source" }],
    ]);
    expect(nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it("returns nothing for an empty graph", () => {
    expect(arrangeLineage([], [])).toEqual([]);
  });
});
