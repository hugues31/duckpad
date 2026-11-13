import { execFileSync } from "node:child_process";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  autosaved,
  dragPaletteNode,
  closeCode,
  openCode,
  openInstanceSettings,
  openUserSettings,
  PASSWORD,
  replaceCode,
  signIn,
  stubDuckDBWebsites,
} from "../e2e/helpers";

// All scenes use the real application and disposable, synthetic fixtures.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("duckpad-theme", "light");
    localStorage.setItem("duckpad-language", "en");
  });
  await signIn(page);
});

test("concurrent file conflict", async ({ page }) => {
  const tree = await (
    await page.request.post("/api/projects", {
      data: { name: "Revenue report" },
    })
  ).json();
  const initial = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  const path = "nodes/revenue.sql";
  const code =
    "-- @label Revenue report\n-- @output result\nSELECT region, SUM(revenue) AS total\nFROM sales\nGROUP BY region;\n";
  initial.bundle.flow.nodes = [
    {
      id: "revenue",
      label: "Revenue report",
      params: {},
      position: { x: 80, y: 80 },
    },
  ];
  initial.bundle.node_sql = { [path]: code };
  const base = await (
    await page.request.put(`/api/worktrees/${tree.id}`, {
      data: { revision: initial.revision, bundle: initial.bundle },
    })
  ).json();
  const saved = {
    ...base.files,
    [path]: code.replace("SUM(revenue)", "ROUND(SUM(revenue), 2)"),
  };
  expect(
    (
      await page.request.put(`/api/worktrees/${tree.id}`, {
        data: { revision: base.revision, files: saved },
      })
    ).ok(),
  ).toBeTruthy();
  const proposed = {
    ...base.files,
    [path]: code.replace("FROM sales", "FROM sales\nWHERE status = 'paid'"),
  };
  expect(
    (
      await page.request.put(`/api/worktrees/${tree.id}`, {
        data: { revision: base.revision, files: proposed },
      })
    ).status(),
  ).toBe(409);
  await page.goto(`/worktrees/${tree.id}/code`);
  await page
    .getByRole("button", { name: "Save resolution", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Concurrent edit conflict" });
  await expect(dialog.locator(".line-insert").first()).toBeVisible();
  await expect(dialog.locator(".line-delete").first()).toBeVisible();
  await capture(page, "conflict-resolution", dialog);
});

async function capture(
  page: Page,
  name: string,
  region: Page | Locator = page,
  extraStyle = "",
) {
  await mkdir(resolve("../docs/images"), { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  return region.screenshot({
    path: resolve("../docs/images", `${name}.png`),
    animations: "disabled",
    caret: "hide",
    // Hide transient notifications and variable Git metadata, not product state.
    // Reduced motion gives every element a brief transition: without this
    // reset, hiding reaches one nested level per frame and the capture can
    // still show the text of the resource monitor.
    style:
      "*, *::before, *::after { transition: none !important; }" +
      ".toast, .resource-monitor, .git-revisions small { visibility: hidden !important; }" +
      extraStyle,
  });
}

/**
 * A capture for the README, which sits on GitHub's light or dark page: the
 * image keeps the rounded corners of the captured window, or lightly rounded
 * ones for a whole page, and what lies outside them becomes transparent.
 */
async function captureForReadme(
  page: Page,
  name: string,
  region: Page | Locator = page,
  extraStyle = "",
) {
  const image = await capture(page, name, region, extraStyle);
  const radius =
    "boundingBox" in region
      ? await region.evaluate((element) =>
          parseFloat(getComputedStyle(element).borderTopLeftRadius),
        )
      : 12;
  expect(radius).toBeGreaterThan(0);
  // Chromium draws the capture again under its rounded outline, pixel for
  // pixel, and leaves the page behind it out of the new image.
  const frame = await page.context().newPage();
  const density = await frame.evaluate(() => devicePixelRatio);
  // The width in the PNG header is in device pixels.
  const width = image.readUInt32BE(16) / density;
  await frame.setContent(
    `<img style="display: block; width: ${width}px; border-radius: ${radius}px"
      src="data:image/png;base64,${image.toString("base64")}">`,
  );
  await frame.locator("img").screenshot({
    path: resolve("../docs/images", `${name}.png`),
    omitBackground: true,
  });
  await frame.close();
}

function node(page: Page, label: string) {
  return page.locator(".react-flow__node").filter({
    has: page.getByText(label, { exact: true }),
  });
}

async function example(page: Page) {
  const response = await page.request.post("/api/example", {
    data: { name: "Northstar" },
  });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(12);
  return worktree;
}

async function run(page: Page, timeout = 30000) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const execution = await result.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${execution.id}`)).json())
          .status,
      { timeout },
    )
    .toBe("success");
  // The page learns the outcome from its own poll: no capture may show the
  // run still in progress.
  await expect(
    page.getByRole("button", { name: "Run all", exact: true }),
  ).toBeVisible();
}

/** Fit the graph in the canvas and wait until the viewport stops moving. */
async function fitted(page: Page) {
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  const viewport = page.locator(".react-flow__viewport");
  let previous = "";
  await expect
    .poll(async () => {
      const current = await viewport.evaluate(
        (element) => getComputedStyle(element).transform,
      );
      const stable = current === previous;
      previous = current;
      return stable;
    })
    .toBe(true);
}

test("capture project creation, results, lineage and SQL", async ({ page }) => {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Northstar");
  await dialog.getByRole("radio", { name: "Start from an example" }).check();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(12);
  await run(page);
  await node(page, "Regional revenue").click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  const revenue = page.getByRole("button", {
    name: /Explain this value: revenue, rows 1,/,
  });
  await expect(revenue).toBeVisible();
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "workspace");
  await revenue.click();
  const lineage = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await expect(lineage.locator(".lineage-step.root")).toBeVisible();
  await expect(lineage.locator(".lineage-loading")).toHaveCount(0);
  await expect(lineage).toContainText("+ 22 more");
  await captureForReadme(page, "readme-lineage");
  await lineage.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page.getByRole("treeitem", { name: "templates", exact: true }).click();
  await page
    .getByRole("treeitem", { name: "templates/sql.sql", exact: true })
    .click();
  await expect(page.locator(".code-file-heading")).toContainText(
    "templates/sql.sql",
  );
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "SELECT",
  );
  await capture(page, "code");
});

test("capture the quickstart using the SQL printed in the guide", async ({
  page,
}) => {
  const sql = [
    ...readFileSync(resolve("../docs/QUICKSTART.md"), "utf8").matchAll(
      /```sql\n([\s\S]*?)```/g,
    ),
  ].map((match) => match[1]);
  expect(sql).toHaveLength(3);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const creation = page.getByRole("dialog");
  await creation.getByLabel("Name", { exact: true }).fill("Revenue lab");
  await creation
    .getByRole("radio", { name: "Empty project", exact: true })
    .check();
  await creation.getByRole("button", { name: "Create", exact: true }).click();
  await expect(creation).toHaveCount(0);
  const inspector = page.locator(".inspector");
  const results = page.getByRole("region", { name: "Results", exact: true });
  const edit = async (code: string) => {
    await openCode(page);
    await replaceCode(page, code);
    await closeCode(page);
  };
  const add = async (label: string, code: string, count: number) => {
    await dragPaletteNode(page, "SQL");
    await expect(page.locator(".react-flow__node")).toHaveCount(count);
    await expect(inspector.getByLabel("Display name")).toHaveValue("");
    await autosaved(page, () =>
      inspector.getByLabel("Display name").fill(label),
    );
    await expect(inspector.locator(".inspector-title")).toContainText(label);
    await edit(code);
  };
  await add("Sample orders", sql[0], 1);
  await run(page);
  await expect(results.locator("tbody tr")).toHaveCount(4);
  await add("Revenue report", sql[1], 2);
  await inspector
    .getByRole("combobox", { name: "source", exact: true })
    .selectOption({ label: "Sample orders · orders" });
  await run(page);
  await results
    .getByRole("combobox", { name: "Output", exact: true })
    .selectOption("report");
  await expect(results.locator("tbody tr")).toHaveCount(2);
  const revenue = results.getByRole("button", {
    name: "Explain this value: revenue, rows 1, 150.00",
    exact: true,
  });
  await expect(revenue).toBeVisible();
  await expect(results.locator("tbody tr").last()).toContainText("80.00");
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  const connection = page.locator(".react-flow__edge-path");
  await expect(connection).toHaveCount(1);
  // Horizontal SVG paths have zero-height boxes but still paint their stroke.
  // Compact node placement can shorten the connection; it must remain drawable.
  expect(
    await connection.evaluate((path: SVGPathElement) => path.getTotalLength()),
  ).toBeGreaterThan(0);
  await expect(connection).not.toHaveCSS("stroke", "none");
  await capture(page, "quickstart-results");
  await revenue.click();
  const lineage = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await expect(lineage.locator(".lineage-step.root")).toBeVisible();
  await expect(lineage.locator(".lineage-loading")).toHaveCount(0);
  await expect(lineage.locator(".lineage-step.root .lineage-value")).toHaveText(
    ["120", "30"],
  );
  await expect(lineage.locator(".lineage-step.is-source")).toContainText(
    "Sample orders",
  );
  await expect(lineage).not.toContainText("node_");
  await capture(page, "quickstart-lineage");
  await lineage.getByRole("button", { name: "Close", exact: true }).click();
  await edit(sql[1] + "\n" + sql[2]);
  await run(page);
  await results.getByRole("tab", { name: /^Tests/ }).click();
  await expect(results).toContainText("amount_nonnegative");
  await expect(results).toContainText("OK");
  await results.getByRole("tab", { name: "Log", exact: true }).click();
  await expect(results).toContainText("3 paid orders checked");
  await autosaved(page, () =>
    inspector
      .getByRole("textbox", { name: "status", exact: true })
      .fill("pending"),
  );
  await expect(
    inspector.getByRole("button", { name: "Stale", exact: true }),
  ).toBeVisible();
  await run(page);
  await results.getByRole("tab", { name: "Data", exact: true }).click();
  await expect(results.locator("tbody tr")).toHaveCount(1);
  await expect(results.locator("tbody tr")).toContainText("North America");
  await expect(results.locator("tbody tr")).toContainText("50.00");
});

test("capture the results panel: samples, columns, tests, log and chart", async ({
  page,
}) => {
  const worktree = await example(page);
  // Paid orders reports a message and three tests, one of them failing as a warning.
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot = await (await page.request.get(url)).json();
  snapshot.bundle.documentation.datasets = {
    ...snapshot.bundle.documentation.datasets,
    "validated:orders": "Paid orders only; each row is one order.",
  };
  snapshot.bundle.documentation.columns = {
    ...snapshot.bundle.documentation.columns,
    "validated:orders": {
      order_id: "Unique order identifier.",
      amount: "Gross order amount in EUR before refunds.",
      region: "Customer region at the time of the run.",
    },
  };
  const saved = await page.request.put(url, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(saved.ok()).toBeTruthy();
  await page.reload();
  await run(page);
  await node(page, "Paid orders").click();
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await expect(panel.locator(".results-header .badge")).toHaveText("Valid");
  await panel.getByRole("button", { name: /^Sample:/ }).click();
  const popover = page.getByRole("dialog", { name: "Sample", exact: true });
  await popover.getByLabel("Number of rows", { exact: true }).fill("100");
  await popover
    .getByRole("textbox", { name: "Filter", exact: true })
    .fill("channel = 'Partner' AND amount > 300");
  await popover.getByRole("button", { name: "Column", exact: true }).click();
  await popover
    .getByLabel("Sort column", { exact: true })
    .selectOption("amount");
  await popover
    .getByLabel("Sort direction", { exact: true })
    .selectOption("desc");
  await expect(popover.getByRole("status")).toHaveText("16 matching rows");
  await capture(page, "results-sample");
  await popover.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(panel.locator(".preview-footer")).toContainText("1–16 / 16");
  await capture(page, "results-data");
  await panel.getByRole("tab", { name: /^Columns/ }).click();
  await panel
    .getByRole("button", { name: "Compute statistics", exact: true })
    .click();
  await expect(panel.locator(".statistics-note")).toBeVisible();
  await capture(page, "results-columns", panel);
  await panel.getByRole("tab", { name: /^Tests/ }).click();
  await panel
    .locator(".test-row")
    .filter({ hasText: "large_order_review" })
    .locator(".test-status")
    .click();
  await expect(panel.locator(".test-details")).toContainText(
    "SELECT * FROM {{ orders }} WHERE amount > {{ review_threshold }};",
  );
  await capture(page, "results-tests", panel);
  await panel
    .getByRole("button", { name: "Show the 10 failing rows", exact: true })
    .click();
  await expect(panel.locator(".preview-footer")).toContainText("1–10 / 10");
  await capture(page, "results-failing-rows", panel);
  await panel.getByRole("tab", { name: /^Log/ }).click();
  await expect(panel.locator(".log-timeline")).toContainText("Published");
  await capture(page, "results-log", panel);
  // The report output of Regional revenue has the Revenue by region chart,
  // shown whole in a taller results panel.
  await page.evaluate(() =>
    localStorage.setItem(
      "duckpad-panel-sizes",
      JSON.stringify({
        ...JSON.parse(localStorage.getItem("duckpad-panel-sizes") || "{}"),
        preview: 520,
      }),
    ),
  );
  await page.reload();
  await node(page, "Regional revenue").click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  await expect(panel.getByRole("figure")).toHaveAccessibleName(
    "Revenue by region",
  );
  await expect(panel.locator(".chart-view svg .mark-symbol path")).toHaveCount(
    4,
  );
  await capture(page, "results-chart", panel);
});

test("capture parameters, node documentation and nested components", async ({
  page,
}) => {
  await example(page);
  await run(page);
  await node(page, "Paid orders").click();
  await page.getByLabel("Output", { exact: true }).selectOption("orders");
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("textbox", { name: /status/ })).toHaveValue(
    "paid",
  );
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await inspector
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await expect(inspector.locator(".documentation-editor")).not.toHaveValue("");
  await capture(page, "node-documentation");
  await node(page, "Customer reach").click();
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  // Template conversions and duplication are secondary node actions.
  await expect(
    inspector.getByRole("button", { name: "Convert to template", exact: true }),
  ).toBeVisible();
  await capture(page, "node-code");
  await node(page, "Regional revenue").dblclick();
  await expect(
    page.getByText(
      "You are editing a shared component definition in this branch.",
    ),
  ).toBeVisible();
  await node(page, "Regional summary").dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await node(page, "Revenue by region").click();
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "component");
});

test("capture node icons and colors, and the icon library", async ({
  page,
}) => {
  const worktree = await example(page);
  // Style a few nodes as the inspector writes it in their code.
  const endpoint = `/api/worktrees/${worktree.id}`;
  const { revision, bundle } = await (await page.request.get(endpoint)).json();
  const styled = (code: string, icon: string, color: string) =>
    code.replace(
      /^(-- @label.*\n)/m,
      `$1-- @icon ${icon}\n-- @color ${color}\n`,
    );
  for (const [file, icon, color] of [
    ["nodes/enriched.sql", "left-join", "purple"],
    ["nodes/period.sql", "date", "orange"],
    ["nodes/reach.sql", "users", "teal"],
  ])
    bundle.node_sql[file] = styled(bundle.node_sql[file], icon, color);
  for (const [template, icon, color] of [
    ["validated_orders", "shield", "green"],
    ["export_report", "euro", "pink"],
  ])
    bundle.templates[template] = styled(
      bundle.templates[template],
      icon,
      color,
    );
  expect(
    (await page.request.put(endpoint, { data: { revision, bundle } })).ok(),
  ).toBeTruthy();
  await expect(
    node(page, "Export revenue").locator(".pipeline-node"),
  ).toHaveClass(/node-color-pink/);
  await run(page);
  await node(page, "Enrich orders").click();
  const inspector = page.locator(".inspector");
  await inspector.getByRole("button", { name: /^Icon and color/ }).click();
  await expect(
    inspector.getByRole("option", { name: "left-join", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "node-icons");

  // Every icon with its name, drawn by the library itself.
  const groups = await inspector
    .locator(".appearance-icons [role=group]")
    .evaluateAll((sections) =>
      sections.map((section) => ({
        title: section.querySelector("h5")!.textContent,
        icons: [...section.querySelectorAll("button")].map((button) => ({
          name: button.title,
          svg: button.innerHTML,
        })),
      })),
    );
  expect(groups.flatMap((group) => group.icons).length).toBeGreaterThan(100);
  const sheet = await page.context().newPage();
  await sheet.setContent(
    `<style>
      body { margin: 0; width: 880px; padding: 4px 20px 20px; background: #fafafa; color: #16161b;
        font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      h2 { margin: 20px 0 10px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
      div { display: grid; grid-template-columns: repeat(8, 1fr); gap: 14px 0; }
      figure { margin: 0; display: grid; justify-items: center; gap: 6px; }
      svg { width: 26px; height: 26px; }
    </style>` +
      groups
        .map(
          (group) =>
            `<h2>${group.title}</h2><div>${group.icons
              .map(
                (icon) =>
                  `<figure>${icon.svg}<figcaption>${icon.name}</figcaption></figure>`,
              )
              .join("")}</div>`,
        )
        .join(""),
  );
  await sheet.locator("body").screenshot({
    path: resolve("../docs/images", "node-icon-library.png"),
  });
  await sheet.close();
});

test("capture the docked code editor and its preview", async ({ page }) => {
  await example(page);
  await run(page);
  await node(page, "Customer reach").click();
  const panel = await openCode(page);
  await expect(panel.getByText("Last result", { exact: true })).toBeVisible();
  // The run can finish before the interface receives its completed status.
  await expect(
    panel.getByRole("button", { name: "Preview", exact: true }),
  ).toBeEnabled();
  await panel.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  const preview = page.locator(".draft-preview");
  await expect(preview.locator(".data-table tbody tr")).not.toHaveCount(0);
  await expect(preview).toContainText("Computed from the first 1,000 rows");
  await capture(
    page,
    "code-preview",
    page,
    ".draft-preview-time { visibility: hidden !important; }",
  );
  await captureForReadme(
    page,
    "readme-code-preview",
    page,
    ".draft-preview-time { visibility: hidden !important; }",
  );
  // Column suggestions after an alias of an input.
  const rest = " FROM {{ source }} s WHERE s.channel = 'Web';";
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n-- @output recent_web\nSELECT " + rest);
  for (let step = 0; step < rest.length; step++)
    await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("s.");
  const suggestions = page.locator(".suggest-widget.visible .monaco-list-row");
  await expect(suggestions.first()).toBeVisible();
  await expect(panel.locator(".monaco-editor")).toContainText("recent_web");
  await capture(
    page,
    "code-completion",
    page,
    ".draft-preview-time { visibility: hidden !important; }",
  );
});

test("capture project variables, a parameter binding and a run confirmation", async ({
  page,
}) => {
  const worktree = await example(page);
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot = await (await page.request.get(url)).json();
  // Northstar already declares high_value_threshold, review_threshold and report_month.
  snapshot.bundle.variables = {
    ...snapshot.bundle.variables,
    order_status: {
      type: "choice(paid|refunded|pending)",
      description: "Order status counted as revenue.",
      default: "paid",
    },
    report_start: {
      type: "date",
      description: "First order date included in the reports.",
      default: "2026-10-01",
      environments: { prod: "2026-01-01" },
    },
    oracle_schema: {
      type: "identifier",
      description: "Schema of the Oracle sales tables.",
      default: "DEMO",
      environments: { prod: "SALES" },
    },
  };
  const saved = await page.request.put(url, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(saved.ok()).toBeTruthy();
  // A prod run retains report_month, so the table shows it in both environments.
  const prod = await (
    await page.request.post(`${url}/runs`, { data: { environment: "prod" } })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${prod.id}`)).json()).status,
      { timeout: 30000 },
    )
    .toBe("success");
  await run(page);
  await node(page, "Paid orders").click();
  await page.getByLabel("Output", { exact: true }).selectOption("orders");
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  const inspector = page.locator(".inspector");
  await inspector
    .getByRole("button", { name: "Bind status to a variable", exact: true })
    .click();
  const picker = inspector.getByRole("group", {
    name: "Bind status to a variable",
  });
  await expect(picker).toContainText("paid in every environment");
  await expect(picker).toContainText("identifier · incompatible");
  await capture(page, "variable-binding");
  await picker.getByRole("button", { name: /^order_status/ }).click();
  await expect(
    inspector.getByRole("group", { name: "status is bound to order_status" }),
  ).toContainText("= paid in dev");
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Variables", exact: true }).click();
  await page
    .locator(".variables-table")
    .getByRole("button", { name: "order_status" })
    .click();
  const editor = page.getByRole("complementary", { name: "order_status" });
  await editor
    .getByRole("switch", { name: "Use the default value in dev" })
    .click();
  await editor.getByLabel("dev value", { exact: true }).selectOption("pending");
  await expect(editor.getByRole("status")).toContainText(
    "Saving marks Paid orders and 6 descendants as stale in dev.",
  );
  await capture(page, "variables");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("Environment", { exact: true }).selectOption("prod");
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm execution" });
  await expect(
    confirmation.getByRole("row").filter({ hasText: "order_status" }),
  ).toContainText("paid");
  await capture(page, "run-variables", confirmation);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  // An expression references a variable and shows its value per environment.
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await node(page, "High-value orders").click();
  const condition = inspector.getByRole("textbox", { name: /condition/ });
  await condition.fill("amount >= ");
  await condition.pressSequentially("{{ var.high");
  await expect(
    inspector.getByRole("listbox", { name: "Variables" }),
  ).toContainText("high_value_threshold");
  await condition.press("Enter");
  await expect(
    inspector.getByRole("list", { name: "Variables used by this expression" }),
  ).toContainText("prod 900");
  await condition.blur();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await capture(page, "variable-expression");
});

