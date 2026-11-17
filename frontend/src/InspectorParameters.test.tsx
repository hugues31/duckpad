// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import InspectorParameters from "./InspectorParameters";
import { applyParameterChange } from "./nodeParameters";
import type { FlowNode, Snapshot } from "./types";

afterEach(cleanup);

type Props = ComponentProps<typeof InspectorParameters>;

/** A node's parameters as the inspector shows them; `update` applies changes to `node`. */
function inspect(node: FlowNode, props: Omit<Partial<Props>, "valueOf">) {
  const state = { node };
  const blur = vi.fn();
  const valueOf = (name?: string) =>
    String(state.node.params[name ?? ""] ?? "");
  render(
    <InspectorParameters
      parameters={[]}
      typesInPreview={false}
      draft={node}
      bindable
      snapshot={
        { worktree: { id: "main" }, variables: null } as unknown as Snapshot
      }
      readOnly={false}
      setParameter={() => {}}
      persist={async () => true}
      declared={{ current: {} }}
      rejection={() => new Error("rejected")}
      worktree="main"
      environment="dev"
      nodeProblems={[]}
      update={(change) => {
        state.node = change(state.node);
      }}
      fileSource={false}
      listedConnection={undefined}
      listedSchema={undefined}
      listedTable={undefined}
      blur={blur}
      connections={[
        {
          id: "share",
          name: "Finance share",
          family: "storage",
          capabilities: ["read"],
        },
        {
          id: "sales",
          name: "Sales",
          family: "database",
          capabilities: ["read"],
        },
      ]}
      locations={new Set(["connection"])}
      valueOf={valueOf}
      csvSource={false}
      objectNames={() => undefined}
      database=""
      databaseObjects={null}
      inputColumns={{}}
      schemas={{}}
      {...props}
    />,
  );
  return { state, blur };
}

it("browses the storage connection of any file parameter and writes the chosen path", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          entries: [
            { name: "2024", kind: "folder", size: null, modified: null },
            { name: "orders.parquet", kind: "file", size: 512, modified: null },
          ],
          truncated: false,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  // A custom template: nothing but its parameter types asks for the browser.
  const { state, blur } = inspect(
    {
      id: "read",
      template: "my_reader",
      params: { storage: "share", path: "inbox/old.parquet" },
    } as unknown as FlowNode,
    {
      parameters: [
        { name: "storage", type: "connection", default: "" },
        { name: "path", type: "file(storage)", default: "" },
      ],
      locations: new Set(["storage"]),
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  expect(screen.getByRole("dialog", { name: "Choose a file" })).toBeTruthy();
  // The browser opens in the folder of the path already written.
  expect(fetch).toHaveBeenCalledWith(
    "/api/worktrees/main/connections/share/files?environment=dev&path=inbox",
    expect.anything(),
  );
  fireEvent.click(await screen.findByRole("option", { name: /orders/ }));
  expect(state.node.params.path).toBe("inbox/orders.parquet");
  expect(blur).toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  // Each opening lists the folder again: files may have arrived since.
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  expect(await screen.findByRole("option", { name: /orders/ })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("offers no browser for project files, which list the project's uploads", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]")),
  );
  inspect(
    {
      id: "read",
      template: "my_reader",
      params: { storage: "" },
    } as unknown as FlowNode,
    {
      parameters: [
        { name: "storage", type: "connection", default: "" },
        { name: "path", type: "file(storage)", default: "" },
      ],
    },
  );
  expect(await screen.findByText("Choose a project file…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Browse" })).toBeNull();
});

it("browses the listed database and sets the schema and the table at once", async () => {
  const parameters = [
    { name: "connection", type: "connection", default: "" },
    { name: "schema", type: "schema_name(connection)", default: "public" },
    { name: "table", type: "table_name(schema)", default: "" },
  ];
  const objects = {
    schemas: ["public", "sales"],
    tables: [
      { schema: "public", name: "customers", view: false },
      { schema: "sales", name: "orders", view: false },
    ],
    truncated: false,
  };
  const { state, blur } = inspect(
    {
      id: "read",
      template: "load_table",
      params: { connection: "sales", schema: "public" },
    } as unknown as FlowNode,
    {
      parameters,
      locations: new Set(),
      listedConnection: "connection",
      listedSchema: "schema",
      listedTable: "table",
      database: "sales",
      databaseObjects: objects,
      objectNames: (parameter) =>
        parameter.name === "connection"
          ? undefined
          : { names: [], pending: false, error: "", complete: true },
    },
  );
  // One button, on the table: choosing it also sets its schema.
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  const filter = screen.getByRole("combobox", {
    name: "Search the tables of every schema",
  });
  await screen.findByRole("option", { name: /customers/ });
  fireEvent.change(filter, { target: { value: "ord" } });
  fireEvent.click(
    await screen.findByRole("option", { name: /^sales\.\s*orders$/ }),
  );
  expect(state.node.params).toMatchObject({ schema: "sales", table: "orders" });
  expect(blur).toHaveBeenCalled();
});

it("keeps the changes of a parameter consistent when a file is browsed", () => {
  // The browser writes through the same change as typing the path.
  expect(
    applyParameterChange(
      { id: "read", template: "my_reader", params: {} } as unknown as FlowNode,
      "path",
      "inbox/orders.parquet",
    ).params,
  ).toEqual({ path: "inbox/orders.parquet" });
});

// A Delta table is a folder, which no upload holds: with project files as the
// Location, the root flow and a component both ask for its path.
for (const [context, bindable] of [
  ["the root flow", true],
  ["a component", false],
] as const)
  it(`asks for the path of a Delta table folder in ${context}, not for an uploaded file`, () => {
    render(
      <InspectorParameters
        parameters={[
          { name: "connection", type: "connection", default: "" },
          { name: "table", type: "file(connection)", default: "" },
        ]}
        typesInPreview={false}
        draft={{ id: "lake", template: "load_delta", params: {} } as FlowNode}
        bindable={bindable}
        snapshot={
          { worktree: { id: "main" }, variables: null } as unknown as Snapshot
        }
        readOnly={false}
        setParameter={() => {}}
        persist={async () => true}
        declared={{ current: {} }}
        rejection={() => new Error("rejected")}
        worktree="main"
        environment="dev"
        nodeProblems={[]}
        update={() => {}}
        fileSource={false}
        folderSource
        listedConnection={undefined}
        listedSchema={undefined}
        listedTable={undefined}
        blur={() => {}}
        connections={[]}
        locations={new Set(["connection"])}
        valueOf={() => ""}
        csvSource={false}
        objectNames={() => undefined}
        database=""
        databaseObjects={null}
        inputColumns={{}}
        schemas={{}}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Location" }).textContent).toBe(
      "Project files",
    );
    expect(screen.getByRole("textbox", { name: /^table/ })).toBeTruthy();
    expect(
      screen.getByText(
        /^The path of the table folder, relative to the Location/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Choose a project file…")).toBeNull();
    expect(screen.queryByLabelText("Upload file")).toBeNull();
  });
