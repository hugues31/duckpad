import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/types";

/** Real Python authoring, mixed execution, captured parents and managed downloads. */
export async function verifyPython(page: Page) {
  const created = await page.request.post("/api/projects", {
    data: { name: "Python acceptance" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(
    page.getByRole("button", { name: "New Python node", exact: true }),
  ).toBeDisabled();
  await page.goto(`/projects/${worktree.project}/settings/python`);
  await expect(
    page.getByRole("checkbox", { name: /Allow dependency source builds/ }),
  ).toBeDisabled();
  await expect(
    page.getByText(/access to the secrets of all authorized/),
  ).toBeVisible();
  await page
    .getByLabel("Enable Python in this project", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/projects/${worktree.project}/settings`)
          ).json()
        ).python.enabled,
    )
    .toBe(true);
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page
    .getByRole("button", { name: "New Python node", exact: true })
    .click();
  const inspector = page.locator(".inspector");
  await inspector
    .getByRole("button", { name: "Edit code", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".monaco-editor")).toBeVisible();
  await dialog.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  const code = `import duckpad as dp
class Filter(dp.Node):
    minimum: int = dp.param(default=2, ge=0)
    def run(self, orders: dp.Relation) -> dp.Relation:
        self.message("info", "Python acceptance ran")
        return orders.filter(f"x >= {self.minimum}")
    def write(self):
        self.artifact("note.txt").write_text("Python download", encoding="utf-8")
`;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((text) => navigator.clipboard.writeText(text), code);
  await page.keyboard.press("ControlOrMeta+V");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(inspector.getByRole("textbox", { name: /minimum/ })).toHaveValue(
    "2",
  );
  let snapshot = await read();
  const node = snapshot.bundle!.flow.nodes[0];
  const flow = snapshot.bundle!.flow;
  flow.nodes.unshift({
    id: "sql",
    template: "source",
    params: {},
    position: { x: 0, y: 0 },
  });
  node.position = { x: 330, y: 0 };
  flow.nodes.push({
    id: "total",
    template: "total",
    params: {},
    position: { x: 660, y: 0 },
  });
  flow.edges = [
    {
      id: "a",
      source: "sql",
      sourceHandle: "result",
      target: node.id,
      targetHandle: "orders",
    },
    {
      id: "b",
      source: node.id,
      sourceHandle: "result",
      target: "total",
      targetHandle: "source",
    },
  ];
  const saved = await page.request.put(endpoint, {
    data: {
      revision: snapshot.revision,
      files: {
        ...snapshot.files,
        "flow.json": JSON.stringify(flow),
        "templates/source.sql":
          "-- @output result\nSELECT * FROM range(5) t(x)",
        "templates/total.sql":
          "-- @input source\n-- @output result\nSELECT sum(x) total FROM {{ source }}",
      },
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  await expect
    .poll(
      async () => {
        const state = await (
          await page.request.get(`${endpoint}/status?environment=dev`)
        ).json();
        return state.nodes?.[node.id]?.execution_status;
      },
      { timeout: 90000 },
    )
    .toBe("success");
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page
    .locator(`.react-flow__node[data-id="${node.id}"] .node-shape`)
    .click();
  await page
    .getByRole("button", { name: /Explain this value: x, rows 1,/ })
    .click();
  await expect(page.locator(".lineage-dialog")).toContainText(
    "Opaque Python operation",
  );
  await expect(page.locator(".lineage-dialog")).toContainText(
    "captured parent results",
  );
  const parent = page.locator(".lineage-dialog details").first();
  await parent
    .getByRole("button", { name: "Trace x, row 1", exact: true })
    .click();
  await expect(page.locator(".lineage-dialog .is-source")).toBeVisible();
  await page
    .locator(".lineage-dialog")
    .getByRole("button", { name: "Back to Python step", exact: true })
    .click();
  await expect(page.locator(".lineage-dialog")).toContainText(
    "Opaque Python operation",
  );
  await page
    .locator(".lineage-dialog")
    .getByTitle("Close", { exact: true })
    .click();
  await page.getByRole("tab", { name: "Log", exact: true }).click();
  await expect(page.locator(".log-timeline")).toContainText(
    "Python acceptance ran",
  );
  await expect(
    page
      .getByRole("button", { name: /Download/ })
      .or(page.getByRole("link", { name: /Download/ }))
      .last(),
  ).toBeVisible();
  const exportResult = await (
    await page.request.get(`${endpoint}/exports/${node.id}?environment=dev`)
  ).json();
  expect(exportResult.status).toBe("available");
  const download = await page.request.get(
    `${endpoint}/exports/${node.id}/download?environment=dev&run=${exportResult.run}`,
  );
  expect(download.ok()).toBeTruthy();
  expect(await download.text()).toBe("Python download");
  const total = await (
    await page.request.get(`${endpoint}/preview/total?environment=dev`)
  ).json();
  expect(total.rows[0].values).toEqual([9]);
  snapshot = await read();
  expect(snapshot.files[`nodes/${node.id}.py`]).toContain("class Filter");
  expect(snapshot.files["uv.lock"]).toContain('name = "duckdb"');
  return { worktree: worktree.id, project: worktree.project };
}
