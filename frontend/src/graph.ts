import type {
  Bundle,
  ComponentDefinition,
  FlowEdge,
  FlowNode,
  Graph,
  Parameter,
  ParsedTemplate,
  TemplateKind,
} from "./types";

/** MIME type of palette items dragged onto the canvas. */
export const DRAG_TYPE = "application/duckpad";

/** The existing endpoint and the chosen port of a node created from a drag. */
export interface NodeConnection {
  nodeId: string;
  handleId: string;
  handleType: "source" | "target";
  port: string;
}

export const identifier = (prefix = "node") => {
  // getRandomValues also works on HTTP origins where randomUUID is unavailable.
  const suffix =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 12)
      : Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
  return prefix + "_" + suffix;
};

export const formatValue = (value: unknown) =>
  value === null
    ? "NULL"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

/** One level of the component breadcrumb. */
export interface PathPart {
  instance: string;
  definition: string;
  label: string;
}

/** The flow, or the component definition opened through the breadcrumb. */
export const graphAt = (bundle: Bundle, path: PathPart[]): Graph =>
  path.length
    ? bundle.components[path[path.length - 1].definition]
    : bundle.flow;

/** Prefix of expanded node IDs inside the opened component instance. */
export const pathPrefix = (path: PathPart[]) =>
  path.map((part) => part.instance + "::").join("");

/** Resolve an expanded node ID to its authored graph and breadcrumb. */
export function resolveNodePath(bundle: Bundle, target: string) {
  const ids = target.split("::");
  const path: PathPart[] = [];
  let graph: Graph = bundle.flow;
  for (const instance of ids.slice(0, -1)) {
    const parent = graph.nodes.find((node) => node.id === instance);
    const definition = parent?.component && bundle.components[parent.component];
    if (!parent?.component || !definition) return null;
    path.push({
      instance,
      definition: parent.component,
      label: parent.label || definition.name || instance,
    });
    graph = definition;
  }
  const id = ids.at(-1)!;
  const node = graph.nodes.find((node) => node.id === id);
  return node
    ? { node, id, graph, path, parent: path.at(-1)?.definition }
    : null;
}

/**
 * The expanded node and port that materialize an output. A component instance
 * stores no rows: its exposed output is the output of a node inside it, found
 * through nested instances as the engine expands them.
 */
export function outputSource(bundle: Bundle, node: string, port: string) {
  return exposedSource(
    bundle.components,
    resolveNodePath(bundle, node)?.node,
    node,
    port,
  );
}

/** Follow a component instance's exposed port to the node inside it that
 * stores the rows; the same node and port otherwise. */
export function exposedSource(
  components: Record<string, ComponentDefinition>,
  current: FlowNode | undefined,
  node: string,
  port: string,
) {
  const source = { node, port };
  const seen = new Set<string>();
  while (current?.component && !seen.has(current.component)) {
    seen.add(current.component);
    const definition: ComponentDefinition | undefined =
      components[current.component];
    const exposed = definition?.outputs?.[source.port];
    if (!exposed) break;
    source.node += "::" + exposed.node;
    source.port = exposed.port;
    current = definition.nodes.find((n) => n.id === exposed.node);
  }
  return source;
}

/** A template or component that a node instantiates. */
export type NodeKind = "template" | "component";

/** What a node exposes, whether it instantiates a template or a component.
 * The definition is undefined once removed from the project.
 */
export type NodeInterface = {
  inputs: string[];
  outputs: string[];
  parameters: Parameter[];
} & (
  | { kind: "component"; definition: ComponentDefinition | undefined }
  | { kind: TemplateKind; definition: ParsedTemplate | undefined }
);

/** Component definitions key their ports and parameters by name; parsed
 * templates list them.
 */
export function nodeInterface(
  node: Pick<FlowNode, "template" | "component"> & { id?: string },
  parsed: Record<string, ParsedTemplate>,
  components: Record<string, ComponentDefinition> = {},
  local: Record<string, ParsedTemplate> = {},
): NodeInterface {
  if (node.component) {
    const definition = components[node.component];
    return {
      definition,
      kind: "component",
      inputs: Object.keys(definition?.inputs || {}),
      outputs: Object.keys(definition?.outputs || {}),
      parameters: Object.entries(definition?.parameters || {}).map(
        ([name, parameter]) => ({ ...parameter, name }),
      ),
    };
  }
  const definition =
    local[node.id || ""] ?? (node.template ? parsed[node.template] : undefined);
  const inputs = definition?.inputs || [];
  const outputs = definition?.outputs || [];
  return {
    definition,
    kind:
      definition?.language === "python"
        ? !outputs.length
          ? "export"
          : !inputs.length
            ? "source"
            : "transform"
        : definition?.writes_external
          ? "export"
          : !inputs.length && outputs.length
            ? "source"
            : "transform",
    inputs,
    outputs,
    parameters: definition?.parameters || [],
  };
}

/** A template or component offered by the palettes, with its definition. */
export type NodeChoice = { id: string; signature: NodeInterface } & (
  | { kind: "template"; definition: ParsedTemplate }
  | { kind: "component"; definition: ComponentDefinition }
);

/** Whether a component definition contains a Python node, directly or in a nested component. */
export function containsPython(
  components: Record<string, ComponentDefinition>,
  id: string,
  visited = new Set<string>(),
): boolean {
  if (visited.has(id)) return false;
  visited.add(id);
  return (components[id]?.nodes || []).some(
    (node) =>
      node.language === "python" ||
      (!!node.component && containsPython(components, node.component, visited)),
  );
}

/** Templates and components that can be added inside the given opened
 * component definitions. A component cannot contain itself, even through
 * another definition.
 */
export function nodeChoices(
  parsed: Record<string, ParsedTemplate>,
  components: Record<string, ComponentDefinition>,
  opened: string[],
): NodeChoice[] {
  const containsOpened = (id: string, visited = new Set<string>()): boolean => {
    if (opened.includes(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return (components[id]?.nodes || []).some(
      (node) => node.component && containsOpened(node.component, visited),
    );
  };
  return [
    ...Object.entries(parsed).map(([id, definition]) => ({
      kind: "template" as const,
      id,
      definition,
      signature: nodeInterface({ template: id }, parsed),
    })),
    ...Object.entries(components)
      .filter(([id]) => !containsOpened(id))
      .map(([id, definition]) => ({
        kind: "component" as const,
        id,
        definition,
        signature: nodeInterface({ component: id }, parsed, components),
      })),
  ];
}

/** Connect an input, replacing its previous source: an input has one source. */
export function connectInput(graph: Graph, edge: Omit<FlowEdge, "id">) {
  graph.edges = graph.edges.filter(
    (e) => !(e.target === edge.target && e.targetHandle === edge.targetHandle),
  );
  graph.edges.push({ ...edge, id: identifier("edge") });
}
