// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import BranchResultsNotice from "./BranchResultsNotice";
import ComparisonView from "./ComparisonView";
import GitSyncButton from "./GitSyncButton";
import GitSyncTab from "./GitSyncTab";
import GitDataImpact from "./GitDataImpact";
import type { ComparisonReport, MergeReview, RemoteStatus } from "./gitTypes";

const worktree = vi.hoisted(() => ({
  snapshot: {
    worktree: { branch: "feature", read_only: false },
    bundle: { flow: { nodes: [{ id: "filter" }] } },
  },
  statuses: { nodes: {} as Record<string, unknown>, active: null as unknown },
  canEdit: true,
  starting: false,
  run: vi.fn(),
}));
vi.mock("./worktree", () => ({ useLoadedWorktree: () => worktree }));
vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: () => null,
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  Position: { Right: "right", Left: "left" },
  useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock("./Editor", () => ({
  CodeDiff: () => <div data-testid="code-diff" />,
}));
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it("explains the empty branch and uses the existing run action until execution starts", () => {
  const view = render(<BranchResultsNotice />);
  expect(screen.getByRole("status").textContent).toContain(
    "No results on this branch · 1 node",
  );
  fireEvent.click(screen.getByRole("button", { name: "Run all" }));
  expect(worktree.run).toHaveBeenCalledOnce();
  worktree.statuses.nodes = { filter: { execution_status: "success" } };
  view.rerender(<BranchResultsNotice />);
  expect(screen.queryByRole("status")).toBeNull();
  worktree.statuses.nodes = {};
});

it("shows only the changed leaf field and keeps unchanged code in a collapsed definition", () => {
  const node = {
    id: "filter",
    params: { condition: "paid", unchanged: 1 },
    sql: "SELECT * FROM source",
    position: { x: 0, y: 0 },
  };
  const report = {
    entities: [
      {
        id: "node/filter",
        name: "Filter",
        kind: "node",
        file: "flow.json",
        scope: "",
        status: "modified",
        categories: ["processing"],
        fields: ["params/condition"],
        before: node,
        after: { ...node, params: { ...node.params, condition: "pending" } },
      },
    ],
    counts: { modified: 1 },
    categories: { processing: 1, documentation: 0, layout: 0 },
    diagnostics: [],
  } as unknown as ComparisonReport;
  render(<ComparisonView report={report} storageKey="test" />);
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(2);
  expect(rows[1].textContent).toBe("params.conditionpaidpending");
  expect(screen.queryByTestId("code-diff")).toBeNull();
  expect(screen.getByText("Full definition").closest("details")?.open).toBe(
    false,
  );
});

it("hides disconnected synchronization and displays a single incoming/outgoing status when connected", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(json({ url: null, state: "disconnected" }));
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <GitSyncButton worktree="main" commit="a" version={0} onClick={() => {}} />,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button")).toBeNull();
  fetch.mockResolvedValue(
    json({
      url: "https://example.invalid/repo.git",
      state: "diverged",
      ahead: 1,
      behind: 2,
    }),
  );
  view.rerender(
    <GitSyncButton worktree="main" commit="b" version={1} onClick={() => {}} />,
  );
  expect(
    (await screen.findByRole("button", { name: "Git synchronization" }))
      .textContent,
  ).toContain("↓2 ↑1");
});

it("disconnected configuration has no disabled synchronization controls or raw heads", () => {
  render(
    <MemoryRouter>
      <GitSyncTab
        base="/git"
        role="admin"
        storageKey="test"
        repository={{
          branches: [],
          remote: {
            url: null,
            local_branch: "main",
            local_head: "raw-head",
            state: "disconnected",
          } as RemoteStatus,
          loading: false,
          failure: null,
          reload: async () => {},
        }}
        onChanged={async () => {}}
        onReview={() => {}}
        onClose={() => {}}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole("textbox", { name: "Repository URL" })).toBeTruthy();
  expect(screen.queryByText("raw-head")).toBeNull();
  expect(screen.queryByRole("button", { name: "Pull" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Fetch" })).toBeNull();
});

it("calculates data impact only on request and sends the selected result generations and key", async () => {
  const fetch = vi.fn(async (_url: string, options?: RequestInit) =>
    json(
      options?.method === "POST"
        ? { added: 1, removed: 2, modified: 3 }
        : [
            {
              node: "filter",
              name: "Filter",
              port: "result",
              before: { id: "before", count: 5 },
              after: { id: "after", count: 4 },
              columns: { added: ["status"], removed: [], retyped: [] },
              keys: ["id"],
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <GitDataImpact
      review={
        {
          id: "review",
          worktree: "main",
          source: "feature",
          destination: "main",
        } as MergeReview
      }
      environment="dev"
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Calculate row changes",
  });
  expect(fetch).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole("combobox", { name: "Comparison key" }), {
    target: { value: "id" },
  });
  fireEvent.click(button);
  await screen.findByText("Rows added: 1 · Rows removed: 2 · Rows modified: 3");
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
    environment: "dev",
    node: "filter",
    port: "result",
    before: "before",
    after: "after",
    key: "id",
  });
});
