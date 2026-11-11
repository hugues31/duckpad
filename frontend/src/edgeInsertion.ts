import { identifier, nodeInterface } from "./graph";
import type {
  ComponentDefinition,
  ComponentPort,
  FlowEdge,
  FlowNode,
  Graph,
  ParsedTemplate,
} from "./types";

export interface InsertionContext extends Graph {
  parsed: Record<string, ParsedTemplate>;
  components: Record<string, ComponentDefinition>;
  local?: Record<string, ParsedTemplate>;
  exposedInputs?: Record<string, ComponentPort>;
}

export interface EdgeInsertion {
  edge: FlowEdge;
  input: string;
  output: string;
}

/** A drop never replaces another input's source or guesses between ports. */
export function planEdgeInsertion(
  context: InsertionContext,
  node: FlowNode,
  edge: FlowEdge,
): EdgeInsertion | null {
  const signature = (item: FlowNode) =>
    nodeInterface(item, context.parsed, context.components, context.local);
  const ports = signature(node);
  const source = context.nodes.find((item) => item.id === edge.source);
  const target = context.nodes.find((item) => item.id === edge.target);
  if (
    !source ||
    !target ||
    edge.source === node.id ||
    edge.target === node.id ||
    (ports.kind !== "component" && ports.definition?.error) ||
    ports.inputs.length !== 1 ||
    ports.outputs.length !== 1 ||
    !signature(source).outputs.includes(edge.sourceHandle) ||
    !signature(target).inputs.includes(edge.targetHandle) ||
    Object.values(context.exposedInputs || {}).some(
      (port) => port.node === node.id && port.port === ports.inputs[0],
    )
  )
    return null;
  const plan = { edge, input: ports.inputs[0], output: ports.outputs[0] };
  return canInsert(context, node.id, plan) ? plan : null;
}

function canInsert(graph: Graph, id: string, plan: EdgeInsertion) {
  const edge = graph.edges.find((item) => item.id === plan.edge.id);
  if (
    !edge ||
    edge.source === id ||
    edge.target === id ||
    edge.source !== plan.edge.source ||
    edge.sourceHandle !== plan.edge.sourceHandle ||
    edge.target !== plan.edge.target ||
    edge.targetHandle !== plan.edge.targetHandle ||
    graph.edges.some(
      (item) =>
        item.target === id ||
        (item.id !== edge.id &&
          item.target === edge.target &&
          item.targetHandle === edge.targetHandle),
    )
  )
    return false;
  const reaches = (start: string, end: string) => {
    const pending = [start];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === end) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const link of graph.edges)
        if (link.source === current) pending.push(link.target);
    }
    return false;
  };
  return !reaches(id, edge.source) && !reaches(edge.target, id);
}

/** Replace one link with two, preserving both original endpoint ports. */
export function insertOnEdge(graph: Graph, id: string, plan: EdgeInsertion) {
  if (
    !graph.nodes.some((node) => node.id === id) ||
    !canInsert(graph, id, plan)
  )
    return;
  graph.edges = graph.edges.map((edge) =>
    edge.id === plan.edge.id
      ? { ...edge, source: id, sourceHandle: plan.output }
      : edge,
  );
  graph.edges.push({
    id: identifier("edge"),
    source: plan.edge.source,
    sourceHandle: plan.edge.sourceHandle,
    target: id,
    targetHandle: plan.input,
  });
}

/** Find the nearest rendered curve or orthogonal segment, even under a node. */
export function edgeAtPoint(
  root: HTMLElement | null,
  point: { x: number; y: number },
  candidates: Map<string, EdgeInsertion>,
) {
  let nearest: EdgeInsertion | undefined;
  let distance = 24;
  for (const element of root?.querySelectorAll<SVGGElement>(
    ".react-flow__edge",
  ) || []) {
    const candidate = candidates.get(element.dataset.id || "");
    if (!candidate) continue;
    const path = element.querySelector<SVGPathElement>(
      ".react-flow__edge-path",
    );
    if (!path) continue;
    const bounds = path.getBoundingClientRect();
    if (
      point.x < bounds.left - distance ||
      point.x > bounds.right + distance ||
      point.y < bounds.top - distance ||
      point.y > bounds.bottom + distance
    )
      continue;
    const matrix = path.getScreenCTM();
    if (!matrix) continue;
    const length = path.getTotalLength();
    const steps = Math.max(1, Math.ceil(length / 8));
    for (let step = 0; step <= steps; step++) {
      const sample = path.getPointAtLength((length * step) / steps);
      const screen = new DOMPoint(sample.x, sample.y).matrixTransform(matrix);
      const gap = Math.hypot(screen.x - point.x, screen.y - point.y);
      if (gap < distance) {
        distance = gap;
        nearest = candidate;
      }
    }
  }
  return nearest;
}
