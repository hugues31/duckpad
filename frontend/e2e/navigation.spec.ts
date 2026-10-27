import { expect, test } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn, submitLogin, openUserSettings } from "./helpers";

test("dedicated pages support direct sign-in, refresh, history, new tabs and translated labels", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/user-settings");
  await submitLogin(page);
  await expect(page).toHaveURL(/\/user-settings$/);
  await expect(
    page.getByRole("heading", { name: "User settings", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("User settings · Duckpad");
  await page
    .getByRole("link", { name: "Instance settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/instance-settings$/);
  await page.getByRole("link", { name: "Environments", exact: true }).click();
  await expect(page).toHaveURL(/\/instance-settings\/environments$/);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Add environment", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/instance-settings$/);
  await expect(
    page.getByRole("heading", { name: "Git author", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Author name", { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/user-settings$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/instance-settings$/);
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  const popup = context.waitForEvent("page");
  await page
    .getByRole("menuitem", { name: "User settings", exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  const other = await popup;
  await expect(other).toHaveURL(/\/user-settings$/);
  await expect(
    other.getByRole("heading", { name: "User settings", exact: true }),
  ).toBeVisible();
  await other.close();
  await openUserSettings(page);
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await expect(page).toHaveURL(/\/user-settings$/);
  await expect(page).toHaveTitle(`${fr.userSettings} · Duckpad`);
  await expect(
    page.getByRole("heading", { name: fr.userSettings, exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: fr.userSettings, exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("worktree URLs restore branch, tab and environment without running a pipeline", async ({
  page,
  context,
}) => {
  await signIn(page);
  const first = await (
    await page.request.post("/api/projects", {
      data: { name: "Routing first" },
    })
  ).json();
  const second = await (
    await page.request.post("/api/projects", {
      data: { name: "Routing second" },
    })
  ).json();
  const branch = await (
    await page.request.post(`/api/worktrees/${first.id}/branches`, {
      data: { name: "feature/routing" },
    })
  ).json();
  let runs = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/runs")) runs++;
  });
  await page.goto(`/worktrees/${branch.id}/history?environment=prod`);
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    branch.id,
  );
  await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(
    "prod",
  );
  await expect(
    page.getByRole("link", { name: "History", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/worktrees/${branch.id}/code\\?environment=prod$`),
  );
  await page.reload();
  await expect(page.locator(".code-workspace .monaco-editor")).toBeVisible();
  await page.getByLabel("Environment", { exact: true }).selectOption("dev");
  await page.goBack();
  await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(
    "prod",
  );
  await page
    .getByLabel("Active project", { exact: true })
    .selectOption(second.project);
  await expect(page).toHaveURL(
    new RegExp(`/worktrees/${second.id}/flow\\?environment=prod$`),
  );
  await page.goBack();
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    branch.id,
  );
  await page
    .getByRole("link", { name: "Project settings", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${first.project}/settings$`),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Project settings", exact: true }),
  ).toBeVisible();
  await context.clearCookies();
  await page.reload();
  await submitLogin(page);
  await expect(page).toHaveURL(
    new RegExp(`/projects/${first.project}/settings$`),
  );
  await expect(
    page.getByRole("heading", { name: "Project settings", exact: true }),
  ).toBeVisible();
  expect(runs).toBe(0);
});

test("unsaved code and documentation guard links and browser history without losing canceled drafts", async ({
  page,
}) => {
  await signIn(page);
  const projectName = `Routing drafts ${Date.now()}`;
  const created = await page.request.post("/api/projects", {
    data: { name: projectName },
  });
  expect(created.ok()).toBeTruthy();
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  await page
    .getByRole("link", { name: `Open project: ${projectName}`, exact: true })
    .click();
  await page.getByRole("link", { name: "Code", exact: true }).click();
  const editor = page.locator(".code-workspace .monaco-editor textarea");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText('{"unsaved":true}');
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await page.goBack();
  await expect(page.locator(".code-workspace")).toContainText('"unsaved":true');
  await openUserSettings(page);
  const guard = page.getByRole("dialog", {
    name: "Unsaved changes",
    exact: true,
  });
  await expect(guard).toBeVisible();
  await guard
    .getByRole("button", { name: "Stay on this page", exact: true })
    .click();
  await expect(page).toHaveURL(/\/code\?environment=dev$/);
  await expect(page.locator(".code-workspace")).toContainText('"unsaved":true');
  await page.goBack();
  await expect(page).toHaveURL(/\/flow$/);
  // The code draft is still mounted behind Flow, so Back to the previous document is guarded.
  await page.goBack();
  await expect(guard).toBeVisible();
  await guard
    .getByRole("button", { name: "Stay on this page", exact: true })
    .click();
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  await page.locator(".project-documentation").fill("Unsaved documentation");
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(guard).toBeVisible();
  await guard
    .getByRole("button", { name: "Stay on this page", exact: true })
    .click();
  await expect(page.locator(".project-documentation")).toHaveValue(
    "Unsaved documentation",
  );
  await page
    .getByRole("link", { name: "Instance settings", exact: true })
    .click();
  await guard
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(/\/instance-settings$/);
  await page.goBack();
  await expect(page.locator(".project-documentation")).not.toHaveValue(
    "Unsaved documentation",
  );
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await expect(page.locator(".code-workspace")).not.toContainText(
    '"unsaved":true',
  );
});

test("unknown and inaccessible routes show explicit states and ignore stored external return paths", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    sessionStorage.setItem("duckpad-sign-in-return", "//example.invalid"),
  );
  await page.reload();
  await submitLogin(page);
  await expect(page).toHaveURL(/\/projects$/);
  for (const path of [
    "/missing",
    "/instance-settings/missing",
    "/worktrees/unknown/not-a-tab",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Page not found", exact: true }),
    ).toBeVisible();
  }
  for (const path of [
    "/worktrees/unknown/flow",
    "/projects/unknown/settings",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Page unavailable", exact: true }),
    ).toBeVisible();
  }
  await page.route("**/api/workspace", async (route) => {
    const workspace = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...workspace, user: { ...workspace.user, role: "member" } },
    });
  });
  await page.goto("/instance-settings");
  await expect(
    page.getByRole("heading", { name: "Page unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Author name", { exact: true })).toHaveCount(0);
});
