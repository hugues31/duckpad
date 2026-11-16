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

/** The y of a socket from the top of its node, when it is known. */
export type PortOffset = (
  node: string,
  port: string | null | undefined,
  type: "source" | "target",
) => number | undefined;

/** A node, or a waypoint of a link that skips columns, in one column of the layout. */
interface Vertex {
  id: string;
  height: number;
  dummy: boolean;
  /** Links towards the previous and next columns, with socket offsets on both ends. */
  up: Link[];
  down: Link[];
  index: number;
  top: number;
}
interface Link {
  vertex: Vertex;
  /** The socket's offset on this vertex, then on the linked one. */
  own: number;
  other: number;
  weight: number;
}

const NODE_GAP_Y = 60;
const WAYPOINT_GAP_Y = 24;
const COLUMN_GAP = 110;
const SWEEPS = 12;
/**
 * Links are drawn straight from one socket to the other, so long links follow their
 * waypoints more closely than nodes follow each other.
 */
const WAYPOINT_WEIGHT = 50;
/** Alignment passes, ending with a pass towards the parents. */
const ALIGNMENTS = 5;

/** Crossings between two adjacent columns, with sockets ordered inside each node. */
function columnCrossings(column: Vertex[]) {
  const segments = column.flatMap((vertex) =>
    vertex.down.map((link) => [
      vertex.index + link.own / (vertex.height + 1),
      link.vertex.index + link.other / (link.vertex.height + 1),
    ]),
  );
  let total = 0;
  for (let i = 0; i < segments.length; i++)
    for (let j = i + 1; j < segments.length; j++)
      if (
        (segments[i][0] - segments[j][0]) * (segments[i][1] - segments[j][1]) <
        0
      )
        total++;
  return total;
}

/** Order a column by the mean position of its links into an already ordered column. */
function orderColumn(column: Vertex[], side: "up" | "down") {
  const rank = new Map(
    column.map((vertex) => {
      const links = vertex[side];
      if (!links.length) return [vertex, vertex.index];
      const sum = links.reduce(
        (total, link) =>
          total + link.vertex.index + link.other / (link.vertex.height + 1),
        0,
      );
      return [vertex, sum / links.length];
    }),
  );
  column.sort((a, b) => rank.get(a)! - rank.get(b)! || a.index - b.index);
  column.forEach((vertex, index) => (vertex.index = index));
}

/**
 * Tops closest to the weighted targets that keep the column's order and gaps
 * (pool adjacent violators).
 */
function placeColumn(
  column: Vertex[],
  targets: { top: number; weight: number }[],
) {
  const minimum: number[] = [];
  let offset = 0;
  column.forEach((vertex, index) => {
    if (index) {
      const previous = column[index - 1];
      offset +=
        previous.height +
        (vertex.dummy || previous.dummy ? WAYPOINT_GAP_Y : NODE_GAP_Y);
    }
    minimum.push(offset);
  });
  const blocks: { value: number; weight: number; size: number }[] = [];
  targets.forEach((target, index) => {
    blocks.push({
      value: target.top - minimum[index],
      weight: target.weight,
      size: 1,
    });
    while (
      blocks.length > 1 &&
      blocks[blocks.length - 2].value >= blocks[blocks.length - 1].value
    ) {
      const last = blocks.pop()!;
      const previous = blocks[blocks.length - 1];
      previous.value =
        (previous.value * previous.weight + last.value * last.weight) /
        (previous.weight + last.weight);
      previous.weight += last.weight;
      previous.size += last.size;
    }
  });
  let index = 0;
  for (const block of blocks)
    for (let count = 0; count < block.size; count++, index++)
      column[index].top = block.value + minimum[index];
}

/** Align each vertex with the sockets it links to on one side. */
function alignColumn(column: Vertex[], side: "up" | "down") {
  placeColumn(
    column,
    column.map((vertex) => {
      const links = vertex[side];
      if (!links.length) return { top: vertex.top, weight: 1 };
      const weight = links.reduce((total, link) => total + link.weight, 0);
      const top =
        links.reduce(
          (total, link) =>
            total + (link.vertex.top + link.other - link.own) * link.weight,
          0,
        ) / weight;
      return { top, weight };
    }),
  );
}

/**
 * Arrange dependencies in columns, leaving room for node labels and ports.
 *
 * Nodes are ordered within their column to reduce link crossings, then moved
 * up or down so that links run as straight as their neighbors allow. Links
 * that skip columns reserve waypoints, so they pass between nodes.
 */
