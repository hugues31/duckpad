import { expect, it } from "vitest";
import { executionFailures } from "./executionFailures";
import type { NodeResult, Statuses } from "./types";

const failed: NodeResult = {
  outputs: {},
  error: 'Referenced column "region" not found',
  error_run: "run-1",
  execution_status: "failed",
};
const blocked: NodeResult = {
  outputs: {},
  error: "Blocked by report::summary::metrics",
  error_run: "run-1",
  execution_status: "blocked",
  error_causes: [{ ...failed, node: "report::summary::metrics" }],
};
const statuses: Statuses = {
  active: null,
  nodes: {
    "report::summary::filter": {
      outputs: {},
      error: null,
      execution_status: "success",
    },
    "report::summary::metrics": failed,
    "report::rank": blocked,
    export: blocked,
    "report-other::query": failed,
  },
};

it("finds a component's nested root failure once, regardless of its first output", () => {
  expect(executionFailures(statuses, "report")).toEqual([
    {
      node: "report::summary::metrics",
      result: { ...failed, node: "report::summary::metrics" },
    },
  ]);
});

it("explains downstream blockers and keeps independent causes", () => {
  expect(executionFailures(statuses, "export")[0].result.error).toContain(
    '"region"',
  );
  const second = { ...failed, node: "other", error: "Another failure" };
  expect(
    executionFailures(
      {
        active: null,
        nodes: {
          export: {
            ...blocked,
            error_causes: [...blocked.error_causes!, second],
          },
        },
      },
      "export",
    ).map((failure) => failure.node),
  ).toEqual(["report::summary::metrics", "other"]);
});

it("keeps direct validation errors and clears after success or an environment switch", () => {
  expect(
    executionFailures(
      { active: null, nodes: { query: { ...blocked, error_causes: [] } } },
      "query",
    )[0].result.error,
  ).toBe(blocked.error);
  const environments: Statuses["nodes"][] = [
    {},
    { query: { ...failed, error: null } },
  ];
  for (const nodes of environments)
    expect(executionFailures({ active: null, nodes }, "query")).toEqual([]);
});
