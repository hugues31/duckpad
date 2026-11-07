import { test, expect, type Page } from "@playwright/test";
import { autosaved, closeCode, codePanel, openCode, signIn } from "./helpers";
import type { Snapshot } from "../src/types";

const DOUBLED = `-- @label Doubled
-- @input source
-- @output result
SELECT amount * 2 AS amount FROM {{ source }};`;

/** Rows → Filter → Doubled (own code), and an instance of the Box component. */
async function prepare(page: Page) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Canvas editing" },
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
  bundle.node_sql = { ...bundle.node_sql, "nodes/doubled.sql": DOUBLED };
  bundle.components.box = {
    id: "box",
    name: "Box",
    nodes: [
      { id: "inner", template: "rows", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [],
    inputs: {},
    outputs: { rows: { node: "inner", port: "result" } },
    parameters: {},
  } as unknown as (typeof bundle.components)[string];
  bundle.flow.nodes = [
    { id: "rows", template: "rows", params: {}, position: { x: 0, y: 0 } },
    {
      id: "filtered",
      template: "filter",
      params: { condition: "amount > 0" },
      position: { x: 350, y: 0 },
    },
    {
      id: "doubled",
      preset: "sql",
      origin: "sql",
      params: {},
      position: { x: 700, y: 0 },
    },
    { id: "boxed", component: "box", params: {}, position: { x: 0, y: 300 } },
  ];
  bundle.flow.edges = [
    {
      id: "rows_filtered",
      source: "rows",
      sourceHandle: "result",
      target: "filtered",
      targetHandle: "source",
    },
    {
      id: "filtered_doubled",
      source: "filtered",
      sourceHandle: "result",
      target: "doubled",
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
  // Undo and redo requests, to check that guarded shortcuts send none.
  const reverts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/revert"))
      reverts.push(request.url());
  });
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  return { endpoint, read, reverts };
}

const node = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const select = (page: Page, id: string, modifiers: "Shift"[] = []) =>
  node(page, id).locator(".node-shape").click({ modifiers });

test("deleting a node offers Undo, and Ctrl+Z / Ctrl+Shift+Z keep a concurrent edit", async ({
  page,
}) => {
  const { endpoint, read, reverts } = await prepare(page);
  const before = await read();
  const ids = async () =>
    (await read()).bundle!.flow.nodes.map((item) => item.id);
  await select(page, "filtered");
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Remove node", exact: true })
    .click();
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Node deleted");
  await expect(node(page, "filtered")).toHaveCount(0);

  // A collaborator renames another node after the deletion.
  const remote = await read();
  remote.bundle!.flow.nodes.find((item) => item.id === "rows")!.label =
    "Remote rows";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: remote.revision, bundle: remote.bundle },
      })
    ).ok(),
  ).toBe(true);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(toast).toContainText("Change undone");
  await expect(node(page, "filtered")).toBeVisible();
  let restored = await read();
  const flow = restored.bundle!.flow;
  expect(flow.nodes.find((item) => item.id === "filtered")).toEqual(
    before.bundle!.flow.nodes.find((item) => item.id === "filtered"),
  );
  expect(flow.edges.map((edge) => edge.id).sort()).toEqual([
    "filtered_doubled",
    "rows_filtered",
  ]);
  expect(flow.nodes.find((item) => item.id === "rows")!.label).toBe(
    "Remote rows",
  );

  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(toast).toContainText("Change redone");
  await expect.poll(ids).not.toContain("filtered");
  restored = await read();
  expect(restored.bundle!.flow.edges).toEqual([]);
  expect(
    restored.bundle!.flow.nodes.find((item) => item.id === "rows")!.label,
  ).toBe("Remote rows");
  expect(reverts).toHaveLength(2);

  // The message's Undo restores the deleted node too.
  await select(page, "doubled");
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Remove node", exact: true })
    .click();
  await expect.poll(ids).not.toContain("doubled");
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(ids).toContain("doubled");
  expect((await read()).files["nodes/doubled.sql"]).toBe(
    before.files["nodes/doubled.sql"],
  );
});

