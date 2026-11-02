// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PartitionInspector, PartitionStrip } from "./PartitionControls";

const state = vi.hoisted(() => ({
  id: "w",
  environment: "dev",
  partitionEntry: null,
  selectPartition: vi.fn(),
  canEdit: true,
  run: vi.fn(),
  snapshot: {
    partitions: {
      dev: {
        dimension: { name: "batch", values: { node: "keys" } },
        manifest: { id: "m", count: 1 },
        nodes: { source: { partitioned: true, filters: {}, collect: [] } },
      },
    },
  },
  statuses: { active: null },
}));
vi.mock("./worktree", () => ({ useOptionalWorktree: () => state }));
vi.mock("./useApiResource", () => ({
  useApiResource: () => ({
    data: {
      entries: [
        {
          partition_id: "p",
          key: { value: "quoted ' key" },
          validity: "valid",
          attributes: {},
          nodes: {
            source: { rows: null, duration: null, preview_available: true },
          },
        },
      ],
      total: 1,
      next_cursor: null,
    },
    error: "",
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("selects an opaque identity, keeping raw keys as labels", () => {
  render(<PartitionStrip node="source" />);
  const key = screen.getByRole("button", { name: "quoted ' key · Valid" });
  fireEvent.click(key);
  expect(state.selectPartition).toHaveBeenCalledWith(
    expect.objectContaining({ partition_id: "p" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(state.selectPartition).toHaveBeenLastCalledWith(null);
});

it("collecting removes conflicting output declarations in the same edit", () => {
  const save = vi.fn();
  render(
    <PartitionInspector
      node={{
        id: "source",
        params: {},
        position: { x: 0, y: 0 },
        outputs: { result: { partition: { by: "batch", column: "key" } } },
      }}
      fullNode="source"
      ports={["result"]}
      onChange={save}
    />,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Collect all input partitions" }),
  );
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ partitions: "all", outputs: { result: {} } }),
  );
});

it("retries failed keys as a normal launch that refreshes the manifest", () => {
  render(<PartitionStrip node="source" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Run failed partitions" }),
  );
  expect(state.run).toHaveBeenCalledWith(undefined, {
    partitions: { mode: "failed" },
  });
});

it("renames expression and typed attribute references without changing literals", async () => {
  const { renamePartitionReferences } = await import("./partitions");
  expect(
    renamePartitionReferences(
      {
        expression: "{{ partition.task }} + {{ partition }}",
        typed: { $partition: "task" },
        literal: "task",
        variable: "{{ var.task }}",
      },
      { task: "job" },
    ),
  ).toEqual({
    expression: "{{ partition.job }} + {{ partition }}",
    typed: { $partition: "job" },
    literal: "task",
    variable: "{{ var.task }}",
  });
});
