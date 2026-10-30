import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };

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
  await page.goto(`/worktrees/${tree.id}/flow`);
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

for (const language of ["en", "fr"] as const) {
  test(`invalid branch names explain how to recover in ${language}`, async ({
    page,
  }) => {
    const tree = await createProject(page);
    if (language === "fr") {
      await page.evaluate(() => localStorage.setItem("duckpad-language", "fr"));
      await page.reload();
    }
    const labels = language === "fr" ? fr : en;
    await page.getByTitle(labels.newBranch, { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: labels.newBranch });
    const name = dialog.getByLabel(labels.branchName, { exact: true });
    await expect(name).toHaveValue("");
    await expect(name).toHaveAttribute("placeholder", "experiment/my-change");
    await expect(dialog).toContainText(labels.branchNameHint);
    await name.fill("experiment/");
    await dialog
      .getByRole("button", { name: labels.create, exact: true })
      .click();
    await expect(dialog.locator(".notice.error")).toHaveText(
      labels.invalidBranchName,
    );
    await expect(name).toHaveValue("experiment/");
    const workspace = await (await page.request.get("/api/workspace")).json();
    expect(
      workspace.worktrees.filter((w: any) => w.project === tree.project),
    ).toHaveLength(1);
    await name.fill("experiment/my-change");
    await dialog
      .getByRole("button", { name: labels.create, exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const after = await (await page.request.get("/api/workspace")).json();
    const branch = after.worktrees.find(
      (w: any) =>
        w.project === tree.project && w.branch === "experiment/my-change",
    );
    expect(branch).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`/worktrees/${branch.id}/flow`));
  });
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
  // The new review replaces the previous one and starts without a choice.
  await expect(
    dialog.getByLabel("Incoming", { exact: false }),
  ).not.toBeChecked();
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
  await dialog
    .getByRole("button", { name: "Compare versions", exact: true })
    .first()
    .click();
  await dialog.getByLabel("B: target").fill(history.items[0].commit);
  await dialog
    .getByLabel("Actual Git parent")
    .selectOption(history.items[0].parents[1]);
  await expect(dialog.getByLabel("A: reference")).toHaveValue(
    history.items[0].parents[1],
  );
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
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Git synchronization", exact: true }),
  ).toContainText("0 ↑ / 0 ↓");
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

test("SQL inspection is read-only in French and dark theme", async ({
  page,
}) => {
  const main = await createProject(page);
  const before = await (
    await page.request.get(`/api/worktrees/${main.id}`)
  ).json();
  const after = await change(page, main.id, (bundle) => {
    bundle.templates.query += "\n-- Updated SQL definition";
  });
  await page.locator(".account .avatar").click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await page.locator(".account .avatar").click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await page
    .getByRole("button", { name: fr.gitSynchronization, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: fr.gitWorkspace });
  await dialog
    .getByRole("button", { name: fr.compareVersions, exact: true })
    .click();
  await dialog.getByLabel(fr.referenceA).fill(before.commit);
  await dialog.getByLabel(fr.targetB).fill(after.commit);
  await expect(dialog.locator(".monaco-diff-editor")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(dialog.locator(".change-list")).toContainText(fr.processing);
  await expect(dialog.locator(".git-impact")).toContainText(fr.analysisPartial);
  const firstEditor = dialog.locator(".monaco-editor textarea").first();
  await firstEditor.focus();
  await page.keyboard.type("not an edit");
  const current = await (
    await page.request.get(`/api/worktrees/${main.id}`)
  ).json();
  expect(current.commit).toBe(after.commit);
  expect(current.files).toEqual(after.files);
});

test("reopening resolves the chosen names again after the branch moves", async ({
  page,
}) => {
  const main = await createProject(page);
  await page.request.post(`/api/worktrees/${main.id}/branches`, {
    data: { name: "feature/moving" },
  });
  const feature = (
    await (await page.request.get("/api/workspace")).json()
  ).worktrees.find((w: any) => w.branch === "feature/moving");
  // A frozen state stored by an earlier version would have expired with the server.
  await page.evaluate(
    (key) =>
      sessionStorage.setItem(
        key,
        JSON.stringify({ a: "frozen_expired", b: "frozen_expired" }),
      ),
    `duckpad.git.${main.id}`,
  );
  const compared: string[][] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/git/compare"))
      compared.push([url.searchParams.get("a")!, url.searchParams.get("b")!]);
  });
  let dialog = await openGit(page);
  await expect(dialog.getByLabel("A: reference")).toHaveValue("HEAD");
  await expect(dialog.getByLabel("B: target")).toHaveValue("working");
  await expect(dialog.locator(".change-list")).toBeVisible();
  await dialog.getByLabel("A: reference").fill("working");
  await dialog.getByLabel("B: target").fill("refs/heads/feature/moving");
  const sides = dialog.locator(".git-revisions small");
  await expect(sides.first()).toContainText("Frozen at");
  await expect(sides.last()).toContainText("refs/heads/feature/moving");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const moved = await change(page, feature.id, (b) => {
    b.flow.nodes[0].label = "Moved feature";
  });
  compared.length = 0;
  dialog = await openGit(page);
  await expect(dialog.getByLabel("A: reference")).toHaveValue("working");
  await expect(dialog.getByLabel("B: target")).toHaveValue(
    "refs/heads/feature/moving",
  );
  await expect(dialog.locator(".change-list")).toContainText("Moved feature");
  await expect(dialog.locator(".git-revisions")).toContainText(
    moved.commit.slice(0, 12),
  );
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(compared).toEqual([["working", "refs/heads/feature/moving"]]);
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
  ).not.toMatch(/frozen_(?!expired)|[0-9a-f]{40}/);
});

