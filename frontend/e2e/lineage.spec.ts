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
  await page
    .getByRole("button", {
      name: new RegExp(`Explain this value: ${column}, rows ${row},`),
    })
    .click();
  await expect(page.locator(".lineage-loading")).toHaveCount(0);
  await expect(page.locator(".lineage-result")).toBeVisible();
}

async function ready(page: Page) {
  await expect(page.locator(".lineage-loading")).toHaveCount(0);
  await expect(page.locator(".lineage-step-heading").first()).toBeEnabled();
}

test("a real value keeps its result, follows inputs to source and replays the chosen path", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await example(page);
  await explain(page);
  const panel = page.locator(".lineage-panel");
  const result = await panel.locator(".lineage-result").innerText();
  await expect(panel.locator(".lineage-step")).toHaveCount(2);
  await expect(panel).toContainText("27 contributions");
  await expect(panel.locator(".inspector-title")).toBeInViewport();
  await expect(panel.locator(".lineage-result .eyebrow")).toBeInViewport();
  await expect(panel.locator(".lineage-step-heading").first()).toBeInViewport();
  await page.mouse.move(800, 400);
  await page.screenshot({ path: "test-results/lineage-timeline.png" });
  await expect(panel.locator("pre.expression")).toBeHidden();
  await panel.getByText("View calculation", { exact: true }).click();
  await expect(panel.locator("pre.expression")).toContainText("SUM");
  await panel.getByRole("button", { name: "Next", exact: true }).click();
  await expect(panel.locator(".pager")).toContainText("10 / 27");
  await panel.locator(".contribution").first().click();
  await expect(panel.getByText(/You have reached the start/)).toBeVisible();
  await ready(page);
  const length = await panel.locator(".lineage-step").count();
  expect(length).toBeGreaterThan(3);
  await expect(panel.locator(".lineage-result")).toHaveText(result, {
    useInnerText: true,
  });
  // Revisit the aggregate and choose another input; the old branch is replaced.
  await panel.locator(".lineage-step-heading").nth(1).click();
  await expect(panel.locator(".pager")).toContainText("10 / 27");
  const inputValue = await panel
    .locator(".contribution-value")
    .nth(1)
    .innerText();
  await panel.locator(".contribution").nth(1).click();
  await expect(panel.getByText(/You have reached the start/)).toBeVisible();
  await ready(page);
  await expect(panel.locator(".lineage-step")).toHaveCount(length);
  await expect(panel.locator(".lineage-step-value").last()).toHaveText(
    inputValue,
  );
  await page.mouse.move(800, 400);
  await page.screenshot({ path: "test-results/lineage-source-path.png" });
  await page.clock.install();
  await panel
    .getByRole("button", { name: "Play this path", exact: true })
    .click();
  await expect(panel.locator(".lineage-step").last()).toHaveClass(/is-active/);
  await page.clock.fastForward(1800);
  await expect(panel.locator(".lineage-step").nth(length - 2)).toHaveClass(
    /is-active/,
  );
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  await page.clock.fastForward(3600);
  await expect(panel.locator(".lineage-step").nth(length - 2)).toHaveClass(
    /is-active/,
  );
  await panel
    .getByRole("button", { name: "Play this path", exact: true })
    .click();
  for (let i = 0; i < length; i++) await page.clock.fastForward(1800);
  await expect(panel.locator(".lineage-step").first()).toHaveClass(/is-active/);
  await expect(
    panel.getByRole("button", { name: "Play this path", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("distinct groups and evaluation context retain their meaning", async ({
  page,
}) => {
  await example(page);
  await explain(page, "customers");
  const panel = page.locator(".lineage-panel");
  await expect(panel).toContainText("distinct value groups");
  await panel.locator(".contribution").first().click();
  await ready(page);
  await expect(
    panel.getByRole("button", { name: "All value groups" }),
  ).toBeVisible();
  await expect(panel.locator(".contribution").first()).toContainText(
    "customer_id",
  );
  await panel.getByRole("button", { name: "All value groups" }).click();
  await ready(page);
  await expect(panel).toContainText("distinct value groups");
  await panel.getByRole("button", { name: /Why these rows/ }).click();
  await ready(page);
  await expect(panel).toContainText(
    "They are not necessarily inputs to the calculation",
  );
  await panel.locator(".contribution").first().click();
  await ready(page);
  await expect(panel).toContainText("This path explains evaluation context");
});

test("recalculation stops playback and makes the entire old path unavailable", async ({
  page,
}) => {
  const worktree = await example(page);
  await explain(page);
  const panel = page.locator(".lineage-panel");
  await panel
    .getByRole("button", { name: "Play this path", exact: true })
    .click();
  await page.request.post(`/api/worktrees/${worktree}/runs`, {
    data: { environment: "dev" },
  });
  await expect(panel.getByRole("alert")).toContainText(
    "This exploration was interrupted",
  );
  await expect(panel.locator(".lineage-step-heading")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Pause", exact: true }),
  ).toHaveCount(0);
});

test("a replacement cell ignores delayed responses from the previous exploration", async ({
  page,
}) => {
  await example(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = false;
  await page.route("**/lineage", async (route) => {
    if (route.request().postDataJSON().row === 0 && !delayed) {
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
  await explain(page, "revenue", 2);
  await expect(page.locator(".lineage-result")).toContainText("Row 2");
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator(".lineage-result")).toContainText("Row 2");
  await expect(page.locator(".lineage-panel")).toContainText("contributions");
});

test("coverage limits and request errors remain explicit and retryable", async ({
  page,
}) => {
  await example(page);
  let fail = true;
  await page.route("**/lineage", async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        json: { error: "Temporarily unavailable" },
      });
    else
      await route.fulfill({
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
      });
  });
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  const panel = page.locator(".lineage-panel");
  await expect(panel.getByRole("alert")).toContainText(
    "Temporarily unavailable",
  );
  fail = false;
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel).toContainText("Coverage limitation");
  await expect(panel).toContainText("This SQL construct is not supported.");
  await expect(panel.locator(".lineage-result strong")).toHaveText("0");
  await expect(
    panel.getByRole("button", { name: "Play this path", exact: true }),
  ).toHaveCount(0);
});

test("the timeline supports keyboard navigation, reduced motion, themes and French", async ({
  page,
}) => {
  await example(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await explain(page);
  const panel = page.locator(".lineage-panel");
  await panel.locator(".lineage-step-heading").first().focus();
  await page.keyboard.press("Enter");
  await expect(panel.locator(".lineage-step-heading").first()).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await panel
    .getByRole("button", { name: "Play this path", exact: true })
    .click();
  expect(
    await panel
      .locator(".is-active .lineage-marker")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await panel.getByRole("button", { name: "Pause", exact: true }).click();
  const accessibility = await new AxeBuilder({ page })
    .include(".lineage-panel")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await expect(panel).toContainText("Valeur sélectionnée");
  await expect(
    panel.getByRole("button", { name: "Lire ce parcours", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Menu du compte", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Sombre", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 600, height: 800 });
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600);
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/lineage-french-dark.png" });
});

test("source NULLs and calculations without input cells are terminal steps", async ({
  page,
}) => {
  await example(page);
  let source = true;
  await page.route("**/lineage", async (route) => {
    const cell = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ...cell,
        value: source ? null : 0,
        kind: source ? "source" : "projection",
        expression: source ? cell.column : "0",
        complete: true,
        warnings: [],
        contributions: source
          ? [
              {
                ...cell,
                value: null,
                node: "source",
                port: "result",
                source: true,
              },
            ]
          : [],
        total: source ? 1 : 0,
        context_total: 0,
        page_size: 5,
      },
    });
  });
  await explain(page);
  const panel = page.locator(".lineage-panel");
  await expect(panel.locator(".lineage-result strong")).toHaveText("NULL");
  await expect(panel.getByText(/You have reached the start/)).toBeVisible();
  await expect(panel.locator(".contribution")).toHaveCount(0);
  source = false;
  await explain(page, "revenue", 2);
  await expect(panel.locator(".lineage-result strong")).toHaveText("0");
  await expect(panel).toContainText(
    "This step has no contributing input cells.",
  );
  await expect(
    panel.getByRole("button", { name: "Play this path", exact: true }),
  ).toHaveCount(0);
});

test("a late lineage response cannot restore a generation invalidated while loading", async ({
  page,
}) => {
  await example(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let loaded = false;
  await page.route("**/lineage", async (route) => {
    const response = await route.fetch();
    loaded = true;
    await gate;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  await expect.poll(() => loaded).toBe(true);
  await page.route("**/generations/**", (route) =>
    route.fulfill({ json: { valid: false } }),
  );
  const panel = page.locator(".lineage-panel");
  await expect(panel.getByRole("alert")).toContainText(
    "This exploration was interrupted",
  );
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(panel.locator(".lineage-step")).toHaveCount(0);
  await expect(panel.locator(".contribution")).toHaveCount(0);
});
