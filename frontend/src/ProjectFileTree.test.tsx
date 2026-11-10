// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ProjectFileTree from "./ProjectFileTree";

afterEach(cleanup);

it("filters by a node's display name and file path without selecting another file", () => {
  const onSelect = vi.fn();
  render(
    <ProjectFileTree
      files={{
        "README.md": "",
        "nodes/total.sql": "",
        "templates/filter.sql": "",
      }}
      selected="README.md"
      names={{ total: [{ label: "Revenue total" }] }}
      onSelect={onSelect}
    />,
  );
  const filter = screen.getByRole("searchbox");
  fireEvent.change(filter, { target: { value: "REVENUE sql" } });
  expect(screen.getByRole("treeitem", { name: "Revenue total" })).toBeTruthy();
  expect(screen.queryByRole("treeitem", { name: "README.md" })).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledWith("nodes/total.sql");
  fireEvent.keyDown(filter, { key: "Escape" });
  expect(
    screen
      .getByRole("treeitem", { name: "README.md" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    screen
      .getByRole("treeitem", { name: "templates" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.change(filter, { target: { value: "templates/filter" } });
  expect(
    screen.getByRole("treeitem", { name: "templates/filter.sql" }),
  ).toBeTruthy();
});
