import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import { partitionFlow } from "./partitions-flow";
import type { Run, Snapshot } from "../src/types";

/** A point per row: every rendered row is one SVG symbol. */
const POINTS = {
  name: "Points",
  spec: {
    mark: "point",
    encoding: {
      x: { field: "x", type: "quantitative" },
      y: { field: "y", type: "quantitative" },
    },
  },
};

/** SQL returning `count` rows of two numeric columns. */
const rows = (count: number) =>
  `-- @output result\nSELECT range AS x, range % 10 AS y FROM range(${count});`;

/** A new project of independent SQL nodes, each charted with `POINTS`. */
async function chartedNodes(page: Page, nodes: Record<string, string>) {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Chart data" },
  });
  const { id } = await created.json();
  const endpoint = `/api/worktrees/${id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const bundle = snapshot.bundle!;
  const names = Object.keys(nodes);
  bundle.flow.nodes = names.map((node, index) => ({
    id: node,
    name: node,
    position: { x: index * 300, y: 0 },
    params: {},
  }));
  bundle.flow.edges = [];
  bundle.node_sql = Object.fromEntries(
    names.map((node) => [`nodes/${node}.sql`, nodes[node]]),
  );
  bundle.charts = Object.fromEntries(
    names.map((node) => [`${node}:result`, [POINTS]]),
  );
  await save(page, endpoint, snapshot.revision, bundle);
  return { id: id as string, endpoint };
}

async function save(
  page: Page,
  endpoint: string,
  revision: Snapshot["revision"],
  bundle: Snapshot["bundle"],
) {
  const saved = await page.request.put(endpoint, {
    data: { revision, bundle },
  });
  expect(saved.ok()).toBe(true);
}

/** Run the project and wait for the run to finish. */
async function run(page: Page, endpoint: string) {
  const launched = await (
    await page.request.post(`${endpoint}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/runs/${launched.id}`)
          ).json()) as Run
        ).status,
      { timeout: 45000 },
    )
    .toMatch(/success|partial_failure|failed/);
}

/** Open a node's Chart tab and return the results panel. */
async function chartTab(page: Page, worktree: string, node: string) {
  await page.goto(`/worktrees/${worktree}/flow?node=${node}`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  return panel;
}

test("a chart draws an output of 5,000 rows and refuses 5,001 with the count", async ({
  page,
}) => {
  test.setTimeout(90000);
  const { id, endpoint } = await chartedNodes(page, {
    fits: rows(5000),
    over: rows(5001),
  });
  await run(page, endpoint);

  const chartRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/preview/fits") &&
      new URL(request.url()).searchParams.get("limit") === "5000"
    )
      chartRequests.push(request.url());
  });
  const fits = await chartTab(page, id, "fits");
  await expect(fits.locator(".chart-view .mark-symbol path")).toHaveCount(
    5000,
    { timeout: 20000 },
  );

  expect(chartRequests).toHaveLength(1);
  const previewLimits: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/preview/over"))
      previewLimits.push(url.searchParams.get("limit"));
  });
  // Keep Chart selected when changing nodes, so the Data tab loads no sample.
  await page.locator('.react-flow__node[data-id="over"]').click();
  const over = fits;
  const refusal = over.getByRole("status").filter({ hasText: "5,001 rows" });
  await expect(refusal).toContainText("5,000");
  await expect(refusal).toContainText("Aggregate");
  await expect(over.locator(".chart-view")).toHaveCount(0);
  await expect(over.locator("svg.marks")).toHaveCount(0);
  for (const limit of previewLimits) expect(limit).toBe("1");
});

test("the Chart tab shows the Data tab's Run hint, Stale badge and failed run", async ({
  page,
}) => {
  test.setTimeout(90000);
  const { id, endpoint } = await chartedNodes(page, { points: rows(3) });

  const panel = await chartTab(page, id, "points");
  const empty = panel.locator(".preview-empty");
  await expect(empty).toContainText("Ready when you are");
  await expect(empty).toContainText(
    "Run this node and its ancestors to materialize a preview.",
  );
  await empty
    .getByRole("button", { name: "Run with ancestors", exact: true })
    .click();
  const symbols = panel.locator(".chart-view .mark-symbol path");
  await expect(symbols).toHaveCount(3, { timeout: 45000 });
  await expect(panel.locator(".results-header .badge")).toHaveText("Valid");

  // A changed query makes the retained result stale: the chart still draws it.
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const bundle = snapshot.bundle!;
  bundle.node_sql = { ...bundle.node_sql, "nodes/points.sql": rows(4) };
  await save(page, endpoint, snapshot.revision, bundle);
  await chartTab(page, id, "points");
  await expect(panel.locator(".results-header .badge")).toHaveText("Stale");
  await expect(symbols).toHaveCount(3);
  await expect(panel.locator(".results-chart")).toContainText(
    "This is the last successful result.",
  );

  // A failed run shows its error above the chart, as on the Data tab.
  const current: Snapshot = await (await page.request.get(endpoint)).json();
  current.bundle!.node_sql = {
    ...current.bundle!.node_sql,
    "nodes/points.sql": "-- @output result\nSELECT missing_column;",
  };
  await save(page, endpoint, current.revision, current.bundle);
  await run(page, endpoint);
  await chartTab(page, id, "points");
  await expect(
    panel.getByRole("alert", { name: "Last run failed" }),
  ).toContainText("missing_column");
});

test("raw dotted and bracketed columns render in starter and authored charts", async ({
  page,
}) => {
  const { id, endpoint } = await chartedNodes(page, {
    special:
      "-- @output result\nSELECT * FROM (VALUES ('North', 7), ('South', 12)) t(\"a.b\", \"x[0]\");",
  });
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  snapshot.bundle!.charts = null;
  await save(page, endpoint, snapshot.revision, snapshot.bundle);
  await run(page, endpoint);
  const panel = await chartTab(page, id, "special");
  await panel.getByRole("button", { name: "Add a chart", exact: true }).click();
  await expect(page).toHaveURL(/\/code(\?|$)/);
  const starter: Snapshot = await (await page.request.get(endpoint)).json();
  const saved = JSON.parse(starter.files["charts.json"]);
  expect(saved["special:result"][0].spec.encoding).toEqual({
    x: { field: "a.b", type: "nominal" },
    y: { field: "x[0]", type: "quantitative" },
  });
  await chartTab(page, id, "special");
  const bars = panel.locator(".chart-view .mark-rect path");
  await expect(bars).toHaveCount(2);
  await expect(bars.first()).toHaveAttribute(
    "aria-label",
    /a\.b: North; x\[0\]: 7/,
  );
  await expect(panel.locator(".role-axis-title")).toHaveText(["a.b", "x[0]"]);
  await bars.first().hover();
  await expect(page.locator("#vg-tooltip-element")).toContainText("x[0]");
  await expect(panel.getByRole("alert")).toHaveCount(0);

  starter.bundle!.charts = {
    "special:result": [
      {
        name: "Authored",
        spec: {
          mark: "point",
          encoding: {
            x: { field: "a.b", type: "nominal" },
            y: { field: "x[0]", type: "quantitative" },
            color: { field: "a.b", type: "nominal" },
            tooltip: [{ field: "x[0]", type: "quantitative" }],
          },
        },
      },
    ],
  };
  await save(page, endpoint, starter.revision, starter.bundle);
  await chartTab(page, id, "special");
  await expect(
    panel.locator(".chart-view .mark-symbol.role-mark path"),
  ).toHaveCount(2);
  await expect(panel.locator(".role-legend-title")).toHaveText("a.b");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("the chart limit follows the selected partition and refuses all partitions without rows", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  const { id } = await (
    await page.request.post("/api/projects", {
      data: { name: "Partition chart limit" },
    })
  ).json();
  const endpoint = `/api/worktrees/${id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const bundle = structuredClone(partitionFlow);
  bundle.templates.source =
    "-- @output result\nSELECT batch, range AS amount FROM (VALUES ('batch-011'), ('batch-012')) t(batch) CROSS JOIN range(3000);";
  bundle.charts = {
    "transform:result": [
      {
        name: "Amounts",
        spec: {
          mark: "point",
          encoding: { x: { field: "amount", type: "quantitative" } },
        },
      },
    ],
  };
  await save(page, endpoint, snapshot.revision, bundle);
  await run(page, endpoint);
  const panel = await chartTab(page, id, "transform");
  await expect(
    panel.getByRole("status").filter({ hasText: "6,000 rows" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: /^batch-011 · Valid/ }).click();
  await expect(
    panel.locator(".chart-view .mark-symbol.role-mark path"),
  ).toHaveCount(3000, { timeout: 20000 });
  const previewLimits: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/preview/transform"))
      previewLimits.push(url.searchParams.get("limit"));
  });
  await panel.getByRole("button", { name: "All", exact: true }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "6,000 rows" }),
  ).toBeVisible();
  await expect(panel.locator(".chart-view")).toHaveCount(0);
  for (const limit of previewLimits) expect(limit).toBe("1");
});
