import { expect, test, type Page } from "@playwright/test";
import { PASSWORD } from "./helpers";

// Exploratory findings: each test checks its setup and workaround normally, then
// marks only the final user-visible expectation as a known failure. Remove that
// marker when fixing the bug; an unexpected pass means this report needs updating.
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
      { timeout: 30000 },
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

async function evidence(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

test("results return to a usable page when a rerun reduces the row count", async ({
  page,
}) => {
  await project(page, "Audit pagination", true);
  expect(await run(page)).toBe("success");
  await page
    .locator('.react-flow__node[data-id="validated"] .node-shape')
    .click();
  const results = page.getByRole("region", { name: "Results", exact: true });
  const footer = results.locator(".preview-footer");
  await expect(footer).toContainText("1–100 / 107");
  await results.getByRole("button", { name: "Next", exact: true }).click();
  await expect(footer).toContainText("101–107 / 107");
  await page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ })
    .fill("refunded");
  await save(page);
  expect(await run(page)).toBe("success");
  await expect(results.locator(".results-header")).toContainText("13 rows");
  await expect(footer).toContainText("/ 13");
  const observed = {
    rows: await results.locator(".data-table tbody tr").count(),
    page: (await footer.locator(".row > span").innerText()).trim(),
  };
  await evidence(page, "pagination-after-rerun");

  // Control: the result is present; going back a page recovers all thirteen rows.
  const previous = results.getByRole("button", {
    name: "Previous",
    exact: true,
  });
  if (await previous.isEnabled()) await previous.click();
  await expect(results.locator(".data-table tbody tr")).toHaveCount(13);
  await expect(footer).toContainText("1–13 / 13");

  test.fail(
    true,
    "The old offset remains 100 after the dataset shrinks to 13 rows.",
  );
  expect(observed).toEqual({ rows: 13, page: "1–13 / 13" });
});

for (const mixed of [false, true]) {
  test(`guided text equality ${mixed ? "accepts nonnumeric codes" : "preserves leading zeros"}`, async ({
    page,
  }) => {
    const worktree = await project(page, "Audit text filtering");
    const inspector = page.locator(".inspector");
    await page.getByRole("button", { name: "Load CSV", exact: true }).click();
    const source = await page
      .locator(".react-flow__node")
      .getAttribute("data-id");
    await inspector.getByLabel("Upload file", { exact: true }).setInputFiles({
      name: "codes.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        `code,label\n001,First\n1,Second\n${mixed ? "ABC" : "002"},Third\n`,
      ),
    });
    await expect(inspector.getByRole("textbox", { name: /file/ })).toHaveValue(
      /codes\.csv$/,
    );
    await inspector
      .getByRole("textbox", { name: /types/ })
      .fill('{"code":"VARCHAR"}');
    await save(page);
    expect(await run(page)).toBe("success");
    await expect(page.locator(".data-table tbody tr")).toHaveCount(3);
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    const filter = await page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("Filter", { exact: true }) })
      .getAttribute("data-id");
    await inspector
      .getByLabel("source", { exact: true })
      .selectOption(`${source}:result`);
    await expect(inspector.getByLabel("Column", { exact: true })).toContainText(
      "code",
    );
    await inspector.getByLabel("Column", { exact: true }).selectOption("code");
    await inspector.getByLabel("Value", { exact: true }).fill("001");
    await inspector
      .getByRole("button", { name: "Apply to parameters", exact: true })
      .click();
    await save(page);
    const status = await run(page);
    let codes: string[] = [];
    if (status === "success") {
      const preview = await (
        await page.request.get(
          `/api/worktrees/${worktree}/preview/${filter}?environment=dev&port=result`,
        )
      ).json();
      codes = preview.rows.map((row: { values: string[] }) => row.values[0]);
      await expect(page.locator(".data-table tbody tr")).toHaveCount(
        codes.length,
      );
    } else {
      await expect(inspector.locator(".result-summary")).toContainText(
        "Failed",
      );
      await page
        .getByRole("region", { name: "Results", exact: true })
        .getByRole("tab", { name: /^Log/ })
        .click();
      await expect(page.locator(".results-panel")).toContainText(
        "Could not convert string",
      );
    }
    await evidence(
      page,
      mixed ? "text-filter-conversion" : "text-filter-extra-row",
    );

    // Control: the same source and operator work when the value stays a string.
    await inspector
      .getByRole("textbox", { name: /condition/ })
      .fill("\"code\" = '001'");
    await save(page);
    expect(await run(page)).toBe("success");
    await page
      .getByRole("region", { name: "Results", exact: true })
      .getByRole("tab", { name: /^Data/ })
      .click();
    await expect(page.locator(".data-table tbody tr")).toHaveCount(1);
    await expect(
      page.locator(".data-table tbody tr td:nth-child(2)"),
    ).toHaveText("001");

    test.fail(
      true,
      "The guided filter guesses a number from text instead of using the column type.",
    );
    expect({ status, codes }).toEqual({ status: "success", codes: ["001"] });
  });
}

test("input choices use the names shown on the canvas for normal nodes", async ({
  page,
}) => {
  await project(page, "Audit source names");
  await page.getByRole("button", { name: "Load CSV", exact: true }).click();
  const source = await page
    .locator(".react-flow__node")
    .getAttribute("data-id");
  await page.getByRole("button", { name: "Load Parquet", exact: true }).click();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Filter", { exact: true }) })
    .getAttribute("data-id");
  const inspector = page.locator(".inspector");
  const input = inspector.getByLabel("source", { exact: true });
  const names = await input.locator('option:not([value=""])').allTextContents();
  await expect(
    page.locator(`.react-flow__node[data-id="${source}"]`),
  ).toContainText("Load CSV");
  await input.click();
  await evidence(page, "source-choice-names");
  await page.keyboard.press("Escape");

  // Control: explicitly renaming the node makes its name available to the picker.
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page
    .locator(`.react-flow__node[data-id="${source}"] .node-shape`)
    .click();
  await inspector
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Order codes");
  await save(page);
  await page
    .locator(`.react-flow__node[data-id="${filter}"] .node-shape`)
    .click();
  await expect(input).toContainText("Order codes · result");

  test.fail(
    true,
    "Input choices fall back to node IDs instead of the effective display label.",
  );
  expect(names.sort()).toEqual(["Load CSV · result", "Load Parquet · result"]);
});
