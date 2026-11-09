import { expect, test } from "@playwright/test";
import labels from "../src/locales/fr.json" with { type: "json" };
import type { Snapshot } from "../src/types";
import { submitLogin } from "./helpers";

// Unit tests cover each language; this checks the server refusal reaches the UI translated.
test.use({ locale: "fr-FR" });

test("explains disabled Python for direct and confirmed pipeline runs", async ({
  page,
}) => {
  await page.goto("/");
  await submitLogin(page, labels);
  const created = await page.request.post("/api/projects", {
    data: { name: `Python policy` },
  });
  expect(created.ok()).toBeTruthy();
  const tree = await created.json();
  const endpoint = `/api/worktrees/${tree.id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const bundle = snapshot.bundle!;
  bundle.flow.nodes = [
    {
      id: "python",
      language: "python",
      params: {},
      position: { x: 0, y: 0 },
    },
  ];
  bundle.flow.edges = [];
  bundle.node_sql = {
    "nodes/python.py":
      "import duckpad as dp\nclass Example(dp.Node):\n    def run(self) -> dp.Relation:\n        return self.sql('SELECT 1 AS value')\n",
  };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${tree.id}/flow?env=dev`);
  const run = page.getByRole("button", { name: labels.run, exact: true });
  await run.click();
  await expect(page.getByRole("alert")).toContainText(
    labels.pythonExecutionDisabled,
  );
  await page
    .locator(".toast")
    .getByRole("button", { name: labels.close, exact: true })
    .click();
  await page
    .getByLabel(labels.environment, { exact: true })
    .selectOption("prod");
  await run.click();
  const dialog = page.getByRole("dialog", { name: labels.confirmRun });
  await dialog
    .getByRole("button", { name: labels.confirmAndRun, exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    labels.pythonExecutionDisabled,
  );
  expect(
    await (await page.request.get(`/api/runs?worktree=${tree.id}`)).json(),
  ).toEqual([]);
});
