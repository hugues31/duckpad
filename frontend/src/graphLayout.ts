import type { Node, Rect, XYPosition } from "@xyflow/react";
import type { FlowEdge } from "./types";

type PlacementNode = Pick<Node, "id" | "position" | "measured">;

/** Reserve room for the title, badges and ports before a new node is measured. */
const NEW_NODE_SIZE = { width: 180, height: 200 };
const NODE_GAP = 40;

/** Find a free rectangle, preferring the visible canvas and the selected node. */
export function findNodePosition(
  nodes: PlacementNode[],
  { visible, selected }: { visible?: Rect; selected?: string | null } = {},
): XYPosition {
  const { width, height } = NEW_NODE_SIZE;
  const bounds = nodes.map((node) => ({
    id: node.id,
    ...node.position,
    width: node.measured?.width ?? width,
    height: node.measured?.height ?? height,
  }));
  const anchor = bounds.find((node) => node.id === selected);
  const preferred = anchor
    ? { x: anchor.x + anchor.width + NODE_GAP, y: anchor.y }
    : visible
      ? {
          x: visible.x + (visible.width - width) / 2,
          y: visible.y + (visible.height - height) / 2,
        }
      : { x: 160, y: 120 };
  // Free rectangles begin beside an obstacle or a viewport edge. Include both
  // sides to fill gaps after deletions and handle arbitrary dragged positions.
  const xs = new Set([preferred.x]);
  const ys = new Set([preferred.y]);
  if (visible) {
    xs.add(visible.x).add(visible.x + visible.width - width);
    ys.add(visible.y).add(visible.y + visible.height - height);
  }
  for (const node of bounds) {
    xs.add(node.x + node.width + NODE_GAP).add(node.x - width - NODE_GAP);
    ys.add(node.y + node.height + NODE_GAP).add(node.y - height - NODE_GAP);
  }
  let best: {
    position: XYPosition;
    visible: boolean;
    distance: number;
  } | null = null;
  for (const x of xs) {
    for (const y of ys) {
      const inView =
        !!visible &&
        x >= visible.x &&
        y >= visible.y &&
        x + width <= visible.x + visible.width &&
        y + height <= visible.y + visible.height;
      const distance = (x - preferred.x) ** 2 + (y - preferred.y) ** 2;
      if (
        best &&
        ((best.visible && !inView) ||
          (best.visible === inView && best.distance <= distance))
      )
        continue;
      if (
        bounds.some(
          (node) =>
            x < node.x + node.width + NODE_GAP &&
            x + width + NODE_GAP > node.x &&
            y < node.y + node.height + NODE_GAP &&
            y + height + NODE_GAP > node.y,
        )
      )
        continue;
      best = { position: { x, y }, visible: inView, distance };
    }
  }
  // At least the candidate beyond the rightmost node is always free.
  return best!.position;
}

/** Arrange dependencies in columns, leaving room for node labels and ports. */
export function layoutNodes<T extends Node>(
  nodes: T[],
  edges: FlowEdge[],
): T[] {
  const entries = new Map(
    nodes.map((node) => [
      node.id,
      { node, incoming: 0, outgoing: [] as string[], rank: 0 },
    ]),
  );
  for (const edge of edges) {
    const source = entries.get(edge.source);
    const target = entries.get(edge.target);
    if (!source || !target) continue;
    source.outgoing.push(edge.target);
    target.incoming++;
  }
  const ready = [...entries.values()].filter((entry) => !entry.incoming);
  for (let index = 0; index < ready.length; index++) {
    const entry = ready[index];
    for (const id of entry.outgoing) {
      const target = entries.get(id)!;
      target.rank = Math.max(target.rank, entry.rank + 1);
      if (--target.incoming === 0) ready.push(target);
    }
  }

  // Invalid cyclic drafts still get a finite layout with every node visible.
  const fallbackRank = ready.reduce(
    (rank, entry) => Math.max(rank, entry.rank + 1),
    0,
  );
  const layers: T[][] = [];
  for (const entry of entries.values()) {
    const rank = entry.incoming ? fallbackRank : entry.rank;
    (layers[rank] ??= []).push(entry.node);
  }
  const nodeHeight = (node: T) => node.measured?.height ?? 150;
  const nodeWidth = (node: T) => node.measured?.width ?? 150;
  const heights = layers.map((layer) =>
    layer.reduce((height, node) => height + nodeHeight(node) + 60, -60),
  );
  const height = Math.max(0, ...heights);
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  layers.forEach((layer, index) => {
    let y = (height - heights[index]) / 2;
    for (const node of layer) {
      positions.set(node.id, { x, y });
      y += nodeHeight(node) + 60;
    }
    x += Math.max(...layer.map(nodeWidth)) + 110;
  });
  return nodes.map((node) => ({ ...node, position: positions.get(node.id)! }));
}
