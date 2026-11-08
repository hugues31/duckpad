import { expect, it } from "vitest";
import {
  copiedNodes,
  copyNodes,
  PASTE_OFFSET,
  pasteNodes,
} from "./nodeClipboard";
import type { Bundle, FlowNode } from "./types";

const node = (id: string, fields: Partial<FlowNode> = {}): FlowNode => ({
  id,
  params: {},
  position: { x: 100, y: 50 },
  ...fields,
});

function bundle(): Bundle {
  return {
    flow: {
      id: "flow",
      name: "Flow",
      nodes: [
        node("source", { template: "load_csv", params: { file: "a.csv" } }),
        node("filter", {
          preset: "filter",
          params: { condition: "amount > 1" },
          position: { x: 300, y: 50 },
        }),
        node("group", { component: "shared", position: { x: 500, y: 50 } }),
        node("other", { position: { x: 700, y: 50 } }),
      ],
      edges: [
        {
          id: "a",
          source: "source",
          sourceHandle: "result",
          target: "filter",
          targetHandle: "source",
        },
        {
          id: "b",
          source: "filter",
          sourceHandle: "result",
          target: "other",
          targetHandle: "source",
        },
      ],
    },
    templates: { load_csv: "SELECT 1" },
    node_sql: {
      "nodes/filter.sql": "SELECT * FROM {{ source }} WHERE {{ condition }}",
    },
    components: {
      shared: { name: "Shared", nodes: [node("inner")], edges: [] },
    },
    documentation: {},
  } as unknown as Bundle;
}

it("pastes copies with new IDs, their code and the edges between them", () => {
  const value = bundle();
  const copied = copyNodes(value, undefined, ["source", "filter"])!;
  expect(copiedNodes()).toBe(copied);
  expect(copied.edges.map((edge) => edge.id)).toEqual(["a"]);
  const ids = pasteNodes(value, undefined, copied, []);
  expect(ids).toHaveLength(2);
  const [source, filter] = ids.map((id) =>
    value.flow.nodes.find((n) => n.id === id)!,
  );
  expect(source).toMatchObject({
    template: "load_csv",
    params: { file: "a.csv" },
    position: { x: 100 + PASTE_OFFSET, y: 50 + PASTE_OFFSET },
  });
  expect(filter).toMatchObject({
    preset: "filter",
    params: { condition: "amount > 1" },
  });
  expect(value.node_sql![`nodes/${filter.id}.sql`]).toBe(
    value.node_sql!["nodes/filter.sql"],
  );
  expect(value.flow.edges.at(-1)).toMatchObject({
    source: source.id,
    target: filter.id,
    sourceHandle: "result",
    targetHandle: "source",
  });
  expect(value.flow.edges.at(-1)!.id).not.toBe("a");
  // The copy is independent of later edits of the original.
  value.flow.nodes[0].params.file = "b.csv";
  expect(copied.nodes[0].params.file).toBe("a.csv");
});

it("shifts each paste past the earlier ones", () => {
  const value = bundle();
  const copied = copyNodes(value, undefined, ["source"])!;
  const first = pasteNodes(value, undefined, copied, [])[0];
  const second = pasteNodes(value, undefined, copied, [])[0];
  const position = (id: string) =>
    value.flow.nodes.find((n) => n.id === id)!.position;
  expect(position(first).x).toBe(100 + PASTE_OFFSET);
  expect(position(second).x).toBe(100 + 2 * PASTE_OFFSET);
});

it("pastes into a component, keeping code of templates it lacks", () => {
  const value = bundle();
  const copied = copyNodes(value, undefined, ["source", "group"])!;
  delete (value.templates as Record<string, string>).load_csv;
  const ids = pasteNodes(value, "shared", copied, ["shared"]);
  // The component cannot contain itself.
  expect(ids).toHaveLength(1);
  const pasted = value.components.shared.nodes.find((n) => n.id === ids[0])!;
  expect(pasted.template).toBeUndefined();
  expect(pasted.preset).toBe("load_csv");
  expect(value.node_sql![`components/shared/${ids[0]}.sql`]).toBe("SELECT 1");
  // Nothing covers the inner node at the original position.
  expect(pasted.position).toEqual({
    x: 100 + PASTE_OFFSET,
    y: 50 + PASTE_OFFSET,
  });
});
