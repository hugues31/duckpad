import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("SQL nodes expose outputs, writes and terminal checks independently", async ({
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
        { id: "mixed", label: "Mixed operations", position: { x: 0, y: 0 } },
        { id: "control", label: "Terminal checks", position: { x: 300, y: 0 } },
      ],
      edges: [],
    };
    snapshot.bundle.node_sql = {
      "nodes/mixed.sql": `-- @param destination: destination = "summary.csv"
COPY {{ total }} TO {{ destination }} (FORMAT CSV, HEADER);
-- @output rows
SELECT range AS amount FROM range(4);
-- @output total
SELECT sum(amount) AS amount FROM {{ rows }};
-- @test positive
SELECT * FROM {{ total }} WHERE amount < 0;`,
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
    await page.locator('.react-flow__node[data-id="mixed"]').click();
    await expect(page.locator(".inspector-kind strong")).toHaveText("SQL");
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await expect
      .poll(async () => {
        const statuses = await (
          await page.request.get(`${endpoint}/status?environment=dev`)
        ).json();
        return statuses.nodes.mixed?.execution_status;
      })
      .toBe("success");
    await page.getByRole("tab", { name: "Log", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Download exported data", exact: true }),
    ).toBeEnabled();
    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await expect(page.getByRole("tab", { name: /^Columns/ })).toBeVisible();
    await page.locator('.react-flow__node[data-id="control"]').click();
    await page.getByRole("tab", { name: "Log", exact: true }).click();
    await expect(
      page.getByText("Control completed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download exported data", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "Tests", exact: true }).click();
    await expect(page.getByText("valid", { exact: true })).toBeVisible();
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
  }
});
