import { expect, it } from "vitest";
import {
  insertOnEdge,
  planEdgeInsertion,
  type InsertionContext,
} from "./edgeInsertion";
import type { FlowEdge } from "./types";

const link = (source: string, target: string): FlowEdge => ({
  id: `${source}_${target}`,
  source,
  target,
  sourceHandle: "rows",
  targetHandle: "data",
});
function context(): InsertionContext {
  return {
    nodes: ["a", "b", "c", "d"].map((id) => ({
      id,
      template: "step",
      params: {},
      position: { x: 0, y: 0 },
    })),
    edges: [link("a", "b"), link("a", "d")],
    parsed: { step: { inputs: ["data"], outputs: ["rows"] } },
    components: {},
    local: { c: { inputs: ["incoming"], outputs: ["outgoing"] } },
  };
}

it("splits only the chosen branch and preserves endpoint ports and node configuration", () => {
  const graph = context();
  const before = structuredClone(graph);
  const plan = planEdgeInsertion(graph, graph.nodes[2], graph.edges[0]);
  expect(plan).not.toBeNull();
  expect(graph).toEqual(before);
  insertOnEdge(graph, "c", plan!);
  expect(graph.nodes).toEqual(before.nodes);
  expect(graph.edges).toEqual([
    { ...before.edges[0], source: "c", sourceHandle: "outgoing" },
    before.edges[1],
    {
      id: expect.any(String),
      source: "a",
      sourceHandle: "rows",
      target: "c",
      targetHandle: "incoming",
    },
  ]);
});

it("uses a component's exposed ports and permits existing consumers without cycles", () => {
  const graph = context();
  graph.nodes[2] = { ...graph.nodes[2], component: "box" };
  graph.components.box = {
    nodes: [],
    edges: [],
    inputs: { input: { node: "inner", port: "data" } },
    outputs: { output: { node: "inner", port: "rows" } },
  };
  graph.edges.push({ ...link("c", "d"), targetHandle: "other" });
  expect(
    planEdgeInsertion(graph, graph.nodes[2], graph.edges[0]),
  ).toMatchObject({ input: "input", output: "output" });
});

it.each([
  "source",
  "sink",
  "ambiguous input",
  "ambiguous output",
  "invalid code",
  "occupied input",
  "exposed input",
  "incident edge",
  "cycle",
  "missing endpoint",
  "missing endpoint port",
  "duplicate input",
])("does not insert a node with %s", (scenario) => {
  const graph = context();
  const node = graph.nodes[2];
  const ports = graph.local!.c;
  switch (scenario) {
    case "source":
      ports.inputs = [];
      break;
    case "sink":
      ports.outputs = [];
      break;
    case "ambiguous input":
      ports.inputs!.push("other");
      break;
    case "ambiguous output":
      ports.outputs!.push("other");
      break;
    case "invalid code":
      ports.error = "Invalid code";
      break;
    case "occupied input":
      graph.edges.push(link("d", "c"));
      break;
    case "exposed input":
      graph.exposedInputs = { external: { node: "c", port: "incoming" } };
      break;
    case "incident edge":
      node.id = "a";
      break;
    case "cycle":
      graph.edges.push(link("c", "d"), link("d", "a"));
      break;
    case "missing endpoint":
      graph.nodes.shift();
      break;
    case "missing endpoint port":
      graph.edges[0].sourceHandle = "missing";
      break;
    case "duplicate input":
      graph.edges.push(link("d", "b"));
      break;
  }
  const before = structuredClone(graph);
  expect(planEdgeInsertion(graph, node, graph.edges[0])).toBeNull();
  expect(graph).toEqual(before);
});

it.each(["deleted edge", "changed edge", "connected input", "deleted node"])(
  "leaves the graph intact if the drop target changed: %s",
  (scenario) => {
    const graph = context();
    const plan = planEdgeInsertion(graph, graph.nodes[2], graph.edges[0])!;
    if (scenario === "deleted edge") graph.edges.shift();
    if (scenario === "changed edge")
      graph.edges[0] = { ...graph.edges[0], targetHandle: "new" };
    if (scenario === "connected input") graph.edges.push(link("d", "c"));
    if (scenario === "deleted node") graph.nodes.splice(2, 1);
    const before = structuredClone(graph);
    insertOnEdge(graph, "c", plan);
    expect(graph).toEqual(before);
  },
);
