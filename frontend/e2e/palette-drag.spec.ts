import { expect, test, type Page } from "@playwright/test";
import { canvasZoom, signIn } from "./helpers";

async function prepare(page: Page, example = false) {
  await signIn(page);
  const response = await page.request.post(
    example ? "/api/example" : "/api/projects",
    { data: example ? {} : { name: "Palette drag placement" } },
  );
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto(`/worktrees/${id}/flow`);
  await expect(page.locator(".palette-item").first()).toBeVisible();
  // Native drag images are outside page screenshots. Observe the real browser
  // API without replacing it, including its image dimensions and pointer anchor.
  await page.evaluate(() => {
    const original = DataTransfer.prototype.setDragImage;
    DataTransfer.prototype.setDragImage = function (image, x, y) {
      const shape = image.querySelector(".node-shape")!;
      const bounds = image.getBoundingClientRect();
      const rect = shape.getBoundingClientRect();
      document.body.dataset.dragImage = JSON.stringify({
        nodeClass: image.querySelector(".pipeline-node")!.className,
        label: image.querySelector(".node-title")!.textContent,
        ports: [...image.querySelectorAll(".handle-label")].map(
          (port) => port.textContent,
        ),
        width: rect.width,
        height: rect.height,
        offsetX: x - (rect.x + rect.width / 2 - bounds.x),
        offsetY: y - (rect.y + rect.height / 2 - bounds.y),
      });
      original.call(this, image, x, y);
    };
  });
  return id as string;
}

const viewport = (page: Page) =>
  page
    .locator(".react-flow__viewport")
    .evaluate((element) => getComputedStyle(element).transform);

for (const entry of [
  { label: "Load CSV", shape: "source-node", zoom: 0, example: false },
  { label: "Join", shape: "round-node", zoom: -2, example: true },
  { label: "Export CSV", shape: "round-node", zoom: 2, example: true },
  { label: "Regional report", shape: "component", zoom: -1, example: true },
]) {
  test(`dragging ${entry.label} previews its shape and drops at the pointer`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const id = await prepare(page, entry.example);
    const nodes = page.locator(".react-flow__node");
    const before = await nodes.count();
    const area = (await page.locator(".canvas-safe-area").boundingBox())!;
    if (entry.example) {
      // Move away from the initial fit before choosing a non-default zoom.
      await page.mouse.move(area.x + area.width - 10, area.y + 30);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width - 160, area.y + 80, {
        steps: 6,
      });
      await page.mouse.up();
      for (let n = 0; n < Math.abs(entry.zoom); n++) {
        await page
          .getByRole("button", {
            name: entry.zoom > 0 ? "Zoom in" : "Zoom out",
            exact: true,
          })
          .click();
      }
    }
    const zoom = await canvasZoom(page);
    const transform = await viewport(page);
    const point = {
      x: Math.round(area.x + area.width / 2),
      y: Math.round(area.y + area.height / 2),
    };
    const pane = page.locator(".react-flow__pane");
    const bounds = (await pane.boundingBox())!;
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/worktrees/${id}`) &&
        response.request().method() === "PUT",
    );
    await page
      .locator(".palette")
      .getByRole("button", { name: entry.label, exact: true })
      .dragTo(pane, {
        sourcePosition: { x: 15, y: 10 },
        targetPosition: { x: point.x - bounds.x, y: point.y - bounds.y },
      });
    expect((await saved).ok()).toBe(true);
    await expect(nodes).toHaveCount(before + 1);
    const node = nodes.filter({ has: page.locator(".is-selected") });
    await expect(node).toHaveCount(1);
    const shape = (await node.locator(".node-shape").boundingBox())!;
    expect(shape.x + shape.width / 2).toBeCloseTo(point.x, 0);
    expect(shape.y + shape.height / 2).toBeCloseTo(point.y, 0);
    expect(await viewport(page)).toBe(transform);

    const image = await page.evaluate(() =>
      JSON.parse(document.body.dataset.dragImage!),
    );
    expect(image.nodeClass).toContain(entry.shape);
    expect(image.label).toBe(entry.label);
    expect(image.ports).toEqual(
      await node.locator(".handle-label").allTextContents(),
    );
    expect(image.width).toBeCloseTo(96 * zoom, 1);
    expect(image.height).toBeCloseTo(96 * zoom, 1);
    expect(image.width).toBeCloseTo(shape.width, 1);
    expect(image.offsetX).toBe(0);
    expect(image.offsetY).toBe(0);
    await expect(page.locator(".node-drag-image")).toHaveCount(0);

    const endpoint = `/api/worktrees/${id}`;
    const snapshot = await (await page.request.get(endpoint)).json();
    const created = snapshot.bundle.flow.nodes.at(-1);
    await page.reload();
    await expect(nodes).toHaveCount(before + 1);
    const reloaded = await (await page.request.get(endpoint)).json();
    expect(reloaded.bundle.flow.nodes.at(-1).position).toEqual(
      created.position,
    );
    expect(errors).toEqual([]);
  });
}

test("canceling a palette drag leaves the graph unchanged", async ({
  page,
}) => {
  const id = await prepare(page);
  const item = page
    .locator(".palette")
    .getByRole("button", { name: "Filter", exact: true });
  const bounds = (await item.boundingBox())!;
  await page.mouse.move(bounds.x + 20, bounds.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 40, bounds.y + 10, { steps: 5 });
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.dragImage))
    .toBeTruthy();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".node-drag-image")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const snapshot = await (
    await page.request.get(`/api/worktrees/${id}`)
  ).json();
  expect(snapshot.bundle.flow.nodes).toEqual([]);
});
