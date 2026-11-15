import { expect, test, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };
import { openUserSettings, signIn } from "./helpers";
import { partitionFlow } from "./partitions-flow";

test("a Job shows live progress in its details until it finishes", async ({
  page,
}) => {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const slug = `progress-${Date.now()}`;
  const response = await page.request.post(
    `/api/projects/${tree.project}/jobs`,
    {
      data: {
        slug,
        name: "Progress Job",
        environment: "dev",
        target: { kind: "branch", ref: "main" },
      },
    },
  );
  expect(response.ok()).toBe(true);
  const job = await response.json();
  let active: Record<string, unknown> | null = null;
  await page.route(`**/api/projects/${tree.project}/jobs`, (route) =>
    route.fulfill({
      json: [
        { ...job, last_run: active ? { ...active, nodes: undefined } : null },
      ],
    }),
  );
  await page.route("**/api/runs/job-progress", (route) =>
    route.fulfill({ json: active }),
  );
  await page.route(`**/api/jobs/${slug}/runs`, (route) => {
    if (route.request().method() === "POST") {
      active = {
        id: "job-progress",
        started: new Date().toISOString(),
        commit: job.resolved_commit,
        status: "preparing",
        environment: "dev",
        nodes: {},
      };
      return route.fulfill({ json: active });
    }
    return route.fulfill({
      json: active ? [{ ...active, nodes: undefined }] : [],
    });
  });
  // Tabs and run controls that fit a laptop row keep the canvas height.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/worktrees/${tree.id}/flow`);
  const toolbar = page.locator(".flow-toolbar");
  await expect(toolbar).toHaveAttribute("data-stacked", "false");
  expect((await toolbar.boundingBox())!.height).toBeLessThan(43);
  await page.goto(`/projects/${tree.project}/jobs`);
  expect(
    (await page.locator(".project-toolbar").boundingBox())!.height,
  ).toBeLessThan(43);
  await page.getByRole("button", { name: "Progress Job", exact: true }).click();
  const details = page.locator(".job-details");
  await details.getByRole("button", { name: "Run Job", exact: true }).click();
  const bar = details.getByRole("progressbar", { name: en.runProgress });
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveAttribute("aria-valuenow");
  active = {
    ...active,
    status: "running",
    nodes: {
      first: { status: "success", duration: 120 },
      second: { status: "running", started: new Date().toISOString() },
    },
  };
  await expect(bar).toHaveAttribute("aria-valuenow", "50");
  await expect(details.locator(".run-progress")).toContainText(
    `1/2 ${en.nodes}`,
  );
  await expect(details.locator(".run-progress-remaining")).toContainText(
    "left",
  );
  await expect(details.locator(".run-progress-remaining")).toBeInViewport({
    ratio: 1,
  });
  active = { ...active, status: "success" };
  await expect(bar).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "Run Job", exact: true }),
  ).toBeEnabled();
});

