import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";

/** The same interaction runs against the test model and a configured real preview. */
export async function verifyAssistantEditing(page: Page) {
  const example = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const endpoint = `/api/worktrees/${example.id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  const snapshot = await read();
  const sql = "-- @output result\nSELECT 1 AS value;\n";
  for (const [index, id] of ["editable_source", "manual_source"].entries()) {
    snapshot.bundle!.flow.nodes.push({
      id,
      label: id,
      params: {},
      position: { x: 100 + index * 300, y: 450 },
    });
    snapshot.bundle!.node_sql![`nodes/${id}.sql`] = sql;
  }
  const seeded = await page.request.put(endpoint, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(seeded.ok()).toBeTruthy();
  await page.goto(`/worktrees/${example.id}/flow`);
  await expect(
    page.locator('.react-flow__node[data-id="editable_source"]'),
  ).toBeVisible();
  const launch = () =>
    page
      .getByRole("button", { name: "Open AI assistant", exact: true })
      .click();
  const chat = page.getByRole("dialog", { name: "AI assistant", exact: true });
  const ask = async (message: string) => {
    await chat
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(message);
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      chat.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0, { timeout: 150000 });
    await expect(chat.getByRole("alert")).toHaveCount(0);
  };
  await launch();
  await ask(
    "Add a normal SQL node with ID assistant_source, label Assistant source, at x=100 y=600. Its SQL must be -- @output result followed by SELECT 1 AS value. Do not change any other node.",
  );
  const added = page.locator('.react-flow__node[data-id="assistant_source"]');
  await expect(added).toBeVisible();
  await expect(chat.locator(".assistant-changes")).toContainText(
    "Assistant source",
  );
  await chat.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(added).toHaveCount(0);
  await expect(chat.getByText("Undone", { exact: true })).toBeVisible();
  await ask(
    "Change the SQL of the normal node editable_source to SELECT 2 AS value, keeping its @output result directive. Do not change any other node.",
  );
  await expect
    .poll(async () => (await read()).files["nodes/editable_source.sql"])
    .toContain("SELECT 2");
  await expect(chat.locator(".assistant-tool pre").last()).toContainText(
    "+SELECT 2",
  );
  // A separate manual SQL edit must survive undoing the assistant's action.
  await chat.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page
    .locator('.react-flow__node[data-id="manual_source"] .node-shape')
    .click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Edit code", exact: true })
    .click();
  const editor = page.getByRole("dialog");
  await expect(editor.locator(".monaco-editor")).toBeVisible();
  await editor.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(sql.replace("1", "3"));
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await launch();
  await chat.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () => (await read()).files["nodes/editable_source.sql"])
    .toBe(sql);
  expect((await read()).files["nodes/manual_source.sql"]).toBe(
    sql.replace("1", "3"),
  );
  await expect(chat.getByText("Undone", { exact: true })).toHaveCount(2);
  await chat
    .getByRole("button", { name: "Compare versions", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Project Git workspace", exact: true }),
  ).toBeVisible();
  return example.id as string;
}
