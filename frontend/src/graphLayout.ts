import type { Node } from "@xyflow/react";
import type { FlowEdge } from "./types";

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
