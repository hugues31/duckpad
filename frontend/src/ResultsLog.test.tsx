// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import ResultsLog from "./ResultsLog";
import type { NodeResult, Snapshot, Statuses } from "./types";

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

it("names Python messages and captured output instead of a message block", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        id: "run",
        commit: "abc123456",
        status: "success",
        environment: "dev",
        nodes: {
          python: {
            status: "success",
            results: [
              {
                level: "info",
                message: "split done",
                origin: { kind: "message", block: "Python" },
              },
              {
                level: "info",
                message: "stdout line",
                origin: { kind: "message", block: "Python stdout/stderr" },
              },
              {
                level: "warning",
                message: "Check the amounts",
                origin: { kind: "message", block: 2 },
                output: "result",
              },
            ],
          },
        },
      }),
    ),
  );
  const { container } = render(
    <MemoryRouter>
      <ResultsLog
        {...logProps}
        exportNode={false}
        download={false}
        result={{ result_run: "run" } as NodeResult}
      />
    </MemoryRouter>,
  );
  await screen.findByText("split done");
  const timeline = container.querySelector(".log-timeline")?.textContent;
  expect(timeline).toContain("Python message");
  expect(timeline).toContain("Python output");
  expect(timeline).toContain("Message block 2 · result");
  expect(timeline).not.toContain("Message block Python");
});

it("does not claim that a muted export wrote its destination", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        id: "run",
        commit: "abc123456",
        status: "success",
        environment: "dev",
        nodes: {
          python: {
            status: "success",
            muted: true,
            writes_external: false,
            statements: [],
          },
        },
      }),
    ),
  );
  const { container } = render(
    <MemoryRouter>
      <ResultsLog
        {...logProps}
        exportNode
        download={false}
        result={{ result_run: "run" } as NodeResult}
      />
    </MemoryRouter>,
  );
  expect(await screen.findByText("Muted, code skipped")).toBeTruthy();
  expect(screen.queryByText("Written to the destination")).toBeNull();
  expect(container.querySelector(".log-export")).toBeNull();
});
