import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";

/** Exercise the real UI on a local instance or an authenticated deployed preview. */
export async function verifyNodeCode(page: Page) {
  const response = await page.request.post("/api/projects", {
    data: { name: "Node code ownership" },
  });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  const inspector = page.locator(".inspector");
  const select = async (id: string) => {
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await page
      .locator(`.react-flow__node[data-id="${id}"] .node-shape`)
      .click();
  };
  const add = async () => {
    await page
      .locator(".palette-item")
      .filter({ hasText: /^Filter$/ })
      .click();
    await expect(
      inspector.getByRole("button", { name: "Edit code", exact: true }),
    ).toBeVisible();
  };
  const edit = async (button: string, text: string) => {
    await inspector.getByRole("button", { name: button, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".monaco-editor")).toBeVisible();
    await dialog.locator(".monaco-editor textarea").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  };
  await add();
  await expect
    .poll(async () => (await read()).bundle!.flow.nodes.length)
    .toBe(1);
  await add();
  await expect
    .poll(async () => (await read()).bundle!.flow.nodes.length)
    .toBe(2);
  let snapshot = await read();
  const [first, second] = snapshot.bundle!.flow.nodes;
  expect(first.template).toBeUndefined();
  expect(second.template).toBeUndefined();
  const original = snapshot.files[`nodes/${first.id}.sql`];
  await edit("Edit code", '-- @param marker: text = "local"\n' + original);
  snapshot = await read();
  expect(snapshot.files[`nodes/${first.id}.sql`]).toBe(original);
  expect(snapshot.bundle!.templates.filter).toBe(original);
  await expect(
    inspector.getByRole("textbox", { name: /marker/ }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Convert to template", exact: true })
    .click();
  const conversion = page.getByRole("dialog");
  await conversion.getByLabel("Template name").fill("Shared filter");
  await conversion
    .getByRole("button", { name: "Convert to template", exact: true })
    .click();
  await expect(conversion).toHaveCount(0);
  snapshot = await read();
  const shared = snapshot.bundle!.flow.nodes.find(
    (n) => n.id === second.id,
  )!.template!;
  expect(shared).toBeTruthy();
  expect(snapshot.files[`nodes/${second.id}.sql`]).toBeUndefined();
  await page
    .getByRole("button", { name: "Add linked: Shared filter", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", {
      name: "Edit template (2 nodes)",
      exact: true,
    }),
  ).toBeVisible();
  const sharedText =
    "-- @param shared_flag: boolean = true\n" +
    snapshot.bundle!.templates[shared];
  await edit("Edit template (2 nodes)", sharedText);
  await expect(inspector.getByLabel(/shared_flag/)).toBeVisible();
  await select(second.id);
  await expect(inspector.getByLabel(/shared_flag/)).toBeVisible();
  await inspector
    .getByRole("button", { name: "View code", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await inspector
    .getByRole("button", { name: "Detach from template", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  snapshot = await read();
  expect(snapshot.files[`nodes/${second.id}.sql`]).toBe(sharedText);
  expect(
    snapshot.bundle!.flow.nodes.find((n) => n.id === second.id)!.origin,
  ).toBe(shared);
  // A relink is an explicit confirmation, and cancel keeps local code.
  await inspector
    .getByRole("button", { name: "Link to original template", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect((await read()).files[`nodes/${second.id}.sql`]).toBe(sharedText);
  await inspector
    .getByRole("button", { name: "Link to original template", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Link to original template", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", {
      name: "Detach from template",
      exact: true,
    }),
  ).toBeVisible();
  expect((await read()).files[`nodes/${second.id}.sql`]).toBeUndefined();
  await inspector
    .getByRole("button", { name: "Detach from template", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Duplicate node", exact: true })
    .click();
  await expect
    .poll(async () => (await read()).bundle!.flow.nodes.length)
    .toBe(4);
  snapshot = await read();
  const duplicate = snapshot.bundle!.flow.nodes.at(-1)!;
  expect(duplicate.template).toBeUndefined();
  expect(snapshot.files[`nodes/${duplicate.id}.sql`]).toBe(sharedText);
  await inspector
    .getByRole("button", { name: "Remove node", exact: true })
    .click();
  await expect
    .poll(async () => (await read()).files[`nodes/${duplicate.id}.sql`])
    .toBeUndefined();
  await page.getByRole("button", { name: "New SQL node", exact: true }).click();
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  snapshot = await read();
  const fresh = snapshot.bundle!.flow.nodes.at(-1)!;
  expect(fresh.template).toBeUndefined();
  expect(snapshot.files[`nodes/${fresh.id}.sql`]).toBe(
    "-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n",
  );
  return { worktree: worktree.id, normal: first.id, linked: shared };
}
