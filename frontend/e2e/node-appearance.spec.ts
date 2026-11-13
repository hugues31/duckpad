import { expect, test, type Page } from "@playwright/test";
import {
  autosaved,
  codePanel,
  codeSaved,
  createFilterProject,
  openCode,
} from "./helpers";

const node = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"] .pipeline-node`);
const suggestions = (page: Page) =>
  page.locator(".suggest-widget.visible .monaco-list-row");

test("the inspector saves an icon and a color in the node's code, and Undo reverts them", async ({
  page,
}) => {
  const { read } = await createFilterProject(page, (bundle) => {
    // Rows owns its code; the Filter stays linked to its shared template.
    delete bundle.flow.nodes[0].template;
    bundle.node_sql = {
      "nodes/rows.sql":
        "-- @label Rows\n-- @output result\nSELECT 1 AS amount;",
    };
  });
  const inspector = page.locator(".inspector");
  const library = inspector.getByRole("button", { name: /^Icon and color/ });
  const filter = node(page, "filtered");
  await expect(filter.locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "filter",
  );
  await expect(library).toHaveText("Default");

  // A linked node styles its shared template: its palette entry follows.
  await library.click();
  await expect(inspector).toContainText(
    "Saved in the shared template's code as @icon and @color",
  );
  await inspector
    .getByRole("searchbox", { name: "Search icons…", exact: true })
    .fill("order");
  await autosaved(page, () =>
    inspector.getByRole("option", { name: "sort", exact: true }).click(),
  );
  await autosaved(page, () =>
    inspector.getByRole("option", { name: "green", exact: true }).click(),
  );
  await expect(library).toHaveText("sort · green");
  await expect(filter).toHaveClass(/node-color-green/);
  await expect(filter.locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "sort",
  );
  const entry = page.locator(".palette-item", { hasText: /^Filter/ });
  await expect(entry.locator(".palette-icon")).toHaveClass(/node-color-green/);
  await expect(entry.locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "sort",
  );
  expect((await read()).files["templates/filter.sql"]).toMatch(
    /^-- @label Filter\n-- @description [^\n]+\n-- @icon sort\n-- @color green\n-- @input source\n/,
  );
  // Styling a node never makes its results stale.
  expect((await read()).files["templates/filter.sql"]).toContain(
    "SELECT * FROM {{ source }} WHERE {{ condition }};",
  );

  // Undo removes the color, the latest change; the icon stays.
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(page.locator(".toast")).toContainText("Change undone");
  await expect(filter).not.toHaveClass(/node-colored/);
  await expect(filter.locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "sort",
  );
  expect((await read()).files["templates/filter.sql"]).not.toContain("@color");

  // A node with its own code keeps the choice to itself, and can drop it.
  await node(page, "rows").locator(".node-shape").click();
  await expect(library).toHaveText("Default");
  await library.click();
  await expect(inspector).toContainText(
    "Saved in the node's code as @icon and @color",
  );
  await autosaved(page, () =>
    inspector.getByRole("option", { name: "database", exact: true }).click(),
  );
  await expect(node(page, "rows").locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "database",
  );
  expect((await read()).files["nodes/rows.sql"]).toBe(
    "-- @label Rows\n-- @icon database\n-- @output result\nSELECT 1 AS amount;",
  );
  await autosaved(page, () =>
    inspector
      .getByRole("option", { name: "Default icon", exact: true })
      .click(),
  );
  expect((await read()).files["nodes/rows.sql"]).toBe(
    "-- @label Rows\n-- @output result\nSELECT 1 AS amount;",
  );
});