test("capture a file node reading project files", async ({
  page,
}, testInfo) => {
  const created = await page.request.post("/api/projects", {
    data: { name: "Budget" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  const workbook = testInfo.outputPath("budget.xlsx");
  execFileSync("../.venv/bin/python", ["../tests/xlsx_fixture.py", workbook]);
  const endpoint = `/api/worktrees/${worktree.id}`;
  const snapshot = await (await page.request.get(endpoint)).json();
  snapshot.bundle.extensions = { excel: { source: "core", enabled: true } };
  await page.request.put(endpoint, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await dragPaletteNode(page, "Load XLSX");
  const inspector = page.locator(".inspector");
  await expect(
    inspector.getByRole("combobox", { name: "Location", exact: true }),
  ).toHaveValue("");
  await inspector
    .getByLabel("Upload file", { exact: true })
    .setInputFiles(workbook);
  await expect(inspector.getByRole("combobox", { name: /^file/ })).toHaveValue(
    /budget\.xlsx$/,
  );
  await autosaved(page, () =>
    inspector.getByRole("textbox", { name: /sheet/ }).fill("Orders"),
  );
  await expect(inspector.locator(".source-sample")).toContainText("North");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/worktrees/${worktree.id}`)).json())
          .bundle.flow.nodes[0]?.params.sheet,
    )
    .toBe("Orders");
  await capture(page, "project-files", inspector);
});

test("capture connection setup and environment policies", async ({ page }) => {
  await openInstanceSettings(page, "Connections");
  await page
    .getByRole("button", { name: "New connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("ID", { exact: true }).fill("finance_share");
  await dialog.getByLabel("Name", { exact: true }).fill("Finance share");
  await dialog
    .getByRole("combobox", { name: "Connector", exact: true })
    .selectOption("folder");
  const root = dialog.getByLabel("root", { exact: true });
  await root.fill("/srv/finance-dev");
  await root.blur();
  await capture(page, "connection", dialog);
  await page.keyboard.press("Escape");

  // Journey 2 of the connections design: a Server folder per environment, granted to a project.
  const catalog = await (await page.request.get("/api/catalog")).json();
  const { origin: _, ...s3 } = catalog.connectors.find(
    (c: { id: string }) => c.id === "s3",
  );
  const connections = [
    {
      id: "finance_share",
      name: "Finance share",
      connector: "folder",
      environments: {
        dev: { root: "/srv/finance-dev" },
        prod: { root: "/srv/finance" },
      },
    },
    {
      id: "landing_bucket",
      name: "Landing bucket",
      connector: "s3",
      environments: {
        dev: { root: "s3://landing-dev/raw/", key_id: "dev", secret: "dev" },
        prod: { root: "s3://landing/raw/", key_id: "prod", secret: "prod" },
      },
    },
    {
      id: "sales_database",
      name: "Sales database",
      connector: "postgres",
      environments: Object.fromEntries(
        ["dev", "prod"].map((environment) => [
          environment,
          {
            host: `${environment}.db.example.com`,
            database: "sales",
            user: "duckpad",
            password: environment,
          },
        ]),
      ),
    },
  ];
  // An administrator exposed a session token on S3: the built-in becomes Customized.
  const customized = {
    ...s3,
    parameters: [...s3.parameters, { name: "session_token", type: "text" }],
  };
  expect(
    (
      await page.request.put("/api/catalog/connector", { data: customized })
    ).ok(),
  ).toBeTruthy();
  for (const data of connections)
    expect(
      (
        await page.request.put("/api/catalog/connection?create=true", { data })
      ).ok(),
    ).toBeTruthy();
  const created = await page.request.post("/api/projects", {
    data: { name: "Finance" },
  });
  const worktree = await created.json();
  try {
    await page.reload();
    await expect(
      page.locator(".connector-row").filter({ hasText: "Amazon S3" }),
    ).toContainText("Customized");
    // Every connector definition, down to the customized built-in.
    await page.setViewportSize({ width: 1440, height: 1240 });
    await capture(page, "connections", page.locator(".settings-layout"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.request.put(`/api/projects/${worktree.project}/connections`, {
      data: { connections: ["finance_share"] },
    });
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await dragPaletteNode(page, "Load XLSX");
    const inspector = page.locator(".inspector");
    await inspector
      .getByRole("combobox", { name: "Location", exact: true })
      .selectOption("finance_share");
    await autosaved(page, () =>
      inspector
        .getByRole("textbox", { name: /file/ })
        .fill("inbox/budget.xlsx"),
    );
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/worktrees/${worktree.id}`)
            ).json()
          ).bundle.flow.nodes[0]?.params.file,
      )
      .toBe("inbox/budget.xlsx");
    await capture(page, "server-folder-location", inspector);
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
    for (const { id } of connections)
      await page.request.delete(`/api/catalog/connection/${id}`);
    await page.request.post("/api/catalog/connector/s3/reset");
  }
  await openInstanceSettings(page, "Environments");
  await expect(page.locator(".environment-card")).toHaveCount(2);
  await expect(
    page.getByRole("article", { name: "prod", exact: true }),
  ).toContainText("Confirm every run");
  await capture(page, "environments", page.locator(".settings-layout"));
});

