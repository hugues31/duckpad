// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { nodeInterface } from "./graph";
import ResultsTests, { declaredTests } from "./ResultsTests";
import type { ExecutionResult, FlowNode, NodeResult, Snapshot } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const code = `import duckpad as dp


class Split(dp.Node):
    def run(self, orders: dp.Relation) -> dp.Relation:
        self.check("amount_present", orders.filter("amount IS NULL"), severity="warning")
        self.check("ids_positive", orders.filter("id <= 0"))
        return orders
`;
const node: FlowNode = {
  id: "split",
  language: "python",
  params: {},
  position: { x: 0, y: 0 },
};
const snapshot = {
  worktree: { id: "tree" },
  bundle: { templates: {}, node_sql: { "nodes/split.py": code } },
} as unknown as Snapshot;
const check = (
  name: string,
  observed: number,
  status: "ok" | "warning",
): ExecutionResult => ({
  level: status === "ok" ? "info" : status,
  status,
  message: observed
    ? `Test ${name} failed: ${observed} failing rows`
    : `Test ${name} passed`,
  origin: { kind: "test", name, block: "Python" },
  output: null,
  observed,
});
const results = [
  check("amount_present", 1, "warning"),
  check("ids_positive", 0, "ok"),
  {
    level: "info",
    message: "done",
    origin: { kind: "message", block: "Python" },
  },
] as ExecutionResult[];

const renderTests = (tests: string[], result?: NodeResult) =>
  render(
    <MemoryRouter>
      <ResultsTests
        snapshot={snapshot}
        environment="dev"
        node={node}
        fullNode="split"
        tests={tests}
        result={result}
        refresh=""
        canShowRows
        readOnly={false}
        onShowRows={() => {}}
        onEditCode={() => {}}
      />
    </MemoryRouter>,
  );

it("lists the checks a Python node ran, each once", () => {
  const signature = nodeInterface(
    { id: "split" },
    {},
    {},
    { split: { language: "python", blocks: [] } },
  );
  expect(declaredTests(signature, [...results, results[0]])).toEqual([
    "amount_present",
    "ids_positive",
  ]);
  expect(declaredTests(signature)).toEqual([]);
});

it("shows Python checks with their outcome and severity, without SQL failing rows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("[]", { headers: { "content-type": "application/json" } }),
    ),
  );
  const { container } = renderTests(["amount_present", "ids_positive"], {
    results,
    outputs: {},
    error: null,
  });
  expect(screen.queryByText("This node declares no tests")).toBeNull();
  const rows = [...container.querySelectorAll(".test-row")].map((row) =>
    [...row.querySelectorAll("td")].slice(0, 3).map((cell) => cell.textContent),
  );
  expect(rows).toEqual([
    ["Warning", "amount_present", "Warning"],
    ["OK", "ids_positive", "Error"],
  ]);
  // Failing rows are recomputed from SQL test queries; Python checks keep none.
  expect(screen.queryByRole("button", { name: /failing row/ })).toBeNull();
  expect(screen.queryByText(/recomputed on demand/)).toBeNull();
});

it("explains self.check for a Python node without checks, without SQL test tips", () => {
  renderTests([]);
  expect(screen.getByText("No Python checks in the latest run")).toBeTruthy();
  expect(
    screen.getByText(
      "Define Python checks with self.check() in the node code.",
    ),
  ).toBeTruthy();
  expect(document.querySelector("pre")?.textContent).toContain("self.check(");
  expect(screen.queryByText(/-- @test/)).toBeNull();
  expect(screen.queryByText(/Create a test from this filter/)).toBeNull();
});
