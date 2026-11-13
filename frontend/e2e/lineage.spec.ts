import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { codePanel, signIn } from "./helpers";
import fr from "../src/locales/fr.json" with { type: "json" };
import pt from "../src/locales/pt.json" with { type: "json" };

// The enriched example adds another join to every traced order.
test.setTimeout(90000);

async function example(page: Page) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const run = await (
    await page.request.post(`/api/worktrees/${worktree.id}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      { timeout: 30000 },
    )
    .toBe("success");
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  return worktree.id as string;
}

async function explain(page: Page, column = "net_share", row = 1) {
  await page
    .getByRole("button", {
      name: new RegExp(`Explain this value: ${column}, rows ${row},`),
    })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await expect(panel.locator(".lineage-step.root")).toBeVisible({
    timeout: 30000,
  });
  await expect(panel.locator(".lineage-loading")).toHaveCount(0, {
    timeout: 30000,
  });
  return panel;
}

test("Northstar follows all nodes through nested components in at most ten requests", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await example(page);
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/lineage")) requests.push(req.postData() || "");
  });
  const panel = await explain(page);
  await expect(panel.locator(".lineage-step header button")).toHaveText([
    "Rank regions",
    "Revenue by region",
    "Eligible orders",
    "Net amounts",
    "Channel fees",
    "Paid orders",
    "Enrich orders",
    "Orders",
  ]);
  expect(requests.length).toBeLessThanOrEqual(10);
  await expect(panel.locator(".root .lineage-equation")).toContainText(
    "6643.32",
  );
  await expect(panel.locator(".root .lineage-equation")).toContainText(
    "25959.99",
  );
  await expect(panel.locator(".root .lineage-equation")).toContainText("25.6");
  await expect(panel).not.toContainText("Coverage limitation");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".react-flow__node.lineage-traced"),
  ).not.toHaveCount(0);
  const url = page.url();
  await panel
    .getByRole("button", { name: "Open on the canvas", exact: false })
    .last()
    .click();
  await expect(
    page
      .locator(".react-flow__node.lineage-traced")
      .filter({ hasText: "Revenue by region" }),
  ).toBeVisible();
  await expect(panel.locator(".lineage-step")).toHaveCount(8);
  await page.goto(url);
  await expect(page.locator(".lineage-step.root")).toContainText("25.6");
  expect(errors).toEqual([]);
});

test("aggregate values paginate, change the followed row, and open contributor rows in Data", async ({
  page,
}) => {
  await example(page);
  const panel = await explain(page, "net_revenue");
  const aggregate = panel
    .locator(".lineage-step")
    .filter({
      has: page.locator("header button", { hasText: "Revenue by region" }),
    })
    .first();
  await expect(aggregate.locator(".lineage-value")).toHaveCount(5);
  await expect(aggregate).toContainText("+ 22 more");
  await expect(aggregate.locator(".lineage-equation")).toContainText("6643.32");
  await aggregate.getByRole("button", { name: "Show the 27 values" }).click();
  await expect(aggregate.locator(".lineage-value")).toHaveCount(27);
  await aggregate.locator(".lineage-value").last().click();
  await expect(panel.locator(".lineage-loading")).toHaveCount(0);
  await expect(
    panel
      .locator(".lineage-step")
      .filter({ hasText: "Eligible orders" })
      .first(),
  ).not.toContainText("84.15");
  await aggregate
    .getByRole("button", { name: "Open the 27 rows in Data" })
    .click();
  const data = page.getByRole("region", { name: "Results", exact: true });
  await expect(data).toContainText("Contributing rows");
  await expect(data.locator("tbody tr")).toHaveCount(27);
  await data.getByRole("searchbox").fill("South");
  await expect(data.locator("tbody tr")).toHaveCount(27);
});

test("table Origin and Impact work before a run and include computed variables", async ({
  page,
}) => {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  await page.goto(`/worktrees/${tree.id}/flow`);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Export revenue", { exact: true }) })
    .click();
  await page.getByRole("button", { name: "Lineage", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await expect(panel).toContainText("report_month");
  await expect(panel).toContainText("Reporting period");
  await expect(panel.locator(".lineage-sources")).toContainText("Orders");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Orders", { exact: true }) })
    .click();
  await page.getByRole("button", { name: "Lineage", exact: true }).click();
  await panel.getByRole("button", { name: "Impact", exact: true }).click();
  await expect(panel.locator(".lineage-sources")).toContainText(
    "Export revenue",
  );
});

test("a new cell updates the panel and browser Back restores the previous cell", async ({
  page,
}) => {
  await example(page);
  const panel = await explain(page);
  await explain(page, "net_share", 2);
  await expect(panel.locator(".root .lineage-equation")).toContainText("25.1");
  await page.goBack();
  await expect(panel.locator(".root .lineage-equation")).toContainText("25.6");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("#node-inspector .inspector")).toBeVisible();
});

test("closing or opening code ends the exploration and its contributing rows", async ({
  page,
}) => {
  await example(page);
  const panel = await explain(page, "net_revenue");
  await panel.getByRole("button", { name: "Open the 27 rows in Data" }).click();
  const data = page.getByRole("region", { name: "Results", exact: true });
  await expect(data).toContainText("Contributing rows");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(data).not.toContainText("Contributing rows");
  await expect(page.locator("#node-inspector .inspector")).toBeVisible();
  // Back reopens the exploration on the canvas level of its node.
  await page.goBack();
  await expect(panel.locator(".lineage-step.root")).toBeVisible();
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) })
    .locator(".node-shape")
    .dblclick();
  await expect(codePanel(page).locator(".monaco-editor")).toBeVisible();
  await expect(panel).toHaveCount(0);
});

test("recalculation interrupts and a saved old link never explains the new generation", async ({
  page,
}) => {
  const tree = await example(page);
  const panel = await explain(page);
  const old = page.url();
  await page.request.post(`/api/worktrees/${tree}/runs`, {
    data: { environment: "dev" },
  });
  await expect(panel.getByRole("alert")).toContainText(
    "This exploration was interrupted",
  );
  await expect(panel.locator(".lineage-step")).toHaveCount(0);
  await page.goto(old);
  await expect(
    page
      .getByRole("complementary", { name: "Lineage", exact: true })
      .getByRole("alert"),
  ).toBeVisible();
  await expect(page.locator(".lineage-step")).toHaveCount(0);
});

test("coverage errors stop branches and failed reads can be retried", async ({
  page,
}) => {
  await example(page);
  let fail = true;
  await page.route("**/lineage", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: "Temporarily unavailable" },
        })
      : route.fulfill({
          json: {
            ...route.request().postDataJSON(),
            node: "report::rank",
            value: 0,
            complete: false,
            warnings: ["This SQL construct is not supported."],
            contributions: [],
            total: 0,
            context_total: 0,
            page_size: 5,
          },
        }),
  );
  await page
    .getByRole("button", { name: /Explain this value: net_share, rows 1,/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await expect(panel.getByRole("alert")).toContainText(
    "Temporarily unavailable",
  );
  fail = false;
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel).toContainText("This SQL construct is not supported.");
  await expect(panel.locator(".lineage-step")).toHaveCount(1);
});

test("the resizable panel is accessible and keeps the grid usable on narrow screens", async ({
  page,
}) => {
  await example(page);
  const panel = await explain(page);
  const accessibility = await new AxeBuilder({ page })
    .include(".lineage-panel")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const resize = page.getByRole("separator", {
    name: "Resize Lineage",
    exact: true,
  });
  const before = await panel.boundingBox();
  await resize.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await panel.boundingBox())!.width).toBeGreaterThan(before!.width);
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(async () => {
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(600);
  }).toPass();
});

test("six real calculations of the same column remain six visible steps", async ({
  page,
}) => {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/projects", {
      data: { name: "Repeated calculations" },
    })
  ).json();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  const ids = [
    "source",
    ...Array.from({ length: 6 }, (_, i) => `step${i + 1}`),
  ];
  const files = {
    ...snapshot.files,
    "flow.json": JSON.stringify({
      name: "Repeated calculations",
      nodes: ids.map((id) => ({ id, params: {} })),
      edges: ids.slice(1).map((id, i) => ({
        id: `e${i}`,
        source: ids[i],
        sourceHandle: "result",
        target: id,
        targetHandle: "input",
      })),
    }),
  };
  for (const [index, id] of ids.entries())
    files[`nodes/${id}.sql`] = index
      ? `-- @label Step ${index}\n-- @input input\n-- @output result\nSELECT amount * 2 AS amount FROM {{ input }};`
      : "-- @label Source\n-- @output result\nSELECT 1 AS amount;";
  const saved = await page.request.put(`/api/worktrees/${tree.id}`, {
    data: { revision: snapshot.revision, files },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const run = await (
    await page.request.post(`/api/worktrees/${tree.id}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
    )
    .toBe("success");
  await page.goto(`/worktrees/${tree.id}/flow?node=step6`);
  const panel = await explain(page, "amount");
  await expect(panel.locator(".lineage-step.calculation")).toHaveCount(6);
  await expect(panel.locator(".lineage-step header button")).toHaveText([
    "Step 6",
    "Step 5",
    "Step 4",
    "Step 3",
    "Step 2",
    "Step 1",
    "Source",
  ]);
  await expect(panel.locator(".root .lineage-equation")).toContainText(
    "32 * 2",
  );
});

test("the panel translates its controls and copies execution evidence", async ({
  page,
  context,
}) => {
  await example(page);
  const panel = await explain(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "Copy", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Environment: dev");
  expect(copied).toContain("Run: run_");
  expect(copied).toMatch(/Commit: [0-9a-f]{40}/);
  expect(copied).toContain("25959.99");
  for (const [language, name, origin] of [
    ["fr", fr.lineage, fr.lineageOrigin],
    ["pt", pt.lineage, pt.lineageOrigin],
  ]) {
    await page.evaluate(
      (language) => localStorage.setItem("duckpad-language", language),
      language,
    );
    await page.reload();
    const translated = page.getByRole("complementary", { name, exact: true });
    await expect(
      translated.getByRole("button", { name: origin, exact: true }),
    ).toBeVisible();
    await expect(translated.locator(".lineage-step.root")).toBeVisible();
  }
});
