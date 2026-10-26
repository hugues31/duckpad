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
