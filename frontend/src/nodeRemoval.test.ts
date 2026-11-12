import { expect, it } from "vitest";
import { removeFlowNodes } from "./flowEdits";
import { planNodeReconnection } from "./nodeRemoval";
import type { FlowEdge, Snapshot } from "./types";

const edge = (source: string, target: string): FlowEdge => ({
  id: `${source}_${target}`,
  source,
  target,
  sourceHandle: "result",
  targetHandle: "source",
});
function snapshot(): Snapshot {
  return {
    bundle: {
      flow: {
        nodes: ["a", "b", "c", "d"].map((id) => ({
          id,
          params: {},
          position: { x: 20, y: 30 },
        })),
        edges: [edge("a", "b"), edge("b", "c"), edge("b", "d")],
      },
      node_sql: { "nodes/b.sql": "SELECT * FROM {{ source }};" },
      templates: {},
      components: {},
      documentation: {},
    },
    parsed_nodes: Object.fromEntries(
      ["a", "b", "c", "d"].map((id) => [
        `nodes/${id}.sql`,
        { inputs: ["source"], outputs: ["result"], parameters: [] },
      ]),
    ),
    parsed_templates: {},
  } as unknown as Snapshot;
}

it.each(["sql", "python"])(
  "reconnects every consumer and removes only the owned %s code",
  (language) => {
    const base = snapshot();
    const value = base.bundle!;
    if (language === "python") {
      value.flow.nodes[1].language = "python";
      value.node_sql!["nodes/b.py"] = "class Step: pass";
      base.parsed_nodes!["nodes/b.py"] = base.parsed_nodes!["nodes/b.sql"];
      delete value.node_sql!["nodes/b.sql"];
      delete base.parsed_nodes!["nodes/b.sql"];
    }
    value.templates.shared = "SELECT 1;";
    value.flow.edges.push({ ...edge("c", "d"), targetHandle: "other" });
    base.parsed_nodes!["nodes/d.sql"].inputs!.push("other");
    const before = structuredClone(value);
    const plan = planNodeReconnection(base, "b");
    expect(plan).not.toBeNull();
    expect(value).toEqual(before);
    removeFlowNodes(value, [], ["b"], [], plan!);
    expect(value.flow.nodes).toEqual(
      before.flow.nodes.filter((node) => node.id !== "b"),
    );
    expect(value.flow.edges).toEqual([
      before.flow.edges[3],
      { ...before.flow.edges[1], source: "a" },
      { ...before.flow.edges[2], source: "a" },
    ]);
    expect(value.templates.shared).toBe("SELECT 1;");
    expect(Object.keys(value.node_sql!)).toEqual([]);
  },
);

it("preserves the upstream output and each consumer's input, without requiring matching names", () => {
  const base = snapshot();
  base.parsed_nodes!["nodes/a.sql"].outputs = ["orders", "customers"];
  base.bundle!.flow.edges[0].sourceHandle = "orders";
  base.parsed_nodes!["nodes/d.sql"].inputs = ["rows"];
  base.bundle!.flow.edges[2].targetHandle = "rows";
  expect(planNodeReconnection(base, "b")).toEqual([
    { ...edge("b", "c"), source: "a", sourceHandle: "orders" },
    {
      ...edge("b", "d"),
      source: "a",
      sourceHandle: "orders",
      targetHandle: "rows",
    },
  ]);
});

it("keeps ordinary deletion disconnected", () => {
  const base = snapshot();
  removeFlowNodes(base.bundle!, [], ["b"]);
  expect(base.bundle!.flow.edges).toEqual([]);
});

it.each([
  "source",
  "sink",
  "join",
  "multiple outputs",
  "external write",
  "invalid interface",
  "component",
  "unconnected",
  "multiple sources",
  "missing source",
  "missing consumer",
  "wrong source port",
  "wrong input port",
  "wrong output port",
  "wrong consumer port",
  "occupied input",
  "duplicate edge",
  "self-link",
])("refuses %s without mutating the graph", (scenario) => {
  const base = snapshot();
  const graph = base.bundle!.flow;
  const parsed = base.parsed_nodes!["nodes/b.sql"];
  switch (scenario) {
    case "source":
      parsed.inputs = [];
      break;
    case "sink":
      parsed.outputs = [];
      break;
    case "join":
      parsed.inputs!.push("other");
      break;
    case "multiple outputs":
      parsed.outputs!.push("other");
      break;
    case "external write":
      parsed.writes_external = true;
      break;
    case "invalid interface":
      parsed.error = "Invalid code";
      break;
    case "component":
      graph.nodes[1].component = "box";
      break;
    case "unconnected":
      graph.edges.shift();
      break;
    case "multiple sources":
      graph.edges.push(edge("d", "b"));
      break;
    case "missing source":
      graph.nodes.shift();
      break;
    case "missing consumer":
      graph.nodes.pop();
      break;
    case "wrong source port":
      graph.edges[0].sourceHandle = "absent";
      break;
    case "wrong input port":
      graph.edges[0].targetHandle = "absent";
      break;
    case "wrong output port":
      graph.edges[1].sourceHandle = "absent";
      break;
    case "wrong consumer port":
      graph.edges[1].targetHandle = "absent";
      break;
    case "occupied input":
      graph.edges.push(edge("a", "c"));
      break;
    case "duplicate edge":
      graph.edges.push({ ...edge("b", "c"), id: "duplicate" });
      break;
    case "self-link":
      graph.edges[1].target = "a";
      break;
  }
  const before = structuredClone(base);
  expect(planNodeReconnection(base, "b")).toBeNull();
  expect(base).toEqual(before);
});

it("does not reconnect component internals", () => {
  expect(planNodeReconnection(snapshot(), "b", "box")).toBeNull();
});
