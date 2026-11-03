import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./helpers";

async function example(page: Page) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const run = await (
    await page.request.post(`/api/worktrees/${worktree.id}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      { timeout: 30000 },
    )
    .toBe("success");
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  return worktree.id as string;
}

async function explain(page: Page, column = "revenue", row = 1) {
  const trigger = page.getByRole("button", {
    name: new RegExp(`Explain this value: ${column}, rows ${row},`),
  });
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".lineage-card.root")).toBeVisible();
  await expect(page.locator(".lineage-loading")).toHaveCount(0);
  return trigger;
}

async function ready(page: Page) {
  await expect(page.locator(".lineage-loading")).toHaveCount(0);
  await expect(page.locator(".lineage-card.root button").last()).toBeEnabled();
}

test("a value opens a large calculation DAG with sources, pagination and no pass-through steps", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await example(page);
  const trigger = await explain(page);
  const dialog = page.getByRole("dialog");
  expect((await dialog.boundingBox())!.width).toBeGreaterThan(1100);
  await expect(dialog.locator(".lineage-card.calculation")).toHaveCount(1);
  await expect(dialog.locator(".lineage-card.is-source")).toHaveCount(5);
  await expect(dialog.locator(".react-flow__edge")).toHaveCount(5);
  await expect
    .poll(async () =>
      dialog.evaluate((element) => {
        const source = element.querySelector(".lineage-card.is-source")!;
        const handle = source
          .querySelector(".react-flow__handle")!
          .getBoundingClientRect();
        const path = element.querySelector<SVGPathElement>(
          ".react-flow__edge-path",
        )!;
        const start = path
          .getPointAtLength(0)
          .matrixTransform(path.getScreenCTM()!);
        return (
          Math.abs(start.x - handle.right) +
          Math.abs(start.y - (handle.top + handle.height / 2))
        );
      }),
    )
    .toBeLessThan(2);
  await expect(dialog.locator(".lineage-equation")).toHaveText(
    "SUM(amount) = 7131",
  );
  await expect(dialog).toContainText("Sum of 27 contributing values");
  await expect(dialog.locator(".lineage-page")).toContainText("1–5 / 27");
  await expect(dialog).not.toContainText("Follow this value");
  await expect(dialog.getByRole("button", { name: /Play/ })).toHaveCount(0);
  expect(
    await dialog
      .locator(".lineage-selected strong")
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeLessThanOrEqual(14);
  await page.mouse.move(100, 50);
  await page.screenshot({ path: "test-results/lineage-graph.png" });
  const first = await dialog
    .locator(".lineage-card.is-source")
    .first()
    .innerText();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await expect(dialog.locator(".lineage-page")).toContainText("6–10 / 27");
  await ready(page);
  expect(
    await dialog.locator(".lineage-card.is-source").first().innerText(),
  ).not.toBe(first);
  await expect(dialog.locator(".lineage-card.calculation")).toHaveCount(1);
  await dialog
    .getByRole("button", { name: /Source and selection details/ })
    .first()
    .click();
  await expect(dialog.locator(".lineage-details")).toContainText(
    "Row selection",
  );
  await expect(
    dialog.locator(".lineage-details table tbody tr").first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

test("shared sources feed both calculations and unchanged arithmetic is not collapsed", async ({
  page,
}) => {
  await example(page);
  const source = {
    dataset: "shared-source",
    row: 0,
    column: "amount",
    node: "orders",
    port: "result",
    value: 10,
    source: true,
  };
  const left = {
    dataset: "left",
    row: 0,
    column: "doubled",
    value: 20,
    node: "double",
  };
  const right = {
    dataset: "right",
    row: 0,
    column: "unchanged",
    value: 10,
    node: "multiply",
  };
  await page.route("**/lineage", (route) => {
    const cell = route.request().postDataJSON();
    const isLeft = cell.dataset === "left";
    const isRight = cell.dataset === "right";
    const evaluated = isLeft ? "10 * 2" : isRight ? "10 * 1" : "20 + 10";
    return route.fulfill({
      json: {
        ...cell,
        value: isLeft ? 20 : isRight ? 10 : 30,
        kind: "projection",
        complete: true,
        warnings: [],
        total: isLeft || isRight ? 1 : 2,
        page_size: 5,
        context_total: 0,
        contributions: isLeft || isRight ? [source] : [left, right],
        calculation: {
          operation: "expression",
          formula: evaluated,
          evaluated,
          passthrough: false,
        },
      },
    });
  });
  await explain(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".lineage-card.calculation")).toHaveCount(3);
  await expect(dialog.locator(".lineage-card.is-source")).toHaveCount(1);
  await expect(dialog.locator(".react-flow__edge")).toHaveCount(4);
  await expect(dialog.getByText("10 * 1 = 10", { exact: true })).toBeVisible();
  await expect(dialog.getByText("10 * 2 = 20", { exact: true })).toBeVisible();
  await expect(dialog.getByText("20 + 10 = 30", { exact: true })).toBeVisible();
});

test("distinct groups open their original rows without changing the calculated count", async ({
  page,
}) => {
  await example(page);
  await explain(page, "customers");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Counts 3 distinct values");
  await expect(
    dialog.getByRole("button", { name: /Show source rows/ }),
  ).toHaveCount(3);
  const value = await dialog.locator(".lineage-selected").innerText();
  await dialog
    .getByRole("button", { name: /Show source rows/ })
    .first()
    .click();
  await ready(page);
  await expect(dialog).toContainText("Showing rows for");
  await expect(dialog.locator(".lineage-card.is-source")).toHaveCount(5);
  await expect(dialog.locator(".lineage-selected")).toHaveText(value, {
    useInnerText: true,
  });
  await dialog.getByRole("button", { name: "All value groups" }).click();
  await ready(page);
  await expect(
    dialog.getByRole("button", { name: /Show source rows/ }),
  ).toHaveCount(3);
});

test("recalculation interrupts an open DAG and disables all old graph navigation", async ({
  page,
}) => {
  const worktree = await example(page);
  await explain(page);
  await page.request.post(`/api/worktrees/${worktree}/runs`, {
    data: { environment: "dev" },
  });
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "This exploration was interrupted",
  );
  await expect(page.locator(".lineage-card")).toHaveCount(0);
});

test("verification stops after a missing result and an expired session signs out", async ({
  page,
}) => {
  await example(page);
  await explain(page);
  let status = 404;
  const checks: number[] = [];
  await page.route("**/generations/**", (route) => {
    checks.push(status);
    return route.fulfill({ status, json: { error: "Dataset not found" } });
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Dataset not found");
  // Verification runs every 500 ms while it can still succeed.
  await page.waitForTimeout(1500);
  expect(checks).toEqual([404]);

  status = 401;
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(checks).toEqual([404, 401]);
});

test("closing a loading cell discards its late response before opening another cell", async ({
  page,
}) => {
  await example(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = false;
  await page.route("**/lineage", async (route) => {
    if (!delayed) {
      delayed = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  await expect.poll(() => delayed).toBe(true);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await explain(page, "revenue", 2);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator(".lineage-selected")).toContainText("Row 2");
  await expect(page.locator(".lineage-selected")).toContainText("6941");
});

test("errors can be retried and coverage limits never invent source nodes", async ({
  page,
}) => {
  await example(page);
  let fail = true;
  await page.route("**/lineage", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: "Temporarily unavailable" },
        })
      : route.fulfill({
          json: {
            ...route.request().postDataJSON(),
            value: 0,
            complete: false,
            warnings: ["This SQL construct is not supported."],
            contributions: [],
            total: 0,
            context_total: 0,
            page_size: 5,
          },
        }),
  );
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText(
    "Temporarily unavailable",
  );
  fail = false;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog).toContainText("Coverage limitation");
  await expect(dialog.locator(".lineage-card.is-source")).toHaveCount(0);
  await dialog
    .getByRole("button", {
      name: "Calculation and selection details",
      exact: true,
    })
    .click();
  await expect(dialog.locator(".lineage-details")).toContainText(
    "This SQL construct is not supported.",
  );
});

test("the modal traps keyboard focus and supports French, dark mode and a narrow screen", async ({
  page,
}) => {
  await example(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await explain(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  const accessibility = await new AxeBuilder({ page })
    .include(".lineage-dialog")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Menu du compte", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Sombre", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Expliquer cette valeur: revenue, lignes 1,/ })
    .click();
  await expect(dialog).toHaveAccessibleName(
    "Comment cette valeur a été calculée",
  );
  await expect(dialog.locator(".lineage-card.root")).toBeVisible();
  await expect(dialog.locator(".lineage-loading")).toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(async () => {
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  }).toPass({ timeout: 10000 });
  await expect
    .poll(async () => {
      const root = await dialog.locator(".lineage-card.root").boundingBox();
      return !!root && root.x >= 0 && root.x + root.width <= 600;
    })
    .toBe(true);
  await page.screenshot({ path: "test-results/lineage-french-dark.png" });
});

test("source NULL and literal zero values remain visible without artificial operations", async ({
  page,
}) => {
  await example(page);
  let source = true;
  await page.route("**/lineage", (route) => {
    const cell = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ...cell,
        value: source ? null : 0,
        kind: source ? "source" : "projection",
        complete: true,
        warnings: [],
        contributions: [],
        total: 0,
        context_total: 0,
        page_size: 5,
        ...(source
          ? {}
          : {
              calculation: {
                operation: "expression",
                formula: "0",
                evaluated: "0",
                passthrough: false,
              },
            }),
      },
    });
  });
  await explain(page);
  await expect(page.locator(".lineage-selected")).toContainText("NULL");
  await expect(page.locator(".lineage-card")).toHaveCount(1);
  await expect(page.locator(".lineage-card.is-source")).toHaveCount(1);
  await page.keyboard.press("Escape");
  source = false;
  await explain(page, "revenue", 2);
  await expect(page.locator(".lineage-equation")).toHaveText("0 = 0");
  await expect(page.locator(".lineage-card")).toHaveCount(1);
});
