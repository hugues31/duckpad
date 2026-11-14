// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import ResultsColumns from "./ResultsColumns";
import type {
  ColumnStatistics,
  Dataset,
  ResultStatistics,
  Snapshot,
} from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const columns = [
  { name: "region", type: "VARCHAR" },
  { name: "revenue", type: "HUGEINT" },
  { name: "average_order", type: "DOUBLE" },
];
const dataset: Dataset = {
  id: "regional_result",
  node: "regional",
  port: "result",
  columns,
  count: 3,
  run: "run",
  status: "valid",
  created: "2026-11-09T19:00:00Z",
};
const column = (bounds?: [string, string]): ColumnStatistics => ({
  type: "",
  nulls: 0,
  distinct: 3,
  count: 3,
  unique: true,
  ...(bounds && { min: bounds[0], max: bounds[1], histogram: [1, 1, 1] }),
});

it("rounds long decimals in the range and shows the exact bounds on hover", async () => {
  const statistics: ResultStatistics = {
    dataset: dataset.id,
    status: "valid",
    count: 3,
    columns,
    statistics: {
      computed: "2026-11-09T19:00:00Z",
      duration: 0.1,
      count: 3,
      columns: {
        region: column(),
        revenue: column(["8823", "11742"]),
        average_order: column(["245.5", "280.11764705882354"]),
      },
    },
    schema: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(statistics), {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  render(
    <MemoryRouter>
      <ResultsColumns
        snapshot={{ worktree: { id: "tree" }, bundle: null } as Snapshot}
        environment="dev"
        target={{ node: "regional", port: "result" }}
        dataset={dataset}
        canEdit={false}
        onSaveDocumentation={async () => undefined}
        onColumn={() => {}}
      />
    </MemoryRouter>,
  );
  const average = await screen.findByText("245.5 … 280.12");
  expect(average.getAttribute("title")).toBe("245.5 … 280.11764705882354");
  // Bounds shown in full need no hover text.
  expect(screen.getByText("8823 … 11742").hasAttribute("title")).toBe(false);
});
