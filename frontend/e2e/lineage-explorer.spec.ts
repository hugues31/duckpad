import { test, expect, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };

test.setTimeout(120000);

async function prepare(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Password", { exact: true })
    .fill("duckpad-browser-test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace", exact: true }),
  ).toBeVisible();
  const project = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  await page.evaluate(
    (id) => localStorage.setItem("duckpad-worktree", id),
    project.id,
  );
  await page.reload();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const run = await (await response).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      { timeout: 60000 },
    )
    .toBe("success");
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  const cell = page.getByRole("button", {
    name: /Explain this value: revenue, rows 1,/,
  });
  await cell.click();
  await expect(page.locator(".lineage-panel")).toContainText("Step explained");
  return { project, cell };
}

async function open(page: Page) {
  await page
    .getByRole("button", { name: "Explore lineage", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Explore lineage",
    exact: true,
  });
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    1,
  );
  return dialog;
}

test("pinned target, complete role topology, synchronized navigation and restored workspace", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { project, cell } = await prepare(page);
  const before = await (
    await page.request.get(`/api/worktrees/${project.id}`)
  ).json();
  const canvas = await page
    .locator(".canvas .react-flow__viewport")
    .getAttribute("style")
    .catch(() => null);
  const dialog = await open(page);
  const pinned = await dialog.getByTestId("lineage-target").innerText();
  await dialog.getByRole("button", { name: /Inspect source row/ }).click();
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    25,
  );
  await expect(dialog.locator(".lineage-records-pager")).toContainText(
    "1–25 / 27",
  );
  await expect(
    dialog.getByRole("region", { name: "Step inspector" }),
  ).toContainText("SUM");
  await expect(dialog.getByTestId("lineage-target")).toHaveText(pinned, {
    useInnerText: true,
  });
  await expect(dialog.locator(".lineage-coverage")).toContainText(
    "Upstream not explored",
  );
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await expect(dialog.locator(".lineage-records-pager")).toContainText(
    "26–27 / 27",
  );
  await dialog
    .getByRole("button", { name: "Detailed path", exact: true })
    .click();
  await expect(dialog.locator(".lineage-records-pager")).toContainText(
    "26–27 / 27",
  );
  await expect(
    dialog.getByRole("list", { name: "Detailed contribution path" }),
  ).toContainText("Regional");
  await dialog.getByRole("button", { name: "Graph", exact: true }).click();
  await dialog.getByLabel("Search steps or roles").fill("amount");
  await expect(
    dialog.locator(".lineage-search-results button").first(),
  ).toContainText("amount");
  await dialog.locator(".lineage-search-results button").first().click();
  await expect(
    dialog
      .getByLabel("Contribution role", { exact: true })
      .locator("option:checked"),
  ).toContainText("amount");
  await dialog.getByLabel("Search steps or roles").fill("");
  await dialog.getByLabel("Collapse components").check();
  await expect(dialog.locator(".lineage-graph")).toContainText(
    "Upstream not explored",
  );
  await dialog.getByLabel("Collapse components").uncheck();
  await dialog
    .getByRole("separator", { name: "Resize step inspector" })
    .focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    dialog.getByRole("separator", { name: "Resize step inspector" }),
  ).toHaveAttribute("aria-valuenow", "360");
  await dialog
    .getByRole("separator", { name: "Resize contributing records" })
    .focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    dialog.getByRole("separator", { name: "Resize contributing records" }),
  ).toHaveAttribute("aria-valuenow", "290");
  await dialog
    .getByRole("button", { name: /Inspect source row/ })
    .first()
    .click();
  await expect(
    dialog
      .getByRole("navigation", { name: "Investigation breadcrumb" })
      .locator("button"),
  ).toHaveCount(4);
  await expect(dialog.getByTestId("lineage-target")).toHaveText(pinned, {
    useInnerText: true,
  });
  await dialog
    .getByRole("button", { name: "Back to target", exact: true })
    .click();
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    1,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Explore lineage", exact: true }),
  ).toBeFocused();
  await expect(cell).toHaveClass(/lineage-selected-cell/);
  await page
    .locator(".lineage-panel")
    .getByTitle("Close", { exact: true })
    .click();
  await expect(cell).toBeFocused();
  if (canvas)
    await expect(page.locator(".canvas .react-flow__viewport")).toHaveAttribute(
      "style",
      canvas,
    );
  const after = await (
    await page.request.get(`/api/worktrees/${project.id}`)
  ).json();
  expect(after.commit).toBe(before.commit);
  expect(after.revision).toBe(before.revision);
  expect(errors).toEqual([]);
});

