import { expect, type Page } from "@playwright/test";
import { closeCode, nodeMenuAction, openCode, replaceCode } from "./helpers";
import type { Run, Snapshot } from "../src/types";

/** Verify message editing, publication and history on Northstar, locally or in a preview. */
export async function verifyMessages(page: Page) {
  const created = await page.request.post("/api/example", {
    data: { name: "Northstar messages" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot = async (): Promise<Snapshot> =>
    (await page.request.get(url)).json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  const node = (id: string) =>
    page.locator(`.react-flow__node[data-id="${id}"]`);
  const inspector = page.locator(".inspector");
  const results = page.getByRole("region", { name: "Results", exact: true });
  const summary = inspector.getByRole("group", {
    name: "Result summary",
    exact: true,
  });
  const select = async () => {
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await node("validated").locator(".node-shape").click();
  };
  await select();
  await nodeMenuAction(page, "Detach from template");
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  const original = (await snapshot()).files["nodes/validated.sql"];
  const warning =
    "\n-- @message\nSELECT 'warning' AS level, count(*) || ' paid orders checked' AS message FROM {{ orders }};";
  const edit = async (sql: string) => {
    await openCode(page);
    await replaceCode(page, sql);
    await closeCode(page);
  };
  const launch = async () => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`${url}/runs`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Run all", exact: true }).click();
    const started = await (await response).json();
    let run: Run;
    await expect
      .poll(
        async () => {
          run = await (
            await page.request.get(`/api/runs/${started.id}`)
          ).json();
          return ["success", "partial_failure", "failed"].includes(run.status);
        },
        { timeout: 45000 },
      )
      .toBe(true);
    return run!;
  };
  await edit(original + warning);
  const success = await launch();
  expect(success.status).toBe("success");
  // Northstar's large_order_review test already reports a warning.
  expect(success.warning_count).toBe(2);
  await expect(
    node("validated").getByLabel("Warnings: 2", { exact: true }),
  ).toBeVisible();
  // The inspector only counts warning messages; its badge opens the Log.
  await summary.getByRole("button", { name: "1 message", exact: true }).click();
  const message = results
    .locator(".log-entry.warning")
    .filter({ hasText: "paid orders checked" });
  await expect(message).toContainText("Warning");
  // The example's own message block comes first.
  await expect(message).toContainText("Message block 2 · orders");
  await expect(
    results
      .locator(".log-entry.info")
      .filter({ hasText: "107 paid orders kept, 13 excluded" }),
  ).toContainText("Message block 1 · orders");
  await page.getByRole("link", { name: "History", exact: true }).click();
  const history = page.locator(".history-row").first();
  await expect(
    history.getByLabel("Warnings: 2", { exact: true }),
  ).toBeVisible();
  await history.click();
  const details = page.getByRole("dialog");
  await details
    .locator(".run-step summary")
    .filter({ hasText: "Paid orders" })
    .click();
  await expect(
    details.getByRole("region", { name: "Execution messages" }),
  ).toContainText("paid orders checked");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await select();
  await edit(
    original +
      warning +
      "\n-- @message\nSELECT 'error' AS level, 'Orders need review' AS message;",
  );
  const failed = await launch();
  expect(failed.nodes.validated.status).toBe("failed");
  expect(failed.nodes.export.status).toBe("blocked");
  await expect(node("validated").locator(".node-status")).toContainText(
    "Failed",
  );
  await expect(node("export").locator(".node-status")).toContainText("Blocked");
  // The notice may also offer "Ask the assistant" when a preview has it enabled.
  await summary
    .getByRole("button", { name: "Last run failed", exact: true })
    .click();
  // The card above the log tells the error once.
  await expect(results.locator(".execution-error-message")).toHaveText(
    "Orders need review",
  );
  await expect(results.locator(".log-error")).toHaveCount(0);
  // The stale preview still shows the messages from its successful generation.
  const retained = await (
    await page.request.get(
      `${url}/preview/validated?environment=dev&port=orders`,
    )
  ).json();
  expect(retained.run).toBe(success.id);
  expect(retained.status).toBe("stale");
  expect(retained.results).toEqual(success.nodes.validated.results);
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.locator(".history-row").first().click();
  await details
    .locator(".run-step summary")
    .filter({ hasText: "Paid orders" })
    .click();
  await expect(
    details.getByRole("region", { name: "Execution messages" }),
  ).toContainText("Orders need review");
  return { worktree: worktree.id, success: success.id, failed: failed.id };
}
