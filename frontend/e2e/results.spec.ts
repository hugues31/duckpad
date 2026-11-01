import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Run, Snapshot } from "../src/types";

/** A run Northstar project, opened on the flow with Paid orders selected. */
async function openPaidOrders(page: Page) {
  await signIn(page);
  const example = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  await runProject(page, example.id);
  await page.goto(`/worktrees/${example.id}/flow?node=validated`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await expect(panel.locator(".results-header .badge")).toHaveText("Valid");
  return { worktree: example.id as string, panel };
}

async function runProject(page: Page, worktree: string) {
  const launched = await (
    await page.request.post(`/api/worktrees/${worktree}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  let run: Run;
  await expect
    .poll(
      async () => {
        run = await (await page.request.get(`/api/runs/${launched.id}`)).json();
        return run.status;
      },
      { timeout: 45000 },
    )
    .toMatch(/success|partial_failure|failed/);
  return run!;
}

test("a sample filters, sorts and limits displayed rows without changing the result", async ({
  page,
}) => {
  const { panel } = await openPaidOrders(page);
  await expect(panel.locator(".preview-footer")).toContainText("1–100 / 107");
  await panel.getByRole("button", { name: /^Sample: all rows/ }).click();
  const popover = page.getByRole("dialog", { name: "Sample", exact: true });
  await popover
    .getByRole("textbox", { name: "Filter", exact: true })
    .fill("channel = 'Partner' AND amount > 300");
  await expect(popover.getByRole("status")).toHaveText("16 matching rows");
  await popover.getByRole("button", { name: "Column", exact: true }).click();
  await popover
    .getByLabel("Sort column", { exact: true })
    .selectOption("amount");
  await popover
    .getByLabel("Sort direction", { exact: true })
    .selectOption("desc");
  await popover.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(popover).toHaveCount(0);
  await expect(panel.locator(".sample-chip")).toHaveText([
    "channel = 'Partner' AND amount > 300",
    "amount ↓",
  ]);
  await expect(panel.locator(".preview-footer")).toContainText(
    "16 of 107 rows match the sample",
  );
  const amounts = panel.locator(".data-table tbody tr td:nth-child(5)");
  await expect(amounts.first()).toHaveText("499");
  // Rows keep their identity, so a filtered value can still be explained.
  await panel
    .getByRole("button", { name: /Explain this value: amount, rows \d+, 499/ })
    .click();
  await expect(page.locator(".lineage-card.root")).toContainText("499");
  await page.keyboard.press("Escape");
  await expect(page.locator(".lineage-card.root")).toHaveCount(0);

  // The sample is remembered for this user and output after a reload.
  await page.reload();
  await expect(panel.locator(".sample-chip")).toHaveCount(2);
  await panel
    .getByRole("button", { name: "Remove filter", exact: true })
    .click();
  await expect(panel.locator(".preview-footer")).toContainText("/ 107");

  await panel
    .getByRole("textbox", { name: "Search all columns…", exact: true })
    .fill("Juniper");
  await expect(panel.locator(".preview-footer")).toContainText(
    "of 107 rows match",
  );
  await expect(panel.locator(".data-table tbody tr")).not.toHaveCount(0);
  for (const row of await panel.locator(".data-table tbody tr").all())
    await expect(row).toContainText("Juniper Studio");

  await panel.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(panel.locator(".preview-footer")).toContainText("1–100 / 107");
  await panel.getByRole("button", { name: /^Sample:/ }).click();
  await popover.getByRole("button", { name: "Random", exact: true }).click();
  await popover.getByLabel("Number of rows", { exact: true }).fill("5");
  await popover.getByLabel("Seed", { exact: true }).fill("42");
  await popover.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: /^Sample: 5 random rows/ }),
  ).toBeVisible();
  await expect(panel.locator(".preview-footer")).toContainText("1–5 / 5");
  const random = await panel.locator(".data-table tbody").textContent();
  await page.reload();
  await expect(panel.locator(".preview-footer")).toContainText("1–5 / 5");
  await expect(panel.locator(".data-table tbody")).toHaveText(random!);

  // An invalid filter is reported, with a reset, instead of being dropped.
  await panel.getByRole("button", { name: /^Sample:/ }).click();
  await popover
    .getByRole("textbox", { name: "Filter", exact: true })
    .fill("missing_column > 1");
  await expect(popover.getByRole("status")).toContainText("Unknown column");
  await popover.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Unknown column");
  await panel.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(panel.locator(".preview-footer")).toContainText("1–100 / 107");
});

test("views are shared in views.json and samples become Filter nodes or tests", async ({
  page,
}) => {
  const { worktree, panel } = await openPaidOrders(page);
  await panel.getByRole("button", { name: /^Sample: all rows/ }).click();
  const popover = page.getByRole("dialog", { name: "Sample", exact: true });
  await popover
    .getByRole("textbox", { name: "Filter", exact: true })
    .fill("amount > 450");
  await popover
    .getByRole("button", { name: "Save as view…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Save as a shared view" });
  await dialog.getByLabel("View name", { exact: true }).fill("Large orders");
  await dialog.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Large orders", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const snapshot: Snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  expect(JSON.parse(snapshot.files["views.json"])).toEqual({
    "validated:orders": [
      { name: "Large orders", method: "first", filter: "amount > 450" },
    ],
  });
  await panel.getByRole("button", { name: "All rows", exact: true }).click();
  await expect(panel.locator(".preview-footer")).toContainText("/ 107");
  await panel
    .getByRole("button", { name: "Large orders", exact: true })
    .click();
  await expect(panel.locator(".preview-footer")).toContainText(
    "10 of 107 rows match",
  );

  // The same check becomes a warning test of the node, then its failing rows.
  await panel.getByRole("button", { name: /^Sample:/ }).click();
  await popover
    .getByRole("button", {
      name: "Create a test from this filter",
      exact: true,
    })
    .click();
  const create = page.getByRole("dialog", {
    name: "Create a test from this filter",
  });
  await create.getByLabel("Test name", { exact: true }).fill("large_amount");
  await create
    .getByRole("button", { name: "Create test", exact: true })
    .click();
  await expect(create).toHaveCount(0);
  await expect
    .poll(async () => {
      const current: Snapshot = await (
        await page.request.get(`/api/worktrees/${worktree}`)
      ).json();
      return current.files["templates/validated_orders.sql"];
    })
    .toContain(
      "-- @test large_amount: warning\nSELECT * FROM {{ orders }} WHERE amount > 450;",
    );
  await runProject(page, worktree);
  await panel.getByRole("tab", { name: /^Tests/ }).click();
  const row = panel.locator(".test-row").filter({ hasText: "large_amount" });
  await expect(row).toContainText("Warning");
  await row
    .getByRole("button", { name: "Show the 10 failing rows", exact: true })
    .click();
  await expect(panel.getByRole("tab", { name: /^Data/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.locator(".sample-chip.failing")).toContainText(
    "Test large_amount · failing rows",
  );
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(10);

  // Add as a Filter node inserts a Filter reading this output.
  await panel.getByRole("button", { name: "Clear", exact: true }).click();
  await panel.getByRole("button", { name: /^Sample:/ }).click();
  await popover
    .getByRole("button", { name: "Add as a Filter node", exact: true })
    .click();
  await expect
    .poll(async () => {
      const current: Snapshot = await (
        await page.request.get(`/api/worktrees/${worktree}`)
      ).json();
      return current.bundle!.flow.nodes.find(
        (node) => node.params.condition === "amount > 450",
      )?.preset;
    })
    .toBe("filter");
});

test("columns show types and descriptions at once, statistics on request", async ({
  page,
}) => {
  const { worktree, panel } = await openPaidOrders(page);
  await panel.getByRole("tab", { name: /^Columns/ }).click();
  const table = panel.locator(".columns-table");
  await expect(table.locator("tbody tr")).toHaveCount(9);
  await expect(table.locator("thead")).not.toContainText("Nulls");
  await panel
    .getByRole("button", { name: "Edit: Column documentation: amount" })
    .click();
  await panel
    .getByRole("textbox", { name: "Column documentation: amount" })
    .fill("Gross order amount in EUR.");
  await panel
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "Column documentation: amount" }),
  ).toHaveCount(0);
  await expect(table.locator("tbody tr").nth(3)).toContainText(
    "Gross order amount in EUR.",
  );
  const snapshot: Snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  expect(snapshot.bundle!.documentation.columns!["validated:orders"]).toEqual({
    amount: "Gross order amount in EUR.",
  });
  await panel
    .getByRole("button", { name: "Compute statistics", exact: true })
    .click();
  await expect(panel.locator(".statistics-note")).toContainText(
    "Statistics of the 107 rows of this result",
  );
  await expect(table.locator("thead")).toContainText("Nulls");
  await expect(table.locator("tbody tr").nth(3)).toContainText("31 … 499");
  await expect(table.locator("tbody tr").nth(4)).toContainText("paid 107");
  // Statistics belong to the result: another visit shows them without computing again.
  await page.reload();
  await panel.getByRole("tab", { name: /^Columns/ }).click();
  await expect(panel.locator(".statistics-note")).toBeVisible();
  // Selecting a column name shows it in the data.
  await panel
    .getByRole("button", { name: "customer_name", exact: true })
    .click();
  await expect(panel.getByRole("tab", { name: /^Data/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("the log tells the run behind the result, and exports open on it", async ({
  page,
}) => {
  const { panel } = await openPaidOrders(page);
  await panel.getByRole("tab", { name: /^Log/ }).click();
  await expect(panel.locator(".run-summary")).toContainText("Succeeded");
  await expect(panel.locator(".run-summary")).toContainText(
    "current configuration",
  );
  const timeline = panel.locator(".log-timeline");
  await expect(timeline).toContainText("Started, inputs ready");
  await expect(timeline).toContainText("source ← Enrich orders");
  await expect(timeline).toContainText("Computed output orders");
  await expect(timeline).toContainText("Computed output overview");
  await expect(timeline).toContainText("Published");
  await panel.locator(".executed-sql summary").click();
  await expect(panel.locator(".executed-sql .monaco-editor")).toBeVisible();
  await page.locator('.react-flow__node[data-id="export"] .node-shape').click();
  await expect(panel.getByRole("tab")).toHaveText(["Tests", "Log"]);
  await expect(panel.getByRole("tab", { name: /^Log/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.locator(".log-export")).toContainText(
    "The destination was written completely.",
  );
  // An export keeps no result that could tell its configuration changed.
  await expect(panel.locator(".run-summary")).not.toContainText(
    "configuration",
  );
  await expect(
    panel.getByRole("button", { name: "Download exported data", exact: true }),
  ).toBeEnabled();
});
