import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Snapshot } from "../src/types";

/** A filter reading a SQL node, and a CSV source that accepts uploads. */
async function prepare(page: Page) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Editor drafts" },
    })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  const snapshot = await read();
  const bundle = snapshot.bundle!;
  bundle.templates.rows = `-- @label Rows
-- @output result
SELECT 1 AS amount;`;
  bundle.flow.nodes = [
    { id: "rows", template: "rows", params: {}, position: { x: 0, y: 0 } },
    {
      id: "filtered",
      template: "filter",
      params: { condition: "true" },
      position: { x: 350, y: 0 },
    },
    {
      id: "upload",
      template: "load_csv",
      params: {},
      position: { x: 0, y: 300 },
    },
  ];
  bundle.flow.edges = [
    {
      id: "rows_filtered",
      source: "rows",
      sourceHandle: "result",
      target: "filtered",
      targetHandle: "source",
    },
  ];
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(
    bundle.flow.nodes.length,
  );
  const saved = async (id: string) =>
    (await read()).bundle!.flow.nodes.find((node) => node.id === id);
  return { endpoint, read, saved };
}

const node = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const select = (page: Page, id: string) =>
  node(page, id).locator(".node-shape").click();

/** Answer every save of the worktree with a temporary failure. */
const failSaves = (page: Page, endpoint: string) =>
  page.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          json: { error: "Temporary save failure" },
        })
      : route.continue(),
  );

for (const field of ["Display name", "condition"] as const) {
  test(`navigation waits for the Inspector ${field} autosave without offering discard`, async ({
    page,
  }) => {
    const { endpoint, read, saved } = await prepare(page);
    await select(page, "filtered");
    const before = await read();
    const input = page.locator(".inspector").getByRole("textbox", {
      name: field,
      exact: true,
    });
    const value =
      field === "Display name" ? "Saved on navigation" : "amount > 123456";
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const writes: unknown[] = [];
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      writes.push(route.request().postDataJSON());
      await released;
      await route.continue();
    });
    const guard = page.getByRole("dialog", {
      name: "Unsaved changes",
      exact: true,
    });
    try {
      await input.fill(value);
      await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
      expect((await read()).revision).toBe(before.revision);
      await page.getByRole("link", { name: "Code", exact: true }).click();
      await expect(page.locator(".save-status")).toHaveText("Saving…");
      await expect(page).toHaveURL(/\/flow(\?|$)/);
      await expect(guard).toHaveCount(0);
      expect((await read()).revision).toBe(before.revision);
      // Typing while navigation waits must be included in the save before leaving.
      await input.fill(
        value + (field === "Display name" ? " completely" : " AND true"),
      );
      release();
      await expect(page).toHaveURL(/\/code(\?|$)/);
      await expect(page.locator(".save-status")).toHaveText(
        "All changes saved",
      );
      await expect(guard).toHaveCount(0);
      const node = await saved("filtered");
      expect(
        field === "Display name" ? node?.label : node?.params.condition,
      ).toBe(value + (field === "Display name" ? " completely" : " AND true"));
      expect(writes).toHaveLength(2);
      expect((await read()).revision).not.toBe(before.revision);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

for (const choice of ["Stay on this page", "Discard and leave"] as const) {
  test(`a failed navigation autosave allows ${choice} without committing the draft`, async ({
    page,
  }) => {
    const { endpoint, read } = await prepare(page);
    if (choice === "Discard and leave") {
      await page.getByRole("link", { name: "Code", exact: true }).click();
      await page.getByRole("link", { name: "Flow", exact: true }).click();
    }
    await select(page, "filtered");
    const before = await read();
    const input = page.locator(".inspector").getByRole("textbox", {
      name: "Display name",
      exact: true,
    });
    await failSaves(page, endpoint);
    await input.fill("Keep this draft only if I stay");
    if (choice === "Discard and leave") await page.goBack();
    else await page.getByRole("link", { name: "Code", exact: true }).click();
    const guard = page.getByRole("dialog", {
      name: "Unsaved changes",
      exact: true,
    });
    await expect(guard).toContainText("Temporary save failure");
    await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
    // A discard must not retry the failed edit when the Inspector unmounts.
    await page.unrouteAll({ behavior: "wait" });
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(endpoint) && request.method() === "PUT")
        writes.push(request.url());
    });
    await guard.getByRole("button", { name: choice, exact: true }).click();
    if (choice === "Stay on this page") {
      await expect(page).toHaveURL(/\/flow(\?|$)/);
      await expect(input).toHaveValue("Keep this draft only if I stay");
      await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
    } else {
      await expect(page).toHaveURL(/\/code(\?|$)/);
      await page.getByRole("link", { name: "Flow", exact: true }).click();
      await select(page, "filtered");
      await expect(input).toHaveValue("");
      await expect(page.locator(".save-status")).toHaveText(
        "All changes saved",
      );
    }
    expect(writes).toEqual([]);
    expect((await read()).revision).toBe(before.revision);
    expect((await read()).bundle).toEqual(before.bundle);
  });
}

