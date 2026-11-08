import { expect, it } from "vitest";
import { primaryOutputCount, showMinimap } from "./canvasResults";
import type { ComponentDefinition, FlowNode, Statuses } from "./types";

it("shows zero rows, selects the primary output and follows component boundaries", () => {
  const statuses = {
    nodes: {
      node: { outputs: { result: { count: 0 }, rejects: { count: 8 } } },
      "report::source": { outputs: { summary: { count: 42 } } },
    },
  } as unknown as Statuses;
  const node = { id: "node" } as FlowNode;
  expect(
    primaryOutputCount(node, "node", ["rejects", "result"], {}, statuses),
  ).toBe(0);
  expect(
    primaryOutputCount(node, "missing", ["result"], {}, statuses),
  ).toBeUndefined();
  expect(primaryOutputCount(node, "node", [], {}, statuses)).toBeUndefined();
  const components = {
    report: {
      nodes: [{ id: "source" }],
      outputs: { result: { node: "source", port: "summary" } },
    },
  } as unknown as Record<string, ComponentDefinition>;
  expect(
    primaryOutputCount(
      { ...node, component: "report" },
      "report",
      ["result"],
      components,
      statuses,
    ),
  ).toBe(42);
});

it("hides the minimap when panels leave little canvas space", () => {
  expect(showMinimap(900, 600)).toBe(true);
  expect(showMinimap(900, 300)).toBe(false);
  expect(showMinimap(450, 600)).toBe(false);
});
