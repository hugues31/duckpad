import { expect, test, type Page } from "@playwright/test";
import type { FlowEdge, FlowNode, Snapshot } from "../src/types";
import { autosaved, signIn } from "./helpers";

const node = (id: string, x: number, y = 0): FlowNode => ({
  id,
  label: id,
  template: id === "source" || id === "backup" ? "rows" : "filter",
  params: { condition: "true" },
  position: { x, y },
});
const edge = (source: string, target: string): FlowEdge => ({
  id: `${source}_${target}`,
  source,
  target,
  sourceHandle: "result",
  targetHandle: "source",
});
const canvasNode = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`);

async function prepare(page: Page, nested: boolean) {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Acyclic connections" },
    })
  ).json();
  const url = `/api/worktrees/${worktree.id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(url)).json();
  const snapshot = await read();
  const bundle = snapshot.bundle!;
  bundle.templates.rows = "-- @output result\nSELECT 1 AS amount;";
  const transforms = [
    node("first", 250),
    node("second", 500),
    node("third", 750),
  ];
  bundle.components.chain = {
    name: "Chain",
    nodes: [...transforms, node("backup", 250, 220)],
    edges: [edge("first", "second"), edge("second", "third")],
    inputs: { source: { node: "first", port: "source" } },
    outputs: { result: { node: "third", port: "result" } },
  };
  bundle.flow.nodes = [
    node("source", 0),
    node("backup", 0, 220),
    ...transforms.slice(0, 2),
    {
      id: "third",
      label: "Chain",
      component: "chain",
      params: {},
      position: { x: 750, y: 0 },
    },
  ];
  bundle.flow.edges = [
    edge("source", "first"),
    edge("first", "second"),
    edge("second", "third"),
  ];
  expect(
    (
      await page.request.put(url, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  if (nested) {
    await canvasNode(page, "third").locator(".node-shape").dblclick();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
  }
  return read;
}

async function connect(
  page: Page,
  source: string,
  target: string,
  reverse = false,
) {
  const output = canvasNode(page, source).locator(
    '.react-flow__handle.source[data-handleid="result"]',
  );
  const input = canvasNode(page, target).locator(
    '.react-flow__handle.target[data-handleid="source"]',
  );
  const from = await (reverse ? input : output).boundingBox();
  const to = await (reverse ? output : input).boundingBox();
  expect(from).toBeTruthy();
  expect(to).toBeTruthy();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}

for (const nested of [false, true]) {
  test(`refuses cyclic connections ${nested ? "inside a component" : "across the flow"} and keeps valid replacements`, async ({
    page,
  }) => {
    const read = await prepare(page, nested);
    const target = nested ? "second" : "first";
    const upstream = nested ? "first" : "source";
    await canvasNode(page, target).locator(".node-shape").click();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    const input = page
      .locator(".inspector")
      .getByLabel("source", { exact: true });
    await expect(input).toHaveValue(`${upstream}:result`);
    await expect(input.locator(`option[value="${target}:result"]`)).toHaveCount(
      0,
    );
    await expect(input.locator('option[value="third:result"]')).toHaveCount(0);
    if (!nested)
      await expect(input.locator('option[value="second:result"]')).toHaveCount(
        0,
      );
    const before = await read();
    const saves: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT") saves.push(request.url());
    });
    await connect(page, target, target);
    await connect(page, "third", target);
    await connect(page, "third", target, true);
    expect(saves).toEqual([]);
    expect((await read()).commit).toBe(before.commit);
    await expect(
      page.getByRole("dialog", { name: "Add a connected node" }),
    ).toHaveCount(0);

    await autosaved(page, () => connect(page, "backup", target));
    const saved = await read();
    const graph = nested ? saved.bundle!.components.chain : saved.bundle!.flow;
    const original = nested
      ? before.bundle!.components.chain
      : before.bundle!.flow;
    expect(graph.edges).toEqual([
      ...original.edges.filter((item) => item.target !== target),
      expect.objectContaining({
        source: "backup",
        target,
        targetHandle: "source",
      }),
    ]);
    await expect(input).toHaveValue("backup:result");
    await autosaved(page, () => input.selectOption(`${upstream}:result`));
    await page.reload();
    const restored = await read();
    const restoredGraph = nested
      ? restored.bundle!.components.chain
      : restored.bundle!.flow;
    expect(
      restoredGraph.edges.map(({ id: _id, ...connection }) => connection),
    ).toEqual(
      expect.arrayContaining(
        original.edges.map(({ id: _id, ...connection }) => connection),
      ),
    );
  });
}
