import { expect, type Page } from "@playwright/test";
import { closeCode, nodeMenuAction, openCode, replaceCode } from "./helpers";
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
    await openCode(page, button);
    await replaceCode(page, text);
    await closeCode(page);
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
  // Actions stay available on every tab and above long parameter forms.
  const actions = inspector.getByRole("group", {
    name: "Node actions",
    exact: true,
  });
  // An icon is named as soon as the pointer reaches it.
  const duplicate = actions.getByRole("button", {
    name: "Duplicate node",
    exact: true,
  });
  await duplicate.hover();
  await expect
    .poll(() =>
      duplicate.evaluate((button) => {
        const name = getComputedStyle(button, "::after");
        return name.opacity === "1" && name.content;
      }),
    )
    .toBe('"Duplicate node"');
  for (const tab of ["Info", "Documentation", "Parameters"]) {
    await inspector.getByRole("button", { name: tab, exact: true }).click();
    await inspector.locator(".inspector-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    for (const name of [
      "Edit code",
      "Run with ancestors",
      "Duplicate node",
      "Mute node (M)",
      "Convert to template",
      "Remove node",
    ]) {
      await expect(
        actions.getByRole("button", { name, exact: true }),
      ).toBeInViewport();
    }
  }
  await nodeMenuAction(page, "Convert to template");
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
    .getByRole("button", { name: "Shared filter", exact: true })
    .click({ modifiers: ["Alt"] });
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
  // The linked node's code is its shared template, docked like its own code.
  const linkedCode = await openCode(page, "Edit template (2 nodes)");
  await expect(linkedCode).toContainText("Shared template, 2 nodes");
  await expect(linkedCode.locator(".monaco-editor")).toContainText(
    "shared_flag",
  );
  await closeCode(page);
  await nodeMenuAction(page, "Detach from template");
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  snapshot = await read();
  expect(snapshot.files[`nodes/${second.id}.sql`]).toBe(sharedText);
  expect(
    snapshot.bundle!.flow.nodes.find((n) => n.id === second.id)!.origin,
  ).toBe(shared);
  // A relink is an explicit confirmation, and cancel keeps local code.
  await nodeMenuAction(page, "Link to original template");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect((await read()).files[`nodes/${second.id}.sql`]).toBe(sharedText);
  await nodeMenuAction(page, "Link to original template");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Link to original template", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", {
      name: "Edit template (2 nodes)",
      exact: true,
    }),
  ).toBeVisible();
  expect((await read()).files[`nodes/${second.id}.sql`]).toBeUndefined();
  await nodeMenuAction(page, "Detach from template");
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  await nodeMenuAction(page, "Duplicate node");
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
  await page
    .locator(".palette")
    .getByRole("button", { name: "SQL", exact: true })
    .click();
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  // The canvas shows the node before its save lands.
  await expect
    .poll(async () => (await read()).bundle!.flow.nodes.length)
    .toBe(4);
  snapshot = await read();
  const fresh = snapshot.bundle!.flow.nodes.at(-1)!;
  expect(fresh.template).toBeUndefined();
  // The palette's description of SQL nodes stays out of the new node's code.
  expect(snapshot.bundle!.templates.sql).toContain("-- @description");
  expect(snapshot.files[`nodes/${fresh.id}.sql`]).toBe(
    snapshot.bundle!.templates.sql.replace(/^-- @description.*\n/m, ""),
  );
  return { worktree: worktree.id, normal: first.id, linked: shared };
}
