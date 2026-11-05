// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DocumentationPanel from "./DocumentationPanel";
import { projectDocumentation } from "./projectDocumentation";
import type { Snapshot, Statuses } from "./types";

vi.mock("./useRevisionDraft", () => ({
  useRevisionDraft: (draft: string) => ({
    draft,
    update: vi.fn(),
    persist: vi.fn(),
    pending: false,
  }),
}));
afterEach(cleanup);
const snapshot = {
  node_names: { node_1: [{ label: "Revenue" }] },
  parsed_templates: {},
  parsed_nodes: {
    "nodes/node_1.sql": {
      outputs: ["result"],
      blocks: [{ test_name: "positive_amount" }],
    },
  },
  bundle: {
    flow: { nodes: [{ id: "node_1" }] },
    components: {},
    documentation: {
      project:
        "# Revenue guide\n\n**Business context**\n\n<script>alert(1)</script>",
      nodes: { node_1: "Daily revenue" },
      datasets: { "node_1:result": "Revenue output" },
      columns: { "node_1:result": { amount: "Gross amount" } },
    },
  },
} as unknown as Snapshot;

it("renders Markdown safely and keeps generated reference read only", () => {
  const { container } = render(
    <DocumentationPanel
      snapshot={snapshot}
      statuses={{ nodes: {}, active: null }}
      onSave={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Markdown preview" }));
  expect(screen.getByRole("heading", { name: "Revenue guide" })).toBeTruthy();
  expect(container.querySelector("strong")?.textContent).toBe(
    "Business context",
  );
  expect(container.querySelector("script")).toBeNull();
  expect(
    container.querySelector(".generated-documentation textarea"),
  ).toBeNull();
  expect(screen.getByText("Gross amount")).toBeTruthy();
  expect(screen.getByText("positive_amount")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("textbox")).toBeTruthy();
});

it("combines retained schema with descriptions and declares schemas unavailable before a run", () => {
  const before = projectDocumentation(snapshot, { nodes: {}, active: null })[0];
  expect(before.outputs[0].dataset).toBeUndefined();
  expect(before.outputs[0].columns).toEqual([
    { name: "amount", type: "", description: "Gross amount" },
  ]);
  const statuses = {
    nodes: {
      node_1: {
        outputs: {
          result: {
            columns: [{ name: "amount", type: "BIGINT" }],
            count: 3,
            status: "stale",
          },
        },
      },
    },
  } as unknown as Statuses;
  const after = projectDocumentation(snapshot, statuses)[0];
  expect(after.outputs[0].columns[0].type).toBe("BIGINT");
  expect(after.outputs[0].dataset?.status).toBe("stale");
  expect(after.description).toBe("Daily revenue");
});