test("cancel and retry discard delayed records; role pages cannot overwrite another role", async ({
  page,
}) => {
  await prepare(page);
  const dialog = await open(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted!: () => void;
  const seen = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  await page.route(
    "**/lineage/records",
    async (route) => {
      const response = await route.fetch();
      intercepted();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    },
    { times: 1 },
  );
  await dialog.getByRole("button", { name: /Inspect source row/ }).click();
  await seen;
  await dialog
    .getByRole("button", { name: "Cancel investigation request" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Investigation paused");
  release();
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    25,
  );
  await dialog.getByLabel("Contribution role", { exact: true }).selectOption({
    label: await dialog
      .getByLabel("Contribution role", { exact: true })
      .locator("option")
      .filter({ hasText: "Selection / condition" })
      .first()
      .innerText(),
  });
  await expect(dialog.locator(".lineage-role-summary h4")).toHaveText(
    "Selection / condition",
  );
  await expect(dialog.locator(".lineage-records-caption")).toContainText(
    "not additive terms",
  );
});

test("recalculation interrupts cached stages and keeps the original target pinned", async ({
  page,
}) => {
  const { project } = await prepare(page);
  const dialog = await open(page);
  const pinned = await dialog.getByTestId("lineage-target").innerText();
  await page.request.post(`/api/worktrees/${project.id}/runs`, {
    data: { environment: "dev" },
  });
  await expect(dialog).toContainText("This exploration was interrupted");
  await expect(dialog.locator(".lineage-records-table")).toHaveCount(0);
  await expect(dialog.getByTestId("lineage-target")).toHaveText(pinned, {
    useInnerText: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Back to target" }),
  ).toBeDisabled();
});

test("narrow dark French workspace supports panel tabs, focus and Escape", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() => {
    localStorage.setItem("duckpad-language", "fr");
    localStorage.setItem("duckpad-theme", "dark");
  });
  await page.reload();
  await page.setViewportSize({ width: 760, height: 900 });
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel(fr.output, { exact: true }).selectOption("report");
  await page
    .getByRole("button", {
      name: new RegExp(`${fr.explain}: revenue, ${fr.rows} 1,`),
    })
    .click();
  await page
    .getByRole("button", { name: fr.exploreLineage, exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: fr.exploreLineage,
    exact: true,
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog
    .getByRole("tab", { name: fr.explorer_records, exact: true })
    .click();
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    1,
  );
  await dialog
    .getByRole("tab", { name: fr.explorer_inspector, exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: fr.stepInspector }),
  ).toBeVisible();
  await expect(dialog.locator(".lineage-target")).toContainText(
    fr.originalTarget,
  );
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
    true,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: fr.exploreLineage, exact: true }),
  ).toBeFocused();
});

