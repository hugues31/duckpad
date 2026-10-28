import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn } from "./helpers";
import { test, expect, type Page } from "@playwright/test";

async function choosePreference(page: Page, name: string) {
  await page.locator(".account .avatar").click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}
async function sample(page: Page) {
  await signIn(page);
  const workspace = await (await page.request.get("/api/workspace")).json();
  if (workspace.projects.length) {
    const result = await (
      await page.request.post("/api/example", { data: {} })
    ).json();
    await page.goto(`/worktrees/${result.id}/flow`);
  } else
    await page.getByRole("button", { name: "Open example project" }).click();
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeVisible();
}
async function run(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  if (
    (await page.getByLabel("Environment", { exact: true }).inputValue()) ===
    "prod"
  )
    await page
      .getByRole("button", { name: "Confirm and run", exact: true })
      .click();
  const result = await (await response).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + result.id)).json())
          .status,
      { timeout: 30000 },
    )
    .toBe("success");
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeVisible();
}

test("complete example, ordered outputs, nested components, lineage pagination and native export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await sample(page);
  await run(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  await expect(
    page.getByRole("button", { name: /Explain this value: revenue, rows 1,/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  await expect(page.locator(".lineage-card.calculation")).toHaveCount(1);
  await expect(page.locator(".lineage-dialog")).toContainText(
    "Sum of 27 contributing values",
    { ignoreCase: true },
  );
  await expect(
    page.locator(".lineage-dialog .lineage-card.is-source").first(),
  ).toContainText("amount");
  await page
    .locator(".lineage-dialog")
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(page.locator(".lineage-dialog .lineage-page")).toContainText(
    "6–10 / 27",
  );
  await page
    .locator(".lineage-dialog")
    .getByTitle("Close", { exact: true })
    .click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Open component", exact: true })
    .click();
  await expect(
    page.getByText(
      "You are editing a shared component definition in this branch.",
    ),
  ).toBeVisible();
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional summary", { exact: true }) })
    .dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await run(page);
  expect(errors).toEqual([]);
});

test("theme and language persist without a project commit and environments have isolated results", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const before = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  await choosePreference(page, "French");
  await expect(
    page.getByRole("button", { name: fr.run, exact: true }),
  ).toBeVisible();
  await choosePreference(page, fr.dark);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  const after = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  expect(after.commit).toBe(before.commit);
  await page.getByLabel(fr.environment, { exact: true }).selectOption("prod");
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Orders", { exact: true }) })
    .click();
  await expect(page.getByText(fr.noResult, { exact: true })).toBeVisible();
  await choosePreference(page, fr.english);
  await choosePreference(page, "Light");
  await run(page);
  await expect(page.locator(".data-table tbody tr")).toHaveCount(100);
});

test("parameter change marks retained previews stale until a manual rerun", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("orders");
  const status = page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ });
  await status.fill("refunded");
  await status.blur();
  await expect(page.locator(".preview-header .badge")).toHaveText("Stale");
  await expect(page.locator(".data-table .cell").first()).toBeDisabled();
  await run(page);
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await expect(page.locator(".preview-header")).toContainText("13 rows");
});

test("Git branch creation, isolated edits and explicit merge", async ({
  page,
}) => {
  await sample(page);
  await page.getByTitle("New working branch", { exact: true }).click();
  await page
    .getByLabel("Branch name", { exact: true })
    .fill("test/browser-branch-" + Date.now());
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Compare & merge", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Documentation", exact: true })
    .first()
    .click();
  await page
    .locator(".project-documentation")
    .fill("A branch-specific business definition.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare & merge", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Review merge", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply reviewed merge", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Branch merged");
  await page.keyboard.press("Escape");
  const mainWorktree = await page
    .getByLabel("Branch", { exact: true })
    .locator("option")
    .filter({ hasText: /^main$/ })
    .getAttribute("value");
  await page.getByLabel("Branch", { exact: true }).selectOption(mainWorktree!);
  await expect(page.getByLabel("Branch", { exact: true })).toContainText(
    "main",
  );
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Git history", exact: true }).click();
  await expect(page.locator(".history-row").first()).toContainText(
    "merge test/browser-branch",
  );
});

