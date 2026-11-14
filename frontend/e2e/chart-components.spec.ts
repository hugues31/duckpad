import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Run, Snapshot } from "../src/types";

const AMOUNTS = {
  name: "Amount by channel",
  spec: {
    mark: "bar",
    encoding: {
      x: { field: "channel", type: "nominal" },
      y: { field: "amount", type: "quantitative" },
    },
  },
};

const snapshotOf = async (page: Page, worktree: string): Promise<Snapshot> =>
  (await page.request.get(`/api/worktrees/${worktree}`)).json();

/** Run the worktree in dev and wait for the run to finish. */
async function run(page: Page, worktree: string) {
  const launched = await (
    await page.request.post(`/api/worktrees/${worktree}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/runs/${launched.id}`)
          ).json()) as Run
        ).status,
      { timeout: 45000 },
    )
    .toMatch(/success|partial_failure|failed/);
}

test("a chart follows its node into a component instance and renders there", async ({
  page,
}) => {
  await signIn(page);
  const worktree = (
    await (await page.request.post("/api/example", { data: {} })).json()
  ).id as string;
  const snapshot = await snapshotOf(page, worktree);
  const saved = await page.request.put(`/api/worktrees/${worktree}`, {
    data: {
      revision: snapshot.revision,
      bundle: {
        ...snapshot.bundle,
        charts: { "validated:orders": [AMOUNTS] },
      },
    },
  });
  expect(saved.ok()).toBe(true);

  await page.goto(`/worktrees/${worktree}/flow`);
  await page
    .locator('.react-flow__node[data-id="validated"] .node-shape')
    .click();
  await page.locator(".group-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Component name").fill("Paid orders group");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The chart key moves to the instance; the definition carries no chart.
  let grouped = await snapshotOf(page, worktree);
  await expect
    .poll(async () => {
      grouped = await snapshotOf(page, worktree);
      return Object.keys(grouped.bundle!.charts ?? {});
    })
    .toEqual([expect.stringMatching(/::validated:orders$/)]);
  const instance = Object.keys(grouped.bundle!.charts!)[0].split("::")[0];
  const component = grouped.bundle!.flow.nodes.find(
    (item) => item.id === instance,
  )!.component!;
  expect(grouped.bundle!.components[component]).not.toHaveProperty("charts");

  await run(page, worktree);
  await page.goto(`/worktrees/${worktree}/flow?node=${instance}`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  const chart = panel.locator(".chart-view svg");
  await expect(chart).toBeVisible();
  await expect(chart.locator(".mark-rect path").first()).toBeVisible();
  await expect(chart).toContainText("channel");
});