test("retained synthetic records demonstrate joins, nulls, tied extrema, distinct groups, windows and unsupported coverage", async ({
  page,
}) => {
  test.setTimeout(240000);
  await page.goto("/");
  await page
    .getByLabel("Password", { exact: true })
    .fill("duckpad-browser-test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace", exact: true }),
  ).toBeVisible();
  const project = await (
    await page.request.post("/api/projects", {
      data: { name: "Contribution cases" },
    })
  ).json();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${project.id}`)
  ).json();
  const cases = [
    ["extrema", "Tied maximum", "SELECT MAX(value) AS total FROM {{ source }}"],
    [
      "distinct",
      "Distinct groups",
      "SELECT COUNT(DISTINCT value) AS total FROM {{ source }}",
    ],
    [
      "join",
      "Repeated source roles",
      "SELECT a.id, a.value + b.value AS total FROM {{ source }} a LEFT JOIN {{ source }} b ON a.id=b.id+1 ORDER BY a.id",
    ],
    [
      "window",
      "Moving total",
      "SELECT id, SUM(value) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS total FROM {{ source }} ORDER BY id",
    ],
    [
      "unsupported",
      "Multiplicity boundary",
      "SELECT value AS total FROM {{ source }} UNION ALL SELECT value FROM {{ source }}",
    ],
  ];
  const bundle = {
    flow: {
      name: "Contribution cases",
      nodes: [
        {
          id: "source",
          label: "Retained inputs",
          template: "source",
          params: {},
          position: { x: 0, y: 150 },
        },
        ...cases.map(([id, label], index) => ({
          id,
          label,
          template: id,
          params: {},
          position: { x: 300, y: index * 130 },
        })),
      ],
      edges: cases.map(([id]) => ({
        id: "edge_" + id,
        source: "source",
        sourceHandle: "result",
        target: id,
        targetHandle: "source",
      })),
    },
    templates: Object.fromEntries([
      [
        "source",
        "-- @kind source\n-- @output result\nSELECT * FROM (VALUES (1, 10), (2, 20), (3, 20), (4, NULL)) AS inputs(id, value)",
      ],
      ...cases.map(([id, , query]) => [
        id,
        "-- @input source\n-- @output result\n" + query,
      ]),
    ]),
    components: {},
    documentation: {},
  };
  expect(
    (
      await page.request.put(`/api/worktrees/${project.id}`, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  const run = await (
    await page.request.post(`/api/worktrees/${project.id}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      { timeout: 60000 },
    )
    .toBe("success");
  await page.evaluate(
    (id) => localStorage.setItem("duckpad-worktree", id),
    project.id,
  );
  await page.reload();
  const dialog = page.getByRole("dialog", {
    name: "Explore lineage",
    exact: true,
  });
  const choose = async (label: string, row = 1) => {
    await page
      .locator(".canvas .react-flow__node")
      .filter({ has: page.getByText(label, { exact: true }) })
      .click();
    await page
      .getByRole("button", {
        name: new RegExp(`Explain this value: total, rows ${row},`),
      })
      .click();
    await page
      .getByRole("button", { name: "Explore lineage", exact: true })
      .click();
    await expect(dialog.locator(".lineage-progress")).toHaveCount(0);
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await page
      .locator(".lineage-panel")
      .getByTitle("Close", { exact: true })
      .click();
  };
  await choose("Tied maximum");
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    2,
  );
  await expect(dialog.locator(".lineage-counts")).toContainText(
    "Examined input rows4",
  );
  await expect(dialog.locator(".lineage-counts")).toContainText(
    "Retained input rows / ties2",
  );
  await close();
  await choose("Distinct groups");
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    2,
  );
  await dialog
    .locator(".lineage-records-table tbody tr")
    .nth(1)
    .getByRole("button", { name: "Inspect original rows" })
    .click();
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    2,
  );
  await expect(dialog.locator(".lineage-records-table")).toContainText("#1");
  await expect(dialog.locator(".lineage-records-table")).toContainText("#2");
  await close();
  await choose("Repeated source roles");
  await expect(dialog.getByText("Captured join pairs · 1")).toBeVisible();
  await dialog
    .getByLabel("Contribution role", { exact: true })
    .selectOption({ label: "Value contribution · b · value (0)" });
  await expect(dialog.locator(".lineage-records-scroll").last()).toContainText(
    "No matching row",
  );
  await close();
  await choose("Repeated source roles", 2);
  await expect(dialog.locator(".lineage-target-value")).toHaveText("30");
  await expect(
    dialog.getByLabel("Contribution role", { exact: true }).locator("option"),
  ).toContainText(["Value contribution · a", "Value contribution · b"]);
  await close();
  await choose("Moving total", 3);
  await expect(dialog.locator(".lineage-target-value")).toHaveText("40");
  await expect(dialog.locator(".lineage-records-table tbody tr")).toHaveCount(
    2,
  );
  await expect(
    dialog.getByText("Window partition, order and frame"),
  ).toBeVisible();
  await close();
  await choose("Multiplicity boundary");
  await expect(dialog.locator(".lineage-coverage")).toContainText(
    "Unsupported operation",
  );
  await expect(dialog.locator(".lineage-records-table")).toHaveCount(0);
});
