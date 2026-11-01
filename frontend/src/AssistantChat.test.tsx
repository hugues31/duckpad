// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AssistantMessage } from "./AssistantChat";
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
