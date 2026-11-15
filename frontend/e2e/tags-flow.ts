import { expect, type Page } from "@playwright/test";
import type { GitTag } from "../src/gitTypes";

async function project(page: Page) {
  const response = await page.request.post("/api/projects", {
    data: { name: "Acceptance tags" },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function save(page: Page, worktree: string, description: string) {
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  snapshot.bundle.documentation.project = description;
  snapshot.bundle.templates = {
    query: "-- @label Revenue\n-- @output result\nSELECT 42 AS revenue;",
  };
  snapshot.bundle.flow.nodes = [
    {
      id: "revenue",
      template: "query",
      label: "Revenue",
      params: {},
      position: { x: 0, y: 0 },
    },
  ];
  const response = await page.request.put(`/api/worktrees/${worktree}`, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function submitTag(page: Page) {
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/git/tags"),
  );
  await page
    .getByRole("dialog", { name: "Create tag", exact: true })
    .getByRole("button", { name: "Create tag", exact: true })
    .click();
  return response;
}

/** Exercise the same acceptance flow locally and on the deployed preview. */
export async function historyTags(page: Page, paginate = false) {
  const tree = await project(page);
  const first = await save(page, tree.id, "Accepted documentation");
  const latest = await save(page, tree.id, "Unreviewed documentation");
  if (paginate) {
    await page.route(
      `**/api/worktrees/${tree.id}/git/history*`,
      async (route) => {
        const url = new URL(route.request().url());
        url.searchParams.set("limit", "1");
        await route.fulfill({
          response: await route.fetch({ url: url.toString() }),
        });
      },
    );
  }
  await page.goto(`/worktrees/${tree.id}/history`);
  await page.getByRole("button", { name: "Git history", exact: true }).click();
  if (paginate)
    await page.getByRole("button", { name: "Load more", exact: true }).click();
  const row = page
    .locator(".history-row")
    .filter({ hasText: first.commit.slice(0, 8) });
  await row.getByRole("button", { name: "Create tag", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create tag", exact: true });
  await expect(dialog.getByLabel("Tag name", { exact: true })).toBeFocused();
  await expect(dialog).toContainText(first.commit);
  await expect(dialog).toContainText("cannot be moved or deleted");
  await dialog.getByLabel("Tag name", { exact: true }).fill("sales/");
  const notes = "Revenue totals verified.\nReady for production.";
  await dialog.getByLabel("Acceptance notes").fill(notes);
  expect((await submitTag(page)).status()).toBe(422);
  await expect(dialog.getByRole("alert")).toContainText("valid tag name");
  await expect(dialog.getByLabel("Acceptance notes")).toHaveValue(notes);
  await dialog.getByLabel("Tag name", { exact: true }).fill("sales/2026.10.31");
  const created = await submitTag(page);
  expect(created.status()).toBe(201);
  expect((await created.json()).commit).toBe(first.commit);
  await expect(dialog).toBeHidden();
  await expect(row.getByLabel("Tags", { exact: true })).toContainText(
    "sales/2026.10.31",
  );
  const tags: GitTag[] = await (
    await page.request.get(`/api/worktrees/${tree.id}/git/tags`)
  ).json();
  expect(tags[0].message).toBe(notes);
  expect(tags[0].tagger?.name).toBe("admin");
  // An error preserves the entered name and notes and cannot replace the original tag.
  await page
    .locator(".history-row")
    .filter({ hasText: latest.commit.slice(0, 8) })
    .getByRole("button", { name: "Create tag", exact: true })
    .click();
  await dialog.getByLabel("Tag name", { exact: true }).fill("sales/2026.10.31");
  await dialog
    .getByLabel("Acceptance notes")
    .fill("Must not replace acceptance");
  expect((await submitTag(page)).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  const compare = page.getByRole("dialog", { name: "Project Git workspace" });
  await expect(
    compare.locator('datalist option[value="refs/tags/sales/2026.10.31"]'),
  ).toHaveCount(1);
  await compare.getByLabel("A: reference").fill("refs/tags/sales/2026.10.31");
  await compare.getByLabel("B: target").fill(latest.commit);
  await expect(compare.locator(".git-revisions")).toContainText(
    first.commit.slice(0, 12),
  );
  await expect(compare.locator(".change-list")).toContainText("Documentation");
  await compare.getByRole("button", { name: "Swap A/B", exact: true }).click();
  await expect(compare.getByLabel("B: target")).toHaveValue(
    "refs/tags/sales/2026.10.31",
  );
  await expect(compare.locator(".git-revisions")).toContainText(
    first.commit.slice(0, 12),
  );
  await compare.getByTitle("Close", { exact: true }).click();

  await page.getByTitle("New working branch", { exact: true }).click();
  const branch = page.getByRole("dialog", {
    name: "New working branch",
    exact: true,
  });
  await branch
    .getByLabel("Branch name", { exact: true })
    .fill("from-acceptance");
  await branch.getByLabel("Starting revision").selectOption("custom");
  await branch
    .getByLabel("Git reference", { exact: true })
    .fill("refs/tags/sales/2026.10.31");
  const opened = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/branches"),
  );
  await branch.getByRole("button", { name: "Create", exact: true }).click();
  const branchResponse = await opened;
  expect(branchResponse.ok()).toBeTruthy();
  const branchTree = await branchResponse.json();
  const branchSnapshot = await (
    await page.request.get(`/api/worktrees/${branchTree.id}`)
  ).json();
  expect(branchSnapshot.commit).toBe(first.commit);
  return { tree, commit: first.commit };
}

export async function runTags(page: Page) {
  const tree = await project(page);
  const accepted = await save(page, tree.id, "Version tested by this run");
  const launched = await page.request.post(`/api/worktrees/${tree.id}/runs`, {
    data: { environment: "dev" },
  });
  expect(launched.ok()).toBeTruthy();
  const run = await launched.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
    )
    .toBe("success");
  const later = await save(page, tree.id, "Changed after the successful run");
  expect(later.commit).not.toBe(accepted.commit);
  await page.goto(`/worktrees/${tree.id}/history`);
  await page.locator("button.history-row").first().click();
  const execution = page.getByRole("dialog", {
    name: "View execution",
    exact: true,
  });
  await execution
    .getByRole("button", { name: "Tag this run's commit", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create tag", exact: true });
  await expect(dialog).toContainText(accepted.commit);
  await dialog.getByLabel("Tag name", { exact: true }).fill("tested/v1");
  await dialog
    .getByLabel("Acceptance notes")
    .fill("Run completed successfully with revenue 42.");
  const response = await submitTag(page);
  expect(response.status()).toBe(201);
  expect((await response.json()).commit).toBe(accepted.commit);
  await expect(dialog).toBeHidden();
  await expect(execution.getByLabel("Tags", { exact: true })).toContainText(
    "tested/v1",
  );
  await execution.getByTitle("Close", { exact: true }).click();
  await page.getByRole("button", { name: "Git history", exact: true }).click();
  await expect(
    page
      .locator(".history-row")
      .filter({ hasText: accepted.commit.slice(0, 8) })
      .getByLabel("Tags", { exact: true }),
  ).toContainText("tested/v1");
  return { tree, commit: accepted.commit };
}
