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
/** `active` is the run the status poll reports for the branch. */
const watch = (active: Run | null = null) =>
  renderHook(
    ({ worktree, environment, active }) =>
      useRunFailure(worktree, environment, active),
    {
      initialProps: { worktree: "main", environment: "dev", active },
    },
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reads the outcome once, after the run left the status poll", async () => {
  const fetch = vi.fn(async () => json(failed));
  vi.stubGlobal("fetch", fetch);
  const { result, rerender } = watch(launched);
  act(() => result.current.trackRun(launched));
  await advance(10000);
  expect(fetch).not.toHaveBeenCalled();
  expect(result.current.runFailure).toBeNull();
  rerender({ worktree: "main", environment: "dev", active: null });
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
  rerender({ worktree: "other", environment: "dev", active: null });
  expect(result.current.runFailure).toBeNull();
  rerender({ worktree: "main", environment: "prod", active: null });
  expect(result.current.runFailure).toBeNull();
  rerender({ worktree: "main", environment: "dev", active: null });
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

it("reports a failure that left every node blocked without an error", async () => {
  // The engine stopped mid-run: no node result explains it.
  const interrupted = {
    ...failed,
    error: "Worker connection lost",
    nodes: { query: { status: "blocked" } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(interrupted)),
  );
  const { result } = watch();
  act(() => result.current.trackRun(launched));
  await advance();
  expect(result.current.runFailure).toEqual(interrupted);
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
