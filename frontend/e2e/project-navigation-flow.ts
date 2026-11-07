import { expect, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };
import { openUserSettings } from "./helpers";
import { partitionFlow } from "./partitions-flow";

/** Exercise project navigation against a local instance or a deployed preview. */
export async function projectNavigationFlow(page: Page) {
  const created = await page.request.post("/api/projects", {
    data: { name: "Project navigation " + Date.now() },
  });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  const endpoint = "/api/worktrees/" + project.id;
  const snapshot = await (await page.request.get(endpoint)).json();
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: partitionFlow },
      })
    ).ok(),
  ).toBeTruthy();
  const branch = await (
    await page.request.post(endpoint + "/branches", {
      data: { name: "feature/navigation" },
    })
  ).json();
  const branchEndpoint = "/api/worktrees/" + branch.id;
  let runs = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/runs")) runs++;
  });
  await page.goto("/worktrees/" + branch.id + "/flow?environment=prod");
  const navigation = page.getByRole("navigation", {
    name: en.projectNavigation,
  });
  await expect(navigation.getByRole("link")).toHaveCount(7);
  const toolbar = page.locator(".flow-toolbar");
  // The new branch also offers its first run in the missing-results notice.
  await expect(
    toolbar.getByRole("button", { name: en.run, exact: true }),
  ).toBeVisible();
  // Opening a page focuses its toolbar for keyboard users, without a focus ring.
  await expect(toolbar).toBeFocused();
  await expect(toolbar).toHaveCSS("outline-style", "none");
  await navigation.getByRole("link", { name: en.jobs, exact: true }).click();
  await expect(
    navigation.getByRole("link", { name: en.jobs, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // Route focus goes to the page heading, not to the shared tab bar.
  await expect(
    page.getByRole("heading", { name: en.jobs, exact: true }),
  ).toBeFocused();
  await navigation
    .getByRole("link", { name: en.projectSettings, exact: true })
    .click();
  await page
    .getByRole("navigation", { name: en.settingsSections })
    .getByRole("link", { name: en.partitions, exact: true })
    .click();
  await expect(
    navigation.getByRole("link", { name: en.projectSettings, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel(en.branch, { exact: true })).toHaveValue(
    branch.id,
  );
  await expect(page.getByLabel(en.environment, { exact: true })).toHaveValue(
    "prod",
  );
  await page.reload();
  await expect(page.getByLabel(en.branch, { exact: true })).toHaveValue(
    branch.id,
  );
  const heading = page.getByRole("heading", {
    name: en.projectSettings,
    exact: true,
  });
  await expect(heading).toBeFocused();
  await expect(heading).toHaveCSS("outline-style", "none");
  const editor = page.getByRole("form", {
    name: en.partitionSettings,
    exact: true,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: en.partitionSettings, exact: true }),
  ).toHaveCount(0);
  await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("1");
  await editor.getByLabel(en.partitionParallelism).fill("3");
  const guard = page.getByRole("dialog", {
    name: en.unsavedChanges,
    exact: true,
  });
  for (const leave of [
    () => navigation.getByRole("link", { name: en.jobs, exact: true }).click(),
    () => page.getByLabel(en.branch, { exact: true }).selectOption(project.id),
    () => page.getByLabel(en.environment, { exact: true }).selectOption("dev"),
  ]) {
    await leave();
    await expect(guard).toBeVisible();
    await guard
      .getByRole("button", { name: en.stayOnPage, exact: true })
      .click();
    await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("3");
    await expect(page.getByLabel(en.branch, { exact: true })).toHaveValue(
      branch.id,
    );
  }
  await editor
    .getByRole("button", { name: en.discardChanges, exact: true })
    .click();
  await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("1");
  await editor.getByLabel(en.partitionParallelism).fill("2");
  await page.route("**/api/worktrees/" + branch.id, (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({
      status: 409,
      json: { error: "Partition revision changed" },
    });
  });
  await editor.getByRole("button", { name: en.save, exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText(
    "Partition revision changed",
  );
  await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("2");
  await page.unroute("**/api/worktrees/" + branch.id);
  await editor.getByRole("button", { name: en.save, exact: true }).click();
  await expect(
    editor.getByRole("button", { name: en.save, exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByText(en.unsavedChanges, { exact: true }),
  ).toHaveCount(0);
  await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("2");
  const saved = await (await page.request.get(branchEndpoint)).json();
  expect(saved.bundle.flow.partitions.batch.execution.parallelism).toBe(2);
  const main = await (await page.request.get(endpoint)).json();
  expect(main.bundle.flow.partitions.batch.execution?.parallelism ?? 1).toBe(1);
  expect(runs).toBe(0);
  await page.screenshot({ path: "test-results/partition-settings-inline.png" });
  // Switching the branch in settings must keep the section and load its own values.
  await page.getByLabel(en.branch, { exact: true }).selectOption(project.id);
  await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("1");
  await page.getByLabel(en.branch, { exact: true }).selectOption(branch.id);
  await navigation.getByRole("link", { name: en.flow, exact: true }).click();
  await expect(page.getByLabel(en.branch, { exact: true })).toHaveValue(
    branch.id,
  );
  await expect(page.getByLabel(en.environment, { exact: true })).toHaveValue(
    "prod",
  );
  await navigation.getByRole("link", { name: en.jobs, exact: true }).click();
  await page.goBack();
  await expect(
    navigation.getByRole("link", { name: en.flow, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(runs).toBe(0);
  await page.screenshot({
    path: "test-results/project-navigation-desktop.png",
  });
  // Long translated labels stay reachable without overflowing the page.
  await openUserSettings(page);
  await page.getByLabel(en.language, { exact: true }).selectOption("fr");
  await page.goto("/worktrees/" + branch.id + "/flow?environment=prod");
  await page.setViewportSize({ width: 390, height: 844 });
  const translated = page.getByRole("navigation", {
    name: fr.projectNavigation,
  });
  await translated
    .getByRole("link", { name: fr.projectSettings, exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: fr.settingsSections })
      .getByRole("link", { name: fr.participants, exact: true }),
  ).toBeVisible();
  await expect(
    translated.getByRole("link", { name: fr.projectSettings, exact: true }),
  ).toBeInViewport();
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({ path: "test-results/project-navigation-mobile.png" });
  await page
    .getByRole("navigation", { name: fr.settingsSections })
    .getByRole("link", { name: fr.partitions, exact: true })
    .click();
  await expect(
    page
      .getByRole("form", { name: fr.partitionSettings })
      .getByLabel(fr.partitionDimension),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: "test-results/partition-settings-inline-mobile.png",
  });
  await translated.getByRole("link", { name: fr.flow, exact: true }).click();
  await expect(
    page
      .locator(".flow-toolbar")
      .getByRole("button", { name: fr.run, exact: true }),
  ).toBeInViewport();
  expect(runs).toBe(0);
  return { project, branch };
}
