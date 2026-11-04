import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import type { Run } from "../src/types";

test("Northstar runs its data tests, messages, computed variable and shared view", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signIn(page);
  const created = await page.request.post("/api/example", { data: {} });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  const url = `/api/worktrees/${worktree.id}`;
  await page.goto(`/worktrees/${worktree.id}/flow`);
  const node = (id: string) =>
    page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  // Reporting period supplies report_month, which names the exported files.
  await expect(node("period").getByTitle("Value source")).toBeVisible();

  const response = page.waitForResponse(
    (r) => r.url().endsWith(`${url}/runs`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const started = await (await response).json();
  let run: Run;
  await expect
    .poll(
      async () => {
        run = await (await page.request.get(`/api/runs/${started.id}`)).json();
        return run.status;
      },
      { timeout: 90000 },
    )
    .toMatch(/^(success|partial_failure|failed)$/);
  expect(run!.status).toBe("success");
  // The review test warns without failing the run.
  expect(run!.warning_count).toBe(1);
  expect(run!.variables).toMatchObject({
    high_value_threshold: { value: 300, source: "default" },
    review_threshold: { value: 450, source: "default" },
    report_month: { value: "2026-10", resolution: "calculated" },
  });
  await expect(
    node("validated").getByLabel("Warnings: 1", { exact: true }),
  ).toBeVisible();

  await node("validated").locator(".node-shape").click();
  const results = page.getByRole("region", { name: "Results", exact: true });
  await results.getByRole("tab", { name: /^Tests/ }).click();
  const tests = results.locator(".test-row");
  await expect(tests).toHaveCount(3);
  for (const name of ["order_id_unique", "amount_positive"])
    await expect(
      tests.filter({ hasText: name }).locator(".test-status"),
    ).toHaveText("OK");
  const review = tests.filter({ hasText: "large_order_review" });
  await expect(review.locator(".test-status")).toHaveText("Warning");
  await expect(review.locator("td.number")).toHaveText("10");
  await results.getByRole("tab", { name: /^Log/ }).click();
  await expect(
    results
      .locator(".log-entry.info")
      .filter({ hasText: "107 paid orders kept, 13 excluded" }),
  ).toBeVisible();
  // The shared view filters with the selected environment's review threshold.
  await results.getByRole("tab", { name: /^Data/ }).click();
  await results
    .getByRole("button", { name: "Orders to review", exact: true })
    .click();
  await expect(results.locator(".preview-footer")).toContainText(
    "10 of 107 rows match",
  );

  // Checks run before the export writes the file named after the month.
  await node("export").locator(".node-shape").click();
  await results.getByRole("tab", { name: /^Tests/ }).click();
  await expect(
    results
      .locator(".test-row")
      .filter({ hasText: "report_not_empty" })
      .locator(".test-status"),
  ).toHaveText("OK");
  const exported = await (
    await page.request.get(`${url}/exports/export?environment=dev`)
  ).json();
  expect(exported).toMatchObject({
    status: "available",
    filename: "regional-revenue-2026-10.csv",
  });

  await page.getByRole("link", { name: "Variables", exact: true }).click();
  const table = page.locator(".variables-table");
  const row = (name: string) =>
    table.getByRole("row").filter({ hasText: name });
  await expect(row("high_value_threshold")).toContainText("900");
  await expect(row("review_threshold")).toContainText("1350");
  await expect(row("report_month")).toContainText("2026-10");
  // Production keeps the same orders, since its amounts are three times larger.
  const prod = await (
    await page.request.get(`${url}/variables/scope?environment=prod`)
  ).json();
  expect(prod).toMatchObject({
    high_value_threshold: { value: 900, source: "environment" },
    review_threshold: { value: 1350, source: "environment" },
  });
});
