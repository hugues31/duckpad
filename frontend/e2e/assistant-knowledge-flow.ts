import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";

/** Exercise the same prompts against the deterministic model and a live preview provider. */
export async function verifyAssistantKnowledge(page: Page) {
  await page.goto("/projects");
  await page
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
  await ask(
    "Explain Duckpad's @param directive using the bundled SQL guide. Show a number parameter and how to reference it in SQL.",
  );
  await expect(chat.locator(".assistant-tool")).toContainText(
    "Reads the Duckpad guide",
  );
  await expect(chat).toContainText("@param");
  await chat.getByRole("button", { name: "Close", exact: true }).click();

  const created = await page.request.post("/api/projects", {
    data: { name: "Assistant variable checks" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  const snapshot = await read();
  snapshot.bundle!.variables = {
    obsolete: { type: "text", default: "Unused" },
    minimum: { type: "number", default: 1, environments: { dev: 2, prod: 3 } },
  };
  snapshot.bundle!.flow.nodes = [
    {
      id: "source",
      label: "Source",
      params: { minimum: { $var: "minimum" } },
      position: { x: 0, y: 0 },
    },
  ];
  snapshot.bundle!.flow.edges = [];
  snapshot.bundle!.node_sql = {
    "nodes/source.sql":
      "-- @param minimum: number = 0\n-- @output result\nSELECT {{ minimum }} AS value;\n",
  };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page
    .getByRole("button", { name: "Open AI assistant", exact: true })
    .click();
  await ask(
    "Delete the project variable obsolete. Do not change any other variable or node.",
  );
  expect((await read()).bundle!.variables).not.toHaveProperty("obsolete");
  await expect(chat.locator(".assistant-changes")).toContainText("obsolete");
  await chat.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(async () => (await read()).bundle!.variables)
    .toHaveProperty("obsolete");

  const before = (await read()).commit;
  await ask(
    "Delete the project variable minimum without changing any node or binding. If it is in use, keep it and explain why.",
  );
  expect((await read()).commit).toBe(before);
  expect((await read()).bundle!.variables).toHaveProperty("minimum");

  await ask(
    "Remove only the dev environment override of variable minimum so dev inherits its default. Preserve the prod override and every other field.",
  );
  expect((await read()).bundle!.variables).toEqual({
    obsolete: { type: "text", default: "Unused" },
    minimum: { type: "number", default: 1, environments: { prod: 3 } },
  });
  await expect(
    chat.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  return worktree.id as string;
}