test("the SQL editor suggests icon and color names with previews, and fixes an unknown one", async ({
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
        "-- @label Paid\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n",
    };
  });
  const panel = await openCode(page);
  const editor = panel.locator(".monaco-editor");
  await expect(editor).toContainText("@label Paid");
  await editor.locator("textarea").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");

  // The directive, then its names: each icon shows beside the list.
  await page.keyboard.type("-- @ic");
  await expect(suggestions(page)).toHaveText(["@icon"]);
  await page.keyboard.press("Tab");
  await expect(suggestions(page).first()).toHaveText(/^table/);
  await page.keyboard.type("left");
  await expect(suggestions(page)).toHaveText([/^left-join/]);
  const preview = page.locator(".suggest-details img");
  await expect(preview).toHaveAttribute("alt", "left-join");
  await codeSaved(page, () => page.keyboard.press("Tab"));
  await expect(node(page, "filtered").locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "left-join",
  );

  // Colors show their tone in the list; a space after the directive lists them.
  await page.keyboard.press("Enter");
  await page.keyboard.type("-- @color ");
  await expect(suggestions(page)).toHaveText([
    /^red/,
    /^orange/,
    /^yellow/,
    /^green/,
    /^teal/,
    /^blue/,
    /^purple/,
    /^pink/,
    /^gray/,
  ]);
  await expect(suggestions(page).first().locator(".colorspan")).toBeVisible();
  // An unknown name is only a warning: the node keeps its ports and its default color.
  await page.keyboard.press("Escape");
  await codeSaved(page, () => page.keyboard.type("grey"));
  await expect(editor.locator(".squiggly-warning")).not.toHaveCount(0);
  await expect(editor.locator(".squiggly-error")).toHaveCount(0);
  await expect(node(page, "filtered")).not.toHaveClass(/node-colored/);
  await expect(
    node(page, "filtered").locator(".react-flow__handle"),
  ).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.locator(".action-widget")).toContainText("Change to gray");
  await codeSaved(page, () => page.keyboard.press("Enter"));
  await expect(editor.locator(".squiggly-warning")).toHaveCount(0);
  await expect(node(page, "filtered")).toHaveClass(/node-color-gray/);
  expect((await read()).files["nodes/filtered.sql"]).toBe(
    "-- @label Paid\n-- @icon left-join\n-- @color gray\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n",
  );

  // Hovering a name shows what it stands for.
  await editor
    .locator(".view-line", { hasText: "@icon" })
    .locator("span", { hasText: /^left-join$/ })
    .hover({ force: true });
  await expect(page.locator(".monaco-hover:visible img")).toHaveAttribute(
    "alt",
    "left-join",
  );
});

test("a Python node declares its icon and its color in comments", async ({
  page,
}) => {
  const { id, endpoint, read } = await createFilterProject(page);
  const snapshot = await read();
  expect(
    (
      await page.request.put(
        `/api/projects/${snapshot.worktree.project}/python`,
        { data: { enabled: true } },
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
    "nodes/filtered.py": `# @label Score
import duckpad as dp
class Score(dp.Node):
    def run(self, source: dp.Relation) -> dp.Relation:
        return source
`,
  };
  const saved = await page.request.put(endpoint, {
    data: { revision: snapshot.revision, bundle },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto(`/worktrees/${id}/flow?node=filtered`);
  const score = node(page, "filtered");
  await expect(score.locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "python",
  );

  // The library writes Python comments under the label.
  const inspector = page.locator(".inspector");
  await inspector.getByRole("button", { name: /^Icon and color/ }).click();
  await autosaved(page, () =>
    inspector.getByRole("option", { name: "brain", exact: true }).click(),
  );
  await expect(score.locator("[data-icon]")).toHaveAttribute(
    "data-icon",
    "brain",
  );
  expect((await read()).files["nodes/filtered.py"]).toMatch(
    /^# @label Score\n# @icon brain\nimport duckpad as dp\n/,
  );

  // The editor completes the same comments.
  const panel = await openCode(page);
  const editor = panel.locator(".monaco-editor");
  await expect(editor).toContainText("@icon brain");
  await editor.locator("textarea").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# @");
  await expect(suggestions(page)).toHaveText(["@label", "@icon", "@color"]);
  await page.keyboard.type("co");
  await page.keyboard.press("Tab");
  await expect(suggestions(page).first()).toHaveText(/^red/);
  await page.keyboard.type("pur");
  await codeSaved(page, () => page.keyboard.press("Tab"));
  await expect(score).toHaveClass(/node-color-purple/);
  await expect(codePanel(page).locator(".squiggly-warning")).toHaveCount(0);
  expect((await read()).files["nodes/filtered.py"]).toMatch(
    /^# @label Score\n# @icon brain\n# @color purple\nimport duckpad as dp\n/,
  );
});
