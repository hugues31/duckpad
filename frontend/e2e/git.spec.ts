import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

async function createProject(page: Page) {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/projects", { data: { name: "Visual Git" } })
  ).json();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  snapshot.bundle.templates = {
    query:
      "-- @label Revenue\n-- @param minimum: number = 0\n-- @output result\nSELECT {{ minimum }} AS revenue;",
  };
  snapshot.bundle.flow.nodes = [
    {
      id: "revenue",
      template: "query",
      label: "Regional revenue",
      params: { minimum: 0 },
      position: { x: 80, y: 80 },
    },
  ];
  const response = await page.request.put(`/api/worktrees/${tree.id}`, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(response.ok()).toBeTruthy();
  await page.evaluate(
    (id) => localStorage.setItem("duckpad-worktree", id),
    tree.id,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Git synchronization", exact: true }),
  ).toBeVisible();
  return tree;
}

async function change(page: Page, id: string, mutate: (bundle: any) => void) {
  const snapshot = await (
    await page.request.get(`/api/worktrees/${id}`)
  ).json();
  mutate(snapshot.bundle);
  const response = await page.request.put(`/api/worktrees/${id}`, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function openGit(page: Page, tab = "Compare versions") {
  await page
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Project Git workspace" });
  await dialog.getByRole("button", { name: tab, exact: true }).first().click();
  return dialog;
}

test("semantic comparison, actual parent, filters, frozen revisions and responsive keyboard navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tree = await createProject(page);
  const before = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  const changed = await change(page, tree.id, (b) => {
    b.flow.nodes[0].position.x += 100;
  });
  const dialog = await openGit(page);
  await dialog.getByLabel("A: reference").fill(before.commit);
  await dialog.getByLabel("B: target").fill(changed.commit);
  await expect(dialog.locator(".change-list")).toContainText(
    "Regional revenue",
  );
  await expect(dialog.locator(".change-list")).toContainText("Canvas layout");
  await dialog.getByText(/Potential impact ·/).click();
  await expect(dialog.locator(".git-impact")).toContainText(
    "No processing or wiring changes",
  );
  await dialog
    .getByLabel("Category", { exact: true })
    .selectOption("processing");
  await expect(dialog.locator(".change-list")).toContainText(
    "No matching changes",
  );
  await dialog.getByLabel("Category", { exact: true }).selectOption("all");
  await dialog.getByRole("button", { name: "Swap A/B" }).click();
  await expect(dialog.getByLabel("A: reference")).toHaveValue(changed.commit);
  await dialog.getByRole("button", { name: "Capture working files" }).click();
  await expect(dialog.locator(".git-revisions")).toContainText("Frozen at");
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && !request.url().includes("logout"))
      writes.push(request.url());
  });
  await dialog.getByLabel("Only changes").uncheck();
  await dialog.getByRole("button", { name: "Focus on change" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
  ).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Git synchronization", exact: true }),
  ).toBeFocused();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await (await page.request.get(`/api/runs?worktree=${tree.id}`)).json(),
  ).toEqual([]);
});

