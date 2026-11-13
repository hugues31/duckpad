import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("source row impact explains rejection, grouping and export across components", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
    .filter({ has: page.getByText("Orders", { exact: true }) })
    .click();
  await page
    .getByRole("button", { name: /^Explain this value: status, rows 9,/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await panel.getByRole("button", { name: "Impact", exact: true }).click();
  await expect(panel.locator(".row-impact > .notice")).toContainText(
    "stops at Paid orders",
  );
  await expect(panel.locator(".row-impact-discarded")).toContainText(
    "'refunded' = 'paid'",
  );
  await expect(panel.locator(".row-impact-grouped")).toContainText(
    "119 other rows",
  );
  await expect(
    panel.locator(".row-impact-unreached").filter({ hasText: "Net amounts" }),
  ).toBeVisible();
  await expect(page.locator(".row-impact-stopped")).toContainText(
    "Paid orders",
  );
  await expect(
    page.locator(".react-flow__node.row-impact-travelled"),
  ).toHaveCount(3);
  await expect(
    page
      .locator(".react-flow__edge.row-impact-travelled .react-flow__edge-path")
      .first(),
  ).toHaveCSS("stroke", "rgb(31, 122, 77)");
  const link = page.url();
  await page.reload();
  await expect(panel.locator(".row-impact-discarded")).toContainText(
    "'refunded' = 'paid'",
  );
  expect(page.url()).toBe(link);
  await panel.getByRole("button", { name: "Origin", exact: true }).click();
  await page.goBack();
  await expect(panel.locator(".row-impact-discarded")).toBeVisible();
  await page
    .getByRole("button", { name: /^Explain this value: status, rows 2,/ })
    .click();
  await panel.getByRole("button", { name: "Impact", exact: true }).click();
  await expect(panel.locator(".row-impact-written")).toContainText(
    "regional-revenue-",
  );
  await expect(
    panel
      .locator(".row-impact-grouped")
      .filter({ hasText: "Revenue by region" }),
  ).toContainText("26 other rows");
  await expect(
    panel
      .locator(".row-impact-grouped")
      .filter({ hasText: "Revenue by region" }),
  ).toContainText("South");
  await panel
    .getByRole("button", { name: "Open on the canvas", exact: false })
    .first()
    .click();
  await expect(
    page.locator(".react-flow__node.row-impact-travelled"),
  ).not.toHaveCount(0);
  await page.request.post(`/api/worktrees/${worktree.id}/runs`, {
    data: { environment: "dev", targets: ["orders"] },
  });
  await expect(panel).toContainText("interrupted");
  expect(errors).toEqual([]);
});
