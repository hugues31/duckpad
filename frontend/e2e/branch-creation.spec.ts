import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./helpers";
import fr from "../src/locales/fr.json" with { type: "json" };

async function change(page: Page, id: string, description: string) {
  const snapshot = await (
    await page.request.get(`/api/worktrees/${id}`)
  ).json();
  snapshot.bundle.documentation.project = description;
  const response = await page.request.put(`/api/worktrees/${id}`, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function project(page: Page) {
  await signIn(page);
  const response = await page.request.post("/api/projects", {
    data: { name: "Branch selection" },
  });
  expect(response.ok()).toBeTruthy();
  const tree = await response.json();
  const first = await change(page, tree.id, "Earlier documentation");
  const latest = await change(page, tree.id, "Latest documentation");
  await page.goto(`/worktrees/${tree.id}/flow`);
  await expect(
    page.getByTitle("New working branch", { exact: true }),
  ).toBeVisible();
  return { tree, first, latest };
}

async function open(page: Page) {
  await page.getByTitle("New working branch", { exact: true }).click();
  return page.getByRole("dialog", { name: "New working branch" });
}

async function create(page: Page, label = "Create") {
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/branches"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: label, exact: true })
    .click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const tree = await result.json();
  await expect(page.getByRole("dialog")).toBeHidden();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  return { snapshot, request: result.request().postDataJSON() };
}

test("default starting point follows the current branch at creation time", async ({
  page,
}) => {
  const { tree } = await project(page);
  const dialog = await open(page);
  await expect(dialog.getByLabel("Branch name", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("Starting revision")).toHaveValue("current");
  await expect(dialog.getByLabel("Starting revision")).toContainText(
    "Latest version · main",
  );
  await dialog
    .getByLabel("Branch name", { exact: true })
    .fill("experiment/latest");
  const changed = await change(page, tree.id, "Saved while choosing a branch");
  const result = await create(page);
  expect(result.request).toEqual({ name: "experiment/latest" });
  expect(result.snapshot.commit).toBe(changed.commit);
  expect(result.snapshot.bundle.documentation.project).toBe(
    "Saved while choosing a branch",
  );
});

test("searchable history preserves an explicit choice and creates the exact earlier version", async ({
  page,
}) => {
  const { first } = await project(page);
  const dialog = await open(page);
  await dialog
    .getByLabel("Branch name", { exact: true })
    .fill("experiment/earlier");
  await dialog.getByLabel("Starting revision").selectOption("history");
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  const search = dialog.getByLabel("Search loaded versions");
  await search.fill(first.commit.slice(0, 8));
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await dialog.getByRole("radio").check();
  await expect(dialog.locator(".branch-selected")).toContainText(
    first.commit.slice(0, 8),
  );
  await expect(dialog.locator(".branch-selected time")).toHaveAttribute(
    "datetime",
    /.+/,
  );
  await search.fill("no matching version");
  await expect(dialog.getByText(/No matching versions/)).toBeVisible();
  await expect(dialog.locator(".branch-selected")).toContainText(
    first.commit.slice(0, 8),
  );
  const result = await create(page);
  expect(result.request.revision).toBe(first.commit);
  expect(result.snapshot.commit).toBe(first.commit);
  expect(result.snapshot.bundle.documentation.project).toBe(
    "Earlier documentation",
  );
});

test("failed history can be retried and older pages stay anchored while the source changes", async ({
  page,
}) => {
  const { tree } = await project(page);
  const history = await (
    await page.request.get(`/api/worktrees/${tree.id}/git/history`)
  ).json();
  let failed = false;
  await page.route(
    `**/api/worktrees/${tree.id}/git/history*`,
    async (route) => {
      const url = new URL(route.request().url());
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          json: { error: "History temporarily unavailable" },
        });
      } else if (!url.searchParams.has("offset")) {
        await route.fulfill({
          json: { ...history, items: history.items.slice(0, 2), next: 2 },
        });
      } else {
        expect(url.searchParams.get("ref")).toBe(history.head);
        await route.continue();
      }
    },
  );
  const dialog = await open(page);
  await dialog
    .getByLabel("Branch name", { exact: true })
    .fill("experiment/oldest");
  await dialog.getByLabel("Starting revision").selectOption("history");
  await expect(dialog.getByRole("alert")).toContainText(
    "History temporarily unavailable",
  );
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await change(page, tree.id, "Newer version after loading history");
  await dialog.getByRole("button", { name: "Load more" }).click();
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  await dialog.getByRole("radio").last().check();
  const result = await create(page);
  expect(result.snapshot.commit).toBe(history.items[2].commit);
});

test("history entry preselects its version with French labels, keyboard access and a narrow layout", async ({
  page,
}) => {
  const { tree, first, latest } = await project(page);
  // The chosen commit can be older than the first page offered by the picker.
  await page.route(`**/api/worktrees/${tree.id}/git/history`, async (route) => {
    const response = await route.fetch();
    const history = await response.json();
    await route.fulfill({
      json: {
        ...history,
        items: history.items.filter(
          (item: { commit: string }) => item.commit === latest.commit,
        ),
        next: 1,
      },
    });
  });
  await page.evaluate(() => localStorage.setItem("duckpad-language", "fr"));
  await page.goto(`/worktrees/${tree.id}/history`);
  await page.getByRole("button", { name: fr.gitHistory, exact: true }).click();
  const row = page
    .locator(".history-row")
    .filter({ hasText: first.commit.slice(0, 8) });
  const opener = row.getByTitle(fr.restoreRevision);
  await opener.click();
  const dialog = page.getByRole("dialog", { name: fr.newBranch });
  await expect(dialog.getByLabel(fr.startingRevision)).toHaveValue("history");
  await expect(dialog.locator(".branch-selected")).toContainText(
    first.commit.slice(0, 8),
  );
  await expect(dialog.getByRole("radio")).toHaveCount(1);
  await dialog
    .getByLabel(fr.branchName, { exact: true })
    .fill("experiment/french");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole("button", { name: fr.create, exact: true }),
  ).toBeInViewport();
  await expect(dialog.getByTitle(fr.close)).toBeInViewport();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBeTruthy();
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole("button", { name: fr.create, exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByTitle(fr.close)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await dialog
    .getByLabel(fr.branchName, { exact: true })
    .fill("experiment/french");
  await expect(dialog.locator(".branch-selected")).toContainText(
    first.commit.slice(0, 8),
  );
  const result = await create(page, fr.create);
  expect(result.snapshot.commit).toBe(first.commit);
});

test("advanced references keep failed submissions editable", async ({
  page,
}) => {
  const { first } = await project(page);
  const dialog = await open(page);
  await dialog
    .getByLabel("Branch name", { exact: true })
    .fill("experiment/reference");
  await dialog.getByLabel("Starting revision").selectOption("custom");
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Git reference", { exact: true })
    .fill("missing-reference");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Branch name", { exact: true })).toHaveValue(
    "experiment/reference",
  );
  await dialog.getByLabel("Git reference", { exact: true }).fill(first.commit);
  const result = await create(page);
  expect(result.snapshot.commit).toBe(first.commit);
});
