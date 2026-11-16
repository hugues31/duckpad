import { expect, type Page } from "@playwright/test";
import {
  autosaved,
  closeCode,
  dragPaletteNode,
  openCode,
  replaceCode,
} from "./helpers";

const orders = `-- @label Sample orders
-- @output orders
SELECT * FROM (VALUES
    (1, 'Europe', 'paid', 120.00),
    (2, 'Europe', 'paid', 30.00),
    (3, 'North America', 'paid', 80.00),
    (4, 'North America', 'pending', 50.00)
) AS sample(order_id, region, status, amount);`;

const report = `-- @label Revenue report
-- @input source
-- @param status: text = "paid"
-- @output paid_orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @output report
SELECT region, COUNT(*) AS orders, SUM(amount) AS revenue
FROM {{ paid_orders }}
GROUP BY region
ORDER BY region;
-- @test amount_nonnegative
SELECT * FROM {{ paid_orders }} WHERE amount < 0;
-- @message
SELECT 'info' AS level, COUNT(*) || ' paid orders checked' AS message
FROM {{ paid_orders }};`;

/** Build and recover a real pipeline using only UI writes, locally or on a preview. */
export async function verifyUsageTour(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New project", exact: true });
  await create.getByLabel("Name", { exact: true }).fill("Usage tour");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const inspector = page.locator(".inspector");
  const results = page.getByRole("region", { name: "Results", exact: true });
  const run = async (outcome = "success") => {
    const launched = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/worktrees/${worktree}/runs`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const response = await launched;
    expect(response.ok()).toBeTruthy();
    const started = await response.json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${started.id}`)).json())
            .status,
        { timeout: 30000 },
      )
      .toBe(outcome);
    await expect(
      page.getByRole("button", { name: "Run", exact: true }),
    ).toBeEnabled();
  };
  const addSql = async (name: string, code: string) => {
    await dragPaletteNode(page, "SQL");
    await autosaved(page, () =>
      inspector.getByLabel("Display name", { exact: true }).fill(name),
    );
    await openCode(page);
    await replaceCode(page, code);
    await closeCode(page);
  };

  await addSql("Sample orders", orders);
  await run();
  await expect(results.locator(".data-table tbody tr")).toHaveCount(4);
  await addSql("Revenue report", report);
  await autosaved(page, () =>
    inspector
      .getByLabel("source", { exact: true })
      .selectOption({ label: "Sample orders · orders" }),
  );
  await run();
  const output = results.getByLabel("Output", { exact: true });
  await output.selectOption("report");
  await expect(results.locator(".data-table tbody tr")).toHaveCount(2);
  await expect(results.locator(".data-table tbody tr").first()).toContainText(
    "150.00",
  );
  await expect(results.locator(".data-table tbody tr").last()).toContainText(
    "80.00",
  );

  // Sort and switch to an output with a different schema, then return.
  await results
    .locator("thead")
    .getByRole("button", { name: /^revenue/ })
    .click();
  await expect(results.locator(".data-table tbody tr").first()).toContainText(
    "North America",
  );
  await output.selectOption("paid_orders");
  await expect(results.locator(".data-table tbody tr")).toHaveCount(3);
  await expect(results.getByRole("alert")).toHaveCount(0);
  await output.selectOption("report");
  await results
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  const lineage = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await expect(lineage.locator(".lineage-step.root")).toBeVisible();
  await expect(lineage).toContainText("150");
  await expect(lineage).toContainText("120");
  await expect(lineage).toContainText("30");
  await page.keyboard.press("Escape");
  await expect(lineage).toHaveCount(0);
  await results.getByRole("tab", { name: /^Tests/ }).click();
  await expect(results.locator(".test-row")).toContainText(
    "amount_nonnegative",
  );
  await expect(results.locator(".test-status")).toHaveText("OK");
  await results.getByRole("tab", { name: /^Log/ }).click();
  await expect(results).toContainText("3 paid orders checked");

  // A SQL mistake must preserve the last result and remain recoverable in the editor.
  await openCode(page);
  await replaceCode(page, report.replace("SUM(amount)", "SUM(missing_amount)"));
  await closeCode(page);
  await run("partial_failure");
  await results.getByRole("tab", { name: "Data", exact: true }).click();
  await expect(
    results.getByRole("alert", { name: "Last run failed" }),
  ).toContainText("missing_amount");
  await expect(results.locator(".data-table tbody tr")).toHaveCount(2);
  await expect(results.locator(".cell").first()).toBeDisabled();
  await openCode(page);
  await replaceCode(page, report);
  await closeCode(page);
  await run();
  await expect(results.getByRole("alert")).toHaveCount(0);
  await expect(results.locator(".cell").first()).toBeEnabled();

  // Editing a parameter changes the result only on the next explicit run.
  await autosaved(page, () =>
    inspector
      .getByRole("textbox", { name: "status", exact: true })
      .fill("pending"),
  );
  await expect(results.locator(".results-header .badge")).toHaveText("Stale");
  await run();
  await expect(results.locator(".data-table tbody tr")).toHaveCount(1);
  await expect(results.locator(".data-table tbody tr")).toContainText("50.00");
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(
    inspector.getByRole("textbox", { name: "status", exact: true }),
  ).toHaveValue("pending");
  await output.selectOption("report");
  await expect(results.locator(".data-table tbody tr")).toHaveCount(1);
  await expect(results.locator(".data-table tbody tr")).toContainText("50.00");
  expect(errors).toEqual([]);
}
