// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { useRunHistory } from "./useRunHistory";

vi.mock("./api", () => ({ api: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("preserves the page boundary when a new run enters the polled first page", async () => {
  let latest = ["run-4", "run-3"];
  vi.mocked(api).mockImplementation(async (path, _options, onResponse) => {
    const older = path.includes("cursor=");
    onResponse?.(
      new Response(null, {
        headers: older ? {} : { "X-Next-Cursor": "before-run-3" },
      }),
    );
    return (older ? ["run-2", "run-1"] : latest).map((id) => ({
      id,
      status: "success",
    }));
  });
  const { result, rerender } = renderHook(({ path }) => useRunHistory(path), {
    initialProps: { path: "/jobs/first/runs" },
  });
  await act(async () => {});
  expect(result.current.data?.map((run) => run.id)).toEqual(["run-4", "run-3"]);
  await act(async () => {
    await result.current.loadMore();
  });
  latest = ["run-5", "run-4"];
  await act(async () => {
    result.current.reload();
  });
  expect(result.current.data?.map((run) => run.id)).toEqual([
    "run-5",
    "run-4",
    "run-3",
    "run-2",
    "run-1",
  ]);
  expect(result.current.hasMore).toBe(false);
  rerender({ path: "/jobs/second/runs" });
  await act(async () => {});
  expect(result.current.data?.map((run) => run.id)).toEqual(["run-5", "run-4"]);
});
