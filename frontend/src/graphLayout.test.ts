import { describe, expect, it } from "vitest";
import { findNodePosition } from "./graphLayout";

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
