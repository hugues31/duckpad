import type { InternalNode } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  edgeEndpoints,
  orthogonalLanes,
  sameLanes,
  STEP_OFFSET,
  type EdgeEndpoints,
} from "./canvasEdges";

const link = (
  id: string,
  output: string,
  [sourceX, sourceY]: [number, number],
  [targetX, targetY]: [number, number],
): EdgeEndpoints => ({ id, output, sourceX, sourceY, targetX, targetY });

describe("orthogonalLanes", () => {
  it("gives links from different outputs separate lanes in a shared channel", () => {
    // Northstar: orders feeds the join and the period, customers feeds the join below.
    const lanes = orthogonalLanes([
      link("orders-left", "orders", [441, 288], [598, 356]),
      link("customers-right", "customers", [441, 498], [598, 380]),
      link("orders-period", "orders", [441, 288], [596, 608]),
    ]);
    expect(lanes.get("orders-left")).toBe(lanes.get("orders-period"));
    expect(
      Math.abs(lanes.get("orders-left")! - lanes.get("customers-right")!),
    ).toBeGreaterThanOrEqual(16);
  });

  it("orders lanes so that parallel links do not cross", () => {
    const lanes = orthogonalLanes([
      link("upper", "a", [0, 100], [200, 300]),
      link("lower", "b", [0, 200], [200, 400]),
    ]);
    // The upper link turns outside the lower one: its horizontals then avoid the other's vertical.
    expect(lanes.get("lower")!).toBeLessThan(lanes.get("upper")!);
  });

  it("keeps lanes between the stubs of narrow channels", () => {
    const edges = ["a", "b", "c", "d"].map((output, index) =>
      link(output, output, [0, index * 50], [60, 330 - index * 50]),
    );
    const lanes = orthogonalLanes(edges);
    const xs = [...lanes.values()].sort((a, b) => a - b);
    expect(xs).toHaveLength(4);
    expect(xs[0]).toBeGreaterThanOrEqual(STEP_OFFSET);
    expect(xs[3]).toBeLessThanOrEqual(60 - STEP_OFFSET);
    expect(new Set(xs).size).toBe(4);
  });

  it("leaves straight, short and backward links to the default route", () => {
    const lanes = orthogonalLanes([
      link("straight", "a", [0, 100], [200, 100]),
      link("short", "b", [0, 100], [30, 200]),
      link("backward", "c", [300, 100], [0, 200]),
    ]);
    expect(lanes.size).toBe(0);
  });

  it("does not merge channels that are far apart", () => {
    const lanes = orthogonalLanes([
      link("first", "a", [0, 0], [200, 100]),
      link("second", "b", [400, 0], [600, 100]),
    ]);
    expect(lanes.get("first")).toBe(100);
    expect(lanes.get("second")).toBe(500);
  });
});

describe("edgeEndpoints", () => {
  it("reads socket positions from measured handles", () => {
    const node = (
      id: string,
      x: number,
      y: number,
      handles: { source?: object[]; target?: object[] },
    ) =>
      [
        id,
        {
          id,
          internals: {
            positionAbsolute: { x, y },
            handleBounds: handles,
          },
        } as unknown as InternalNode,
      ] as const;
    const nodes = new Map([
      node("a", 10, 20, {
        source: [{ id: "result", x: 140, y: 40, width: 16, height: 16 }],
      }),
      node("b", 300, 50, {
        target: [{ id: "source", x: -8, y: 30, width: 16, height: 16 }],
      }),
    ]);
    const edges = [
      {
        id: "a-b",
        source: "a",
        target: "b",
        sourceHandle: "result",
        targetHandle: "source",
      },
      {
        id: "pending",
        source: "a",
        target: "b",
        sourceHandle: "result",
        targetHandle: "missing",
      },
    ];
    expect(edgeEndpoints(nodes, edges)).toEqual([
      {
        id: "a-b",
        output: "a\0result",
        sourceX: 166,
        sourceY: 68,
        targetX: 292,
        targetY: 88,
      },
    ]);
  });
});

describe("sameLanes", () => {
  it("compares lane positions", () => {
    expect(sameLanes(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
    expect(sameLanes(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(sameLanes(new Map(), new Map([["a", 1]]))).toBe(false);
  });
});
