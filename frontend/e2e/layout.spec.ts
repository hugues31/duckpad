import { test, expect, type Page } from "@playwright/test";
import type { Graph, Snapshot } from "../src/types";
import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn } from "./helpers";

async function openWorktree(page: Page, id: string) {
  await page.evaluate((id) => localStorage.setItem("duckpad-worktree", id), id);
  await page.reload();
  await expect(page.locator(".react-flow__controls")).toBeVisible();
}

function expectArranged(before: Graph, after: Graph) {
  expect(after.nodes.map(({ position: _position, ...node }) => node)).toEqual(
    before.nodes.map(({ position: _position, ...node }) => node),
  );
  expect(after.edges).toEqual(before.edges);
  expect(after.nodes).not.toEqual(before.nodes);
  for (const edge of after.edges) {
    const source = after.nodes.find((node) => node.id === edge.source)!;
    const target = after.nodes.find((node) => node.id === edge.target)!;
    expect(source.position.x + 150).toBeLessThan(target.position.x);
  }
  for (const [index, node] of after.nodes.entries()) {
    expect(Number.isFinite(node.position.x + node.position.y)).toBe(true);
    for (const other of after.nodes.slice(index + 1)) {
      expect(
        Math.abs(node.position.x - other.position.x) >= 150 ||
          Math.abs(node.position.y - other.position.y) >= 150,
      ).toBe(true);
    }
  }
}

async function arrange(page: Page, url: string) {
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(url) && response.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "Auto-arrange nodes", exact: true })
    .click();
  expect((await saved).ok()).toBe(true);
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
  return (await (await page.request.get(url)).json()) as Snapshot;
}