test("discard does not retry edits typed during a failed navigation save", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  await select(page, "filtered");
  const before = await read();
  const input = page.locator(".inspector").getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await released;
    await route.fulfill({
      status: 503,
      json: { error: "Temporary save failure" },
    });
  });
  try {
    await input.fill("First attempt");
    await page.getByRole("link", { name: "Code", exact: true }).click();
    await expect(page.locator(".save-status")).toHaveText("Saving…");
    await input.fill("Typed while saving");
    release();
    const guard = page.getByRole("dialog", {
      name: "Unsaved changes",
      exact: true,
    });
    await expect(guard).toContainText("Temporary save failure");
    await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
    await page.unrouteAll({ behavior: "wait" });
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(endpoint) && request.method() === "PUT")
        writes.push(request.url());
    });
    await guard
      .getByRole("button", { name: "Discard and leave", exact: true })
      .click();
    await expect(page).toHaveURL(/\/code(\?|$)/);
    expect((await read()).revision).toBe(before.revision);
    expect(writes).toEqual([]);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("browser Back autosaves an Inspector draft that has not blurred", async ({
  page,
}) => {
  const { saved } = await prepare(page);
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await select(page, "filtered");
  await page
    .locator(".inspector")
    .getByRole("textbox", {
      name: "Display name",
      exact: true,
    })
    .fill("Saved by Back");
  await page.goBack();
  await expect(page).toHaveURL(/\/code(\?|$)/);
  expect((await saved("filtered"))?.label).toBe("Saved by Back");
  await expect(
    page.getByRole("dialog", { name: "Unsaved changes", exact: true }),
  ).toHaveCount(0);
});

test("Inspector saves guided expressions and uploads before another node opens", async ({
  page,
}) => {
  const { saved } = await prepare(page);
  // Guided columns come from the materialized input.
  await page.route(
    (url) => url.pathname.endsWith("/input-columns/filtered"),
    (route) =>
      route.fulfill({
        json: {
          inputs: [
            {
              input: "source",
              columns: [{ name: "amount", type: "INTEGER" }],
              origin: "result",
            },
          ],
        },
      }),
  );
  const inspector = page.locator(".inspector");
  await select(page, "filtered");
  await inspector.getByLabel("Column", { exact: true }).selectOption("amount");
  await inspector.getByLabel("Operator", { exact: true }).selectOption(">");
  // The guided form writes the condition, saved when another node opens.
  await inspector.getByLabel("Value", { exact: true }).fill("100");
  await select(page, "upload");
  await expect
    .poll(async () => (await saved("filtered"))?.params.condition)
    .toBe('"amount" > 100');

  await inspector.getByLabel("Upload file", { exact: true }).setInputFiles({
    name: "orders.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("amount\n120\n"),
  });
  await expect(inspector.getByRole("combobox", { name: /^file/ })).toHaveValue(
    /orders\.csv$/,
  );
  await select(page, "filtered");
  await expect
    .poll(async () => (await saved("upload"))?.params.file)
    .toMatch(/orders\.csv$/);
});

