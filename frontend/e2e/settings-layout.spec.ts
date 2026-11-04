import { expect, test, type Locator, type Page } from "@playwright/test";
import { openInstanceSettings, openUserSettings, signIn } from "./helpers";
import fr from "../src/locales/fr.json" with { type: "json" };

async function beside(first: Locator, second: Locator) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.width);
  expect(Math.abs(b!.y - a!.y)).toBeLessThan(2);
}

async function noPageOverflow(page: Page) {
  for (const target of [page.locator("html"), page.locator(".full-panel")]) {
    expect(
      await target.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
}

test("settings use desktop columns and remain usable on narrow screens in both languages", async ({
  page,
}) => {
  await signIn(page);
  await openUserSettings(page);
  const preferences = page.locator(".settings-card").filter({
    has: page.getByRole("heading", { name: "Preferences", exact: true }),
  });
  const password = page.locator(".settings-card").filter({
    has: page.getByRole("heading", { name: "Change password", exact: true }),
  });
  await beside(preferences, password);
  await noPageOverflow(page);
  await page.screenshot({ path: "test-results/settings-user-desktop.png" });

  await openInstanceSettings(page);
  await expect(page).toHaveURL(/\/instance-settings\/users$/);
  const navigation = page.getByRole("navigation", {
    name: "Instance settings",
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
  const fields = page.locator(".settings-fields > .field");
  await expect(fields).toHaveCount(6);
  await beside(fields.nth(0), fields.nth(1));
  await noPageOverflow(page);
  await page.screenshot({ path: "test-results/settings-instance-desktop.png" });

  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await noPageOverflow(page);
    await expect(
      navigation.getByRole("link", { name: "Extensions", exact: true }),
    ).toBeInViewport();
  }
  const a = await fields.nth(0).boundingBox();
  const b = await fields.nth(1).boundingBox();
  expect(b!.y).toBeGreaterThan(a!.y + a!.height);
  await page
    .getByRole("button", { name: "Save changes", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeInViewport();

  await openUserSettings(page);
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await page.getByLabel(fr.theme, { exact: true }).selectOption("dark");
  await noPageOverflow(page);
  await page.goto("/instance-settings");
  await expect(page).toHaveURL(/\/instance-settings\/users$/);
  await expect(
    page.getByRole("link", { name: fr.usersPermissions, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page
      .getByRole("navigation", { name: fr.instanceSettings, exact: true })
      .getByRole("link"),
  ).toHaveCount(8);
  await noPageOverflow(page);
  await page.getByRole("link", { name: fr.ssoSettings, exact: true }).click();
  await expect(page.getByLabel(fr.ssoEnabled, { exact: true })).toBeVisible();
  await noPageOverflow(page);
  await page.screenshot({ path: "test-results/settings-instance-mobile.png" });
});

test("project controls and extension policies have separate desktop columns", async ({
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
      has: page.getByRole("heading", { name: "Participants", exact: true }),
    });
    const connections = page.locator(".settings-card").filter({
      has: page.getByRole("heading", {
        name: "Authorized connections",
        exact: true,
      }),
    });
    await expect(connections).toBeVisible();
    await beside(participants, connections);
    await noPageOverflow(page);
    await page.screenshot({
      path: "test-results/settings-project-desktop.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await noPageOverflow(page);
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
    await beside(cards.nth(0), cards.nth(1));
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
