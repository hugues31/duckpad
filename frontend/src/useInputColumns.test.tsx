// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import type { Snapshot, Statuses } from "./types";
import { useInputColumns } from "./useInputColumns";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
}));
vi.mock("./worktree", () => ({
  usePartitionQuery: () => ({ manifest: "manifest", partition_id: "one" }),
}));
afterEach(cleanup);

it("loads expanded inputs once per revision or result generation and preserves partition selection", async () => {
  vi.mocked(api).mockResolvedValue({
    inputs: [
      { input: "source", columns: [{ name: "amount", type: "INTEGER" }] },
    ],
  });
  const snapshot = { revision: "a", worktree: { id: "worktree" } } as Snapshot;
  const statuses: Statuses = { active: null, nodes: {} };
  const { result, rerender } = renderHook(
    ({ snapshot, statuses }) =>
      useInputColumns(snapshot, "outer::leaf", "dev", statuses),
    { initialProps: { snapshot, statuses } },
  );
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.columns.source[0].name).toBe("amount");
  expect(api).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api).mock.calls[0][0]).toContain(
    "input-columns/outer%3A%3Aleaf",
  );
  expect(vi.mocked(api).mock.calls[0][0]).toContain("partition_id=one");
  rerender({ snapshot: { ...snapshot }, statuses: { ...statuses, nodes: {} } });
  expect(api).toHaveBeenCalledTimes(1);
  rerender({ snapshot: { ...snapshot, revision: "b" }, statuses });
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
});
