import { expect, test, type Page } from "@playwright/test";
import { PASSWORD } from "./helpers";

// Regression cases adapted from the guided text equality findings in audit PR #160.
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

async function project(page: Page) {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Guided filtering");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
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

const cases = [
  ...[false, true].map((mixed) => ({
    name: `guided text equality ${mixed ? "accepts nonnumeric codes" : "preserves leading zeros"}`,
    data: `code,label\n001,First\n1,Second\n${mixed ? "ABC" : "002"},Third\n`,
    type: "VARCHAR",
    value: "001",
    operator: "=",
    condition: "\"code\" = '001'",
    expected: "001",
  })),
  {
    name: "guided numeric comparisons retain numeric ordering",
    data: "code,label\n10,First\n1,Second\n3,Third\n",
    type: "INTEGER",
    value: "2",
    operator: "<",
    condition: '"code" < 2',
    expected: 1,
  },
  {
    name: "guided boolean equality retains boolean values",
    data: "code,label\ntrue,First\nfalse,Second\nfalse,Third\n",
    type: "BOOLEAN",
    value: "true",
    operator: "=",
    condition: '"code" = TRUE',
    expected: true,
  },
];

for (const scenario of cases) {
  test(scenario.name, async ({ page }) => {
    const worktree = await project(page);
    const inspector = page.locator(".inspector");
    await page.getByRole("button", { name: "Load CSV", exact: true }).click();
    const source = await page
      .locator(".react-flow__node")
      .getAttribute("data-id");
    await inspector.getByLabel("Upload file", { exact: true }).setInputFiles({
      name: "codes.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(scenario.data),
    });
    await expect(inspector.getByRole("textbox", { name: /file/ })).toHaveValue(
      /codes\.csv$/,
    );
    await inspector
      .getByRole("textbox", { name: /types/ })
      .fill(JSON.stringify({ code: scenario.type }));
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
    await inspector
      .getByLabel("Operator", { exact: true })
      .selectOption(scenario.operator);
    await inspector.getByLabel("Value", { exact: true }).fill(scenario.value);
    await inspector
      .getByRole("button", { name: "Apply to parameters", exact: true })
      .click();
    await save(page);
    expect(await run(page)).toBe("success");
    const response = await page.request.get(
      `/api/worktrees/${worktree}/preview/${filter}?environment=dev&port=result`,
    );
    expect(response.ok()).toBe(true);
    const preview = await response.json();
    expect(
      preview.rows.map((row: { values: unknown[] }) => row.values[0]),
    ).toEqual([scenario.expected]);
    await expect(page.locator(".data-table tbody tr")).toHaveCount(1);
    await expect(
      page.locator(".data-table tbody tr td:nth-child(2)"),
    ).toHaveText(String(scenario.expected));
    await expect(
      inspector.getByRole("textbox", { name: /condition/ }),
    ).toHaveValue(scenario.condition);
  });
}
