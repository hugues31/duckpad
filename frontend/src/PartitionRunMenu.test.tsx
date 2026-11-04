// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PartitionRunMenu } from "./PartitionRunMenu";

const run = vi.hoisted(() => vi.fn());
vi.mock("./worktree", () => ({
  useOptionalWorktree: () => ({
    id: "w",
    environment: "dev",
    canEdit: true,
    run,
    partitionEntry: {
      partition_id: "p",
      key: {
        type: "text",
        value: "a",
        producer_run: "old",
        from: { node: "keys" },
      },
    },
    snapshot: {
      partitions: {
        dev: {
          dimension: { values: { node: "keys" } },
          manifest: { count: 1 },
        },
      },
    },
  }),
}));
vi.mock("./useApiResource", () => ({
  useApiResource: () => ({ data: { entries: [], next_cursor: null } }),
}));

it("submits only typed key values when the initial selection includes provenance", () => {
  render(<PartitionRunMenu />);
  fireEvent.click(screen.getByRole("button", { name: "Run with options…" }));
  fireEvent.change(
    screen.getByLabelText("Key selection", { selector: "select" }),
    { target: { value: "selected" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Run pipeline" }));
  expect(run).toHaveBeenCalledWith(
    undefined,
    expect.objectContaining({
      partitions: { mode: "selected", keys: [{ type: "text", value: "a" }] },
    }),
  );
});
