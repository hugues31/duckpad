// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";

afterEach(cleanup);

it("skips disabled actions and closes after choosing an enabled action", () => {
  const selected = vi.fn();
  const close = vi.fn();
  render(
    <ActionMenu
      label="Node actions"
      position={{ x: 0, y: 0 }}
      items={[
        { id: "copy", label: "Duplicate", run: vi.fn(), disabled: true },
        { id: "convert", label: "Convert", run: selected },
      ]}
      onClose={close}
    />,
  );
  const action = screen.getByRole("menuitem", { name: "Convert" });
  expect(document.activeElement).toBe(action);
  fireEvent.keyDown(action, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  fireEvent.click(action);
  expect(selected).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(2);
});
