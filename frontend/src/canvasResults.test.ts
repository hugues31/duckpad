import { describe, expect, it } from "vitest";
import { nodeStatus, primaryOutputCount, showMinimap } from "./canvasResults";
import type { ComponentDefinition, FlowNode, Statuses } from "./types";

it("shows zero rows, selects the primary output and follows component boundaries", () => {
  const statuses = {
    nodes: {
      node: { outputs: { result: { count: 0 }, rejects: { count: 8 } } },
      "report::source": { outputs: { summary: { count: 42 } } },
    },
  } as unknown as Statuses;
  const node = { id: "node" } as FlowNode;
  expect(
    primaryOutputCount(node, "node", ["rejects", "result"], {}, statuses),
  ).toBe(0);
  expect(
    primaryOutputCount(node, "missing", ["result"], {}, statuses),
  ).toBeUndefined();
  expect(primaryOutputCount(node, "node", [], {}, statuses)).toBeUndefined();
  const components = {
    report: {
      nodes: [{ id: "source" }],
      outputs: { result: { node: "source", port: "summary" } },
    },
  } as unknown as Record<string, ComponentDefinition>;
  expect(
    primaryOutputCount(
      { ...node, component: "report" },
      "report",
      ["result"],
      components,
      statuses,
    ),
  ).toBe(42);
});

it("hides the minimap when panels leave little canvas space", () => {
  expect(showMinimap(900, 600)).toBe(true);
  expect(showMinimap(900, 300)).toBe(false);
  expect(showMinimap(450, 600)).toBe(false);
});

describe("node status", () => {
  it("does not borrow active or retained states from unrelated nodes", () => {
    const statuses = {
      active: { nodes: { unrelated: { status: "running" } } },
      nodes: { "other::leaf": { execution_status: "failed", outputs: {} } },
    } as unknown as Statuses;
    expect(nodeStatus(statuses, "group")).toBe("");
  });
  it.each([
    [
      {
        active: { nodes: { "group::leaf": { status: "running" } } },
        nodes: { "group::leaf": { error: "old", outputs: {} } },
      },
      "running",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { execution_status: "blocked", outputs: {} } },
      },
      "blocked",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { execution_status: "failed", outputs: {} } },
      },
      "failed",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { outputs: { result: { status: "stale" } } } },
      },
      "stale",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { outputs: { result: { status: "valid" } } } },
      },
      "valid",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { execution_status: "success", outputs: {} } },
      },
      "success",
    ],
  ] as const)("summarizes nested node states", (statuses, expected) =>
    expect(nodeStatus(statuses as unknown as Statuses, "group")).toBe(expected),
  );
  it("does not include sibling IDs sharing a prefix", () => {
    const statuses = {
      active: { nodes: { "group2::leaf": { status: "running" } } },
      nodes: { "group2::leaf": { execution_status: "failed", outputs: {} } },
    } as unknown as Statuses;
    expect(nodeStatus(statuses, "group")).toBe("");
  });
  it.each([
    ["blocked", "blocked"],
    ["canceled", "canceled"],
  ] as const)(
    "prefers a %s nested state to a retained error",
    (state, expected) => {
      const statuses = {
        active: null,
        nodes: {
          group: { error: "old", outputs: {} },
          "group::leaf": { execution_status: state, outputs: {} },
        },
      } as unknown as Statuses;
      expect(nodeStatus(statuses, "group")).toBe(expected);
    },
  );
  it("prefers an active failure to a blocked state", () => {
    const statuses = {
      active: {
        nodes: {
          "group::a": { status: "blocked" },
          "group::b": { status: "failed" },
        },
      },
      nodes: {},
    } as unknown as Statuses;
    expect(nodeStatus(statuses, "group")).toBe("failed");
  });
});
