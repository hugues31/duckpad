import { expect, test, type Page } from "@playwright/test";
import { codePanel, createFilterProject, openCode } from "./helpers";

const suggestions = (page: Page) =>
  page.locator(".suggest-widget.visible .monaco-list-row");

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