test("a conflicting undo is reported once, and editors wait for undos", async ({
  page,
}) => {
  const { endpoint, read, reverts } = await prepare(page);
  await select(page, "rows");
  const inspector = page.locator(".inspector");
  await autosaved(page, () =>
    inspector
      .getByRole("textbox", { name: "Display name", exact: true })
      .fill("Mine"),
  );
  // A collaborator renames the same node afterwards.
  const remote = await read();
  remote.bundle!.flow.nodes.find((item) => item.id === "rows")!.label =
    "Theirs";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: remote.revision, bundle: remote.bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.route(/\/revert$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  await page.keyboard.press("ControlOrMeta+Z");
  // No edit can race the undo.
  await expect(page.locator("#node-inspector")).toHaveAttribute("inert");
  await expect(page.locator(".toast")).toContainText("Concurrent edits");
  await expect(page.locator("#node-inspector")).not.toHaveAttribute("inert");
  // The retained conflict settles that undo: it is not sent again.
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(page.locator(".toast")).toContainText("Nothing to undo");
  expect(reverts).toHaveLength(1);
});

test("copy includes edits still being saved", async ({ page }) => {
  const { endpoint, read } = await prepare(page);
  await select(page, "doubled");
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() === "PUT")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page
    .locator(".inspector")
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Renamed");
  // Selecting the node again leaves the field, which starts its save.
  await select(page, "doubled");
  await expect(page.locator(".save-status")).toHaveText("Saving…");
  await page.keyboard.press("ControlOrMeta+C");
  await expect(page.locator(".toast")).toContainText("Node copied");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  const pasted = (await read()).bundle!.flow.nodes.find(
    (item) => !["rows", "filtered", "doubled", "boxed"].includes(item.id),
  )!;
  expect(pasted.label).toBe("Renamed");
});

