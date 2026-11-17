import { describe, expect, it } from "vitest";
import { findNodePosition, layoutNodes, type PortOffset } from "./graphLayout";

const node = (id: string, x: number, y: number, width = 180, height = 200) => ({
  id,
  position: { x, y },
  measured: { width, height },
});
type PlacedNode = ReturnType<typeof node>;

function expectFree(position: { x: number; y: number }, nodes: PlacedNode[]) {
  for (const other of nodes)
    expect(
      position.x < other.position.x + other.measured.width &&
        position.x + 180 > other.position.x &&
        position.y < other.position.y + other.measured.height &&
        position.y + 200 > other.position.y,
    ).toBe(false);
}

describe("findNodePosition", () => {
  it("centers the first node in a panned and zoomed visible area", () => {
    expect(
      findNodePosition([], {
        visible: { x: -2000, y: 700, width: 500, height: 600 },
      }),
    ).toEqual({ x: -1840, y: 900 });
  });

  it("does not reuse an occupied slot after deleting the first node", () => {
    const first = { ...node("first", 0, 0), position: findNodePosition([]) };
    const second = {
      ...node("second", 0, 0),
      position: findNodePosition([first]),
    };
    const third = findNodePosition([second]);
    expectFree(third, [second]);
  });

  it("uses measured bounds, including oversized nodes at arbitrary positions", () => {
    const nodes = [
      node("large", -123.5, -400, 950, 1200),
      node("small", 900, 100),
    ];
    expectFree(findNodePosition(nodes), nodes);
  });

  it("uses the measured size of nodes smaller than a new node", () => {
    expect(
      findNodePosition([node("small", 0, 0, 100, 100)], {
        visible: { x: 0, y: 0, width: 320, height: 200 },
      }),
    ).toEqual({ x: 140, y: 0 });
  });

  it("reserves room for nodes that have not been measured yet", () => {
    const existing = { id: "pending", position: { x: 160, y: 120 } };
    expectFree(findNodePosition([existing]), [node("pending", 160, 120)]);
  });

  it("places a node beside the selection when there is room", () => {
    const nodes = [node("selected", 300, 100, 250)];
    expect(findNodePosition(nodes, { selected: "selected" })).toEqual({
      x: 590,
      y: 100,
    });
  });

  it("prefers a free visible spot over a distant selected node", () => {
    const nodes = [node("selected", 3000, 100)];
    const position = findNodePosition(nodes, {
      selected: "selected",
      visible: { x: -500, y: -500, width: 800, height: 800 },
    });
    expect(position.x).toBeGreaterThanOrEqual(-500);
    expect(position.y).toBeGreaterThanOrEqual(-500);
    expect(position.x + 180).toBeLessThanOrEqual(300);
    expect(position.y + 200).toBeLessThanOrEqual(300);
    expectFree(position, nodes);
  });

  it("fills a narrow visible gap between measured bounds", () => {
    const nodes = [node("left", 0, 0), node("right", 440, 0)];
    expect(
      findNodePosition(nodes, {
        visible: { x: 0, y: 0, width: 620, height: 200 },
      }),
    ).toEqual({ x: 220, y: 0 });
  });

  it("finds space outside a full or undersized viewport without moving existing nodes", () => {
    const nodes = [node("large", -10000, -10000, 20000, 20000)];
    const original = structuredClone(nodes);
    const options = { visible: { x: 0, y: 0, width: 100, height: 100 } };
    const position = findNodePosition(nodes, options);
    expectFree(position, nodes);
    expect(findNodePosition(nodes, options)).toEqual(position);
    expect(nodes).toEqual(original);
  });

  it("keeps repeated additions disjoint even after the viewport fills up", () => {
    const nodes: PlacedNode[] = [];
    for (let index = 0; index < 40; index++) {
      const position = findNodePosition(nodes, {
        selected: nodes.at(-1)?.id,
        visible: { x: -200, y: -200, width: 900, height: 700 },
      });
      expectFree(position, nodes);
      nodes.push({ ...node(String(index), 0, 0), position });
    }
  });
});

describe("layoutNodes", () => {
  const box = (id: string, y = 0, height = 150) => ({
    id,
    position: { x: 0, y },
    measured: { width: 150, height },
    data: {},
  });
  const edge = (source: string, target: string, targetHandle = "source") => ({
    id: `${source}-${target}-${targetHandle}`,
    source,
    target,
    sourceHandle: "result",
    targetHandle,
  });
  type Box = ReturnType<typeof box>;
  const placed = (nodes: Box[]) =>
    new Map(nodes.map((node) => [node.id, node.position]));

  it("arranges dependencies in columns from left to right", () => {
    const nodes = layoutNodes(
      [box("c"), box("a"), box("b")],
      [edge("a", "b"), edge("b", "c")],
    );
    const at = placed(nodes);
    expect(at.get("a")!.x).toBeLessThan(at.get("b")!.x);
    expect(at.get("b")!.x).toBeLessThan(at.get("c")!.x);
    // A chain is drawn as straight links.
    expect(new Set(nodes.map((node) => node.position.y)).size).toBe(1);
  });

  it("orders each column to remove crossings", () => {
    // Saved positions put the consumer of "top" below the consumer of "bottom".
    const at = placed(
      layoutNodes(
        [box("top", 0), box("bottom", 300), box("late", 0), box("early", 300)],
        [edge("top", "early"), edge("bottom", "late")],
      ),
    );
    expect(at.get("early")!.y).toBeLessThan(at.get("late")!.y);
  });

  it("places the source of an upper input socket above the source of a lower one", () => {
    const ports: PortOffset = (node, port) =>
      node === "join" ? (port === "left" ? 36 : 60) : 48;
    const at = placed(
      layoutNodes(
        [box("right", 0), box("left", 300), box("join")],
        [edge("left", "join", "left"), edge("right", "join", "right")],
        ports,
      ),
    );
    expect(at.get("left")!.y).toBeLessThan(at.get("right")!.y);
  });

  it("keeps nodes of a column apart", () => {
    const nodes = layoutNodes(
      [box("source"), box("a", 0, 170), box("b", 0, 170), box("c", 0, 170)],
      [edge("source", "a"), edge("source", "b"), edge("source", "c")],
    );
    const ys = nodes
      .filter((node) => node.id !== "source")
      .map((node) => node.position.y)
      .sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(170 + 60);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(170 + 60);
  });

  it("routes a link that skips a column beside the skipped node", () => {
    const at = placed(
      layoutNodes(
        [box("a"), box("b"), box("c")],
        [edge("a", "b"), edge("b", "c"), edge("a", "c")],
      ),
    );
    // The link from a to c crosses b's column halfway between their sockets.
    const middle = (at.get("a")!.y + at.get("c")!.y) / 2 + 75;
    const b = at.get("b")!.y;
    expect(middle < b - 12 || middle > b + 150 + 12).toBe(true);
  });

  it("lays out cyclic drafts with every node", () => {
    const nodes = layoutNodes(
      [box("a"), box("b"), box("c")],
      [edge("a", "b"), edge("b", "a"), edge("b", "c")],
    );
    expect(nodes.every((node) => Number.isFinite(node.position.y))).toBe(true);
    expect(
      new Set(nodes.map((node) => `${node.position.x}:${node.position.y}`))
        .size,
    ).toBe(3);
  });
});
