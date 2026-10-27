import { expect, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };

/** Administrator password of the disposable instance started by scripts/e2e_server.py. */
export const PASSWORD = "duckpad-browser-test";

type LoginLabels = Pick<typeof en, "password" | "signInAction" | "workspace">;

/** Submit the login form shown in the given language and wait for the workspace. */
export async function submitLogin(page: Page, labels: LoginLabels = en) {
  await page.getByLabel(labels.password, { exact: true }).fill(PASSWORD);
  await page
    .getByRole("button", { name: labels.signInAction, exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: labels.workspace, exact: true }),
  ).toBeVisible();
}

export async function signIn(page: Page) {
  await page.goto("/");
  await submitLogin(page);
}

export async function openInstanceSettings(page: Page, section = "General") {
  await page
    .getByRole("button", { name: "Instance settings", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Instance settings", exact: true })
    .getByRole("button", { name: section, exact: true })
    .click();
}

export async function openUserSettings(page: Page) {
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "User settings", exact: true })
    .click();
}
