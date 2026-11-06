// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionMenuButton } from "./ActionMenu";

afterEach(cleanup);

it("toggles from its trigger and restores focus after keyboard dismissal", () => {
  render(
    <ActionMenuButton
      label="Node actions"
      items={() => [{ id: "copy", label: "Duplicate", run: vi.fn() }]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Node actions" });
  fireEvent.click(trigger);
  expect(screen.getByRole("menuitem")).toBe(document.activeElement);
  fireEvent.pointerDown(trigger);
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("skips disabled actions and closes after choosing an enabled action", () => {
  const selected = vi.fn();
  render(
    <ActionMenuButton
      label="Node actions"
      items={() => [
        { id: "copy", label: "Duplicate", run: vi.fn(), disabled: true },
        { id: "convert", label: "Convert", run: selected },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Node actions" }));
  const action = screen.getByRole("menuitem", { name: "Convert" });
  expect(document.activeElement).toBe(action);
  fireEvent.click(action);
  expect(selected).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
});
