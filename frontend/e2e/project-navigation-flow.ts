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
  await expect(navigation.getByRole("link")).toHaveCount(8);
  await expect(
    page.getByRole("button", { name: en.run, exact: true }),
  ).toBeVisible();
  await navigation.getByRole("link", { name: en.jobs, exact: true }).click();
  await expect(
    navigation.getByRole("link", { name: en.jobs, exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: en.jobs, exact: true }),
  ).toBeVisible();
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
  await page
    .getByRole("button", { name: en.partitionSettings, exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: en.partitionSettings,
    exact: true,
  });
  await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("1");
  await editor.getByLabel(en.partitionParallelism).fill("2");
  await editor.getByRole("button", { name: en.save, exact: true }).click();
  await expect(editor).toHaveCount(0);
  const saved = await (await page.request.get(branchEndpoint)).json();
  expect(saved.bundle.flow.partitions.batch.execution.parallelism).toBe(2);
  const main = await (await page.request.get(endpoint)).json();
  expect(main.bundle.flow.partitions.batch.execution?.parallelism ?? 1).toBe(1);
  expect(runs).toBe(0);
  // Switching the branch in settings must keep the section and load its own values.
  await page.getByLabel(en.branch, { exact: true }).selectOption(project.id);
  await page
    .getByRole("button", { name: en.partitionSettings, exact: true })
    .click();
  await expect(editor.getByLabel(en.partitionParallelism)).toHaveValue("1");
  await editor.getByRole("button", { name: en.cancel, exact: true }).click();
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
    translated.getByRole("link", { name: fr.projectSettings, exact: true }),
  ).toBeInViewport();
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({ path: "test-results/project-navigation-mobile.png" });
  await translated.getByRole("link", { name: fr.flow, exact: true }).click();
  await expect(
    page.getByRole("button", { name: fr.run, exact: true }),
  ).toBeInViewport();
  expect(runs).toBe(0);
  return { project, branch };
}
