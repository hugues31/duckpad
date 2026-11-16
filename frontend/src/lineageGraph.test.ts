import { describe, expect, it, vi } from "vitest";
import {
  buildLineageGraph,
  cellId,
  readLineageTarget,
  writeLineageTarget,
  type Query,
  type Explanation,
  type Input,
  type TableLineage,
} from "./lineageGraph";

const input = (node: string, row = 0, source = false): Input => ({
  node,
  dataset: node,
  row,
  column: "amount",
  value: 10,
  source,
});
const result = (
  cell: Input,
  contributions: Input[],
  extra: Partial<Explanation> = {},
): Explanation => ({
  ...cell,
  complete: true,
  warnings: [],
  kind: "projection",
  total: contributions.length,
  page_size: 5,
  contributions,
  context_total: 0,
  ...extra,
});
const tables: TableLineage = {
  node: "root",
  seeds: ["root"],
  nodes: {},
  edges: [],
};
const reader = (results: Explanation[]) => {
  const data = new Map(results.map((r) => [cellId(r), r]));
  return vi.fn(async (cell: Query) => data.get(cellId(cell))!);
};

describe("node lineage path", () => {
  it("keeps six consecutive calculations and all transport nodes", async () => {
    const cells = Array.from({ length: 8 }, (_, i) =>
      input(`node${i}`, 0, i === 7),
    );
    const read = reader(
      cells.slice(0, -1).map((cell, i) =>
        result(cell, [cells[i + 1]], {
          calculation: {
            operation: "expression",
            formula: i === 6 ? "amount" : "amount * 1",
            evaluated: i === 6 ? "10" : "10 * 1",
            passthrough: i === 6,
          },
        }),
      ),
    );
    const graph = await buildLineageGraph(
      cells[0],
      {},
      new Set(),
      read,
      tables,
    );
    expect(graph.entries.map((e) => e.result.node)).toEqual(
      cells.map((c) => c.node),
    );
    expect(
      graph.entries.filter(
        (e) => e.result.calculation && !e.result.calculation.passthrough,
      ),
    ).toHaveLength(6);
  });
  it("follows one aggregate value and changes the path when another is chosen", async () => {
    const root = input("root"),
      rows = Array.from({ length: 5 }, (_, i) => input("upstream", i));
    const read = reader([
      result(root, rows, { kind: "aggregate", total: 1000 }),
      ...rows.map((c) => result(c, [input("source", c.row, true)])),
    ]);
    const graph = await buildLineageGraph(root, {}, new Set(), read, tables);
    expect(graph.entries).toHaveLength(3);
    expect(graph.entries[1].result.row).toBe(0);
    const chosen = await buildLineageGraph(
      root,
      { [cellId(root)]: rows[4] },
      new Set(),
      read,
      tables,
    );
    expect(chosen.entries[1].result.row).toBe(4);
  });
  it("starts mixed windows at the selected scalar row and defers long branches", async () => {
    const root = input("root"),
      selected = input("upstream", 3),
      branch = input("long");
    const read = reader([
      result(root, [input("upstream", 0)], {
        operands: [
          {
            id: "0",
            formula: "amount",
            value: 10,
            aggregate: false,
            operation: "expression",
            total: 2,
            contributions: [selected, branch],
          },
        ],
      }),
      result(selected, [input("source", 3, true)]),
    ]);
    const graph = await buildLineageGraph(root, {}, new Set(), read, {
      ...tables,
      edges: [
        { source: "a", target: "long" },
        { source: "b", target: "a" },
        { source: "c", target: "b" },
      ],
    });
    expect(graph.entries[1].result.row).toBe(3);
    expect(graph.entries[0].children[1].deferred).toBe(true);
    expect(read.mock.calls.some(([cell]) => cell.dataset === "long")).toBe(
      false,
    );
  });
  it("reports each step once it is read, before the steps after it", async () => {
    const root = input("root"),
      middle = input("middle"),
      source = input("source", 0, true);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const data = new Map(
      [result(root, [middle]), result(middle, [source])].map((r) => [
        cellId(r),
        r,
      ]),
    );
    const steps: { nodes: (string | undefined)[]; complete: boolean }[] = [];
    const building = buildLineageGraph(
      root,
      {},
      new Set(),
      async (query) => {
        // The step after the root stays unread until the test releases it.
        if (query.dataset === "middle") await held;
        return data.get(cellId(query))!;
      },
      tables,
      (graph) =>
        steps.push({
          nodes: graph.entries.map((e) => e.result.node),
          complete: graph.complete,
        }),
    );
    await vi.waitFor(() => expect(steps).toHaveLength(1));
    // The root is shown with the input it leads to, which is not traced yet.
    expect(steps[0]).toEqual({ nodes: ["root"], complete: false });
    release();
    const graph = await building;
    expect(steps.map((step) => step.nodes)).toEqual([
      ["root"],
      ["root", "middle"],
      ["root", "middle", "source"],
    ]);
    expect(steps.every((step) => !step.complete)).toBe(true);
    expect(graph.complete).toBe(true);
    expect(graph.entries.map((e) => e.result.node)).toEqual(steps[2].nodes);
    expect(graph.entries[0].children.map((c) => c.id)).toEqual([
      cellId(middle),
    ]);
  });
  it("shares ancestors and stops an incomplete branch", async () => {
    const root = input("root"),
      left = input("left"),
      right = input("right"),
      source = input("source", 0, true);
    const graph = await buildLineageGraph(
      root,
      {},
      new Set(),
      reader([
        result(root, [left, right]),
        result(left, [source]),
        result(right, [source]),
      ]),
      tables,
    );
    expect(graph.entries.filter((e) => e.result.source)).toHaveLength(1);
    const limited = await buildLineageGraph(
      root,
      {},
      new Set(),
      reader([
        result(root, [source], { complete: false, warnings: ["Unsupported"] }),
      ]),
      tables,
    );
    expect(limited.entries).toHaveLength(1);
  });
});

it("round trips a generation-bound URL without discarding unrelated parameters", () => {
  const target = {
    node: "report::summary::metrics",
    port: "report",
    direction: "origin" as const,
    cell: {
      dataset: "result",
      node: "report::summary::metrics",
      row: 3,
      column: "net share",
    },
  };
  const url = writeLineageTarget(new URLSearchParams("env=dev"), target);
  expect(readLineageTarget(url)).toMatchObject(target);
  expect(writeLineageTarget(url, null).toString()).toBe(
    "env=dev&node=report%3A%3Asummary%3A%3Ametrics",
  );
});

it("round trips column exploration without a dataset or row", () => {
  const target = {
    node: "report",
    port: "report",
    column: "net_share",
    direction: "origin" as const,
  };
  const url = writeLineageTarget(new URLSearchParams("env=dev"), target);
  expect(readLineageTarget(url)).toMatchObject(target);
  expect(readLineageTarget(url)?.cell).toBeUndefined();
  expect(url.has("dataset")).toBe(false);
  expect(url.has("row")).toBe(false);
});
