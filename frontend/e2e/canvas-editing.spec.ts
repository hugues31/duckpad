import { test, expect, type Page } from "@playwright/test";
import {
  autosaved,
  canvasZoom,
  closeCode,
  codePanel,
  deferred,
  openCode,
  signIn,
} from "./helpers";
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

test("Escape clears the selection and closes its inspector and results", async ({
  page,
}) => {
  const { read } = await prepare(page);
  const before = await read();
  const inspector = page.locator(".inspector");
  const results = page.getByRole("region", { name: "Results", exact: true });
  const selected = page.locator(".react-flow__node.selected");

  for (const focus of ["canvas", "inspector", "results"]) {
    await select(page, "filtered");
    await expect(inspector).toBeVisible();
    await expect(results).toBeVisible();
    await expect(selected).toHaveCount(1);
    if (focus === "inspector")
      await inspector.getByRole("textbox", { name: "Display name" }).focus();
    else if (focus === "results")
      await results.getByRole("tab", { name: "Data", exact: true }).focus();
    else await node(page, "filtered").focus();
    await page.keyboard.press("Escape");
    await expect(inspector).toBeHidden();
    await expect(results).toBeHidden();
    await expect(selected).toHaveCount(0);
  }

  await select(page, "filtered");
  await select(page, "rows", ["Shift"]);
  await expect(selected).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);
  await expect(inspector).toBeHidden();
  await expect(results).toBeHidden();
  await expect(page.locator(".group-button")).toBeHidden();
  await page.keyboard.press("Escape");
  expect((await read()).commit).toBe(before.commit);
  await select(page, "filtered");
  await expect(inspector).toBeVisible();
  await expect(results).toBeVisible();
});

