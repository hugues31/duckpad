import { expect, type Page } from "@playwright/test";
import { dragPaletteNode, closeCode, closeEditor, openCode } from "./helpers";
import type { Snapshot } from "../src/types";

/** Exercise palette authoring against a local instance or an authenticated preview. */
export async function verifyPalette(
  page: Page,
  language: "sql" | "python" = "sql",
) {
  const python = language === "python";
  const createProject = async (name: string) => {
    const response = await page.request.post("/api/projects", {
      data: { name },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).id as string;
  };
  const read = async (id: string): Promise<Snapshot> =>
    (await page.request.get(`/api/worktrees/${id}`)).json();
  const sourceName = `Reusable ${language} palette nodes ${Date.now()}`;
  const project = await createProject(sourceName);
  const enablePython = async (id: string) => {
    const snapshot = await read(id);
    const response = await page.request.put(
      `/api/projects/${snapshot.worktree.project}/python`,
      { data: { enabled: true, allow_builds: false } },
    );
    expect(response.ok()).toBe(true);
  };
  await page.goto(`/worktrees/${project}/flow`);
  const palette = page.getByRole("complementary", { name: "Nodes" });
  const actions = palette.getByRole("group", { name: "Add to palette" });
  await expect(actions.getByRole("button")).toHaveText([
    "SQL",
    "Python",
    "Import",
  ]);
  const pythonButton = actions.getByRole("button", {
    name: "New Python template",
  });
  await expect(pythonButton).toBeDisabled();
  await expect(pythonButton).toHaveAttribute(
    "title",
    /Python is disabled for this project/,
  );
  if (python) {
    await enablePython(project);
    await page.reload();
    await expect(pythonButton).toBeEnabled();
  }
  const title = python ? "New Python template" : "New SQL template";
  const create = actions.getByRole("button", { name: title });
  const before = await read(project);
  expect(before.bundle!.flow.nodes).toHaveLength(0);
  await create.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toContainText(
    `add a reusable ${python ? "Python" : "SQL"} template`,
  );
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
  // Closing a new template before any edit creates nothing.
  expect((await read(project)).bundle!.templates).toEqual(
    before.bundle!.templates,
  );
  await create.click();
  const name = `Reusable ${language} answer`;
  const code = python
    ? `# @label ${name}\nimport duckpad as dp\n\n\nclass Answer(dp.Node):\n    def run(self) -> dp.Relation:\n        return self.db.sql("SELECT 42 AS answer")\n`
    : `-- @label ${name}\n-- @output result\nSELECT 42 AS answer;\n`;
  await expect(dialog.locator(".monaco-editor")).toBeVisible();
  await dialog.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((text) => navigator.clipboard.writeText(text), code);
  await page.keyboard.press("ControlOrMeta+V");
  await closeEditor(dialog);
  const template = palette.getByRole("button", { name, exact: true });
  await expect(template).toBeVisible();
  let snapshot = await read(project);
  expect(snapshot.bundle!.flow.nodes).toHaveLength(0);
  const created = Object.keys(snapshot.bundle!.templates).filter(
    (id) => !(id in before.bundle!.templates),
  );
  expect(created).toHaveLength(1);
  expect(snapshot.bundle!.templates[created[0]]).toBe(code);
  expect(created[0].endsWith(".py")).toBe(python);
  await page.reload();
  await template.click();
  await expect(page.locator(".palette-details")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await dragPaletteNode(page, name);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  // Python entries and nodes show the Python logo, SQL ones keep the code icon.
  for (const icon of [
    template.locator(".palette-icon svg"),
    page.locator(".react-flow__node .node-shape svg"),
  ])
    await expect(icon).toHaveClass(python ? /lucide-python/ : /lucide-code/);
  await template.dragTo(page.locator(".react-flow__pane"), {
    targetPosition: { x: 700, y: 450 },
  });
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  snapshot = await read(project);
  for (const node of snapshot.bundle!.flow.nodes) {
    expect(node.template).toBeUndefined();
    expect(node.origin).toBe(created[0]);
    expect(node.language || "sql").toBe(language);
    expect(snapshot.files[`nodes/${node.id}.${python ? "py" : "sql"}`]).toBe(
      code,
    );
  }
  // Linked instances reopen the shared definition in the matching language editor.
  await palette
    .getByRole("button", { name, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add linked", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const shared = await openCode(page, "Edit template (1 node)");
  await expect(shared).toContainText("Shared template, 1 node");
  await expect(shared.locator("[data-mode-id]")).toHaveAttribute(
    "data-mode-id",
    language,
  );
  await closeCode(page);
  // Import adds a reusable definition to the destination palette, without a canvas node.
  const destination = await createProject(`${language} palette imports`);
  if (python) await enablePython(destination);
  await page.goto(`/worktrees/${destination}/flow`);
  await actions.getByRole("button", { name: "Import from a project" }).click();
  const library = page.getByRole("dialog", { name: "Import from a project" });
  await library
    .locator(".history-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ hasText: sourceName })
    .getByRole("button", { name: "Import independent copy", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText(
    "Independent copy imported",
  );
  await page.keyboard.press("Escape");
  await expect(template).toBeVisible();
  const imported = await read(destination);
  expect(imported.bundle!.flow.nodes).toHaveLength(0);
  expect(Object.values(imported.bundle!.templates)).toContain(code);
  await template.click();
  await expect(page.locator(".palette-details")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await dragPaletteNode(page, name);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  return { project, destination };
}
