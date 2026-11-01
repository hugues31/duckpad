// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { isFinal, usePolling, type PollingOptions } from "./usePolling";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Advance the fake clock, letting settled tasks schedule their next run. */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

type Task = (signal: AbortSignal) => Promise<boolean | void>;

interface Props {
  task: Task;
  options: PollingOptions;
}

function poll(task: Task, options: PollingOptions) {
  return renderHook((props: Props) => usePolling(props.task, props.options), {
    initialProps: { task, options },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("isFinal", () => {
  it("gives up on errors a retry cannot change", () => {
    expect(isFinal(new ApiError("Unauthorized", 401))).toBe(true);
    expect(isFinal(new ApiError("Forbidden", 403))).toBe(true);
    expect(isFinal(new ApiError("Not found", 404))).toBe(true);
  });

  it("retries server, proxy and network failures", () => {
    expect(isFinal(new ApiError("Conflict", 409))).toBe(false);
    expect(isFinal(new ApiError("Server error", 500))).toBe(false);
    expect(isFinal(new ApiError("Bad gateway", 502))).toBe(false);
    expect(isFinal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isFinal(undefined)).toBe(false);
  });
});

describe("usePolling", () => {
  it("runs once when no interval is given", async () => {
    const task = vi.fn(async () => undefined);
    poll(task, {});
    expect(task).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs again an interval after each run settles", async () => {
    const task = vi.fn(async () => undefined);
    poll(task, { interval: 1000 });
    expect(task).toHaveBeenCalledTimes(1);
    await advance(999);
    expect(task).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(task).toHaveBeenCalledTimes(2);
    await advance(3000);
    expect(task).toHaveBeenCalledTimes(5);
  });

  it("never overlaps a run that is still pending", async () => {
    const slow = deferred();
    const task = vi
      .fn<Task>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(undefined);
    poll(task, { interval: 1000 });
    await advance(10_000);
    expect(task).toHaveBeenCalledTimes(1);

    await act(async () => slow.resolve());
    await advance(999);
    expect(task).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("waits for the delay before the first run", async () => {
    const task = vi.fn(async () => undefined);
    poll(task, { delay: 500, interval: 1000 });
    expect(task).not.toHaveBeenCalled();
    await advance(499);
    expect(task).not.toHaveBeenCalled();
    await advance(1);
    expect(task).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does nothing while disabled and starts once enabled", async () => {
    const task = vi.fn(async () => undefined);
    const { rerender } = poll(task, { interval: 1000, enabled: false });
    await advance(5000);
    expect(task).not.toHaveBeenCalled();

    rerender({ task, options: { interval: 1000, enabled: true } });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("stops when a run returns false", async () => {
    const task = vi
      .fn<Task>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(undefined);
    poll(task, { interval: 1000 });
    await advance(10_000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("retries after a temporary failure", async () => {
    const task = vi
      .fn<Task>()
      .mockRejectedValueOnce(new ApiError("Bad gateway", 502))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(undefined);
    poll(task, { interval: 1000 });
    await advance(3000);
    expect(task).toHaveBeenCalledTimes(4);
  });

  it.each([401, 403, 404])(
    "stops after a final API error %i",
    async (status) => {
      const task = vi
        .fn<Task>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new ApiError("Denied", status))
        .mockResolvedValue(undefined);
      poll(task, { interval: 1000 });
      await advance(10_000);
      expect(task).toHaveBeenCalledTimes(2);
    },
  );

  it("aborts the running task and stops when unmounted", async () => {
    const slow = deferred();
    const task = vi
      .fn<Task>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(undefined);
    const { unmount } = poll(task, { interval: 1000 });
    const signal = task.mock.calls[0][0];
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => slow.resolve());
    await advance(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled run when unmounted", async () => {
    const task = vi.fn(async () => undefined);
    const { unmount } = poll(task, { interval: 1000 });
    await advance(500);
    unmount();
    await advance(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("restarts immediately when the task changes", async () => {
    const task = vi.fn<Task>().mockResolvedValue(undefined);
    const { rerender } = poll(task, { interval: 1000 });
    await advance(500);
    const first = task.mock.calls[0][0];

    // A useCallback task changes when its dependencies do.
    const next = vi.fn<Task>().mockResolvedValue(undefined);
    rerender({ task: next, options: { interval: 1000 } });
    expect(first.aborted).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].aborted).toBe(false);

    // The schedule of the previous task was cancelled.
    await advance(999);
    expect(task).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("restarts when the interval changes", async () => {
    const task = vi.fn<Task>().mockResolvedValue(undefined);
    const { rerender } = poll(task, { interval: 1000 });
    rerender({ task, options: { interval: 5000 } });
    expect(task).toHaveBeenCalledTimes(2);
    await advance(4999);
    expect(task).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it("keeps its schedule when re-rendered with the same task", async () => {
    const task = vi.fn<Task>().mockResolvedValue(undefined);
    const { rerender } = poll(task, { interval: 1000 });
    await advance(500);
    const signal = task.mock.calls[0][0];

    // Options are compared by value, not by object identity.
    rerender({ task, options: { interval: 1000 } });
    expect(signal.aborted).toBe(false);
    expect(task).toHaveBeenCalledTimes(1);
    await advance(500);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
