import { expect, test, type Page } from "@playwright/test";
import {
  deferred,
  openInstanceSettings,
  openUserSettings,
  signIn,
} from "./helpers";
import fr from "../src/locales/fr.json" with { type: "json" };

async function noPageOverflow(page: Page) {
  for (const target of [page.locator("html"), page.locator(".full-panel")]) {
    expect(
      await target.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
}

test("project settings keep their heading and navigation steady while sections load", async ({
  page,
}) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Stable project settings" },
  });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  const settingsPath = `/api/projects/${project.project}/settings`;
  const panel = page.getByRole("region", {
    name: "Project settings",
    exact: true,
  });
  const heading = panel.locator(".settings-heading");
  const navigation = panel.getByRole("navigation", {
    name: "Settings sections",
    exact: true,
  });
  try {
    await page.goto(`/projects/${project.project}/settings`);
    await expect(heading.locator(".access-badge")).toBeVisible();
    for (const width of [1512, 800, 390]) {
      await page.setViewportSize({ width, height: 982 });
      for (const section of [
        "Connections",
        "Python execution",
        "Partitions",
        "Extensions",
        "General",
        "Users",
      ]) {
        const before = {
          text: await heading.innerText(),
          bounds: await navigation.boundingBox(),
        };
        const release = deferred();
        await page.route(`**${settingsPath}`, async (route) => {
          await release.promise;
          await route.continue();
        });
        const request = page.waitForRequest(
          (request) => new URL(request.url()).pathname === settingsPath,
        );
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === settingsPath,
        );
        try {
          const link = navigation.getByRole("link", {
            name: section,
            exact: true,
          });
          await link.click();
          await request;
          await expect(link).toHaveAttribute("aria-current", "page");
          expect(await heading.innerText()).toBe(before.text);
          expect(await navigation.boundingBox()).toEqual(before.bounds);
        } finally {
          release.resolve();
          await response;
          await page.unroute(`**${settingsPath}`);
        }
        await expect(heading.locator(".access-badge")).toBeVisible();
        expect(await navigation.boundingBox()).toEqual(before.bounds);
        await noPageOverflow(page);
      }
    }
  } finally {
    await page.request.delete(`/api/projects/${project.project}`);
  }
});

test("settings remain usable on narrow screens in both languages", async ({
  page,
}) => {
  await signIn(page);
  await openInstanceSettings(page);
  await expect(page).toHaveURL(/\/instance-settings\/users$/);
  const navigation = page.getByRole("navigation", {
    name: "Settings sections",
    exact: true,
  });
  await expect(
    navigation.getByRole("link", { name: "General", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", {
      name: "Users and permissions",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
  await navigation
    .getByRole("link", { name: "Single sign-on (OIDC)", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/instance-settings\/sso$/);
  await expect(
    page.getByLabel("Enable single sign-on", { exact: true }),
  ).toBeVisible();
  await noPageOverflow(page);

  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await noPageOverflow(page);
    await expect(
      navigation.getByRole("link", { name: "Extensions", exact: true }),
    ).toBeInViewport();
  }
  await page
    .getByRole("button", { name: "Save changes", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeInViewport();

  await openUserSettings(page);
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await noPageOverflow(page);
  const userNavigation = page.getByRole("navigation", {
    name: fr.settingsSections,
    exact: true,
  });
  await expect(userNavigation.getByRole("link")).toHaveCount(4);
  await userNavigation
    .getByRole("link", { name: fr.password, exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/user-settings\/password$/);
  await expect(
    page.getByLabel(fr.currentPassword, { exact: true }),
  ).toBeVisible();
  await noPageOverflow(page);
  await page.reload();
  await expect(
    userNavigation.getByRole("link", { name: fr.password, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page.getByLabel(fr.language, { exact: true })).toBeVisible();
  for (const label of [fr.sshKey, fr.apiTokens]) {
    await userNavigation
      .getByRole("link", { name: label, exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: label, exact: true }),
    ).toBeVisible();
    await noPageOverflow(page);
  }
  await page.goto("/instance-settings");
  await expect(page).toHaveURL(/\/instance-settings\/users$/);
  await expect(
    page.getByRole("link", { name: fr.usersPermissions, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await noPageOverflow(page);
  await page.getByRole("link", { name: fr.ssoSettings, exact: true }).click();
  await expect(page.getByLabel(fr.ssoEnabled, { exact: true })).toBeVisible();
  await noPageOverflow(page);
});

test("project and extension settings use sections and fit narrow screens", async ({
  page,
}) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Settings layout" },
  });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  try {
    await page.goto(`/projects/${project.project}/settings`);
    const participants = page.locator(".settings-card").filter({
      has: page.getByRole("heading", { name: "Users", exact: true }),
    });
    const connections = page.locator(".settings-card").filter({
      has: page.getByRole("heading", {
        name: "Authorized connections",
        exact: true,
      }),
    });
    await expect(participants).toBeVisible();
    const navigation = page.getByRole("navigation", {
      name: "Settings sections",
      exact: true,
    });
    await navigation
      .getByRole("link", { name: "Connections", exact: true })
      .click();
    await expect(connections).toBeVisible();
    await noPageOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await noPageOverflow(page);
    await navigation
      .getByRole("link", { name: "General", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Delete project", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 1512, height: 982 });
    await openInstanceSettings(page, "Extensions");
    const cards = page
      .getByRole("region", { name: "DuckDB extensions", exact: true })
      .locator(".settings-card");
    await expect(
      cards.nth(1).getByRole("checkbox", {
        name: "Allow unsigned extensions",
        exact: true,
      }),
    ).toBeVisible();
    await noPageOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await noPageOverflow(page);
  } finally {
    await page.request.delete(`/api/projects/${project.project}`);
  }
});
