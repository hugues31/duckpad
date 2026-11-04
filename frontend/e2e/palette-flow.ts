import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";

/** Exercise palette authoring against a local instance or an authenticated preview. */
export async function verifyPalette(page: Page) {
  const createProject = async (name: string) => {
    const response = await page.request.post("/api/projects", {
      data: { name },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).id as string;
  };
  const read = async (id: string): Promise<Snapshot> =>
    (await page.request.get(`/api/worktrees/${id}`)).json();
  const project = await createProject("Reusable palette nodes");
  await page.goto(`/worktrees/${project}/flow`);
  const palette = page.getByRole("complementary", { name: "Nodes" });
  const actions = palette.getByRole("group", { name: "Add to palette" });
  await expect(actions.getByRole("button")).toHaveText(["SQL", "Import"]);
  await expect(palette.getByText("Drag a node onto the canvas")).toHaveCount(0);
  const create = actions.getByRole("button", { name: "New SQL template" });
  await create.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New SQL template" });
  await expect(dialog).toContainText("Save a reusable SQL template");
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
  const before = await read(project);
  expect(before.bundle!.flow.nodes).toHaveLength(0);
  await create.click();
  const name = "Reusable answer";
  const sql = `-- @label ${name}\n-- @output result\nSELECT 42 AS answer;\n`;
  await expect(dialog.locator(".monaco-editor")).toBeVisible();
  await dialog.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(sql);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const template = palette.getByRole("button", { name, exact: true });
  await expect(template).toBeVisible();
  let snapshot = await read(project);
  expect(snapshot.bundle!.flow.nodes).toHaveLength(0);
  const created = Object.keys(snapshot.bundle!.templates).filter(
    (id) => !(id in before.bundle!.templates),
  );
  expect(created).toHaveLength(1);
  expect(snapshot.bundle!.templates[created[0]]).toBe(sql);
  await page.reload();
  await template.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await template.dragTo(page.locator(".react-flow__pane"), {
    targetPosition: { x: 700, y: 450 },
  });
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  snapshot = await read(project);
  for (const node of snapshot.bundle!.flow.nodes) {
    expect(node.template).toBeUndefined();
    expect(node.origin).toBe(created[0]);
    expect(snapshot.files[`nodes/${node.id}.sql`]).toBe(sql);
  }
  // Import adds a reusable definition to the destination palette, without a canvas node.
  const destination = await createProject("Palette imports");
  await page.goto(`/worktrees/${destination}/flow`);
  await actions.getByRole("button", { name: "Import from a project" }).click();
  const library = page.getByRole("dialog", { name: "Import from a project" });
  await library
    .locator(".history-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByRole("button", { name: "Import independent copy", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText(
    "Independent copy imported",
  );
  await page.keyboard.press("Escape");
  await expect(template).toBeVisible();
  const imported = await read(destination);
  expect(imported.bundle!.flow.nodes).toHaveLength(0);
  expect(Object.values(imported.bundle!.templates)).toContain(sql);
  await template.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  return { project, destination };
}
