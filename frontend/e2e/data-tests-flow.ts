import { expect, type Page } from "@playwright/test";
import type { Run, Snapshot } from "../src/types";

/** Exercise data tests in normal node code on Northstar, locally or in a preview. */
export async function verifyDataTests(page: Page) {
  const created = await page.request.post("/api/example", {
    data: { name: "Northstar data tests" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  const url = `/api/worktrees/${worktree.id}`;
  await page.goto(`/worktrees/${worktree.id}/flow`);
  const node = (id: string) =>
    page.locator(`.react-flow__node[data-id="${id}"]`);
  const inspector = page.locator(".inspector");
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await node("validated").locator(".node-shape").click();
  await inspector
    .getByRole("button", { name: "Detach from template", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  const snapshot: Snapshot = await (await page.request.get(url)).json();
  const original = snapshot.files["nodes/validated.sql"];
  const edit = async (severity: "error" | "warning", predicate: string) => {
    await inspector
      .getByRole("button", { name: "Edit code", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".monaco-editor")).toBeVisible();
    await dialog.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(
      original +
        `\n-- @test orders_checked: ${severity}\nSELECT * FROM {{ orders }} WHERE ${predicate};`,
    );
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  };
  const launch = async () => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`${url}/runs`) && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
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
  const tests = inspector.locator(".node-tests > .execution-messages");
  await edit("warning", "true");
  const warning = await launch();
  expect(warning.status).toBe("success");
  expect(warning.warning_count).toBe(1);
  const count = warning.nodes.validated.results![0].observed;
  expect(Number(count)).toBeGreaterThan(0);
  await expect(
    node("validated").getByLabel("Warnings: 1", { exact: true }),
  ).toBeVisible();
  await expect(tests).toContainText("Warning");
  await expect(tests).toContainText(`Failing rows: ${count}`);
  await expect(tests).toContainText("Data test · orders");

  await edit("error", "true");
  const failed = await launch();
  expect(failed.nodes.validated.status).toBe("failed");
  expect(failed.nodes.export.status).toBe("blocked");
  await expect(node("validated").locator(".node-status")).toContainText(
    "Failed",
  );
  await expect(tests).toContainText("Error");
  await expect(tests).toContainText("orders_checked");
  const retained = await (
    await page.request.get(
      `${url}/preview/validated?environment=dev&port=orders`,
    )
  ).json();
  expect(retained.run).toBe(warning.id);
  expect(retained.status).toBe("stale");

  await edit("error", "false");
  const passed = await launch();
  expect(passed.status).toBe("success");
  expect(passed.warning_count).toBe(0);
  await expect(tests).toContainText("OK");
  await expect(tests).toContainText("Failing rows: 0");
  await expect(
    node("validated").getByLabel("Warnings: 1", { exact: true }),
  ).toHaveCount(0);
  await inspector.locator(".test-history summary").click();
  const previous = inspector.locator(".test-history .execution-messages");
  await expect(previous).toHaveCount(2);
  await expect(previous.nth(0)).toContainText("Error");
  await expect(previous.nth(1)).toContainText("Warning");
  await expect(previous.nth(0)).toContainText(`Failing rows: ${count}`);

  await page.getByRole("link", { name: "History", exact: true }).click();
  const details = page.getByRole("dialog");
  for (const [index, status, observed] of [
    [0, "OK", 0],
    [1, "Error", count],
  ] as const) {
    await page.locator(".history-row").nth(index).click();
    await details
      .locator(".run-step summary")
      .filter({ hasText: "Paid orders" })
      .click();
    const results = details.getByRole("region", { name: "Execution messages" });
    await expect(results).toContainText("orders_checked");
    await expect(results).toContainText(status);
    await expect(results).toContainText(`Failing rows: ${observed}`);
    await details.getByRole("button", { name: "Close", exact: true }).click();
  }
  return {
    worktree: worktree.id,
    warning: warning.id,
    failed: failed.id,
    passed: passed.id,
  };
}