test("canvas nodes fill with their expected progress, and links follow the run", async ({
  page,
}) => {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const ago = (seconds: number) =>
    new Date(Date.now() - seconds * 1000).toISOString();
  let active: Record<string, any> | null = {
    id: "canvas-progress",
    status: "running",
    environment: "dev",
    started: ago(30),
    nodes: {
      orders: { status: "success", started: ago(4), duration: 1 },
      customers: { status: "success", started: ago(4), duration: 1 },
      enriched: { status: "running", started: ago(2), estimated_duration: 20 },
      period: { status: "running", started: ago(1) },
      validated: { status: "pending", estimated_duration: 1 },
      "report::summary::eligible": {
        status: "success",
        started: ago(3),
        duration: 1,
        estimated_duration: 1,
      },
      "report::summary::metrics": { status: "pending", estimated_duration: 3 },
    },
  };
  await page.route(`**/api/worktrees/${tree.id}/status?*`, (route) =>
    route.fulfill({ json: { nodes: {}, active } }),
  );
  await page.goto(`/worktrees/${tree.id}/flow`);
  const node = (id: string) =>
    page.locator(`.react-flow__node[data-id="${id}"] .pipeline-node`);
  const edge = (id: string) =>
    page.locator(`.react-flow__edge[data-id="${id}"]`);
  const sweep = (id: string) =>
    node(id)
      .locator(".node-progress")
      .evaluate(
        (element) => getComputedStyle(element, "::after").animationName,
      );

  // A previous duration gives a fill that advances from left to right.
  const estimated = node("enriched");
  await expect(estimated.locator(".node-progress")).toHaveAttribute(
    "data-state",
    "estimated",
  );
  await expect(estimated).toHaveClass(/is-running/);
  const status = estimated.locator(".node-status.running");
  await expect(status).toContainText(en.running);
  await expect(status.locator(".node-status-time")).toHaveText(/^\d+ s$/);
  await expect(status).toHaveAttribute("title", /previous run: 20 s/);
  const fill = () =>
    estimated
      .locator(".node-progress-fill")
      .evaluate(
        (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
      );
  const start = await fill();
  expect(start).toBeLessThan(0);
  await expect.poll(fill).toBeGreaterThan(start);
  // Without one, a sweep shows activity but no progress.
  await expect(node("period").locator(".node-progress")).toHaveAttribute(
    "data-state",
    "working",
  );
  await expect.poll(() => sweep("period")).toBe("node-progress-sweep");
  await expect(node("period").locator(".node-status")).toHaveAttribute(
    "title",
    new RegExp(en.noPreviousDuration),
  );
  // Waiting nodes say so; nodes outside the run keep their own state.
  await expect(node("validated").locator(".node-status")).toHaveText(
    en.pending,
  );
  await expect(node("reach").locator(".node-status")).toHaveCount(0);
  // Between two of its nodes, a component keeps its progress and looks unfinished.
  const component = node("report").locator(".node-progress");
  await expect(node("report")).toHaveClass(/is-running/);
  await expect(component).toHaveAttribute("data-state", "estimated");
  await expect(component).not.toHaveAttribute("data-outcome");
  expect(
    await component
      .locator(".node-progress-fill")
      .evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  // Data flows along links into executing nodes only.
  await expect(edge("orders_result_enriched_left")).toHaveClass(/is-flowing/);
  await expect(edge("orders_result_enriched_left")).toHaveClass(/animated/);
  await expect(edge("enriched_result_validated_source")).not.toHaveClass(
    /animated|highlighted/,
  );

  active = {
    ...active,
    nodes: {
      ...active.nodes,
      enriched: { status: "success", started: ago(3), duration: 3 },
      validated: { status: "running", started: ago(30), estimated_duration: 1 },
    },
  };
  // A success washes the shape, and the links it fed stay highlighted.
  await expect(estimated.locator(".node-progress")).toHaveAttribute(
    "data-outcome",
    "success",
  );
  await expect(estimated).not.toHaveClass(/is-running/);
  await expect(edge("orders_result_enriched_left")).toHaveClass(/highlighted/);
  await expect(edge("orders_result_enriched_left")).not.toHaveClass(/animated/);
  await expect(edge("enriched_result_validated_source")).toHaveClass(
    /is-flowing/,
  );
  // Past its previous duration, a node keeps its fill and shows activity.
  const late = node("validated");
  await expect(late.locator(".node-progress")).toHaveAttribute(
    "data-state",
    "overrun",
  );
  await expect(late.locator(".node-status")).toHaveAttribute(
    "title",
    /longer than the previous run \(1\.0 s\)/,
  );
  await expect.poll(() => sweep("validated")).toBe("node-progress-sweep");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => sweep("validated")).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  active = { ...active, status: "canceling" };
  await expect(late.locator(".node-progress")).toHaveAttribute(
    "data-paused",
    "true",
  );
  active = null;
  await expect(page.locator(".pipeline-node.is-running")).toHaveCount(0);
  await expect(page.locator(".node-status")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge.animated")).toHaveCount(0);
});

async function expectToolbarFits(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const tabs = page.locator(".main-tabs");
  expect(
    await tabs.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  for (const link of await tabs.getByRole("link").all())
    await expect(link).toBeInViewport({ ratio: 1 });
  const toolbar = page.locator(".flow-toolbar");
  for (const button of await toolbar.getByRole("button").all())
    await expect(button).toBeInViewport({ ratio: 1 });
  expect(
    await toolbar.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
  const tabsBox = (await tabs.boundingBox())!;
  const controlsBox = (await toolbar.locator(":scope > .row").boundingBox())!;
  if ((await toolbar.getAttribute("data-stacked")) === "true")
    expect(controlsBox.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height);
  else expect((await toolbar.boundingBox())!.height).toBeLessThan(43);
}

for (const [language, labels] of [
  ["en", en],
  ["fr", fr],
] as const) {
  test(`run progress and partition controls fit a laptop in ${language}`, async ({
    page,
  }) => {
    await signIn(page);
    if (language !== "en") {
      await openUserSettings(page);
      await page
        .getByLabel(en.language, { exact: true })
        .selectOption(language);
    }
    const project = await (
      await page.request.post("/api/projects", {
        data: { name: "Run progress" },
      })
    ).json();
    // A working branch also exposes Merge, the widest toolbar configuration.
    const branch = await (
      await page.request.post(`/api/worktrees/${project.id}/branches`, {
        data: { name: "feature/progress" },
      })
    ).json();
    const endpoint = `/api/worktrees/${branch.id}`;
    const snapshot = await (await page.request.get(endpoint)).json();
    expect(
      (
        await page.request.put(endpoint, {
          data: { revision: snapshot.revision, bundle: partitionFlow },
        })
      ).ok(),
    ).toBe(true);
    let active: Record<string, unknown> | null = null;
    await page.route(`**${endpoint}/status?*`, (route) =>
      route.fulfill({ json: { nodes: {}, active } }),
    );
    await page.route(`**${endpoint}/runs`, (route) => {
      active = {
        id: "progress-run",
        status: "preparing",
        environment: "dev",
        nodes: {},
      };
      return route.fulfill({ json: active });
    });
    await page.goto(`/worktrees/${branch.id}/flow`);
    const run = page
      .locator(".flow-toolbar")
      .getByRole("button", { name: labels.run, exact: true });
    await expect(run).toBeEnabled();
    for (const width of [1024, 1280, 1440, 1512])
      await expectToolbarFits(page, width);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".partition-trigger").click();
    await expect(page.locator(".partition-menu")).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await expect(page.locator(".partition-trigger")).toBeFocused();
    await run.click();
    const bar = page.getByRole("progressbar", { name: labels.runProgress });
    const strip = page.locator(".run-progress");
    await expect(bar).toBeVisible();
    await expect(bar).not.toHaveAttribute("aria-valuenow");
    await expect(strip).toContainText(labels.preparing);
    await expect(strip).toContainText(labels.estimatingRemaining);
    await expect(strip.locator(".run-progress-count")).toHaveCount(0);

    active = {
      ...active,
      status: "running",
      nodes: {
        first: { status: "success", duration: 10 },
        second: {
          status: "running",
          started: new Date().toISOString(),
          estimated_duration: 7200,
        },
      },
    };
    await expect(bar).toHaveAttribute("aria-valuenow", "50");
    await expect(strip).toContainText(`1/2 ${labels.nodes}`);
    const remaining = strip.locator(".run-progress-remaining");
    await expect(remaining).toContainText("2 h");
    await expect(remaining).toBeInViewport({ ratio: 1 });
    await expect(bar).toHaveAttribute(
      "aria-valuetext",
      new RegExp(labels.estimatedRemaining.split("{duration}")[0]),
    );
    await expect(bar.locator("div")).toHaveCSS(
      "animation-name",
      "run-progress-shimmer",
    );

    active = {
      ...active,
      partitions: {
        started: new Date(Date.now() - 60000).toISOString(),
        phase: "consumers",
        selected: 10,
        total: 50,
        completed: 3,
        failed: 2,
        active_keys: [{ value: "a-very-long-partition-key-".repeat(30) }],
      },
    };
    await expect(strip).toContainText(`3/10 ${labels.partitions}`);
    await expect(remaining).toContainText("min");
    await expect(remaining).toBeInViewport({ ratio: 1 });
    await expect(bar).toHaveAttribute("aria-valuenow", "50");
    await expect(bar).toHaveAttribute(
      "aria-valuetext",
      new RegExp(`2 ${labels.failed}`),
    );
    for (const width of [1024, 1280, 1440, 1512])
      await expectToolbarFits(page, width);
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(
      await strip.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.locator(".partition-trigger").click();
    const menu = page.locator(".partition-menu");
    await expect(menu).toBeInViewport({ ratio: 1 });
    expect(
      await menu.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + 10, box.y + 10),
        );
      }),
    ).toBe(true);
    await page.keyboard.press("Escape");
    // Floating panels must start below the taller toolbar and progress strip.
    await page.locator('.react-flow__node[data-id="source"]').click();
    const inspector = (await page.locator(".inspector").boundingBox())!;
    const progress = (await strip.boundingBox())!;
    expect(inspector.y).toBeGreaterThanOrEqual(progress.y + progress.height);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(bar.locator("div")).toHaveCSS("animation-name", "none");
    await expect(strip.locator("svg")).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    active = { ...active, status: "canceling" };
    await expect(remaining).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: labels.canceling, exact: true }),
    ).toBeDisabled();
    active = null;
    await expect(bar).toHaveCount(0);
    await expect(run).toBeEnabled();
  });
}
