import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Run, Snapshot } from "../src/types";

const AMOUNTS = {
  name: "Amount by channel",
  spec: {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    mark: "bar",
    encoding: {
      x: { field: "channel", type: "nominal" },
      y: { field: "amount", type: "quantitative" },
    },
  },
};

/** A run Northstar project whose charts.json holds `charts`. */
async function chartedProject(page: Page, charts: unknown) {
  await signIn(page);
  const example = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const launched = await (
    await page.request.post(`/api/worktrees/${example.id}/runs`, {
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
  const snapshot: Snapshot = await (
    await page.request.get(`/api/worktrees/${example.id}`)
  ).json();
  const saved = await page.request.put(`/api/worktrees/${example.id}`, {
    data: {
      revision: snapshot.revision,
      bundle: { ...snapshot.bundle, charts },
    },
  });
  expect(saved.ok()).toBe(true);
  return example.id as string;
}

test("a chart of charts.json renders as SVG in the Chart tab, loading Vega on first open", async ({
  page,
}) => {
  const worktree = await chartedProject(page, {
    "validated:orders": [AMOUNTS],
  });
  // The chunks of vega-embed and vega-interpreter, split from the main bundle.
  const vegaChunk = (url: string) =>
    /\/assets\/(embed|vega)[\w.-]*\.js$/.test(url);
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  await page.goto(`/worktrees/${worktree}/flow?node=validated`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await expect(panel.locator(".results-header .badge")).toHaveText("Valid");
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter(vegaChunk)).toEqual([]);

  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  await expect.poll(() => scripts.filter(vegaChunk).length).toBe(2);
  const chart = panel.locator(".chart-view svg");
  await expect(chart).toBeVisible();
  await expect(chart.locator(".mark-rect path").first()).toBeVisible();
  await expect(chart).toContainText("channel");
});

test("no chart renders while charts.json has a diagnostic", async ({
  page,
}) => {
  const worktree = await chartedProject(page, {
    "validated:orders": [{ ...AMOUNTS, owner: "someone" }],
  });
  await page.goto(`/worktrees/${worktree}/flow?node=validated`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("unknown fields: owner");
  await expect(panel.locator(".chart-view")).toHaveCount(0);
  await expect(panel.locator("svg.marks")).toHaveCount(0);
});
