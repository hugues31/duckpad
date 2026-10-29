import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openInstanceSettings, signIn } from "../e2e/helpers";

// All scenes use the real application and disposable, synthetic Northstar data.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("duckpad-theme", "light");
    localStorage.setItem("duckpad-language", "en");
  });
  await signIn(page);
});

async function capture(
  page: Page,
  name: string,
  region: Page | Locator = page,
) {
  await mkdir(resolve("../docs/images"), { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await region.screenshot({
    path: resolve("../docs/images", `${name}.png`),
    animations: "disabled",
    caret: "hide",
    // Hide transient notifications and variable Git metadata, not product state.
    style:
      ".toast, .resource-monitor, .git-revisions small { visibility: hidden !important; }",
  });
}

function node(page: Page, label: string) {
  return page.locator(".react-flow__node").filter({
    has: page.getByText(label, { exact: true }),
  });
}

async function example(page: Page) {
  const response = await page.request.post("/api/example", {
    data: { name: "Northstar" },
  });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
  return worktree;
}

async function run(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const execution = await result.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${execution.id}`)).json())
          .status,
      { timeout: 30000 },
    )
    .toBe("success");
}

test("capture project creation, results, lineage and SQL", async ({ page }) => {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Northstar");
  await dialog.getByRole("radio", { name: "Start from an example" }).check();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await capture(page, "new-project", dialog);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
  await run(page);
  await node(page, "Regional revenue").click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  const revenue = page.getByRole("button", {
    name: /Explain this value: revenue, rows 1,/,
  });
  await expect(revenue).toBeVisible();
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "workspace");
  await revenue.click();
  const lineage = page.getByRole("dialog", {
    name: "How this value was calculated",
  });
  await expect(lineage).toContainText("Sum of 27 contributing values", {
    ignoreCase: true,
  });
  await expect(lineage.locator(".lineage-card.is-source")).toHaveCount(5);
  await capture(page, "lineage", lineage);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page
    .getByRole("treeitem", { name: "templates/sql.sql", exact: true })
    .click();
  await expect(page.locator(".code-file-heading")).toContainText(
    "templates/sql.sql",
  );
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "SELECT",
  );
  await capture(page, "code");
});

test("capture parameters, node documentation and nested components", async ({
  page,
}) => {
  await example(page);
  await run(page);
  await node(page, "Paid orders").click();
  await page.getByLabel("Output", { exact: true }).selectOption("orders");
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("textbox", { name: /status/ })).toHaveValue(
    "paid",
  );
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "parameters");
  await inspector
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await expect(inspector.locator(".documentation-editor")).not.toHaveValue("");
  await capture(page, "node-documentation");
  await node(page, "Regional revenue").dblclick();
  await expect(
    page.getByText(
      "You are editing a shared component definition in this branch.",
    ),
  ).toBeVisible();
  await node(page, "Regional summary").dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await node(page, "Revenue by region").click();
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "component");
});

test("capture connection setup and environment policies", async ({ page }) => {
  await openInstanceSettings(page, "Connections");
  await page
    .getByRole("button", { name: "New connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("ID", { exact: true }).fill("xlsx");
  await dialog.getByLabel("Name", { exact: true }).fill("Excel reports");
  await dialog
    .getByRole("combobox", { name: "Connector", exact: true })
    .selectOption("xlsx");
  await expect(dialog.getByLabel("root", { exact: true })).toHaveValue("");
  await capture(page, "connection", dialog);
  await page.keyboard.press("Escape");
  await openInstanceSettings(page, "Environments");
  await expect(page.locator(".environment-card")).toHaveCount(2);
  await expect(
    page.getByRole("article", { name: "prod", exact: true }),
  ).toContainText("Confirm every run");
  await capture(page, "environments", page.locator(".settings-layout"));
});

test("capture branch creation and a real parameter comparison", async ({
  page,
}) => {
  await example(page);
  await page.getByTitle("New working branch", { exact: true }).click();
  const branch = page.getByRole("dialog", {
    name: "New working branch",
    exact: true,
  });
  await branch
    .getByLabel("Branch name", { exact: true })
    .fill("experiment/refunded-orders");
  await expect(
    branch.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await capture(page, "new-branch", branch);
  await branch.getByRole("button", { name: "Create", exact: true }).click();
  await expect(branch).toBeHidden();
  await node(page, "Paid orders").click();
  const status = page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ });
  await status.fill("refunded");
  await status.blur();
  const worktree = new URL(page.url()).pathname.split("/")[2];
  await expect
    .poll(async () => {
      const snapshot = await (
        await page.request.get(`/api/worktrees/${worktree}`)
      ).json();
      return snapshot.bundle.flow.nodes.find(
        (n: { label: string }) => n.label === "Paid orders",
      ).params.status;
    })
    .toBe("refunded");
  // Keep both revision selectors and the before/after values in the image.
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  const git = page.getByRole("dialog", { name: "Project Git workspace" });
  await git
    .getByRole("button", { name: "Compare versions", exact: true })
    .first()
    .click();
  await git.getByLabel("A: reference").fill("main");
  await git.getByLabel("B: target").fill("experiment/refunded-orders");
  await expect(git.locator(".change-list")).toContainText("Paid orders");
  await git.locator(".change-row").filter({ hasText: "Paid orders" }).click();
  await expect(git.locator(".comparison-values")).toContainText("refunded");
  await expect(git.locator(".comparison-values")).toContainText("paid");
  await expect(
    git.locator(".comparison-values tr").filter({ hasText: "refunded" }),
  ).toBeInViewport({ ratio: 1 });
  await capture(page, "git-comparison", git);
});
