import { expect, test, type Page } from "@playwright/test";
import { PASSWORD } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.DUCKPAD_AUDIT_PASSWORD || PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
});

test.afterEach(async ({ page }, info) => {
  for (const annotation of info.annotations) {
    if (annotation.type !== "audit-project") continue;
    const response = await page.request.delete(
      `/api/projects/${annotation.description}`,
    );
    expect(response.ok()).toBe(true);
  }
});

async function project(page: Page, name: string, example = false) {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  if (example)
    await dialog.getByRole("radio", { name: "Start from an example" }).check();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith(example ? "/api/example" : "/api/projects") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const worktree = await response.json();
  test.info().annotations.push({
    type: "audit-project",
    description: worktree.project,
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Active project")).toHaveValue(worktree.project);
  return worktree.id as string;
}

async function run(page: Page) {
  const button = page.getByRole("button", {
    name: "Run pipeline",
    exact: true,
  });
  await expect(button).toBeEnabled();
  const launched = page.waitForResponse(
    (response) =>
      response.url().endsWith("/runs") &&
      response.request().method() === "POST",
  );
  await button.click();
  const response = await launched;
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${id}`)).json()).status,
      { timeout: 60000 },
    )
    .toMatch(/^(success|partial_failure|failed)$/);
  await expect(button).toBeEnabled();
  return (await (await page.request.get(`/api/runs/${id}`)).json())
    .status as string;
}

async function save(page: Page) {
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
}

// Regression from the exploratory audit: a new result must have a usable page.
for (const { status, count, title } of [
  {
    status: "refunded",
    count: 13,
    title: "results return to a usable page when a rerun reduces the row count",
  },
  {
    status: "no-such-status",
    count: 0,
    title: "results reset pagination when a rerun returns no rows",
  },
]) {
  test(title, async ({ page }) => {
    // Exercise three complete pipeline runs, including recovery after shrinking.
    test.slow();
    await project(page, "Pagination regression", true);
    expect(await run(page)).toBe("success");
    await page
      .locator('.react-flow__node[data-id="validated"] .node-shape')
      .click();
    const results = page.getByRole("region", { name: "Results", exact: true });
    const range = results.locator(".preview-footer .row > span");
    const rows = results.locator(".data-table tbody tr");
    const previous = results.getByRole("button", {
      name: "Previous",
      exact: true,
    });
    const next = results.getByRole("button", { name: "Next", exact: true });
    await expect(range).toHaveText("1–100 / 107");
    await expect(rows).toHaveCount(100);
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(range).toHaveText("101–107 / 107");
    await expect(rows).toHaveCount(7);
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(range).toHaveText("1–100 / 107");
    await expect(rows).toHaveCount(100);
    await next.click();
    await expect(range).toHaveText("101–107 / 107");
    await expect(rows).toHaveCount(7);

    await page
      .locator(".inspector")
      .getByRole("textbox", { name: /status/ })
      .fill(status);
    await save(page);
    expect(await run(page)).toBe("success");
    await expect(results.locator(".results-header")).toContainText(
      `${count} rows`,
    );
    await expect(range).toHaveText(count ? `1–${count} / ${count}` : "0 / 0");
    await expect(rows).toHaveCount(count);
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    if (count) {
      await expect(
        results.getByText("No rows match these filters"),
      ).toHaveCount(0);
      await expect(rows.first().locator(".row-number")).toHaveText("1");
      await expect(rows.last().locator(".row-number")).toHaveText(
        String(count),
      );
    }

    // Growing the result again must not resurrect the abandoned page offset.
    await page
      .locator(".inspector")
      .getByRole("textbox", { name: /status/ })
      .fill("paid");
    await save(page);
    expect(await run(page)).toBe("success");
    await expect(range).toHaveText("1–100 / 107");
    await expect(rows).toHaveCount(100);
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(range).toHaveText("101–107 / 107");
    await expect(rows).toHaveCount(7);
  });
}
