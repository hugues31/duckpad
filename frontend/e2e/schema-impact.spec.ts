import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

async function project(page: Page) {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/projects", {
      data: { name: "Schema impact" },
    })
  ).json();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  const files = {
    ...snapshot.files,
    "flow.json": JSON.stringify({
      nodes: [{ id: "source" }, { id: "total" }],
      edges: [
        {
          id: "e",
          source: "source",
          sourceHandle: "result",
          target: "total",
          targetHandle: "input",
        },
      ],
    }),
    "nodes/source.sql": "-- @output result\nSELECT 1::INTEGER AS amount;",
    "nodes/total.sql":
      "-- @input input\n-- @output result\nSELECT SUM(amount) AS total FROM {{ input }};",
  };
  const response = await page.request.put(`/api/worktrees/${tree.id}`, {
    data: { revision: snapshot.revision, files },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return tree.id as string;
}

test("simulate a type without a run or a save, and clear old results when editing the type", async ({
  page,
}) => {
  const id = await project(page);
  const original = await (
    await page.request.get(`/api/worktrees/${id}`)
  ).json();
  await page.goto(
    `/worktrees/${id}/flow?lineage=source&output=result&column=amount&direction=impact`,
  );
  const panel = page.getByRole("complementary", {
    name: "Lineage",
    exact: true,
  });
  await panel.getByText("Simulate a type change…", { exact: true }).click();
  const form = panel
    .locator("details")
    .filter({ hasText: "Simulate a type change…" });
  await form.getByLabel("New type").fill("VARCHAR");
  await form.getByRole("button", { name: "Simulate", exact: true }).click();
  await expect(
    form.getByRole("heading", { name: "Compilation errors (1)" }),
  ).toBeVisible();
  await expect(form.locator("pre")).toContainText("Binder Error");
  await expect(
    form.getByRole("link", { name: "Open code" }).first(),
  ).toHaveAttribute("href", /total/);
  await form.getByLabel("New type").fill("DOUBLE");
  await expect(form.locator("pre")).toHaveCount(0);
  await form.getByRole("button", { name: "Simulate", exact: true }).click();
  await expect(
    form.getByText("No compilation errors in the checked queries."),
  ).toBeVisible();
  const unchanged = await (
    await page.request.get(`/api/worktrees/${id}`)
  ).json();
  expect(unchanged.revision).toBe(original.revision);
  const statuses = await (
    await page.request.get(`/api/worktrees/${id}/status?environment=dev`)
  ).json();
  expect(statuses.active).toBeNull();
});

test("merge review identifies a renamed column and its unchanged broken consumer", async ({
  page,
}) => {
  const id = await project(page);
  const branch = await (
    await page.request.post(`/api/worktrees/${id}/branches`, {
      data: { name: "rename-amount" },
    })
  ).json();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${branch.id}`)
  ).json();
  const save = await page.request.put(`/api/worktrees/${branch.id}`, {
    data: {
      revision: snapshot.revision,
      files: {
        ...snapshot.files,
        "nodes/source.sql": "-- @output result\nSELECT 1::INTEGER AS value;",
      },
    },
  });
  expect(save.ok(), await save.text()).toBeTruthy();
  await page.goto(`/worktrees/${branch.id}/flow`);
  await page
    .getByRole("button", { name: "Compare & merge", exact: true })
    .click();
  const review = page.getByRole("dialog", { name: "Project Git workspace" });
  const impact = review.getByRole("region", { name: "Schema impact" });
  await expect(
    impact.getByRole("heading", { name: "Compilation errors (1)" }),
  ).toBeVisible();
  await expect(impact).toContainText("Unchanged by the merge");
  await expect(impact).toContainText("Renamed: amount → value");
  await expect(impact.locator("pre")).toContainText("amount");
});
