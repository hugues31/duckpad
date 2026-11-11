import { expect, test, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import { signIn } from "./helpers";
import type { PreviewPage, Run, Snapshot } from "../src/types";

const encoding = {
  x: { field: "channel", type: "nominal" },
  y: { field: "amount", type: "quantitative" },
};
const BARS = { name: "Amount by channel", spec: { mark: "bar", encoding } };
const POINTS = { name: "Amounts as points", spec: { mark: "point", encoding } };

const snapshotOf = async (page: Page, worktree: string): Promise<Snapshot> =>
  (await page.request.get(`/api/worktrees/${worktree}`)).json();

const history = async (page: Page, worktree: string) =>
  (
    await (
      await page.request.get(`/api/worktrees/${worktree}/git/history`)
    ).json()
  ).items as { commit: string; parents: string[] }[];

/** A run Northstar project whose charts.json holds `charts`, or no charts.json. */
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
  const snapshot = await snapshotOf(page, example.id);
  if (charts || snapshot.files["charts.json"] !== undefined) {
    const saved = await page.request.put(`/api/worktrees/${example.id}`, {
      data: {
        revision: snapshot.revision,
        bundle: { ...snapshot.bundle, charts },
      },
    });
    expect(saved.ok()).toBe(true);
  }
  return example.id as string;
}

