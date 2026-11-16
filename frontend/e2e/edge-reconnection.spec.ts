import { expect, test, type Locator, type Page } from "@playwright/test";
import { autosaved, createFilterProject } from "./helpers";
import type { Snapshot } from "../src/types";

const edge = (page: Page, id: string) =>
  page.locator(`.react-flow__edge[data-id="${id}"]`);
const endpoint = (page: Page, id: string, end: "source" | "target") =>
  edge(page, id).locator(`.react-flow__edgeupdater-${end}`);
const handle = (page: Page, id: string, type: string, port: string) =>
  page.locator(
    `.react-flow__node[data-id="${id}"] .react-flow__handle.${type}[data-handleid="${port}"]`,
  );
const palette = (page: Page) =>
  page.getByRole("dialog", { name: "Add a connected node", exact: true });

async function center(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function emptySpace(page: Page) {
  return page.locator(".canvas-safe-area").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (const y of [0.75, 0.25, 0.6]) {
      for (const x of [0.5, 0.75, 0.25]) {
        const point = {
          x: bounds.x + bounds.width * x,
          y: bounds.y + bounds.height * y,
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
}

async function dragEnd(
  page: Page,
  id: string,
  end: "source" | "target",
  destination: { x: number; y: number },
) {
  await endpoint(page, id, end).hover();
  const start = await center(endpoint(page, id, end));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 12 });
  await page.mouse.up();
}

test("moving a source keeps the link identity and persists through undo, redo and reload", async ({
  page,
}) => {
  const { read } = await createFilterProject(page, (bundle) => {
    bundle.templates.rows += "\n-- @output alternate\nSELECT 2 AS amount;";
  });
  const before = (await read()).bundle!.flow;
  await autosaved(page, async () => {
    await dragEnd(
      page,
      "second",
      "source",
      await center(handle(page, "rows", "source", "alternate")),
    );
  });
  const after = (await read()).bundle!.flow;
  expect(after.nodes).toEqual(before.nodes);
  expect(after.edges).toEqual([
    before.edges[0],
    { ...before.edges[1], source: "rows", sourceHandle: "alternate" },
  ]);
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await read()).bundle!.flow).toEqual(before);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await read()).bundle!.flow).toEqual(after);
  await page.reload();
  await expect(edge(page, "second")).toBeVisible();
  expect((await read()).bundle!.flow).toEqual(after);
});

test("moving a target replaces its occupied input in one undoable save", async ({
  page,
}) => {
  const { read } = await createFilterProject(page);
  const before = (await read()).bundle!.flow;
  await autosaved(page, async () => {
    await dragEnd(
      page,
      "first",
      "target",
      await center(handle(page, "output", "target", "source")),
    );
  });
  expect((await read()).bundle!.flow.edges).toEqual([
    { ...before.edges[0], target: "output" },
  ]);
  await expect(edge(page, "second")).toHaveCount(0);
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await read()).bundle!.flow).toEqual(before);
});

for (const end of ["source", "target"] as const) {
  test(`dropping the ${end} end in empty space deletes only that link and can be undone`, async ({
    page,
  }) => {
    const { read } = await createFilterProject(page);
    const before = (await read()).bundle!.flow;
    await autosaved(page, async () => {
      await dragEnd(page, "second", end, await emptySpace(page));
    });
    expect((await read()).bundle!.flow).toEqual({
      ...before,
      edges: [before.edges[0]],
    });
    await expect(edge(page, "second")).toHaveCount(0);
    await expect(palette(page)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await read()).bundle!.flow).toEqual(before);
    await expect(endpoint(page, "second", end)).toBeVisible();
  });
}

test("clicking an endpoint and dropping on invalid targets leave the graph unchanged", async ({
  page,
}) => {
  const { read } = await createFilterProject(page);
  const before = await read();
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") saves.push(request.url());
  });
  await endpoint(page, "second", "target").click();
  for (const destination of [
    handle(page, "rows", "source", "result"),
    page.locator('.react-flow__node[data-id="rows"] .node-shape'),
    page.getByRole("navigation", { name: "Workspace", exact: true }),
    handle(page, "output", "target", "source"),
  ]) {
    await dragEnd(page, "second", "target", await center(destination));
    await expect(edge(page, "second")).toBeVisible();
    await expect(palette(page)).toHaveCount(0);
  }
  expect((await read()).bundle).toEqual(before.bundle);
  expect((await read()).commit).toBe(before.commit);
  expect(saves).toEqual([]);
});

