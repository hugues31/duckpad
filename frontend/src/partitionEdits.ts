import type { Translate } from "./i18n";
import {
  renamePartitionReferences,
  type PartitionDefinition,
} from "./partitions";
import type { Bundle, FlowNode } from "./types";
export function applyPartitionDraft(
  bundle: Bundle,
  name: string,
  draft: PartitionDefinition,
  attributes: string,
  renames: Record<string, string>,
  t: Translate,
) {
  const original = Object.entries(bundle.flow.partitions || {})[0];
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
    throw new Error(t("partitionInvalidName"));
  const nextAttributes = attributes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => renames[value] ?? value);
  if (
    nextAttributes.some((value) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) ||
    new Set(nextAttributes).size !== nextAttributes.length
  )
    throw new Error(t("partitionInvalidName"));
  for (const node of bundle.flow.nodes) {
    node.params = renamePartitionReferences(
      node.params || {},
      renames,
    ) as FlowNode["params"];
    for (const attribute of original?.[1].attributes || []) {
      const current = renames[attribute] ?? attribute;
      if (nextAttributes.includes(current)) continue;
      if (
        JSON.stringify(
          renamePartitionReferences(node.params || {}, {
            [current]: "__removed_partition_attribute",
          }),
        ) !== JSON.stringify(node.params || {})
      )
        throw new Error(t("partitionAttributeUsed"));
    }
  }
  if (original && original[0] !== name) {
    for (const node of bundle.flow.nodes)
      for (const output of Object.values(node.outputs || {}))
        if (output.partition?.by === original[0]) output.partition.by = name;
  }
  bundle.flow.partitions = {
    [name]: {
      ...draft,
      attributes: nextAttributes,
    },
  };
}