test("copied connected nodes paste as new connected nodes, here and in a component", async ({
  page,
}) => {
  const { read } = await prepare(page);
  await select(page, "filtered");
  await select(page, "doubled", ["Shift"]);
  await page.keyboard.press("ControlOrMeta+C");
  await expect(page.locator(".toast")).toContainText("2 nodes copied");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  const snapshot = await read();
  const { nodes, edges } = snapshot.bundle!.flow;
  const pasted = nodes.filter(
    (item) => !["rows", "filtered", "doubled", "boxed"].includes(item.id),
  );
  expect(pasted).toHaveLength(2);
  const filter = pasted.find((item) => item.template === "filter")!;
  const doubled = pasted.find((item) => item.template !== "filter")!;
  expect(filter.params).toEqual({ condition: "amount > 0" });
  expect(filter.position).toEqual({ x: 390, y: 40 });
  expect(snapshot.files[`nodes/${doubled.id}.sql`]).toBe(
    snapshot.files["nodes/doubled.sql"],
  );
  // The copies are connected to each other, not to the original input.
  expect(
    edges.filter(
      (edge) => edge.source === filter.id || edge.target === filter.id,
    ),
  ).toEqual([
    expect.objectContaining({
      source: filter.id,
      sourceHandle: "result",
      target: doubled.id,
      targetHandle: "source",
    }),
  ]);

  // Pasting in a component adds the copies to its definition.
  await select(page, "boxed");
  await page
    .getByRole("button", { name: "Open component", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const box = (await read()).bundle!.components.box;
  expect(box.nodes).toHaveLength(3);
  expect(box.edges).toHaveLength(1);
});

const zoom = (page: Page) =>
  page
    .locator(".react-flow__viewport")
    .evaluate(
      (viewport) => new DOMMatrix(getComputedStyle(viewport).transform).a,
    );
/**
 * Double-click a node at human speed: the first click selects it, which opens
 * the inspector and the preview and refits the graph, so the second click lands
 * on whatever has moved under the pointer. Returns the zoom between the clicks.
 */
async function slowDoubleClick(page: Page, id: string) {
  const shape = node(page, id).locator(".node-shape");
  const before = (await shape.boundingBox())!;
  const x = before.x + before.width / 2;
  const y = before.y + before.height / 2;
  await page.mouse.click(x, y);
  await expect(node(page, id)).toHaveClass(/selected/);
  await expect
    .poll(async () => {
      const after = (await shape.boundingBox())!;
      return Math.hypot(after.x - before.x, after.y - before.y);
    })
    .toBeGreaterThan(before.height);
  const refitted = await zoom(page);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  return refitted;
}

test("a double-click acts on the node its first click selected, even after the graph moved", async ({
  page,
}) => {
  await prepare(page);
  await slowDoubleClick(page, "boxed");
  await expect(page.locator(".component-notice")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(node(page, "inner")).toBeVisible();

  await page
    .locator(".canvas-breadcrumb")
    .getByRole("button", { name: "Canvas editing", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  const refitted = await slowDoubleClick(page, "filtered");
  await page.waitForTimeout(500);
  // Neither the pane nor another node takes the second click.
  expect(await zoom(page)).toBe(refitted);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await expect(node(page, "filtered")).toHaveClass(/selected/);
  await expect(page.locator(".component-notice")).toHaveCount(0);
});

test("canvas shortcuts yield to fields, editors and dialogs", async ({
  page,
}) => {
  const { read, reverts } = await prepare(page);
  await select(page, "doubled");
  await page.keyboard.press("ControlOrMeta+C");
  await expect(page.locator(".toast")).toContainText("Node copied");
  const inspector = page.locator(".inspector");
  const label = inspector.getByRole("textbox", {
    name: "Display name",
    exact: true,
  });
  await label.fill("Typed label");
  await label.press("ControlOrMeta+Z");
  await label.press("ControlOrMeta+V");
  await label.blur();
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  // The docked code editor keeps its own shortcuts.
  const panel = await openCode(page);
  await panel.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.press("ControlOrMeta+Z");
  await closeCode(page);
  // An open dialog blocks the canvas shortcuts, wherever the focus is.
  await page
    .getByRole("complementary", { name: "Nodes" })
    .getByRole("button", { name: "New SQL template" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New SQL template" });
  await expect(dialog.locator(".monaco-editor")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(reverts).toEqual([]);
  expect((await read()).bundle!.flow.nodes).toHaveLength(4);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
});

test("the code editor saves after a pause, with Ctrl+S and when it closes", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  const code = async () => (await read()).files["nodes/doubled.sql"];
  await select(page, "doubled");
  const dialog = await openCode(page);
  const state = dialog.locator(".editor-save-state");
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await dialog.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+End");
  // Nothing but the pause saves this edit.
  await page.keyboard.insertText("\n-- paused");
  await expect.poll(code).toMatch(/\n-- paused$/);
  await expect(state).toHaveText("All changes saved");
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  await expect(dialog).toBeVisible();

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(endpoint),
  );
  await page.keyboard.insertText("\n-- shortcut");
  await page.keyboard.press("ControlOrMeta+S");
  expect((await saved).ok()).toBe(true);
  await expect(state).toHaveText("All changes saved");
  expect(await code()).toMatch(/\n-- paused\n-- shortcut$/);
  await expect(dialog).toBeVisible();

  // Selecting another node saves the code it leaves; the panel stays open.
  await page.keyboard.insertText("\n-- switched");
  await select(page, "filtered");
  await expect(codePanel(page)).toBeVisible();
  await expect.poll(code).toMatch(/\n-- paused\n-- shortcut\n-- switched$/);
  await select(page, "doubled");
  // The editor reports changes once it shows the node's code.
  await expect(codePanel(page).locator(".monaco-editor")).toContainText(
    "switched",
  );
  await codePanel(page).locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n-- closed");
  await closeCode(page);
  await expect
    .poll(code)
    .toMatch(/\n-- paused\n-- shortcut\n-- switched\n-- closed$/);
});
