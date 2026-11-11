import { expect, test, type Page } from "@playwright/test";
import { createFilterProject } from "./helpers";

async function prepare(page: Page) {
  return createFilterProject(page, (bundle) => {
    bundle.flow.nodes[1].position = { x: 350, y: 260 };
    bundle.flow.nodes[2].position = { x: 700, y: 120 };
    bundle.flow.edges = [
      {
        id: "direct",
        source: "rows",
        sourceHandle: "result",
        target: "output",
        targetHandle: "source",
      },
    ];
  });
}

async function edgePoint(page: Page, id = "direct") {
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  const path = page.locator(
    `.react-flow__edge[data-id="${id}"] .react-flow__edge-path`,
  );
  // Horizontal SVG paths have zero-height bounds even though their stroke is visible.
  await expect(path).toBeAttached();
  return path.evaluate((element: SVGPathElement) => {
    const point = element.getPointAtLength(element.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(
      element.getScreenCTM()!,
    );
    return { x: screen.x, y: screen.y };
  });
}

async function moveOntoEdge(
  page: Page,
  id: string,
  highlight: boolean,
  edge = "direct",
) {
  const point = await edgePoint(page, edge);
  const shape = page.locator(`.react-flow__node[data-id="${id}"] .node-shape`);
  const bounds = (await shape.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 12 });
  const target = page.locator(".react-flow__edge.insertion-target");
  await expect(target).toHaveCount(highlight ? 1 : 0);
}

for (const style of ["curved", "orthogonal"]) {
  test(`insert an existing node on a ${style} edge, then undo, redo and reload`, async ({
    page,
  }) => {
    const { read } = await prepare(page);
    await page.evaluate(
      (value) => localStorage.setItem("duckpad-edge-style", value),
      style,
    );
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    const before = (await read()).bundle!.flow;
    await moveOntoEdge(page, "filtered", true);
    // A drag previews the change without saving it.
    expect((await read()).bundle!.flow).toEqual(before);
    await page.mouse.up();
    await expect
      .poll(async () => (await read()).bundle!.flow.edges.length)
      .toBe(2);
    const after = (await read()).bundle!.flow;
    expect(after.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "rows",
          sourceHandle: "result",
          target: "filtered",
          targetHandle: "source",
        }),
        expect.objectContaining({
          source: "filtered",
          sourceHandle: "result",
          target: "output",
          targetHandle: "source",
        }),
      ]),
    );
    expect(after.nodes[1].position).not.toEqual(before.nodes[1].position);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await read()).bundle!.flow).toEqual(before);
    await expect(page.locator(".toast")).toContainText("Change undone");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await read()).bundle!.flow).toEqual(after);
    await page.reload();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    expect((await read()).bundle!.flow).toEqual(after);
  });
}

test("palette insertion saves the new node and both links together", async ({
  page,
}) => {
  const { read } = await prepare(page);
  const before = (await read()).bundle!.flow;
  const item = page
    .locator(".palette")
    .getByRole("button", { name: "Filter", exact: true });
  await item.scrollIntoViewIfNeeded();
  const bounds = (await item.boundingBox())!;
  const point = await edgePoint(page);
  await page.mouse.move(bounds.x + 15, bounds.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 65, bounds.y + 10, { steps: 4 });
  await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".react-flow__edge.insertion-target")).toHaveCount(
    1,
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await read()).bundle!.flow.nodes.length)
    .toBe(4);
  const after = (await read()).bundle!.flow;
  const created = after.nodes.find(
    (node) => !before.nodes.some((old) => old.id === node.id),
  )!;
  expect(after.edges).toHaveLength(2);
  expect(after.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "rows",
        target: created.id,
        targetHandle: "source",
      }),
      expect.objectContaining({
        source: created.id,
        sourceHandle: "result",
        target: "output",
      }),
    ]),
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await read()).bundle!.flow).toEqual(before);
});

test("a node with an occupied input moves without rewiring", async ({
  page,
}) => {
  const { read } = await createFilterProject(page);
  const before = (await read()).bundle!.flow;
  await moveOntoEdge(page, "output", false, "first");
  await page.mouse.up();
  await expect
    .poll(async () => (await read()).bundle!.flow.nodes[2].position)
    .not.toEqual(before.nodes[2].position);
  expect((await read()).bundle!.flow.edges).toEqual(before.edges);
});

test("a rejected insertion restores the saved positions and links", async ({
  page,
}) => {
  const { endpoint, read } = await prepare(page);
  const before = (await read()).bundle!.flow;
  await page.route(`**${endpoint}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Insertion refused" }),
        })
      : route.continue(),
  );
  await moveOntoEdge(page, "filtered", true);
  await page.mouse.up();
  await expect(page.locator(".toast")).toContainText("Insertion refused");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="filtered"]')).toHaveCSS(
    "transform",
    `matrix(1, 0, 0, 1, ${before.nodes[1].position.x}, ${before.nodes[1].position.y})`,
  );
  expect((await read()).bundle!.flow).toEqual(before);
});
