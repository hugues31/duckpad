import { expect, test, type Page } from "@playwright/test";
import { canvasZoom, signIn } from "./helpers";
import type { Snapshot } from "../src/types";

type Point = { x: number; y: number };

async function open(page: Page, example: boolean) {
  await signIn(page);
  const response = await page.request.post(
    example ? "/api/example" : "/api/projects",
    { data: example ? {} : { name: "Palette drag placement" } },
  );
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto(`/worktrees/${id}/flow`);
  await expect(page.locator(".palette-item").first()).toBeVisible();
  return `/api/worktrees/${id}`;
}

const preview = (page: Page) => page.locator(".node-drag-preview");
const viewport = (page: Page) =>
  page
    .locator(".react-flow__viewport")
    .evaluate((element) => getComputedStyle(element).transform);

async function startDrag(page: Page, label: string) {
  const item = page
    .locator(".palette")
    .getByRole("button", { name: label, exact: true });
  await item.scrollIntoViewIfNeeded();
  const bounds = (await item.boundingBox())!;
  await page.mouse.move(bounds.x + 15, bounds.y + 10);
  await page.mouse.down();
  return { x: Math.round(bounds.x + 60), y: Math.round(bounds.y + 12) };
}

/** The preview's shape center follows the pointer, where the drop puts it. */
async function dragOver(page: Page, point: Point, accepted: boolean) {
  await page.mouse.move(point.x, point.y, { steps: 4 });
  // Blink tells whether a zone accepts the drop on its next dragover.
  await page.mouse.move(point.x, point.y);
  await expect(preview(page).locator(".node-shape")).toBeVisible();
  if (accepted) await expect(preview(page)).not.toHaveClass(/refused/);
  else await expect(preview(page)).toHaveClass(/refused/);
  const shape = (await preview(page).locator(".node-shape").boundingBox())!;
  expect(shape.x + shape.width / 2).toBeCloseTo(point.x, 0);
  expect(shape.y + shape.height / 2).toBeCloseTo(point.y, 0);
  return shape;
}

/** Drop under the pointer, without moving the viewport, as previewed. */
async function drop(page: Page, endpoint: string, point: Point) {
  const nodes = page.locator(".react-flow__node");
  const ids = () =>
    nodes.evaluateAll((elements) => elements.map((node) => node.dataset.id));
  const before = await ids();
  const transform = await viewport(page);
  const shape = await dragOver(page, point, true);
  const ports = await preview(page).locator(".handle-label").allTextContents();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(endpoint) &&
      response.request().method() === "PUT",
  );
  await page.mouse.up();
  expect((await saved).ok()).toBe(true);
  await expect(preview(page)).toHaveCount(0);
  await expect(nodes).toHaveCount(before.length + 1);
  const id = (await ids()).find((value) => !before.includes(value));
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(node).toHaveClass(/selected/);
  const dropped = (await node.locator(".node-shape").boundingBox())!;
  expect(dropped.x).toBeCloseTo(shape.x, 0);
  expect(dropped.y).toBeCloseTo(shape.y, 0);
  expect(dropped.width).toBeCloseTo(shape.width, 1);
  expect(await node.locator(".handle-label").allTextContents()).toEqual(ports);
  expect(await viewport(page)).toBe(transform);
  // The saved position is the rendered one.
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const created = snapshot.bundle!.flow.nodes.find((n) => n.id === id)!;
  const [x, y] = await node.evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return [matrix.e, matrix.f];
  });
  expect(x).toBeCloseTo(created.position!.x, 1);
  expect(y).toBeCloseTo(created.position!.y, 1);
  return node;
}

test("palette drags preview nodes at the canvas zoom and refuse drops outside the canvas", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const endpoint = await open(page, true);
  const area = (await page.locator(".canvas-safe-area").boundingBox())!;
  const point = {
    x: Math.round(area.x + area.width / 2),
    y: Math.round(area.y + area.height / 2),
  };
  // Move the graph away from the drop point.
  await page.mouse.move(area.x + area.width - 10, area.y + 30);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width - 160, area.y + 80, { steps: 6 });
  await page.mouse.up();
  await page.locator(".react-flow__node").first().click();
  const search = (await page.locator(".canvas-search").boundingBox())!;
  await expect(page.locator(".inspector")).toBeVisible();
  const inspector = (await page.locator(".inspector").boundingBox())!;
  for (const entry of [
    { label: "Join", shape: "round-node", zoom: 0 },
    { label: "Export CSV", shape: "square-node", zoom: -20 },
    { label: "Regional report", shape: "component", zoom: 22 },
  ]) {
    for (let n = 0; n < Math.abs(entry.zoom); n++) {
      const control = page.getByRole("button", {
        name: entry.zoom > 0 ? "Zoom in" : "Zoom out",
        exact: true,
      });
      if (await control.isDisabled()) break;
      await control.click();
    }
    const zoom = await canvasZoom(page);
    if (entry.zoom) expect(zoom).toBe(entry.zoom < 0 ? 0.1 : 1.8);
    const palette = await startDrag(page, entry.label);
    const shape = await dragOver(page, palette, false);
    expect(shape.width).toBeCloseTo(96 * zoom, 1);
    // The search field and the inspector cover the canvas without accepting drops.
    await dragOver(page, { x: search.x + 40, y: search.y + 15 }, false);
    await dragOver(
      page,
      { x: inspector.x + 80, y: inspector.y + inspector.height / 2 },
      false,
    );
    await expect(preview(page).locator(".pipeline-node")).toHaveClass(
      new RegExp(entry.shape),
    );
    await expect(preview(page).locator(".node-title")).toHaveText(entry.label);
    await drop(page, endpoint, point);
  }
  expect(errors).toEqual([]);
});

test("a first palette drop keeps the viewport, and a canceled drag adds nothing", async ({
  page,
}) => {
  const endpoint = await open(page, false);
  await dragOver(page, await startDrag(page, "Filter"), false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(preview(page)).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  expect(snapshot.bundle!.flow.nodes).toEqual([]);

  const area = (await page.locator(".canvas-safe-area").boundingBox())!;
  await startDrag(page, "Load CSV");
  // Outside the window, no event reports the pointer: the preview hides.
  await page.mouse.move(-5, area.y + 40, { steps: 4 });
  await expect(preview(page).locator(".node-shape")).toBeHidden();
  const node = await drop(page, endpoint, {
    x: Math.round(area.x + area.width / 3),
    y: Math.round(area.y + area.height / 3),
  });
  await expect(node.locator(".pipeline-node")).toHaveClass(/square-node/);
});