export function layoutNodes<T extends Node>(
  nodes: T[],
  edges: FlowEdge[],
  portOffset: PortOffset = () => undefined,
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
  const nodeHeight = (node: T) => node.measured?.height ?? 150;
  const nodeWidth = (node: T) => node.measured?.width ?? 150;
  const columns: Vertex[][] = [];
  const vertices = new Map<string, Vertex>();
  const ranks = new Map<string, number>();
  // The current vertical order is the starting point, so similar graphs keep their arrangement.
  const sorted = [...entries.values()].sort(
    (a, b) => a.node.position.y - b.node.position.y,
  );
  for (const entry of sorted) {
    const rank = entry.incoming ? fallbackRank : entry.rank;
    const vertex: Vertex = {
      id: entry.node.id,
      height: nodeHeight(entry.node),
      dummy: false,
      up: [],
      down: [],
      index: (columns[rank] ??= []).length,
      top: 0,
    };
    columns[rank].push(vertex);
    vertices.set(vertex.id, vertex);
    ranks.set(vertex.id, rank);
  }
  const offset = (
    vertex: Vertex,
    port: string | null | undefined,
    type: "source" | "target",
  ) =>
    vertex.dummy ? 0 : (portOffset(vertex.id, port, type) ?? vertex.height / 2);
  const connect = (
    upper: Vertex,
    lower: Vertex,
    upperOffset: number,
    lowerOffset: number,
  ) => {
    const weight = upper.dummy || lower.dummy ? WAYPOINT_WEIGHT : 1;
    upper.down.push({
      vertex: lower,
      own: upperOffset,
      other: lowerOffset,
      weight,
    });
    lower.up.push({
      vertex: upper,
      own: lowerOffset,
      other: upperOffset,
      weight,
    });
  };
  edges.forEach((edge, number) => {
    const source = vertices.get(edge.source);
    const target = vertices.get(edge.target);
    if (!source || !target) return;
    const from = ranks.get(source.id)!;
    const to = ranks.get(target.id)!;
    // Links inside a cycle do not constrain the layout.
    if (to <= from) return;
    let previous = source;
    let previousOffset = offset(source, edge.sourceHandle, "source");
    for (let rank = from + 1; rank < to; rank++) {
      const waypoint: Vertex = {
        id: `\0${number}:${rank}`,
        height: 0,
        dummy: true,
        up: [],
        down: [],
        index: columns[rank].length,
        top: 0,
      };
      columns[rank].push(waypoint);
      connect(previous, waypoint, previousOffset, 0);
      previous = waypoint;
      previousOffset = 0;
    }
    connect(
      previous,
      target,
      previousOffset,
      offset(target, edge.targetHandle, "target"),
    );
  });

  // Barycentric sweeps, keeping the order with the fewest crossings.
  const crossings = () =>
    columns.reduce((total, column) => total + columnCrossings(column), 0);
  const snapshot = () => columns.map((column) => [...column]);
  let best = snapshot();
  let fewest = crossings();
  for (let sweep = 0; sweep < SWEEPS && fewest > 0; sweep++) {
    if (sweep % 2 === 0)
      for (let rank = 1; rank < columns.length; rank++)
        orderColumn(columns[rank], "up");
    else
      for (let rank = columns.length - 2; rank >= 0; rank--)
        orderColumn(columns[rank], "down");
    const count = crossings();
    if (count < fewest) {
      fewest = count;
      best = snapshot();
    }
  }
  best.forEach((column, rank) => {
    columns[rank] = column;
    column.forEach((vertex, index) => (vertex.index = index));
  });

  // Start from stacked columns, then align linked sockets column by column.
  for (const column of columns)
    placeColumn(
      column,
      column.map(() => ({ top: 0, weight: 1 })),
    );
  for (let pass = 0; pass < ALIGNMENTS; pass++) {
    // Odd passes let sources follow their consumers; the last pass straightens links from parents.
    const side = pass % 2 ? "down" : "up";
    const order = pass % 2 ? [...columns].reverse() : columns;
    for (const column of order) alignColumn(column, side);
  }

  const top = Math.min(
    ...columns.flatMap((column) => column.map((vertex) => vertex.top)),
  );
  const positions = new Map<string, { x: number; y: number }>();
  let x = 0;
  columns.forEach((column) => {
    const width = Math.max(
      0,
      ...column
        .filter((vertex) => !vertex.dummy)
        .map((vertex) => nodeWidth(entries.get(vertex.id)!.node)),
    );
    for (const vertex of column)
      if (!vertex.dummy)
        positions.set(vertex.id, {
          x,
          y: Math.round(vertex.top - top),
        });
    x += width + COLUMN_GAP;
  });
  return nodes.map((node) => ({ ...node, position: positions.get(node.id)! }));
}
