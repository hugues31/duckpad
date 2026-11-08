// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import type { HistoryPage } from "./gitTypes";
import { useGitHistory } from "./useGitHistory";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
const page = (head: string, next: number | null = null): HistoryPage => ({
  head,
  next,
  items: [
    {
      commit: head,
      author: "Test",
      date: "2026-01-01",
      parents: [],
      message: head,
    },
  ],
});

it("pins pagination to its original head and ignores duplicate load-more requests", async () => {
  let finish!: (value: HistoryPage) => void;
  vi.mocked(api)
    .mockResolvedValueOnce(page("first", 1))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const { result } = renderHook(() =>
    useGitHistory("/history", { entity: "node/a" }),
  );
  await waitFor(() => expect(result.current.pending).toBe(false));
  act(() => {
    void result.current.loadMore();
    void result.current.loadMore();
  });
  expect(api).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api).mock.calls[1][0]).toContain("ref=first");
  expect(vi.mocked(api).mock.calls[1][0]).toContain("entity=node%2Fa");
  await act(async () => finish(page("older")));
  expect(result.current.data?.items.map((item) => item.commit)).toEqual([
    "first",
    "older",
  ]);
});

it("aborts old pagination and keeps late errors out of a different history", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(api)
    .mockResolvedValueOnce(page("a", 1))
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValueOnce(page("b"));
  const { result, rerender } = renderHook(
    ({ entity }) => useGitHistory("/history", { entity }),
    { initialProps: { entity: "a" } },
  );
  await waitFor(() => expect(result.current.pending).toBe(false));
  act(() => {
    void result.current.loadMore();
  });
  const signal = vi.mocked(api).mock.calls[1][1]?.signal;
  rerender({ entity: "b" });
  expect(signal?.aborted).toBe(true);
  await act(async () => fail(new Error("Old failure")));
  expect(result.current.error).toBe("");
  expect(result.current.data?.items[0].commit).toBe("b");
});