test("a reference chosen after opening a commit survives history filtering", async ({
  page,
}) => {
  const main = await createProject(page);
  const first = await (
    await page.request.get(`/api/worktrees/${main.id}`)
  ).json();
  const second = await change(page, main.id, (b) => {
    b.flow.nodes[0].label = "Renamed revenue";
  });
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Git history", exact: true }).click();
  await page
    .locator(".history-row")
    .filter({ hasText: second.commit.slice(0, 8) })
    .getByRole("button", { name: "Changes", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Project Git workspace" });
  await expect(dialog.getByLabel("A: reference")).toHaveValue(first.commit);
  await expect(dialog.getByLabel("B: target")).toHaveValue(second.commit);
  await dialog.getByLabel("A: reference").fill("empty");
  await expect(dialog.locator(".change-list")).toContainText("Renamed revenue");
  const filtered = page.waitForResponse(
    (response) =>
      response.url().includes("/git/history?") &&
      new URL(response.url()).searchParams.get("entity") === "revenue",
  );
  await dialog.locator(".git-history summary").click();
  await dialog.getByLabel("History element").fill("revenue");
  await filtered;
  await expect(dialog.locator(".git-history")).toContainText("Renamed revenue");
  await expect(dialog.getByLabel("A: reference")).toHaveValue("empty");
});

test("a failed history page keeps the comparison and Retry loads that page again", async ({
  page,
}) => {
  const main = await createProject(page);
  const first = await (
    await page.request.get(`/api/worktrees/${main.id}`)
  ).json();
  const second = await change(page, main.id, (b) => {
    b.flow.nodes[0].label = "Latest name";
  });
  const history = await (
    await page.request.get(`/api/worktrees/${main.id}/git/history`)
  ).json();
  expect(history.items.length).toBeGreaterThan(1);
  const pages: string[] = [];
  await page.route(
    `**/api/worktrees/${main.id}/git/history*`,
    async (route) => {
      const offset = new URL(route.request().url()).searchParams.get("offset");
      pages.push(offset ?? "first");
      if (offset === null)
        await route.fulfill({
          json: { ...history, items: history.items.slice(0, 1), next: 1 },
        });
      else if (pages.filter((value) => value !== "first").length === 1)
        await route.fulfill({
          status: 503,
          json: { error: "History temporarily unavailable" },
        });
      else await route.continue();
    },
  );
  const dialog = await openGit(page);
  await dialog.getByLabel("A: reference").fill(first.commit);
  await dialog.getByLabel("B: target").fill(second.commit);
  await expect(dialog.locator(".change-list")).toContainText("Latest name");
  const panel = dialog.locator(".git-history");
  await panel.locator("summary").click();
  await expect(panel.locator(".git-commit")).toHaveCount(1);
  await panel.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "History temporarily unavailable",
  );
  await expect(dialog.locator(".change-list")).toContainText("Latest name");
  await expect(dialog.getByRole("alert")).toHaveCount(1);
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel.locator(".git-commit")).toHaveCount(history.items.length);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(pages).toEqual(["first", "1", "1"]);
  await expect(dialog.locator(".change-list")).toContainText("Latest name");
});

