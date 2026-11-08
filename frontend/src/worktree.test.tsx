// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorktreeProvider, useWorktree, type Worktree } from "./worktree";
import type { Snapshot } from "./types";

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  discardRejected: vi.fn(),
  refresh: vi.fn(),
  snapshot: {
    worktree: { id: "branch" },
    role: "editor",
    diagnostics: [],
    revision: "old",
    bundle: {},
  },
}));
vi.mock("./shell", () => ({
  useShell: () => ({
    drafts: { persist: mocks.persist, discardRejected: mocks.discardRejected },
    environment: "dev",
    closeModal: vi.fn(),
  }),
}));
vi.mock("./useWorktreeSnapshot", () => ({
  useWorktreeSnapshot: () => ({
    snapshot: mocks.snapshot,
    refresh: mocks.refresh,
    statuses: {},
  }),
}));

let worktree: Worktree;
function Probe() {
  const value = useWorktree();
  useLayoutEffect(() => {
    worktree = value;
  });
  return null;
}
function mount() {
  render(
    <MemoryRouter>
      <WorktreeProvider worktree="branch">
        <Probe />
      </WorktreeProvider>
    </MemoryRouter>,
  );
}
const json = (value: unknown) => new Response(JSON.stringify(value));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  mocks.persist.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

it("waits for drafts, reads the current grouping revision, tracks flush and undoes the command", async () => {
  const drafts = deferred();
  const response = deferred();
  mocks.persist.mockReturnValueOnce(drafts.promise);
  const fetch = vi.fn(async (path: string) =>
    json(
      path.endsWith("/revert")
        ? { ...mocks.snapshot, change: "undo-group" }
        : { ...mocks.snapshot, revision: "saved-draft" },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  mount();
  const request = vi.fn(async (base: Snapshot) => {
    expect(base.revision).toBe("saved-draft");
    await response.promise;
    return { ...base, change: "group" };
  });
  let pending!: Promise<Snapshot>;
  act(() => {
    pending = worktree.commit(request);
  });
  expect(worktree.saving).toBe(true);
  expect(request).not.toHaveBeenCalled();
  let flushed = false;
  const flush = worktree.flush().then(() => {
    flushed = true;
  });
  await act(async () => {
    drafts.resolve();
  });
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(flushed).toBe(false);
  await act(async () => {
    response.resolve();
    await pending;
    await flush;
  });
  expect(worktree.saving).toBe(false);
  await act(async () => {
    expect(await worktree.undo()).toBe(true);
  });
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/worktrees/branch/revert",
    expect.objectContaining({ body: JSON.stringify({ commit: "group" }) }),
  );
});

it("resolves a retained proposal without resubmitting the rejected editor draft", async () => {
  mocks.persist.mockRejectedValue(new Error("Concurrent edits conflict"));
  const fetch = vi.fn(async () => json(mocks.snapshot));
  vi.stubGlobal("fetch", fetch);
  mount();
  await act(async () => {
    await worktree.commit(async (base) => ({ ...base, change: "resolution" }), {
      conflict: "retained",
    });
  });
  expect(mocks.persist).not.toHaveBeenCalled();
  mocks.persist.mockResolvedValue(undefined);
  await act(async () => {
    expect(await worktree.undo()).toBe(true);
  });
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/worktrees/branch/revert",
    expect.objectContaining({ body: JSON.stringify({ commit: "resolution" }) }),
  );
});

it("clears redo for every new command, and releases saving after a rejected command", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      json({
        ...mocks.snapshot,
        ...(path.endsWith("/revert") ? { change: "undo" } : {}),
      }),
    ),
  );
  mount();
  await act(async () => {
    await worktree.commit(async (base) => ({ ...base, change: "import" }));
  });
  await act(async () => {
    await worktree.undo();
  });
  await act(async () => {
    await worktree.commit(async (base) => ({ ...base, change: "rename" }));
  });
  await act(async () => {
    expect(await worktree.redo()).toBe(false);
  });
  await act(async () => {
    await expect(
      worktree.commit(async () => {
        throw new Error("Rejected");
      }),
    ).rejects.toThrow("Rejected");
  });
  expect(worktree.saving).toBe(false);
  await worktree.flush();
});
