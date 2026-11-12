// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantTurn } from "./assistantTypes";

afterEach(cleanup);

const context: AssistantTurn["context"] = {
  page: "projects",
  project: null,
  worktree: "",
  branch: "",
  node: "",
  file: "",
  environment: "",
};

it("renders Markdown and SQL without active HTML, unsafe links or remote images", () => {
  const turn: AssistantTurn = {
    user: "Explain the query",
    provider: "primary",
    model: "test",
    status: "complete",
    error: "",
    tools: [],
    context,
    text: '**Result**\n\n```sql\nSELECT 1;\n```\n\n<script>window.bad = true</script>\n\n<img src="https://example.invalid/tracker" onerror="alert(1)">\n\n![image](https://example.invalid/tracker)\n\n[unsafe](javascript:alert(1))\n\n[Docs](https://example.com/docs)',
  };
  const { container, getByText } = render(<AssistantMessage turn={turn} />);
  expect(container.querySelector("script, img")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe("SELECT 1;\n");
  expect(container.querySelector("strong")?.textContent).toBe("Result");
  expect(getByText("unsafe").getAttribute("href")).toBe("");
  expect(getByText("Docs").getAttribute("rel")).toBe("noreferrer");
});

it("names the project and branch a tool call read outside the turn's branch", () => {
  const card = {
    args: { section: "nodes" },
    status: "complete",
    summary: "{}",
  };
  const sales = {
    project: "project_1",
    worktree: "worktree_1",
    project_name: "Sales",
    branch: "main",
  };
  const turn: AssistantTurn = {
    user: "Which nodes of Sales use this connection?",
    provider: "primary",
    model: "test",
    status: "complete",
    error: "",
    context: { ...context, project: "project_2", worktree: "worktree_open" },
    text: "",
    tools: [
      { ...card, id: "listed", name: "list_projects", args: {} },
      { ...card, id: "elsewhere", name: "read_flow", reads: [sales] },
      {
        ...card,
        id: "job",
        name: "inspect_run",
        args: { run: "run_1" },
        reads: [{ ...sales, worktree: "worktree_2", branch: "job:worktree_2" }],
      },
      {
        ...card,
        id: "details",
        name: "read_connections",
        args: { details: true },
        reads: [{ instance: true }],
      },
      {
        ...card,
        id: "open",
        name: "read_flow",
        reads: [{ ...sales, worktree: "worktree_open", project_name: "Mine" }],
      },
    ],
  };
  const { container } = render(<AssistantMessage turn={turn} />);
  expect(
    [...container.querySelectorAll(".assistant-tool-label")].map(
      (label) => label.textContent,
    ),
  ).toEqual([
    "Lists your projects",
    "Reads the flow · Sales / main · nodes",
    "Inspects run diagnostics · Sales",
    "Reads connections",
    "Reads the flow · nodes",
  ]);
});

it("shows the exact changes of an edit to confirm, on the branch it was asked from", () => {
  const turn: AssistantTurn = {
    user: "Document this project like Sales",
    provider: "primary",
    model: "test",
    status: "awaiting_approval",
    error: "",
    context: {
      ...context,
      project: "project_2",
      project_name: "Mine",
      worktree: "worktree_open",
      branch: "main",
    },
    text: "",
    tools: [
      {
        id: "edit",
        name: "write_documentation",
        args: { entry: { section: "project", text: "Copied" } },
        status: "awaiting_approval",
        summary: "",
        approval: {
          kind: "edit",
          decision: null,
          changes: [],
          change_count: 0,
          diffs: [{ path: "README.md", diff: "+Copied", truncated: false }],
        },
      },
    ],
  };
  const decisions: [string, boolean][] = [];
  const onDecision = (tool: string, approved: boolean) =>
    decisions.push([tool, approved]);
  const { container, getByRole, queryByText, rerender } = render(
    <AssistantMessage turn={turn} here canApprove onDecision={onDecision} />,
  );
  expect(container.querySelector(".assistant-run pre")?.textContent).toBe(
    "+Copied",
  );
  expect(queryByText(/Asked on/)).toBeNull();
  getByRole("button", { name: "Apply change" }).click();
  getByRole("button", { name: "Decline" }).click();
  expect(decisions).toEqual([
    ["edit", true],
    ["edit", false],
  ]);
  // From another page, the change can only be declined, and the notice links to its branch.
  rerender(
    <MemoryRouter>
      <AssistantMessage turn={turn} onDecision={onDecision} />
    </MemoryRouter>,
  );
  expect(getByRole("button", { name: "Apply change" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(getByRole("button", { name: "Decline" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(container.querySelector(".assistant-notice")?.textContent).toBe(
    "Asked on Mine / main. Open that branch to confirm.",
  );
  expect(getByRole("link", { name: "Mine / main" }).getAttribute("href")).toBe(
    "/worktrees/worktree_open/flow",
  );
});

it("shows the waiting indicator only while the answer is coming", () => {
  const turn: AssistantTurn = {
    user: "Explain the flow",
    provider: "primary",
    model: "test",
    status: "running",
    error: "",
    tools: [],
    context,
    text: "",
  };
  const { container, getByRole, queryByRole, rerender } = render(
    <AssistantMessage turn={turn} thinking />,
  );
  expect(getByRole("status").textContent).toBe("Reading and composing…");
  expect(container.querySelector(".assistant-markdown")).toBeNull();
  rerender(
    <AssistantMessage
      turn={{ ...turn, status: "complete", text: "Done." }}
      thinking={false}
    />,
  );
  expect(queryByRole("status")).toBeNull();
  expect(container.querySelector(".assistant-markdown")?.textContent).toBe(
    "Done.",
  );
});
