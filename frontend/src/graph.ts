import type { Bundle, FlowEdge, FlowNode, Graph, Json } from "./types";

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

export const formatValue = (value: any) =>
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
    ? (bundle.components[path[path.length - 1].definition] as Graph)
    : bundle.flow;

/** Prefix of expanded node IDs inside the opened component instance. */
export const pathPrefix = (path: PathPart[]) =>
  path.map((part) => part.instance + "::").join("");

/** A template or component that a node instantiates. */
export type NodeKind = "template" | "component";

/** What a template does with data. */
export type TemplateKind = "source" | "transform" | "export";

/** What a node exposes, whether it instantiates a template or a component. */
export interface NodeInterface {
  /** The component definition or parsed template, unless it was removed. */
  definition: Json | undefined;
  kind: TemplateKind | "component";
  inputs: string[];
  outputs: string[];
  parameters: Json[];
}

/** Component definitions key their ports and parameters by name; parsed
 * templates list them.
 */
export function nodeInterface(
  node: Pick<FlowNode, "template" | "component">,
  parsed: Record<string, Json>,
  components: Record<string, Json> = {},
): NodeInterface {
  if (node.component) {
    const definition = components[node.component];
    return {
      definition,
      kind: "component",
      inputs: Object.keys(definition?.inputs || {}),
      outputs: Object.keys(definition?.outputs || {}),
      parameters: Object.entries(definition?.parameters || {}).map(
        ([name, parameter]) => ({ ...(parameter as Json), name }),
      ),
    };
  }
  const definition = parsed[node.template || ""];
  return {
    definition,
    kind: definition?.kind || "transform",
    inputs: definition?.inputs || [],
    outputs: definition?.outputs || [],
    parameters: definition?.parameters || [],
  };
}

/** Templates and components that can be added inside the given opened
 * component definitions. A component cannot contain itself, even through
 * another definition.
 */
export function nodeChoices(
  parsed: Record<string, Json>,
  components: Record<string, Json>,
  opened: string[],
) {
  const containsOpened = (id: string, visited = new Set<string>()): boolean => {
    if (opened.includes(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return (components[id]?.nodes || []).some(
      (node: FlowNode) =>
        node.component && containsOpened(node.component, visited),
    );
  };
  return [
    ...Object.keys(parsed).map((id) => ({
      kind: "template" as NodeKind,
      id,
      signature: nodeInterface({ template: id }, parsed),
    })),
    ...Object.keys(components)
      .filter((id) => !containsOpened(id))
      .map((id) => ({
        kind: "component" as NodeKind,
        id,
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
