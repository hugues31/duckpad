import type {
  Bundle,
  FlowNode,
  ParsedTemplate,
  Snapshot,
  Graph,
} from "./types";

export const nodeCodePath = (id: string, parent?: string, language = "sql") => {
  const extension = language === "python" ? "py" : "sql";
  return parent
    ? `components/${parent}/${id}.${extension}`
    : `nodes/${id}.${extension}`;
};
export const templateCodePath = (template: string) =>
  `templates/${template}${template.endsWith(".py") ? "" : ".sql"}`;
/** The project file holding a node's code: its shared template or its own file. */
export const nodeSourcePath = (node: FlowNode, parent?: string) =>
  node.template
    ? templateCodePath(node.template)
    : nodeCodePath(node.id, parent, node.language);
/** A node's element ID in Git comparisons and histories. */
export const nodeEntity = (id: string, parent?: string) =>
  `${parent ? `component/${parent}/` : ""}node/${id}`;
export const nodeGraph = (bundle: Bundle, parent?: string) =>
  parent ? bundle.components[parent] : bundle.flow;
export const nodeCode = (bundle: Bundle, node: FlowNode, parent?: string) =>
  node.template
    ? bundle.templates[node.template]
    : bundle.node_sql?.[nodeCodePath(node.id, parent, node.language)] || "";

/** Locate the authored definition of a node inside component instances. */
export function nodeLocation(bundle: Bundle, fullNode: string) {
  const ids = fullNode.split("::");
  let graph: Graph = bundle.flow;
  let parent: string | undefined;
  for (const id of ids.slice(0, -1)) {
    parent = graph.nodes.find((node) => node.id === id)?.component;
    if (!parent || !bundle.components[parent]) return null;
    graph = bundle.components[parent];
  }
  const node = graph.nodes.find((item) => item.id === ids.at(-1));
  return node ? { node, parent } : null;
}

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
      snapshot.parsed_nodes?.[nodeCodePath(node.id, parent, node.language)] ||
        {},
    ]),
  );
}

export function detachNode(bundle: Bundle, node: FlowNode, parent?: string) {
  const code = nodeCode(bundle, node, parent);
  node.preset ||= node.template || node.origin;
  if (node.template) node.origin = node.template;
  delete node.template;
  (bundle.node_sql ||= {})[nodeCodePath(node.id, parent, node.language)] = code;
}

export function linkNode(
  bundle: Bundle,
  node: FlowNode,
  template: string,
  parent?: string,
) {
  node.template = template;
  node.origin = template;
  delete bundle.node_sql?.[nodeCodePath(node.id, parent, node.language)];
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
