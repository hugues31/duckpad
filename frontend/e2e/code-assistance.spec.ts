import { expect, test, type Page } from "@playwright/test";
import {
  closeEditor,
  codePanel,
  createFilterProject,
  openCode,
} from "./helpers";

const suggestions = (page: Page) =>
  page.locator(".suggest-widget.visible .monaco-list-row");

test("template dialogs complete the connections granted to the project", async ({
  page,
}) => {
  const { read } = await createFilterProject(page);
  const snapshot = await read();
  const connection = "editor-files";
  try {
    expect(
      (
        await page.request.put("/api/catalog/connection?create=true", {
          data: {
            id: connection,
            name: "Editor files",
            connector: "folder",
            environments: { dev: { root: "" } },
          },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.put(
          `/api/projects/${snapshot.worktree.project}/connections`,
          {
            data: { connections: [connection] },
          },
        )
      ).ok(),
    ).toBe(true);
    await page.reload();
    await page
      .getByRole("button", { name: "New SQL template", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "New SQL template",
      exact: true,
    });
    await dialog.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(
      '-- @param location: connection = "editor-fi"\n-- @output result\nSELECT 1;',
    );
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Control+Space");
    await expect(
      suggestions(page).filter({ hasText: connection }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await closeEditor(dialog);
    expect(Object.values((await read()).files)).toContain(
      '-- @param location: connection = "editor-files"\n-- @output result\nSELECT 1;',
    );
  } finally {
    await page.request.delete(`/api/catalog/connection/${connection}`);
  }
});

test("SQL completion replaces a whole default or reference at the cursor", async ({
  page,
}) => {
  const { read } = await createFilterProject(page, (bundle) => {
    bundle.flow.nodes[1] = {
      id: "filtered",
      params: {},
      position: { x: 350, y: 0 },
    };
    bundle.node_sql = {
      "nodes/filtered.sql":
        '-- @input source\n-- @param mode: choice(left outer|inner) = "left outext"\n-- @output result\nSELECT * FROM {{ souce }};\n',
    };
  });
  const panel = await openCode(page);
  await panel.locator("textarea").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+Space");
  await expect(
    suggestions(page).filter({ hasText: "left outer" }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect
    .poll(async () => (await read()).files["nodes/filtered.sql"])
    .toContain('-- @param mode: choice(left outer|inner) = "left outer"');

  // Complete in the middle of an existing reference, keeping its closing braces.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+Space");
  await expect(suggestions(page).filter({ hasText: /^source/ })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect
    .poll(async () => (await read()).files["nodes/filtered.sql"])
    .toContain("SELECT * FROM {{ source }};");
});

test("Python column completion preserves the rest of a SQL expression", async ({
  page,
}) => {
  const { id, endpoint, read } = await createFilterProject(page);
  const snapshot = await read();
  expect(
    (
      await page.request.put(
        `/api/projects/${snapshot.worktree.project}/python`,
        {
          data: { enabled: true },
        },
      )
    ).ok(),
  ).toBe(true);
  const bundle = snapshot.bundle!;
  bundle.flow.nodes[1] = {
    id: "filtered",
    language: "python",
    params: {},
    position: { x: 350, y: 0 },
  };
  bundle.node_sql = {
    "nodes/filtered.py": `import duckpad as dp
class Filter(dp.Node):
    def run(self, source: dp.Relation) -> dp.Relation:
        return source.filter("amount > 0 AND inp = 'input'")
`,
  };
  const saved = await page.request.put(endpoint, {
    data: { revision: snapshot.revision, bundle },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const run = await page.request.post(`${endpoint}/runs`, {
    data: { environment: "dev", node: "filtered", ancestors: true },
  });
  expect(run.ok()).toBe(true);
  const { id: runId } = await run.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${runId}`)).json()).status,
    )
    .toBe("success");
  await page.goto(`/worktrees/${id}/flow?node=filtered`);
  const panel = await openCode(page);
  await expect(panel).toContainText("input_only");
  await panel.locator("textarea").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  for (let step = 0; step < 12; step++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+Space");
  await expect(
    suggestions(page).filter({ hasText: /^input_only/ }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect
    .poll(async () => (await read()).files["nodes/filtered.py"])
    .toContain(`return source.filter("amount > 0 AND input_only = 'input'")`);

  // Enter starts a new line after a name typed in full, and inserts a
  // suggestion that completes the typed text.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("        self.db");
  await expect(suggestions(page).filter({ hasText: /^db/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("self.par");
  await expect(
    suggestions(page).filter({ hasText: /^partition/ }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await read()).files["nodes/filtered.py"])
    .toContain("        self.db\n        self.partition");
});

test("the code editor completes Duckpad SQL, explains references and fixes problems", async ({
  page,
}) => {
  test.setTimeout(90000);
  const { endpoint, read } = await createFilterProject(page, (bundle) => {
    bundle.flow.nodes[1] = {
      id: "filtered",
      params: {},
      position: { x: 350, y: 0 },
    };
    bundle.node_sql = {
      "nodes/filtered.sql":
        '-- @label Paid\n-- @input source\n-- @param kind: text = "input"\n-- @output result\nSELECT * FROM {{ source }} WHERE input_only = {{ kind }};\n',
    };
  });
  // Input columns come from the upstream result.
  const run = await page.request.post(`${endpoint}/runs`, {
    data: { environment: "dev" },
  });
  expect(run.ok()).toBe(true);
  const { id } = await run.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${id}`)).json()).status,
    )
    .toBe("success");
  const panel = await openCode(page);
  await expect(panel.getByText("Last result", { exact: true })).toBeVisible();
  const editor = panel.locator(".monaco-editor");
  await expect(editor).toContainText("input_only");
  await editor.locator("textarea").focus();
  await page.keyboard.press("ControlOrMeta+End");

  // Directives, then the names a query can reference.
  await page.keyboard.type("-- @");
  await expect(suggestions(page)).toHaveText([
    "@label",
    "@description",
    "@input",
    "@param",
    "@output",
    "@test",
    "@message",
  ]);
  await page.keyboard.type("test kept:");
  await expect(suggestions(page)).toHaveText(["error", "warning"]);
  // Tab inserts a suggestion; in SQL, Enter always starts a new line.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("SELECT * FROM {{");
  await expect(suggestions(page)).toHaveText([/^kind/, /^result/, /^source/]);
  await page.keyboard.type("sou");
  await page.keyboard.press("Tab");
  // The columns of an aliased input, with their types.
  await page.keyboard.press("End");
  await page.keyboard.type(" s WHERE s.");
  await expect(suggestions(page)).toHaveText([/^amount/, /^input_only/]);
  await expect(suggestions(page).first()).toContainText("INTEGER");
  await page.keyboard.type("am");
  await page.keyboard.press("Tab");
  // Functions match the start of a word, never a loose match of it.
  await page.keyboard.type(" > 0 AND re");
  await expect(suggestions(page).first()).toBeVisible();
  await page.keyboard.type("gion");
  await expect(suggestions(page)).toHaveCount(0);
  // DuckDB functions, with their parameters while typing the call.
  await page.keyboard.type(" IS NULL AND strfti");
  await expect(suggestions(page).first()).toContainText("strftime");
  await page.keyboard.press("Tab");
  await expect(page.locator(".parameter-hints-widget")).toContainText(
    "Converts a date to a string",
  );
  await page.keyboard.press("Escape");

  // A problem is underlined where it is, with fixes.
  await page.keyboard.press("End");
  await page.keyboard.insertText(
    " OR s.amount IN (SELECT amount FROM {{ customers }})",
  );
  await expect(editor.locator(".squiggly-error")).not.toHaveCount(0);
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ControlOrMeta+.");
  const fixes = page.locator(".action-widget");
  await expect(fixes).toContainText("Declare the input customers");
  await expect(fixes).toContainText("Declare the parameter customers");
  await page.keyboard.press("Enter");
  await expect(editor).toContainText("-- @input customers");
  await expect(editor.locator(".squiggly-error")).toHaveCount(0);

  // Hovering a reference tells what it holds on this node.
  // Bracket colors split the reference into spans.
  await editor
    .locator(".view-line", { hasText: "input_only =" })
    .locator("span", { hasText: /^\s*kind\s*$/ })
    .hover({ force: true });
  const hover = page.locator(".monaco-hover:visible");
  await expect(hover).toContainText("Parameter kind: text");
  await expect(hover).toContainText('Default: "input"');
  await expect(codePanel(page).locator(".editor-save-state")).toHaveText(
    "All changes saved",
  );
  const saved = (await read()).files["nodes/filtered.sql"];
  expect(saved).toContain("-- @input customers\n");
  expect(saved).toContain(
    "SELECT * FROM {{ source }} s WHERE s.amount > 0 AND region IS NULL AND strftime() OR s.amount IN (SELECT amount FROM {{ customers }})",
  );

  // Once closed, the editor's find box leaves page shortcuts working.
  await editor.locator("textarea").focus();
  await page.keyboard.press("ControlOrMeta+F");
  await expect(editor.locator(".find-widget.visible")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor.locator(".find-widget.visible")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .getByRole("button", { name: "Search instance", exact: true })
    .focus();
  await page.keyboard.press("ControlOrMeta+K");
  const search = page.getByRole("dialog", {
    name: "Search instance",
    exact: true,
  });
  await expect(search.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
});
