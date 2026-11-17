// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ResourceBrowser from "./ResourceBrowser";
import type { BrowserEntry, BrowserSource } from "./resourceBrowsing";

afterEach(cleanup);

const LEVELS: Record<string, BrowserEntry[]> = {
  "": [
    { path: ["inbox"], kind: "folder" },
    {
      path: ["budget.xlsx"],
      kind: "file",
      size: 2048,
      modified: "2026-11-03T10:00:00+00:00",
    },
  ],
  inbox: [
    { path: ["inbox", "2024"], kind: "folder" },
    { path: ["inbox", "*.csv"], kind: "pattern", count: 2 },
    { path: ["inbox", "january.csv"], kind: "file", size: 10 },
    { path: ["inbox", "february.csv"], kind: "file", size: 20 },
  ],
  "inbox/2024": [],
};
const source: BrowserSource = async (path, filter) => ({
  entries: LEVELS[path.join("/")].filter((entry) =>
    entry.path.at(-1)!.includes(filter),
  ),
  truncated: false,
});
const options = () =>
  screen.getAllByRole("option").map((option) => option.textContent);

function browse(props: Partial<Parameters<typeof ResourceBrowser>[0]> = {}) {
  const onChoose = vi.fn();
  const onChooseFolder = vi.fn();
  const onClose = vi.fn();
  render(
    <ResourceBrowser
      title="Choose a file"
      root="Finance share"
      family="storage"
      source={source}
      onChoose={onChoose}
      onChooseFolder={onChooseFolder}
      onClose={onClose}
      {...props}
    />,
  );
  return { onChoose, onChooseFolder, onClose };
}

it("walks folders with the pointer and the path, then chooses a file", async () => {
  const { onChoose } = browse();
  expect(await screen.findByRole("option", { name: /inbox/ })).toBeTruthy();
  expect(options()).toEqual(["inbox", "budget.xlsx2 kB · Nov 3, 2026"]);
  fireEvent.click(screen.getByRole("option", { name: /inbox/ }));
  expect(await screen.findByRole("option", { name: /january/ })).toBeTruthy();
  expect(options()).toEqual([
    "2024",
    "All CSV files*.csv2 files",
    "january.csv10 bytes",
    "february.csv20 bytes",
  ]);
  const path = screen.getByRole("navigation", { name: "Path" });
  expect(path.textContent).toBe("Finance shareinbox");
  fireEvent.click(screen.getByRole("button", { name: "Finance share" }));
  // The folder just left is the one reached first.
  expect(
    (await screen.findByRole("option", { name: /inbox/ })).getAttribute(
      "aria-selected",
    ),
  ).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: /budget/ }));
  expect(onChoose).toHaveBeenCalledWith(
    expect.objectContaining({ path: ["budget.xlsx"], kind: "file" }),
  );
});

it("is driven from the filter with the keyboard", async () => {
  const { onChoose } = browse();
  const filter = screen.getByRole("combobox", { name: "Filter this folder" });
  await screen.findByRole("option", { name: /inbox/ });
  expect(document.activeElement).toBe(filter);
  fireEvent.keyDown(filter, { key: "Enter" });
  await screen.findByRole("option", { name: /january/ });
  fireEvent.change(filter, { target: { value: "uary" } });
  await screen.findByRole("option", { name: /february/ });
  expect(options()).toEqual(["january.csv10 bytes", "february.csv20 bytes"]);
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  expect(filter.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: /february/ }).id,
  );
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onChoose).toHaveBeenCalledWith(
    expect.objectContaining({ path: ["inbox", "february.csv"] }),
  );
  // Backspace on an empty filter goes back to the parent folder.
  fireEvent.change(filter, { target: { value: "" } });
  fireEvent.keyDown(filter, { key: "Backspace" });
  expect(await screen.findByRole("option", { name: /budget/ })).toBeTruthy();
});

it("opens at the chosen file and offers the open folder itself", async () => {
  const { onChoose, onChooseFolder } = browse({
    initialPath: ["inbox"],
    current: ["inbox", "february.csv"],
  });
  const chosen = await screen.findByRole("option", { name: /february/ });
  expect(chosen.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Current choice")).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: /All CSV files/ }));
  expect(onChoose).toHaveBeenCalledWith(
    expect.objectContaining({ path: ["inbox", "*.csv"], kind: "pattern" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  expect(onChooseFolder).toHaveBeenCalledWith(["inbox"]);
  fireEvent.click(screen.getByRole("option", { name: "2024" }));
  expect((await screen.findByRole("status")).textContent).toBe(
    "This folder is empty.",
  );
});

it("reports a listing failure, retries it, and says when a level is incomplete", async () => {
  const load = vi
    .fn<BrowserSource>()
    .mockRejectedValueOnce(new Error("The storage refused the listing (403)"))
    .mockResolvedValue({
      entries: [{ path: ["orders.csv"], kind: "file" }],
      truncated: true,
    });
  browse({ source: load, onChooseFolder: undefined });
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The storage refused the listing (403)",
  );
  expect(screen.queryByRole("button", { name: "Use this folder" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("option", { name: /orders/ })).toBeTruthy();
  expect(
    screen.getByText(/^Only the first 1,000 names are listed/),
  ).toBeTruthy();
});

it("shows tables of other schemas with their schema", async () => {
  const tables: BrowserSource = async () => ({
    entries: [
      { path: ["sales", "orders"], kind: "table" },
      { path: ["sales", "large_orders"], kind: "view" },
      { path: ["public", "orders"], kind: "table" },
    ],
    truncated: false,
  });
  browse({
    family: "database",
    root: "Warehouse",
    source: tables,
    initialPath: ["sales"],
  });
  await screen.findByRole("option", { name: /large_orders/ });
  expect(options()).toEqual(["orders", "large_ordersview", "public.orders"]);
  expect(
    screen.getByRole("combobox", { name: "Search the tables of every schema" }),
  ).toBeTruthy();
});
