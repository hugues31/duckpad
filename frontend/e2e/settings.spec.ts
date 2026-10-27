import { expect, test } from "@playwright/test";
import { openInstanceSettings, openUserSettings, signIn } from "./helpers";

test("instance configuration is available without a project and separate from personal settings", async ({
  page,
}) => {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = await response.json();
    await route.fulfill({
      json: { ...workspace, projects: [], worktrees: [] },
    });
  });
  await signIn(page);
  const original = await (await page.request.get("/api/workspace")).json();
  await openUserSettings(page);
  await expect(
    page.getByRole("heading", { name: "User settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Change password", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Author name", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Active project", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Environments", { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel("Enable single sign-on", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await expect(
    page.getByRole("heading", { name: "Paramètres utilisateur", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByLabel("Langue", { exact: true }).locator(".select-value"),
  ).toHaveText("Français");
  await expect(
    page.getByLabel("Thème", { exact: true }).locator(".select-value"),
  ).toHaveText("Sombre");
  await page.getByLabel("Langue", { exact: true }).selectOption("en");
  await page.reload();
  await openUserSettings(page);
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  await page.getByLabel("Theme", { exact: true }).selectOption("light");

  try {
    await openInstanceSettings(page);
    await expect(
      page.getByRole("heading", { name: "Instance settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Active project", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel("Current password", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Theme", { exact: true })).toHaveCount(0);
    await page
      .getByLabel("Author name", { exact: true })
      .fill("Shared pipeline author");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("All changes saved");
    await openInstanceSettings(page, "Environments");
    await page
      .getByLabel("Environments", { exact: true })
      .fill([...original.catalog.environments, "staging"].join(", "));
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/workspace")).json()).catalog
            .environments,
      )
      .toContain("staging");
    await openInstanceSettings(page, "Connections");
    await page
      .getByRole("button", { name: "New connection", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "staging", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await openInstanceSettings(page, "Users and permissions");
    await expect(
      page.getByLabel("Instance role · admin", { exact: true }),
    ).toHaveValue("admin");
    await expect(
      page.getByText("Instance admins manage all accounts", { exact: false }),
    ).toBeVisible();
    await openInstanceSettings(page, "Single sign-on (OIDC)");
    await expect(
      page.getByLabel("Enable single sign-on", { exact: true }),
    ).toBeVisible();
    await openInstanceSettings(page);
    await expect(page.getByLabel("Author name", { exact: true })).toHaveValue(
      "Shared pipeline author",
    );
    await page.setViewportSize({ width: 800, height: 900 });
    const navigation = page.getByRole("navigation", {
      name: "Instance settings",
      exact: true,
    });
    expect(
      await navigation.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/instance-settings.png",
      fullPage: true,
    });
  } finally {
    await page.request.put("/api/identity", { data: original.identity });
    await page.request.put("/api/environments", {
      data: original.catalog.environments,
    });
  }
});

test("project administrators manage their project and password without instance settings", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const username = `settings-member-${Date.now()}`;
  const password = "settings-member-password";
  const created = await page.request.post("/api/users", {
    data: { username, password, role: "member" },
  });
  expect(created.ok()).toBeTruthy();
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await member.goto("/");
    await member.getByLabel("Username", { exact: true }).fill(username);
    await member.getByLabel("Password", { exact: true }).fill(password);
    await member.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      member.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await expect(
      member.getByRole("link", { name: "Instance settings", exact: true }),
    ).toHaveCount(0);
    await openUserSettings(member);
    await expect(member.getByLabel("Language", { exact: true })).toBeVisible();
    await expect(member.getByLabel("Author name", { exact: true })).toHaveCount(
      0,
    );
    await member.getByLabel("Current password", { exact: true }).fill(password);
    await member
      .getByLabel("New password", { exact: true })
      .fill("updated-settings-password");
    await member
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(
      member.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await member.getByLabel("Username", { exact: true }).fill(username);
    await member
      .getByLabel("Password", { exact: true })
      .fill("updated-settings-password");
    await member.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      member.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    const worktree = await (
      await member.request.post("/api/projects", {
        data: { name: "Scoped project" },
      })
    ).json();
    await member.goto(`/worktrees/${worktree.id}/flow`);
    await member
      .getByRole("link", { name: "Project settings", exact: true })
      .click();
    await expect(
      member.getByRole("heading", { name: "Project settings", exact: true }),
    ).toBeVisible();
    await expect(
      member.getByLabel(`Project role · ${username}`, { exact: true }),
    ).toBeEnabled();
    await expect(
      member.getByRole("button", { name: "Delete project", exact: true }),
    ).toBeVisible();
    await expect(
      member.getByRole("heading", {
        name: "Authorized connections",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      member.getByRole("link", { name: "Instance settings", exact: true }),
    ).toHaveCount(0);
    await expect(member.getByLabel("Branch", { exact: true })).toHaveCount(0);
    await expect(member.getByLabel("Environment", { exact: true })).toHaveCount(
      0,
    );
    expect((await member.request.get("/api/users")).status()).toBe(403);
    expect((await member.request.get("/api/sso")).status()).toBe(403);
    await member.goto("/instance-settings/users");
    await expect(
      member.getByRole("heading", { name: "Page unavailable", exact: true }),
    ).toBeVisible();
    await member.goBack();
    await expect(
      member.getByRole("heading", { name: "Project settings", exact: true }),
    ).toBeVisible();
    await member.getByRole("link", { name: "Pipelines", exact: true }).click();
    await expect(member.getByLabel("Branch", { exact: true })).toBeVisible();
    await expect(
      member.getByRole("button", { name: "Run pipeline", exact: true }),
    ).toBeEnabled();
  } finally {
    await context.close();
  }
});
