// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useAutosavedDraft } from "./useAutosavedDraft";
import { AUTOSAVE_DELAY } from "./useRevisionDraft";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("reports mounted failures inline in StrictMode and retries only when requested", async () => {
  vi.useFakeTimers();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Save refused"))
    .mockResolvedValue(2);
  const orphan = vi.fn();
  const { result } = renderHook(
    () =>
      useAutosavedDraft<string, number>("saved", 1, save, {
        onOrphanedError: orphan,
      }),
    { wrapper: StrictMode },
  );
  act(() => result.current.update(() => "edited"));
  await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY));
  expect(result.current.error).toBe("Save refused");
  expect(orphan).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY * 3));
  expect(save).toHaveBeenCalledTimes(1);
  await act(() => result.current.saveNow());
  expect(save).toHaveBeenCalledTimes(2);
  expect(result.current.dirty).toBe(false);
  expect(result.current.error).toBe("");
});

it.each([false, true])(
  "reports a late failure once (save already started: %s)",
  async (started) => {
    let reject!: (error: Error) => void;
    const error = new Error("Offline");
    const save = vi.fn(
      () =>
        new Promise<number>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const orphan = vi.fn();
    const { result, unmount } = renderHook(
      () =>
        useAutosavedDraft<string, number>("saved", 1, save, {
          onOrphanedError: orphan,
        }),
      { wrapper: StrictMode },
    );
    act(() => result.current.update(() => "edited"));
    let pending: Promise<boolean> | undefined;
    if (started)
      await act(async () => {
        pending = result.current.saveNow();
      });
    unmount();
    await act(async () => {
      await Promise.resolve();
      reject(error);
      await pending;
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(orphan).toHaveBeenCalledExactlyOnceWith(error);
  },
);

it("does not save a read-only draft on idle or unmount", async () => {
  vi.useFakeTimers();
  const save = vi.fn();
  const { result, unmount } = renderHook(() =>
    useAutosavedDraft<string, number>("saved", 1, save, { readOnly: true }),
  );
  act(() => result.current.update(() => "edited"));
  await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY));
  await act(() => result.current.saveNow());
  unmount();
  expect(save).not.toHaveBeenCalled();
});
