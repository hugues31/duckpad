import { expect, it } from "vitest";
import { resolveNodePath, outputSource } from "./graph";
import { nodeLocation, setNodeCode } from "./nodeCode";
import type { Bundle, FlowNode } from "./types";

const node = (id: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  position: { x: 0, y: 0 },
  params: {},
  ...extra,
});
const bundle = (): Bundle => ({
  flow: {
    id: "flow",
    name: "Flow",
    nodes: [node("outer", { component: "shared" })],
    edges: [],
  },
  components: {
    shared: {
      name: "Shared",
      nodes: [node("inner", { component: "leaf" })],
      edges: [],
      inputs: {},
      outputs: { result: { node: "inner", port: "result" } },
    },
    leaf: {
      nodes: [node("python", { language: "python" })],
      edges: [],
      inputs: {},
      outputs: { result: { node: "python", port: "result" } },
    },
  },
  templates: { linked: "SELECT 1" },
  documentation: {},
});

it("resolves nested instances to the same authored node for navigation, code, and output lookup", () => {
  const value = bundle();
  const location = resolveNodePath(value, "outer::inner::python")!;
  expect(location.path.map((part) => [part.instance, part.definition])).toEqual(
    [
      ["outer", "shared"],
      ["inner", "leaf"],
    ],
  );
  expect(nodeLocation(value, "outer::inner::python")).toEqual({
    node: location.node,
    parent: "leaf",
  });
  expect(outputSource(value, "outer", "result")).toEqual({
    node: "outer::inner::python",
    port: "result",
  });
  expect(resolveNodePath(value, "outer::missing::python")).toBeNull();
  expect(resolveNodePath(value, "outer::inner::missing")).toBeNull();
  setNodeCode(value, location.node, "print('updated')", location.parent);
  expect(value.node_sql).toEqual({
    "components/leaf/python.py": "print('updated')",
  });
});

it("updates linked templates and local SQL without changing other code", () => {
  const value = bundle();
  setNodeCode(value, node("linked", { template: "linked" }), "SELECT 2");
  setNodeCode(value, node("local"), "SELECT 3");
  expect(value.templates.linked).toBe("SELECT 2");
  expect(value.node_sql).toEqual({ "nodes/local.sql": "SELECT 3" });
  expect(() => setNodeCode(value, value.flow.nodes[0], "invalid")).toThrow(
    "component instance has no code",
  );
});
