import { expect, test, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn } from "./helpers";

async function createFromDialog(page: Page, endpoint: string) {
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/${endpoint}`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "New project", exact: true })
    .getByRole("button", { name: "Create", exact: true })
    .click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const worktree = await result.json();
  await expect(page.getByLabel("Active project")).toHaveValue(worktree.project);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return worktree;
}

test("new project offers empty and independent example projects from the dashboard and active project", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  const name = dialog.getByLabel("Name", { exact: true });
  await expect(name).toBeFocused();
  const nameBounds = await name.boundingBox();
  const typeBounds = await dialog.getByRole("group").boundingBox();
  expect(nameBounds!.y + nameBounds!.height).toBeLessThan(typeBounds!.y);
  await expect(
    dialog.getByRole("radio", { name: "Empty project" }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Name", { exact: true }).fill("  Blank project  ");
  const blank = await createFromDialog(page, "projects");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const before = await (
    await page.request.get(`/api/worktrees/${blank.id}`)
  ).json();
  expect(before.bundle.flow.nodes).toEqual([]);

  await page.getByRole("button", { name: "New project", exact: true }).click();
  await name.fill("   ");
  await dialog.getByRole("radio", { name: "Start from an example" }).check();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await name.fill("  Revenue lab  ");
  const first = await createFromDialog(page, "example");
  expect(first.project).not.toBe(blank.project);
  await page.reload();
  await expect(page.getByLabel("Active project")).toContainText("Revenue lab");
  const example = await (
    await page.request.get(`/api/worktrees/${first.id}`)
  ).json();
  expect(example.bundle.flow.name).toBe("Revenue lab");
  await expect(
    page.locator(".react-flow__node").filter({
      has: page.getByText("Regional revenue", { exact: true }),
    }),
  ).toBeVisible();
  const runResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/runs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const run = await (await runResponse).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      { timeout: 30000 },
    )
    .toBe("success");

  await page
    .getByRole("link", { name: "Duckpad — Projects", exact: true })
    .click();
  await expect(
    page.getByRole("link", {
      name: "Open project: Blank project",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await name.fill("Second revenue lab");
  await dialog.getByRole("radio", { name: "Start from an example" }).check();
  const second = await createFromDialog(page, "example");
  expect(second.project).not.toBe(first.project);
  const after = await (
    await page.request.get(`/api/worktrees/${blank.id}`)
  ).json();
  expect(after.commit).toBe(before.commit);
  expect(after.bundle.flow.nodes).toEqual([]);
  const workspace = await (await page.request.get("/api/workspace")).json();
  for (const [project, name] of [
    [blank, "Blank project"],
    [first, "Revenue lab"],
    [second, "Second revenue lab"],
  ] as const)
    expect(
      workspace.projects.some(
        (item: { id: string; name: string }) =>
          item.id === project.project && item.name === name,
      ),
    ).toBeTruthy();
});

test("project creation preserves drafts on errors and prevents duplicate submissions", async ({
  page,
}) => {
  await signIn(page);
  let requests = 0;
  let release: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests++;
    await delayed;
    await route.fulfill({
      status: 503,
      json: { error: "Creation unavailable" },
    });
  });
  const opener = page.getByRole("button", { name: "New project", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  const name = dialog.getByLabel("Name", { exact: true });
  await name.fill("Retry project");
  await dialog.getByRole("radio", { name: "Start from an example" }).check();
  await expect(name).toHaveValue("Retry project");
  await dialog.getByRole("radio", { name: "Empty project" }).check();
  await expect(name).toHaveValue("Retry project");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Creating project…", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("radio", { name: "Empty project" }),
  ).toBeDisabled();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole("alert")).toHaveText("Creation unavailable");
  expect(requests).toBe(1);
  await expect(name).toHaveValue("Retry project");
  await page.unroute("**/api/projects");
  await createFromDialog(page, "projects");

  await page.getByRole("button", { name: "New project", exact: true }).click();
  await name.fill("Retry example");
  await dialog.getByRole("radio", { name: "Start from an example" }).check();
  await page.route("**/api/example", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Example unavailable" },
    }),
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Example unavailable");
  await expect(name).toHaveValue("Retry example");
  await expect(
    dialog.getByRole("radio", { name: "Start from an example" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the chooser supports keyboard navigation, French and dark mode on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.locator(".account .avatar").click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await page.locator(".account .avatar").click();
  await page.getByRole("menuitemradio", { name: fr.dark, exact: true }).click();
  const before = await (await page.request.get("/api/workspace")).json();
  const opener = page.getByRole("button", { name: fr.newProject, exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: fr.newProject, exact: true });
  await expect(dialog.getByLabel(fr.name, { exact: true })).toBeFocused();
  await dialog.getByLabel(fr.name, { exact: true }).fill("Mobile revenue lab");
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("radio", { name: fr.emptyProject }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    dialog.getByRole("radio", { name: fr.fromExample }),
  ).toBeChecked();
  await expect(dialog).toContainText(fr.exampleDescription);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBeTruthy();
  await dialog.getByRole("button", { name: fr.create, exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: fr.close, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: fr.create, exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.projects.length).toBe(before.projects.length);
});

test("a downloaded project ZIP imports as a new project and lists what it cannot carry", async ({
  page,
}) => {
  await signIn(page);
  const source = await (
    await page.request.post("/api/example", { data: { name: "Zip source" } })
  ).json();
  const archive = await (
    await page.request.get(`/api/worktrees/${source.id}/archive.zip`)
  ).body();
  await page.reload();
  const before = await (await page.request.get("/api/workspace")).json();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  await dialog.getByRole("radio", { name: "Import a project ZIP" }).check();
  const name = dialog.getByLabel("Name", { exact: true });
  await expect(name).toHaveAttribute("placeholder", "Name from the archive");
  const submit = dialog.getByRole("button", { name: "Import", exact: true });
  await expect(submit).toBeDisabled();
  const file = dialog.getByLabel("Project ZIP", { exact: true });
  await file.setInputFiles({
    name: "notes.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not a zip"),
  });
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Choose a readable ZIP archive of a Duckpad project",
  );
  expect(
    (await (await page.request.get("/api/workspace")).json()).projects,
  ).toHaveLength(before.projects.length);

  await file.setInputFiles({
    name: "zip-source.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects/import") &&
      response.request().method() === "POST",
  );
  await submit.click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const imported = await result.json();
  expect(imported.project).not.toBe(source.project);
  await expect(dialog.getByRole("status")).toContainText("Project imported.");
  await expect(dialog.locator("code")).toHaveText(`sample_${source.project}`);
  const open = dialog.getByRole("button", {
    name: "Open project",
    exact: true,
  });
  await expect(open).toBeFocused();
  await open.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Active project")).toHaveValue(imported.project);
  await expect(page.getByLabel("Active project")).toContainText("Zip source");
  await expect(
    page.locator(".react-flow__node").filter({
      has: page.getByText("Regional revenue", { exact: true }),
    }),
  ).toBeVisible();
  const copy = await (
    await page.request.get(`/api/worktrees/${imported.id}`)
  ).json();
  expect(copy.bundle.flow.name).toBe("Zip source");
  expect(copy.files["README.md"]).toContain("Northstar");

  const blank = await (
    await page.request.post("/api/projects", { data: { name: "Blank zip" } })
  ).json();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await dialog.getByRole("radio", { name: "Import a project ZIP" }).check();
  await name.fill("  Renamed import  ");
  await file.setInputFiles({
    name: "blank.zip",
    mimeType: "application/zip",
    buffer: await (
      await page.request.get(`/api/worktrees/${blank.id}/archive.zip`)
    ).body(),
  });
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Active project")).toContainText(
    "Renamed import",
  );
});
