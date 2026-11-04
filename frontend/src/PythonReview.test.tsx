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
import ResultsLog from "./ResultsLog";
import ParameterField from "./ParameterField";
import type { NodeResult, Snapshot, Statuses, Workspace } from "./types";

// Asking the assistant needs the application shell.
vi.mock("./AskAssistant", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

it("shows historical Python logs without durations and offers their artifacts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      json(
        url.includes("/exports/")
          ? { status: "available", filename: "report.txt", run: "run" }
          : {
              id: "run",
              commit: "abc123456",
              status: "success",
              environment: "dev",
              nodes: {
                python: {
                  status: "success",
                  artifact: {},
                  results: [
                    {
                      level: "info",
                      message: "Python output",
                      origin: { kind: "message", block: "Python" },
                    },
                  ],
                  outputs: {
                    result: {
                      count: 2,
                      columns: [{ name: "x", type: "INTEGER" }],
                      duration: null,
                    },
                  },
                },
              },
            },
      ),
    ),
  );
  render(
    <MemoryRouter>
      <ResultsLog
        snapshot={{ worktree: { id: "tree" } } as Snapshot}
        environment="dev"
        fullNode="python"
        exportNode={false}
        download
        readOnly={false}
        result={{ result_run: "run" } as NodeResult}
        inputs={[]}
        statuses={{ nodes: {} } as Statuses}
        onTests={() => {}}
      />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Python output")).toBeTruthy();
  expect(await screen.findByRole("button", { name: /Download/ })).toBeTruthy();
});

const logProps = {
  snapshot: { worktree: { id: "tree" } } as Snapshot,
  environment: "dev",
  fullNode: "python",
  readOnly: false,
  inputs: [],
  statuses: { nodes: {} } as unknown as Statuses,
  onTests: () => {},
};

it("offers a download before any run only for Python nodes without outputs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ status: "available", filename: "report.txt", run: "run" }),
    ),
  );
  const { rerender } = render(
    <MemoryRouter>
      <ResultsLog {...logProps} exportNode={false} download />
    </MemoryRouter>,
  );
  expect(screen.getByText("This node has not run in this environment"));
  expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  rerender(
    <MemoryRouter>
      <ResultsLog {...logProps} exportNode download />
    </MemoryRouter>,
  );
  expect(await screen.findByRole("button", { name: /Download/ })).toBeTruthy();
});

it("shows a Python traceback once, in a code block, and its summary in the timeline", async () => {
  const traceback =
    'Traceback (most recent call last):\n  File "nodes/boom.py", line 7, in run\n    raise ValueError("boom")\nValueError: boom\n';
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        id: "run",
        commit: "abc123456",
        status: "failed",
        environment: "dev",
        nodes: { python: { status: "failed", error: traceback } },
      }),
    ),
  );
  const { container } = render(
    <MemoryRouter>
      <ResultsLog
        {...logProps}
        exportNode={false}
        download={false}
        result={{ error: traceback, error_run: "run" } as NodeResult}
      />
    </MemoryRouter>,
  );
  await screen.findByText("ValueError: boom");
  expect(container.querySelector(".log-error pre")?.textContent).toBe(
    traceback,
  );
  expect(container.querySelector(".log-timeline")?.textContent).not.toContain(
    "Traceback",
  );
});

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

it("explains integer and bound errors on numeric Python fields", () => {
  render(
    <ParameterField
      parameter={{
        name: "limit",
        type: "number",
        python_type: "int",
        ge: 1,
        le: 10,
      }}
      value={1}
      onChange={() => {}}
      connections={[]}
    />,
  );
  const input = screen.getByRole("textbox", {
    name: "limit",
  }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "2.5" } });
  fireEvent.blur(input);
  expect(input.validationMessage).toBe("Enter a whole number");
  fireEvent.change(input, { target: { value: "11" } });
  fireEvent.blur(input);
  expect(input.validationMessage).toBe("The value must satisfy: ≥ 1, ≤ 10");
  expect(screen.getByText("int · ≥ 1 · ≤ 10")).toBeTruthy();
});
