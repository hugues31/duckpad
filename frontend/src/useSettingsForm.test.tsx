// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DraftContext, useDraftRegistry } from "./useRevisionDraft";
import { useSettingsForm } from "./useSettingsForm";

afterEach(cleanup);

it("compares unordered grants and discards dependent state", () => {
  const discard = vi.fn();
  const { result } = renderHook(() =>
    useSettingsForm(["a", "b"], async () => {}, {
      equal: (a, b) =>
        a.length === b.length && a.every((item) => b.includes(item)),
      discard,
    }),
  );
  act(() => result.current.update(() => ["b", "a"]));
  expect(result.current.dirty).toBe(false);
  act(() => result.current.update((items) => [...items, "c"]));
  expect(result.current.dirty).toBe(true);
  act(() => result.current.discard());
  expect(result.current.config).toEqual(["a", "b"]);
  expect(result.current.dirty).toBe(false);
  expect(discard).toHaveBeenCalledOnce();
});

it("protects navigation, preserves edits through rejection, and unregisters on discard", async () => {
  const registry = renderHook(() => useDraftRegistry());
  const save = vi.fn().mockRejectedValue(new Error("Unavailable"));
  const { result } = renderHook(
    () => useSettingsForm({ name: "Saved" }, save),
    {
      wrapper: ({ children }) => (
        <DraftContext.Provider value={registry.result.current.register}>
          {children}
        </DraftContext.Provider>
      ),
    },
  );
  act(() => result.current.change({ name: "Draft" }));
  expect(registry.result.current.requiresConfirmation()).toBe(true);
  await act(() => result.current.submit());
  expect(result.current.error).toBe("Unavailable");
  expect(result.current.config?.name).toBe("Draft");
  expect(registry.result.current.dirty()).toBe(true);
  act(() => registry.result.current.discard());
  expect(result.current.config?.name).toBe("Saved");
  expect(registry.result.current.dirty()).toBe(false);
});

it("deduplicates a save and preserves newer edits while it finishes", async () => {
  let finish!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useSettingsForm({ name: "Saved" }, save));
  act(() => result.current.change({ name: "First" }));
  await act(async () => {
    void result.current.submit();
    void result.current.submit();
  });
  expect(save).toHaveBeenCalledExactlyOnceWith({ name: "First" });
  act(() => result.current.change({ name: "Newer" }));
  await act(async () => finish());
  expect(result.current.config?.name).toBe("Newer");
  expect(result.current.dirty).toBe(true);
});
