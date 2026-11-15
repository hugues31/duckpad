import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("a node with only tests and messages shows them in its results", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "SQL operations" },
    })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  try {
    const snapshot = await (await page.request.get(endpoint)).json();
    snapshot.bundle.flow = {
      nodes: [
        { id: "control", label: "Terminal checks", position: { x: 0, y: 0 } },
      ],
      edges: [],
    };
    snapshot.bundle.node_sql = {
      "nodes/control.sql": `-- @test valid
SELECT 1 WHERE false;
-- @message
SELECT 'info' AS level, 'Control completed' AS message;`,
    };
    expect(
      (
        await page.request.put(endpoint, {
          data: { revision: snapshot.revision, bundle: snapshot.bundle },
        })
      ).ok(),
    ).toBeTruthy();
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await page.locator('.react-flow__node[data-id="control"]').click();
    await page.getByRole("button", { name: "Run all", exact: true }).click();
    await page.getByRole("tab", { name: "Log", exact: true }).click();
    await expect(
      page.getByText("Control completed", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      page.getByRole("button", { name: "Download exported data", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "Tests", exact: true }).click();
    await expect(page.getByText("valid", { exact: true })).toBeVisible();
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
  }
});
