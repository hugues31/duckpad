// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import DocumentationPanel from "./DocumentationPanel";
import en from "./locales/en.json";
import { labelLines } from "./PipelineDiagram";
import { nodeAnchor, projectDocumentation } from "./projectDocumentation";
import type { Snapshot, Statuses } from "./types";

vi.mock("./useRevisionDraft", () => ({
  useRevisionDraft: (draft: string) => ({
    draft,
    update: vi.fn(),
    persist: vi.fn(),
    pending: false,
    dirty: false,
  }),
}));
afterEach(cleanup);

const t = (key: keyof typeof en) => en[key];
const template = (definition: object) => ({
  parameters: [],
  inputs: [],
  outputs: ["result"],
  blocks: [],
  ...definition,
});
const snapshot = {
  worktree: { id: "tree", project: "project", branch: "main" },
  commit: "0123456789abcdef",
  connections: [
    {
      id: "lake",
      name: "Data lake",
      family: "storage",
      capabilities: ["read"],
    },
    { id: "spare", name: "Spare", family: "database", capabilities: [] },
  ],
  node_names: {
    orders: [{ label: "Orders" }],
    revenue: [{ label: "Revenue" }],
    report: [{ label: "Report" }],
    "report::daily": [{ label: "Report" }, { label: "Daily totals" }],
    export: [{ label: "Export" }],
  },
  parsed_templates: {
    load_csv: template({
      label: "Load CSV",
      description: "Read a CSV file.",
      parameters: [
        { name: "connection", type: "connection", default: "" },
        { name: "file", type: "file(connection)", default: "" },
        { name: "delimiter", type: "text", default: "," },
      ],
    }),
    export_csv: template({
      label: "Export CSV",
      inputs: ["source"],
      outputs: [],
      writes_external: true,
      blocks: [
        { output: null, test_name: "not_empty", test_severity: "error" },
      ],
    }),
  },
  parsed_nodes: {
    "nodes/revenue.sql": template({
      inputs: ["source"],
      parameters: [{ name: "minimum_amount", type: "number", default: 0 }],
      blocks: [
        { output: "result" },
        {
          output: null,
          test_name: "positive_amount",
          test_severity: "warning",
        },
      ],
    }),
    "components/daily_report/daily.sql": template({
      inputs: ["source"],
      parameters: [{ name: "threshold", type: "number", default: 1 }],
    }),
  },
  variables: {
    file_error: null,
    undeclared: {},
    diagnostics: [],
    warnings: [],
    declarations: {
      minimum: {
        type: "number",
        description: "Smallest amount kept.",
        default: 10,
        environments: { prod: 50 },
        errors: [],
        warnings: [],
        values: { dev: { value: 10 }, prod: { value: 50 } },
        usages: [
          { node: "revenue", label: "Revenue", param: "minimum_amount" },
        ],
      },
    },
  },
  bundle: {
    flow: {
      id: "flow",
      name: "Sales",
      description: "From orders to revenue",
      // Stored out of order: the document follows the pipeline.
      nodes: [
        {
          id: "export",
          template: "export_csv",
          params: {},
          position: { x: 600, y: 0 },
        },
        {
          id: "report",
          component: "daily_report",
          params: { level: 5 },
          position: { x: 400, y: 0 },
        },
        {
          id: "revenue",
          params: { minimum_amount: { $var: "minimum" } },
          position: { x: 200, y: 0 },
        },
        {
          id: "orders",
          template: "load_csv",
          params: { connection: "lake", file: "orders.csv" },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [
        edge("orders", "result", "revenue", "source"),
        edge("revenue", "result", "report", "rows"),
        edge("report", "totals", "export", "source"),
      ],
    },
    templates: {},
    components: {
      daily_report: {
        name: "Daily report",
        description: "Totals per day.",
        nodes: [{ id: "daily", params: {}, position: { x: 0, y: 0 } }],
        edges: [],
        inputs: { rows: { node: "daily", port: "source" } },
        outputs: { totals: { node: "daily", port: "result" } },
        parameters: {
          level: {
            type: "number",
            default: 1,
            targets: [{ node: "daily", param: "threshold" }],
          },
        },
      },
    },
    charts: { "report::daily:result": [{ name: "Daily revenue", spec: {} }] },
    views: { "revenue:result": [{ name: "Large orders" }] },
    documentation: {
      project:
        "# Revenue guide\n\n**Business context**\n\n<script>alert(1)</script>",
      nodes: { revenue: "Daily revenue" },
      datasets: { "revenue:result": "Revenue output" },
      columns: { "revenue:result": { amount: "Gross amount" } },
    },
  },
} as unknown as Snapshot;

function edge(source: string, port: string, target: string, input: string) {
  return {
    id: `${source}-${target}`,
    source,
    sourceHandle: port,
    target,
    targetHandle: input,
  };
}

const empty: Statuses = { nodes: {}, active: null };
const ran = {
  active: null,
  nodes: {
    revenue: {
      error: null,
      outputs: {
        result: {
          columns: [{ name: "amount", type: "BIGINT" }],
          count: 3,
          status: "stale",
          created: "2026-01-02T03:04:05Z",
        },
      },
      results: [
        {
          level: "warning",
          message: "Test positive_amount failed: 2 failing rows",
          observed: 2,
          origin: { kind: "test", name: "positive_amount" },
          status: "warning",
        },
      ],
    },
    "report::daily": {
      error: null,
      outputs: {
        result: {
          columns: [{ name: "day", type: "DATE" }],
          count: 1,
          status: "valid",
          created: "2026-01-02T03:04:05Z",
        },
      },
    },
  },
} as unknown as Statuses;

const panel = (
  props: Partial<Parameters<typeof DocumentationPanel>[0]> = {},
) => (
  <MemoryRouter>
    <DocumentationPanel
      snapshot={snapshot}
      statuses={empty}
      environment="dev"
      environments={[
        { id: "dev", label: "Dev", color: "", confirm_before_run: false },
        { id: "prod", label: "Prod", color: "", confirm_before_run: false },
      ]}
      onSave={vi.fn()}
      {...props}
    />
  </MemoryRouter>
);

it("describes the project in pipeline order, by role", () => {
  const documentation = projectDocumentation(snapshot, empty, t)!;
  expect(documentation.name).toBe("Sales");
  expect(documentation.sources.map((node) => node.label)).toEqual(["Orders"]);
  expect(documentation.transformations.map((node) => node.label)).toEqual([
    "Revenue",
    "Report",
  ]);
  expect(documentation.exports.map((node) => node.label)).toEqual(["Export"]);
  expect(documentation.diagram.nodes.map((node) => node.id)).toEqual([
    "orders",
    "revenue",
    "report",
    "export",
  ]);
  expect(documentation.diagram.edges).toHaveLength(3);
  const [revenue, report] = documentation.transformations;
  expect(revenue.reads).toEqual([{ id: "orders", label: "Orders" }]);
  expect(revenue.feeds).toEqual([{ id: "report", label: "Report" }]);
  expect(revenue.description).toBe("Daily revenue");
  // An undocumented node falls back on what its definition says.
  expect(documentation.sources[0].description).toBe("Read a CSV file.");
  expect(documentation.sources[0].documented).toBe(false);
  expect(report).toMatchObject({
    kind: "component",
    definition: "Daily report",
    description: "Totals per day.",
  });
  expect(documentation.coverage).toEqual({
    nodes: { documented: 1, total: 4 },
    columns: { documented: 1, total: 1 },
  });
});

it("lists only the parameters a node sets, with their variables and connections", () => {
  const documentation = projectDocumentation(snapshot, empty, t)!;
  expect(documentation.sources[0].parameters).toEqual([
    {
      name: "connection",
      label: "connection",
      value: "lake",
      connection: "Data lake",
    },
    { name: "file", label: "file", value: "orders.csv" },
  ]);
  expect(documentation.transformations[0].parameters).toEqual([
    {
      name: "minimum_amount",
      label: "minimum amount",
      value: { $var: "minimum" },
      variable: "minimum",
    },
  ]);
  expect(documentation.connections).toEqual([
    expect.objectContaining({
      name: "Data lake",
      usedBy: [{ id: "orders", label: "Orders" }],
    }),
    expect.objectContaining({ name: "Spare", usedBy: [] }),
  ]);
  expect(documentation.variables.map((variable) => variable.name)).toEqual([
    "minimum",
  ]);
});

it("shows the nodes of a component with the values its instance gives them", () => {
  const report = projectDocumentation(snapshot, ran, t)!.transformations[1];
  expect(report.steps).toHaveLength(1);
  const [daily] = report.steps;
  expect(daily).toMatchObject({ id: "report::daily", label: "Daily totals" });
  expect(daily.parameters).toEqual([
    { name: "threshold", label: "threshold", value: 5 },
  ]);
  // The instance exposes the rows stored by its inner node, with its charts.
  expect(report.outputs[0]).toMatchObject({
    port: "totals",
    charts: ["Daily revenue"],
    columns: [{ name: "day", type: "DATE", description: "" }],
  });
  expect(report.outputs[0].dataset?.count).toBe(1);
});

it("combines retained schemas with descriptions and reports tests with their latest outcome", () => {
  const before = projectDocumentation(snapshot, empty, t)!;
  const [undiscovered] = before.transformations[0].outputs;
  expect(undiscovered.dataset).toBeUndefined();
  expect(undiscovered.columns).toEqual([
    { name: "amount", type: "", description: "Gross amount" },
  ]);
  expect(before.tests).toEqual([
    {
      node: { id: "revenue", label: "Revenue" },
      test: { name: "positive_amount", severity: "warning" },
    },
    {
      node: { id: "export", label: "Export" },
      test: { name: "not_empty", severity: "error" },
    },
  ]);
  const after = projectDocumentation(snapshot, ran, t)!;
  const [output] = after.transformations[0].outputs;
  expect(output.columns[0].type).toBe("BIGINT");
  expect(output.dataset?.status).toBe("stale");
  expect(output.views).toEqual(["Large orders"]);
  expect(after.tests[0].test).toEqual({
    name: "positive_amount",
    severity: "warning",
    status: "warning",
    observed: 2,
  });
});

it("renders the document: cover, outline, overview, pipeline and reference", () => {
  const { container } = render(panel({ statuses: ran }));
  expect(screen.getByRole("heading", { level: 1, name: "Sales" })).toBeTruthy();
  expect(screen.getByText("From orders to revenue")).toBeTruthy();
  const outline = screen.getByRole("navigation", { name: "Contents" });
  expect(
    within(outline)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual([
    "Overview",
    "Pipeline",
    "Sources1",
    "Orders",
    "Transformations2",
    "Revenue",
    "Report",
    "Exports1",
    "Export",
    "Variables1",
    "Data tests2",
    "Connections2",
  ]);
  // The overview is read by default, as safe Markdown under the page's headings.
  expect(
    screen.getByRole("heading", { level: 3, name: "Revenue guide" }),
  ).toBeTruthy();
  expect(
    container.querySelector(".documentation-preview strong")?.textContent,
  ).toBe("Business context");
  expect(container.querySelector("script")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  // The reference is generated: nothing in it is editable.
  expect(container.querySelector(".doc-node textarea")).toBeNull();
  const revenue = container.querySelector<HTMLElement>(
    "#" + nodeAnchor("revenue"),
  )!;
  expect(within(revenue).getByText("Gross amount")).toBeTruthy();
  expect(within(revenue).getByText("positive_amount")).toBeTruthy();
  expect(within(revenue).getByText("Failing rows: 2")).toBeTruthy();
  expect(within(revenue).getByText("3 rows")).toBeTruthy();
  expect(within(revenue).getByText("Stale")).toBeTruthy();
  expect(within(revenue).getByText("minimum")).toBeTruthy();
  expect(
    within(revenue)
      .getByRole("link", { name: "Open in Flow: Revenue" })
      .getAttribute("href"),
  ).toBe("/worktrees/tree/flow?environment=dev&node=revenue");
  // Each drawn node leads to its section.
  expect(
    [...container.querySelectorAll(".doc-diagram a")].map((link) =>
      link.getAttribute("href"),
    ),
  ).toEqual([
    "#doc-node-orders",
    "#doc-node-revenue",
    "#doc-node-report",
    "#doc-node-export",
  ]);
  // Inside a component, columns are folded until asked for.
  const step = container.querySelector<HTMLElement>(
    "#" + nodeAnchor("report::daily"),
  )!;
  expect(step.querySelector("details")!.open).toBe(false);
  expect(revenue.querySelector("details")!.open).toBe(true);
});

it("opens the overview editor on request and returns to the rendered text", () => {
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Edit overview" }));
  expect(
    screen.getByRole("textbox", { name: "Project documentation" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("group", { name: "Markdown formatting" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("heading", { name: "Revenue guide" })).toBeTruthy();
});

it("shows only rendered documentation to readers, including after editing access is revoked", () => {
  const { rerender } = render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Edit overview" }));
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect(screen.getByText("Documentation coverage")).toBeTruthy();
  rerender(panel({ readOnly: true }));
  expect(screen.getByRole("heading", { name: "Revenue guide" })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    screen.queryByRole("group", { name: "Markdown formatting" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit overview" })).toBeNull();
  expect(screen.queryByText("Documentation coverage")).toBeNull();
  // Readers can still export the document.
  expect(screen.getByRole("button", { name: "Export PDF" })).toBeTruthy();
});

it("prints the whole document under the project's name", () => {
  const print = vi.fn();
  vi.stubGlobal("print", print);
  document.title = "Documentation · Duckpad";
  const { container } = render(panel({ statuses: ran }));
  fireEvent.click(screen.getByRole("button", { name: "Edit overview" }));
  fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
  expect(print).toHaveBeenCalledOnce();
  // Browsers announce a print, also when it starts from their own menu.
  act(() => {
    window.dispatchEvent(new Event("beforeprint"));
  });
  expect(document.title).toBe("Sales - Documentation");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("heading", { name: "Revenue guide" })).toBeTruthy();
  expect(
    [...container.querySelectorAll("details")].every((item) => item.open),
  ).toBe(true);
  expect(container.querySelector(".doc-print-meta")?.textContent).toContain(
    "Branch main  ·  Commit 01234567  ·  Environment Dev  ·  Generated on",
  );
  act(() => {
    window.dispatchEvent(new Event("afterprint"));
  });
  expect(document.title).toBe("Documentation · Duckpad");
  expect(screen.getByRole("textbox")).toBeTruthy();
  vi.unstubAllGlobals();
});

it("invites to write an overview and to add nodes in an empty project", () => {
  const blank = {
    ...snapshot,
    node_names: {},
    variables: null,
    connections: [],
    bundle: {
      ...snapshot.bundle!,
      flow: { id: "flow", name: "Blank", nodes: [], edges: [] },
      documentation: {},
    },
  } as unknown as Snapshot;
  const { rerender } = render(panel({ snapshot: blank }));
  expect(screen.getByText(/^No overview yet\./)).toBeTruthy();
  expect(screen.getByText(/^This project has no nodes yet\./)).toBeTruthy();
  expect(
    within(screen.getByRole("navigation", { name: "Contents" })).getAllByRole(
      "link",
    ),
  ).toHaveLength(1);
  rerender(panel({ snapshot: blank, readOnly: true }));
  expect(screen.getByText("This project has no overview yet.")).toBeTruthy();
});

it("wraps diagram labels on two lines", () => {
  expect(labelLines("Orders")).toEqual(["Orders"]);
  expect(labelLines("Regional revenue by channel")).toEqual([
    "Regional revenue by",
    "channel",
  ]);
  expect(
    labelLines("Monthly regional revenue by sales channel and segment"),
  ).toEqual(["Monthly regional", "revenue by sales…"]);
  expect(labelLines("customer_lifetime_value_by_cohort")).toEqual([
    "customer_lifetime_…",
  ]);
});