test("an Inspector draft that could not be saved guards navigation", async ({
  page,
}) => {
  const { endpoint, saved } = await prepare(page);
  const inspector = page.locator(".inspector");
  const label = inspector.getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await select(page, "filtered");
  await failSaves(page, endpoint);
  await label.fill("Large orders");
  await label.blur();
  await expect(inspector.locator(".notice.error")).toHaveText(
    "Temporary save failure",
  );
  const documentation = page.getByRole("link", {
    name: "Documentation",
    exact: true,
  });
  await documentation.click();
  const guard = page.getByRole("dialog", {
    name: "Unsaved changes",
    exact: true,
  });
  await guard
    .getByRole("button", { name: "Stay on this page", exact: true })
    .click();
  await expect(page).toHaveURL(/\/flow(\?|$)/);
  await expect(label).toHaveValue("Large orders");

  await page.unrouteAll();
  // Leaving the field again retries the save.
  await label.focus();
  await label.blur();
  await expect
    .poll(async () => (await saved("filtered"))?.label)
    .toBe("Large orders");
  await documentation.click();
  await expect(page).toHaveURL(/\/documentation(\?|$)/);
  await expect(guard).toHaveCount(0);
});

test("node documentation saves after a pause, keeps typing through saves and is saved when another node opens", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  const inspector = page.locator(".inspector");
  const notes = inspector.locator(".documentation-editor");
  const documented = async () =>
    (await read()).bundle!.documentation.nodes?.filtered;
  await select(page, "filtered");
  await inspector
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await notes.fill("Keeps paid orders");

  // A collaborator's save reaches the page through polling.
  const remote = await read();
  remote.bundle!.flow.nodes.find((node) => node.id === "rows")!.label =
    "Remote rows";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: remote.revision, bundle: remote.bundle },
      })
    ).ok(),
  ).toBe(true);
  await expect(node(page, "rows")).toContainText("Remote rows");
  await expect(notes).toHaveValue("Keeps paid orders");
  await expect.poll(documented).toBe("Keeps paid orders");

  // Keep typing while the save of a pause is in flight.
  let started!: () => void;
  const saving = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    started();
    await released;
    await route.continue();
  });
  await notes.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" above 100");
  await saving;
  await page.keyboard.type(" daily");
  release();
  await expect.poll(documented).toBe("Keeps paid orders above 100 daily");
  await expect(notes).toHaveValue("Keeps paid orders above 100 daily");
  await expect(page.locator(".save-status")).toHaveText("All changes saved");

  // Opening another node before the pause saves the latest notes.
  await page.keyboard.type(" for review");
  await select(page, "rows");
  await expect
    .poll(documented)
    .toBe("Keeps paid orders above 100 daily for review");
  await select(page, "filtered");
  await inspector
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await expect(notes).toHaveValue(
    "Keeps paid orders above 100 daily for review",
  );
});

test("a node whose deletion fails comes back on the canvas", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  const ids = async () =>
    (await read()).bundle!.flow.nodes.map((node) => node.id);
  await failSaves(page, endpoint);
  await select(page, "upload");
  await page.keyboard.press("Delete");
  await expect(page.getByRole("alert")).toContainText("Temporary save failure");
  await expect(node(page, "upload")).toBeVisible();
  expect(await ids()).toContain("upload");

  await page.unrouteAll();
  await select(page, "upload");
  await page.keyboard.press("Delete");
  await expect(node(page, "upload")).toHaveCount(0);
  await expect.poll(ids).not.toContain("upload");
});

test("a save failure after hiding the Inspector is reported once", async ({
  page,
}) => {
  const { endpoint } = await prepare(page);
  await select(page, "filtered");
  const inspector = page.locator(".inspector");
  let fail!: () => void;
  const released = new Promise<void>((resolve) => {
    fail = resolve;
  });
  let writes = 0;
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    await released;
    await route.fulfill({
      status: 503,
      json: { error: "Late Inspector failure" },
    });
  });
  await inspector
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Pending label");
  await expect.poll(() => writes).toBe(1);
  await inspector.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("#node-inspector")).toBeHidden();
  fail();
  await expect(
    page.getByRole("alert").filter({ hasText: "Late Inspector failure" }),
  ).toHaveCount(1);
});
