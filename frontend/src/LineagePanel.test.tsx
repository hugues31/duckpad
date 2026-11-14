// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import type { LineageTarget } from "./lineageGraph";
import { MemoryRouter } from "react-router";
import LineagePanel from "./LineagePanel";
import type { Explanation } from "./lineageGraph";

const worktree = {
  id: "tree",
  environment: "dev",
  snapshot: { node_names: {}, connections: [], revision: "revision" },
  statuses: {},
  starting: false,
};
vi.mock("./worktree", () => ({ useLoadedWorktree: () => worktree }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

/** A cell of a Python result; Python reports parents but no cell mapping. */
const python = (
  row: number,
  parents: Explanation["parents"] = [],
): Explanation => ({
  dataset: "split_result",
  node: "split",
  port: "result",
  row,
  column: "amount",
  value: row + 0.5,
  kind: "python",
  expression: "Opaque Python operation",
  complete: false,
  warnings: [],
  total: 0,
  page_size: 5,
  contributions: [],
  context_total: 0,
  parents,
});

/** Answer lineage requests; a held dataset answers once its promise resolves. */
function serve(
  explanations: Record<string, Explanation>,
  held: Record<string, Promise<void>> = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes("/lineage/tables"))
        return json({ node: "total", seeds: ["total"], nodes: {}, edges: [] });
      if (url.includes("/generations/")) return json({ valid: true });
      const query = JSON.parse(String(options?.body));
      await held[query.dataset];
      return json(explanations[`${query.dataset}:${query.row}`]);
    }),
  );
}

function Explorer({ dataset, row }: { dataset: string; row: number }) {
  const [target, onChange] = useState<LineageTarget | null>({
    node: "total",
    direction: "origin",
    cell: { dataset, row, column: "amount" },
  });
  return (
    target && (
      <LineagePanel
        target={target}
        onChange={onChange}
        onClose={() => onChange(null)}
        onMap={ignore}
        onHover={ignore}
        onOpen={ignore}
        onLocate={() => {}}
        onRows={ignore}
      />
    )
  );
}
const ignore = () => {};
const open = (dataset: string, row: number) =>
  render(
    <MemoryRouter>
      <Explorer dataset={dataset} row={row} />
    </MemoryRouter>,
  );

it("names the Python boundary once and lists its parents on one card", async () => {
  const orders = {
    dataset: "orders_result",
    node: "orders",
    port: "result",
    run: "run",
    count: 1,
    columns: [{ name: "amount", type: "DOUBLE" }],
    rows: [{ row: 0, values: [10.5] }],
  };
  serve({
    "total:0": {
      dataset: "total",
      node: "total",
      port: "result",
      row: 0,
      column: "amount",
      value: 2,
      kind: "aggregate",
      calculation: {
        operation: "sum",
        formula: "sum(amount)",
        passthrough: false,
      },
      complete: true,
      warnings: [],
      total: 2,
      page_size: 5,
      contributions: [python(0), python(1)].map((cell) => ({ ...cell })),
      context_total: 0,
    },
    "split_result:0": python(0, [orders]),
    "split_result:1": python(1, [orders]),
    "orders_result:0": {
      dataset: "orders_result",
      node: "orders",
      port: "result",
      row: 0,
      column: "amount",
      value: 10.5,
      kind: "source",
      complete: true,
      warnings: [],
      total: 1,
      page_size: 5,
      contributions: [],
      context_total: 0,
    },
  });
  open("total", 0);
  await screen.findAllByText("Opaque Python operation");
  expect(document.querySelectorAll(".lineage-parents")).toHaveLength(1);
  expect(
    screen.getAllByText(/Select a cell from these captured parent results/),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Trace amount, row 1" }));
  await screen.findByText("10.5", { selector: ".lineage-formula span" });
  expect(document.querySelector(".lineage-parents")).toBeNull();
});

it("does not ask to select parent cells of a Python source", async () => {
  serve({ "split_result:0": python(0) });
  open("split_result", 0);
  await screen.findByText("Opaque Python operation");
  expect(screen.queryByText(/captured parent results/)).toBeNull();
  expect(document.querySelector(".lineage-parents")).toBeNull();
});

it("shows the steps traced so far while the next one is read", async () => {
  const step = (
    node: string,
    contributions: Explanation["contributions"],
  ): Explanation => ({
    dataset: node,
    node,
    port: "result",
    row: 0,
    column: "amount",
    value: 10,
    kind: "projection",
    calculation: {
      operation: "expression",
      formula: "amount * 1",
      passthrough: false,
    },
    complete: true,
    warnings: [],
    total: contributions.length,
    page_size: 5,
    contributions,
    context_total: 0,
  });
  const orders = { ...step("orders", []), source: true };
  const upstream = step("upstream", [orders]);
  let release = () => {};
  serve(
    { "total:0": step("total", [upstream]), "upstream:0": upstream },
    { upstream: new Promise<void>((resolve) => (release = resolve)) },
  );
  open("total", 0);
  await waitFor(() =>
    expect(document.querySelectorAll(".lineage-step")).toHaveLength(1),
  );
  // The next step is announced below the path already shown.
  expect(document.querySelector(".lineage-path + .lineage-loading")).not.toBe(
    null,
  );
  release();
  await waitFor(() =>
    expect(document.querySelectorAll(".lineage-step")).toHaveLength(3),
  );
  await waitFor(() =>
    expect(document.querySelector(".lineage-loading")).toBe(null),
  );
});
