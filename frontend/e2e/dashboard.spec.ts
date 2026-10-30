import { test, expect, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };
import { submitLogin, openInstanceSettings } from "./helpers";

async function signIn(page: Page) {
  await page.goto("/");
  await submitLogin(page);
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
}

async function createProject(page: Page, name: string) {
  const response = await page.request.post("/api/projects", { data: { name } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("empty dashboard creates and opens a project, then lists it from the Duckpad logo", async ({
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
  await expect(
    page.getByRole("heading", { name: "Your first pipeline starts here." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open example project" }),
  ).toBeEnabled();
  await page.unroute("**/api/workspace");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Name", { exact: true }).fill("Dashboard creation");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByLabel("Active project")).toContainText(
    "Dashboard creation",
  );
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  await expect(
    page.getByRole("link", {
      name: "Open project: Dashboard creation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Active project")).toHaveCount(0);
  await expect(page.getByLabel("Branch", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toHaveCount(0);
});

test("dashboard lists projects once, opens their main branch and supports keyboard navigation", async ({
  page,
}) => {
  await signIn(page);
  const first = await createProject(page, "Dashboard first");
  const second = await createProject(page, "Dashboard second");
  const branch = await page.request.post(
    `/api/worktrees/${first.id}/branches`,
    {
      data: { name: "experiment/dashboard" },
    },
  );
  expect(branch.ok(), await branch.text()).toBeTruthy();
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  const firstCard = page.getByRole("link", {
    name: "Open project: Dashboard first",
    exact: true,
  });
  await expect(firstCard).toHaveCount(1);
  await firstCard.click();
  await expect(page.getByLabel("Active project")).toHaveValue(first.project);
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    first.id,
  );
  await page
    .getByLabel("Branch", { exact: true })
    .selectOption((await branch.json()).id);
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  await firstCard.click();
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    first.id,
  );
  await expect(page.locator(".react-flow")).toBeVisible();
  await openInstanceSettings(page, "Connections");
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  const secondCard = page.getByRole("link", {
    name: "Open project: Dashboard second",
    exact: true,
  });
  await secondCard.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Active project")).toHaveValue(second.project);
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    second.id,
  );
  await page.reload();
  await expect(page.getByLabel("Active project")).toHaveValue(second.project);
  await expect(page.locator(".react-flow")).toBeVisible();
});

test("late snapshots cannot replace the project opened from the dashboard", async ({
  page,
}) => {
  await signIn(page);
  const first = await createProject(page, "Delayed project");
  const second = await createProject(page, "Current project");
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${first.id}`)
  ).json();
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/worktrees/${first.id}`, async (route) => {
    await delayed;
    await route.fulfill({ json: snapshot });
  });
  const pending = page.waitForRequest(`**/api/worktrees/${first.id}`);
  await page
    .getByRole("link", { name: "Open project: Delayed project", exact: true })
    .click();
  const request = await pending;
  // Leaving the project cancels its snapshot read.
  const cancelled = page.waitForEvent(
    "requestfailed",
    (failed) => failed === request,
  );
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  await cancelled;
  await page
    .getByRole("link", { name: "Open project: Current project", exact: true })
    .click();
  await expect(page.getByLabel("Active project")).toHaveValue(second.project);
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeVisible();
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByLabel("Active project")).toHaveValue(second.project);
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    second.id,
  );
});

test("dashboard cards fit on a phone and remain usable in French and dark mode", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const name =
    "Dashboard project with a very long name for the monthly revenue transformation";
  const project = await createProject(page, name);
  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  await page.locator(".account .avatar").click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await page.locator(".account .avatar").click();
  await page.getByRole("menuitemradio", { name: fr.dark, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: fr.projects, exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const card = page.getByRole("link", {
    name: `${fr.openProject}: ${name}`,
    exact: true,
  });
  await card.scrollIntoViewIfNeeded();
  const bounds = await card.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(
    await page
      .locator(".project-dashboard")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy();
  await card.click();
  await expect(page.getByLabel(fr.activeProject)).toHaveValue(project.project);
  await expect(
    page.getByRole("button", { name: fr.run, exact: true }),
  ).toBeVisible();
});