test("links that would create a cycle are refused with a notice, except between ports a component keeps apart", async ({
  page,
}) => {
  const { read } = await createFilterProject(page, (bundle) => {
    // Two independent halves: the rows it loads, and the output of its input.
    const [rows, , output] = bundle.flow.nodes;
    bundle.components.halves = {
      name: "Halves",
      nodes: [rows, { ...output, id: "total" }],
      edges: [],
      inputs: { input: { node: "total", port: "source" } },
      outputs: {
        rows: { node: "rows", port: "result" },
        total: { node: "total", port: "result" },
      },
    };
    bundle.flow.nodes[0] = {
      id: "rows",
      component: "halves",
      params: {},
      position: rows.position,
    };
    bundle.flow.edges[0].sourceHandle = "rows";
  });
  const before = await read();
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") saves.push(request.url());
  });
  const input = page
    .locator(".inspector")
    .getByLabel("source", { exact: true });
  const choices = () =>
    input
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      );
  expect(await choices()).toEqual(["", "rows:rows", "rows:total"]);
  const notice = page.locator(".toast");
  const filterInput = handle(page, "filtered", "target", "source");
  const outputResult = handle(page, "output", "source", "result");
  const connect = async (from: Locator, to: Locator) => {
    const start = await center(from);
    const end = await center(to);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
  };
  for (const attempt of [
    () => connect(handle(page, "filtered", "source", "result"), filterInput),
    () => connect(outputResult, filterInput),
    () => connect(filterInput, outputResult),
    async () => dragEnd(page, "first", "source", await center(outputResult)),
    async () => dragEnd(page, "second", "target", await center(filterInput)),
  ]) {
    await attempt();
    await expect(notice).toHaveText(
      "This link would create a cycle: a node cannot read its own result.",
    );
    await notice.getByRole("button", { name: "Close", exact: true }).click();
    await expect(palette(page)).toHaveCount(0);
  }
  expect((await read()).bundle).toEqual(before.bundle);
  expect(saves).toEqual([]);

  // The component reads the filter it feeds: only its fed output closes a loop.
  await autosaved(page, () =>
    connect(outputResult, handle(page, "rows", "target", "input")),
  );
  await expect(notice).toHaveCount(0);
  expect((await read()).diagnostics).toEqual([]);
  expect(await choices()).toEqual(["", "rows:rows"]);
  await connect(handle(page, "rows", "source", "total"), filterInput);
  await expect(notice).toBeVisible();
  expect(saves).toHaveLength(1);
});

test("the selected link moves from an output shared by several links and is restored unselected", async ({
  page,
}) => {
  const { read } = await createFilterProject(page, (bundle) => {
    // Lower, so the link to it does not pass behind the middle node.
    bundle.flow.nodes[2].position = { x: 700, y: 250 };
    bundle.flow.edges = [
      {
        id: "third",
        source: "rows",
        sourceHandle: "result",
        target: "output",
        targetHandle: "source",
      },
      bundle.flow.edges[0],
    ];
  });
  const before = (await read()).bundle!.flow;
  expect(before.edges.map((item) => item.id)).toEqual(["third", "first"]);
  // The link drawn first lies under the other one at their shared end.
  await edge(page, "third").locator(".react-flow__edge-interaction").click();
  await expect(edge(page, "third")).toContainClass("selected");
  await autosaved(page, async () => {
    await dragEnd(page, "third", "source", await emptySpace(page));
  });
  expect((await read()).bundle!.flow.edges).toEqual([before.edges[1]]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await read()).bundle!.flow).toEqual(before);
  await expect(edge(page, "third")).toBeVisible();
  await expect(edge(page, "third")).not.toContainClass("selected");
});

test("failed reconnect and disconnect saves keep the original links", async ({
  page,
}) => {
  const { endpoint: url, read } = await createFilterProject(page);
  const before = (await read()).bundle!.flow;
  await page.route(`**${url}`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "Link save failed" } })
      : route.continue(),
  );
  for (const destination of [
    await center(handle(page, "rows", "source", "result")),
    await emptySpace(page),
  ]) {
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(url) && response.request().method() === "PUT",
    );
    await dragEnd(page, "second", "source", destination);
    expect((await saved).status()).toBe(500);
    await expect(page.locator(".toast").last()).toContainText(
      "Link save failed",
    );
    await expect(edge(page, "second")).toBeVisible();
    expect((await read()).bundle!.flow).toEqual(before);
    await expect(palette(page)).toHaveCount(0);
  }
});

test("right-angled reconnection edits the opened component while preserving its parent flow", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("duckpad-edge-style", "orthogonal"),
  );
  const { id, endpoint: url, read } = await createFilterProject(page);
  const snapshot = await read();
  const bundle = snapshot.bundle!;
  const original = structuredClone(bundle.flow);
  bundle.components.box = {
    name: "Box",
    nodes: original.nodes,
    edges: original.edges,
    inputs: {},
    outputs: { result: { node: "output", port: "result" } },
    parameters: {},
  };
  bundle.flow.nodes = [
    { id: "box", component: "box", params: {}, position: { x: 0, y: 0 } },
  ];
  bundle.flow.edges = [];
  expect(
    (
      await page.request.put(url, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${id}/flow`);
  await page.locator('.react-flow__node[data-id="box"] .node-shape').dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await autosaved(page, async () => {
    await dragEnd(
      page,
      "second",
      "source",
      await center(handle(page, "rows", "source", "result")),
    );
  });
  const after = (await read()).bundle!;
  expect(after.flow).toEqual(bundle.flow);
  expect(after.components.box.edges).toEqual([
    original.edges[0],
    { ...original.edges[1], source: "rows" },
  ]);
});

test("readers have no reconnect handles and cannot change links", async ({
  page,
}) => {
  const { read } = await createFilterProject(page);
  const before: Snapshot = await read();
  const username = `edge-reader-${Date.now()}`;
  const password = "edge-reader-password";
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
  await expect(edge(page, "second")).toHaveCount(1);
  await expect(page.locator(".react-flow__edgeupdater")).toHaveCount(0);
  expect((await read()).bundle).toEqual(before.bundle);
});
