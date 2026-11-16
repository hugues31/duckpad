import { expect, it } from "vitest";
import {
  addFlowFilter,
  addFlowNode,
  dropFlowFiles,
  removeFlowNodes,
} from "./flowEdits";
import type { Bundle, FlowNode } from "./types";

const node = (id: string, params: FlowNode["params"] = {}): FlowNode => ({
  id,
  params,
  position: { x: 0, y: 0 },
});
const bundle = (): Bundle =>
  ({
    flow: { id: "flow", name: "Flow", nodes: [], edges: [] },
    templates: {},
    node_sql: {},
    components: {},
    documentation: {},
  }) as unknown as Bundle;

it("edits nodes and files without losing owned code or independent edges", () => {
  const value = bundle();
  value.templates.source = "-- @output result\nSELECT 1 AS amount;";
  const source = { ...node("source"), template: "source" };
  addFlowNode(value, [], source, "template", false);
  expect(source.template).toBeUndefined();
  expect(value.node_sql?.["nodes/source.sql"]).toContain("SELECT 1");
  const selected = dropFlowFiles(
    value,
    [],
    [
      {
        id: "file",
        name: "data.csv",
        path: "data.csv",
        template: "load_csv",
        code: "SELECT 2;",
        settings: { header: true },
      },
    ],
    { x: 10, y: 20 },
  );
  expect(selected).toBe("file");
  const filtered = node("filtered");
  addFlowFilter(value, [], filtered, source, "result", false, undefined);
  expect(value.flow.edges[0]).toMatchObject({
    source: "source",
    target: "filtered",
  });
  removeFlowNodes(value, [], ["source"]);
  expect(value.flow.nodes.map((n) => n.id)).not.toContain("source");
  expect(value.flow.edges).toEqual([]);
  expect(value.node_sql).not.toHaveProperty("nodes/source.sql");
});
