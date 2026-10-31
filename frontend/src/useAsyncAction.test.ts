// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAsyncAction } from "./useAsyncAction";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

describe("useAsyncAction", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useAsyncAction());
    expect(result.current).toMatchObject({ pending: false, error: "" });
  });

  it("is pending while the action runs and reports success", async () => {
    const { result } = renderHook(() => useAsyncAction());
    const action = deferred();
    let outcome!: Promise<boolean>;
    act(() => {
      outcome = result.current.run(() => action.promise);
    });
    expect(result.current.pending).toBe(true);

    await act(async () => action.resolve());
    await expect(outcome).resolves.toBe(true);
    expect(result.current).toMatchObject({ pending: false, error: "" });
  });

  it("reports the error message of a failed action", async () => {
    const { result } = renderHook(() => useAsyncAction());
    let outcome!: boolean;
    await act(async () => {
      outcome = await result.current.run(async () => {
        throw new Error("Branch already exists");
      });
    });
    expect(outcome).toBe(false);
    expect(result.current).toMatchObject({
      pending: false,
      error: "Branch already exists",
    });
  });

  it("clears the previous error when the action runs again", async () => {
    const { result } = renderHook(() => useAsyncAction());
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("Offline")));
    });
    const retry = deferred();
    act(() => {
      void result.current.run(() => retry.promise);
    });
    expect(result.current).toMatchObject({ pending: true, error: "" });
    await act(async () => retry.resolve());
    expect(result.current.error).toBe("");
  });

  it("lets the owner set or clear the error", () => {
    const { result } = renderHook(() => useAsyncAction());
    act(() => result.current.setError("Name is required"));
    expect(result.current.error).toBe("Name is required");
    act(() => result.current.setError(""));
    expect(result.current.error).toBe("");
  });

  it("keeps run stable across renders", async () => {
    const { result, rerender } = renderHook(() => useAsyncAction());
    const run = result.current.run;
    await act(async () => {
      await run(() => Promise.reject(new Error("Offline")));
    });
    rerender();
    expect(result.current.run).toBe(run);
  });
});
