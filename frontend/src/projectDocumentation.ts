import { nodeInterface, outputSource } from "./graph";
import { localDefinitions, nodeLocation } from "./nodeCode";
import { declaredTests } from "./ResultsTests";
import type { Snapshot, Statuses } from "./types";

/** Read only catalog of the authored graph and the current environment's retained schema. */
export function projectDocumentation(snapshot: Snapshot, statuses: Statuses) {
  const bundle = snapshot.bundle;
  if (!bundle) return [];
  const docs = bundle.documentation;
  return Object.entries(snapshot.node_names || {}).flatMap(([id, name]) => {
    if (id.startsWith("components/")) return [];
    const location = nodeLocation(bundle, id);
    if (!location) return [];
    const { node, parent } = location;
    const signature = nodeInterface(
      node,
      snapshot.parsed_templates,
      bundle.components,
      localDefinitions(snapshot, parent),
    );
    return [
      {
        id,
        name,
        description:
          docs.nodes?.[id] || signature.definition?.description || "",
        tests: declaredTests(signature, statuses.nodes[id]?.results),
        outputs: signature.outputs.map((port) => {
          const source = outputSource(bundle, id, port);
          const dataset = statuses.nodes[source.node]?.outputs[source.port];
          const key = `${id}:${port}`;
          const descriptions = docs.columns?.[key] || {};
          return {
            port,
            dataset,
            description: docs.datasets?.[key] || "",
            columns: (
              dataset?.columns ||
              Object.keys(descriptions).map((name) => ({ name, type: "" }))
            ).map((column) => ({
              ...column,
              description: descriptions[column.name] || "",
            })),
          };
        }),
      },
    ];
  });
}
