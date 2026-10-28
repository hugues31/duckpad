import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./helpers";
import type { Snapshot } from "../src/types";
import fr from "../src/locales/fr.json" with { type: "json" };

async function prepare(page: Page) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Connection palette" },
    })
  ).json();
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot: Snapshot = await (await page.request.get(url)).json();
  const bundle = snapshot.bundle!;
  bundle.templates.dual = `-- @label Dual output
-- @output first
SELECT 1 AS value;
-- @output second
SELECT 2 AS value;`;
  bundle.components.reusable = {
    id: "reusable",
    name: "Reusable branch",
    nodes: [
      {
        id: "inner",
        template: "filter",
        params: { condition: "true" },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    inputs: { rows: { node: "inner", port: "source" } },
    outputs: { rows: { node: "inner", port: "result" } },
    parameters: {},
  };
  bundle.flow.nodes = [
    { id: "source", template: "dual", params: {}, position: { x: 0, y: 0 } },
    {
      id: "target",
      template: "filter",
      params: { condition: "true" },
      position: { x: 350, y: 0 },
    },
    {
      id: "component",
      component: "reusable",
      params: {},
      position: { x: 700, y: 0 },
    },
  ];
  bundle.flow.edges = [
    {
      id: "existing",
      source: "source",
      sourceHandle: "first",
      target: "target",
      targetHandle: "source",
    },
  ];
  expect(
    (
      await page.request.put(url, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  return url;
}

const palette = (page: Page) =>
  page.getByRole("dialog", { name: "Add a connected node", exact: true });
const handle = (page: Page, node: string, type: string, port: string) =>
  page.locator(
    `.react-flow__node[data-id="${node}"] .react-flow__handle.${type}[data-handleid="${port}"]`,
  );

async function dragToSpace(
  page: Page,
  node = "source",
  type = "source",
  port = "second",
  touch = false,
) {
  const endpoint = handle(page, node, type, port);
  await expect(endpoint).toBeVisible();
  const start = (await endpoint.boundingBox())!;
  const point = await page.locator(".canvas-safe-area").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (const y of [0.75, 0.25, 0.6, 0.4]) {
      for (const x of [0.75, 0.25, 0.5]) {
        const point = {
          x: Math.round(bounds.x + bounds.width * x),
          y: Math.round(bounds.y + bounds.height * y),
        };
        if (
          document
            .elementFromPoint(point.x, point.y)
            ?.classList.contains("react-flow__pane")
        )
          return point;
      }
    }
    throw new Error("No empty canvas space found");
  });
  if (touch) {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: start.x + start.width / 2, y: start.y + start.height / 2 },
      ],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
  } else {
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + start.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 8 });
    await page.mouse.up();
  }
  const flowPosition = await page
    .locator(".react-flow")
    .evaluate((element, point) => {
      const bounds = element.getBoundingClientRect();
      const viewport = element.querySelector(".react-flow__viewport")!;
      const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
      return {
        x: (point.x - bounds.x - matrix.e) / matrix.a,
        y: (point.y - bounds.y - matrix.f) / matrix.d,
      };
    }, point);
  await expect(page.getByRole("dialog")).toBeVisible();
  return flowPosition;
}

async function choose(page: Page, url: string, action: () => Promise<void>) {
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(url) && response.request().method() === "PUT",
  );
  await action();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return (await (await page.request.get(url)).json()) as Snapshot;
}

test("search and keyboard selection create and persist a node and the exact connection in one save", async ({
  page,
}) => {
  const url = await prepare(page);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  const before: Snapshot = await (await page.request.get(url)).json();
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(url) && request.method() === "PUT")
      writes.push(request.postDataJSON());
  });
  const position = await dragToSpace(page);
  const search = palette(page).getByRole("combobox");
  await expect(search).toBeFocused();
  await expect(
    palette(page).getByRole("option", { name: /Load CSV/ }),
  ).toHaveCount(0);
  await search.fill("JOIN");
  await expect(palette(page).getByRole("option")).toHaveCount(2);
  await search.press("ArrowDown");
  await expect(
    palette(page).getByRole("option", { selected: true }),
  ).toContainText("right");
  await page.screenshot({ path: "test-results/connection-palette.png" });
  expect(
    (await new AxeBuilder({ page }).include(".connection-palette").analyze())
      .violations,
  ).toEqual([]);
  const after = await choose(page, url, () => search.press("Enter"));
  const created = after.bundle!.flow.nodes.find(
    (node) => !before.bundle!.flow.nodes.some((old) => node.id === old.id),
  )!;
  expect(created.template).toBe("join");
  expect(created.position.x).toBeCloseTo(position.x, 1);
  expect(created.position.y).toBeCloseTo(position.y, 1);
  expect(after.bundle!.flow.edges).toEqual(
    expect.arrayContaining([
      ...before.bundle!.flow.edges,
      expect.objectContaining({
        source: "source",
        sourceHandle: "second",
        target: created.id,
        targetHandle: "right",
      }),
    ]),
  );
  expect(writes).toHaveLength(1);
  await page.reload();
  await expect(
    page.locator(`.react-flow__node[data-id="${created.id}"]`),
  ).toBeVisible();
  expect((await (await page.request.get(url)).json()).bundle.flow).toEqual(
    after.bundle!.flow,
  );
});

