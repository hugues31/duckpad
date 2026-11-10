// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  useApiResource,
  useResource,
  type ResourceOptions,
} from "./useApiResource";

interface Call<T> {
  key: string;
  signal: AbortSignal;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** A loader whose answers the test settles one call at a time. */
function loader<T = string>() {
  const calls: Call<T>[] = [];
  const load = vi.fn(
    (key: string, signal: AbortSignal) =>
      new Promise<T>((resolve, reject) =>
        calls.push({ key, signal, resolve, reject }),
      ),
  );
  return { load, calls };
}

/** Let settled loads update the hook, advancing the fake clock if asked. */
const advance = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

interface Props {
  resourceKey: string | null;
  options?: ResourceOptions;
}

function resource<T>(
  load: (key: string, signal: AbortSignal) => Promise<T>,
  initialProps: Props,
) {
  return renderHook(
    ({ resourceKey, options }: Props) =>
      useResource<T>(
        resourceKey,
        (signal) => load(resourceKey!, signal),
        options,
      ),
    { initialProps },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useResource", () => {
  it("loads nothing while the key is null", async () => {
    const { load } = loader();
    const { result } = resource(load, { resourceKey: null });
    await advance(5000);
    expect(load).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      data: null,
      error: "",
      pending: false,
    });
  });

  it("is pending until the first answer", async () => {
    const { load, calls } = loader();
    const { result } = resource(load, { resourceKey: "main" });
    expect(result.current).toMatchObject({ data: null, pending: true });
    expect(calls.map((call) => call.key)).toEqual(["main"]);

    calls[0].resolve("main data");
    await advance();
    expect(result.current).toMatchObject({
      data: "main data",
      error: "",
      pending: false,
    });
  });

  it("reports a failed load", async () => {
    const { load, calls } = loader();
    const { result } = resource(load, { resourceKey: "main" });
    calls[0].reject(new Error("Service unavailable"));
    await advance();
    expect(result.current).toMatchObject({
      data: null,
      error: "Service unavailable",
      pending: false,
    });
  });

  it("resets the data and error when the key changes", async () => {
    const { load, calls } = loader();
    const { result, rerender } = resource(load, { resourceKey: "main" });
    calls[0].resolve("main data");
    await advance();

    rerender({ resourceKey: "feature" });
    expect(result.current).toMatchObject({
      data: null,
      error: "",
      pending: true,
    });
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].key).toBe("feature");

