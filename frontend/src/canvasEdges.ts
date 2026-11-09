import type { InternalNode } from "@xyflow/react";
import type { FlowEdge } from "./types";

/** Where a link leaves its output socket and enters its input socket. */
export interface EdgeEndpoints {
  id: string;
  /** Links from one output share a lane, as the branches of a single wire. */
  output: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

/** The horizontal stub that right-angled links keep beside each socket. */
export const STEP_OFFSET = 20;
/** The distance between two parallel vertical segments. */
const LANE_GAP = 16;

/** The measured bounds of a socket, relative to its node, once the node is rendered. */
export function socket(
  node: InternalNode | undefined,
  type: "source" | "target",
  id: string | null | undefined,
) {
  return node?.internals.handleBounds?.[type]?.find(
    (handle) => handle.id === id,
  );
}

/** Socket positions of the links, in flow coordinates, once nodes are measured. */
export function edgeEndpoints(
  nodes: Map<string, InternalNode>,
  edges: FlowEdge[],
): EdgeEndpoints[] {
  const endpoints: EdgeEndpoints[] = [];
  for (const edge of edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    const output = socket(source, "source", edge.sourceHandle);
    const input = socket(target, "target", edge.targetHandle);
    if (!source || !target || !output || !input) continue;
    // Outputs sit on the right of their socket, inputs on the left, as React Flow draws them.
    endpoints.push({
      id: edge.id,
      output: `${edge.source}\0${edge.sourceHandle}`,
      sourceX: source.internals.positionAbsolute.x + output.x + output.width,
      sourceY:
        source.internals.positionAbsolute.y + output.y + output.height / 2,
      targetX: target.internals.positionAbsolute.x + input.x,
      targetY: target.internals.positionAbsolute.y + input.y + input.height / 2,
    });
  }
  return endpoints;
}

interface Lane {
  output: string;
  sourceY: number;
  targetYs: number[];
  top: number;
  bottom: number;
  edges: EdgeEndpoints[];
}

/** Crossings between two lanes when `left` takes the vertical segment left of `right`. */
function crossings(left: Lane, right: Lane) {
  const within = (y: number, lane: Lane) => y > lane.top && y < lane.bottom;
  // Horizontal segments run from the source to the lane, then from the lane to each target.
  return (
    left.targetYs.filter((y) => within(y, right)).length +
    (within(right.sourceY, left) ? 1 : 0)
  );
}

/**
 * The x of the vertical segment of each right-angled link.
 *
 * Links whose vertical segments would overlap share a channel. Each output gets its own lane in
 * that channel, ordered to avoid crossings, so separate links never merge into one line.
 */
export function orthogonalLanes(endpoints: EdgeEndpoints[]) {
  const lanes = new Map<string, number>();
  const routed = endpoints
    .filter(
      (edge) =>
        edge.targetX - edge.sourceX > 2 * STEP_OFFSET &&
        Math.abs(edge.targetY - edge.sourceY) >= 1,
    )
    .map((edge) => ({ edge, center: (edge.sourceX + edge.targetX) / 2 }))
    .sort((a, b) => a.center - b.center || a.edge.id.localeCompare(b.edge.id));
  // A channel grows while its spread lanes would reach the next link's vertical segment.
  const channels: { centers: number[]; edges: EdgeEndpoints[] }[] = [];
  for (const { edge, center } of routed) {
    const last = channels.at(-1);
    if (last) {
      const outputs = new Set(last.edges.map((item) => item.output)).size;
      const middle =
        last.centers.reduce((sum, value) => sum + value, 0) /
        last.centers.length;
      if (center - middle < ((outputs - 1) * LANE_GAP) / 2 + LANE_GAP) {
        last.edges.push(edge);
        last.centers.push(center);
        continue;
      }
    }
    channels.push({ centers: [center], edges: [edge] });
  }
  for (const channel of channels) {
    const grouped = new Map<string, Lane>();
    for (const edge of channel.edges) {
      const lane = grouped.get(edge.output) ?? {
        output: edge.output,
        sourceY: edge.sourceY,
        targetYs: [],
        top: edge.sourceY,
        bottom: edge.sourceY,
        edges: [],
      };
      lane.targetYs.push(edge.targetY);
      lane.top = Math.min(lane.top, edge.targetY);
      lane.bottom = Math.max(lane.bottom, edge.targetY);
      lane.edges.push(edge);
      grouped.set(edge.output, lane);
    }
    const score = new Map<Lane, number>();
    for (const lane of grouped.values()) {
      let total = 0;
      for (const other of grouped.values())
        if (other !== lane)
          total += crossings(lane, other) - crossings(other, lane);
      score.set(lane, total);
    }
    // Rank lanes by how many crossings they save on the left: a stable, transitive order.
    const ordered = [...grouped.values()].sort(
      (a, b) =>
        score.get(a)! - score.get(b)! ||
        a.sourceY - b.sourceY ||
        a.output.localeCompare(b.output),
    );
    const { edges, centers } = channel;
    const middle =
      centers.reduce((sum, value) => sum + value, 0) / edges.length;
    // Lanes fit between the stubs of every link in the channel when there is room for them.
    const low = Math.max(...edges.map((edge) => edge.sourceX + STEP_OFFSET));
    const high = Math.min(...edges.map((edge) => edge.targetX - STEP_OFFSET));
    const spread = ordered.length - 1;
    const gap =
      spread && high > low
        ? Math.min(LANE_GAP, (high - low) / spread)
        : LANE_GAP;
    const half = (gap * spread) / 2;
    const start =
      (high > low
        ? Math.min(Math.max(middle, low + half), high - half)
        : middle) - half;
    ordered.forEach((lane, index) => {
      for (const edge of lane.edges) {
        // Each segment still stays between its own sockets' stubs.
        const x = Math.min(
          Math.max(start + index * gap, edge.sourceX + STEP_OFFSET),
          edge.targetX - STEP_OFFSET,
        );
        lanes.set(edge.id, Math.round(x * 10) / 10);
      }
    });
  }
  return lanes;
}

/**
 * Whether two lists of socket positions route the same links. Panning and zooming
 * update the canvas store without moving any socket, so lanes are not recomputed.
 */
export function sameEndpoints(a: EdgeEndpoints[], b: EdgeEndpoints[]) {
  return (
    a.length === b.length &&
    a.every((edge, index) => {
      const other = b[index];
      return (
        edge.id === other.id &&
        edge.output === other.output &&
        edge.sourceX === other.sourceX &&
        edge.sourceY === other.sourceY &&
        edge.targetX === other.targetX &&
        edge.targetY === other.targetY
      );
    })
  );
}
