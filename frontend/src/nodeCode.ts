import type { Bundle, FlowNode, ParsedTemplate, Snapshot } from "./types";

export const NEW_NODE_SQL =
  "-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n";
export const nodeCodePath = (id: string, parent?: string) =>
  parent ? `components/${parent}/${id}.sql` : `nodes/${id}.sql`;
export const nodeGraph = (bundle: Bundle, parent?: string) =>
  parent ? bundle.components[parent] : bundle.flow;
export const nodeCode = (bundle: Bundle, node: FlowNode, parent?: string) =>
  node.template
    ? bundle.templates[node.template]
    : bundle.node_sql?.[nodeCodePath(node.id, parent)] || "";

/** Parsed local definitions of the opened graph, keyed by stable node ID. */
export function localDefinitions(
  snapshot: Snapshot,
  parent?: string,
): Record<string, ParsedTemplate> {
  return Object.fromEntries(
    (snapshot.bundle
      ? nodeGraph(snapshot.bundle, parent)?.nodes || []
      : []
    ).map((node) => [
      node.id,
      snapshot.parsed_nodes?.[nodeCodePath(node.id, parent)] || {},
    ]),
  );
}

export function detachNode(bundle: Bundle, node: FlowNode, parent?: string) {
  const code = nodeCode(bundle, node, parent);
  node.preset ||= node.template || node.origin;
  if (node.template) node.origin = node.template;
  delete node.template;
  (bundle.node_sql ||= {})[nodeCodePath(node.id, parent)] = code;
}

export function linkNode(
  bundle: Bundle,
  node: FlowNode,
  template: string,
  parent?: string,
) {
  node.template = template;
  node.origin = template;
  delete bundle.node_sql?.[nodeCodePath(node.id, parent)];
}

/** Count placed instances, including every use of a component containing linked nodes. */
export function templateUsage(bundle: Bundle, template: string): number {
  function count(
    graph: Bundle["flow"] | Bundle["components"][string],
    seen: string[],
  ): number {
    return graph.nodes.reduce(
      (total, node) =>
        total +
        (node.template === template
          ? 1
          : node.component &&
              bundle.components[node.component] &&
              !seen.includes(node.component)
            ? count(bundle.components[node.component], [
                ...seen,
                node.component,
              ])
            : 0),
      0,
    );
  }
  return count(bundle.flow, []);
}
