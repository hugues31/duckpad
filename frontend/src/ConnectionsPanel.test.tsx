// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import ConnectionsPanel from "./ConnectionsPanel";
import type { Workspace } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const workspace = {
  user: {},
  projects: [],
  worktrees: [],
  catalog: {
    environments: ["dev", "prod"],
    environment_details: [
      { id: "dev", label: "Dev", color: "#16a34a", confirm_before_run: false },
      { id: "prod", label: "Prod", color: "#dc2626", confirm_before_run: true },
    ],
    connectors: [
      {
        id: "native",
        name: "Native",
        family: "database",
        parameters: [{ name: "path", type: "text" }],
        capabilities: ["read", "write"],
      },
    ],
    connections: [
      {
        id: "warehouse",
        name: "Warehouse",
        connector: "native",
        environments: { dev: { path: "dev.db" }, prod: { path: "prod.db" } },
      },
    ],
  },
} as unknown as Workspace;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

it("ignores the answer of a test whose environment or values changed since", async () => {
  const answers: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve))),
  );
  render(
    <ConnectionsPanel
      workspace={workspace}
      refresh={async () => {}}
      onEditor={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Warehouse/ }));
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(screen.getByRole("button", { name: "Testing…" })).toHaveProperty(
    "disabled",
    true,
  );
  // A dev failure answered after switching to prod stays out of the prod form.
  fireEvent.click(screen.getByRole("button", { name: "Prod" }));
  await act(async () =>
    answers[0](json({ error: "password authentication failed" }, 422)),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  // A success answered after an edit does not vouch for the edited values.
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  fireEvent.change(screen.getByLabelText("path"), {
    target: { value: "other.db" },
  });
  await act(async () => answers[1](json({ schemas: ["main"], tables: [] })));
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Test connection" }),
  ).toHaveProperty("disabled", false);
  // The test of the values on screen reports its environment.
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await act(async () => answers[2](json({ schemas: ["main"], tables: [] })));
  expect(screen.getByRole("status").textContent).toBe(
    "Connected in Prod. Schemas: 1, tables: 0.",
  );
});
