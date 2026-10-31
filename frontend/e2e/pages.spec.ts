import { expect, test, type Page, type Request } from "@playwright/test";
import { signIn } from "./helpers";

async function createProject(page: Page, name: string) {
  const response = await page.request.post("/api/projects", {
    data: { name: `${name} ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string; project: string };
}

async function createBranch(page: Page, worktree: string, name: string) {
  const response = await page.request.post(
    `/api/worktrees/${worktree}/branches`,
    { data: { name } },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { id: string };
}

/** Templates of a working branch whose label is `label`. */
async function templatesLabeled(page: Page, worktree: string, label: string) {
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  return Object.values(
    snapshot.bundle.templates as Record<string, string>,
  ).filter((text) => text.includes(`@label ${label}`)).length;
}

test("project settings keep the open branch for Pipelines and stop polling it", async ({
  page,
}) => {
  await signIn(page);
  const project = await createProject(page, "Settings return");
  const branch = await createBranch(page, project.id, "feature/settings");
  await page.goto(`/worktrees/${branch.id}/flow`);
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    branch.id,
  );
  await page
    .getByRole("link", { name: "Project settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Project settings", exact: true }),
  ).toBeVisible();
  const reads: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/api\/worktrees\/[^/]+(\/status)?$/.test(pathname))
      reads.push(pathname);
  });
  // The pipeline snapshot used to be read every second on this page.
  await page.waitForTimeout(2500);
  expect(reads).toEqual([]);
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/worktrees/${branch.id}/flow`));
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue(
    branch.id,
  );
});

test("the library imports a single copy into the branch it was opened on", async ({
  page,
}) => {
  await signIn(page);
  const label = `Library probe ${Date.now()}`;
  const source = await createProject(page, "Library source");
  const snapshot = await (
    await page.request.get(`/api/worktrees/${source.id}`)
  ).json();
  const files = {
    ...snapshot.files,
    "templates/library_probe.sql": `-- @label ${label}\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n`,
  };
  expect(
    (
      await page.request.put(`/api/worktrees/${source.id}`, {
        data: { revision: snapshot.revision, files },
      })
    ).ok(),
  ).toBeTruthy();
  const target = await createProject(page, "Library target");
  const branch = await createBranch(page, target.id, "feature/library");
  const library = page.getByRole("button", {
    name: "Import from a project",
    exact: true,
  });
  const dialog = page.getByRole("dialog", {
    name: "Import from a project",
    exact: true,
  });

  // Leave the main branch while its library is loading.
  await page.goto(`/worktrees/${branch.id}/flow`);
  await page.getByLabel("Branch", { exact: true }).selectOption(target.id);
  await expect(page).toHaveURL(new RegExp(`/worktrees/${target.id}/flow`));
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/library", async (route) => {
    await loaded;
    // The request is canceled when the dialog closes first.
    await route.continue().catch(() => undefined);
  });
  const settled = new Promise<void>((resolve) => {
    const done = (request: Request) => {
      if (request.url().endsWith("/api/library")) resolve();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  });
  await library.click();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/worktrees/${branch.id}/flow`));
  release();
  await settled;
  await page.waitForTimeout(500);
  await expect(dialog).toHaveCount(0);
  await page.unroute("**/api/library");

  const imports: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/import"))
      imports.push(new URL(request.url()).pathname);
  });
  await library.click();
  const item = dialog.locator(".history-row").filter({ hasText: label });
  await item
    .getByRole("button", { name: "Import independent copy" })
    .dblclick();
  await expect(page.locator(".toast")).toContainText(
    "Independent copy imported",
  );
  await page.waitForTimeout(500);
  expect(imports).toEqual([`/api/worktrees/${branch.id}/import`]);
  expect(await templatesLabeled(page, branch.id, label)).toBe(1);
  expect(await templatesLabeled(page, target.id, label)).toBe(0);
});

test("a failed save is reported once, and a failed reload does not fail a save", async ({
  page,
}) => {
  await signIn(page);
  const project = await createProject(page, "Save reports");
  await page.goto(`/worktrees/${project.id}/flow`);
  const endpoint = `**/api/worktrees/${project.id}`;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 503,
        json: { error: "Simulated save failure" },
      });
    else await route.continue();
  });
  await page
    .getByRole("button", { name: "New SQL template", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New SQL template",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".notice.error")).toHaveText(
    "Simulated save failure",
  );
  // Checked once: a toast would already be shown, and disappears later.
  expect(await page.locator(".toast").count()).toBe(0);
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page.unroute(endpoint);

  // Reading the saved state fails until the save is reported.
  let saved = false;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === "PUT") {
      await route.continue();
      saved = true;
    } else if (saved)
      await route.fulfill({ status: 500, json: { error: "Unavailable" } });
    else await route.continue();
  });
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  const panel = page.locator(".documentation-page");
  await panel.locator(".project-documentation").fill("Saved despite reads");
  await panel
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(panel).toContainText("All changes saved");
  expect(await page.locator(".toast").count()).toBe(0);
  await page.unroute(endpoint);
  const snapshot = await (
    await page.request.get(`/api/worktrees/${project.id}`)
  ).json();
  expect(snapshot.bundle.documentation.project).toBe("Saved despite reads");
});

/** Open the example project with its results in the dev environment. */
async function openRunExample(page: Page) {
  await signIn(page);
  const example = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const launched = await (
    await page.request.post(`/api/worktrees/${example.id}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${launched.id}`)).json())
          .status,
      { timeout: 30000 },
    )
    .toBe("success");
  await page.goto(`/worktrees/${example.id}/flow?environment=dev`);
  const node = page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) });
  // Results loaded later would legitimately refresh the preview.
  await expect(node.locator(".node-status.valid")).toBeVisible();
  return { worktree: example.id as string, node };
}

test("the data preview and the Inspector share one load of the node", async ({
  page,
}) => {
  const { worktree, node } = await openRunExample(page);
  const nodeId = await node.getAttribute("data-id");
  const loads: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname ===
      `/api/worktrees/${worktree}/preview/${nodeId}`
    )
      loads.push(request.url());
  });
  await node.click();
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  const inspector = page.locator(".inspector");
  await inspector.getByRole("button", { name: "SQL", exact: true }).click();
  await inspector
    .getByRole("button", { name: "Displayed result", exact: true })
    .click();
  await expect(inspector).toContainText(/Commit [0-9a-f]{8}/);
  await page.waitForTimeout(1000);
  expect(loads).toHaveLength(1);
});

test("the results search covers every column and headers sort the sample", async ({
  page,
}) => {
  const { node } = await openRunExample(page);
  await node.click();
  const preview = page.locator(".preview-panel");
  const first = preview.locator(".data-table th button span").first();
  const column = (await first.textContent())!;
  const searched = page.waitForRequest((request) => {
    const { pathname, searchParams } = new URL(request.url());
    return (
      pathname.includes("/preview/") &&
      searchParams.get("search") === "no-such-value"
    );
  });
  await preview
    .getByLabel("Search all columns…", { exact: true })
    .fill("no-such-value");
  await searched;
  await expect(preview.locator(".empty-small")).toBeVisible();
  await preview.getByTitle("Clear", { exact: true }).click();
  await expect(preview.locator(".empty-small")).toHaveCount(0);
  await first.click();
  await expect(first).toHaveText(`${column} ↑`);
  await expect(preview.locator(".sample-chip")).toHaveText(`${column} ↑`);
});
