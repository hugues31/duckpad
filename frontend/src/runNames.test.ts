import { expect, it } from "vitest";
import { runScopeLabel } from "./runNames";
import en from "./locales/en.json";
import type { Run } from "./types";

it("uses captured scope names including component paths and unnamed historical runs", () => {
  const run = {
    scope: "node_1",
    nodes: { node_1: { label: "Revenue" } },
  } as unknown as Run;
  expect(runScopeLabel(run, (key) => en[key])).toBe("Revenue");
  expect(
    runScopeLabel(
      { ...run, scope_name: [{ label: "Finance" }, { label: "Report" }] },
      (key) => en[key],
    ),
  ).toBe("Finance / Report");
  expect(runScopeLabel({ ...run, nodes: {} }, (key) => en[key])).toBe(en.node);
  expect(runScopeLabel({ ...run, scope: "project" }, (key) => en[key])).toBe(
    en.fullRun,
  );
  expect(
    runScopeLabel(
      {
        ...run,
        nodes: {},
        flow: {
          id: "project",
          name: "Project",
          edges: [],
          nodes: [
            {
              id: "node_1",
              component: "report",
              params: {},
              position: { x: 0, y: 0 },
            },
          ],
        },
        components: {
          report: { name: "Historical report", nodes: [], edges: [] },
        },
      },
      (key) => en[key],
    ),
  ).toBe("Historical report");
});