test("closing the dialog during an action neither navigates nor closes the next dialog", async ({
  page,
}) => {
  const main = await createProject(page);
  await page.request.post(`/api/worktrees/${main.id}/branches`, {
    data: { name: "feature/late" },
  });
  let hold = false;
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const holding = new Promise<void>((resolve) => (started = resolve));
  await page.route(
    `**/api/worktrees/${main.id}/git/branches`,
    async (route) => {
      if (!hold) return route.continue();
      hold = false;
      started();
      await released;
      await route.continue().catch(() => {});
    },
  );
  const dialog = await openGit(page, "Branches");
  hold = true;
  await dialog
    .locator(".git-commit")
    .filter({ hasText: "feature/late" })
    .getByRole("button", { name: "Open isolated worktree", exact: true })
    .click();
  await holding;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByTitle("New working branch", { exact: true }).click();
  const next = page.getByRole("dialog", { name: "New working branch" });
  await expect(next).toBeVisible();
  const settled = page.waitForResponse((response) =>
    response.url().endsWith(`/worktrees/${main.id}/git/branches`),
  );
  release();
  await (await settled).finished();
  // Let the late action finish before checking that it changed nothing.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  await expect(next).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/worktrees/${main.id}/flow`));
});

test("the branches tab creates branches with the shared branch dialog", async ({
  page,
}) => {
  const main = await createProject(page);
  await page
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Project Git workspace" });
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  await dialog.getByRole("button", { name: "Branches", exact: true }).click();
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "New working branch", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await dialog
    .getByRole("button", { name: "New working branch", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const create = page.getByRole("dialog", { name: "New working branch" });
  const name = create.getByLabel("Branch name", { exact: true });
  await expect(name).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(create).toBeHidden();
  const opener = page.getByRole("button", {
    name: "Git synchronization",
    exact: true,
  });
  await expect(opener).toBeFocused();
  await openGit(page, "Branches");
  await dialog
    .getByRole("button", { name: "New working branch", exact: true })
    .click();
  await name.fill("experiment/");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create.getByRole("alert")).toHaveText(en.invalidBranchName);
  await name.fill("experiment/from-git");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toBeHidden();
  await expect(page.locator(".toast")).toContainText(en.branchCreated);
  const workspace = await (await page.request.get("/api/workspace")).json();
  const branch = workspace.worktrees.find(
    (w: any) =>
      w.project === main.project && w.branch === "experiment/from-git",
  );
  expect(branch).toBeTruthy();
  await expect(page).toHaveURL(new RegExp(`/worktrees/${branch.id}/flow`));
});

test("the synchronization button reports a failed status check and retries it", async ({
  page,
}) => {
  await page.route("**/git/remote", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Remote status temporarily unavailable" },
    }),
  );
  await createProject(page);
  // The dialog opened below has a tab with the same name.
  const button = page.locator(".git-status-button");
  await expect(button).toHaveAttribute(
    "title",
    /Status unavailable: Remote status temporarily unavailable/,
  );
  await page.unroute("**/git/remote");
  await button.click();
  await expect(button).toHaveAttribute("title", /· Disconnected ·/);
  await expect(
    page.getByRole("dialog", { name: "Project Git workspace" }),
  ).toBeVisible();
});
