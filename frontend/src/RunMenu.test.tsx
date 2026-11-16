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
  partitionEntry: null,
  snapshot: {
    bundle: { flow: { nodes: [] } },
    partitions: {} as Record<string, unknown>,
  },
}));
vi.mock("./worktree", () => ({
  useLoadedWorktree: () => worktree,
  useOptionalWorktree: () => worktree,
}));
vi.mock("./useApiResource", () => ({
  useApiResource: () => ({ data: { entries: [], next_cursor: null } }),
}));

afterEach(() => {
  cleanup();
  worktree.run.mockClear();
  worktree.snapshot.partitions = {};
});

it("offers only what the Run button does not do", () => {
  render(<RunMenu />);
  const trigger = screen.getByRole("button", { name: "Run options" });
  fireEvent.click(trigger);
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Run everythingComputes every node, sources included"]);
  fireEvent.click(screen.getByRole("menuitem", { name: /Run everything/ }));
  expect(worktree.run).toHaveBeenLastCalledWith(undefined, { reuse: false });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("hangs from the arrow, with its right edge on the button's", () => {
  render(<RunMenu />);
  const trigger = screen.getByRole("button", { name: "Run options" });
  trigger.getBoundingClientRect = () => ({ right: 900, bottom: 60 }) as DOMRect;
  const width = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return (
        this.getAttribute("role") === "menu" ? { width: 240, height: 80 } : {}
      ) as DOMRect;
    });
  trigger.getBoundingClientRect = () => ({ right: 900, bottom: 60 }) as DOMRect;
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu", { name: "Run options" });
  expect(menu.style.left).toBe("660px");
  expect(menu.style.top).toBe("64px");
  width.mockRestore();
});

it("adds the key options of a partitioned flow, which choose what runs", () => {
  worktree.snapshot.partitions = {
    dev: { dimension: { values: { node: "keys" } }, manifest: { count: 1 } },
  };
  render(<RunMenu />);
  fireEvent.click(screen.getByRole("button", { name: "Run options" }));
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual([
    "Run everythingComputes every node, sources included",
    "Run with options…",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Run with options…" }));
  fireEvent.click(screen.getByRole("button", { name: "Run all" }));
  expect(worktree.run).toHaveBeenLastCalledWith(
    undefined,
    expect.objectContaining({ partitions: { mode: "all" }, reuse: false }),
  );
});
