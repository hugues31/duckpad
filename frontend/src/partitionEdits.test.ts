import { expect, it } from "vitest";
import type { Translate } from "./i18n";
import en from "./locales/en.json";
import { applyPartitionDraft } from "./partitionEdits";
import type { Bundle, FlowNode } from "./types";

const t: Translate = (key) => en[key];
const definition = {
  type: "text" as const,
  values: { node: "keys", column: "batch" },
  attributes: ["task"],
};

function partitioned() {
  const source: FlowNode = {
    id: "source",
    params: { path: "{{ partition.task }}" },
    position: { x: 0, y: 0 },
    outputs: { result: { partition: { by: "batch", column: "batch" } } },
  };
  const value = {
    flow: {
      id: "flow",
      name: "Flow",
      nodes: [source],
      edges: [],
      partitions: { batch: definition },
    },
    templates: {},
    components: {},
  } as unknown as Bundle;
  return { value, source };
}

it("renames partition dimensions and attributes and rejects deleting a used attribute", () => {
  const { value, source } = partitioned();
  applyPartitionDraft(value, "files", definition, "task", { task: "file" }, t);
  expect(value.flow.nodes[0].params.path).toBe("{{ partition.file }}");
  expect(source.outputs!.result.partition?.by).toBe("files");
  expect(value.flow.partitions!.files.attributes).toEqual(["file"]);
  expect(() =>
    applyPartitionDraft(value, "files", definition, "", {}, t),
  ).toThrow(en.partitionAttributeUsed);
  expect(() =>
    applyPartitionDraft(value, "bad name", definition, "file", {}, t),
  ).toThrow(en.partitionInvalidName);
});

it("trims listed attributes and rejects duplicates", () => {
  const { value } = partitioned();
  applyPartitionDraft(value, "batch", definition, " task , day ", {}, t);
  expect(value.flow.partitions!.batch.attributes).toEqual(["task", "day"]);
  expect(() =>
    applyPartitionDraft(value, "batch", definition, "task, task", {}, t),
  ).toThrow(en.partitionInvalidName);
});
