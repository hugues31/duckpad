// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SourcePreview from "./SourcePreview";
import SourceFileField from "./SourceFileField";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lets a user remove a type override that prevents previewing the file", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: "Cannot convert name to INTEGER" }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      ),
  );
  const onTypes = vi.fn();
  render(
    <SourcePreview
      worktree="main"
      params={{ file: "customers.csv", types: { name: "INTEGER" } }}
      csv
      onTypes={onTypes}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Cannot convert name to INTEGER",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Data type: name" }), {
    target: { value: "" },
  });
  expect(onTypes).toHaveBeenCalledWith({});
});

it("shows project file names and commits detected CSV options with the choice", async () => {
  const path = "0123456789abcdef_customers.csv";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url: string, options?: RequestInit) =>
        new Response(
          JSON.stringify(
            options?.method === "POST"
              ? {
                  settings: { delimiter: ";", header: true },
                  columns: [],
                  rows: [],
                }
              : [{ name: "customers.csv", path }],
          ),
        ),
    ),
  );
  const onChange = vi.fn();
  const onBlur = vi.fn();
  render(
    <SourceFileField
      id="file"
      worktree="main"
      value=""
      onChange={onChange}
      onBlur={onBlur}
      csv
    />,
  );
  await screen.findByRole("option", { name: "customers.csv" });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: path } });
  await vi.waitFor(() =>
    expect(onChange).toHaveBeenCalledWith(path, {
      delimiter: ";",
      header: true,
      types: {},
    }),
  );
  expect(onBlur).toHaveBeenCalled();
});