test("auto-arrange saves only the current DAG, preserves selection and frames the result", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const url = `/api/worktrees/${worktree.id}`;
  const original: Snapshot = await (await page.request.get(url)).json();
  const graph = original.bundle!.flow;
  graph.nodes.push({
    ...graph.nodes[0],
    id: "disconnected",
    label: "Disconnected source",
  });
  graph.nodes.forEach((node) => {
    node.position = { x: 100, y: 100 };
  });
  expect(
    (
      await page.request.put(url, {
        data: { revision: original.revision, bundle: original.bundle },
      })
    ).ok(),
  ).toBe(true);
  await openWorktree(page, worktree.id);
  await expect(page.locator(".canvas-footer")).toHaveCount(0);
  const layoutGroup = page.getByRole("group", {
    name: "Auto-arrange nodes",
    exact: true,
  });
  const navigation = page.locator(".react-flow__controls");
  await expect(layoutGroup.getByRole("button")).toHaveCount(1);
  await expect(navigation.getByRole("button")).toHaveCount(3);
  const groupBounds = (await layoutGroup.boundingBox())!;
  const navigationBounds = (await navigation.boundingBox())!;
  expect(
    groupBounds.x - navigationBounds.x - navigationBounds.width,
  ).toBeGreaterThanOrEqual(8);
  expect(groupBounds.y).toBe(navigationBounds.y);
  const before: Snapshot = await (await page.request.get(url)).json();
  const after = await arrange(page, url);
  expectArranged(before.bundle!.flow, after.bundle!.flow);
  expect(after.bundle!.components).toEqual(before.bundle!.components);
  expect(after.bundle!.templates).toEqual(before.bundle!.templates);
  const positions = await page
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).style.transform),
    );
  await page.reload();
  await expect
    .poll(() =>
      page
        .locator(".react-flow__node")
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLElement).style.transform),
        ),
    )
    .toEqual(positions);

  const component = after.bundle!.flow.nodes.find(
    (node) => node.label === "Regional revenue",
  )!;
  await page.locator(`.react-flow__node[data-id="${component.id}"]`).dblclick();
  await expect(page.locator(".component-notice")).toBeVisible();
  const componentGraph = after.bundle!.components[
    component.component!
  ] as Graph;
  await expect(page.locator(".react-flow__node")).toHaveCount(
    componentGraph.nodes.length,
  );
  await page.locator(".react-flow__node").first().click();
  const selected = await page
    .locator(".react-flow__node.selected")
    .getAttribute("data-id");
  const nested = await arrange(page, url);
  expectArranged(
    componentGraph,
    nested.bundle!.components[component.component!] as Graph,
  );
  expect(nested.bundle!.flow).toEqual(after.bundle!.flow);
  for (const [id, definition] of Object.entries(after.bundle!.components)) {
    if (id !== component.component)
      expect(nested.bundle!.components[id]).toEqual(definition);
  }
  await expect(page.locator(".react-flow__node.selected")).toHaveAttribute(
    "data-id",
    selected!,
  );
  await expect(page.locator(".preview-panel")).toBeVisible();
  await page.screenshot({ path: "test-results/auto-layout-component.png" });
  const username = `layout-reader-${Date.now()}`;
  const password = "layout-reader-password";
  const reader = await (
    await page.request.post("/api/users", {
      data: { username, password },
    })
  ).json();
  expect(
    (
      await page.request.put(
        `/api/projects/${after.worktree.project}/members/${reader.id}`,
        {
          data: { role: "reader" },
        },
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
  await expect(page.locator(".react-flow__node")).toHaveCount(
    graph.nodes.length,
  );
  await expect(
    page.getByRole("button", { name: "Auto-arrange nodes", exact: true }),
  ).toBeDisabled();
});

for (const failSave of [false, true]) {
  test(`node drops stay in place during a slow save${failSave ? " and roll back on failure" : " and ignore stale polls"}`, async ({
    page,
  }) => {
    await signIn(page);
    const worktree = await (
      await page.request.post("/api/example", { data: {} })
    ).json();
    await openWorktree(page, worktree.id);
    const url = `/api/worktrees/${worktree.id}`;
    const orders = page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("Orders", { exact: true }) });
    await orders.click();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    let releaseSave!: () => void;
    let releasePoll!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let writeBlocked = false;
    let pollBlocked = false;
    let pollReleased = false;
    await page.route(`**${url}`, async (route) => {
      if (route.request().method() === "PUT") {
        writeBlocked = true;
        await saveGate;
        if (failSave) {
          await route.fulfill({
            status: 503,
            json: { error: "Simulated save failure" },
          });
          return;
        }
      } else if (!pollBlocked) {
        const response = await route.fetch();
        pollBlocked = true;
        await pollGate;
        await route.fulfill({ response });
        pollReleased = true;
        return;
      }
      await route.continue();
    });
    try {
      await expect.poll(() => pollBlocked).toBe(true);
      const original = await orders.evaluate(
        (element) => (element as HTMLElement).style.transform,
      );
      const shape = (await orders.locator(".node-shape").boundingBox())!;
      await page.mouse.move(
        shape.x + shape.width / 2,
        shape.y + shape.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        shape.x + shape.width / 2 + 45,
        shape.y + shape.height / 2 + 30,
        { steps: 10 },
      );
      const dropped = await orders.evaluate(
        (element) => (element as HTMLElement).style.transform,
      );
      expect(dropped).not.toBe(original);
      await orders.evaluate((element) => {
        const node = element as HTMLElement;
        const positions = [node.style.transform];
        (window as any).dropPositions = positions;
        const observer = new MutationObserver(() =>
          positions.push(node.style.transform),
        );
        observer.observe(node, {
          attributes: true,
          attributeFilter: ["style"],
        });
        (window as any).dropObserver = observer;
      });
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith(url) && response.request().method() === "PUT",
      );
      await page.mouse.up();
      await expect.poll(() => writeBlocked).toBe(true);
      // Selection refreshes node data while the server still holds the old position.
      await page
        .locator(".react-flow__node")
        .filter({ has: page.getByText("Customers", { exact: true }) })
        .click();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      expect(
        await page.evaluate(() =>
          (window as any).dropPositions.every(
            (position: string) => position === (window as any).dropPositions[0],
          ),
        ),
      ).toBe(true);
      releaseSave();
      expect((await saved).status()).toBe(failSave ? 503 : 200);
      await expect(
        page.getByText("All changes saved", { exact: true }),
      ).toBeVisible();
      if (failSave) {
        await expect(page.getByRole("alert")).toContainText(
          "Simulated save failure",
        );
        await expect(orders).toHaveCSS(
          "transform",
          await page.evaluate(
            (value) => new DOMMatrix(value).toString(),
            original!,
          ),
        );
      }
      releasePoll();
      await expect.poll(() => pollReleased).toBe(true);
      await page.waitForResponse(
        (response) =>
          response.url().endsWith(url) && response.request().method() === "GET",
      );
      if (!failSave) {
        expect(
          await page.evaluate(() =>
            (window as any).dropPositions.every(
              (position: string) =>
                position === (window as any).dropPositions[0],
            ),
          ),
        ).toBe(true);
        await page.reload();
        await expect
          .poll(() =>
            orders.evaluate(
              (element) => (element as HTMLElement).style.transform,
            ),
          )
          .toBe(dropped);
      }
    } finally {
      releaseSave();
      releasePoll();
      await page.evaluate(() => (window as any).dropObserver?.disconnect());
    }
  });
}

test("auto-arrange is disabled for empty graphs and has a French label on small screens", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", { data: { name: "Empty layout" } })
  ).json();
  await openWorktree(page, worktree.id);
  await expect(
    page.getByRole("button", { name: "Auto-arrange nodes", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => localStorage.setItem("duckpad-language", "fr"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const button = page.getByRole("button", { name: fr.autoLayout, exact: true });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  const bounds = (await button.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
});
