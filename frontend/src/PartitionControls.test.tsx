// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PartitionInspector,
  PartitionSettings,
  PartitionStrip,
} from "./PartitionControls";
import { partitionMessage } from "./partitions";
import en from "./locales/en.json";

const state = vi.hoisted(() => ({
  id: "w",
  environment: "dev",
  partitionEntry: null,
  failed: false,
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
  statuses: { active: null, nodes: {} },
}));
vi.mock("./worktree", () => ({ useOptionalWorktree: () => state }));
vi.mock("./useApiResource", () => ({
  useApiResource: () => ({
    data: {
      entries: [
        {
          partition_id: "p",
          key: { value: "quoted ' key" },
          validity: state.failed ? "failed" : "valid",
          attributes: {},
          nodes: {
            source: {
              rows: state.failed ? null : 1,
              duration: null,
              validity: state.failed ? "failed" : "valid",
              preview_available: !state.failed,
            },
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
  state.failed = false;
});

it("selects an opaque identity, keeping raw keys as labels", () => {
  render(<PartitionStrip node="source" />);
  const key = screen.getByRole("button", {
    name: "quoted ' key · Valid · 1 row",
  });
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
  state.failed = true;
  render(<PartitionStrip node="source" />);
  // A failed key says so, not that its preview was dropped.
  screen.getByRole("button", { name: "quoted ' key · Failed" });
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

it("does not offer a failed retry when no key has failed", () => {
  render(<PartitionStrip node="source" />);
  expect(
    screen.queryByRole("button", { name: "Run failed partitions" }),
  ).toBeNull();
});

it("saves a dimension only once its value source names a node and a column", () => {
  const snapshot = state.snapshot;
  Object.assign(state, {
    snapshot: {
      partitions: { dev: { dimension: null, manifest: null, nodes: {} } },
      worktree: { branch: "main" },
      parsed_templates: { keys: { outputs: ["result"] } },
      bundle: {
        flow: {
          nodes: [
            {
              id: "keys",
              label: "Keys",
              template: "keys",
              params: {},
              position: { x: 0, y: 0 },
            },
          ],
          edges: [],
        },
        components: {},
      },
    },
  });
  try {
    render(<PartitionSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Partition settings" }));
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toHaveProperty("disabled", true);
    // No port is preselected before a node is chosen.
    expect(screen.queryByText(/Absent/)).toBeNull();
    fireEvent.change(
      screen.getByLabelText("Source node", { selector: "select" }),
      { target: { value: "keys" } },
    );
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(
      screen.getByLabelText("Source column", { selector: "input" }),
      { target: { value: "batch" } },
    );
    expect(save).toHaveProperty("disabled", false);
  } finally {
    Object.assign(state, { snapshot });
  }
});

it("translates partition errors and keeps other messages as they are", () => {
  const t = (key: keyof typeof en) => en[key];
  expect(
    partitionMessage(
      t,
      "partition_not_calculated: Partition values not calculated; run keys",
    ),
  ).toBe(en.partitionNotCalculatedHint);
  expect(
    partitionMessage(
      t,
      "partition_incomplete: transform.result lacks valid results for batch-012, batch-013",
    ),
  ).toBe(en.partitionIncompleteHint.replace("{keys}", "batch-012, batch-013"));
  expect(
    partitionMessage(t, "partition_column: order date is missing or ambiguous"),
  ).toBe(en.partitionColumnMissing.replace("{column}", "order date"));
  expect(
    partitionMessage(
      t,
      "partition_column: batch cannot losslessly compare this key",
    ),
  ).toBe(en.partitionColumnLossy.replace("{column}", "batch"));
  const retained = "partition_not_retained: no partition output is retained";
  expect(partitionMessage(t, retained)).toBe(en.partitionNotRetainedHint);
  expect(partitionMessage(t, retained, true)).toBe(
    en.partitionNoneRetainedHint,
  );
  for (const raw of [
    "Order conversion failed",
    "partition_definition: partition values have no valid source",
    "partition_incomplete: unexpected detail",
  ])
    expect(partitionMessage(t, raw)).toBe(raw);
});
