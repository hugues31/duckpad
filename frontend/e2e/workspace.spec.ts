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
    page.getByRole("button", { name: "Run all", exact: true }),
  ).toBeVisible();
}
async function run(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run all", exact: true }).click();
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
    page.getByRole("button", { name: "Run all", exact: true }),
  ).toBeVisible();
}

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
  await choosePreference(page, "Anglais");
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
      family: "storage",
      parameters: [{ name: "root", type: "text", default: "" }],
      capabilities: ["read"],
      init_sql: "",
    },
  });
  await page.request.put("/api/catalog/connection?create=true", {
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
    page
      .locator(".inspector")
      .getByRole("combobox", { name: "Location", exact: true }),
  ).toContainText("Read only files");
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Export revenue", { exact: true }) })
    .click();
  await expect(
    page
      .locator(".inspector")
      .getByRole("combobox", { name: "Location", exact: true }),
  ).not.toContainText("Read only files");
  const after = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  expect(after.commit).toBe(before.commit);
});

test("panel toggles and fitting keep nodes reachable", async ({ page }) => {
  await sample(page);
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

  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await choosePreference(page, "Dark");
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
  }

  await page
    .getByRole("button", { name: "Toggle results", exact: true })
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
  await page
    .getByRole("button", { name: "Toggle node library", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search node types…", exact: true })
    .fill("Filter");
  await expect(page.locator(".palette-item")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Toggle results", exact: true })
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
  await page.getByRole("button", { name: "Hide results", exact: true }).click();
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
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
    .getByRole("button", { name: "Toggle results", exact: true })
    .click();
  await page.waitForResponse(
    (response) => response.url().includes("/status?") && response.ok(),
  );
  await expect(viewport).toHaveAttribute("style", zoomed!);
  await page
    .getByRole("button", { name: "Toggle results", exact: true })
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

test("account menu owns preferences and signs out only on an explicit action", async ({
  page,
}) => {
  await sample(page);
  const avatar = page.getByRole("button", {
    name: "Account menu",
    exact: true,
  });
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

test("selected and pointed nodes show their flow, with filled connected sockets and the preferred link style", async ({
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
      await expect(element.locator(".react-flow__edge-path")).toHaveCSS(
        "animation-name",
        "data-flow",
      );
    } else await expect(element).not.toHaveClass(/animated/);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.locator(".node-connected .react-flow__edge-path").first(),
  ).toHaveCSS("animation-name", "none");
  const customers = page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Customers", { exact: true }) });
  // Pointing at a node highlights its links without animating them.
  await customers.hover();
  const pointed = page.locator(".react-flow__edge.node-hovered");
  await expect(pointed).toHaveCount(1);
  await page.mouse.move(1, 1);
  await expect(pointed).toHaveCount(0);

  // Connected sockets are filled; an unused output stays hollow.
  const paid = page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) });
  const used = paid.locator('.react-flow__handle[data-handleid="orders"]');
  const unused = paid.locator('.react-flow__handle[data-handleid="overview"]');
  await expect(used).toHaveClass(/is-connected/);
  await expect(unused).not.toHaveClass(/is-connected/);
  await expect(
    paid.locator('.react-flow__handle[data-handleid="source"]'),
  ).toHaveClass(/is-connected/);

  // Links are curved by default and follow the link style preference.
  const path = (edge: any) =>
    page.locator(
      `.react-flow__edge[data-id="${edge.id}"] .react-flow__edge-path`,
    );
  const joined = graph.filter((edge: any) => edge.target === join.id);
  expect(joined).toHaveLength(2);
  for (const edge of joined) await expect(path(edge)).toHaveAttribute("d", /C/);
  await page.locator(".account .avatar").click();
  await page
    .getByRole("menuitemradio", { name: "Right angles", exact: true })
    .click();
  for (const edge of joined)
    await expect(path(edge)).not.toHaveAttribute("d", /C/);
  const source = customers.locator(".react-flow__handle.source");
  const target = page.locator(
    `.react-flow__node[data-id="${join.id}"] .react-flow__handle[data-handleid="left"]`,
  );
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

test("documentation waits for its refreshed revision and preserves edits during a slow save", async ({
  page,
}) => {
  await sample(page);
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  const panel = page.locator(".documentation-page");
  const editor = panel.locator(".project-documentation");
  const button = panel.getByRole("button", {
    name: /^(Save changes|Saving…)$/,
  });
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
  // Nothing is left to save.
  await expect(button).toBeDisabled();
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  expect(snapshot.bundle.documentation.project).toBe(
    "Second revision typed while saving",
  );
  expect(snapshot.conflicts).toEqual([]);
  expect(writes).toBe(2);
});
