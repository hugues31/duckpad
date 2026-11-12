// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Run } from "./types";
import { useRunFailure } from "./useRunFailure";

const launched: Run = {
  id: "run-1",
  project: "project",
  worktree: "main",
  branch: "main",
  environment: "dev",
  commit: "0123abc",
  scope: "project",
  scope_name: [],
  trigger: "manual",
  entry_point: "ui",
  status: "preparing",
  started: "2026-01-01T00:00:00Z",
  nodes: {},
  connections: {},
  definitions: {},
  components: {},
};
const failed: Run = {
  ...launched,
  status: "failed",
  error: "Cannot initialize execution worker: Import delta from core.",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const advance = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const watch = () =>
  renderHook(
    ({ worktree, environment }) => useRunFailure(worktree, environment),
    {
      initialProps: { worktree: "main", environment: "dev" },
    },
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains a failure that finishes before the first poll and stops fetching", async () => {
  const fetch = vi.fn(async () => json(failed));
  vi.stubGlobal("fetch", fetch);
  const { result } = watch();
  await advance();
  expect(fetch).not.toHaveBeenCalled();
  act(() => result.current.trackRun(launched));
  await advance();
  expect(result.current.runFailure).toEqual(failed);
  await advance(10000);
  expect(result.current.runFailure).toEqual(failed);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retries temporary errors while preparation is in progress", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(launched))
    .mockResolvedValueOnce(json({ error: "Unavailable" }, 503))
    .mockResolvedValueOnce(json(failed));
  vi.stubGlobal("fetch", fetch);
  const { result } = watch();
  act(() => result.current.trackRun(launched));
  await advance(1000);
  expect(result.current.runFailure).toBeNull();
  await advance(1000);
  expect(result.current.runFailure).toEqual(failed);
});

it("scopes failures to the branch and environment and clears them for a retry", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(failed)),
  );
  const { result, rerender } = watch();
  act(() => result.current.trackRun(failed));
  expect(result.current.runFailure).toEqual(failed);
  await advance();
  rerender({ worktree: "other", environment: "dev" });
  expect(result.current.runFailure).toBeNull();
  rerender({ worktree: "main", environment: "prod" });
  expect(result.current.runFailure).toBeNull();
  rerender({ worktree: "main", environment: "dev" });
  expect(result.current.runFailure).toEqual(failed);
  act(() => result.current.trackRun(null));
  expect(result.current.runFailure).toBeNull();
});

it("ignores a late response from a previous run after a successful retry", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(
        json({ ...launched, id: "run-2", status: "success" }),
      ),
  );
  const { result } = watch();
  act(() => result.current.trackRun(launched));
  await advance();
  act(() => result.current.trackRun({ ...launched, id: "run-2" }));
  await advance();
  await act(async () => finish(json(failed)));
  expect(result.current.runFailure).toBeNull();
});

it.each([
  { ...failed, status: "canceled" },
  { ...failed, status: "success" },
  { ...failed, error: "" },
  { ...failed, nodes: { query: { status: "failed", error: "Invalid SQL" } } },
])(
  "does not duplicate node failures or report other outcomes: %j",
  async (run) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(run)),
    );
    const { result } = watch();
    act(() => result.current.trackRun(launched));
    await advance();
    expect(result.current.runFailure).toBeNull();
  },
);