/** The Chart tab of a node's results. */
async function chartTab(page: Page, worktree: string, node: string) {
  await page.goto(`/worktrees/${worktree}/flow?node=${node}`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await expect(panel.locator(".results-header .badge")).toHaveText("Valid");
  await panel.getByRole("tab", { name: en.results_chart, exact: true }).click();
  return panel;
}

test("two charts of an output are switched by name and follow the theme", async ({
  page,
}) => {
  const worktree = await chartedProject(page, {
    "validated:orders": [BARS, POINTS],
  });
  const panel = await chartTab(page, worktree, "validated");
  const selector = panel.getByRole("group", { name: en.chartSelector });
  const bars = selector.getByRole("button", { name: BARS.name });
  const points = selector.getByRole("button", { name: POINTS.name });
  await expect(bars).toHaveAttribute("aria-pressed", "true");
  await expect(points).toHaveAttribute("aria-pressed", "false");
  const figure = panel.getByRole("figure");
  const chart = panel.locator(".chart-view svg");
  await expect(figure).toHaveAccessibleName(BARS.name);
  await expect(chart.locator(".mark-rect path").first()).toBeVisible();

  await points.click();
  await expect(points).toHaveAttribute("aria-pressed", "true");
  await expect(figure).toHaveAccessibleName(POINTS.name);
  await expect(chart.locator(".mark-symbol path").first()).toBeVisible();
  await expect(chart.locator(".mark-rect")).toHaveCount(0);

  // The axis labels take the colors of the theme, and change with it.
  const label = chart.locator(".role-axis-label text").first();
  const light = await label.getAttribute("fill");
  await page.locator(".account .avatar").click();
  await page.getByRole("menuitemradio", { name: en.dark, exact: true }).click();
  await expect(label).not.toHaveAttribute("fill", light!);
  await expect(figure).toHaveAccessibleName(POINTS.name);
});

test("an input dataset shows the charts of the output it reads", async ({
  page,
}) => {
  const worktree = await chartedProject(page, { "validated:orders": [BARS] });
  // Customer reach has no chart: it reads Paid orders.
  const panel = await chartTab(page, worktree, "reach");
  await expect(panel.getByText(en.chartNone, { exact: true })).toBeVisible();
  await panel
    .getByRole("combobox", { name: en.output, exact: true })
    .selectOption("input:source");
  await expect(panel.getByRole("figure")).toHaveAccessibleName(BARS.name);
  await expect(
    panel.locator(".chart-view svg .mark-rect path").first(),
  ).toBeVisible();
});

test("Add a chart creates charts.json in one commit and opens it in Code", async ({
  page,
}) => {
  const worktree = await chartedProject(page, null);
  const before = await history(page, worktree);
  const panel = await chartTab(page, worktree, "validated");
  await expect(panel.getByText(en.chartNone, { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: en.chartAdd, exact: true }).click();

  await expect(page).toHaveURL(/\/code(\?|$)/);
  await expect(page.locator(".code-file-heading")).toContainText("charts.json");
  const after = await history(page, worktree);
  expect(after[1].commit).toBe(before[0].commit);
  expect(after[0].parents).toEqual([before[0].commit]);
  const preview: PreviewPage = await (
    await page.request.get(
      `/api/worktrees/${worktree}/preview/validated?environment=dev&port=orders&limit=1`,
    )
  ).json();
  const [x, y] = preview.columns.map((column) => column.name);
  const snapshot = await snapshotOf(page, worktree);
  expect(JSON.parse(snapshot.files["charts.json"])).toEqual({
    "validated:orders": [
      {
        name: en.chartStarterName,
        spec: {
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          mark: { type: "bar", tooltip: true },
          encoding: {
            x: { field: x, type: "nominal" },
            y: { field: y, type: "quantitative" },
          },
        },
      },
    ],
  });
  expect(snapshot.diagnostics).toEqual([]);

  await page.getByRole("link", { name: en.flow, exact: true }).click();
  await panel.getByRole("tab", { name: en.results_chart, exact: true }).click();
  await expect(panel.getByRole("figure")).toHaveAccessibleName(
    en.chartStarterName,
  );
});

test("Add a chart on a stale revision reports the conflict and keeps both changes", async ({
  page,
}) => {
  const worktree = await chartedProject(page, null);
  const panel = await chartTab(page, worktree, "validated");
  const add = panel.getByRole("button", { name: en.chartAdd, exact: true });
  await expect(add).toBeVisible();
  // The page keeps its revision while another session saves a chart.
  const stale = await snapshotOf(page, worktree);
  let held = true;
  await page.route(`**/api/worktrees/${worktree}`, async (route) => {
    if (route.request().method() !== "GET") held = false;
    if (held && route.request().method() === "GET")
      await route.fulfill({ json: stale });
    else await route.continue();
  });
  const other = { name: en.chartStarterName, spec: { mark: "line", encoding } };
  const saved = await page.request.put(`/api/worktrees/${worktree}`, {
    data: {
      revision: stale.revision,
      bundle: { ...stale.bundle, charts: { "validated:orders": [other] } },
    },
  });
  expect(saved.ok()).toBe(true);

  await add.click();
  // The saved chart shows, and the retained proposal waits for a resolution.
  await expect(page.locator(".banner.warning")).toContainText(en.conflictHint);
  await expect(panel.getByRole("figure")).toHaveAccessibleName(other.name);
  await expect(page).toHaveURL(/\/flow/);
  const snapshot = await snapshotOf(page, worktree);
  expect(JSON.parse(snapshot.files["charts.json"])).toEqual({
    "validated:orders": [other],
  });
  expect(snapshot.conflicts).toHaveLength(1);
  const [conflict] = snapshot.conflicts;
  // One conflict for the whole chart, never one per spec field.
  expect(conflict.paths).toEqual([
    `charts.json/validated:orders/${en.chartStarterName}`,
  ]);
  expect(
    JSON.parse(conflict.proposal["charts.json"])["validated:orders"][0].spec
      .mark,
  ).toEqual({ type: "bar", tooltip: true });
});

test("readers and read-only branches see no Add a chart, and a reader cannot save one", async ({
  page,
}) => {
  const worktree = await chartedProject(page, null);
  // A read-only branch, such as Job results, shows only the explanation.
  await page.route(`**/api/worktrees/${worktree}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const snapshot: Snapshot = await response.json();
    snapshot.worktree.read_only = true;
    await route.fulfill({ response, json: snapshot });
  });
  let panel = await chartTab(page, worktree, "validated");
  await expect(panel.getByText(en.chartNone, { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: en.chartAdd, exact: true }),
  ).toHaveCount(0);
  await page.unrouteAll();

  const before = await snapshotOf(page, worktree);
  const username = `chart-reader-${Date.now()}`;
  const password = `reader-${Date.now()}-pw`;
  const reader = await (
    await page.request.post("/api/users", { data: { username, password } })
  ).json();
  expect(
    (
      await page.request.put(
        `/api/projects/${before.worktree.project}/members/${reader.id}`,
        { data: { role: "reader" } },
      )
    ).ok(),
  ).toBe(true);
  await page.request.post("/api/logout");
  expect(
    (
      await page.request.post("/api/login", { data: { username, password } })
    ).ok(),
  ).toBe(true);
  panel = await chartTab(page, worktree, "validated");
  await expect(panel.getByText(en.chartNone, { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: en.chartAdd, exact: true }),
  ).toHaveCount(0);
  const refused = await page.request.put(`/api/worktrees/${worktree}`, {
    data: {
      revision: before.revision,
      bundle: { ...before.bundle, charts: { "validated:orders": [BARS] } },
    },
  });
  expect(refused.status()).toBe(403);
  expect((await snapshotOf(page, worktree)).revision).toBe(before.revision);
});

test("a chart with an unknown field shows the error instead of the previous chart", async ({
  page,
}) => {
  const worktree = await chartedProject(page, {
    "validated:orders": [
      BARS,
      {
        name: "Misspelled field",
        spec: {
          mark: "bar",
          encoding: {
            ...encoding,
            y: { field: "amont", type: "quantitative" },
          },
        },
      },
    ],
  });
  const panel = await chartTab(page, worktree, "validated");
  await expect(panel.locator(".chart-view svg")).toHaveCount(1);

  await panel.getByRole("button", { name: "Misspelled field" }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    en.chartUnknownFields.replace("{fields}", "amont"),
  );
  await expect(panel.locator(".chart-view svg")).toHaveCount(0);
});