    calls[1].resolve("feature data");
    await advance();
    expect(result.current).toMatchObject({
      data: "feature data",
      pending: false,
    });
  });

  it("does not show an error of the previous key", async () => {
    const { load, calls } = loader();
    const { result, rerender } = resource(load, { resourceKey: "main" });
    calls[0].reject(new Error("Branch not found"));
    await advance();
    rerender({ resourceKey: "feature" });
    expect(result.current.error).toBe("");
  });

  it("ignores a late answer for the previous key", async () => {
    const { load, calls } = loader();
    const { result, rerender } = resource(load, { resourceKey: "main" });
    rerender({ resourceKey: "feature" });

    calls[0].resolve("main data");
    await advance();
    expect(result.current).toMatchObject({ data: null, pending: true });

    calls[1].resolve("feature data");
    await advance();
    expect(result.current).toMatchObject({
      data: "feature data",
      pending: false,
    });
  });

  it("keeps the data while reloading", async () => {
    const { load, calls } = loader();
    const { result } = resource(load, { resourceKey: "main" });
    calls[0].resolve("first");
    await advance();

    act(() => result.current.reload());
    expect(result.current).toMatchObject({ data: "first", pending: true });
    expect(calls).toHaveLength(2);

    calls[1].resolve("second");
    await advance();
    expect(result.current).toMatchObject({ data: "second", pending: false });
  });

  it("loads again, keeping the data, when the refresh value changes", async () => {
    const { load, calls } = loader();
    const { result, rerender } = resource(load, {
      resourceKey: "main",
      options: { refresh: "revision-1" },
    });
    calls[0].resolve("first");
    await advance();

    rerender({ resourceKey: "main", options: { refresh: "revision-2" } });
    expect(result.current).toMatchObject({ data: "first", pending: true });
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(2);

    calls[1].resolve("second");
    await advance();
    expect(result.current).toMatchObject({ data: "second", pending: false });
  });

  it("ignores a late answer after the refresh value changed", async () => {
    const { load, calls } = loader();
    const { result, rerender } = resource(load, {
      resourceKey: "main",
      options: { refresh: "revision-1" },
    });
    rerender({ resourceKey: "main", options: { refresh: "revision-2" } });

    calls[0].resolve("outdated");
    await advance();
    expect(result.current).toMatchObject({ data: null, pending: true });

    calls[1].resolve("current");
    await advance();
    expect(result.current).toMatchObject({ data: "current", pending: false });
  });

  it("polls without becoming pending again", async () => {
    const { load, calls } = loader();
    const { result } = resource(load, {
      resourceKey: "main",
      options: { interval: 1000 },
    });
    calls[0].resolve("first");
    await advance(1000);
    expect(calls).toHaveLength(2);
    expect(result.current).toMatchObject({ data: "first", pending: false });

    calls[1].resolve("second");
    await advance();
    expect(result.current).toMatchObject({ data: "second", pending: false });
  });

  it("keeps polling after a temporary failure and clears its error", async () => {
    const { load, calls } = loader();
    const { result } = resource(load, {
      resourceKey: "main",
      options: { interval: 1000 },
    });
    calls[0].reject(new ApiError("Bad gateway", 502));
    await advance();
    expect(result.current.error).toBe("Bad gateway");

    await advance(1000);
    calls[1].resolve("recovered");
    await advance();
    expect(result.current).toMatchObject({ data: "recovered", error: "" });
  });

  it("stops polling after a final API error", async () => {
    const { load, calls } = loader();
    const { result } = resource(load, {
      resourceKey: "main",
      options: { interval: 1000 },
    });
    calls[0].reject(new ApiError("Not found", 404));
    await advance(10_000);
    expect(calls).toHaveLength(1);
    expect(result.current).toMatchObject({
      error: "Not found",
      pending: false,
    });
  });

  it("loads nothing while disabled", async () => {
    const { load } = loader();
    const { result } = resource(load, {
      resourceKey: "main",
      options: { enabled: false },
    });
    await advance(5000);
    expect(load).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, pending: false });
  });

  it("replaces the loaded data locally", async () => {
    const { load, calls } = loader<{ name: string }>();
    const { result } = resource(load, { resourceKey: "main" });
    calls[0].resolve({ name: "Orders" });
    await advance();

    act(() => result.current.setData({ name: "Sales" }));
    expect(result.current.data).toEqual({ name: "Sales" });
    act(() =>
      result.current.setData((current) => ({ name: current!.name + " 2025" })),
    );
    expect(result.current.data).toEqual({ name: "Sales 2025" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps reload and setData stable across renders", async () => {
    const { load, calls } = loader();
    const { result, rerender } = resource(load, { resourceKey: "main" });
    const { reload, setData } = result.current;
    calls[0].resolve("first");
    await advance();
    rerender({ resourceKey: "main" });
    expect(result.current.reload).toBe(reload);
    expect(result.current.setData).toBe(setData);
  });
});

describe("useApiResource", () => {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("reads the JSON answer of an API path", async () => {
    const fetch = vi.fn(async () => respond(200, [{ id: "orders" }]));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() =>
      useApiResource<{ id: string }[]>("/projects"),
    );
    await advance();
    expect(result.current).toMatchObject({
      data: [{ id: "orders" }],
      error: "",
      pending: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("reports the error message of the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(404, { error: "Project not found" })),
    );
    const { result } = renderHook(() => useApiResource("/projects/missing"));
    await advance();
    expect(result.current).toMatchObject({
      data: null,
      error: "Project not found",
      pending: false,
    });
  });

  it("requests nothing for a null path", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useApiResource(null));
    await advance();
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });
});
