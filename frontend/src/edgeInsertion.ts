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
  // Nothing feeds the node yet, so only its own consumers can close a cycle.
  const consumers = new Map<string, string[]>();
  for (const link of graph.edges) {
    const targets = consumers.get(link.source);
    if (targets) targets.push(link.target);
    else consumers.set(link.source, [link.target]);
  }
  const pending = [id];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === edge.source) return false;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(consumers.get(current) || []));
  }
  return true;
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

/** How far from a link's line the dragged shape's center still counts, in
 * canvas units: the link then crosses the 96px shape well inside its outline.
 */
const REACH = 36;
/** Small shapes on a zoomed-out canvas keep a target that stays easy to hit. */
const MIN_REACH = 24;

/** Rendered links passing under a shape centered on the point, nearest first.
 * Distances follow the drawn curve or right-angled segments, even under a node.
 */
export function edgesNear(
  root: HTMLElement | null,
  point: { x: number; y: number },
  zoom: number,
) {
  const reach = Math.max(MIN_REACH, REACH * zoom);
  const near: { id: string; gap: number }[] = [];
  for (const element of root?.querySelectorAll<SVGGElement>(
    ".react-flow__edge",
  ) || []) {
    const id = element.dataset.id;
    const path = element.querySelector<SVGPathElement>(
      ".react-flow__edge-path",
    );
    if (!id || !path) continue;
    const bounds = path.getBoundingClientRect();
    if (
      point.x < bounds.left - reach ||
      point.x > bounds.right + reach ||
      point.y < bounds.top - reach ||
      point.y > bounds.bottom + reach
    )
      continue;
    const matrix = path.getScreenCTM();
    if (!matrix) continue;
    const length = path.getTotalLength();
    const steps = Math.max(1, Math.ceil(length / 8));
    let gap = reach;
    for (let step = 0; step <= steps; step++) {
      const sample = path.getPointAtLength((length * step) / steps);
      const screen = new DOMPoint(sample.x, sample.y).matrixTransform(matrix);
      gap = Math.min(gap, Math.hypot(screen.x - point.x, screen.y - point.y));
    }
    if (gap < reach) near.push({ id, gap });
  }
  return near.sort((a, b) => a.gap - b.gap).map((edge) => edge.id);
}
