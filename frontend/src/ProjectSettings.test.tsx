// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import ProjectSettings from "./ProjectSettings";
import en from "./locales/en.json";
import type { Workspace } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

it.each(["member", "admin"])(
  "only lets an instance admin save connections (instance role: %s)",
  async (role) => {
    let connections = ["warehouse"];
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options?: RequestInit) => {
        if (options?.method === "PUT") {
          const body = JSON.parse(String(options.body));
          writes.push(body);
          connections = body.connections;
        }
        return json({
          project: { name: "Example" },
          role: "admin",
          users: [],
          members: [],
          connections,
        });
      }),
    );
    render(
      <MemoryRouter>
        <ProjectSettings
          project="example"
          section="connections"
          workspace={
            {
              user: { role },
              catalog: {
                connections: [{ id: "warehouse", name: "Warehouse" }],
              },
            } as unknown as Workspace
          }
          refresh={async () => {}}
          onDeleted={() => {}}
        />
      </MemoryRouter>,
    );
    const grant = await screen.findByRole("checkbox", { name: "Warehouse" });
    await waitFor(() => expect(grant).toHaveProperty("checked", true));
    if (role !== "admin") {
      expect(grant).toHaveProperty("disabled", true);
      expect(screen.getByText(en.projectInstanceAdminHint)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: en.saveConnections }),
      ).toBeNull();
      expect(writes).toEqual([]);
    } else {
      const save = screen.getByRole("button", { name: en.saveConnections });
      expect(save).toHaveProperty("disabled", true);
      expect(grant).toHaveProperty("disabled", false);
      fireEvent.click(grant);
      expect(save).toHaveProperty("disabled", false);
      fireEvent.click(save);
      await waitFor(() => expect(writes).toEqual([{ connections: [] }]));
      await waitFor(() => expect(save).toHaveProperty("disabled", true));
    }
  },
);

it("saves Python activation explicitly and disables source builds until activation", async () => {
  let policy = { enabled: false, allow_builds: false };
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === "PUT") {
        policy = JSON.parse(String(options.body));
        writes.push(policy);
        return json(policy);
      }
      if (url.endsWith("/environment"))
        return json({ state: "unprepared", python: "3.12", duckdb: "2.0.0" });
      return json({
        python: policy,
        project: { name: "Example" },
        role: "admin",
        users: [],
        members: [],
        connections: [],
      });
    }),
  );
  render(
    <MemoryRouter>
      <ProjectSettings
        project="example"
        section="python"
        workspace={
          {
            user: { role: "admin" },
            catalog: { connections: [] },
          } as unknown as Workspace
        }
        refresh={async () => {}}
        onDeleted={() => {}}
      />
    </MemoryRouter>,
  );
  const enabled = await screen.findByRole("checkbox", {
    name: "Enable Python in this project",
  });
  const builds = screen.getByRole("checkbox", {
    name: "Allow dependency source builds",
  });
  expect(builds).toHaveProperty("disabled", true);
  fireEvent.click(enabled);
  expect(writes).toEqual([]);
  expect(builds).toHaveProperty("disabled", false);
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(writes).toEqual([{ enabled: true, allow_builds: false }]),
  );
  await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  // Disabling Python also withdraws source builds.
  fireEvent.click(builds);
  expect(builds).toHaveProperty("checked", true);
  fireEvent.click(enabled);
  expect(builds).toHaveProperty("checked", false);
  expect(builds).toHaveProperty("disabled", true);
  expect(
    screen.queryByText("Allow Python to read authorized connection secrets"),
  ).toBeNull();
});

it("shows the Python policy read-only, without saving, to other users", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      json(
        url.endsWith("/environment")
          ? { state: "ready", python: "3.12", duckdb: "2.0.0" }
          : {
              python: { enabled: true, allow_builds: false },
              project: { name: "Example" },
              role: "admin",
              users: [],
              members: [],
              connections: [],
            },
      ),
    ),
  );
  render(
    <MemoryRouter>
      <ProjectSettings
        project="example"
        section="python"
        workspace={
          {
            user: { role: "editor" },
            catalog: { connections: [] },
          } as unknown as Workspace
        }
        refresh={async () => {}}
        onDeleted={() => {}}
      />
    </MemoryRouter>,
  );
  const enabled = await screen.findByRole("checkbox", {
    name: "Enable Python in this project",
  });
  // The draft follows the loaded policy.
  await waitFor(() => expect(enabled).toHaveProperty("checked", true));
  expect(enabled).toHaveProperty("disabled", true);
  expect(
    screen.getByText(
      "Only an instance administrator can change these settings.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.queryByText(/Stop this project/)).toBeNull();
  expect(
    await screen.findByText(
      "Environment ready; DuckDB pinned to the server version",
    ),
  ).toBeTruthy();
});