test("Escape yields to a dialog or a control that uses it, and saves pending inspector edits when dismissing", async ({
  page,
}) => {
  const { read } = await prepare(page);
  await select(page, "filtered");
  await page
    .getByRole("button", { name: "About Duckpad", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const inspector = page.locator(".inspector");
  const results = page.getByRole("region", { name: "Results", exact: true });
  await expect(inspector).toBeVisible();
  await expect(results).toBeVisible();
  await expect(node(page, "filtered")).toHaveClass(/selected/);

  // A list of search results, an inline edit and the code editor use Escape
  // themselves: the panels stay open.
  const search = page.getByRole("combobox", { name: "Find a node…" });
  await search.fill("rows");
  await expect(page.getByRole("listbox")).toBeVisible();
  await search.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await search.fill("");
  await results.getByRole("tab", { name: "Columns", exact: true }).click();
  await results
    .getByRole("button", { name: "Edit: Dataset documentation", exact: true })
    .click();
  const documentation = results.getByRole("textbox", {
    name: "Dataset documentation",
    exact: true,
  });
  await documentation.fill("Abandoned");
  await documentation.press("Escape");
  await expect(documentation).toHaveCount(0);
  await expect(results).toBeVisible();
  await select(page, "doubled");
  const code = await openCode(page);
  await code.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.press("Escape");
  await expect(code).toBeVisible();
  await expect(node(page, "doubled")).toHaveClass(/selected/);
  await closeCode(page);
  await select(page, "filtered");

  await autosaved(page, async () => {
    await inspector
      .getByRole("textbox", { name: "Display name" })
      .fill("Renamed filter");
    await page.keyboard.press("Escape");
  });
  await expect(inspector).toBeHidden();
  expect(
    (await read()).bundle!.flow.nodes.find((item) => item.id === "filtered")
      ?.label,
  ).toBe("Renamed filter");
});

test("mute shortcuts and menu preserve the graph and bypass execution", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  const original = (await read()).bundle!;
  const doubled = node(page, "doubled");
  await select(page, "doubled");
  await autosaved(page, () => page.keyboard.press("m"));
  await expect(doubled.locator(".pipeline-node")).toHaveClass(/is-muted/);
  await expect(doubled.locator(".node-passthrough path")).toHaveCount(1);
  await expect(doubled).toContainText("Muted");
  // The selection ring stays visible on the faded node.
  await expect(doubled.locator(".node-shape")).not.toHaveCSS(
    "box-shadow",
    "none",
  );
  const notice = page.locator(".inspector .notice", { hasText: "Muted." });
  await expect(notice).toBeVisible();
  const saved = (await read()).bundle!;
  expect(saved.flow.nodes.find((item) => item.id === "doubled")?.muted).toBe(
    true,
  );
  expect(saved.flow.edges).toEqual(original.flow.edges);
  expect(saved.node_sql).toEqual(original.node_sql);

  await page.reload();
  await expect(doubled.locator(".pipeline-node")).toHaveClass(/is-muted/);
  const run = async (expected: number) => {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/runs"),
    );
    await page.getByRole("button", { name: "Run all", exact: true }).click();
    const started = await (await response).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${started.id}`)).json())
            .status,
      )
      .toBe("success");
    const preview = await (
      await page.request.get(`${endpoint}/preview/doubled?environment=dev`)
    ).json();
    expect(preview.rows[0].values).toEqual([expected]);
  };
  await run(1);
  await doubled.click({ button: "right" });
  await autosaved(page, () =>
    page
      .getByRole("menuitem", { name: "Unmute node (M)", exact: true })
      .click(),
  );
  await expect(doubled.locator(".pipeline-node")).not.toHaveClass(/is-muted/);
  await run(2);
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(doubled.locator(".pipeline-node")).toHaveClass(/is-muted/);
  await select(page, "doubled");
  await autosaved(page, () =>
    notice.getByRole("button", { name: "Unmute node (M)" }).click(),
  );
  await expect(doubled.locator(".pipeline-node")).not.toHaveClass(/is-muted/);
  await expect(notice).toHaveCount(0);
  await select(page, "rows");
  await node(page, "rows").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Mute node (M)", exact: true }),
  ).toBeDisabled();
});

test("mute handles multiple selected nodes and yields to typing", async ({
  page,
}) => {
  const { read } = await prepare(page);
  await select(page, "filtered");
  await select(page, "doubled", ["Shift"]);
  await autosaved(page, () => page.keyboard.press("m"));
  await expect(page.locator(".pipeline-node.is-muted")).toHaveCount(2);
  await autosaved(page, () => page.keyboard.press("m"));
  await expect(page.locator(".pipeline-node.is-muted")).toHaveCount(0);
  await select(page, "doubled");
  await autosaved(page, () =>
    page.getByRole("textbox", { name: "Display name", exact: true }).press("m"),
  );
  await expect(page.locator(".pipeline-node.is-muted")).toHaveCount(0);
  expect((await read()).bundle!.flow.nodes.some((item) => item.muted)).toBe(
    false,
  );
});

test("selected links delete, undo and survive a rejected save without deleting nodes", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  const edge = page.locator('.react-flow__edge[data-id="rows_filtered"]');
  const clickEdge = async (id = "rows_filtered") => {
    const selectedEdge = page.locator(`.react-flow__edge[data-id="${id}"]`);
    const point = await selectedEdge
      .locator(".react-flow__edge-path")
      .evaluate((element) => {
        const path = element as SVGPathElement;
        const middle = path.getPointAtLength(path.getTotalLength() / 2);
        const screen = new DOMPoint(middle.x, middle.y).matrixTransform(
          path.getScreenCTM()!,
        );
        return { x: screen.x, y: screen.y };
      });
    await page.mouse.click(point.x, point.y);
    await expect(selectedEdge).toHaveClass(/selected/);
  };
  await select(page, "filtered");
  await clickEdge();
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  // Typing in a filter must not delete the selected link.
  const search = page.getByRole("combobox", { name: "Find a node…" });
  await search.focus();
  await page.keyboard.press("Delete");
  await expect(edge).toHaveCount(1);
  await clickEdge();
  await page.keyboard.press("Delete");
  await expect(edge).toHaveCount(0);
  await expect
    .poll(async () => (await read()).bundle!.flow.edges.map((edge) => edge.id))
    .toEqual(["filtered_doubled"]);
  expect((await read()).bundle!.flow.nodes).toHaveLength(4);
  await page.keyboard.press("ControlOrMeta+Z");
  // The canvas ignores clicks until the undo is saved and reloaded.
  await expect(page.locator(".toast")).toContainText("Change undone");
  await expect(edge).toHaveCount(1);
  // A restored link is not selected, so deleting a node next cannot remove it.
  await expect(edge).not.toHaveClass(/selected/);
  await page.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "Save unavailable" } })
      : route.continue(),
  );
  await clickEdge();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".toast")).toContainText("Save unavailable");
  await expect(edge).toHaveCount(1);
  await expect(edge).not.toHaveClass(/selected/);
  expect((await read()).bundle!.flow.edges).toHaveLength(2);
  await page.unroute(`**${endpoint}`);
  await clickEdge();
  await page.keyboard.down("Shift");
  await clickEdge("filtered_doubled");
  await page.keyboard.up("Shift");
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(2);
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  expect((await read()).bundle!.flow.nodes).toHaveLength(4);
});

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

test("grouping waits for an Inspector save, and Ctrl+Z undoes the group before the edit", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  await select(page, "filtered");
  const release = deferred();
  const started = deferred();
  let savedRevision = "";
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    savedRevision = (await response.json()).revision;
    started.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page
    .locator(".inspector")
    .getByLabel("Display name", { exact: true })
    .fill("Reviewed filter");
  await started.promise;
  await page.locator(".group-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Component name").fill("Reviewed group");
  const request = page.waitForRequest((r) => r.url().endsWith("/group"));
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  release.resolve();
  // The group applies to the revision of the edit it waited for.
  expect((await request).postDataJSON().revision).toBe(savedRevision);
  await expect(dialog).toHaveCount(0);
  const groups = async () =>
    Object.values((await read()).bundle!.components).map(
      (component) => component.name,
    );
  await expect.poll(groups).toContain("Reviewed group");
  await page.getByRole("link", { name: "Flow", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(groups).not.toContain("Reviewed group");
  expect(
    (await read()).bundle!.flow.nodes.find((item) => item.id === "filtered")
      ?.label,
  ).toBe("Reviewed filter");
});

test("Back during a group waits for it, then leaves the flow", async ({
  page,
}) => {
  await prepare(page);
  // Back to a page of this session, which the router can hold.
  await page.getByRole("link", { name: "Variables", exact: true }).click();
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await select(page, "filtered");
  const release = deferred();
  const held = deferred();
  await page.route(/\/group$/, async (route) => {
    held.resolve();
    await release.promise;
    await route.continue();
  });
  await page.locator(".group-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Component name").fill("Left group");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await held.promise;
  // The group then selects its component, a navigation of its own.
  await page.evaluate(() => history.back());
  release.resolve();
  await expect(
    page.getByRole("heading", { name: "Project variables", exact: true }),
  ).toBeVisible();
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
  const refitted = await canvasZoom(page);
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
  await slowDoubleClick(page, "filtered");
  await page.waitForTimeout(500);
  // Neither the pane nor another node takes the second click.
  await expect(codePanel(page).locator(".monaco-editor")).toBeVisible();
  await expect(codePanel(page)).toContainText("Shared template, 1 node");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await expect(node(page, "filtered")).toHaveClass(/selected/);
  await expect(page.locator(".component-notice")).toHaveCount(0);
  await closeCode(page);
  await node(page, "doubled").locator(".node-shape").dblclick();
  await expect(codePanel(page).locator(".monaco-editor")).toContainText(
    "amount * 2",
  );
  await closeCode(page);
  await node(page, "boxed").locator(".node-shape").dblclick();
  await expect(node(page, "inner")).toBeVisible();
  await node(page, "inner").locator(".node-shape").dblclick();
  await expect(codePanel(page).locator(".monaco-editor")).toContainText(
    "1 AS amount",
  );
});

test("double-click opens Python code and read-only nodes cannot be changed", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  const snapshot = await read();
  const bundle = snapshot.bundle!;
  bundle.flow.nodes.push({
    id: "python_node",
    language: "python",
    label: "Python rows",
    params: {},
    position: { x: 700, y: 300 },
  });
  bundle.node_sql!["nodes/python_node.py"] =
    "import duckpad as dp\nclass Source(dp.Node):\n    def run(self) -> dp.Relation:\n        return self.db.sql('SELECT 42 AS amount')\n";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await node(page, "python_node").locator(".node-shape").dblclick();
  await expect(codePanel(page)).toContainText("Python");
  await expect(codePanel(page).locator(".monaco-editor")).toContainText(
    "SELECT 42",
  );
  await closeCode(page);
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const value: Snapshot = await response.json();
    value.worktree.read_only = true;
    await route.fulfill({ response, json: value });
  });
  await page.reload();
  await select(page, "python_node");
  const actions = page.getByRole("group", {
    name: "Node actions",
    exact: true,
  });
  await expect(actions).toBeVisible();
  for (const button of await actions.getByRole("button").all())
    await expect(button).toBeDisabled();
  const before = (await read()).revision;
  await node(page, "python_node").locator(".node-shape").dblclick();
  await expect(codePanel(page).locator(".monaco-editor")).toBeVisible();
  await codePanel(page).locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("should not be saved");
  await closeCode(page);
  expect((await read()).revision).toBe(before);
  // The snapshot poll keeps reaching the route; let it finish before teardown.
  await page.unrouteAll({ behavior: "wait" });
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
  await page.keyboard.press("m");
  await page.keyboard.press("ControlOrMeta+Z");
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
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("m");
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(reverts).toEqual([]);
  expect((await read()).bundle!.flow.nodes.some((item) => item.muted)).toBe(
    false,
  );
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
