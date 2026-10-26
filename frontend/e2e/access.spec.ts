import { test, expect, type Page } from "@playwright/test";

async function login(
  page: Page,
  username = "admin",
  password = "duckpad-browser-test",
) {
  await page.goto("/");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace", exact: true }),
  ).toBeVisible();
}

test("manage instance accounts, project participants and live reader access", async ({
  page,
  browser,
}) => {
  await login(page);
  const username = `reader-${Date.now()}`;
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Users", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Username", { exact: true }).fill(username);
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("reader-browser-password");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: username });
  await expect(row).toContainText("Active");
  const users = await (await page.request.get("/api/users")).json();
  const reader = users.find(
    (u: { username: string }) => u.username === username,
  );
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Shared access test" },
    })
  ).json();
  await page.evaluate(
    (id) => localStorage.setItem("duckpad-worktree", id),
    worktree.id,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Project settings", exact: true })
    .click();
  await page.getByLabel("User", { exact: true }).selectOption(reader.id);
  await page.getByLabel("Project role", { exact: true }).selectOption("reader");
  await page
    .getByRole("button", { name: "Add participant", exact: true })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: username }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/project-access.png",
    fullPage: true,
  });
  const readerContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  await login(readerPage, username, "reader-browser-password");
  await expect(
    readerPage.getByRole("button", { name: "Users", exact: true }),
  ).toHaveCount(0);
  await readerPage
    .getByRole("button", {
      name: "Open project: Shared access test",
      exact: true,
    })
    .click();
  await expect(
    readerPage.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeDisabled();
  await expect(
    readerPage.getByRole("button", { name: "New working branch", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel(`Project role · ${username}`, { exact: true })
    .selectOption("editor");
  await expect(
    readerPage.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("row")
    .filter({ hasText: username })
    .getByRole("button", { name: "Remove access" })
    .click();
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    readerPage.getByRole("heading", {
      name: "Your first pipeline starts here.",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await row.getByRole("button", { name: "Deactivate", exact: true }).click();
  await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(row).toContainText("Inactive");
  await expect(
    readerPage.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({
    path: "test-results/instance-users.png",
    fullPage: true,
  });
  await readerContext.close();
});

test("last administrator protection is visible in the management screen", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page
    .getByLabel("Instance role · admin", { exact: true })
    .selectOption("member");
  await expect(page.getByRole("alert")).toContainText(
    "Keep at least one active instance administrator",
  );
  await expect(
    page.getByLabel("Instance role · admin", { exact: true }),
  ).toHaveValue("admin");
});
