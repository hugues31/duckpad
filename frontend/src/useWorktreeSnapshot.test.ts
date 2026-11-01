// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, Snapshot, Statuses } from "./types";
import { useWorktreeSnapshot } from "./useWorktreeSnapshot";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const snapshot = (worktree: string, revision: string): Snapshot => ({
  role: "editor",
  connections: [],
  worktree: { id: worktree, project: "project", branch: worktree },
  revision,
  commit: "0123abc",
  bundle: null,
  files: {},
  diagnostics: [],
  conflicts: [],
  parsed_templates: {},
  variables: null,
});

const run = (id: string, worktree: string): Run => ({
  id,
  project: "project",
  worktree,
  branch: worktree,
  environment: "dev",
  commit: "0123abc",
  scope: "project",
  trigger: "manual",
  entry_point: "ui",
  status: "running",
  started: "2026-01-01T00:00:00Z",
  nodes: {},
  connections: {},
  definitions: {},
  components: {},
});

const statuses: Statuses = {
  nodes: {
    load_orders: { outputs: {}, error: null, execution_status: "success" },
  },
  active: null,
};

/** Answer API requests by their path below /api. */
function serve(route: (path: string) => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: string) => route(url.replace(/^\/api/, "")));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Advance the fake clock, letting settled requests update the hook. */
const advance = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

interface Props {
  worktree: string;
  environment: string;
  enabled?: boolean;
  onUnavailable?: () => Promise<unknown>;
}

function watch(initialProps: Props) {
  return renderHook(
    ({
      worktree,
      environment,
      enabled = true,
      onUnavailable = async () => undefined,
    }: Props) =>
      useWorktreeSnapshot(worktree, environment, { enabled, onUnavailable }),
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

describe("useWorktreeSnapshot", () => {
  it("loads the snapshot and the statuses of the environment", async () => {
    const fetch = serve((path) =>
      path === "/worktrees/main"
        ? json(snapshot("main", "r1"))
        : json(statuses),
    );
    const { result } = watch({ worktree: "main", environment: "dev" });
    expect(result.current.snapshot).toBeNull();
    await advance();
    expect(result.current).toMatchObject({
      snapshot: snapshot("main", "r1"),
      statuses,
      loadError: "",
    });
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      "/api/worktrees/main",
      "/api/worktrees/main/status?environment=dev",
    ]);
  });

  it("reads only the snapshot without an environment", async () => {
    const fetch = serve(() => json(snapshot("main", "r1")));
    const { result } = watch({ worktree: "main", environment: "" });
    await advance();
    expect(result.current.snapshot?.revision).toBe("r1");
    expect(result.current.statuses).toEqual({ nodes: {}, active: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loads nothing while disabled", async () => {
    const fetch = serve(() => json(snapshot("main", "r1")));
    const { result } = watch({
      worktree: "main",
      environment: "dev",
      enabled: false,
    });
    await advance(5000);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
  });

  it("polls every second, keeping the snapshot object until it changes", async () => {
    let revision = "r1";
    serve(() => json(snapshot("main", revision)));
    const { result } = watch({ worktree: "main", environment: "" });
    await advance();
    const first = result.current.snapshot;

    await advance(1000);
    expect(result.current.snapshot).toBe(first);

    revision = "r2";
    await advance(1000);
    expect(result.current.snapshot?.revision).toBe("r2");
  });

  it("reports a failed read until the next one succeeds", async () => {
    let failing = true;
    serve(() =>
      failing
        ? json({ error: "Database is locked" }, 503)
        : json(snapshot("main", "r1")),
    );
    const { result } = watch({ worktree: "main", environment: "" });
    await advance();
    expect(result.current.loadError).toBe("Database is locked");

    failing = false;
    await advance(1000);
    expect(result.current).toMatchObject({
      loadError: "",
      snapshot: { revision: "r1" },
    });
  });

  it("reports revoked access and recovers once it is restored", async () => {
    let denied = false;
    serve((path) =>
      path !== "/worktrees/main"
        ? json(statuses)
        : denied
          ? json({ error: "Forbidden" }, 403)
          : json(snapshot("main", "r1")),
    );
    const first = vi.fn(async () => undefined);
    const latest = vi.fn(async () => undefined);
    const { result, rerender } = watch({
      worktree: "main",
      environment: "dev",
      onUnavailable: first,
    });
    await advance();
    expect(result.current.snapshot).not.toBeNull();

    // Owners pass a new callback on every render.
    rerender({ worktree: "main", environment: "dev", onUnavailable: latest });
    denied = true;
    await advance(1000);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({
      snapshot: null,
      statuses: { nodes: {}, active: null },
      loadError: "Forbidden",
    });

    denied = false;
    await advance(1000);
    expect(result.current.snapshot?.revision).toBe("r1");
  });

  it("does not treat a missing status as revoked access", async () => {
    serve((path) =>
      path === "/worktrees/main"
        ? json(snapshot("main", "r1"))
        : json({ error: "Unknown environment" }, 404),
    );
    const onUnavailable = vi.fn(async () => undefined);
    const { result } = watch({
      worktree: "main",
      environment: "deleted",
      onUnavailable,
    });
    await advance(3000);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(result.current.snapshot?.revision).toBe("r1");
  });

  it("hides the snapshot of the previous branch", async () => {
    serve((path) => {
      const [, , worktree] = path.split("/");
      return json(snapshot(worktree, `${worktree}-r1`));
    });
    const { result, rerender } = watch({ worktree: "main", environment: "" });
    await advance();
    expect(result.current.snapshot?.worktree.id).toBe("main");

    rerender({ worktree: "feature", environment: "" });
    expect(result.current.snapshot).toBeNull();
    await advance();
    expect(result.current.snapshot?.worktree.id).toBe("feature");
  });

  it("refreshes the current branch, ignoring reads started before", async () => {
    let answer: (response: Response) => void = () => undefined;
    let revision = "r1";
    serve(() =>
      revision === "slow"
        ? new Promise<Response>((resolve) => (answer = resolve))
        : json(snapshot("main", revision)),
    );
    const { result } = watch({ worktree: "main", environment: "" });
    await advance();

    // The next poll starts, then a change is saved and refreshed.
    revision = "slow";
    await advance(1000);
    revision = "r2";
    await act(() => result.current.refresh());
    expect(result.current.snapshot?.revision).toBe("r2");

    await act(async () => answer(json(snapshot("main", "r1"))));
    await advance();
    expect(result.current.snapshot?.revision).toBe("r2");
  });

  it("shows a run as active on its own branch only", async () => {
    serve((path) =>
      path === "/worktrees/main"
        ? json(snapshot("main", "r1"))
        : json(statuses),
    );
    const { result } = watch({ worktree: "main", environment: "dev" });
    await advance();

    act(() => result.current.setActive("feature", run("run_other", "feature")));
    expect(result.current.statuses.active).toBeNull();
    act(() => result.current.setActive("main", run("run_1", "main")));
    expect(result.current.statuses).toEqual({
      ...statuses,
      active: run("run_1", "main"),
    });
  });
});