test("drag a filter, configure it without SQL, and group it into a reusable component", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  await page
    .locator(".palette-item")
    .filter({ has: page.getByText("Filter", { exact: true }) })
    .dragTo(page.locator(".react-flow__pane"), {
      targetPosition: { x: 350, y: 240 },
    });
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  const inspector = page.locator(".inspector");
  await inspector
    .getByLabel("source", { exact: true })
    .selectOption({ label: "Orders · result" });
  await expect(inspector.getByLabel("Column", { exact: true })).toContainText(
    "amount",
  );
  await inspector.getByLabel("Column", { exact: true }).selectOption("amount");
  await inspector.getByLabel("Operator", { exact: true }).selectOption(">");
  await inspector.getByLabel("Value", { exact: true }).fill("100");
  await inspector
    .getByRole("button", { name: "Apply to parameters", exact: true })
    .click();
  await inspector
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await run(page);
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await expect(
    inspector.getByRole("textbox", { name: /condition/ }),
  ).toHaveValue('"amount" > 100');
  await page.locator(".group-button").click();
  await page
    .getByRole("dialog")
    .getByLabel("Component name")
    .fill("Large orders");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("Large orders", { exact: true }) }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Open component", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await run(page);
});

test("conflicting parameter edits survive reload and can be resolved explicitly", async ({
  page,
}) => {
  await sample(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) })
    .click();
  const status = page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ });
  await status.fill("refunded");
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const snapshot = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  snapshot.bundle.flow.nodes.find(
    (n: any) => n.label === "Paid orders",
  ).params.status = "pending";
  expect(
    (
      await page.request.put("/api/worktrees/" + worktree, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await status.blur();
  await expect(
    page.getByRole("button", { name: "Save resolution", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Save resolution", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("refunded");
  await expect(page.getByRole("dialog")).toContainText("pending");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Use my proposal", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save resolution", exact: true }),
  ).toHaveCount(0);
  await run(page);
});

test("an open lineage explanation is interrupted when its generation is recalculated", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  await expect(page.locator(".lineage-dialog")).toContainText(
    "Sum of 27 contributing values",
  );
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const response = await page.request.post(`/api/worktrees/${worktree}/runs`, {
    data: { environment: "dev" },
  });
  expect(response.ok()).toBeTruthy();
  const execution = await response.json();
  await expect(page.locator(".lineage-dialog")).toContainText(
    "This exploration was interrupted",
  );
  await expect(
    page.locator(".lineage-dialog .lineage-card.is-source"),
  ).toHaveCount(0);
  // Catalog changes in later tests must not race this background execution.
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${execution.id}`)).json())
          .status,
      { timeout: 30000 },
    )
    .toBe("success");
});

test("connection capabilities constrain source and export forms without a project commit", async ({
  page,
}) => {
  await sample(page);
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const before = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  await page.request.put("/api/catalog/connector", {
    data: {
      id: "read_only",
      name: "Read only files",
      parameters: [{ name: "root", type: "text", default: "" }],
      capabilities: ["read"],
      init_sql: "",
    },
  });
  await page.request.put("/api/catalog/connection", {
    data: {
      id: "read_only_files",
      name: "Read only files",
      connector: "read_only",
      environments: { dev: { root: "" }, prod: { root: "" } },
    },
  });
  const settings = await (
    await page.request.get(`/api/projects/${before.worktree.project}/settings`)
  ).json();
  await page.request.put(
    `/api/projects/${before.worktree.project}/connections`,
    {
      data: { connections: [...settings.connections, "read_only_files"] },
    },
  );
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Orders", { exact: true }) })
    .click();
  await expect(
    page.locator(".inspector").getByRole("combobox", { name: /connection/ }),
  ).toContainText("Read only files");
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Export revenue", { exact: true }) })
    .click();
  await expect(
    page.locator(".inspector").getByRole("combobox", { name: /connection/ }),
  ).not.toContainText("Read only files");
  const after = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  expect(after.commit).toBe(before.commit);
});

test("glass panels overlay the full canvas and fitting keeps nodes reachable", async ({
  page,
}) => {
  await sample(page);
  const canvas = page.locator(".canvas");
  const shell = await page.locator(".app-shell").boundingBox();
  expect(await canvas.boundingBox()).toEqual(shell);

  async function expectNodesReachable() {
    await expect
      .poll(async () =>
        page.locator(".react-flow__node").evaluateAll((nodes) =>
          nodes.every((node) => {
            const rect = node.getBoundingClientRect();
            return (
              document
                .elementFromPoint(
                  rect.x + rect.width / 2,
                  rect.y + rect.height / 2,
                )
                ?.closest(".react-flow__node") === node
            );
          }),
        ),
      )
      .toBe(true);
  }
  await expectNodesReachable();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Regional revenue" })
    .click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect(page.locator(".preview-panel")).toBeVisible();
  await expectNodesReachable();
  expect(await canvas.boundingBox()).toEqual(shell);

  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await choosePreference(page, "Dark");
    const glass = await page.locator(".palette").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, blur: style.backdropFilter };
    });
    expect(glass.background).toMatch(/^rgba\(/);
    expect(glass.blur).toContain("blur");
    // Check muted text even over the brightest/darkest possible content behind the glass.
    const contrast = await page
      .locator(".palette-list h4")
      .first()
      .evaluate((element) => {
        const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
        const foreground = rgb(getComputedStyle(element).color);
        const surface = rgb(
          getComputedStyle(element.closest(".palette")!).backgroundColor,
        );
        const luminance = (color: number[]) =>
          color.slice(0, 3).reduce((sum, value, i) => {
            const channel = value / 255;
            return (
              sum +
              [0.2126, 0.7152, 0.0722][i] *
                (channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4)
            );
          }, 0);
        return Math.min(
          ...[0, 255].map((backdrop) => {
            const background = surface
              .slice(0, 3)
              .map(
                (channel) => channel * surface[3] + backdrop * (1 - surface[3]),
              );
            const [low, high] = [
              luminance(foreground),
              luminance(background),
            ].sort((a, b) => a - b);
            return (high + 0.05) / (low + 0.05);
          }),
        );
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await expectNodesReachable();
    await page.screenshot({
      path: `test-results/glass-workspace-${theme}.png`,
    });
  }

  await page
    .getByRole("button", { name: "Toggle data preview", exact: true })
    .click();
  await expect(page.locator(".preview-panel")).toBeHidden();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle inspector", exact: true })
    .click();
  await expect(page.locator(".inspector")).toBeHidden();
  await page
    .getByRole("button", { name: "Toggle node library", exact: true })
    .click();
  await expect(page.locator(".palette")).toBeHidden();
  await expectNodesReachable();
  expect(await canvas.boundingBox()).toEqual(shell);
  await page
    .getByRole("button", { name: "Toggle node library", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Find a node…", exact: true })
    .fill("Filter");
  await expect(page.locator(".palette-item")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Toggle data preview", exact: true })
    .click();
  await expect(page.locator(".preview-panel")).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle inspector", exact: true })
    .click();
  await expect(page.locator(".inspector-tabs button.active")).toHaveText(
    "Documentation",
  );
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Orders", { exact: true }) })
    .click({ modifiers: ["Shift"] });
  await expect(page.locator(".group-button")).toContainText("(2)");
});

test("floating panels remain usable on tablet and phone with higher contrast", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await sample(page);
  await expect(page.locator(".palette")).toBeHidden();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Orders" })
    .first()
    .click();
  await expect(page.locator(".inspector")).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle inspector", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ contrast: "more", reducedMotion: "reduce" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(390);
  await page
    .getByRole("button", { name: "Toggle node library", exact: true })
    .click();
  await expect(page.locator(".palette")).toBeVisible();
  const background = await page
    .locator(".palette")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).toMatch(/^rgb\(/);
  await page
    .getByRole("button", { name: "Hide node library", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle inspector", exact: true })
    .click();
  await expect(
    page.locator(".inspector").getByLabel("Display name", { exact: true }),
  ).toBeVisible();
  await page.locator(".inspector").getByTitle("Close", { exact: true }).click();
  await page
    .getByRole("button", { name: "Hide data preview", exact: true })
    .click();
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.screenshot({ path: "test-results/glass-workspace-mobile.png" });
  expect(await page.locator(".canvas").boundingBox()).toEqual(
    await page.locator(".app-shell").boundingBox(),
  );
});

test("panning, zooming and moving nodes survive release and backend polling", async ({
  page,
}) => {
  await sample(page);
  const orders = page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Orders", { exact: true }) });
  await orders.click();
  const viewport = page.locator(".react-flow__viewport");
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  const origin = await viewport.getAttribute("style");
  const point = await page.locator(".canvas-safe-area").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    for (let y = rect.bottom - 5; y > rect.top; y -= 30) {
      for (let x = rect.left + 5; x < rect.right - 100; x += 30) {
        if (
          document
            .elementFromPoint(x, y)
            ?.classList.contains("react-flow__pane")
        )
          return { x, y };
      }
    }
    throw new Error("No exposed canvas point found");
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 85, point.y - 40, { steps: 12 });
  const dragged = await viewport.getAttribute("style");
  expect(dragged).not.toBe(origin);
  await page.mouse.up();
  for (let i = 0; i < 2; i++)
    await page.waitForResponse(
      (response) => response.url().includes("/status?") && response.ok(),
    );
  await expect(viewport).toHaveAttribute("style", dragged!);
  await expect(page.locator(".inspector")).toBeVisible();

  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(viewport).not.toHaveAttribute("style", dragged!);
  const zoomed = await viewport.getAttribute("style");
  await page
    .getByRole("button", { name: "Toggle data preview", exact: true })
    .click();
  await page.waitForResponse(
    (response) => response.url().includes("/status?") && response.ok(),
  );
  await expect(viewport).toHaveAttribute("style", zoomed!);
  await page
    .getByRole("button", { name: "Toggle data preview", exact: true })
    .click();
  await expect(viewport).toHaveAttribute("style", zoomed!);

  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  const fitted = await viewport.getAttribute("style");
  const node = await orders.locator(".node-shape").boundingBox();
  const before = await orders.getAttribute("style");
  await page.mouse.move(node!.x + node!.width / 2, node!.y + node!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    node!.x + node!.width / 2 + 45,
    node!.y + node!.height / 2 + 25,
    { steps: 10 },
  );
  const moved = await orders.getAttribute("style");
  expect(moved).not.toBe(before);
  await page.waitForResponse(
    (response) => response.url().includes("/status?") && response.ok(),
  );
  await expect(orders).toHaveAttribute("style", moved!);
  const save = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/worktrees/"),
  );
  await page.mouse.up();
  expect((await save).ok()).toBe(true);
  for (let i = 0; i < 2; i++)
    await page.waitForResponse(
      (response) => response.url().includes("/status?") && response.ok(),
    );
  await expect(viewport).toHaveAttribute("style", fitted!);
  await expect(orders).toHaveAttribute("style", moved!);
});

test("workspace docks to the edges with square datasets, circular operations and neutral backgrounds", async ({
  page,
}) => {
  await sample(page);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Regional revenue" })
    .click();
  const viewport = page.viewportSize()!;
  const header = (await page.locator(".topbar").boundingBox())!;
  const toolbar = (await page.locator(".flow-toolbar").boundingBox())!;
  const palette = (await page.locator(".palette").boundingBox())!;
  const inspector = (await page.locator(".inspector").boundingBox())!;
  const preview = (await page.locator(".preview-panel").boundingBox())!;
  expect(header.y).toBe(0);
  expect(header.x).toBe(0);
  expect(header.width).toBe(viewport.width);
  expect(toolbar.y).toBe(header.height);
  expect(palette.x).toBe(0);
  expect(palette.y).toBe(toolbar.y + toolbar.height);
  expect(inspector.y).toBe(palette.y);
  expect(inspector.x + inspector.width).toBe(viewport.width);
  expect(preview.x).toBe(palette.width);
  expect(preview.x + preview.width).toBe(inspector.x);
  expect(preview.y + preview.height).toBe(viewport.height);
  for (const panel of [
    ".topbar",
    ".flow-toolbar",
    ".palette",
    ".inspector",
    ".preview-panel",
  ]) {
    await expect(page.locator(panel)).toHaveCSS("border-radius", "0px");
  }
  const shapes = await page.locator(".node-shape").evaluateAll((elements) =>
    elements.map((element) => {
      const css = getComputedStyle(element);
      return {
        source: element.closest(".source-node") !== null,
        radius: css.borderRadius,
        width: css.width,
        height: css.height,
      };
    }),
  );
  for (const shape of shapes) {
    expect(shape.width).toBe(shape.height);
    expect(shape.radius).toBe(shape.source ? "8px" : "50%");
  }
  await expect(page.locator(".app-shell")).toHaveCSS(
    "background-image",
    "none",
  );
  await expect(page.locator(".react-flow__background")).toHaveCount(0);
  await choosePreference(page, "Dark");
  await expect(page.locator(".app-shell")).toHaveCSS(
    "background-color",
    "rgb(28, 28, 30)",
  );
  await expect(page.locator(".app-shell")).toHaveCSS(
    "background-image",
    "none",
  );
});

test("glass reveals nodes moving behind stationary panel content", async ({
  page,
}) => {
  await sample(page);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Regional revenue" })
    .click();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await choosePreference(page, "Dark");
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    const palette = page.locator(".palette");
    const text = await palette.innerText();
    const before = await palette.screenshot({ animations: "disabled" });
    const source = (await page
      .locator(".source-node .node-shape")
      .first()
      .boundingBox())!;
    const canvas = (await page.locator(".canvas-safe-area").boundingBox())!;
    const start = {
      x: canvas.x + canvas.width - 180,
      y: canvas.y + canvas.height + 25,
    };
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.classList.contains("react-flow__pane"),
        start,
      ),
    ).toBe(true);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      start.x + 100 - (source.x + source.width / 2),
      start.y,
      { steps: 15 },
    );
    await page.mouse.up();
    await page.waitForResponse(
      (response) => response.url().includes("/status?") && response.ok(),
    );
    const after = await palette.screenshot({ animations: "disabled" });
    expect(await palette.innerText()).toBe(text);
    // Only the canvas moved: the difference comes from content visible through the glass.
    expect(after.equals(before)).toBe(false);
    const covered = (await page
      .locator(".source-node .node-shape")
      .first()
      .boundingBox())!;
    expect(covered.x).toBeGreaterThan(0);
    expect(covered.x + covered.width).toBeLessThan(
      (await palette.boundingBox())!.width,
    );
    await page.screenshot({
      path: `test-results/glass-overlap-${theme}.png`,
      animations: "disabled",
    });
  }
});

test("account menu owns preferences and signs out only on an explicit action", async ({
  page,
}) => {
  await sample(page);
  const avatar = page.getByRole("button", {
    name: "Account menu",
    exact: true,
  });
  const box = (await avatar.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(page.viewportSize()!.width - 20);
  await expect(
    page.locator(".topbar").getByTitle("Settings", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".topbar .language-button")).toHaveCount(0);
  await expect(
    page.locator(".topbar").getByTitle("Dark", { exact: true }),
  ).toHaveCount(0);
  let logouts = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/logout")) logouts++;
  });
  await avatar.focus();
  await page.keyboard.press("ArrowDown");
  expect(
    await page.getByRole("menu").evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      return [12, rect.height / 2, rect.height - 12].every((y) =>
        [12, rect.width - 12].every((x) =>
          menu.contains(document.elementFromPoint(rect.x + x, rect.y + y)),
        ),
      );
    }),
  ).toBe(true);
  await expect(
    page.getByRole("menuitemradio", { name: "English", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("menuitem", { name: "Sign out", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(avatar).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await avatar.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(avatar).not.toBeFocused();
  await avatar.click();
  await page.locator(".palette-title").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(logouts).toBe(0);
  await avatar.click();
  await page
    .getByRole("menuitem", { name: "User settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "User settings", exact: true }),
  ).toBeVisible();
  await avatar.click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(logouts).toBe(1);
});

test("three panel dividers resize, persist and preserve manual canvas navigation", async ({
  page,
}) => {
  await sample(page);
  const select = () =>
    page
      .locator(".react-flow__node")
      .filter({ hasText: "Regional revenue" })
      .click();
  await select();
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const before = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const viewport = page.locator(".react-flow__viewport");
  const camera = await viewport.getAttribute("style");
  for (const [label, selector, dx, dy] of [
    ["Resize node library", ".palette", 70, 0],
    ["Resize inspector", ".inspector", -90, 0],
    ["Resize data preview", ".preview-panel", 0, -110],
  ] as const) {
    const divider = page.getByRole("separator", { name: label });
    const start = (await divider.boundingBox())!;
    const panel = page.locator(selector);
    const previous = (await panel.boundingBox())!;
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      start.x + start.width / 2 + dx,
      start.y + start.height / 2 + dy,
      { steps: 10 },
    );
    await page.mouse.up();
    const next = (await panel.boundingBox())!;
    expect(
      dy ? next.height - previous.height : next.width - previous.width,
    ).toBeCloseTo(Math.abs(dx || dy), 0);
    await expect(viewport).toHaveAttribute("style", camera!);
  }
  const dimensions = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("duckpad-panel-sizes")!),
  );
  await page.reload();
  await select();
  expect((await page.locator(".palette").boundingBox())!.width).toBe(
    dimensions.palette,
  );
  expect((await page.locator(".inspector").boundingBox())!.width).toBe(
    dimensions.inspector,
  );
  expect(
    (await page.locator(".preview-panel").boundingBox())!.height,
  ).toBeCloseTo(dimensions.preview, 0);
  const right = page.getByRole("separator", {
    name: "Resize inspector",
    exact: true,
  });
  await right.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await page.locator(".inspector").boundingBox())!.width).toBe(
    dimensions.inspector + 16,
  );
  await page.keyboard.press("Home");
  await expect(right).toHaveAttribute("aria-valuenow", "260");
  await page.keyboard.press("End");
  expect(Number(await right.getAttribute("aria-valuenow"))).toBe(
    Number(await right.getAttribute("aria-valuemax")),
  );
  const after = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  expect(after.commit).toBe(before.commit);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect
    .poll(
      async () =>
        (await page.locator(".canvas-safe-area").boundingBox())!.width,
    )
    .toBeGreaterThanOrEqual(320);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(390);
  await expect
    .poll(async () => (await page.locator(".inspector").boundingBox())!.width)
    .toBeLessThanOrEqual(390);
});

test("selected nodes show incoming and outgoing flow, with larger usable sockets", async ({
  page,
}) => {
  await sample(page);
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const snapshot = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  const join = snapshot.bundle.flow.nodes.find(
    (node: any) => node.label === "Enrich orders",
  );
  const graph = snapshot.bundle.flow.edges;
  const expected = graph.filter(
    (edge: any) => edge.source === join.id || edge.target === join.id,
  );
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Enrich orders" })
    .click();
  await expect(page.locator(".react-flow__edge.node-connected")).toHaveCount(
    expected.length,
  );
  for (const edge of graph) {
    const element = page.locator(`.react-flow__edge[data-id="${edge.id}"]`);
    if (expected.includes(edge)) {
      await expect(element).toHaveClass(/animated/);
      const path = element.locator(".react-flow__edge-path");
      await expect(path).toHaveAttribute("marker-end", /url\(/);
      await expect(path).toHaveCSS("animation-name", "data-flow");
      const before = await path.evaluate(
        (node) => getComputedStyle(node).strokeDashoffset,
      );
      await expect
        .poll(() =>
          path.evaluate((node) => getComputedStyle(node).strokeDashoffset),
        )
        .not.toBe(before);
    } else await expect(element).not.toHaveClass(/animated/);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.locator(".node-connected .react-flow__edge-path").first(),
  ).toHaveCSS("animation-name", "none");
  await expect(
    page.locator(".node-connected .react-flow__edge-path").first(),
  ).toHaveAttribute("marker-end", /url\(/);
  const customers = page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Customers", { exact: true }) });
  const source = customers.locator(".react-flow__handle.source");
  const target = page.locator(
    `.react-flow__node[data-id="${join.id}"] .react-flow__handle[data-handleid="left"]`,
  );
  await expect(source).toHaveCSS("width", "16px");
  await expect(target).toHaveCSS("height", "16px");
  const start = (await source.boundingBox())!;
  const end = (await target.boundingBox())!;
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/worktrees/"),
  );
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  expect((await saved).ok()).toBe(true);
  const updated = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  const incoming = updated.bundle.flow.edges.filter(
    (edge: any) => edge.target === join.id && edge.targetHandle === "left",
  );
  expect(incoming).toHaveLength(1);
  expect(incoming[0].source).toBe(await customers.getAttribute("data-id"));
});

test("project documentation saves repeatedly without an edit conflict", async ({
  page,
}) => {
  await sample(page);
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  const panel = page.locator(".documentation-page");
  for (const text of ["First revision", "Second revision"]) {
    await panel.locator(".project-documentation").fill(text);
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" && r.url().includes("/api/worktrees/"),
    );
    await panel
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
  }
  await expect(page.locator(".banner.warning")).toHaveCount(0);
  const worktree = new URL(page.url()).pathname.split("/")[2];
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  expect(snapshot.bundle.documentation.project).toBe("Second revision");
  expect(snapshot.conflicts).toEqual([]);
});

test("documentation waits for its refreshed revision and preserves edits during a slow save", async ({
  page,
}) => {
  await sample(page);
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  const panel = page.locator(".documentation-page");
  const editor = panel.locator(".project-documentation");
  const button = panel.getByRole("button");
  const worktree = new URL(page.url()).pathname.split("/")[2];
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let saving = false;
  let refreshBlocked = false;
  let writes = 0;
  await page.route(`**/api/worktrees/${worktree}`, async (route) => {
    if (route.request().method() === "PUT") {
      saving = true;
      writes++;
    } else if (route.request().method() === "GET" && saving) {
      refreshBlocked = true;
      await refreshGate;
    }
    await route.continue();
  });
  try {
    await editor.fill("First revision");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/api/worktrees/${worktree}`),
    );
    await button.click();
    expect((await saved).ok()).toBe(true);
    await expect.poll(() => refreshBlocked).toBe(true);
    await editor.fill("Second revision typed while saving");
    await expect(button).toBeDisabled();
    // A repeated activation cannot submit the old revision while the GET is blocked.
    await button.evaluate((element: HTMLButtonElement) => element.click());
    expect(writes).toBe(1);
  } finally {
    releaseRefresh();
  }
  await expect(button).toBeEnabled();
  await expect(editor).toHaveValue("Second revision typed while saving");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/api/worktrees/${worktree}`),
  );
  await button.click();
  expect((await saved).ok()).toBe(true);
  await expect(button).toBeEnabled();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  expect(snapshot.bundle.documentation.project).toBe(
    "Second revision typed while saving",
  );
  expect(snapshot.conflicts).toEqual([]);
  expect(writes).toBe(2);
});

test("runs use a configured environment after the environments are renamed", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", { data: { name: "Renamed" } })
  ).json();
  try {
    await page.request.put("/api/environments", {
      data: ["staging", "prod"],
    });
    await page.goto(`/worktrees/${project.id}/flow`);
    const launched = page.waitForResponse(
      (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    const response = await launched;
    expect(response.ok()).toBe(true);
    expect((await response.json()).environment).toBe("staging");
  } finally {
    await page.request.put("/api/environments", { data: ["dev", "prod"] });
  }
});
