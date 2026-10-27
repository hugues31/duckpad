import { expect, test, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn } from "./helpers";

async function fixture(page: Page, name: string) {
  const worktree = await (
    await page.request.post("/api/projects", { data: { name } })
  ).json();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree.id}`)
  ).json();
  snapshot.bundle.templates.search_source =
    "-- @label Search source\n-- @output result\nSELECT 1 AS value;";
  const node = (id: string, label: string, x: number) => ({
    id,
    label,
    template: "search_source",
    params: {},
    position: { x, y: 100 },
  });
  snapshot.bundle.flow.nodes = [
    node("first", "Shared label", 0),
    node("distant", "Shared label", 10000),
    {
      id: "east",
      label: "Eastern summary",
      component: "summary",
      params: {},
      position: { x: 500, y: 500 },
    },
    {
      id: "west",
      label: "Western summary",
      component: "summary",
      params: {},
      position: { x: 1000, y: 500 },
    },
  ];
  snapshot.bundle.components.summary = {
    name: "Summary",
    inputs: {},
    outputs: {},
    nodes: [node("metric", "Nested revenue", 5000)],
    edges: [],
  };
  const saved = await page.request.put(`/api/worktrees/${worktree.id}`, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(saved.ok()).toBeTruthy();
  return { worktree, snapshot: await saved.json() };
}

test("canvas search finds labels and IDs, centers distant nodes and never saves or runs", async ({
  page,
}) => {
  await signIn(page);
  const { worktree, snapshot } = await fixture(page, "Canvas search workspace");
  await page.goto(`/worktrees/${worktree.id}/flow`);
  const search = page.getByRole("combobox", {
    name: "Find a node in this canvas…",
  });
  await search.fill(" SHARED ");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await search.press("ArrowDown");
  await search.press("Enter");
  const selected = page.locator('.react-flow__node[data-id="distant"]');
  await expect(selected).toHaveClass(/selected/);
  await expect
    .poll(async () => {
      const node = await selected.boundingBox();
      const frame = await page
        .locator(".canvas-safe-area")
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        });
      return (
        !!node &&
        node.x >= frame.left &&
        node.x + node.width <= frame.right &&
        node.y >= frame.top &&
        node.y + node.height <= frame.bottom
      );
    })
    .toBeTruthy();
  await search.fill("first");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(page.locator('.react-flow__node[data-id="first"]')).toHaveClass(
    /selected/,
  );
  await search.fill("not-a-node");
  await expect(
    page.getByText("No matching results", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  const after = await (
    await page.request.get(`/api/worktrees/${worktree.id}`)
  ).json();
  expect(after.commit).toBe(snapshot.commit);
  expect(after.bundle.flow.nodes).toEqual(snapshot.bundle.flow.nodes);
  expect(
    await (await page.request.get(`/api/runs?worktree=${worktree.id}`)).json(),
  ).toEqual([]);
  await page.evaluate(() => localStorage.setItem("duckpad-language", "fr"));
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: fr.canvasSearch }),
  ).toBeVisible();
});

test("instance search opens another branch and the correct nested instance, including after reload", async ({
  page,
}) => {
  await signIn(page);
  const { worktree } = await fixture(page, "Instance search workspace");
  const branch = await (
    await page.request.post(`/api/worktrees/${worktree.id}/branches`, {
      data: { name: "search-experiment" },
    })
  ).json();
  await page.goto("/projects");
  await page
    .getByRole("button", { name: "Search instance", exact: true })
    .click();
  const search = page.getByRole("combobox", {
    name: "Search instance",
    exact: true,
  });
  await expect(search).toBeFocused();
  await search.fill("search-experiment Western Nested revenue");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/worktrees/${branch.id}/flow.*node=west%3A%3Ametric`),
  );
  await expect(page.locator(".canvas-breadcrumb")).toContainText(
    "Western summary",
  );
  await expect(page.locator('.react-flow__node[data-id="metric"]')).toHaveClass(
    /selected/,
  );
  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="metric"]')).toHaveClass(
    /selected/,
  );
  await page
    .getByRole("combobox", { name: "Find a node in this canvas…" })
    .fill("metric");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Search instance", exact: true })
    .click();
  await search.fill("no-such-search-result");
  await expect(
    page.getByText("No matching results", { exact: true }),
  ).toBeVisible();
  await search.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Search instance", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Search instance", exact: true })
    .click();
  await search.fill("search-experiment");
  await page.getByRole("listbox").getByRole("option").first().click();
  await expect(page.locator(".canvas-breadcrumb")).not.toContainText(
    "Western summary",
  );
  await expect(page.locator('.react-flow__node[data-id="east"]')).toBeVisible();
});

