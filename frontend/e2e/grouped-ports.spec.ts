import { expect, test, type Locator, type Page } from "@playwright/test";
import { autosaved, createFilterProject } from "./helpers";

const node = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);
const group = (page: Page, id: string, side: "in" | "out") =>
  node(page, id).locator(`.node-port-group.${side}`);
const handle = (page: Page, id: string, port: string) =>
  node(page, id).locator(`.react-flow__handle[data-handleid="${port}"]`);

async function center(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function crowdedProject(page: Page) {
  return createFilterProject(page, (bundle) => {
    bundle.templates.rows = Array.from(
      { length: 5 },
      (_, index) =>
        `-- @output ${index ? `out${index + 1}` : "result"}\nSELECT 1 AS amount;`,
    ).join("\n");
    bundle.templates.crowded =
      Array.from(
        { length: 8 },
        (_, index) => `-- @input ${index ? `input${index + 1}` : "source"}`,
      ).join("\n") +
      "\n" +
      Array.from(
        { length: 4 },
        (_, index) =>
          `-- @output ${index ? `out${index + 1}` : "result"}\nSELECT 1 AS amount;`,
      ).join("\n");
    bundle.flow.nodes[1].template = "crowded";
    bundle.templates.inner =
      Array.from(
        { length: 5 },
        (_, index) => `-- @input input${index + 1}`,
      ).join("\n") +
      "\n" +
      Array.from(
        { length: 5 },
        (_, index) => `-- @output out${index + 1}\nSELECT 1 AS amount;`,
      ).join("\n");
    bundle.components.crowded = {
      name: "Many ports",
      nodes: [
        {
          id: "inner",
          template: "inner",
          params: {},
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      inputs: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          i ? `input${i + 1}` : "source",
          { node: "inner", port: `input${i + 1}` },
        ]),
      ),
      outputs: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `out${i + 1}`,
          { node: "inner", port: `out${i + 1}` },
        ]),
      ),
    };
    delete bundle.flow.nodes[2].template;
    bundle.flow.nodes[2].component = "crowded";
  });
}

test("five ports fold per side, expand on approach, and keep links attached without saving", async ({
  page,
}) => {
  const { read } = await crowdedProject(page);
  const before = await read();
  await expect(
    group(page, "rows", "out").getByRole("button", {
      name: "5 outputs",
      exact: true,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(group(page, "filtered", "in")).toHaveAttribute(
    "data-expanded",
    "false",
  );
  await expect(group(page, "filtered", "out")).toHaveCount(0);
  await expect(node(page, "filtered").locator(".source")).toHaveCount(4);
  await expect(group(page, "output", "in")).toHaveAttribute(
    "data-expanded",
    "false",
  );
  await expect(group(page, "output", "out")).toHaveAttribute(
    "data-expanded",
    "false",
  );

  const wire = page.locator(
    '.react-flow__edge[data-id="first"] .react-flow__edge-path',
  );
  const foldedPath = await wire.getAttribute("d");
  const oval = await center(group(page, "filtered", "in"));
  // Open before reaching the oval, including while a wire is being dragged.
  await page.mouse.move(oval.x - 18, oval.y);
  await expect(group(page, "filtered", "in")).toHaveAttribute(
    "data-expanded",
    "true",
  );
  await expect(handle(page, "filtered", "input8")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await expect(wire).not.toHaveAttribute("d", foldedPath!);
  const ports = await node(page, "filtered")
    .locator(".target")
    .evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().y),
    );
  expect(new Set(ports).size).toBe(8);
  await page.mouse.move(0, 0);
  await expect(group(page, "filtered", "in")).toHaveAttribute(
    "data-expanded",
    "false",
  );
  await expect(wire).toHaveAttribute("d", foldedPath!);
  expect((await read()).commit).toBe(before.commit);
  await group(page, "rows", "out").locator(".node-port-toggle").dblclick();
  await expect(
    page.getByRole("complementary", { name: "Code editor", exact: true }),
  ).toHaveCount(0);
  expect((await read()).commit).toBe(before.commit);

  // Changing a definition across the threshold refreshes handles without a reload.
  const next = await read();
  next.bundle!.templates.crowded += "\n-- @output out5\nSELECT 1 AS amount;";
  expect(
    (
      await page.request.put(`/api/worktrees/${next.worktree.id}`, {
        data: { revision: next.revision, bundle: next.bundle },
      })
    ).ok(),
  ).toBe(true);
  await expect(group(page, "filtered", "out")).toHaveAttribute(
    "data-expanded",
    "false",
  );
});

test("dragging to a collapsed group chooses the exact port and survives folding, undo and reload", async ({
  page,
}) => {
  const { read } = await crowdedProject(page);
  const before = (await read()).bundle!.flow;
  await group(page, "rows", "out").hover();
  const start = await center(handle(page, "rows", "out5"));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 80, { steps: 5 });
  await expect(group(page, "rows", "out")).toHaveAttribute(
    "data-expanded",
    "true",
  );
  const target = await center(group(page, "filtered", "in"));
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(group(page, "filtered", "in")).toHaveAttribute(
    "data-expanded",
    "true",
  );
  const end = await center(handle(page, "filtered", "input8"));
  await autosaved(
    page,
    async () => {
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
    },
    true,
  );
  // The pressed socket is hidden once folded: it must not keep the focus,
  // where it would swallow the canvas shortcuts.
  await expect(node(page, "rows")).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(group(page, "rows", "out")).toHaveAttribute(
    "data-expanded",
    "false",
  );
  await expect(group(page, "filtered", "in")).toHaveAttribute(
    "data-expanded",
    "false",
  );
  const after = (await read()).bundle!.flow;
  expect(after.nodes).toEqual(before.nodes);
  expect(after.edges).toHaveLength(3);
  expect(after.edges.at(-1)).toMatchObject({
    source: "rows",
    sourceHandle: "out5",
    target: "filtered",
    targetHandle: "input8",
  });
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await read()).bundle!.flow).toEqual(before);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await read()).bundle!.flow).toEqual(after);
  await page.reload();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(group(page, "filtered", "in")).toHaveAttribute(
    "data-expanded",
    "false",
  );
  expect((await read()).bundle!.flow).toEqual(after);
});