test("review and resolve a field conflict with base evidence, reject stale heads, then integrate", async ({
  page,
}) => {
  const main = await createProject(page);
  const feature = await (
    await page.request.post(`/api/worktrees/${main.id}/branches`, {
      data: { name: "feature/revenue" },
    })
  ).json();
  await change(page, main.id, (b) => {
    b.flow.nodes[0].params.minimum = 10;
  });
  await change(page, feature.id, (b) => {
    b.flow.nodes[0].params.minimum = 20;
  });
  const dialog = await openGit(page, "Branches");
  await dialog
    .getByLabel("Source branch")
    .selectOption("refs/heads/feature/revenue");
  await dialog
    .getByRole("button", { name: "Review merge", exact: true })
    .click();
  await expect(
    dialog.getByText("flow.json/nodes/revenue/params/minimum", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Apply reviewed merge" }),
  ).toBeDisabled();
  await expect(dialog.locator(".git-conflict-values")).toContainText("10");
  await expect(dialog.locator(".git-conflict-values")).toContainText("20");
  await dialog.getByLabel("Incoming", { exact: false }).check();
  await expect(
    dialog.getByRole("button", { name: "Apply reviewed merge" }),
  ).toBeEnabled();
  await change(page, main.id, (b) => {
    b.documentation.project = "Concurrent edit";
  });
  await dialog.getByRole("button", { name: "Apply reviewed merge" }).click();
  await expect(dialog.getByRole("alert")).toContainText("heads changed");
  await dialog.getByRole("button", { name: "Branches", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Review merge", exact: true })
    .click();
  await dialog.getByLabel("Incoming", { exact: false }).check();
  await expect(
    dialog.getByRole("button", { name: "Apply reviewed merge" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply reviewed merge" }).click();
  await expect(dialog).toContainText("Branch merged");
  const result = await (
    await page.request.get(`/api/worktrees/${main.id}`)
  ).json();
  expect(result.bundle.flow.nodes[0].params.minimum).toBe(20);
  const history = await (
    await page.request.get(`/api/worktrees/${main.id}/git/history`)
  ).json();
  expect(history.items[0].parents).toHaveLength(2);
});

test("configure origin, fetch, review first publication, integrate incoming changes and publish", async ({
  page,
}) => {
  const main = await createProject(page);
  const dialog = await openGit(page, "Git synchronization");
  await dialog
    .getByLabel("Repository URL")
    .fill(`https://example.invalid/e2e/${main.id.replaceAll("_", "-")}.git`);
  await dialog.getByLabel("Remote branch", { exact: true }).fill("main");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await dialog.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(dialog).toContainText("Ready for first publication");
  await dialog
    .getByRole("button", { name: "Review publication", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Publish reviewed commit", exact: true })
    .click();
  await expect(dialog.locator(".git-sync-summary")).toContainText("Up to date");
  const incoming = await (
    await page.request.post(`/api/worktrees/${main.id}/branches`, {
      data: { name: "incoming" },
    })
  ).json();
  await change(page, incoming.id, (b) => {
    b.documentation.project = "Incoming documentation";
  });
  let state = await (
    await page.request.get(`/api/worktrees/${incoming.id}/git/remote`)
  ).json();
  state = await (
    await page.request.put(`/api/worktrees/${incoming.id}/git/remote`, {
      data: {
        url: state.url,
        remote_branch: "main",
        config_revision: state.config_revision,
      },
    })
  ).json();
  const pushed = await page.request.post(
    `/api/worktrees/${incoming.id}/git/push`,
    { data: state },
  );
  expect(pushed.ok()).toBeTruthy();
  await dialog.getByRole("button", { name: "Reload state" }).click();
  await dialog.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(dialog.locator(".git-sync-summary")).toContainText("Behind");
  await dialog.getByRole("button", { name: "Review incoming changes" }).click();
  await expect(dialog).toContainText("origin/main → main");
  await dialog.getByRole("button", { name: "Apply reviewed merge" }).click();
  await expect(dialog).toContainText("Branch merged");
  await dialog
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Review publication", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Publish reviewed commit", exact: true })
    .click();
  await expect(dialog.locator(".git-sync-summary")).toContainText("Up to date");
});

test("outdated comparison responses cannot replace the latest selection", async ({
  page,
}) => {
  const main = await createProject(page);
  const first = await (
    await page.request.get(`/api/worktrees/${main.id}`)
  ).json();
  const second = await change(page, main.id, (b) => {
    b.flow.nodes[0].label = "Latest name";
  });
  const dialog = await openGit(page);
  await dialog.getByLabel("A: reference").fill(first.commit);
  await page.route("**/git/compare?**", async (route) => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get("b") === first.commit)
      await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ response }).catch(() => {});
  });
  await dialog.getByLabel("B: target").fill(first.commit);
  await dialog.getByLabel("B: target").fill(second.commit);
  await expect(dialog.locator(".change-list")).toContainText("Latest name");
  await expect(dialog.getByLabel("B: target")).toHaveValue(second.commit);
  await dialog.getByRole("button", { name: "Swap A/B" }).click();
  await expect(dialog.getByLabel("A: reference")).toHaveValue(second.commit);
});