test("dragging from an occupied input replaces only that input with a chosen component output", async ({
  page,
}) => {
  const url = await prepare(page);
  await dragToSpace(page, "target", "target", "source");
  await expect(
    palette(page).getByRole("option", { name: /Export CSV/ }),
  ).toHaveCount(0);
  await palette(page).getByRole("combobox").fill("Reusable branch");
  const after = await choose(page, url, () =>
    palette(page).getByRole("option").click(),
  );
  const created = after.bundle!.flow.nodes.find(
    (node) => node.id !== "component" && node.component === "reusable",
  )!;
  expect(after.bundle!.flow.edges).toEqual([
    expect.objectContaining({
      source: created.id,
      sourceHandle: "rows",
      target: "target",
      targetHandle: "source",
    }),
  ]);
});

test("no matches, Escape and outside clicks leave the graph and revision unchanged", async ({
  page,
}) => {
  const url = await prepare(page);
  const before = await (await page.request.get(url)).json();
  await dragToSpace(page);
  await palette(page).getByRole("combobox").fill("no-such-node");
  await expect(palette(page).getByRole("status")).toHaveText(
    "No compatible nodes found.",
  );
  await palette(page).getByRole("combobox").press("Enter");
  await expect(palette(page)).toBeVisible();
  await palette(page).getByRole("combobox").press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await dragToSpace(page);
  await page.locator(".flow-toolbar").click({ position: { x: 5, y: 5 } });
  await expect(palette(page)).toHaveCount(0);
  const after = await (await page.request.get(url)).json();
  expect(after.revision).toBe(before.revision);
  expect(after.bundle).toEqual(before.bundle);
});

test("valid connections, node bodies and drops outside the canvas do not open the palette", async ({
  page,
}) => {
  const url = await prepare(page);
  await handle(page, "source", "source", "second").dragTo(
    handle(page, "target", "target", "source"),
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(url)).json()).bundle.flow.edges[0]
          .sourceHandle,
    )
    .toBe("second");
  await expect(palette(page)).toHaveCount(0);
  await handle(page, "source", "source", "second").dragTo(
    page.locator('.react-flow__node[data-id="target"] .node-shape'),
  );
  await expect(palette(page)).toHaveCount(0);
  await handle(page, "source", "source", "second").dragTo(
    page.locator(".flow-toolbar"),
  );
  await expect(palette(page)).toHaveCount(0);
});

test("nested additions stay in the opened component and exclude recursive definitions", async ({
  page,
}) => {
  const url = await prepare(page);
  const before: Snapshot = await (await page.request.get(url)).json();
  await page
    .locator('.react-flow__node[data-id="component"] .node-shape')
    .click();
  await page
    .getByRole("button", { name: "Open component", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await dragToSpace(page, "inner", "source", "result");
  await expect(
    palette(page).getByRole("option", { name: /Reusable branch/ }),
  ).toHaveCount(0);
  await palette(page).getByRole("combobox").fill("Filter");
  const after = await choose(page, url, () =>
    palette(page).getByRole("option").click(),
  );
  expect(after.bundle!.flow).toEqual(before.bundle!.flow);
  const nested = after.bundle!.components.reusable;
  expect(nested.nodes).toHaveLength(2);
  expect(nested.edges).toEqual([
    expect.objectContaining({
      source: "inner",
      sourceHandle: "result",
      target: nested.nodes[1].id,
      targetHandle: "source",
    }),
  ]);
});

test("touch dragging opens a localized palette that fits a small dark viewport", async ({
  page,
}) => {
  await prepare(page);
  await page.setViewportSize({ width: 800, height: 650 });
  await page.evaluate(() => {
    localStorage.setItem("duckpad-language", "fr");
    localStorage.setItem("duckpad-theme", "dark");
  });
  await page.reload();
  await page.getByRole("button", { name: fr.fitView, exact: true }).click();
  await dragToSpace(page, "source", "source", "second", true);
  const dialog = page.getByRole("dialog", { name: fr.addConnectedNode });
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await dialog.getByRole("combobox").fill(fr.join);
  await expect(dialog.getByRole("option")).toHaveCount(2);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(800);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(650);
  await page.screenshot({ path: "test-results/connection-palette-dark.png" });
  expect(
    (await new AxeBuilder({ page }).include(".connection-palette").analyze())
      .violations,
  ).toEqual([]);
  await dialog.getByRole("combobox").press("Escape");
});

test("a failed save leaves neither a new node nor a replacement edge", async ({
  page,
}) => {
  const url = await prepare(page);
  const before = await (await page.request.get(url)).json();
  await page.route(`**${url}`, async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 503,
        json: { error: "Simulated save failure" },
      });
    else await route.continue();
  });
  await dragToSpace(page, "target", "target", "source");
  await palette(page).getByRole("combobox").fill("Dual output");
  await palette(page).getByRole("option").last().click();
  await expect(page.getByRole("alert")).toContainText("Simulated save failure");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  expect((await (await page.request.get(url)).json()).bundle).toEqual(
    before.bundle,
  );
});

test("readers cannot open a connection palette or change the graph", async ({
  page,
}) => {
  const url = await prepare(page);
  const before: Snapshot = await (await page.request.get(url)).json();
  const username = `palette-reader-${Date.now()}`;
  const password = "palette-reader-password";
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
  await page.reload();
  await expect(page.locator(".palette-item").first()).toBeDisabled();
  await handle(page, "source", "source", "second").dragTo(
    page.locator(".react-flow__pane"),
    { targetPosition: { x: 600, y: 400 } },
  );
  await expect(palette(page)).toHaveCount(0);
  const after: Snapshot = await (await page.request.get(url)).json();
  expect(after.revision).toBe(before.revision);
  expect(after.bundle).toEqual(before.bundle);
});
