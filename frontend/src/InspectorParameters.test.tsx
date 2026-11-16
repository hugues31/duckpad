// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import InspectorParameters from "./InspectorParameters";
import type { FlowNode, Snapshot } from "./types";

afterEach(cleanup);

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