test("keyboard focus reveals ports, Escape dismisses them, and keyboard connections use their names", async ({
  page,
}) => {
  const { read } = await crowdedProject(page);
  const before = await read();
  const toggle = group(page, "rows", "out").locator(".node-port-toggle");
  await toggle.focus();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(handle(page, "rows", "result")).toBeFocused();
  await handle(page, "rows", "out5").focus();
  await page.keyboard.press("Enter");
  await group(page, "output", "in").locator(".node-port-toggle").focus();
  await handle(page, "output", "input5").focus();
  await autosaved(page, () => page.keyboard.press("Space"), true);
  expect((await read()).bundle!.flow.edges.at(-1)).toMatchObject({
    source: "rows",
    sourceHandle: "out5",
    target: "output",
    targetHandle: "input5",
  });
  expect((await read()).bundle!.flow.nodes).toEqual(before.bundle!.flow.nodes);
  // Undo still applies while a socket has the focus.
  await expect(handle(page, "output", "input5")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await read()).bundle!.flow)
    .toEqual(before.bundle!.flow);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("tapping named sockets connects the chosen ports", async ({ page }) => {
    const { read } = await crowdedProject(page);
    await group(page, "rows", "out").locator(".node-port-toggle").tap();
    await handle(page, "rows", "out5").tap();
    await group(page, "output", "in").locator(".node-port-toggle").tap();
    await autosaved(page, () => handle(page, "output", "input5").tap());
    expect((await read()).bundle!.flow.edges.at(-1)).toMatchObject({
      source: "rows",
      sourceHandle: "out5",
      target: "output",
      targetHandle: "input5",
    });
  });
  test("a tap opens the oval and tapping outside closes it", async ({
    page,
  }) => {
    const { read } = await crowdedProject(page);
    const before = await read();
    const toggle = group(page, "output", "out").locator(".node-port-toggle");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(handle(page, "output", "out5")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    await page.getByRole("button", { name: "Fit view", exact: true }).tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect((await read()).commit).toBe(before.commit);
  });
});

test("a link end beside an expanded socket can be dragged to another port", async ({
  page,
}) => {
  const { read } = await crowdedProject(page);
  const before = (await read()).bundle!.flow;
  await group(page, "filtered", "in").hover();
  const endpoint = page.locator(
    '.react-flow__edge[data-id="first"] .react-flow__edgeupdater-target',
  );
  // The link end lies outside the list, which stays open while the pointer rests there.
  await endpoint.hover();
  await page.waitForTimeout(400);
  await expect(group(page, "filtered", "in")).toHaveAttribute(
    "data-expanded",
    "true",
  );
  await page.mouse.down();
  const target = await center(group(page, "output", "in"));
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(group(page, "output", "in")).toHaveAttribute(
    "data-expanded",
    "true",
  );
  const end = await center(handle(page, "output", "input5"));
  await autosaved(page, async () => {
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  });
  expect((await read()).bundle!.flow.edges).toEqual([
    { ...before.edges[0], target: "output", targetHandle: "input5" },
    before.edges[1],
  ]);
});
