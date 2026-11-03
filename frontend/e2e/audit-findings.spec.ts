import { expect, test, type Page } from "@playwright/test";
import { PASSWORD } from "./helpers";

import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };
import pt from "../src/locales/pt.json" with { type: "json" };

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

async function save(page: Page) {
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
}

test("input choices use the names shown on the canvas for normal nodes", async ({
  page,
}) => {
  const worktree = await project(page, "Audit source names");
  await page.getByRole("button", { name: "Load CSV", exact: true }).click();
  const source = await page
    .locator(".react-flow__node")
    .getAttribute("data-id");
  await page.getByRole("button", { name: "Load Parquet", exact: true }).click();
  const parquet = await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Load Parquet", { exact: true }) })
    .getAttribute("data-id");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Filter", { exact: true }) })
    .getAttribute("data-id");
  const inspector = page.locator(".inspector");
  const input = inspector.getByLabel("source", { exact: true });
  await expect(input.locator('option:not([value=""])')).toHaveText([
    "Load CSV · result",
    "Load Parquet · result",
  ]);
  await expect(
    page.locator(`.react-flow__node[data-id="${source}"]`),
  ).toContainText("Load CSV");
  await input.selectOption({ label: "Load Parquet · result" });
  await expect(input).toHaveValue(`${parquet}:result`);
  const connectedSource = async () => {
    const response = await page.request.get(`/api/worktrees/${worktree}`);
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    return snapshot.bundle.flow.edges.find(
      (edge: { target: string; targetHandle: string }) =>
        edge.target === filter && edge.targetHandle === "source",
    );
  };
  await expect.poll(connectedSource).toMatchObject({
    source: parquet,
    sourceHandle: "result",
  });

  // Explicit display names still take priority over the translated default.
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
  await input.selectOption({ label: "Order codes · result" });
  await expect(input).toHaveValue(`${source}:result`);
  await expect.poll(connectedSource).toMatchObject({
    source,
    sourceHandle: "result",
  });

  let current = en;
  for (const labels of [fr, pt, en]) {
    await page
      .getByRole("button", { name: current.accountMenu, exact: true })
      .click();
    await page
      .getByRole("group", { name: current.language, exact: true })
      .getByRole("menuitemradio")
      .nth(labels === fr ? 1 : labels === pt ? 2 : 0)
      .click();
    await expect(input.locator('option:not([value=""])')).toHaveText([
      "Order codes · result",
      `${labels.load_parquet} · result`,
    ]);
    await expect(
      page.locator(`.react-flow__node[data-id="${parquet}"]`),
    ).toContainText(labels.load_parquet);
    await expect(input).toHaveValue(`${source}:result`);
    current = labels;
  }
});
