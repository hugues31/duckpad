import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { historyTags, runTags } from "./tags-flow";

test("History creates immutable tags used by comparison and advanced branch creation", async ({
  page,
}) => {
  await signIn(page);
  await historyTags(page, true);
});

test("run details tag the executed commit after the branch has advanced", async ({
  page,
}) => {
  await signIn(page);
  await runTags(page);
});

test("Readers can see tags but cannot create them from history or run details", async ({
  page,
}) => {
  await signIn(page);
  const { tree } = await runTags(page);
  const username = `tag-reader-${Date.now()}`;
  const password = "tag-reader-password";
  const user = await (
    await page.request.post("/api/users", { data: { username, password } })
  ).json();
  expect(
    (
      await page.request.put(
        `/api/projects/${tree.project}/members/${user.id}`,
        { data: { role: "reader" } },
      )
    ).ok(),
  ).toBeTruthy();
  await page.request.post("/api/logout");
  expect(
    (
      await page.request.post("/api/login", { data: { username, password } })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${tree.id}/history`);
  await page.locator("button.history-row").first().click();
  const execution = page.getByRole("dialog", {
    name: "View execution",
    exact: true,
  });
  await expect(execution.getByLabel("Tags", { exact: true })).toContainText(
    "tested/v1",
  );
  await expect(
    execution.getByRole("button", {
      name: "Tag this run's commit",
      exact: true,
    }),
  ).toHaveCount(0);
  await execution.getByTitle("Close", { exact: true }).click();
  await page.getByRole("button", { name: "Git history", exact: true }).click();
  await expect(page.getByLabel("Tags", { exact: true })).toContainText(
    "tested/v1",
  );
  await expect(
    page.getByRole("button", { name: "Create tag", exact: true }),
  ).toHaveCount(0);
});
