// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
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

it("names the project and branch a tool call read outside the conversation's branch", () => {
  const card = {
    args: { section: "nodes" },
    status: "complete",
    summary: "{}",
  };
  const turn: AssistantTurn = {
    user: "Which nodes of Sales use this connection?",
    provider: "primary",
    model: "test",
    status: "complete",
    error: "",
    context,
    text: "",
    tools: [
      { ...card, id: "listed", name: "list_projects", args: {} },
      {
        ...card,
        id: "elsewhere",
        name: "read_flow",
        reads: [
          {
            project: "project_1",
            worktree: "worktree_1",
            project_name: "Sales",
            branch: "main",
          },
        ],
      },
      {
        ...card,
        id: "job",
        name: "inspect_run",
        args: { run: "run_1" },
        reads: [
          {
            project: "project_1",
            worktree: "worktree_2",
            project_name: "Sales",
            branch: "job:worktree_2",
          },
        ],
      },
      {
        ...card,
        id: "details",
        name: "read_connections",
        args: { details: true },
        reads: [{ instance: true }],
      },
      { ...card, id: "open", name: "read_flow" },
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