test("reader search excludes private projects and removes results when membership is revoked", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const { worktree } = await fixture(page, "Visible search project");
  await fixture(page, "Confidential search project");
  const username = `search-reader-${Date.now()}`;
  const password = "search-reader-password";
  const user = await (
    await page.request.post("/api/users", { data: { username, password } })
  ).json();
  const endpoint = `/api/projects/${worktree.project}/members/${user.id}`;
  expect(
    (await page.request.put(endpoint, { data: { role: "reader" } })).ok(),
  ).toBeTruthy();
  const context = await browser.newContext();
  try {
    const reader = await context.newPage();
    await reader.goto("/");
    await reader.getByLabel("Username", { exact: true }).fill(username);
    await reader.getByLabel("Password", { exact: true }).fill(password);
    await reader.getByRole("button", { name: "Sign in", exact: true }).click();
    await reader
      .getByRole("button", { name: "Search instance", exact: true })
      .click();
    const search = reader.getByRole("combobox", {
      name: "Search instance",
      exact: true,
    });
    await search.fill("Confidential");
    await expect(
      reader.getByText("No matching results", { exact: true }),
    ).toBeVisible();
    await search.fill("Visible distant");
    await expect(reader.getByRole("listbox").getByRole("option")).toHaveCount(
      1,
    );
    await search.press("Enter");
    await expect(
      reader.locator('.react-flow__node[data-id="distant"]'),
    ).toHaveClass(/selected/);
    await expect(
      reader.getByRole("button", { name: "Run pipeline", exact: true }),
    ).toBeDisabled();
    await reader
      .getByRole("combobox", { name: "Find a node in this canvas…" })
      .fill("first");
    await reader.getByRole("listbox").getByRole("option").click();
    await expect(
      reader.locator('.react-flow__node[data-id="first"]'),
    ).toHaveClass(/selected/);
    await reader
      .getByRole("button", { name: "Search instance", exact: true })
      .click();
    await search.fill("Visible");
    await expect(
      reader.getByRole("listbox").getByRole("option").first(),
    ).toBeVisible();
    expect((await page.request.delete(endpoint)).ok()).toBeTruthy();
    await expect(reader.getByRole("listbox").getByRole("option")).toHaveCount(
      0,
    );
  } finally {
    await context.close();
  }
});

test("instance search handles errors, ignores stale responses and keeps keyboard focus in the dialog", async ({
  page,
}) => {
  await signIn(page);
  const { worktree } = await fixture(page, "Async search project");
  let releaseOld: () => void = () => {};
  const oldReady = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let started: () => void = () => {};
  const oldStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/search?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "error") {
      await route.fulfill({
        status: 503,
        json: { error: "Search temporarily unavailable" },
      });
      return;
    }
    if (q === "old") {
      started();
      await oldReady;
    }
    await route
      .fulfill({
        json: {
          results: [
            {
              kind: "project",
              label: q === "old" ? "Obsolete result" : "Current result",
              project: worktree.project,
              project_name: "Async search project",
              worktree: worktree.id,
              branch: "main",
            },
          ],
          has_more: false,
          incomplete: false,
        },
      })
      .catch(() => {});
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Search instance", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search instance" });
  const search = dialog.getByRole("combobox");
  await search.fill("error");
  await expect(dialog.getByRole("status")).toHaveText(
    "Search temporarily unavailable",
  );
  await search.fill("old");
  await oldStarted;
  await expect(dialog.getByRole("status")).toHaveText("Loading…");
  await search.fill("new");
  await expect(dialog.getByRole("option")).toContainText("Current result");
  releaseOld();
  await expect(dialog.getByRole("option")).not.toContainText("Obsolete result");
  await search.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Clear search", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