// A disposable PostgreSQL server with a sales_dev and a sales_prod database holding
// public.orders, as scripts/integration.py prepares; the scene is skipped without one.
const postgres = {
  host: process.env.DUCKPAD_DOCS_POSTGRES_HOST,
  port: Number(process.env.DUCKPAD_DOCS_POSTGRES_PORT || 5432),
  user: process.env.DUCKPAD_DOCS_POSTGRES_USER,
  password: process.env.DUCKPAD_DOCS_POSTGRES_PASSWORD,
};

test("capture a PostgreSQL connection test and Load table", async ({
  page,
}) => {
  test.skip(!postgres.host, "Set DUCKPAD_DOCS_POSTGRES_* to a test server.");
  // Include the connection result and the fixed form actions in the guide image.
  await page.setViewportSize({ width: 1440, height: 1200 });
  const values = (database: string, options: string) => ({
    ...postgres,
    database,
    options,
  });
  const connection = {
    id: "sales",
    name: "Sales database",
    connector: "postgres",
    environments: {
      dev: values("sales_dev", "application_name=duckpad"),
      prod: values("sales_prod", "sslmode=require application_name=duckpad"),
    },
  };
  const created = await page.request.post("/api/projects", {
    data: { name: "Sales" },
  });
  const worktree = await created.json();
  try {
    expect(
      (
        await page.request.put("/api/catalog/connection?create=true", {
          data: connection,
        })
      ).ok(),
    ).toBeTruthy();
    await openInstanceSettings(page, "Connections");
    await page
      .locator(".connection-card")
      .filter({ hasText: "Sales database" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "prod", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText("Connected in prod");
    await capture(page, "connection-test", dialog);
    await page.keyboard.press("Escape");

    await page.request.put(`/api/projects/${worktree.project}/connections`, {
      data: { connections: ["sales"] },
    });
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await dragPaletteNode(page, "Load table");
    const inspector = page.locator(".inspector");
    await inspector
      .getByRole("combobox", { name: "connection", exact: true })
      .selectOption("sales");
    const table = inspector.getByRole("combobox", {
      name: "table",
      exact: true,
    });
    const schema = inspector.getByRole("combobox", {
      name: "schema",
      exact: true,
    });
    // The default name is already an option before the asynchronous listing arrives.
    await expect(schema.locator("option")).toHaveText(["Choose…", "public"]);
    await schema.selectOption("public");
    await expect(
      table.getByRole("option", { name: "orders", exact: true }),
    ).toHaveCount(1);
    await autosaved(page, () => table.selectOption("orders"));
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/worktrees/${worktree.id}`)
            ).json()
          ).bundle.flow.nodes[0]?.params.table,
      )
      .toBe("orders");
    await capture(page, "load-table", inspector);
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
    await page.request.delete("/api/catalog/connection/sales");
  }
});

test("capture branch creation and a real parameter comparison", async ({
  page,
}) => {
  await example(page);
  await page.getByTitle("New working branch", { exact: true }).click();
  const branch = page.getByRole("dialog", {
    name: "New working branch",
    exact: true,
  });
  await branch
    .getByLabel("Branch name", { exact: true })
    .fill("experiment/refunded-orders");
  await expect(
    branch.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await capture(page, "new-branch", branch);
  await branch.getByRole("button", { name: "Create", exact: true }).click();
  await expect(branch).toBeHidden();
  await node(page, "Paid orders").click();
  const status = page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ });
  await status.fill("refunded");
  await status.blur();
  const worktree = new URL(page.url()).pathname.split("/")[2];
  await expect
    .poll(async () => {
      const snapshot = await (
        await page.request.get(`/api/worktrees/${worktree}`)
      ).json();
      return snapshot.bundle.flow.nodes.find(
        (n: { label: string }) => n.label === "Paid orders",
      ).params.status;
    })
    .toBe("refunded");
  // Keep both revision selectors and the before/after values in the image.
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  const git = page.getByRole("dialog", { name: "Project Git workspace" });
  await git
    .getByRole("button", { name: "Compare versions", exact: true })
    .first()
    .click();
  await git.getByLabel("A: reference").fill("main");
  await git.getByLabel("B: target").fill("experiment/refunded-orders");
  await expect(git.locator(".change-list")).toContainText("Paid orders");
  await git.locator(".change-row").filter({ hasText: "Paid orders" }).click();
  await expect(git.locator(".comparison-values")).toContainText("refunded");
  await expect(git.locator(".comparison-values")).toContainText("paid");
  await expect(
    git.locator(".comparison-values tr").filter({ hasText: "refunded" }),
  ).toBeInViewport({ ratio: 1 });
  await capture(page, "git-comparison", git);
  await captureForReadme(page, "readme-git-comparison", git);
});

test("capture account roles, project access and personal preferences", async ({
  page,
}) => {
  await openInstanceSettings(page, "Users and permissions");
  for (const username of ["analyst", "reviewer"]) {
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add user", exact: true });
    await dialog.getByLabel("Username", { exact: true }).fill(username);
    await dialog.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByLabel(`Instance role · ${username}`, { exact: true }),
    ).toHaveValue("member");
  }
  await capture(page, "users", page.locator(".settings-layout"));
  const users = await (await page.request.get("/api/users")).json();
  const created = await page.request.post("/api/projects", {
    data: { name: "Team workspace" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page
    .getByRole("link", { name: "Project settings", exact: true })
    .click();
  for (const [username, role] of [
    ["analyst", "editor"],
    ["reviewer", "reader"],
  ]) {
    const user = users.find(
      (user: { username: string }) => user.username === username,
    );
    await page.getByLabel("User", { exact: true }).selectOption(user.id);
    await page.getByLabel("Project role", { exact: true }).selectOption(role);
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    await expect(
      page.getByLabel(`Project role · ${username}`, { exact: true }),
    ).toHaveValue(role);
  }
  const participants = page.locator(".settings-card").filter({
    has: page.getByRole("heading", { name: "Users", exact: true }),
  });
  await capture(page, "project-access", participants);
  await openUserSettings(page);
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("light");
  await expect(page.getByLabel("Node links", { exact: true })).toHaveValue(
    "curved",
  );
  await capture(
    page,
    "preferences",
    page.locator(".settings-card").filter({
      has: page.getByRole("heading", { name: "Preferences", exact: true }),
    }),
  );
});

test("capture offline extension download and import settings", async ({
  page,
}) => {
  await stubDuckDBWebsites(page);
  const runtime = await (
    await page.request.get("/api/extensions/runtime")
  ).json();
  await openInstanceSettings(page, "Extensions");
  await page
    .getByLabel("Extension source", { exact: true })
    .selectOption("core");
  await page.getByLabel("Extension name", { exact: true }).fill("httpfs");
  await expect(
    page.getByRole("link", { name: "Download server binary", exact: true }),
  ).toHaveAttribute(
    "href",
    `https://extensions.duckdb.org/${runtime.version}/${runtime.platform}/httpfs.duckdb_extension.gz`,
  );
  await expect(
    page.getByText("Download available for the server"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Allow unsigned extensions", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Import extension", exact: true }),
  ).toBeDisabled();
  await capture(page, "extensions", page.locator(".settings-layout"));
});

test("capture project extension activation and missing imports", async ({
  page,
}) => {
  await stubDuckDBWebsites(page);
  const response = await page.request.post("/api/projects", {
    data: { name: "Project capabilities" },
  });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot = await (await page.request.get(url)).json();
  snapshot.bundle.extensions = {
    json: { source: "core", enabled: true },
    duckfn_statrs: { source: "community", enabled: false },
  };
  expect(
    (
      await page.request.put(url, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(
    `/projects/${worktree.project}/settings/extensions?worktree=${worktree.id}&environment=dev`,
  );
  await expect(
    page
      .getByRole("article", { name: "json", exact: true })
      .getByRole("status"),
  ).toHaveText("Active for this project");
  await expect(
    page
      .getByRole("article", { name: "duckfn_statrs", exact: true })
      .getByRole("status"),
  ).toHaveText("Import required");
  await expect(page.getByText(/choose an extension to fill in/)).toBeVisible();
  await capture(
    page,
    "project-extensions",
    page.locator(".project-extensions-page"),
  );
});

test("capture the first-launch setup page and password recovery help", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1100, height: 1000 },
    locale: "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    // The form renders from any token; only saving checks it.
    await page.goto("/#setup=documentation-capture");
    await expect(
      page.getByRole("heading", { name: "Choose your password", exact: true }),
    ).toBeVisible();
    await capture(page, "first-launch-setup", page.locator(".login-card"));
    await page
      .getByRole("button", {
        name: "Sign in with the generated password instead",
        exact: true,
      })
      .click();
    await page
      .getByLabel("Password", { exact: true })
      .fill("not-the-admin-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator(".login-help")).toHaveAttribute("open");
    await capture(page, "sign-in-recovery", page.locator(".login-card"));
  } finally {
    await context.close();
  }
});

test("capture SSO configuration and the enabled sign-in choice", async ({
  page,
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1100, height: 1000 },
    locale: "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    await openInstanceSettings(page, "Single sign-on (OIDC)");
    const settings = page.getByRole("region", {
      name: "Single sign-on (OIDC)",
      exact: true,
    });
    await settings.getByLabel("Enable single sign-on", { exact: true }).check();
    await settings
      .getByLabel("Sign-in button label", { exact: true })
      .fill("Northstar");
    // Document public example values in the real form before saving the local test provider.
    await settings
      .getByLabel("Issuer URL", { exact: true })
      .fill("https://identity.example.com/realms/team");
    await settings.getByLabel("Client ID", { exact: true }).fill("duckpad");
    const secret = settings.getByLabel("Client secret", { exact: true });
    await secret.fill("documentation-example");
    await expect(secret).toHaveAttribute("type", "password");
    await settings
      .getByLabel("Application URL", { exact: true })
      .fill("https://duckpad.example.com");
    await expect(
      settings.getByLabel("Redirect URI", { exact: true }),
    ).toHaveValue("https://duckpad.example.com/api/oidc/callback");
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeEnabled();
    await capture(page, "sso-settings", page.locator(".settings-layout"));

    // The fixture validates discovery and completes a signed OIDC flow without external services.
    await settings
      .getByLabel("Issuer URL", { exact: true })
      .fill(baseURL + "/test-oidc");
    await settings.getByLabel("Client ID", { exact: true }).fill("test-client");
    await secret.fill("test-secret");
    await settings
      .getByLabel("Application URL", { exact: true })
      .fill(baseURL!);
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(settings.getByRole("status")).toContainText(
      "SSO settings saved",
    );
    await expect(secret).toHaveValue("");
    const login = await context.newPage();
    await login.goto("/");
    const sso = login.getByRole("link", {
      name: "Continue with Northstar",
      exact: true,
    });
    await expect(sso).toBeVisible();
    await expect(
      login.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(login.getByLabel("Password", { exact: true })).toHaveValue("");
    await capture(login, "sso-sign-in", login.locator(".login-card"));
    await sso.click();
    await login
      .getByRole("link", { name: "Approve test sign-in", exact: true })
      .click();
    await expect(
      login.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    const session = await (await login.request.get("/api/session")).json();
    expect(session.auth_method).toBe("oidc");
    expect(session.role).toBe("member");
  } finally {
    await context.close();
    expect(
      (await page.request.put("/api/sso", { data: { enabled: false } })).ok(),
    ).toBeTruthy();
  }
});

// The README shows the application at GitHub's content width: a smaller
// viewport at double density keeps its text legible there.
test.describe("README", () => {
  test.use({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2 });

  test("capture the README workspace in both themes", async ({ page }) => {
    await example(page);
    await run(page);
    await page.evaluate(() =>
      localStorage.setItem(
        "duckpad-panel-sizes",
        JSON.stringify({ preview: 320 }),
      ),
    );
    for (const theme of ["light", "dark"] as const) {
      // Added after the suite's light theme, so this one applies on reload.
      await page.addInitScript(
        (value) => localStorage.setItem("duckpad-theme", value),
        theme,
      );
      await page.emulateMedia({ colorScheme: theme });
      await page.reload();
      await node(page, "Paid orders").click();
      await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
      // The canvas takes the inspector's room and fits the whole example.
      await page
        .getByRole("button", { name: "Toggle inspector", exact: true })
        .click();
      await expect(page.locator(".inspector")).toBeHidden();
      await fitted(page);
      await captureForReadme(
        page,
        theme === "light" ? "readme-workspace" : "readme-workspace-dark",
      );
    }
  });

  test("capture custom nodes using the code printed in the README", async ({
    page,
  }) => {
    // The first Python run also prepares the project's environment.
    test.setTimeout(240000);
    await page.setViewportSize({ width: 1280, height: 860 });
    const readme = readFileSync(resolve("../README.md"), "utf8");
    const printed = (language: string) => {
      const blocks = [
        ...readme.matchAll(
          new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"),
        ),
      ];
      expect(blocks).toHaveLength(1);
      return blocks[0][1];
    };
    const tree = await (
      await page.request.post("/api/projects", {
        data: { name: "Custom nodes" },
      })
    ).json();
    expect(
      (
        await page.request.put(`/api/projects/${tree.project}/python`, {
          data: { enabled: true, allow_builds: false },
        })
      ).ok(),
    ).toBeTruthy();
    const url = `/api/worktrees/${tree.id}`;
    const snapshot = await (await page.request.get(url)).json();
    const flow = JSON.parse(snapshot.files["flow.json"]);
    flow.nodes = [
      { id: "orders", params: {}, position: { x: 40, y: 120 } },
      {
        id: "split",
        template: "split_orders.py",
        language: "python",
        params: {},
        position: { x: 330, y: 120 },
      },
      {
        id: "revenue",
        template: "revenue_breakdown",
        params: {},
        position: { x: 620, y: 60 },
      },
    ];
    flow.edges = [
      {
        id: "orders_split",
        source: "orders",
        sourceHandle: "result",
        target: "split",
        targetHandle: "orders",
      },
      {
        id: "split_revenue",
        source: "split",
        sourceHandle: "accepted",
        target: "revenue",
        targetHandle: "orders",
      },
    ];
    const saved = await page.request.put(url, {
      data: {
        revision: snapshot.revision,
        files: {
          ...snapshot.files,
          "flow.json": JSON.stringify(flow),
          "nodes/orders.sql": `-- @label Orders
-- @output result
SELECT i AS order_id,
  ['Juniper Studio', 'Atlas Bikes', 'Cedar & Co', 'Harbor Foods'][1 + i % 4] AS customer_name,
  ['North', 'South', 'East', 'West'][1 + (i // 4) % 4] AS region,
  60 + (i * 37) % 440 AS amount
FROM range(1, 121) t(i);
`,
          "templates/revenue_breakdown.sql": printed("sql"),
          "templates/split_orders.py": printed("python"),
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    await page.evaluate(() =>
      localStorage.setItem(
        "duckpad-panel-sizes",
        JSON.stringify({ preview: 300 }),
      ),
    );
    await page.goto(`/worktrees/${tree.id}/flow`);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await run(page, 180000);
    // Reloading leaves the environment preparation notice behind.
    await page.reload();
    await node(page, "Split orders").click();
    await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
    // The form comes from the class attributes; the palette lists both nodes.
    const inspector = page.locator(".inspector");
    await expect(
      inspector.getByRole("textbox", { name: /minimum/ }),
    ).toHaveValue("300");
    const palette = page.locator(".palette-list");
    await palette.evaluate((list) => list.scrollTo(0, list.scrollHeight));
    for (const name of ["Revenue breakdown", "Split orders"])
      await expect(
        palette.getByRole("button", { name, exact: true }),
      ).toBeInViewport();
    await captureForReadme(page, "readme-custom-nodes");
  });
});

test("assistant settings and contextual chat", async ({ page }) => {
  // Tall enough for the whole settings card, sticky save bar included.
  await page.setViewportSize({ width: 1440, height: 1900 });
  const response = await page.request.put("/api/assistant/settings", {
    data: {
      enabled: true,
      allow_data: true,
      max_rows: 50,
      providers: [
        {
          id: "primary",
          kind: "deepseek",
          api_key: "documentation-test-key",
          models: ["deepseek-chat"],
        },
      ],
      default_provider: "primary",
      default_model: "deepseek-chat",
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/instance-settings/assistant");
  await expect(
    page
      .getByRole("group", { name: "DeepSeek", exact: true })
      .getByRole("listitem"),
  ).toHaveText(["deepseek-chat"]);
  await capture(
    page,
    "assistant-settings",
    page.locator(".settings-card"),
    ".assistant-launcher { visibility: hidden !important; }",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await example(page);
  await node(page, "Paid orders").click();
  await page
    .getByRole("button", { name: "Open AI assistant", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "AI assistant" }),
  ).toBeVisible();
  await capture(page, "assistant-chat");
});

test("value lineage panel", async ({ page }) => {
  await example(page);
  await run(page);
  await node(page, "Regional revenue").click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  await page
    .getByRole("button", { name: /Explain this value: net_share, rows 1,/ })
    .click();
  await expect(page.locator(".lineage-step")).toHaveCount(8);
  await expect(page.locator(".lineage-loading")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Hide node library", exact: true })
    .click();
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await capture(page, "lineage");
});
