import type {
  Bundle,
  FlowEdge,
  FlowNode,
  Graph,
  Json,
  Snapshot,
} from "./types";

/** MIME type of palette items dragged onto the canvas. */
export const DRAG_TYPE = "application/duckpad";

export const identifier = (prefix = "node") =>
  prefix + "_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);

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

/** A node's component definition or parsed template interface. */
export const definitionOf = (node: FlowNode, snapshot: Snapshot) =>
  node.component
    ? snapshot.bundle?.components[node.component]
    : snapshot.parsed_templates[node.template || ""];

export const outputPorts = (
  node: FlowNode,
  definition: Json | undefined,
): string[] =>
  node.component
    ? Object.keys(definition?.outputs || {})
    : definition?.outputs || [];

/** Connect an input, replacing its previous source: an input has one source. */
export function connectInput(graph: Graph, edge: Omit<FlowEdge, "id">) {
  graph.edges = graph.edges.filter(
    (e) => !(e.target === edge.target && e.targetHandle === edge.targetHandle),
  );
  graph.edges.push({ ...edge, id: identifier("edge") });
}
