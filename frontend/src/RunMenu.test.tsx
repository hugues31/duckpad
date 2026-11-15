// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RunMenu } from "./RunMenu";

const worktree = vi.hoisted(() => ({
  id: "w",
  environment: "dev",
  canEdit: true,
  starting: false,
  run: vi.fn(),
  snapshot: { bundle: {}, partitions: {} as Record<string, unknown> },
}));
vi.mock("./worktree", () => ({
  useLoadedWorktree: () => worktree,
  useOptionalWorktree: () => worktree,
}));

afterEach(() => {
  cleanup();
  worktree.run.mockClear();
  worktree.snapshot.partitions = {};
});

it("runs what changed by default and everything on request", () => {
  render(<RunMenu />);
  const trigger = screen.getByRole("button", { name: "Run options" });
  fireEvent.click(trigger);
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual([
    "Run what changedKeeps valid results",
    "Run everythingReads the sources again",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: /Run what changed/ }));
  expect(worktree.run).toHaveBeenLastCalledWith();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: /Run everything/ }));
  expect(worktree.run).toHaveBeenLastCalledWith(undefined, { reuse: false });
});

it("leaves the menu of a partitioned flow to its key options", () => {
  worktree.snapshot.partitions = {
    dev: { dimension: { values: { node: "keys" } } },
  };
  render(<RunMenu />);
  expect(screen.queryByRole("button", { name: "Run options" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Run with options…" }),
  ).toBeTruthy();
});
